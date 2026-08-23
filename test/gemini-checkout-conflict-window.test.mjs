import test from 'node:test';
import assert from 'node:assert/strict';

import { __test__ as reviewerHarness } from '../src/reviewer-harness.mjs';

// The Gemini pool holds exactly ONE credential because `agy` is single-process,
// so a 409 is the normal state whenever another reviewer holds it. The old
// bound was 4 attempts at 250ms linear backoff -- 2.5 seconds total -- against
// a ~2 minute review and a 10 minute lease TTL. Callers gave up ~50x too early
// and fell into GEMINI_CQP_FALLBACK_LOCK_WAIT_MS, a 30 MINUTE serialized lock.
// Measured impact: 2055 fallbacks in one log and reviewer drains up to 1551s.

function response(status, body) {
  return { status, ok: status >= 200 && status < 300, async json() { return body; } };
}

function successfulCheckout(id) {
  return response(200, {
    checkout_id: `lease-${id}`,
    credential_id: `cred-${id}`,
    oauth_creds_json: JSON.stringify({ access_token: `token-${id}` }),
  });
}

function conflict() {
  return response(409, { error: 'checkout conflict' });
}

test('keeps waiting past the old attempt cap while the window is open', async () => {
  reviewerHarness.resetGeminiCredentialCheckoutQueueForTest();
  // Ten conflicts is far beyond the legacy 4-attempt cap. Under the old
  // behaviour this threw and the caller took the 30-minute lock.
  let calls = 0;
  let clock = 0;
  const result = await reviewerHarness.checkoutGeminiCredentialFromBroker({
    env: {
      CQP_BROKER_URL: 'http://broker.test',
      AGENT_OS_GEMINI_CHECKOUT_409_BACKOFF_MS: '10',
      AGENT_OS_GEMINI_CHECKOUT_409_WINDOW_MS: '60000',
    },
    fetchImpl: async () => {
      calls += 1;
      return calls <= 10 ? conflict() : successfulCheckout('late');
    },
    sleepImpl: async (ms) => { clock += ms; },
    nowImpl: () => clock,
    log: { warn() {} },
  });

  assert.equal(result.checkoutId, 'lease-late');
  assert.equal(calls, 11, 'should have kept retrying past the 4-attempt legacy cap');
});

test('gives up once the wall-clock window is exhausted', async () => {
  reviewerHarness.resetGeminiCredentialCheckoutQueueForTest();
  // A genuinely orphaned lease must still fall through to the fallback rather
  // than blocking forever -- the window is under the lease TTL for that reason.
  let clock = 0;
  await assert.rejects(
    reviewerHarness.checkoutGeminiCredentialFromBroker({
      env: {
        CQP_BROKER_URL: 'http://broker.test',
        AGENT_OS_GEMINI_CHECKOUT_409_BACKOFF_MS: '1000',
        AGENT_OS_GEMINI_CHECKOUT_409_WINDOW_MS: '5000',
      },
      fetchImpl: async () => conflict(),
      sleepImpl: async (ms) => { clock += ms; },
      nowImpl: () => clock,
      log: { warn() {} },
    }),
    (err) => err?.isGeminiCredentialPoolUnavailable === true,
  );
  assert.ok(clock >= 5000, `expected to wait out the window, waited ${clock}ms`);
  assert.ok(clock <= 8000, `should not overshoot the window materially, waited ${clock}ms`);
});

test('backoff is capped so late attempts stay responsive', async () => {
  reviewerHarness.resetGeminiCredentialCheckoutQueueForTest();
  // Linear backoff unbounded would sleep straight through a release. The cap
  // keeps the poll frequent enough to catch one.
  const sleeps = [];
  let clock = 0;
  let calls = 0;
  await reviewerHarness.checkoutGeminiCredentialFromBroker({
    env: {
      CQP_BROKER_URL: 'http://broker.test',
      AGENT_OS_GEMINI_CHECKOUT_409_BACKOFF_MS: '4000',
      AGENT_OS_GEMINI_CHECKOUT_409_WINDOW_MS: '600000',
    },
    fetchImpl: async () => {
      calls += 1;
      return calls <= 6 ? conflict() : successfulCheckout('capped');
    },
    sleepImpl: async (ms) => { sleeps.push(ms); clock += ms; },
    nowImpl: () => clock,
    log: { warn() {} },
  });
  assert.ok(sleeps.length > 0);
  assert.ok(Math.max(...sleeps) <= 5000, `backoff must stay capped, saw ${Math.max(...sleeps)}ms`);
});

test('default elapsed-time clock is monotonic and does not depend on Date.now', async (t) => {
  reviewerHarness.resetGeminiCredentialCheckoutQueueForTest();
  const originalDateNow = Date.now;
  Date.now = () => {
    throw new Error('Date.now should not be used for Gemini checkout elapsed time');
  };
  t.after(() => {
    Date.now = originalDateNow;
  });

  let calls = 0;
  const result = await reviewerHarness.checkoutGeminiCredentialFromBroker({
    env: {
      CQP_BROKER_URL: 'http://broker.test',
      AGENT_OS_GEMINI_CHECKOUT_409_BACKOFF_MS: '1',
      AGENT_OS_GEMINI_CHECKOUT_409_WINDOW_MS: '1000',
    },
    fetchImpl: async () => {
      calls += 1;
      return calls <= 2 ? conflict() : successfulCheckout('monotonic-default');
    },
    sleepImpl: async () => {},
    log: { info() {} },
  });

  assert.equal(result.checkoutId, 'lease-monotonic-default');
  assert.equal(calls, 3);
});

