import test from 'node:test';
import assert from 'node:assert/strict';

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
