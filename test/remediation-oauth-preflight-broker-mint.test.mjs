import test from 'node:test';
import assert from 'node:assert/strict';

import {
  mintClaudeCodeRemediationBrokerToken,
  resolveClaudeCodeOAuthTransport,
  OAuthError,
} from '../src/remediation-oauth-preflight.mjs';

function jsonResponse(obj, init = {}) {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

// --- transport auto-detection (Paul, 2026-08-18: standalone must default to keychain) ---

test('transport auto-detects keychain when no broker secret is configured (standalone/vanilla)', () => {
  assert.equal(resolveClaudeCodeOAuthTransport({}), 'keychain');
});

test('transport auto-detects broker when a broker shared secret FILE is configured (fleet)', () => {
  assert.equal(
    resolveClaudeCodeOAuthTransport({ OAUTH_BROKER_SHARED_SECRET_FILE: '/x/secret' }),
    'broker',
  );
});

test('transport auto-detects broker when an inline broker shared secret is configured', () => {
  assert.equal(resolveClaudeCodeOAuthTransport({ OAUTH_BROKER_SHARED_SECRET: 's' }), 'broker');
});

test('explicit keychain overrides even when a broker secret is present', () => {
  assert.equal(
    resolveClaudeCodeOAuthTransport({
      ADVERSARIAL_REVIEW_CLAUDE_CODE_OAUTH_TRANSPORT: 'keychain',
      OAUTH_BROKER_SHARED_SECRET: 's',
    }),
    'keychain',
  );
});

test('explicit broker forces broker even before a secret is provisioned', () => {
  assert.equal(
    resolveClaudeCodeOAuthTransport({ ADVERSARIAL_REVIEW_CLAUDE_CODE_OAUTH_TRANSPORT: 'broker' }),
    'broker',
  );
});

// --- mint: the standalone / keychain path is NEVER clobbered ---

test('standalone (no secret) mints nothing and never calls the broker (keychain untouched)', async () => {
  let called = false;
  const r = await mintClaudeCodeRemediationBrokerToken({
    env: {},
    fetchImpl: async () => {
      called = true;
      return jsonResponse({});
    },
  });
  assert.equal(r.injected, false);
  assert.equal(r.reason, 'transport-not-broker');
  assert.equal(called, false, 'no broker call may happen in standalone mode');
});

test('explicit keychain transport mints nothing (vanilla `claude auth login` preserved)', async () => {
  const r = await mintClaudeCodeRemediationBrokerToken({
    env: { ADVERSARIAL_REVIEW_CLAUDE_CODE_OAUTH_TRANSPORT: 'keychain', OAUTH_BROKER_SHARED_SECRET: 's' },
    fetchImpl: async () => {
      throw new Error('keychain transport must not fetch');
    },
  });
  assert.equal(r.injected, false);
  assert.equal(r.reason, 'transport-not-broker');
});

test('an already-present ANTHROPIC_AUTH_TOKEN is never clobbered', async () => {
  const r = await mintClaudeCodeRemediationBrokerToken({
    env: { OAUTH_BROKER_SHARED_SECRET: 's', ANTHROPIC_AUTH_TOKEN: 'existing-token' },
    fetchImpl: async () => {
      throw new Error('must not fetch when a token is already present');
    },
  });
  assert.equal(r.injected, false);
  assert.equal(r.reason, 'token-already-present');
});

// --- mint: the fleet / broker path ---

test('broker mode mints a claude-code token and sends the shared secret as a Bearer', async () => {
  const seen = {};
  const r = await mintClaudeCodeRemediationBrokerToken({
    env: {
      OAUTH_BROKER_SHARED_SECRET: 'sekret',
      OAUTH_BROKER_URL: 'http://broker.test',
      CLAUDE_MODEL_ID: 'claude-opus-5',
    },
    fetchImpl: async (url, options) => {
      seen.url = url;
      seen.auth = options.headers.Authorization;
      return jsonResponse({
        access_token: 'brk-tok',
        provider: 'claude-code',
        expires_at: '2099-01-01T00:00:00Z',
      });
    },
  });
  assert.equal(r.injected, true);
  assert.equal(r.token, 'brk-tok');
  assert.equal(r.brokerUrl, 'http://broker.test');
  assert.equal(r.expiresAt, '2099-01-01T00:00:00Z');
  assert.match(seen.url, /\/token\?provider=claude-code/);
  assert.match(seen.url, /model=claude-opus-5/);
  assert.equal(seen.auth, 'Bearer sekret');
});

test('broker mode falls over to the standby endpoint when the primary fails', async () => {
  const r = await mintClaudeCodeRemediationBrokerToken({
    env: {
      OAUTH_BROKER_SHARED_SECRET: 's',
      OAUTH_BROKER_URL: 'http://primary.test',
      OAUTH_BROKER_STANDBY_URL: 'http://standby.test',
    },
    retryDelaysMs: [],
    fetchImpl: async (url) => {
      if (url.startsWith('http://primary.test')) return jsonResponse({ error: 'down' }, { status: 503 });
      return jsonResponse({ access_token: 'standby-tok', provider: 'claude-code' });
    },
  });
  assert.equal(r.injected, true);
  assert.equal(r.token, 'standby-tok');
  assert.equal(r.brokerUrl, 'http://standby.test');
});

test('broker mode throws (fail-closed) when no endpoint vends a usable token', async () => {
  await assert.rejects(
    mintClaudeCodeRemediationBrokerToken({
      env: {
        OAUTH_BROKER_SHARED_SECRET: 's',
        OAUTH_BROKER_URL: 'http://primary.test',
        OAUTH_BROKER_STANDBY_URL: 'http://standby.test',
      },
      retryDelaysMs: [],
      fetchImpl: async () => jsonResponse({ access_token: null }),
    }),
    (err) => err instanceof OAuthError,
  );
});

// --- transient-fault retry: a broker BOUNCE must not permanently fail a claimed job ---

function connectionRefused() {
  // Shape Node's fetch (undici) connection failure: generic message, real code
  // on `cause`.
  const err = new TypeError('fetch failed');
  err.cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:4099'), { code: 'ECONNREFUSED' });
  return err;
}

test('a transient ECONNREFUSED is retried on the same endpoint and succeeds (broker bounce)', async () => {
  const calls = [];
  const r = await mintClaudeCodeRemediationBrokerToken({
    env: { OAUTH_BROKER_SHARED_SECRET: 's', OAUTH_BROKER_URL: 'http://primary.test' },
    retryDelaysMs: [0, 0],
    fetchImpl: async (url) => {
      calls.push(url);
      if (calls.length < 3) throw connectionRefused();
      return jsonResponse({ access_token: 'recovered-tok', provider: 'claude-code' });
    },
  });
  assert.equal(r.injected, true);
  assert.equal(r.token, 'recovered-tok');
  assert.equal(calls.length, 3, 'the ladder must retry the SAME endpoint before failing over');
  assert.equal(r.brokerUrl, 'http://primary.test');
});

test('a transient HTTP 503 is retried on the same endpoint and succeeds', async () => {
  let calls = 0;
  const r = await mintClaudeCodeRemediationBrokerToken({
    env: { OAUTH_BROKER_SHARED_SECRET: 's', OAUTH_BROKER_URL: 'http://primary.test' },
    retryDelaysMs: [0],
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return jsonResponse({ error: 'restarting' }, { status: 503 });
      return jsonResponse({ access_token: 'after-503', provider: 'claude-code' });
    },
  });
  assert.equal(r.token, 'after-503');
  assert.equal(calls, 2);
});