test('explicit retry-only configuration preserves the legacy attempt-count bound', async () => {
  reviewerHarness.resetGeminiCredentialCheckoutQueueForTest();
  let calls = 0;
  let clock = 0;
  await assert.rejects(
    reviewerHarness.checkoutGeminiCredentialFromBroker({
      env: {
        CQP_BROKER_URL: 'http://broker.test',
        AGENT_OS_GEMINI_CHECKOUT_409_RETRIES: '2',
        AGENT_OS_GEMINI_CHECKOUT_409_BACKOFF_MS: '1',
      },
      fetchImpl: async () => { calls += 1; return conflict(); },
      sleepImpl: async (ms) => { clock += ms; },
      nowImpl: () => clock,
      log: { warn() {} },
    }),
    (err) => err?.isGeminiCredentialPoolUnavailable === true,
  );
  assert.equal(reviewerHarness.resolveGeminiCheckoutConflictWindowMs({
    AGENT_OS_GEMINI_CHECKOUT_409_RETRIES: '2',
  }), 0);
  assert.equal(calls, 3, 'explicit retries without a window should not inherit the 5-minute default');
});

test('empty primary window env falls back to legacy checkout window env', () => {
  assert.equal(reviewerHarness.resolveGeminiCheckoutConflictWindowMs({
    AGENT_OS_GEMINI_CHECKOUT_409_WINDOW_MS: '',
    GEMINI_CQP_CHECKOUT_409_WINDOW_MS: '1234',
  }), 1234);
});

test('empty primary retries env still honors legacy retry-only checkout bound', () => {
  assert.equal(reviewerHarness.resolveGeminiCheckoutConflictWindowMs({
    AGENT_OS_GEMINI_CHECKOUT_409_RETRIES: '',
    GEMINI_CQP_CHECKOUT_409_RETRIES: '2',
  }), 0);
  assert.equal(reviewerHarness.resolveGeminiCheckoutConflictRetries({
    AGENT_OS_GEMINI_CHECKOUT_409_RETRIES: '',
    GEMINI_CQP_CHECKOUT_409_RETRIES: '2',
  }), 2);
});

test('empty primary backoff env falls back to legacy checkout backoff env', () => {
  assert.equal(reviewerHarness.resolveGeminiCheckoutConflictBackoffMs({
    AGENT_OS_GEMINI_CHECKOUT_409_BACKOFF_MS: '',
    GEMINI_CQP_CHECKOUT_409_BACKOFF_MS: '7',
  }), 7);
});

test('window=0 preserves the legacy attempt-count bound', async () => {
  reviewerHarness.resetGeminiCredentialCheckoutQueueForTest();
  // Operators who pinned the old behaviour keep it.
  let calls = 0;
  let clock = 0;
  await assert.rejects(
    reviewerHarness.checkoutGeminiCredentialFromBroker({
      env: {
        CQP_BROKER_URL: 'http://broker.test',
        AGENT_OS_GEMINI_CHECKOUT_409_RETRIES: '2',
        AGENT_OS_GEMINI_CHECKOUT_409_BACKOFF_MS: '1',
        AGENT_OS_GEMINI_CHECKOUT_409_WINDOW_MS: '0',
      },
      fetchImpl: async () => { calls += 1; return conflict(); },
      sleepImpl: async (ms) => { clock += ms; },
      nowImpl: () => clock,
      log: { warn() {} },
    }),
    (err) => err?.isGeminiCredentialPoolUnavailable === true,
  );
  assert.equal(calls, 3, 'retries=2 means 3 total attempts');
});

test('zero backoff still sleeps while the wall-clock window is active', async () => {
  reviewerHarness.resetGeminiCredentialCheckoutQueueForTest();
  const sleeps = [];
  let clock = 0;
  let calls = 0;
  const infos = [];
  const warnings = [];
  const result = await reviewerHarness.checkoutGeminiCredentialFromBroker({
    env: {
      CQP_BROKER_URL: 'http://broker.test',
      AGENT_OS_GEMINI_CHECKOUT_409_BACKOFF_MS: '0',
      AGENT_OS_GEMINI_CHECKOUT_409_WINDOW_MS: '1000',
    },
    fetchImpl: async () => {
      calls += 1;
      return calls <= 3 ? conflict() : successfulCheckout('after-zero-backoff');
    },
    sleepImpl: async (ms) => { sleeps.push(ms); clock += ms; },
    nowImpl: () => clock,
    log: {
      info(message) { infos.push(message); },
      warn(message) { warnings.push(message); },
    },
  });

  assert.equal(result.checkoutId, 'lease-after-zero-backoff');
  assert.deepEqual(sleeps, [50, 50, 50]);
  assert.equal(infos.length, 1, 'the wait-window diagnostic should be logged once at info');
  assert.match(infos[0], /Gemini credential checkout conflict/);
  assert.deepEqual(warnings, [], 'normal checkout queueing must not emit warn-level logs');
});

test('a non-409 failure still throws immediately', async () => {
  reviewerHarness.resetGeminiCredentialCheckoutQueueForTest();
  let calls = 0;
  await assert.rejects(
    reviewerHarness.checkoutGeminiCredentialFromBroker({
      env: { CQP_BROKER_URL: 'http://broker.test', AGENT_OS_GEMINI_CHECKOUT_409_WINDOW_MS: '600000' },
      fetchImpl: async () => { calls += 1; return response(500, { error: 'boom' }); },
      sleepImpl: async () => {},
      nowImpl: () => 0,
    }),
    (err) => err?.isGeminiCredentialPoolUnavailable === true,
  );
  assert.equal(calls, 1, 'a 500 must not be retried by the 409 window');
});
