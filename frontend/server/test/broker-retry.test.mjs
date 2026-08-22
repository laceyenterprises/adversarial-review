/**
 * Bounded backoff over the transient half of the split (ARF-07).
 *
 * The permanent/transient classification only pays for itself if the transient
 * side is actually *treated* as transient. These cases pin the three properties
 * that make that safe rather than merely optimistic:
 *
 *   1. only `broker_transient` is retried — a permanent refusal, an unmapped
 *      role, and a refused ambient identity all escalate on the first attempt;
 *   2. the loop is bounded, in attempts and in delay, so a genuinely-down
 *      upstream fails the standup step instead of hanging it;
 *   3. the retry sits *inside* the PAT fallback, so the App identity is not
 *      abandoned for a blip that a second attempt would have survived.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AmbientIdentityRefusedError, BrokerPermanentError, BrokerTransientError, SecretRefError,
} from '../src/broker/errors.mjs';
import { normalizeBrokerConfig } from '../src/broker/manifest.mjs';
import {
  DEFAULT_RETRY_ATTEMPTS, DEFAULT_RETRY_DELAY_MS, MAX_RETRY_DELAY_MS,
  backoffDelayMs, isTransientBrokerError, withTransientRetry,
} from '../src/broker/retry.mjs';
import { classifyOpReadError, createSecretResolver, runOpRead } from '../src/broker/secrets.mjs';
import { createTokenBroker } from '../src/broker/token-broker.mjs';
import {
  BROKER_AUTH_VALUE, MINTED_TOKEN, PAT_VALUE, fakeSecretResolver, isoAt, jsonResponse,
  recordingFetch,
} from './helpers/broker-fixtures.mjs';

const NOW = 1_800_000_000;
const GITHUB = 'https://api.github.test';
const ENDPOINT = 'https://broker.test';

/** A sleep that records the schedule instead of spending it. */
function recordingSleep() {
  const waits = [];
  const sleep = async (ms) => { waits.push(ms); };
  sleep.waits = waits;
  return sleep;
}

function bundledConfig(overrides = {}) {
  return normalizeBrokerConfig({
    file: {
      mode: 'bundled',
      githubApiUrl: GITHUB,
      roles: {
        'the-hammer': {
          provider: 'github_app',
          appId: '4197249',
          installationId: '143886388',
          privateKeyRef: 'op://Vault/hammer-key/private key',
          patFallbackRef: 'op://Vault/hammer-pat/credential',
        },
        'claude-reviewer': {
          provider: 'github_app',
          appId: '881',
          installationId: '4100',
          privateKeyRef: 'op://Vault/hammer-key/private key',
        },
      },
      ...overrides,
    },
  });
}

function externalConfig(overrides = {}) {
  return normalizeBrokerConfig({
    file: {
      mode: 'external',
      endpoint: ENDPOINT,
      endpointTokenRef: 'op://Vault/broker-auth/credential',
      roles: {
        'the-hammer': { scope: 'the-hammer-lacey/github_app/merge' },
      },
      ...overrides,
    },
  });
}

function broker({ config, fetchImpl, resolveSecret, sleep, logger } = {}) {
  return createTokenBroker({
    config: config ?? bundledConfig(),
    fetchImpl: fetchImpl ?? recordingFetch(async () => jsonResponse({
      token: MINTED_TOKEN, expires_at: isoAt(NOW + 3600),
    })),
    resolveSecret: resolveSecret ?? fakeSecretResolver(),
    now: () => NOW,
    sleep: sleep ?? (async () => {}),
    logger,
  });
}

