// TOKDZ-01 — the Claude reviewer survives a broker token rotation. A loopback
// fake upstream plays the Anthropic API (it revokes a grant on rotation, exactly
// as the upstream does), a stub plays the broker's `/token` re-read, and the real
// proxy sits between them and the "CLI".
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import {
  CLAUDE_REVIEWER_PROXIED_HANDOFF_FLOOR_MS,
  claudeReviewerTokenProxyEnabled,
  startClaudeReviewerTokenProxy,
  startClaudeReviewerTokenProxyForAuth,
} from '../src/claude-reviewer-token-proxy.mjs';
import { __test__ as harness } from '../src/reviewer-harness.mjs';

const { assertClaudeBrokerTokenHandoffLifetime, prepareClaudeOAuthEnv, reviewWithClaude } = harness;

const quietLogger = { info() {}, warn() {} };
// Every fixture grant expiry is a fixed 2026-09-28 timestamp, so the proxy
// clock is pinned to the same timeline; the live clock would eventually pass
// grant-a's expiry and turn each first forward into a proactive re-read.
const FIXTURE_NOW_MS = Date.parse('2026-09-28T19:31:10Z');

// The upstream accepts exactly the grants in `valid`; a rotation removes the
// old grant (revocation) and adds the new one.
async function startFakeUpstream() {
  const valid = new Set(['grant-a']);
  const seen = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const bearer = String(req.headers.authorization || '').replace(/^Bearer /, '');
      seen.push({
        method: req.method,
        url: req.url,
        bearer,
        host: req.headers.host,
        apiKey: req.headers['x-api-key'] ?? null,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      if (!valid.has(bearer)) {
        const body = JSON.stringify({
          type: 'error',
          error: { type: 'authentication_error', message: 'OAuth access token has been revoked.' },
        });
        res.writeHead(401, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
        res.end(body);
        return;
      }
      // A streamed (chunked) SSE answer, like a real messages turn.
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
      setTimeout(() => {
        res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
      }, 20);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    seen,
    rotate(from, to) {
      valid.delete(from);
      valid.add(to);
    },
    close: () => new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    }),
  };
}

function createBroker(initial = { token: 'grant-a', expiresAt: '2026-09-28T20:54:30Z' }) {
  const broker = {
    current: { ...initial },
    calls: 0,
    async remint() {
      broker.calls += 1;
      return { ...broker.current };
    },
  };
  return broker;
}

