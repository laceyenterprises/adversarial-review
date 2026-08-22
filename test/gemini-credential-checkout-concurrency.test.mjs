import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { __test__ as reviewerHarness } from '../src/reviewer-harness.mjs';

function response(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() {
      return body;
    },
  };
}

function successfulCheckout(id) {
  return response(200, {
    checkout_id: `lease-${id}`,
    credential_id: `cred-${id}`,
    oauth_creds_json: JSON.stringify({ access_token: `token-${id}` }),
  });
}

test('Gemini broker checkout retries HTTP 409 before falling back to legacy credentials', async () => {
  reviewerHarness.resetGeminiCredentialCheckoutQueueForTest();
  const statuses = [409, 200];
  const sleeps = [];
  const result = await reviewerHarness.checkoutGeminiCredentialFromBroker({
    env: {
      CQP_BROKER_URL: 'http://broker.test',
      AGENT_OS_GEMINI_CHECKOUT_409_RETRIES: '2',
      AGENT_OS_GEMINI_CHECKOUT_409_BACKOFF_MS: '7',
    },
    fetchImpl: async () => {
      const status = statuses.shift();
      if (status === 409) return response(409, { error: 'checkout conflict' });
      return successfulCheckout('after-conflict');
    },
    sleepImpl: async (ms) => {
      sleeps.push(ms);
    },
  });

  assert.equal(result.checkoutId, 'lease-after-conflict');
  assert.deepEqual(sleeps, [7]);
});

test('Gemini broker checkout serializes concurrent callers in-process', async () => {
  reviewerHarness.resetGeminiCredentialCheckoutQueueForTest();
  let active = 0;
  let maxActive = 0;
  let call = 0;
  let releaseFirst;
  const firstEntered = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const holdFirst = new Promise((resolve) => {
    setImmediate(resolve);
  });

  const fetchImpl = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    call += 1;
    const id = call;
    if (id === 1) {
      releaseFirst();
      await holdFirst;
    }
    active -= 1;
    return successfulCheckout(id);
  };

  const first = reviewerHarness.checkoutGeminiCredentialFromBroker({
    env: { CQP_BROKER_URL: 'http://broker.test' },
    fetchImpl,
  });
  await firstEntered;
  const second = reviewerHarness.checkoutGeminiCredentialFromBroker({
    env: { CQP_BROKER_URL: 'http://broker.test' },
    fetchImpl,
  });

  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map((result) => result.checkoutId), ['lease-1', 'lease-2']);
  assert.equal(maxActive, 1);
});

// ── Orphaned-lease hardening (2026-08-22) ────────────────────────────────────
//
// The Gemini credential pool is a SINGLE credential (`default`). A reviewer that
// dies without releasing strands every other review until the lease TTL expires.
// Live that day: lease 7e6a131f acquired 17:36Z, holder gone by 17:38Z, still
// blocking until 18:06Z — and 2012 `checkout unavailable` fallbacks, each one
// degrading to the SERIALIZED legacy credential lock.
test('checkout lease TTL is short enough that an orphan self-heals quickly', async () => {
  const source = readFileSync(
    new URL('../src/reviewer-harness.mjs', import.meta.url),
    'utf8',
  );
  const match = source.match(/ttl_seconds:\s*(\d+)\s*\*\s*60/);
  assert.ok(match, 'checkout ttl_seconds must be expressed in minutes');
  const minutes = Number(match[1]);
  // A first-pass review takes ~2 minutes; keep real headroom but bound the
  // worst-case stall. 30 minutes was the live outage.
  assert.ok(
    minutes <= 10,
    `checkout lease TTL is ${minutes}m; an orphaned lease strands the whole `
    + 'single-credential pool for that long',
  );
  assert.ok(minutes >= 5, `checkout lease TTL ${minutes}m leaves too little headroom for a review`);
});

test('a terminating signal releases the checkout instead of stranding the pool', () => {
  const source = readFileSync(
    new URL('../src/reviewer-harness.mjs', import.meta.url),
    'utf8',
  );
  // `finally` does not run on a signal, and the watcher signals reviewer process
  // groups, so signal-release is the only non-TTL defense for SIGTERM.
  assert.match(source, /armGeminiCheckoutSignalRelease/);
  assert.match(source, /'SIGTERM',\s*'SIGINT',\s*'SIGHUP'/);
  // It must be armed at ACQUISITION, not at cleanup — a signal between acquire
  // and the finally block is exactly the leak window.
  const armIdx = source.indexOf('armGeminiCheckoutSignalRelease(() =>');
  const acquireIdx = source.indexOf('checkout = await checkoutGeminiCredentialImpl');
  assert.ok(acquireIdx !== -1 && armIdx > acquireIdx, 'signal release must arm right after acquisition');
});