describe('bounded transient backoff', () => {
  it('retries only the transient side, and rethrows the last error unchanged', async () => {
    const sleep = recordingSleep();
    let attempts = 0;
    const err = await withTransientRetry(async () => {
      attempts += 1;
      throw new BrokerTransientError(`blip ${attempts}`);
    }, { attempts: 3, baseDelayMs: 100, sleep }).catch((caught) => caught);

    assert.equal(attempts, 3, 'the cap is honoured exactly');
    assert.ok(err instanceof BrokerTransientError);
    assert.equal(err.message, 'blip 3', 'the LAST failure is what surfaces');
    assert.deepEqual(sleep.waits, [100, 200], 'one backoff between attempts, exponential');
  });

  it('does not retry a permanent error, an unmapped role, or a refused identity', async () => {
    for (const permanent of [
      new BrokerPermanentError('revoked'),
      new SecretRefError('1Password could not resolve op://Vault/x/y'),
      new AmbientIdentityRefusedError('the-hammer', { field: 'scope', expected: 'a', actual: 'b' }),
      new TypeError('not a broker error at all'),
    ]) {
      let attempts = 0;
      await assert.rejects(() => withTransientRetry(async () => {
        attempts += 1;
        throw permanent;
      }, { attempts: 5, sleep: async () => {} }));
      assert.equal(attempts, 1, `${permanent.name} escalates on the first attempt`);
    }
  });

  it('stops as soon as an attempt succeeds', async () => {
    let attempts = 0;
    const value = await withTransientRetry(async () => {
      attempts += 1;
      if (attempts < 2) throw new BrokerTransientError('blip');
      return 'ok';
    }, { attempts: 5, sleep: async () => {} });

    assert.equal(value, 'ok');
    assert.equal(attempts, 2);
  });

  it('caps the delay and treats a nonsense attempt count as one attempt', async () => {
    assert.equal(backoffDelayMs(1, 100), 100);
    assert.equal(backoffDelayMs(2, 100), 200);
    assert.equal(backoffDelayMs(40, 100), MAX_RETRY_DELAY_MS, 'the ceiling holds');
    assert.equal(backoffDelayMs(1, 0), DEFAULT_RETRY_DELAY_MS, 'a bad base falls back');

    let attempts = 0;
    await assert.rejects(() => withTransientRetry(async () => {
      attempts += 1;
      throw new BrokerTransientError('blip');
    }, { attempts: 0, sleep: async () => {} }), BrokerTransientError);
    assert.equal(attempts, 1);
  });

  it('classifies the transient code rather than the class identity', () => {
    assert.equal(isTransientBrokerError(new BrokerTransientError('x')), true);
    assert.equal(isTransientBrokerError(new BrokerPermanentError('x')), false);
    assert.equal(isTransientBrokerError(new Error('x')), false);
    assert.equal(isTransientBrokerError(null), false);
  });
});

describe('op read retries an interrupted subprocess', () => {
  // The blocking finding: `op` is a subprocess on a machine running launchd
  // jobs, and the 2026-05-16 outage is the recorded case of a transient EIO at
  // spawn time being treated as terminal.
  function opError(code) {
    const err = new Error(`spawn failed: ${code}`);
    err.code = code;
    return err;
  }

  it('retries a spawn EIO with bounded backoff and returns the eventual value', async () => {
    const sleep = recordingSleep();
    const calls = [];
    const execImpl = async (command, ref) => {
      calls.push(ref);
      if (calls.length < 3) throw classifyOpReadError(opError('EIO'), '', ref);
      return 'the-secret-value';
    };
    const opReadImpl = (command, ref, timeoutMs, retry) => withTransientRetry(
      () => execImpl(command, ref), { ...retry, sleep },
    );
    const resolve = createSecretResolver({ opReadImpl, retry: { attempts: 4, baseDelayMs: 50 } });

    const secret = await resolve('op://Vault/hammer-pat/credential');

    assert.equal(secret.use((value) => value), 'the-secret-value');
    assert.equal(calls.length, 3, 'two blips ridden out, third attempt answered');
    assert.deepEqual(sleep.waits, [50, 100]);
  });

  it('does NOT retry a reference 1Password refused', async () => {
    const refusal = new Error('op read failed');
    refusal.code = 1;
    refusal.signal = null;
    let calls = 0;
    const opReadImpl = (command, ref, timeoutMs, retry) => withTransientRetry(async () => {
      calls += 1;
      throw classifyOpReadError(refusal, 'no item matched', ref);
    }, { ...retry, sleep: async () => {} });
    const resolve = createSecretResolver({ opReadImpl, retry: { attempts: 4 } });

    await assert.rejects(() => resolve('op://Vault/hammer-pat/credential'), SecretRefError);
    assert.equal(calls, 1, 'a settled "no" is not re-asked');
  });

  it('escalates as transient once the bounded budget is spent', async () => {
    let calls = 0;
    const opReadImpl = (command, ref, timeoutMs, retry) => withTransientRetry(async () => {
      calls += 1;
      throw classifyOpReadError(opError('ETIMEDOUT'), '', ref);
    }, { ...retry, sleep: async () => {} });
    const resolve = createSecretResolver({ opReadImpl, retry: { attempts: 3 } });

    await assert.rejects(
      () => resolve('op://Vault/hammer-pat/credential'),
      // Still transient, so a role with a PAT fallback can still reach it.
      BrokerTransientError,
    );
    assert.equal(calls, 3);
  });

  it('wraps the real op invocation in the retry loop', async () => {
    // `runOpRead` is what `createSecretResolver` reaches for by default; a retry
    // wired only into the test double would be no protection at all.
    let attempts = 0;
    const failing = await runOpRead('definitely-not-a-real-op-binary-XXXX', 'op://V/i/f', 50, {
      attempts: 2,
      sleep: async () => { attempts += 1; },
    }).catch((err) => err);

    // ENOENT is deliberately permanent (a CLI that is not installed is an
    // install problem), so this proves the wrapper is in the call path without
    // depending on a machine that can produce a real EIO.
    assert.ok(failing instanceof SecretRefError);
    assert.equal(attempts, 0, 'a missing CLI is not retried');
  });
});