test('our own timeout (AbortError) counts as transient and is retried', async () => {
  let calls = 0;
  const r = await mintClaudeCodeRemediationBrokerToken({
    env: { OAUTH_BROKER_SHARED_SECRET: 's', OAUTH_BROKER_URL: 'http://primary.test' },
    retryDelaysMs: [0],
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        const err = new Error('This operation was aborted');
        err.name = 'AbortError';
        throw err;
      }
      return jsonResponse({ access_token: 'after-timeout', provider: 'claude-code' });
    },
  });
  assert.equal(r.token, 'after-timeout');
  assert.equal(calls, 2);
});

test('a NON-transient 403 is not retried and fails over to the standby immediately', async () => {
  const calls = [];
  const r = await mintClaudeCodeRemediationBrokerToken({
    env: {
      OAUTH_BROKER_SHARED_SECRET: 's',
      OAUTH_BROKER_URL: 'http://primary.test',
      OAUTH_BROKER_STANDBY_URL: 'http://standby.test',
    },
    retryDelaysMs: [0, 0],
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.startsWith('http://primary.test')) return jsonResponse({ error: 'forbidden' }, { status: 403 });
      return jsonResponse({ access_token: 'standby-tok', provider: 'claude-code' });
    },
  });
  assert.equal(r.token, 'standby-tok');
  assert.equal(calls.length, 2, 'a bad shared secret must not burn the retry ladder');
});

test('an exhausted transient ladder still fails closed after trying every endpoint', async () => {
  const calls = [];
  await assert.rejects(
    mintClaudeCodeRemediationBrokerToken({
      env: {
        OAUTH_BROKER_SHARED_SECRET: 's',
        OAUTH_BROKER_URL: 'http://primary.test',
        OAUTH_BROKER_STANDBY_URL: 'http://standby.test',
      },
      retryDelaysMs: [0, 0],
      fetchImpl: async (url) => {
        calls.push(url);
        throw connectionRefused();
      },
    }),
    (err) => err instanceof OAuthError && /token mint failed/.test(err.message),
  );
  // 2 endpoints x (1 initial + 2 retries) — bounded, so a wedged broker can
  // never hang the remediation drain.
  assert.equal(calls.length, 6);
});

