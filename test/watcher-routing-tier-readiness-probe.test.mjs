// watcher-routing-tier-readiness-probe.test.mjs — proves the pre-spawn
// readiness probe returns a ready/not-ready decision before spawn. When the
// routing tier is down, the watcher now feeds that failure into the existing
// transient cascade path rather than silently releasing the claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import { probeRoutingTierReadiness } from '../src/watcher.mjs';

function mockResponse({ status = 200 } = {}) {
  return { status, ok: status >= 200 && status < 300 };
}

test('healthy 200 response → ready: true', async () => {
  const fetchFn = async () => mockResponse({ status: 200 });
  const result = await probeRoutingTierReadiness({
    env: { WATCHER_ROUTING_TIER_READINESS_PROBE_DISABLED: '' },
    fetchFn,
  });
  assert.equal(result.ready, true);
  assert.equal(result.reason, undefined);
});

test('503 Service Unavailable → ready: false with readiness_http_503', async () => {
  const fetchFn = async () => mockResponse({ status: 503 });
  const result = await probeRoutingTierReadiness({
    env: { WATCHER_ROUTING_TIER_READINESS_PROBE_DISABLED: '' },
    fetchFn,
  });
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'readiness_http_503');
  assert.equal(result.failureClass, 'cascade');
  assert.match(result.failureMessage, /HTTP 503/);
});

test('502 / 504 also produce readiness_http_{status}', async () => {
  for (const status of [502, 504]) {
    const fetchFn = async () => mockResponse({ status });
    const result = await probeRoutingTierReadiness({
      env: { WATCHER_ROUTING_TIER_READINESS_PROBE_DISABLED: '' },
      fetchFn,
    });
    assert.equal(result.ready, false);
    assert.equal(result.reason, `readiness_http_${status}`);
    assert.equal(result.failureClass, 'cascade');
  }
});

test('ECONNREFUSED → ready: false with routing_tier_connection_refused', async () => {
  const fetchFn = async () => {
    const err = new Error('connect ECONNREFUSED 127.0.0.1:4000');
    err.cause = { code: 'ECONNREFUSED' };
    throw err;
  };
  const result = await probeRoutingTierReadiness({
    env: { WATCHER_ROUTING_TIER_READINESS_PROBE_DISABLED: '' },
    fetchFn,
  });
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'routing_tier_connection_refused');
  assert.equal(result.failureClass, 'cascade');
  assert.match(result.failureMessage, /could not connect/i);
});

test('AbortError (timeout) → ready: false with readiness_timeout', async () => {
  const fetchFn = async () => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    throw err;
  };
  const result = await probeRoutingTierReadiness({
    env: { WATCHER_ROUTING_TIER_READINESS_PROBE_DISABLED: '' },
    fetchFn,
  });
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'readiness_timeout');
  assert.equal(result.failureClass, 'cascade');
  assert.match(result.failureMessage, /timed out/i);
});

test('other network errors surface their error code', async () => {
  const fetchFn = async () => {
    const err = new Error('socket hang up');
    err.cause = { code: 'ECONNRESET' };
    throw err;
  };
  const result = await probeRoutingTierReadiness({
    env: { WATCHER_ROUTING_TIER_READINESS_PROBE_DISABLED: '' },
    fetchFn,
  });
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'readiness_error_ECONNRESET');
  assert.equal(result.failureClass, 'cascade');
  assert.match(result.failureMessage, /ECONNRESET/);
});

test('WATCHER_ROUTING_TIER_READINESS_PROBE_DISABLED=1 short-circuits to ready: true', async () => {
  // No fetch is invoked. Confirms the disable knob works for tests that
  // don't run a LiteLLM proxy.
  let fetchCalled = false;
  const fetchFn = async () => {
    fetchCalled = true;
    throw new Error('fetch should not have been called');
  };
  const result = await probeRoutingTierReadiness({
    env: { WATCHER_ROUTING_TIER_READINESS_PROBE_DISABLED: '1' },
    fetchFn,
  });
  assert.equal(result.ready, true);
  assert.equal(result.skipped, true);
  assert.equal(fetchCalled, false);
});

test('WATCHER_ROUTING_TIER_READINESS_URL env var is honored', async () => {
  // Operator override (e.g. when LiteLLM lives on a non-default port). The
  // probe must hit the configured URL, not the default.
  let calledUrl = null;
  const fetchFn = async (url) => {
    calledUrl = String(url);
    return mockResponse({ status: 200 });
  };
  const result = await probeRoutingTierReadiness({
    env: {
      WATCHER_ROUTING_TIER_READINESS_PROBE_DISABLED: '',
      WATCHER_ROUTING_TIER_READINESS_URL: 'http://127.0.0.1:9999/custom-readiness',
    },
    fetchFn,
  });
  assert.equal(result.ready, true);
  assert.equal(calledUrl, 'http://127.0.0.1:9999/custom-readiness');
});

test('WATCHER_ROUTING_TIER_READINESS_TIMEOUT_MS env var is honored', async () => {
  // Override path exists; probe still proceeds successfully under a custom
  // timeout when the response arrives in time. (We don't test the actual
  // timer fire here — that's covered by the AbortError test above which
  // synthesizes the timeout-shaped error directly.)
  let signalSeen = null;
  const fetchFn = async (_url, opts) => {
    signalSeen = opts?.signal ?? null;
    return mockResponse({ status: 200 });
  };
  const result = await probeRoutingTierReadiness({
    env: {
      WATCHER_ROUTING_TIER_READINESS_PROBE_DISABLED: '',
      WATCHER_ROUTING_TIER_READINESS_TIMEOUT_MS: '500',
    },
    fetchFn,
  });
  assert.equal(result.ready, true);
  assert.ok(signalSeen, 'fetch should receive an AbortSignal regardless of timeout value');
});