describe('network transient retries', () => {
  it('retries a 503 from GitHub before reaching for the PAT fallback', async () => {
    const sleep = recordingSleep();
    const fetchImpl = recordingFetch(async (url, init, index) => (index < 2
      ? jsonResponse({ message: 'Server Error' }, 503)
      : jsonResponse({ token: MINTED_TOKEN, expires_at: isoAt(NOW + 3600) })));

    const grant = await broker({ fetchImpl, sleep }).resolveToken('the-hammer');

    assert.equal(fetchImpl.calls.length, 3);
    assert.equal(
      grant.credentialSource, 'github_app_installation',
      'the App identity survived the blip; the PAT fallback was never needed',
    );
    assert.deepEqual(sleep.waits, [DEFAULT_RETRY_DELAY_MS, DEFAULT_RETRY_DELAY_MS * 2]);
  });

  it('falls back to the PAT only once the App identity retries are spent', async () => {
    const fetchImpl = recordingFetch(async () => jsonResponse({ message: 'Server Error' }, 503));
    const grant = await broker({ fetchImpl }).resolveToken('the-hammer');

    assert.equal(fetchImpl.calls.length, DEFAULT_RETRY_ATTEMPTS);
    assert.equal(grant.credentialSource, 'github_pat_fallback');
    assert.equal(grant.token.use((value) => value), PAT_VALUE);
  });

  it('does not retry a permanent GitHub refusal', async () => {
    const fetchImpl = recordingFetch(async () => jsonResponse({ message: 'Integration not found' }, 404));
    await assert.rejects(
      () => broker({ fetchImpl }).resolveToken('the-hammer'),
      BrokerPermanentError,
    );
    assert.equal(fetchImpl.calls.length, 1, 'a revoked App is not re-asked three times');
  });

  it('retries an unreachable external broker, which has no fallback to mask it', async () => {
    const fetchImpl = recordingFetch(async (url, init, index) => {
      if (index < 1) throw new Error('ECONNREFUSED');
      return jsonResponse({
        token: 'ghs_EXTERNAL_RETRY', expires_at: isoAt(NOW + 3600),
        scope: 'the-hammer-lacey/github_app/merge',
      });
    });
    const grant = await broker({ config: externalConfig(), fetchImpl }).resolveToken('the-hammer');

    assert.equal(fetchImpl.calls.length, 2);
    assert.equal(grant.credentialSource, 'external_broker');
  });

  it('does not retry a broker that refuses the identity it was asked for', async () => {
    const fetchImpl = recordingFetch(async () => jsonResponse({
      token: 'ghs_SOMEONE_ELSE', expires_at: isoAt(NOW + 3600), scope: 'someone-else/github_app/merge',
    }));
    await assert.rejects(
      () => broker({ config: externalConfig(), fetchImpl }).resolveToken('the-hammer'),
      AmbientIdentityRefusedError,
    );
    assert.equal(fetchImpl.calls.length, 1, 'an ambient-identity refusal is immediate');
  });

  it('honours broker.transientRetryAttempts=1 as "no retry"', async () => {
    const fetchImpl = recordingFetch(async () => jsonResponse({ message: 'Server Error' }, 503));
    const config = bundledConfig({ transientRetryAttempts: 1 });
    const grant = await broker({ config, fetchImpl }).resolveToken('the-hammer');

    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(grant.credentialSource, 'github_pat_fallback');
  });

  it('audits every retry with a reason but no material', async () => {
    const records = [];
    const fetchImpl = recordingFetch(async (url, init, index) => (index < 1
      ? jsonResponse({ message: 'Server Error' }, 503)
      : jsonResponse({ token: MINTED_TOKEN, expires_at: isoAt(NOW + 3600) })));
    await broker({ fetchImpl, logger: (record) => records.push(record) }).resolveToken('the-hammer');

    const retries = records.filter((record) => record.event === 'broker.transient_retry');
    assert.equal(retries.length, 1);
    assert.equal(retries[0].attempt, 1);
    assert.equal(retries[0].attempts, DEFAULT_RETRY_ATTEMPTS);
    assert.match(retries[0].reason, /HTTP 503/);
    const serialized = JSON.stringify(records);
    assert.ok(!serialized.includes(MINTED_TOKEN) && !serialized.includes(PAT_VALUE));
  });
});