test('the retry ladder reports one failure per endpoint, not one per attempt', async () => {
  await assert.rejects(
    mintClaudeCodeRemediationBrokerToken({
      env: {
        OAUTH_BROKER_SHARED_SECRET: 's',
        OAUTH_BROKER_URL: 'http://primary.test',
        OAUTH_BROKER_STANDBY_URL: 'http://standby.test',
      },
      retryDelaysMs: [0, 0],
      fetchImpl: async () => { throw connectionRefused(); },
    }),
    (err) => {
      const occurrences = err.message.split('primary.test').length - 1;
      assert.equal(occurrences, 1, 'a retried bounce must not spam the failure list');
      return true;
    },
  );
});

test('transient retries are logged so a broker bounce is visible to operators', async () => {
  const warnings = [];
  let calls = 0;
  await mintClaudeCodeRemediationBrokerToken({
    env: { OAUTH_BROKER_SHARED_SECRET: 's', OAUTH_BROKER_URL: 'http://primary.test' },
    retryDelaysMs: [0],
    log: { warn: (line) => warnings.push(line) },
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) throw connectionRefused();
      return jsonResponse({ access_token: 't', provider: 'claude-code' });
    },
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /broker token mint transient failure \(attempt 1\/2\)/);
});

test('an unread error-response body is cancelled so the socket returns to the pool', async () => {
  let cancelled = 0;
  const r = await mintClaudeCodeRemediationBrokerToken({
    env: {
      OAUTH_BROKER_SHARED_SECRET: 's',
      OAUTH_BROKER_URL: 'http://primary.test',
      OAUTH_BROKER_STANDBY_URL: 'http://standby.test',
    },
    retryDelaysMs: [],
    fetchImpl: async (url) => {
      if (url.startsWith('http://primary.test')) {
        return {
          ok: false,
          status: 503,
          body: { cancel: async () => { cancelled += 1; } },
        };
      }
      return jsonResponse({ access_token: 'standby-tok', provider: 'claude-code' });
    },
  });
  assert.equal(r.token, 'standby-tok');
  assert.equal(cancelled, 1, 'the failed response body must be cancelled, not leaked');
});

test('a bodyless error response (non-undici fetch stub) does not throw', async () => {
  await assert.rejects(
    mintClaudeCodeRemediationBrokerToken({
      env: {
        OAUTH_BROKER_SHARED_SECRET: 's',
        OAUTH_BROKER_URL: 'http://b.test',
        OAUTH_BROKER_STANDBY_URL: 'http://b.test',
      },
      retryDelaysMs: [],
      fetchImpl: async () => ({ ok: false, status: 403 }),
    }),
    (err) => err instanceof OAuthError,
  );
});

test('a secret file with a trailing newline is trimmed to the bare secret', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'broker-secret-'));
  const secretPath = join(dir, 'secret');
  writeFileSync(secretPath, '  sekret\r\n\n');
  let seenAuth;
  await mintClaudeCodeRemediationBrokerToken({
    env: { OAUTH_BROKER_SHARED_SECRET_FILE: secretPath, OAUTH_BROKER_URL: 'http://b.test' },
    retryDelaysMs: [],
    fetchImpl: async (_url, options) => {
      seenAuth = options.headers.Authorization;
      return jsonResponse({ access_token: 't', provider: 'claude-code' });
    },
  });
  assert.equal(seenAuth, 'Bearer sekret');
});

test('explicit broker transport with no secret configured fails closed', async () => {
  await assert.rejects(
    mintClaudeCodeRemediationBrokerToken({
      env: { ADVERSARIAL_REVIEW_CLAUDE_CODE_OAUTH_TRANSPORT: 'broker' },
      fetchImpl: async () => jsonResponse({ access_token: 'x', provider: 'claude-code' }),
    }),
    (err) => err instanceof OAuthError && /not configured/.test(err.message),
  );
});

test('a configured-but-missing secret file fails closed as an OAuthError (not a raw ENOENT)', async () => {
  await assert.rejects(
    mintClaudeCodeRemediationBrokerToken({
      env: { OAUTH_BROKER_SHARED_SECRET_FILE: '/nonexistent/path/broker-secret-xyz.secret' },
      fetchImpl: async () => {
        throw new Error('must not fetch when the configured secret file is unreadable');
      },
    }),
    (err) => err instanceof OAuthError && /unreadable/.test(err.message),
  );
});

test('a wrong-provider token is rejected by the provider guard', async () => {
  await assert.rejects(
    mintClaudeCodeRemediationBrokerToken({
      env: {
        OAUTH_BROKER_SHARED_SECRET: 's',
        OAUTH_BROKER_URL: 'http://b.test',
        OAUTH_BROKER_STANDBY_URL: 'http://b.test',
      },
      fetchImpl: async () => jsonResponse({ access_token: 'x', provider: 'codex' }),
    }),
    (err) => err instanceof OAuthError,
  );
});
