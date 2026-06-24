import assert from 'node:assert/strict';
import test from 'node:test';

import {
  _recordedSpansForTests,
  _resetForTests,
} from '../../../modules/agent-observability/lib/otel-emit.mjs';
import {
  emitReviewStarted,
  emitReviewVerdict,
  normalizeArVerdict,
} from '../src/tel-workflow.mjs';

test.beforeEach(() => {
  _resetForTests();
  process.env.AGENT_OS_OTEL_RECORD_SPANS_FOR_TESTS = '1';
});

test.afterEach(() => {
  delete process.env.AGENT_OS_OTEL_RECORD_SPANS_FOR_TESTS;
});

test('ar.review.started span carries adversarial-review app name only', () => {
  emitReviewStarted({
    repo: 'laceyenterprises/agent-os',
    prNumber: 123,
    reviewerClass: 'codex',
    riskClass: 'medium',
  });

  const [span] = _recordedSpansForTests();
  assert.equal(span.name, 'ar.review.started');
  assert.equal(span.attrs.application_name, 'agent-os-adversarial-review');
  assert.equal(span.attrs.reviewer_class, 'codex');
  assert.equal(span.attrs.risk_class, 'medium');
  assert.equal(span.attrs.pr_url, 'https://github.com/laceyenterprises/agent-os/pull/123');
  assert.equal(Object.hasOwn(span.attrs, 'worker_class'), false);
  assert.equal(span.links[0].attributes.lrq, 'unknown');
});

test('ar.review.verdict normalizes allowed verdict values', () => {
  emitReviewVerdict({
    repo: 'laceyenterprises/agent-os',
    prNumber: 124,
    reviewerClass: 'claude-code',
    verdict: 'Request changes',
  });

  const [span] = _recordedSpansForTests();
  assert.equal(span.name, 'ar.review.verdict');
  assert.equal(span.attrs.verdict, 'request_changes');
});

test('normalizeArVerdict maps supported convention values', () => {
  assert.equal(normalizeArVerdict('Approve'), 'approved');
  assert.equal(normalizeArVerdict('Comment only'), 'comment_only');
  assert.equal(normalizeArVerdict('Request changes'), 'request_changes');
});