describe('endpoint credential rotation', () => {
  function endpointBroker(fetchImpl) {
    const seen = [];
    const inner = fakeSecretResolver();
    const resolveSecret = async (ref, context) => {
      seen.push(String(ref));
      return inner(ref, context);
    };
    return {
      seen,
      broker: broker({ config: externalConfig(), fetchImpl, resolveSecret }),
    };
  }

  it('re-reads the endpoint credential after the broker rejects it (401)', async () => {
    // The non-blocking finding: the credential ARF authenticates to the broker
    // WITH is memoized per process, so a rotated `endpointTokenRef` would keep
    // failing against the withdrawn value until the daemon restarted.
    const fetchImpl = recordingFetch(async (url, init, index) => (index < 1
      ? jsonResponse({ error: 'invalid token' }, 401)
      : jsonResponse({
        token: 'ghs_AFTER_ROTATION', expires_at: isoAt(NOW + 3600),
        scope: 'the-hammer-lacey/github_app/merge',
      })));
    const { seen, broker: instance } = endpointBroker(fetchImpl);

    // The 401 itself still surfaces: a genuinely revoked credential must not be
    // hidden behind a silent retry that looks like a rotation.
    await assert.rejects(() => instance.resolveToken('the-hammer'), BrokerPermanentError);
    assert.deepEqual(seen, ['op://Vault/broker-auth/credential']);

    const grant = await instance.resolveToken('the-hammer');
    assert.equal(grant.credentialSource, 'external_broker');
    assert.deepEqual(
      seen,
      ['op://Vault/broker-auth/credential', 'op://Vault/broker-auth/credential'],
      'the second attempt re-read the ref rather than reusing the rejected value',
    );
  });

  it('keeps the memo for a failure that is not about the endpoint credential', async () => {
    const fetchImpl = recordingFetch(async () => jsonResponse({ error: 'no such role' }, 404));
    const { seen, broker: instance } = endpointBroker(fetchImpl);

    await assert.rejects(() => instance.resolveToken('the-hammer'), BrokerPermanentError);
    await assert.rejects(() => instance.resolveToken('the-hammer'), BrokerPermanentError);

    assert.deepEqual(
      seen, ['op://Vault/broker-auth/credential'],
      'an unmapped role at the far side says nothing about ARF\'s own credential',
    );
  });

  it('audits the invalidation with refs only', async () => {
    const records = [];
    const fetchImpl = recordingFetch(async () => jsonResponse({ error: 'forbidden' }, 403));
    const instance = broker({
      config: externalConfig(), fetchImpl, logger: (record) => records.push(record),
    });
    await assert.rejects(() => instance.resolveToken('the-hammer'), BrokerPermanentError);

    const invalidated = records.filter((r) => r.event === 'broker.endpoint_token_invalidated');
    assert.equal(invalidated.length, 1);
    assert.equal(invalidated[0].endpointTokenRef, 'op://Vault/broker-auth/credential');
    assert.ok(!JSON.stringify(records).includes(BROKER_AUTH_VALUE));
  });
});