function post(baseUrl, { bearer = 'grant-a', path = '/v1/messages?beta=true', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'review' }] });
    const req = request(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function withProxy(options, fn) {
  const upstream = await startFakeUpstream();
  const broker = createBroker(options.brokerInitial);
  const proxy = await startClaudeReviewerTokenProxy({
    initialToken: 'grant-a',
    initialExpiresAt: '2026-09-28T20:54:30Z',
    remint: () => broker.remint(),
    upstream: upstream.url,
    logger: quietLogger,
    remintCooldownMs: 0,
    now: () => FIXTURE_NOW_MS,
    ...options.proxy,
  });
  try {
    await fn({ upstream, broker, proxy });
  } finally {
    await proxy.close();
    await upstream.close();
  }
}

test('forwards with the broker grant, never the caller\'s own credential headers, and streams the answer', async () => {
  await withProxy({}, async ({ upstream, proxy }) => {
    const res = await post(proxy.baseUrl, { headers: { 'x-api-key': 'must-not-forward' } });
    assert.equal(res.status, 200);
    assert.match(res.body, /message_start[\s\S]*message_stop/);
    assert.equal(upstream.seen.length, 1);
    assert.equal(upstream.seen[0].bearer, 'grant-a');
    assert.equal(upstream.seen[0].apiKey, null);
    assert.equal(upstream.seen[0].url, '/v1/messages?beta=true');
    assert.equal(upstream.seen[0].host, new URL(upstream.url).host);
    assert.match(upstream.seen[0].body, /claude-opus-5-5/);
  });
});

test('a mid-review rotation is survived: the revoked grant is replaced and the request replayed once', async () => {
  await withProxy({}, async ({ upstream, broker, proxy }) => {
    assert.equal((await post(proxy.baseUrl)).status, 200);
    // The bridge rotates: the upstream revokes grant-a, the broker now serves grant-b.
    upstream.rotate('grant-a', 'grant-b');
    broker.current = { token: 'grant-b', expiresAt: '2026-09-29T04:24:30Z' };
    // The CLI still presents its frozen spawn-time bearer.
    const res = await post(proxy.baseUrl, { bearer: 'grant-a' });
    assert.equal(res.status, 200);
    assert.deepEqual(upstream.seen.map((entry) => entry.bearer), ['grant-a', 'grant-a', 'grant-b']);
    const stats = proxy.stats();
    assert.equal(stats.rotationsObserved, 1);
    assert.equal(stats.rejectionsRecovered, 1);
    assert.equal(stats.rejectionsUnrecovered, 0);
    assert.equal(proxy.rotationPending(), false);
    assert.equal(proxy.currentExpiresAt(), '2026-09-29T04:24:30.000Z');
    // Later requests go straight out on the new grant.
    assert.equal((await post(proxy.baseUrl)).status, 200);
    assert.equal(upstream.seen.at(-1).bearer, 'grant-b');
  });
});

test('a rejection the broker cannot heal yet answers a retryable 503, then recovers after the rotation', async () => {
  await withProxy({}, async ({ upstream, broker, proxy }) => {
    upstream.rotate('grant-a', 'grant-b'); // revoked upstream, broker still serving grant-a
    const pending = await post(proxy.baseUrl);
    assert.equal(pending.status, 503);
    assert.match(pending.body, /\[token-refresh-pending\]/);
    assert.equal(proxy.rotationPending(), true);
    broker.current = { token: 'grant-b', expiresAt: '2026-09-29T04:24:30Z' };
    const healed = await post(proxy.baseUrl);
    assert.equal(healed.status, 200);
    assert.equal(proxy.rotationPending(), false);
  });
});

test('a replay that is rejected too is a bad credential: the 401 is mirrored, not held', async () => {
  await withProxy({}, async ({ upstream, broker, proxy }) => {
    upstream.rotate('grant-a', 'grant-c');
    broker.current = { token: 'grant-b', expiresAt: '2026-09-29T04:24:30Z' }; // also rejected
    const res = await post(proxy.baseUrl);
    assert.equal(res.status, 401);
    assert.match(res.body, /revoked/);
    assert.equal(proxy.rotationPending(), false);
    assert.equal(proxy.stats().authState, 'rejected');
  });
});

test('an unknown caller bearer is refused without touching the upstream or the broker', async () => {
  await withProxy({}, async ({ upstream, broker, proxy }) => {
    const res = await post(proxy.baseUrl, { bearer: 'some-other-process' });
    assert.equal(res.status, 401);
    assert.match(res.body, /requires the reviewer's broker bearer/);
    assert.equal(upstream.seen.length, 0);
    assert.equal(broker.calls, 0);
    assert.equal(proxy.stats().unauthorizedCallers, 1);
  });
});

test('an uncredentialed probe is forwarded without any credential; a foreign x-api-key is refused', async () => {
  await withProxy({}, async ({ upstream, broker, proxy }) => {
    const probe = await new Promise((resolve, reject) => {
      const req = request(`${proxy.baseUrl}/api/hello`, { method: 'HEAD' }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(probe, 401); // the fake upstream's answer to no bearer, passed through untouched
    assert.deepEqual(upstream.seen.map((entry) => [entry.method, entry.url, entry.bearer]), [['HEAD', '/api/hello', '']]);
    assert.equal(broker.calls, 0);
    assert.equal(proxy.rotationPending(), false);

    const res = await new Promise((resolve, reject) => {
      const req = request(`${proxy.baseUrl}/v1/messages`, { method: 'POST', headers: { 'x-api-key': 'sk-foreign' } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      });
      req.on('error', reject);
      req.end('{}');
    });
    assert.equal(res, 401);
    assert.equal(upstream.seen.length, 1);
    assert.equal(proxy.stats().lastUnauthorized, 'POST /v1/messages');
  });
});

test('an absolute-form request target is refused so the bearer cannot be steered off-host', async () => {
  await withProxy({}, async ({ upstream, proxy }) => {
    const port = new URL(proxy.baseUrl).port;
    const status = await new Promise((resolve, reject) => {
      const req = request({
        host: '127.0.0.1',
        port,
        method: 'GET',
        path: 'http://attacker.invalid/v1/messages',
        headers: { authorization: 'Bearer grant-a' },
      }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 400);
    assert.equal(upstream.seen.length, 0);
  });
});

test('network-path and backslash targets cannot send the broker bearer off-host', async () => {
  const seen = [];
  const attacker = createServer((req, res) => {
    seen.push(req.headers.authorization);
    res.end();
  });
  await new Promise((resolve) => attacker.listen(0, '127.0.0.1', resolve));
  try {
    await withProxy({}, async ({ upstream, broker, proxy }) => {
      const port = new URL(proxy.baseUrl).port;
      const attackerHost = `127.0.0.1:${attacker.address().port}`;
      for (const target of [`//${attackerHost}/v1/messages`, `/\\${attackerHost}/v1/messages`]) {
        const status = await new Promise((resolve, reject) => {
          const req = request({
            host: '127.0.0.1', port, method: 'GET', path: target,
            headers: { authorization: 'Bearer grant-a' },
          }, (res) => {
            res.resume();
            resolve(res.statusCode);
          });
          req.on('error', reject);
          req.end();
        });
        assert.equal(status, 400, target);
      }
      assert.deepEqual(seen, []);
      assert.equal(upstream.seen.length, 0);
      assert.equal(broker.calls, 0);
    });
  } finally {
    await new Promise((resolve) => attacker.close(resolve));
  }
});

test('a grant near expiry is re-read before forwarding', async () => {
  let nowMs = Date.parse('2026-09-28T20:53:00Z'); // 90s before grant-a expires
  await withProxy({ proxy: { now: () => nowMs } }, async ({ upstream, broker, proxy }) => {
    upstream.rotate('grant-a', 'grant-b');
    broker.current = { token: 'grant-b', expiresAt: '2026-09-29T04:53:00Z' };
    const res = await post(proxy.baseUrl);
    assert.equal(res.status, 200);
    assert.deepEqual(upstream.seen.map((entry) => entry.bearer), ['grant-b']);
    assert.equal(proxy.stats().proactiveRemints, 1);
    nowMs += 1000;
  });
});

test('concurrent rejections during a rotation share one broker re-read', async () => {
  await withProxy({ proxy: { remintCooldownMs: 60_000 } }, async ({ upstream, broker, proxy }) => {
    upstream.rotate('grant-a', 'grant-b');
    broker.current = { token: 'grant-b', expiresAt: '2026-09-29T04:24:30Z' };
    const results = await Promise.all([post(proxy.baseUrl), post(proxy.baseUrl), post(proxy.baseUrl)]);
    assert.deepEqual(results.map((res) => res.status), [200, 200, 200]);
    assert.equal(broker.calls, 1);
  });
});

test('the proxy refuses a non-loopback, non-Anthropic upstream', async () => {
  await assert.rejects(
    () => startClaudeReviewerTokenProxy({
      initialToken: 'grant-a',
      remint: async () => ({}),
      upstream: 'https://proxy.example.invalid',
      logger: quietLogger,
    }),
    /must be https:\/\/api\.anthropic\.com or a loopback URL/,
  );
});

test('startClaudeReviewerTokenProxyForAuth starts only for a broker auth that can re-read, unless disabled', async () => {
  const brokerAuth = {
    transport: 'broker',
    env: { ANTHROPIC_AUTH_TOKEN: 'grant-a' },
    expiresAt: '2026-09-28T20:54:30Z',
    remint: async () => ({ token: 'grant-a', expiresAt: '2026-09-28T20:54:30Z' }),
  };
  const started = [];
  const startImpl = async (options) => {
    started.push(options);
    return { baseUrl: 'http://127.0.0.1:1', close: async () => {} };
  };
  assert.equal(claudeReviewerTokenProxyEnabled({}), true);
  assert.equal(claudeReviewerTokenProxyEnabled({ ADVERSARIAL_REVIEW_CLAUDE_TOKEN_REFRESH_PROXY: 'off' }), false);
  assert.equal(await startClaudeReviewerTokenProxyForAuth({
    auth: brokerAuth, env: { ADVERSARIAL_REVIEW_CLAUDE_TOKEN_REFRESH_PROXY: 'off' }, startImpl, logger: quietLogger,
  }), null);
  assert.equal(await startClaudeReviewerTokenProxyForAuth({
    auth: { ...brokerAuth, transport: 'keychain' }, env: {}, startImpl, logger: quietLogger,
  }), null);
  assert.equal(await startClaudeReviewerTokenProxyForAuth({
    auth: { ...brokerAuth, remint: undefined }, env: {}, startImpl, logger: quietLogger,
  }), null);
  assert.equal(started.length, 0);
  const proxy = await startClaudeReviewerTokenProxyForAuth({ auth: brokerAuth, env: {}, startImpl, logger: quietLogger });
  assert.equal(proxy.baseUrl, 'http://127.0.0.1:1');
  assert.equal(started[0].initialToken, 'grant-a');
  // A listener that cannot start falls back to the direct handoff.
  assert.equal(await startClaudeReviewerTokenProxyForAuth({
    auth: brokerAuth,
    env: {},
    startImpl: async () => { throw new Error('EADDRINUSE'); },
    logger: quietLogger,
  }), null);
});

test('the proxied handoff floor replaces the maximum-timeout requirement', () => {
  const nowMs = Date.parse('2026-09-28T19:31:10Z');
  const expiresAt = new Date(nowMs + 4994933).toISOString(); // the live refusal: 83 min left
  const reviewerTimeoutMs = 180 * 60 * 1000;
  assert.throws(
    () => assertClaudeBrokerTokenHandoffLifetime({ expiresAt, nowMs, reviewerTimeoutMs }),
    /expires too soon for subprocess handoff: remaining=4994933ms minimum=10920000ms expires_at=\S+ handoff=direct/,
  );
  assert.deepEqual(
    assertClaudeBrokerTokenHandoffLifetime({ expiresAt, nowMs, reviewerTimeoutMs, proxied: true }),
    { expiresAtMs: Date.parse(expiresAt), remainingMs: 4994933, requiredLifetimeMs: CLAUDE_REVIEWER_PROXIED_HANDOFF_FLOOR_MS },
  );
  assert.throws(
    () => assertClaudeBrokerTokenHandoffLifetime({
      expiresAt: new Date(nowMs + 4 * 60 * 1000).toISOString(), nowMs, reviewerTimeoutMs, proxied: true,
    }),
    (err) => err.failureClass === 'token-refresh-pending' && /handoff=proxied/.test(err.message),
  );
});

test('prepareClaudeOAuthEnv applies the proxied floor by default and returns a secret-free broker re-read', async () => {
  const mints = [];
  const auth = await prepareClaudeOAuthEnv({
    sourceEnv: { OAUTH_BROKER_SHARED_SECRET_FILE: '/run/secrets/oauth-broker' },
    mintClaudeCodeBrokerTokenImpl: async ({ env }) => {
      mints.push(env.OAUTH_BROKER_SHARED_SECRET_FILE);
      return { injected: true, token: `grant-${mints.length}`, brokerUrl: 'http://127.0.0.1:4099', expiresAt: '2026-09-28T20:54:30Z' };
    },
    logger: quietLogger,
    nowMs: Date.parse('2026-09-28T19:31:10Z'), // 83 min left: refused before TOKDZ-01
    reviewerTimeoutMs: 180 * 60 * 1000,
  });
  assert.equal(auth.env.ANTHROPIC_AUTH_TOKEN, 'grant-1');
  assert.equal(auth.env.OAUTH_BROKER_SHARED_SECRET_FILE, undefined);
  assert.deepEqual(await auth.remint(), { token: 'grant-2', expiresAt: '2026-09-28T20:54:30Z' });
  assert.deepEqual(mints, ['/run/secrets/oauth-broker', '/run/secrets/oauth-broker']);

  await assert.rejects(() => prepareClaudeOAuthEnv({
    sourceEnv: {
      OAUTH_BROKER_SHARED_SECRET_FILE: '/run/secrets/oauth-broker',
      ADVERSARIAL_REVIEW_CLAUDE_TOKEN_REFRESH_PROXY: 'off',
    },
    mintClaudeCodeBrokerTokenImpl: async () => ({ injected: true, token: 'grant-1', expiresAt: '2026-09-28T20:54:30Z' }),
    logger: quietLogger,
    nowMs: Date.parse('2026-09-28T19:31:10Z'),
    reviewerTimeoutMs: 180 * 60 * 1000,
  }), (err) => err.failureClass === 'token-refresh-pending');
});

// reviewWithClaude end to end, with a "CLI" that makes real HTTP calls to
// whatever ANTHROPIC_BASE_URL it was handed. 200 changed lines put the reviewer
// ceiling at its 180 min maximum, the pass size behind the live refusal
// (minimum=10919571ms), so a direct handoff would need ~3 h of token life.
const LARGE_DIFF = Array.from({ length: 200 }, (_, index) => `+line ${index}`).join('\n');

async function reviewThroughProxy({ upstream, broker, cli, expiresAt = '2026-09-28T20:54:30Z', env = {} }) {
  const proxies = [];
  const result = reviewWithClaude(LARGE_DIFF, '', {
    platform: 'linux',
    logger: quietLogger,
    nowMs: () => Date.parse('2026-09-28T19:31:10Z'),
    assertClaudeOAuthImpl: async () => ({
      transport: 'broker',
      env: { PATH: process.env.PATH, ANTHROPIC_AUTH_TOKEN: 'grant-a', ...env },
      expiresAt,
      remint: () => broker.remint(),
    }),
    startTokenProxyImpl: async (options) => {
      const proxy = await startClaudeReviewerTokenProxyForAuth({
        ...options,
        startImpl: (startOptions) => startClaudeReviewerTokenProxy({
          ...startOptions,
          upstream: upstream.url,
          remintCooldownMs: 0,
          now: () => FIXTURE_NOW_MS,
        }),
      });
      if (proxy) proxies.push(proxy);
      return proxy;
    },
    spawnClaudeImpl: cli,
  });
  return { result, proxies };
}

test('reviewWithClaude spawns through the proxy with 83 min left and survives a rotation mid-review', async () => {
  const upstream = await startFakeUpstream();
  const broker = createBroker();
  const childEnvs = [];
  try {
    const { result, proxies } = await reviewThroughProxy({
      upstream,
      broker,
      cli: async (_args, options) => {
        childEnvs.push(options.env);
        const base = options.env.ANTHROPIC_BASE_URL;
        const bearer = options.env.ANTHROPIC_AUTH_TOKEN;
        assert.equal((await post(base, { bearer })).status, 200);
        upstream.rotate('grant-a', 'grant-b');
        broker.current = { token: 'grant-b', expiresAt: '2026-09-29T04:24:30Z' };
        assert.equal((await post(base, { bearer })).status, 200);
        return { stdout: JSON.stringify({ type: 'result', result: '## Verdict\nComment only' }), stderr: '' };
      },
    });
    const review = await result;
    assert.equal(review.reviewText, '## Verdict\nComment only');
    assert.match(childEnvs[0].ANTHROPIC_BASE_URL, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(childEnvs[0].OAUTH_BROKER_SHARED_SECRET_FILE, undefined);
    assert.deepEqual(upstream.seen.map((entry) => entry.bearer), ['grant-a', 'grant-a', 'grant-b']);
    assert.equal(proxies[0].stats().rotationsObserved, 1);
    // The listener is gone once the pass settles (a pooled keep-alive socket
    // reports the teardown as a hang-up rather than a refused connect).
    await assert.rejects(() => post(childEnvs[0].ANTHROPIC_BASE_URL), /ECONNREFUSED|socket hang up|ECONNRESET/);
  } finally {
    await upstream.close();
  }
});

test('reviewWithClaude turns an unhealed mid-review rejection into a token-refresh-pending hold, not an OAuth page', async () => {
  const upstream = await startFakeUpstream();
  const broker = createBroker();
  try {
    const { result } = await reviewThroughProxy({
      upstream,
      broker,
      cli: async (_args, options) => {
        upstream.rotate('grant-a', 'grant-b'); // broker never catches up
        const res = await post(options.env.ANTHROPIC_BASE_URL, { bearer: options.env.ANTHROPIC_AUTH_TOKEN });
        const err = new Error(`Command failed with code 1\nAPI Error: ${res.status} ${res.body}`);
        err.stderr = 'API Error: 401 retry exhausted';
        throw err;
      },
    });
    await assert.rejects(result, (err) => {
      assert.equal(err.failureClass, 'token-refresh-pending');
      assert.equal(err.isOAuthError, undefined);
      assert.match(err.message, /rejected mid-review .* expires_at=2026-09-28T20:54:30\.000Z handoff=proxied/);
      return true;
    });
  } finally {
    await upstream.close();
  }
});

test('reviewWithClaude with the proxy disabled keeps the direct handoff and its full-lifetime refusal', async () => {
  const upstream = await startFakeUpstream();
  const broker = createBroker();
  try {
    const { result, proxies } = await reviewThroughProxy({
      upstream,
      broker,
      env: { ADVERSARIAL_REVIEW_CLAUDE_TOKEN_REFRESH_PROXY: 'off' },
      cli: async () => {
        throw new Error('spawn must not run with a too-short direct-handoff bearer');
      },
    });
    await assert.rejects(result, (err) => err.failureClass === 'token-refresh-pending' && /handoff=direct/.test(err.message));
    assert.equal(proxies.length, 0);
  } finally {
    await upstream.close();
  }
});
