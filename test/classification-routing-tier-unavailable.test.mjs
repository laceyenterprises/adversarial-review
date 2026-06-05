// classification-routing-tier-unavailable.test.mjs — proves the classifier
// routes LiteLLM-bounce-window failures into the 'cascade' bucket so the
// watcher's attempt budget is not consumed. Regression target: 2026-06-04
// LiteLLM instability that emitted ~75% reviewer failure rate
// (18 ConnectionRefused failures vs 6 successful Review postings in a
// 500-log-line window) and posted permanent "FINAL — lenient threshold"
// verdicts on PRs whose attempt budget was burned mid-bounce.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyReviewerFailure,
} from '../src/adapters/reviewer-runtime/cli-direct/classification.mjs';

test('claude CLI "Unable to connect to API (ConnectionRefused)" stays unknown without local-routing context', () => {
  // Verbatim shape of the failure observed in the 2026-06-04 watcher log.
  const stderr = `[reviewer] DEBUG: starting claude review...
[reviewer] AI review failed for laceyenterprises/agent-os#1354: Command failed with code 1
stdout tail:
API Error: Unable to connect to API (ConnectionRefused)`;
  assert.equal(classifyReviewerFailure(stderr, 1), 'unknown');
});

test('bare "Unable to connect to API" stays unknown', () => {
  assert.equal(
    classifyReviewerFailure('Unable to connect to API', 1),
    'unknown'
  );
});

test('node-style ECONNREFUSED string classifies as cascade', () => {
  // The drift-watch LaunchAgent emits this exact shape against :4000.
  assert.equal(
    classifyReviewerFailure('connect ECONNREFUSED 127.0.0.1:4000', 1),
    'cascade'
  );
});

test('connection-refused traces require API or proxy context', () => {
  assert.equal(classifyReviewerFailure('Connection Refused', 1), 'unknown');
  assert.equal(classifyReviewerFailure('connection refused while connecting to API', 1), 'unknown');
  assert.equal(classifyReviewerFailure('CONNECTION REFUSED 127.0.0.1:4000', 1), 'cascade');
  assert.equal(classifyReviewerFailure('LiteLLM API Error: Unable to connect to API (ConnectionRefused)', 1), 'cascade');
});

test('"socket hang up" requires API or proxy context', () => {
  // Observed when LiteLLM workers receive SIGTERM mid-request.
  assert.equal(classifyReviewerFailure('socket hang up', 1), 'unknown');
  assert.equal(classifyReviewerFailure('API Error: socket hang up', 1), 'unknown');
  assert.equal(classifyReviewerFailure('LiteLLM API Error: socket hang up', 1), 'cascade');
});

test('HTTP 502/503/504 require routing-tier context', () => {
  assert.equal(classifyReviewerFailure('status 502', 1), 'unknown');
  assert.equal(classifyReviewerFailure('upstream returned status 502', 1), 'cascade');
  assert.equal(classifyReviewerFailure('HTTP/503 from API gateway', 1), 'cascade');
  assert.equal(classifyReviewerFailure('response: 504 from LiteLLM upstream', 1), 'cascade');
});

test('OAuth-broken still wins over routing-tier patterns when both match', () => {
  // The classifier comment block explicitly notes: OAuth wins over cascade
  // when both match. Confirm the routing-tier patterns don't accidentally
  // shadow oauth-broken (otherwise an operator-actionable rotate-token
  // alert would silently be downgraded into a transient backoff).
  const stderr = 'connect ECONNREFUSED 127.0.0.1:4000\nOAuth token expired';
  assert.equal(classifyReviewerFailure(stderr, 1), 'oauth-broken');
});

test('launchctl-bootstrap still wins over routing-tier patterns', () => {
  const stderr =
    'connect ECONNREFUSED 127.0.0.1:4000\nclaude launchctl session bootstrap failed';
  assert.equal(classifyReviewerFailure(stderr, 1), 'launchctl-bootstrap');
});

test('real 429 (mentionsReal429 set) does NOT classify as cascade', () => {
  // Defensive: routing-tier patterns must not steal real 429s into cascade.
  // The existing classifier suppresses cascade when `mentionsReal429` is set
  // (the `(mentionsRateLimit && !mentionsReal429)` guard); a real 429 falls
  // into the terminal 'unknown' bucket today (the classifier has no dedicated
  // 'rate-limit' class). What matters here is that the new routing-tier
  // patterns don't promote it back into 'cascade'.
  const stderr = 'API Error: 429 Too Many Requests — rate_limit_exceeded';
  const cls = classifyReviewerFailure(stderr, 1);
  assert.notEqual(cls, 'cascade');
});

test('benign success-shaped output classifies as unknown (no over-matching)', () => {
  // Stay conservative — patterns must not paint normal output as cascade.
  // The classifier's terminal fallback is 'unknown' (returned when no
  // pattern matches and no error code points to a known class).
  const cls = classifyReviewerFailure('Review posted successfully', 0);
  assert.equal(cls, 'unknown');
});

test('unrelated CLI error still classifies as unknown / bug (regression guard)', () => {
  // A non-routing-tier failure shape should NOT accidentally land in
  // cascade. Pre-existing classifier behavior: spawn-failed-with-ENOENT
  // returns 'bug'; random text falls into the terminal 'unknown' bucket.
  const enoentCls = classifyReviewerFailure('spawn failed', null, 'ENOENT');
  assert.equal(enoentCls, 'bug');
  const unknownCls = classifyReviewerFailure(
    'unexpected error parsing response payload at line 42',
    1
  );
  assert.equal(unknownCls, 'unknown');
});

test('unrelated helper/network failures do not get folded into cascade', () => {
  assert.equal(
    classifyReviewerFailure('unable to connect to linear webhook endpoint', 1),
    'unknown'
  );
  assert.equal(
    classifyReviewerFailure('database connection refused for local sqlite helper', 1),
    'unknown'
  );
});
