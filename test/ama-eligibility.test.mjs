import test from 'node:test';
import assert from 'node:assert/strict';

import { isEligibleForAmaClosure, __testables__ } from '../src/ama/eligibility.mjs';
import { DEFAULT_ADVERSARIAL_GATE_CONTEXT } from '../src/adversarial-gate-context.mjs';

const GATE_CONTEXT = DEFAULT_ADVERSARIAL_GATE_CONTEXT;
const ENV = { ADV_GATE_STATUS_CONTEXT: GATE_CONTEXT };

/**
 * Default eligible fixture: every gate passes. Each test below mutates ONE
 * gate at a time to verify the predicate fails on exactly that one gate
 * (and that the other gates stay green in `result.trace`).
 */
function eligibleFixture(overrides = {}) {
  const headSha = 'abc12345';
  const reviewState = {
    verdict: 'approved',
    headSha,
    riskClass: 'low',
    remediationPending: false,
    operatorApprovedEvidence: null,
    blockingFindingCount: 0,
    blockingFindingState: 'known',
    nonBlockingFindingCount: 0,
    nonBlockingFindingState: 'known',
    prAuthor: 'codex-worker-bot',
    reviewerFamily: 'claude',
    ...overrides.reviewState,
  };
  const prMetadata = {
    prNumber: 1234,
    headSha,
    isOpen: true,
    isDraft: false,
    mergeableState: 'MERGEABLE',
    labels: [],
    statusCheckRollup: [
      { __typename: 'CheckRun', name: 'lint', conclusion: 'SUCCESS' },
      { __typename: 'CheckRun', name: 'test', conclusion: 'SUCCESS' },
    ],
    branchProtection: { requiredContexts: [GATE_CONTEXT] },
    author: 'codex-worker-bot',
    ...overrides.prMetadata,
  };
  const cfg = {
    enabled: true,
    workerClass: 'codex',
    mergeMethod: 'squash',
    eligibility: {
      riskClasses: ['low'],
      fastMergeLabels: ['fast-merge:test-fixtures', 'fast-merge:docs'],
      reviewerFamilyPolicy: 'audit_existing_gate_contract',
      ciGreenClassifier: 'existingAdversarialMergeClassifier',
    },
    branchProtection: { requiredGateContextSource: 'resolveGateStatusContext' },
    ...overrides.cfg,
  };
  return { reviewState, prMetadata, cfg };
}

// ---------------------------------------------------------------------------
// Truth-table sanity: the fully-eligible default fixture is eligible.
// ---------------------------------------------------------------------------

test('eligible: a settled-success Approved review with all gates green is eligible', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture();
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, { env: ENV });
  assert.equal(result.eligible, true, JSON.stringify(result, null, 2));
  assert.deepEqual(result.reasons, []);
  assert.equal(result.trace.verdict.settledSuccess, true);
  assert.equal(result.trace.riskClass.allowed, true);
  assert.equal(result.trace.ciGreen.green, true);
  assert.equal(result.trace.branchProtection.ok, true);
  assert.deepEqual(result.trace.blockLabels, []);
});

test('eligible: Comment-only (clean) settled-success is eligible', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    reviewState: { verdict: 'comment-only' },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, { env: ENV });
  assert.equal(result.eligible, true, JSON.stringify(result, null, 2));
});

test('not eligible: Comment-only with open non-blocking findings requires remediation in strict mode', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    reviewState: {
      verdict: 'comment-only',
      nonBlockingFindingCount: 1,
      nonBlockingFindingState: 'known',
    },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, { env: ENV });
  assert.equal(result.eligible, false, JSON.stringify(result, null, 2));
  assert.ok(result.reasons.includes('non-blocking-findings-present'));
  assert.equal(result.trace.verdict.settledSuccess, false);
  assert.equal(result.trace.verdict.nonBlockingFindings.count, 1);
});

test('eligible: Comment-only with explicit None non-blocking section remains a direct close', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    reviewState: {
      verdict: 'comment-only',
      nonBlockingFindingCount: 0,
      nonBlockingFindingState: 'known',
    },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, { env: ENV });
  assert.equal(result.eligible, true, JSON.stringify(result, null, 2));
  assert.equal(result.trace.verdict.settledSuccess, true);
  assert.deepEqual(result.reasons, []);
});

test('not eligible: settled-success with unknown non-blocking state fails closed in strict mode', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    reviewState: {
      verdict: 'comment-only',
      nonBlockingFindingCount: 0,
      nonBlockingFindingState: 'unknown',
    },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, { env: ENV });
  assert.equal(result.eligible, false, JSON.stringify(result, null, 2));
  assert.ok(result.reasons.includes('verdict-not-settled-success'));
  assert.ok(result.reasons.includes('non-blocking-findings-unknown'));
  assert.equal(result.trace.verdict.nonBlockingFindings.known, false);
  assert.equal(result.trace.verdict.settledSuccess, false);
});

test('eligible: strict_non_blocking_remediation=false ignores non-blocking findings like prior behavior', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    reviewState: {
      verdict: 'comment-only',
      nonBlockingFindingCount: 2,
      nonBlockingFindingState: 'known',
    },
    cfg: { strictNonBlockingRemediation: false },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, { env: ENV });
  assert.equal(result.eligible, true, JSON.stringify(result, null, 2));
  assert.equal(result.trace.verdict.strictNonBlockingRemediation, false);
  assert.equal(result.trace.verdict.settledSuccess, true);
});

test('eligible: current-head operator-approved waives strict non-blocking finding gate', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    prMetadata: { labels: ['operator-approved'] },
    reviewState: {
      verdict: 'comment-only',
      nonBlockingFindingCount: 1,
      nonBlockingFindingState: 'known',
      operatorApprovedEvidence: {
        applied: true,
        observedRevisionRef: 'abc12345',
        actor: 'paul-the-operator',
        eventId: 'LE_operator',
        observedAt: '2026-06-10T20:00:00Z',
      },
    },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, { env: ENV });
  assert.equal(result.eligible, true, JSON.stringify(result, null, 2));
  assert.equal(result.trace.verdict.operatorOverride, true);
  assert.ok(!result.reasons.includes('non-blocking-findings-present'));
});

test('eligible: canonical rebase coverage clears stale-review-head', () => {
  const reviewedHead = '11111111';
  const currentHead = '22222222';
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    reviewState: { headSha: reviewedHead },
    prMetadata: { headSha: currentHead },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, {
    env: ENV,
    rebaseReviewCoverage: {
      active: true,
      reviewedHead,
      currentHead,
      evidence: 'content_equivalent_rebased_head',
      contentEquivalence: {
        equivalent: true,
        reviewedCount: 1,
        rebasedCount: 1,
        dropped: [],
        added: [],
      },
    },
  });
  assert.equal(result.eligible, true, JSON.stringify(result, null, 2));
  assert.ok(!result.reasons.includes('stale-review-head'));
  assert.equal(
    result.trace.headMatch.rebaseReviewCoverage.marker,
    'content_equivalent_rebased_head',
  );
});

test('not eligible: empty patch-id rebase coverage keeps stale-review-head', () => {
  const reviewedHead = '11111111';
  const currentHead = '22222222';
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    reviewState: { headSha: reviewedHead },
    prMetadata: { headSha: currentHead },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, {
    env: ENV,
    rebaseReviewCoverage: {
      active: true,
      reviewedHead,
      currentHead,
      evidence: 'content_equivalent_rebased_head',
      contentEquivalence: {
        equivalent: true,
        reviewedCount: 0,
        rebasedCount: 0,
        dropped: [],
        added: [],
      },
    },
  });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes('stale-review-head'));
  assert.equal(
    result.trace.headMatch.rebaseReviewCoverage.checks.contentEquivalenceNonEmpty,
    false,
  );
});

test('not eligible: rebase coverage ignores legacy enabled and marker aliases', () => {
  const reviewedHead = '11111111';
  const currentHead = '22222222';
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    reviewState: { headSha: reviewedHead },
    prMetadata: { headSha: currentHead },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, {
    env: ENV,
    rebaseReviewCoverage: {
      enabled: true,
      reviewedHead,
      currentHead,
      marker: 'content_equivalent_rebased_head',
      contentEquivalence: {
        equivalent: true,
        reviewedCount: 1,
        rebasedCount: 1,
        dropped: [],
        added: [],
      },
    },
  });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes('stale-review-head'));
  assert.equal(result.trace.headMatch.rebaseReviewCoverage.checks.active, false);
  assert.equal(result.trace.headMatch.rebaseReviewCoverage.checks.marker, false);
});

// ---------------------------------------------------------------------------
// Verdict gate (SPEC §4.2 #1)
// ---------------------------------------------------------------------------

test('not eligible: Request-changes verdict without operator-approved override', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    reviewState: { verdict: 'request-changes' },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, { env: ENV });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes('verdict-not-settled-success'));
  assert.equal(result.trace.verdict.settledSuccess, false);
});

test('eligible: Request-changes with current-head operator-approved override', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    prMetadata: { labels: ['operator-approved'] },
    reviewState: {
      verdict: 'request-changes',
      operatorApprovedEvidence: {
        applied: true,
        observedRevisionRef: 'abc12345',
        actor: 'paul-the-operator',
        eventId: 'LE_abc',
        observedAt: '2026-06-10T20:00:00Z',
      },
    },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, { env: ENV });
  assert.equal(result.eligible, true, JSON.stringify(result, null, 2));
  assert.equal(result.trace.verdict.operatorOverride, true);
});

test('eligible: same-login operator-approved override is allowed at single-operator scale', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    prMetadata: { labels: ['operator-approved'] },
    reviewState: {
      verdict: 'request-changes',
      operatorApprovedEvidence: {
        applied: true,
        observedRevisionRef: 'abc12345',
        actor: 'codex-worker-bot',
        eventId: 'LE_self',
        observedAt: '2026-06-10T20:00:00Z',
      },
    },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, { env: ENV });
  assert.equal(result.eligible, true, JSON.stringify(result, null, 2));
  assert.equal(result.trace.verdict.operatorOverride, true);
});

test('not eligible: stale operator-approved evidence (head changed since label) is ignored', () => {
  // SPEC §4.2 #4 / §6 AC#7 — operator-approved label events that were applied
  // at a stale head do NOT clear the verdict gate. The review itself is still
  // current (so the review-based head-match passes), but the override branch
  // is unavailable because the evidence is no longer head-scoped.
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    reviewState: {
      verdict: 'request-changes',
      operatorApprovedEvidence: {
        applied: true,
        // OLD head — does not match the PR's current head.
        observedRevisionRef: 'OLD-head-1111111',
        actor: 'paul-the-operator',
        eventId: 'LE_stale',
        observedAt: '2026-06-10T18:00:00Z',
      },
    },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, { env: ENV });
  assert.equal(result.eligible, false);
  // Verdict gate falls through because the override is stale.
  assert.ok(result.reasons.includes('verdict-not-settled-success'));
  assert.equal(result.trace.verdict.operatorOverride, false);
  // The review-based head-match still passes (review head == current head),
  // so stale-review-head is NOT in reasons — proves the stale label is
  // rejected on its own terms, not on a coincidental head mismatch.
  assert.ok(!result.reasons.includes('stale-review-head'));
});

test('not eligible: operator-approved evidence is ignored after the label is removed', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    prMetadata: { labels: [] },
    reviewState: {
      verdict: 'request-changes',
      operatorApprovedEvidence: {
        applied: true,
        observedRevisionRef: 'abc12345',
        actor: 'paul-the-operator',
        eventId: 'LE_revoked_operator',
        observedAt: '2026-06-10T20:00:00Z',
      },
    },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, { env: ENV });
  assert.equal(result.eligible, false);
  assert.equal(result.trace.verdict.operatorOverride, false);
  assert.ok(result.reasons.includes('verdict-not-settled-success'));
});

// ---------------------------------------------------------------------------
// Risk-class gate (SPEC §4.2 #3)
// ---------------------------------------------------------------------------

test('not eligible: high risk class is not in the default `low` allowlist', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    reviewState: { riskClass: 'high' },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, { env: ENV });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes('risk-class-not-permitted'));
  assert.equal(result.trace.riskClass.allowed, false);
});

test('eligible: medium risk class passes when the operator extends `risk_classes`', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    reviewState: { riskClass: 'medium' },
    cfg: {
      eligibility: {
        riskClasses: ['low', 'medium'],
        fastMergeLabels: ['fast-merge:test-fixtures', 'fast-merge:docs'],
        reviewerFamilyPolicy: 'audit_existing_gate_contract',
        ciGreenClassifier: 'existingAdversarialMergeClassifier',
      },
    },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, { env: ENV });
  assert.equal(result.eligible, true, JSON.stringify(result, null, 2));
});

test('not eligible: merge-agent-requested fallback label does not satisfy the AMA risk gate', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    prMetadata: { labels: ['operator-approved', 'merge-agent-requested'] },
    reviewState: {
      riskClass: 'critical',
      verdict: 'request-changes',
      operatorApprovedEvidence: {
        applied: true,
        observedRevisionRef: 'abc12345',
        actor: 'paul-the-operator',
        eventId: 'LE_operator',
        observedAt: '2026-06-10T20:00:00Z',
      },
    },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, {
    env: ENV,
    mergeAgentRequested: {
      applied: true,
      observedRevisionRef: 'abc12345',
      actor: 'paul-the-operator',
      eventId: 'LE_merge_requested',
      observedAt: '2026-06-10T20:00:00Z',
    },
  });
  assert.equal(result.eligible, false);
  assert.equal(result.trace.riskClass.permitted, false);
  assert.equal(result.trace.verdict.operatorOverride, true);
  assert.equal(result.trace.riskClass.adversarialMergeRequestedOverride, false);
  assert.ok(result.reasons.includes('risk-class-not-permitted'));
});

test('eligible: critical risk class requires current-head adversarial-merge-requested plus operator-approved', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    prMetadata: { labels: ['operator-approved', 'adversarial-merge-requested'] },
    reviewState: {
      riskClass: 'critical',
      verdict: 'request-changes',
      operatorApprovedEvidence: {
        applied: true,
        observedRevisionRef: 'abc12345',
        actor: 'paul-the-operator',
        eventId: 'LE_operator',
        observedAt: '2026-06-10T20:00:00Z',
      },
    },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, {
    env: ENV,
    adversarialMergeRequested: {
      applied: true,
      observedRevisionRef: 'abc12345',
      actor: 'paul-the-operator',
      eventId: 'LE_merge_requested',
      observedAt: '2026-06-10T20:01:00Z',
    },
  });
  assert.equal(result.eligible, true, JSON.stringify(result, null, 2));
  assert.equal(result.trace.riskClass.permitted, true);
  assert.equal(result.trace.riskClass.requiresTwoKey, true);
});

test('not eligible: adversarial-merge-requested from PR author is rejected', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    prMetadata: { labels: ['operator-approved', 'adversarial-merge-requested'] },
    reviewState: {
      riskClass: 'critical',
      verdict: 'request-changes',
      operatorApprovedEvidence: {
        applied: true,
        observedRevisionRef: 'abc12345',
        actor: 'paul-the-operator',
        eventId: 'LE_operator',
        observedAt: '2026-06-10T20:00:00Z',
      },
    },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, {
    env: ENV,
    adversarialMergeRequested: {
      applied: true,
      observedRevisionRef: 'abc12345',
      actor: prMetadata.author,
      eventId: 'LE_self_request',
      observedAt: '2026-06-10T20:01:00Z',
    },
  });
  assert.equal(result.eligible, false);
  assert.equal(result.trace.verdict.operatorOverride, true);
  assert.equal(result.trace.riskClass.adversarialMergeRequestedOverride, false);
  assert.ok(result.reasons.includes('risk-class-not-permitted'));
});

test('not eligible: adversarial-merge-requested evidence is ignored after the label is removed', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    prMetadata: { labels: ['operator-approved'] },
    reviewState: {
      riskClass: 'critical',
      verdict: 'request-changes',
      operatorApprovedEvidence: {
        applied: true,
        observedRevisionRef: 'abc12345',
        actor: 'paul-the-operator',
        eventId: 'LE_operator',
        observedAt: '2026-06-10T20:00:00Z',
      },
    },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, {
    env: ENV,
    adversarialMergeRequested: {
      applied: true,
      observedRevisionRef: 'abc12345',
      actor: 'paul-the-operator',
      eventId: 'LE_revoked_merge_requested',
      observedAt: '2026-06-10T20:01:00Z',
    },
  });
  assert.equal(result.eligible, false);
  assert.equal(result.trace.riskClass.adversarialMergeRequestedOverride, false);
  assert.ok(result.reasons.includes('risk-class-not-permitted'));
});

test('not eligible: `unknown` risk class is never in the default allowlist', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    reviewState: { riskClass: 'unknown' },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, { env: ENV });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes('risk-class-not-permitted'));
});

// ---------------------------------------------------------------------------
// `eligibility.high_risk_requires_two_key` — opt-out that lets AMA be the
// single authority for EVERY risk class. Default true preserves the two-key
// requirement for high/critical; `unknown` is never waived.
// ---------------------------------------------------------------------------

// Full eligibility sub-config (the fixture spread replaces `cfg.eligibility`
// wholesale, so each override must restate every key the predicate reads).
const eligibilityCfg = (highRiskRequiresTwoKey, riskClasses = ['low', 'medium', 'high', 'critical']) => ({
  eligibility: {
    riskClasses,
    fastMergeLabels: ['fast-merge:test-fixtures', 'fast-merge:docs'],
    reviewerFamilyPolicy: 'audit_existing_gate_contract',
    ciGreenClassifier: 'existingAdversarialMergeClassifier',
    highRiskRequiresTwoKey,
  },
});

test('eligible: high risk closes single-key when high_risk_requires_two_key=false and high is allowlisted', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    reviewState: { riskClass: 'high' },
    cfg: eligibilityCfg(false),
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, { env: ENV });
  assert.equal(result.eligible, true, JSON.stringify(result, null, 2));
  assert.equal(result.trace.riskClass.requiresTwoKey, false);
  assert.equal(result.trace.riskClass.highRiskRequiresTwoKey, false);
  assert.equal(result.trace.riskClass.permitted, true);
});

test('eligible: critical risk closes single-key when high_risk_requires_two_key=false and critical is allowlisted', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    reviewState: { riskClass: 'critical' },
    cfg: eligibilityCfg(false),
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, { env: ENV });
  assert.equal(result.eligible, true, JSON.stringify(result, null, 2));
  assert.equal(result.trace.riskClass.requiresTwoKey, false);
  assert.equal(result.trace.riskClass.permitted, true);
});

test('not eligible: `unknown` risk still requires two-key even when high_risk_requires_two_key=false', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    reviewState: { riskClass: 'unknown' },
    cfg: eligibilityCfg(false),
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, { env: ENV });
  assert.equal(result.eligible, false);
  assert.equal(result.trace.riskClass.requiresTwoKey, true);
  assert.ok(result.reasons.includes('risk-class-not-permitted'));
});

test('not eligible: high risk single-key still requires high in the allowlist', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    reviewState: { riskClass: 'high' },
    // knob waives two-key, but high is NOT in risk_classes -> still refused.
    cfg: eligibilityCfg(false, ['low', 'medium']),
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, { env: ENV });
  assert.equal(result.eligible, false);
  assert.equal(result.trace.riskClass.requiresTwoKey, false);
  assert.ok(result.reasons.includes('risk-class-not-permitted'));
});

test('not eligible: final hammer does not waive a missing high-risk allowlist entry', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    reviewState: {
      verdict: 'request-changes',
      riskClass: 'high',
      reviewCycleExhausted: true,
    },
    // High/critical may be single-key, but only when the class is configured.
    cfg: eligibilityCfg(false, ['low', 'medium']),
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, { env: ENV });
  assert.equal(result.eligible, false);
  assert.equal(result.trace.riskClass.requiresTwoKey, false);
  assert.equal(result.trace.riskClass.finalHammerWaivable, false);
  assert.ok(result.reasons.includes('risk-class-not-permitted'));
  assert.ok(!result.trace.finalHammer.waived.includes('risk-class-not-permitted'));
});

test('not eligible: high risk still requires two-key by default (knob unset) even if allowlisted', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    reviewState: { riskClass: 'high' },
    // highRiskRequiresTwoKey omitted -> predicate defaults it to true.
    cfg: {
      eligibility: {
        riskClasses: ['low', 'medium', 'high', 'critical'],
        fastMergeLabels: ['fast-merge:test-fixtures', 'fast-merge:docs'],
        reviewerFamilyPolicy: 'audit_existing_gate_contract',
        ciGreenClassifier: 'existingAdversarialMergeClassifier',
      },
    },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, { env: ENV });
  assert.equal(result.eligible, false);
  assert.equal(result.trace.riskClass.requiresTwoKey, true);
  assert.equal(result.trace.riskClass.highRiskRequiresTwoKey, true);
  assert.ok(result.reasons.includes('risk-class-not-permitted'));
});

// ---------------------------------------------------------------------------
// CI-green gate (SPEC §4.2 #5)
// ---------------------------------------------------------------------------

test('not eligible: a failing external check fails CI gate', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    prMetadata: {
      statusCheckRollup: [
        { __typename: 'CheckRun', name: 'lint', conclusion: 'SUCCESS' },
        { __typename: 'CheckRun', name: 'test', conclusion: 'FAILURE' },
      ],
    },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, { env: ENV });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes('ci-not-green'));
  assert.equal(result.trace.ciGreen.green, false);
});

test('not eligible: a pending external check fails CI gate', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    prMetadata: {
      statusCheckRollup: [
        { __typename: 'CheckRun', name: 'lint', conclusion: 'SUCCESS' },
        { __typename: 'CheckRun', name: 'test', status: 'IN_PROGRESS' },
      ],
    },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, { env: ENV });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes('ci-not-green'));
});

test('not eligible: missing statusCheckRollup fails closed as unknown CI', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    prMetadata: { statusCheckRollup: undefined },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, { env: ENV });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes('ci-not-green'));
  assert.equal(result.trace.ciGreen.conclusion, null);
});

test('not eligible: malformed statusCheckRollup object fails closed as unknown CI', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    prMetadata: { statusCheckRollup: {} },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, { env: ENV });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes('ci-not-green'));
  assert.equal(result.trace.ciGreen.conclusion, null);
});

test('eligible: only the adversarial-review self-gate is present → CI counts as green (no external checks)', () => {
  // SPEC §4.2 #5 — the classifier excludes the adversarial-review pipeline's
  // own status context to avoid circular gating. With only that context in
  // the rollup, the classifier returns SUCCESS and AMA proceeds.
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    prMetadata: {
      statusCheckRollup: [
        // Adversarial-review's own gate, in the failing state — still must
        // be excluded from the AMA classifier per SPEC §4.2 #5.
        { __typename: 'StatusContext', context: GATE_CONTEXT, state: 'FAILURE' },
      ],
    },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, { env: ENV });
  assert.equal(result.eligible, true, JSON.stringify(result, null, 2));
});

// ---------------------------------------------------------------------------
// Branch-protection gate (SPEC §4.2 #9 + AC#8)
// ---------------------------------------------------------------------------

test('not eligible: branch protection does NOT require the configured gate context', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    prMetadata: { branchProtection: { requiredContexts: ['unrelated/ci'] } },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, { env: ENV });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes('branch-protection-missing-gate'));
  assert.equal(result.trace.branchProtection.ok, false);
});

test('not eligible: branch protection has no required contexts at all', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    prMetadata: { branchProtection: { requiredContexts: [] } },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, { env: ENV });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes('branch-protection-missing-gate'));
});

test('eligible: branch_protection.required=false drops ONLY the gate requirement (plan without branch protection)', () => {
  // Simulates a repo whose GitHub plan offers no branch protection: the
  // gate context can never be present, so the operator opts out via
  // roles.adversarial.merge_authority.branch_protection.required=false.
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    prMetadata: { branchProtection: { requiredContexts: [] } },
    cfg: {
      branchProtection: {
        requiredGateContextSource: 'resolveGateStatusContext',
        required: false,
      },
    },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, { env: ENV });
  assert.equal(result.eligible, true, JSON.stringify(result, null, 2));
  assert.ok(!result.reasons.includes('branch-protection-missing-gate'));
  assert.equal(result.trace.branchProtection.required, false);
  assert.equal(result.trace.branchProtection.ok, true);
  assert.equal(result.trace.branchProtection.waived, true);
  assert.equal(result.trace.branchProtection.auditReason, 'branch_protection_requirement_waived');
});

test('not eligible: branch_protection.required=false still enforces every OTHER §4.2 gate', () => {
  // Opting out of branch protection must NOT weaken any other hard gate.
  // Here a blocking finding is present, so the PR stays ineligible even
  // though the branch-protection gate is waived.
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    reviewState: { blockingFindingCount: 1, blockingFindingState: 'known' },
    prMetadata: { branchProtection: { requiredContexts: [] } },
    cfg: {
      branchProtection: {
        requiredGateContextSource: 'resolveGateStatusContext',
        required: false,
      },
    },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, { env: ENV });
  assert.equal(result.eligible, false);
  assert.ok(!result.reasons.includes('branch-protection-missing-gate'));
  assert.ok(result.reasons.includes('blocking-findings-present'));
});

// ---------------------------------------------------------------------------
// Hard-stop label gate (SPEC §4.2 #6)
// ---------------------------------------------------------------------------

test('not eligible: `adversarial-merge-blocked` label always fails closed', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    prMetadata: { labels: ['adversarial-merge-blocked'] },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, { env: ENV });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes('label-adversarial-merge-blocked'));
});

test('not eligible: `do-not-merge` label fails closed', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    prMetadata: { labels: [{ name: 'do-not-merge' }] },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, { env: ENV });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes('label-do-not-merge'));
});

for (const label of [
  'merge-agent-skip',
  'do-not-merge',
  'no-merge-hold',
  'merge-agent-stuck',
  'adversarial-merge-blocked',
]) {
  test(`not eligible: GitHub-style ${label} label object fails closed`, () => {
    const { reviewState, prMetadata, cfg } = eligibleFixture({
      prMetadata: { labels: [{ name: label }] },
    });
    const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, { env: ENV });
    assert.equal(result.eligible, false);
    assert.ok(result.reasons.includes(`label-${label}`));
  });
}

test('not eligible: `merge-agent-stuck` label fails closed WITHOUT scoped recovery evidence', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    prMetadata: { labels: ['merge-agent-stuck'] },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, { env: ENV });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes('label-merge-agent-stuck'));
});

test('eligible: `merge-agent-stuck` label cleared by current-head merge-agent-requested recovery evidence', () => {
  // SPEC §4.2 #6 — the merge-agent-stuck carve-out for documented recovery.
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    prMetadata: { labels: ['merge-agent-stuck', 'merge-agent-requested'] },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, {
    env: ENV,
    recoveryEvidence: {
      kind: 'merge-agent-requested',
      applied: true,
      observedRevisionRef: 'abc12345',
      actor: 'paul-the-operator',
      eventId: 'LE_recovery',
      observedAt: '2026-06-10T20:30:00Z',
    },
  });
  assert.equal(result.eligible, true, JSON.stringify(result, null, 2));
  assert.deepEqual(result.trace.blockLabels, []);
});

test('eligible: `merge-agent-stuck` recovery allows same-login merge-agent-requested evidence', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    prMetadata: { labels: ['merge-agent-stuck', 'merge-agent-requested'] },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, {
    env: ENV,
    recoveryEvidence: {
      kind: 'merge-agent-requested',
      applied: true,
      observedRevisionRef: 'abc12345',
      actor: 'codex-worker-bot',
      eventId: 'LE_self_recovery',
      observedAt: '2026-06-10T20:30:00Z',
    },
  });
  assert.equal(result.eligible, true, JSON.stringify(result, null, 2));
  assert.deepEqual(result.trace.blockLabels, []);
});

test('not eligible: `merge-agent-stuck` is not cleared by plain operator-approved recovery evidence', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    prMetadata: { labels: ['merge-agent-stuck', 'operator-approved'] },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, {
    env: ENV,
    recoveryEvidence: {
      kind: 'operator-approved',
      applied: true,
      observedRevisionRef: 'abc12345',
      actor: 'paul-the-operator',
      eventId: 'LE_wrong_recovery',
      observedAt: '2026-06-10T20:30:00Z',
    },
  });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes('label-merge-agent-stuck'));
});

test('not eligible: `merge-agent-stuck` is not cleared by stale recovery-in-flight evidence', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    prMetadata: { labels: ['merge-agent-stuck', 'merge-agent-recovery-in-flight'] },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, {
    env: ENV,
    recoveryEvidence: {
      kind: 'merge-agent-recovery-in-flight',
      applied: true,
      observedRevisionRef: 'abc12345',
      actor: 'paul-the-operator',
      eventId: 'LE_stale_recovery',
      observedAt: '2026-06-10T20:30:00Z',
    },
  });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes('label-merge-agent-stuck'));
});

// ---------------------------------------------------------------------------
// Mergeability gate (SPEC §4.2 #7)
// ---------------------------------------------------------------------------

test('not eligible: closed PR fails the mergeability gate', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    prMetadata: { isOpen: false },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, { env: ENV });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes('pr-not-open'));
});

test('not eligible: draft PR fails the mergeability gate', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    prMetadata: { isDraft: true },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, { env: ENV });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes('pr-is-draft'));
});

test('not eligible: GitHub mergeableState=CONFLICTING fails the mergeability gate', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    prMetadata: { mergeableState: 'CONFLICTING' },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, { env: ENV });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes('pr-not-mergeable'));
});

// ---------------------------------------------------------------------------
// Remediation-pending gate
// ---------------------------------------------------------------------------

test('not eligible: remediation-pending=true fails closed without operator-approved override', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    reviewState: { remediationPending: true },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, { env: ENV });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes('remediation-pending'));
  // Verdict gate also fails because a settled-success requires not-pending.
  assert.ok(result.reasons.includes('verdict-not-settled-success'));
});

test('eligible: operator-approved clears remediation-pending when structural gates still pass', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    prMetadata: { labels: ['operator-approved'] },
    reviewState: {
      remediationPending: true,
      verdict: 'request-changes',
      operatorApprovedEvidence: {
        applied: true,
        observedRevisionRef: 'abc12345',
        actor: 'paul-the-operator',
        eventId: 'LE_remediation_override',
        observedAt: '2026-06-10T20:00:00Z',
      },
    },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, { env: ENV });
  assert.equal(result.eligible, true, JSON.stringify(result, null, 2));
  assert.ok(!result.reasons.includes('remediation-pending'));
});

test('not eligible: missing remediationPending fails closed without operator-approved override', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    reviewState: { remediationPending: undefined },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, { env: ENV });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes('remediation-state-unknown'));
  assert.equal(result.trace.remediation.known, false);
});

test('not eligible: malformed remediationPending fails closed without operator-approved override', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    reviewState: { remediationPending: 'false' },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, { env: ENV });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes('remediation-state-unknown'));
  assert.equal(result.trace.remediation.known, false);
});

test('not eligible: disabled AMA config fails closed even with a green snapshot', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    cfg: { enabled: false },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, { env: ENV });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes('ama-disabled'));
  assert.equal(result.trace.config.enabled, false);
});

test('not eligible: active fast-merge override state fails closed until AMA imports the FML contract', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    prMetadata: { labels: ['fast-merge:docs'] },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, {
    env: ENV,
    fastMergeState: {
      authorizedHeadSha: 'abc12345',
      currentHeadAuthorized: true,
      active: true,
    },
  });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes('fast-merge-state-unsupported'));
  assert.equal(result.trace.fastMerge.active, true);
});

test('not eligible: comment-only review with structured blocking findings is not settled success', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    reviewState: {
      verdict: 'comment-only',
      blockingFindingCount: 2,
      blockingFindingState: 'known',
    },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, { env: ENV });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes('blocking-findings-present'));
  assert.ok(result.reasons.includes('verdict-not-settled-success'));
  assert.equal(result.trace.verdict.blockingFindings.count, 2);
});

test('not eligible: approved review with structured blocking findings is not settled success', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    reviewState: {
      blockingFindingCount: 1,
      blockingFindingState: 'known',
    },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, { env: ENV });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes('blocking-findings-present'));
  assert.ok(result.reasons.includes('verdict-not-settled-success'));
});

test('not eligible: unknown blocker state fails closed even with approved verdict', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    reviewState: {
      blockingFindingCount: 0,
      blockingFindingState: 'unknown',
    },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, { env: ENV });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes('blocking-findings-unknown'));
  assert.ok(result.reasons.includes('verdict-not-settled-success'));
  assert.equal(result.trace.verdict.blockingFindings.known, false);
});

test('not eligible: malformed blocker count fails closed as unknown blocker state', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    reviewState: {
      blockingFindingCount: Number.NaN,
      blockingFindingState: 'known',
    },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, { env: ENV });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes('blocking-findings-unknown'));
  assert.ok(result.reasons.includes('verdict-not-settled-success'));
});

// ---------------------------------------------------------------------------
// Cross-cutting: multiple gates failing simultaneously
// ---------------------------------------------------------------------------

test('reasons accumulate when multiple gates fail at once', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    reviewState: { verdict: 'request-changes', riskClass: 'critical' },
    prMetadata: {
      labels: ['adversarial-merge-blocked'],
      statusCheckRollup: [
        { __typename: 'CheckRun', name: 'test', conclusion: 'FAILURE' },
      ],
    },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, { env: ENV });
  assert.equal(result.eligible, false);
  // All four gates must surface in reasons; operators read this to triage.
  assert.ok(result.reasons.includes('verdict-not-settled-success'));
  assert.ok(result.reasons.includes('risk-class-not-permitted'));
  assert.ok(result.reasons.includes('ci-not-green'));
  assert.ok(result.reasons.includes('label-adversarial-merge-blocked'));
});

// ---------------------------------------------------------------------------
// Override evidence: non-applied / non-attributable
// ---------------------------------------------------------------------------

test('operator-approved evidence with applied=false is ignored', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    prMetadata: { labels: ['operator-approved'] },
    reviewState: {
      verdict: 'request-changes',
      operatorApprovedEvidence: {
        applied: false,
        observedRevisionRef: 'abc12345',
        actor: 'paul-the-operator',
        eventId: 'LE_x',
        observedAt: '2026-06-10T20:00:00Z',
        reason: 'stale-or-non-attributable',
      },
    },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, { env: ENV });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes('verdict-not-settled-success'));
});

test('operator-approved evidence with actor=`unknown` fails closed', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    prMetadata: { labels: ['operator-approved'] },
    reviewState: {
      verdict: 'request-changes',
      operatorApprovedEvidence: {
        applied: true,
        observedRevisionRef: 'abc12345',
        actor: 'unknown',
        eventId: 'LE_unknown_actor',
        observedAt: '2026-06-10T20:00:00Z',
      },
    },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, { env: ENV });
  assert.equal(result.eligible, false);
  assert.equal(result.trace.verdict.operatorOverride, false);
});

test('operator-approved evidence missing event id fails closed', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    prMetadata: { labels: ['operator-approved'] },
    reviewState: {
      verdict: 'request-changes',
      operatorApprovedEvidence: {
        applied: true,
        observedRevisionRef: 'abc12345',
        actor: 'paul-the-operator',
        eventId: null,
        observedAt: '2026-06-10T20:00:00Z',
      },
    },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, { env: ENV });
  assert.equal(result.eligible, false);
  assert.equal(result.trace.verdict.operatorOverride, false);
});

test('operator-approved evidence missing observedAt fails closed', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    prMetadata: { labels: ['operator-approved'] },
    reviewState: {
      verdict: 'request-changes',
      operatorApprovedEvidence: {
        applied: true,
        observedRevisionRef: 'abc12345',
        actor: 'paul-the-operator',
        eventId: 'LE_missing_time',
        observedAt: null,
      },
    },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, { env: ENV });
  assert.equal(result.eligible, false);
  assert.equal(result.trace.verdict.operatorOverride, false);
});

test('adversarial-merge-requested evidence with applied=false is ignored', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    prMetadata: { labels: ['adversarial-merge-requested'] },
    reviewState: { riskClass: 'critical' },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, {
    env: ENV,
    adversarialMergeRequested: {
      applied: false,
      observedRevisionRef: 'abc12345',
      actor: 'paul-the-operator',
      eventId: 'LE_x',
      observedAt: '2026-06-10T20:00:00Z',
    },
  });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes('risk-class-not-permitted'));
});

test('adversarial-merge-requested evidence missing provenance fails closed', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    prMetadata: { labels: ['operator-approved', 'adversarial-merge-requested'] },
    reviewState: {
      riskClass: 'critical',
      verdict: 'request-changes',
      operatorApprovedEvidence: {
        applied: true,
        observedRevisionRef: 'abc12345',
        actor: 'paul-the-operator',
        eventId: 'LE_operator',
        observedAt: '2026-06-10T20:00:00Z',
      },
    },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, {
    env: ENV,
    adversarialMergeRequested: {
      applied: true,
      observedRevisionRef: 'abc12345',
      actor: 'unknown',
      eventId: null,
      observedAt: null,
    },
  });
  assert.equal(result.eligible, false);
  assert.equal(result.trace.riskClass.adversarialMergeRequestedOverride, false);
  assert.ok(result.reasons.includes('risk-class-not-permitted'));
});

// ---------------------------------------------------------------------------
// __testables__ — internal helpers exposed for finer-grained probing.
// ---------------------------------------------------------------------------

test('__testables__ hard-stop label set matches SPEC §4.2 #6', () => {
  // Lock the exact set so adding a new hard-stop later is a deliberate
  // code change with a test update.
  assert.deepEqual(
    [...__testables__.HARD_STOP_LABELS],
    [
      'merge-agent-skip',
      'do-not-merge',
      'no-merge-hold',
      'merge-agent-stuck',
      'adversarial-merge-blocked',
    ],
  );
});

test('__testables__ settled-success verdict set matches SPEC §4.2 #1', () => {
  assert.deepEqual(
    [...__testables__.SETTLED_SUCCESS_VERDICTS].sort(),
    ['approved', 'comment-only'].sort(),
  );
});

// ---------------------------------------------------------------------------
// AMA "final hammer" (operator directive 2026-06-14): at review-cycle exhaustion
// AMA waives the soft convergence gates but keeps the hard safety gates.
// ---------------------------------------------------------------------------

test('final hammer: exhausted cycle does NOT waive verdict/blocking without validated HAM evidence', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    reviewState: {
      verdict: 'request-changes',
      blockingFindingCount: 3,
      blockingFindingState: 'known',
      reviewCycleExhausted: true,
    },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, { env: ENV });
  // Budget exhaustion ALONE must NOT auto-merge a Request-changes head with a
  // blocking finding. The hammer must first produce validated terminal
  // remediation evidence.
  assert.equal(result.eligible, false, JSON.stringify(result, null, 2));
  assert.equal(result.trace.finalHammer.active, true);
  assert.ok(result.reasons.includes('verdict-not-settled-success'));
  assert.ok(result.reasons.includes('blocking-findings-present'));
  assert.ok(!result.trace.finalHammer.waived.includes('verdict-not-settled-success'));
});

test('final hammer: adversarial-merge-requested without validated HAM evidence does not waive verdict/blocking', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    prMetadata: { labels: ['adversarial-merge-requested'] },
    reviewState: {
      verdict: 'request-changes',
      blockingFindingCount: 2,
      blockingFindingState: 'known',
      reviewCycleExhausted: true,
    },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, {
    env: ENV,
    adversarialMergeRequested: {
      applied: true,
      observedRevisionRef: 'abc12345',
      actor: 'paul-the-operator',
      eventId: 'LE_adversarial_merge_requested',
      observedAt: '2026-06-10T20:00:00Z',
    },
  });

  assert.equal(result.eligible, false, JSON.stringify(result, null, 2));
  assert.equal(result.trace.riskClass.adversarialMergeRequestedOverride, true);
  assert.equal(result.trace.verdict.operatorOverride, false);
  assert.ok(result.reasons.includes('verdict-not-settled-success'));
  assert.ok(result.reasons.includes('blocking-findings-present'));
  assert.ok(!result.trace.finalHammer.waived.includes('verdict-not-settled-success'));
  assert.ok(!result.trace.finalHammer.waived.includes('blocking-findings-present'));
});

test('final hammer + current-head operator override remains an optional early authority', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    prMetadata: { labels: ['operator-approved'] },
    reviewState: {
      verdict: 'request-changes',
      blockingFindingCount: 3,
      blockingFindingState: 'known',
      reviewCycleExhausted: true,
      operatorApprovedEvidence: {
        applied: true,
        observedRevisionRef: 'abc12345',
        actor: 'paul-the-operator',
        eventId: 'LE_abc',
        observedAt: '2026-06-10T20:00:00Z',
      },
    },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, { env: ENV });
  assert.equal(result.eligible, true, JSON.stringify(result, null, 2));
  assert.equal(result.trace.verdict.operatorOverride, true);
});

test('final hammer: NEVER waives the structural branch-protection-missing-gate', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    // verdict satisfied by a current-head operator override so this isolates the
    // structural branch-protection gate.
    reviewState: {
      verdict: 'request-changes',
      reviewCycleExhausted: true,
      operatorApprovedEvidence: {
        applied: true,
        observedRevisionRef: 'abc12345',
        actor: 'paul-the-operator',
        eventId: 'LE_abc',
        observedAt: '2026-06-10T20:00:00Z',
      },
    },
    // repo GitHub plan offers no branch protection at all
    prMetadata: { labels: ['operator-approved'], branchProtection: { requiredContexts: [] } },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, { env: ENV });
  assert.equal(result.eligible, false, JSON.stringify(result, null, 2));
  assert.ok(result.reasons.includes('branch-protection-missing-gate'));
  assert.ok(!result.trace.finalHammer.waived.includes('branch-protection-missing-gate'));
});

test('final hammer: does NOT fire before the cycle is exhausted', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    reviewState: {
      verdict: 'request-changes',
      blockingFindingCount: 2,
      reviewCycleExhausted: false,
    },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, { env: ENV });
  assert.equal(result.eligible, false);
  assert.equal(result.trace.finalHammer.active, false);
  assert.ok(result.reasons.includes('verdict-not-settled-success'));
});

test('final hammer: NEVER waives a non-mergeable PR (hard gate)', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    reviewState: { verdict: 'request-changes', reviewCycleExhausted: true },
    prMetadata: { mergeableState: 'CONFLICTING' },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, { env: ENV });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes('pr-not-mergeable'));
});

test('final hammer: NEVER waives a red CI (hard gate)', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    reviewState: { verdict: 'request-changes', reviewCycleExhausted: true },
    prMetadata: {
      statusCheckRollup: [
        { __typename: 'CheckRun', name: 'test', conclusion: 'FAILURE' },
      ],
    },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, { env: ENV });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes('ci-not-green'));
});

test('final hammer: NEVER waives a head-scoped adversarial-merge-blocked hard stop', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    reviewState: { verdict: 'request-changes', reviewCycleExhausted: true },
    prMetadata: { labels: ['adversarial-merge-blocked'] },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, {
    env: ENV,
    adversarialMergeBlockedEvidence: { applied: true, observedRevisionRef: prMetadata.headSha },
  });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.some((r) => r.startsWith('label-')));
});

test('final hammer: high/critical risk still requires HAM evidence before terminal close', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    reviewState: { verdict: 'request-changes', riskClass: 'critical', reviewCycleExhausted: true },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, { env: ENV });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes('risk-class-not-permitted'));
});

test('final hammer: exhausted validated HAM remediation waives risk class without operator-approved', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    reviewState: {
      verdict: 'request-changes',
      riskClass: 'critical',
      blockingFindingCount: 1,
      blockingFindingState: 'known',
      reviewCycleExhausted: true,
    },
    prMetadata: { headSha: 'def67890' },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, {
    env: ENV,
    hamTerminalRemediation: hamEvidence(),
    hamTerminalRemediationGroundTruth: hamGroundTruth(),
  });
  assert.equal(result.eligible, true, JSON.stringify(result, null, 2));
  assert.equal(result.trace.verdict.operatorOverride, false);
  assert.ok(result.trace.finalHammer.waived.includes('risk-class-not-permitted'));
  assert.equal(result.trace.riskClass.requiresTwoKey, true);
  assert.equal(result.trace.riskClass.permitted, false);
});

test('final hammer: pre-exhaustion HAM remediation does not waive high/critical risk', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    reviewState: {
      verdict: 'request-changes',
      riskClass: 'critical',
      blockingFindingCount: 1,
      blockingFindingState: 'known',
      reviewCycleExhausted: false,
    },
    prMetadata: { headSha: 'def67890' },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, {
    env: ENV,
    hamTerminalRemediation: hamEvidence(),
    hamTerminalRemediationGroundTruth: hamGroundTruth(),
  });
  assert.equal(result.eligible, false, JSON.stringify(result, null, 2));
  assert.ok(result.reasons.includes('risk-class-not-permitted'));
  assert.equal(result.trace.finalHammer.active, false);
  assert.equal(result.trace.riskClass.finalHammerWaivable, false);
  assert.ok(!result.trace.finalHammer.waived.includes('risk-class-not-permitted'));
});

test('final hammer: operator-approved alone does not waive risk-class for medium not in allowlist', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    // verdict satisfied via operator override so this isolates the risk-class waiver.
    prMetadata: { labels: ['operator-approved'] },
    reviewState: {
      verdict: 'request-changes',
      riskClass: 'medium',
      reviewCycleExhausted: true,
      operatorApprovedEvidence: {
        applied: true,
        observedRevisionRef: 'abc12345',
        actor: 'paul-the-operator',
        eventId: 'LE_abc',
        observedAt: '2026-06-10T20:00:00Z',
      },
    },
    cfg: { eligibility: { riskClasses: ['low'] } }, // medium NOT permitted normally
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, { env: ENV });
  assert.equal(result.eligible, false, JSON.stringify(result, null, 2));
  assert.ok(result.reasons.includes('risk-class-not-permitted'));
  assert.ok(!result.trace.finalHammer.waived.includes('risk-class-not-permitted'));
});

test('final hammer: waives risk-class for medium not in allowlist with adversarial merge request', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    // verdict satisfied via operator override so this isolates the risk-class waiver.
    prMetadata: { labels: ['operator-approved', 'adversarial-merge-requested'] },
    reviewState: {
      verdict: 'request-changes',
      riskClass: 'medium',
      reviewCycleExhausted: true,
      operatorApprovedEvidence: {
        applied: true,
        observedRevisionRef: 'abc12345',
        actor: 'paul-the-operator',
        eventId: 'LE_abc',
        observedAt: '2026-06-10T20:00:00Z',
      },
    },
    cfg: { eligibility: { riskClasses: ['low'] } }, // medium NOT permitted normally
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, {
    env: ENV,
    adversarialMergeRequested: {
      applied: true,
      observedRevisionRef: 'abc12345',
      actor: 'paul-the-operator',
      eventId: 'LE_adversarial_merge_requested',
      observedAt: '2026-06-10T20:00:00Z',
    },
  });
  assert.equal(result.eligible, true, JSON.stringify(result, null, 2));
  assert.ok(result.trace.finalHammer.waived.includes('risk-class-not-permitted'));
});

// ---------------------------------------------------------------------------
// HAM terminal remediation (SPEC §1.1.1): a HAM-authored commit on top of the
// reviewed head can satisfy final-review findings without a re-review, but only
// with provenance, audit-comment mapping, live-head checks, and non-waived gates.
// ---------------------------------------------------------------------------

function hamEvidence({
  headSha = 'def67890',
  parentSha = 'abc12345',
  reviewedHead = parentSha,
  audit = true,
  workerClass = 'hammer',
  workerTicket = 'HAM',
  remediatedFindings = '2 addressed (1 blocking, 1 non-blocking)',
  auditBody = 'HAM audit: addressed Auth path not threaded in src/auth.js and README note is stale in README.md. Doc-currency: not applicable for changed files src/auth.js.',
  docCurrency = {
    status: 'not_applicable',
    changedFiles: ['src/auth.js'],
  },
  findings = [
    { title: 'Auth path not threaded', blocking: true, file: 'src/auth.js', addressed: true },
    { title: 'README note is stale', blocking: false, file: 'README.md', addressed: true },
  ],
} = {}) {
  return {
    active: true,
    ticket: workerTicket,
    commit: {
      sha: headSha,
      parentSha,
      trailers: {
        'Worker-Class': workerClass,
        'Worker-Ticket': workerTicket,
        'Reviewed-Head': reviewedHead,
        'Closed-By': 'hammer (adversarial-pipe-mode)',
        'Remediated-Findings': remediatedFindings,
      },
    },
    auditComment: audit
      ? {
          body: auditBody,
          docCurrency,
          findings,
        }
      : null,
  };
}

function hamGroundTruth({
  headSha = 'def67890',
  parentSha = 'abc12345',
  reviewedHead = parentSha,
  audit = true,
  workerClass = 'hammer',
  workerTicket = 'HAM',
  closedBy = 'hammer (adversarial-pipe-mode)',
  remediatedFindings = '2 addressed (1 blocking, 1 non-blocking)',
  auditAuthor = 'hammer-worker',
  changedFiles = ['src/auth.js'],
  auditBody = 'HAM audit: addressed Auth path not threaded in src/auth.js and README note is stale in README.md. Doc-currency: not applicable for changed files src/auth.js.',
} = {}) {
  return {
    commit: {
      sha: headSha,
      parentSha,
      author: 'hammer-worker',
      changedFiles,
      trailers: {
        'Worker-Class': workerClass,
        'Worker-Ticket': workerTicket,
        'Reviewed-Head': reviewedHead,
        'Closed-By': closedBy,
        'Remediated-Findings': remediatedFindings,
      },
    },
    auditComment: audit
      ? {
          body: auditBody,
          author: auditAuthor,
          createdAt: '2026-06-13T12:30:00Z',
          id: 'IC_ham_audit',
        }
      : null,
  };
}

test('ham terminal remediation: exhausted HAM-authored live head over reviewed parent is eligible and records marker', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    reviewState: {
      verdict: 'request-changes',
      blockingFindingCount: 1,
      blockingFindingState: 'known',
      reviewCycleExhausted: true,
    },
    prMetadata: { headSha: 'def67890' },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, {
    env: ENV,
    hamTerminalRemediation: {
      ...hamEvidence(),
      auditComment: {
        body: 'HAM audit: addressed Auth path not threaded in src/auth.js and README note is stale in README.md. Doc-currency: not applicable for changed files src/auth.js.',
        docCurrency: {
          status: 'not_applicable',
          changedFiles: ['src/auth.js'],
        },
        findings: [
          { title: 'Auth path not threaded', blocking: true, file: 'src/auth.js', addressed: true },
          { title: 'README note is stale', blocking: false, file: 'README.md', addressed: true },
        ],
      },
    },
    hamTerminalRemediationGroundTruth: hamGroundTruth(),
  });
  assert.equal(result.eligible, true, JSON.stringify(result, null, 2));
  assert.equal(result.trace.hamTerminalRemediation.marker, 'ham_terminal_remediation_validated');
  assert.equal(result.trace.hamTerminalRemediation.auditComment.author, 'hammer-worker');
  assert.deepEqual(result.trace.hamTerminalRemediation.verifiedCommit.changedFiles, ['src/auth.js']);
  assert.deepEqual(
    result.trace.hamTerminalRemediation.waived.sort(),
    ['blocking-findings-present', 'stale-review-head', 'verdict-not-settled-success'].sort(),
  );
});

test('ham terminal remediation: pre-exhaustion blocking request-changes stays on remediation loop', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    reviewState: {
      verdict: 'request-changes',
      blockingFindingCount: 1,
      blockingFindingState: 'known',
      reviewCycleExhausted: false,
    },
    prMetadata: { headSha: 'def67890' },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, {
    env: ENV,
    hamTerminalRemediation: hamEvidence(),
    hamTerminalRemediationGroundTruth: hamGroundTruth(),
  });
  assert.equal(result.trace.hamTerminalRemediation.ok, true);
  assert.equal(result.eligible, false, JSON.stringify(result, null, 2));
  assert.ok(result.reasons.includes('blocking-findings-present'));
  assert.ok(result.reasons.includes('verdict-not-settled-success'));
  assert.ok(!result.trace.hamTerminalRemediation.waived.includes('blocking-findings-present'));
});

test('ham terminal remediation: leaked build-time HAM-02 ticket is not valid provenance', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    reviewState: {
      verdict: 'request-changes',
      blockingFindingCount: 1,
      blockingFindingState: 'known',
    },
    prMetadata: { headSha: 'def67890' },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, {
    env: ENV,
    hamTerminalRemediation: hamEvidence({ workerTicket: 'HAM-02' }),
    hamTerminalRemediationGroundTruth: hamGroundTruth({ workerTicket: 'HAM-02' }),
  });

  assert.equal(result.eligible, false);
  assert.equal(result.trace.hamTerminalRemediation.checks.ticket, false);
  assert.equal(result.trace.hamTerminalRemediation.ok, false);
});

test('ham terminal remediation: server-rebased HAM commit proves reviewed head with trailer', () => {
  const reviewedHead = 'abc12345';
  const rebasedParent = 'fc53d29b';
  const currentHead = 'def67890';
  const auditBody = 'HAM audit: addressed Auth path not threaded in src/auth.js and README note is stale in README.md. Doc-currency: not applicable for changed files src/auth.js.';
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    reviewState: {
      headSha: reviewedHead,
      verdict: 'request-changes',
      blockingFindingCount: 1,
      blockingFindingState: 'known',
      reviewCycleExhausted: true,
    },
    prMetadata: { headSha: currentHead },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, {
    env: ENV,
    hamTerminalRemediation: {
      ...hamEvidence({
        headSha: currentHead,
        parentSha: reviewedHead,
        reviewedHead,
        auditBody,
      }),
      auditComment: {
        body: auditBody,
        docCurrency: {
          status: 'not_applicable',
          changedFiles: ['src/auth.js'],
        },
        findings: [
          { title: 'Auth path not threaded', blocking: true, file: 'src/auth.js', addressed: true },
          { title: 'README note is stale', blocking: false, file: 'README.md', addressed: true },
        ],
      },
    },
    hamTerminalRemediationGroundTruth: hamGroundTruth({
      headSha: currentHead,
      parentSha: rebasedParent,
      reviewedHead,
      auditAuthor: 'the-hammer-lacey[bot]',
      auditBody,
    }),
  });
  assert.equal(result.eligible, true, JSON.stringify(result, null, 2));
  assert.equal(result.trace.hamTerminalRemediation.checks.parent, true);
  assert.equal(result.trace.hamTerminalRemediation.checks.auditCommentAuthor, true);
  assert.equal(result.trace.hamTerminalRemediation.reviewedParent, reviewedHead);
  assert.equal(result.trace.hamTerminalRemediation.actualParent, rebasedParent);
  assert.equal(result.trace.hamTerminalRemediation.reviewedHeadTrailer, reviewedHead);
  assert.ok(result.trace.hamTerminalRemediation.waived.includes('stale-review-head'));
  assert.ok(result.trace.hamTerminalRemediation.waived.includes('verdict-not-settled-success'));
});

test('ham terminal remediation: valid evidence waives strict non-blocking finding gate', () => {
  const finding = { title: 'README note is stale', blocking: false, file: 'README.md', addressed: true };
  const auditBody = 'HAM audit: addressed README note is stale in README.md. Doc-currency: updated README.md for changed files README.md.';
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    reviewState: {
      verdict: 'comment-only',
      blockingFindingCount: 0,
      blockingFindingState: 'known',
      nonBlockingFindingCount: 1,
      nonBlockingFindingState: 'known',
      // Coverage gate input: the single current non-blocking finding identity
      // matches the HAM addressed finding title below, so coverage is met.
      nonBlockingFindingIdentities: ['readme note is stale'],
    },
    prMetadata: { headSha: 'def67890' },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, {
    env: ENV,
    hamTerminalRemediation: hamEvidence({
      remediatedFindings: '1 addressed (0 blocking, 1 non-blocking)',
      auditBody,
      docCurrency: {
        status: 'updated',
        changedFiles: ['README.md'],
        docsUpdated: ['README.md'],
      },
      findings: [finding],
    }),
    hamTerminalRemediationGroundTruth: hamGroundTruth({
      remediatedFindings: '1 addressed (0 blocking, 1 non-blocking)',
      auditBody,
      changedFiles: ['README.md'],
    }),
  });
  assert.equal(result.eligible, true, JSON.stringify(result, null, 2));
  assert.equal(result.trace.hamTerminalRemediation.marker, 'ham_terminal_remediation_validated');
  assert.ok(result.trace.hamTerminalRemediation.waived.includes('non-blocking-findings-present'));
  assert.equal(result.trace.hamTerminalRemediation.addressedFindings.nonBlocking, 1);
  assert.equal(result.trace.hamTerminalRemediation.nonBlockingCoverage.ok, true);
});

// Round-4 fix (2026-06-22): strict `.ok` must NOT bypass identity coverage for
// the non-blocking lane. `.ok` proves the addressed COUNT matches the current
// review and the HAM's own audit-coverage, but NOT that the HAM addressed the
// current review's specific non-blocking findings by identity. A HAM can match
// the count (1 addressed, 1 standing) while addressing a DIFFERENT finding.
test('ham terminal remediation: strict .ok does NOT bypass non-blocking identity coverage', () => {
  const finding = { title: 'README note is stale', blocking: false, file: 'README.md', addressed: true };
  const auditBody = 'HAM audit: addressed README note is stale in README.md. Doc-currency: updated README.md for changed files README.md.';
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    reviewState: {
      verdict: 'comment-only',
      blockingFindingCount: 0,
      blockingFindingState: 'known',
      nonBlockingFindingCount: 1,
      nonBlockingFindingState: 'known',
      // The current standing non-blocking finding is a DIFFERENT identity than
      // the one the HAM addressed — count matches (1 == 1), identity does not.
      nonBlockingFindingIdentities: ['unrelated nit the ham did not address'],
    },
    prMetadata: { headSha: 'def67890' },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, {
    env: ENV,
    hamTerminalRemediation: hamEvidence({
      remediatedFindings: '1 addressed (0 blocking, 1 non-blocking)',
      auditBody,
      docCurrency: { status: 'updated', changedFiles: ['README.md'], docsUpdated: ['README.md'] },
      findings: [finding],
    }),
    hamTerminalRemediationGroundTruth: hamGroundTruth({
      remediatedFindings: '1 addressed (0 blocking, 1 non-blocking)',
      auditBody,
      changedFiles: ['README.md'],
    }),
  });
  // `.ok` is true (full provenance + count-match) ...
  assert.equal(result.trace.hamTerminalRemediation.ok, true, JSON.stringify(result.trace.hamTerminalRemediation, null, 2));
  // ... but identity coverage fails, so the non-blocking finding is NOT waived.
  assert.equal(result.trace.hamTerminalRemediation.nonBlockingCoverage.ok, false);
  assert.equal(result.eligible, false, JSON.stringify(result, null, 2));
  assert.ok(result.reasons.includes('non-blocking-findings-present'));
  assert.ok(!result.trace.hamTerminalRemediation.waived.includes('non-blocking-findings-present'));
});

// Round-3 fix (2026-06-21): the non-blocking waiver is no longer dropped on bare
// `activeAuthorized` HAM evidence. Even with a real HAM commit + provenance +
// audit, the waiver requires the HAM's addressed non-blocking findings to COVER
// EVERY current standing non-blocking finding by identity. This is the
// reviewer's exact scenario: the review has 2 non-blocking findings, the HAM
// addressed only 1 → coverage not met → the PR does NOT merge.
test('ham terminal remediation: non-blocking waiver REFUSED when HAM covers only a subset of current non-blocking findings', () => {
  const finding = { title: 'README note is stale', blocking: false, file: 'README.md', addressed: true };
  const auditBody = 'HAM audit: addressed README note is stale in README.md. Doc-currency: updated README.md for changed files README.md.';
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    reviewState: {
      verdict: 'comment-only',
      blockingFindingCount: 0,
      blockingFindingState: 'known',
      // Two current standing non-blocking findings; the HAM addressed only the
      // first ('README note is stale'). The second is uncovered → no waiver.
      nonBlockingFindingCount: 2,
      nonBlockingFindingState: 'known',
      nonBlockingFindingIdentities: ['readme note is stale', 'unrelated nit still standing'],
    },
    prMetadata: { headSha: 'abc12345' },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, {
    env: ENV,
    hamTerminalRemediation: hamEvidence({
      headSha: 'abc12345',
      parentSha: 'abc12345',
      remediatedFindings: '1 addressed (0 blocking, 99 non-blocking)',
      auditBody,
      docCurrency: {
        status: 'updated',
        changedFiles: ['README.md'],
        docsUpdated: ['README.md'],
      },
      findings: [finding],
    }),
    hamTerminalRemediationGroundTruth: hamGroundTruth({
      headSha: 'abc12345',
      parentSha: 'abc12345',
      remediatedFindings: '1 addressed (0 blocking, 99 non-blocking)',
      auditBody,
      changedFiles: ['README.md'],
    }),
  });
  assert.equal(
    result.trace.hamTerminalRemediation.ok,
    false,
    JSON.stringify(result.trace.hamTerminalRemediation, null, 2),
  );
  assert.equal(result.trace.hamTerminalRemediation.activeAuthorized, true);
  assert.equal(result.trace.hamTerminalRemediation.nonBlockingCoverage.ok, false);
  assert.equal(result.eligible, false, JSON.stringify(result, null, 2));
  assert.ok(result.reasons.includes('non-blocking-findings-present'));
  assert.ok(!result.trace.hamTerminalRemediation.waived.includes('non-blocking-findings-present'));
});

test('ham terminal remediation: non-blocking waiver REFUSED when known count exceeds parsed identities', () => {
  const finding = { title: 'README note is stale', blocking: false, file: 'README.md', addressed: true };
  const auditBody = 'HAM audit: addressed README note is stale in README.md. Doc-currency: updated README.md for changed files README.md.';
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    reviewState: {
      verdict: 'comment-only',
      blockingFindingCount: 0,
      blockingFindingState: 'known',
      // Regression for compact legacy sections: the count path saw two
      // top-level bullets, while the identity parser only surfaced one title.
      // That one title being addressed must not waive the unparsed second
      // standing finding.
      nonBlockingFindingCount: 2,
      nonBlockingFindingState: 'known',
      nonBlockingFindingIdentities: ['readme note is stale'],
    },
    prMetadata: { headSha: 'abc12345' },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, {
    env: ENV,
    hamTerminalRemediation: hamEvidence({
      headSha: 'abc12345',
      parentSha: 'abc12345',
      remediatedFindings: '1 addressed (0 blocking, 99 non-blocking)',
      auditBody,
      docCurrency: {
        status: 'updated',
        changedFiles: ['README.md'],
        docsUpdated: ['README.md'],
      },
      findings: [finding],
    }),
    hamTerminalRemediationGroundTruth: hamGroundTruth({
      headSha: 'abc12345',
      parentSha: 'abc12345',
      remediatedFindings: '1 addressed (0 blocking, 99 non-blocking)',
      auditBody,
      changedFiles: ['README.md'],
    }),
  });
  assert.equal(result.trace.hamTerminalRemediation.activeAuthorized, true);
  assert.equal(result.trace.hamTerminalRemediation.nonBlockingCoverage.identityCoverageOk, false);
  assert.equal(result.trace.hamTerminalRemediation.nonBlockingCoverage.identityCountCoversKnownCount, false);
  assert.equal(result.trace.hamTerminalRemediation.nonBlockingCoverage.ok, false);
  assert.equal(result.eligible, false, JSON.stringify(result, null, 2));
  assert.ok(result.reasons.includes('non-blocking-findings-present'));
  assert.ok(!result.trace.hamTerminalRemediation.waived.includes('non-blocking-findings-present'));
});

// Coverage MET: when the HAM's addressed non-blocking findings cover EVERY
// current standing non-blocking finding by identity, the non-blocking waiver
// holds even though strict `.ok` finding-count provenance fails (the HAM's
// declared count never matches an ever-churning fresh review).
test('ham terminal remediation: non-blocking waiver GRANTED when HAM covers every current non-blocking finding by identity', () => {
  const findings = [
    { title: 'README note is stale', blocking: false, file: 'README.md', addressed: true },
    { title: 'Typo in CONTRIBUTING', blocking: false, file: 'CONTRIBUTING.md', addressed: true },
  ];
  const auditBody = 'HAM audit: addressed README note is stale in README.md and Typo in CONTRIBUTING in CONTRIBUTING.md. Doc-currency: updated README.md for changed files README.md.';
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    reviewState: {
      verdict: 'comment-only',
      blockingFindingCount: 0,
      blockingFindingState: 'known',
      nonBlockingFindingCount: 2,
      nonBlockingFindingState: 'known',
      nonBlockingFindingIdentities: ['readme note is stale', 'typo in contributing'],
    },
    prMetadata: { headSha: 'abc12345' },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, {
    env: ENV,
    hamTerminalRemediation: hamEvidence({
      headSha: 'abc12345',
      parentSha: 'abc12345',
      // Strict count mismatch on purpose: 99 declared vs 2 in the map → .ok=false.
      remediatedFindings: '2 addressed (0 blocking, 99 non-blocking)',
      auditBody,
      docCurrency: {
        status: 'updated',
        changedFiles: ['README.md'],
        docsUpdated: ['README.md'],
      },
      findings,
    }),
    hamTerminalRemediationGroundTruth: hamGroundTruth({
      headSha: 'abc12345',
      parentSha: 'abc12345',
      remediatedFindings: '2 addressed (0 blocking, 99 non-blocking)',
      auditBody,
      changedFiles: ['README.md'],
    }),
  });
  assert.equal(
    result.trace.hamTerminalRemediation.ok,
    false,
    JSON.stringify(result.trace.hamTerminalRemediation, null, 2),
  );
  assert.equal(result.trace.hamTerminalRemediation.activeAuthorized, true);
  assert.equal(result.trace.hamTerminalRemediation.nonBlockingCoverage.ok, true);
  assert.equal(result.eligible, true, JSON.stringify(result, null, 2));
  assert.ok(result.trace.hamTerminalRemediation.waived.includes('non-blocking-findings-present'));
  assert.ok(!result.reasons.includes('non-blocking-findings-present'));
});

// Fail closed: identities unknown (not supplied) while the review reports
// non-blocking findings present → no waiver regardless of activeAuthorized HAM.
test('ham terminal remediation: non-blocking waiver REFUSED when current non-blocking identities are unknown', () => {
  const finding = { title: 'README note is stale', blocking: false, file: 'README.md', addressed: true };
  const auditBody = 'HAM audit: addressed README note is stale in README.md. Doc-currency: updated README.md for changed files README.md.';
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    reviewState: {
      verdict: 'comment-only',
      blockingFindingCount: 0,
      blockingFindingState: 'known',
      nonBlockingFindingCount: 1,
      nonBlockingFindingState: 'known',
      // Identities deliberately omitted → undefined → fail closed.
    },
    prMetadata: { headSha: 'abc12345' },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, {
    env: ENV,
    hamTerminalRemediation: hamEvidence({
      headSha: 'abc12345',
      parentSha: 'abc12345',
      remediatedFindings: '1 addressed (0 blocking, 99 non-blocking)',
      auditBody,
      docCurrency: {
        status: 'updated',
        changedFiles: ['README.md'],
        docsUpdated: ['README.md'],
      },
      findings: [finding],
    }),
    hamTerminalRemediationGroundTruth: hamGroundTruth({
      headSha: 'abc12345',
      parentSha: 'abc12345',
      remediatedFindings: '1 addressed (0 blocking, 99 non-blocking)',
      auditBody,
      changedFiles: ['README.md'],
    }),
  });
  assert.equal(result.trace.hamTerminalRemediation.activeAuthorized, true);
  assert.equal(result.trace.hamTerminalRemediation.nonBlockingCoverage.ok, false);
  assert.equal(result.eligible, false, JSON.stringify(result, null, 2));
  assert.ok(result.reasons.includes('non-blocking-findings-present'));
});

// Trivial coverage: zero current non-blocking findings + activeAuthorized HAM
// → still eligible (coverage trivially satisfied, no waiver even needed).
test('ham terminal remediation: zero current non-blocking findings remains eligible (trivial coverage)', () => {
  const auditBody = 'HAM audit: addressed Auth path not threaded in src/auth.js. Doc-currency: updated src/auth.js for changed files src/auth.js.';
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    reviewState: {
      // Request-changes head with a real blocking finding the HAM remediated
      // (strict .ok lane) and ZERO current non-blocking findings → the
      // non-blocking coverage gate is trivially satisfied and never blocks.
      verdict: 'request-changes',
      blockingFindingCount: 1,
      blockingFindingState: 'known',
      nonBlockingFindingCount: 0,
      nonBlockingFindingState: 'known',
      nonBlockingFindingIdentities: [],
      reviewCycleExhausted: true,
    },
    prMetadata: { headSha: 'abc12345' },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, {
    env: ENV,
    hamTerminalRemediation: hamEvidence({
      headSha: 'abc12345',
      parentSha: 'abc12345',
      remediatedFindings: '1 addressed (1 blocking, 0 non-blocking)',
      auditBody,
      docCurrency: {
        status: 'updated',
        changedFiles: ['src/auth.js'],
        docsUpdated: ['src/auth.js'],
      },
      findings: [{ title: 'Auth path not threaded', blocking: true, file: 'src/auth.js', addressed: true }],
    }),
    hamTerminalRemediationGroundTruth: hamGroundTruth({
      headSha: 'abc12345',
      parentSha: 'abc12345',
      remediatedFindings: '1 addressed (1 blocking, 0 non-blocking)',
      auditBody,
      changedFiles: ['src/auth.js'],
    }),
  });
  assert.equal(result.trace.hamTerminalRemediation.activeAuthorized, true);
  assert.equal(result.trace.hamTerminalRemediation.nonBlockingCoverage.ok, true);
  assert.equal(result.eligible, true, JSON.stringify(result, null, 2));
});

test('ham terminal remediation: clean zero-finding review accepts empty finding map', () => {
  const auditBody = 'HAM audit: final review had no blocking or non-blocking findings. Doc-currency: updated modules/worker-pool/worker-pool-walkthrough.md.';
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    reviewState: {
      verdict: 'comment-only',
      blockingFindingCount: 0,
      blockingFindingState: 'known',
      nonBlockingFindingCount: 0,
      nonBlockingFindingState: 'known',
      nonBlockingFindingIdentities: [],
    },
    prMetadata: { headSha: 'def67890' },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, {
    env: ENV,
    hamTerminalRemediation: hamEvidence({
      headSha: 'def67890',
      parentSha: 'abc12345',
      remediatedFindings: '0 addressed (0 blocking, 0 non-blocking)',
      auditBody,
      docCurrency: {
        status: 'updated',
        changedFiles: ['modules/worker-pool/worker-pool-walkthrough.md'],
        docsUpdated: ['modules/worker-pool/worker-pool-walkthrough.md'],
      },
      findings: [],
    }),
    hamTerminalRemediationGroundTruth: hamGroundTruth({
      headSha: 'def67890',
      parentSha: 'abc12345',
      remediatedFindings: '0 addressed (0 blocking, 0 non-blocking)',
      auditAuthor: 'lacey-merge-agent[bot]',
      auditBody,
      changedFiles: ['modules/worker-pool/worker-pool-walkthrough.md'],
    }),
  });
  assert.equal(result.trace.hamTerminalRemediation.activeAuthorized, true);
  assert.equal(result.eligible, true, JSON.stringify(result, null, 2));
});

test('ham terminal remediation: self-attested active does not waive strict non-blocking gate', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    reviewState: {
      verdict: 'comment-only',
      blockingFindingCount: 0,
      blockingFindingState: 'known',
      nonBlockingFindingCount: 1,
      nonBlockingFindingState: 'known',
    },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, {
    env: ENV,
    hamTerminalRemediation: { active: true },
  });
  assert.equal(result.trace.hamTerminalRemediation.active, true);
  assert.equal(result.trace.hamTerminalRemediation.activeAuthorized, false);
  assert.equal(result.trace.hamTerminalRemediation.ok, false);
  assert.equal(result.eligible, false, JSON.stringify(result, null, 2));
  assert.ok(result.reasons.includes('non-blocking-findings-present'));
  assert.ok(!result.trace.hamTerminalRemediation.waived.includes('non-blocking-findings-present'));
});

test('ham terminal remediation: request-changes with known-zero blockers is not waived on .active alone', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    reviewState: {
      verdict: 'request-changes',
      blockingFindingCount: 0,
      blockingFindingState: 'known',
      nonBlockingFindingCount: 0,
      nonBlockingFindingState: 'known',
    },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, {
    env: ENV,
    hamTerminalRemediation: { active: true },
  });
  assert.equal(result.trace.hamTerminalRemediation.ok, false);
  assert.equal(result.eligible, false, JSON.stringify(result, null, 2));
  assert.ok(result.reasons.includes('verdict-not-settled-success'));
  assert.ok(!result.trace.hamTerminalRemediation.waived.includes('verdict-not-settled-success'));
});

test('ham terminal remediation: blocking findings are NOT waived without strict .ok provenance', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    reviewState: {
      verdict: 'request-changes',
      blockingFindingCount: 1,
      blockingFindingState: 'known',
    },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, {
    env: ENV,
    // active but NOT validated: an entitled hammer can't merge past a real blocker
    // it hasn't proven it remediated.
    hamTerminalRemediation: { active: true },
  });
  assert.equal(result.trace.hamTerminalRemediation.ok, false);
  assert.equal(result.eligible, false, JSON.stringify(result, null, 2));
  assert.ok(result.reasons.includes('blocking-findings-present'));
});

test('ham terminal remediation: claimed doc updates must be in the verified diff', () => {
  const auditBody = [
    'HAM audit: addressed Auth path not threaded in src/auth.js and README note is stale in README.md.',
    'Doc-currency: updated docs/data-model/catalog.json for changed files migrations/001-add-profile.sql.',
  ].join(' ');
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    reviewState: {
      verdict: 'request-changes',
      blockingFindingCount: 1,
      blockingFindingState: 'known',
    },
    prMetadata: { headSha: 'def67890' },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, {
    env: ENV,
    hamTerminalRemediation: {
      ...hamEvidence({
        auditBody,
        docCurrency: {
          status: 'updated',
          changedFiles: ['migrations/001-add-profile.sql'],
          docsUpdated: ['docs/data-model/catalog.json'],
        },
      }),
      auditComment: {
        body: auditBody,
        docCurrency: {
          status: 'updated',
          changedFiles: ['migrations/001-add-profile.sql'],
          docsUpdated: ['docs/data-model/catalog.json'],
        },
        findings: [
          { title: 'Auth path not threaded', blocking: true, file: 'src/auth.js', addressed: true },
          { title: 'README note is stale', blocking: false, file: 'README.md', addressed: true },
        ],
      },
    },
    hamTerminalRemediationGroundTruth: hamGroundTruth({
      auditBody,
      changedFiles: ['migrations/001-add-profile.sql'],
    }),
  });
  assert.equal(result.eligible, false);
  assert.equal(result.trace.hamTerminalRemediation.checks.docCurrency, false);
  assert.equal(result.trace.hamTerminalRemediation.docCurrency.docsUpdatedInCommit, false);
});

test('ham terminal remediation: later non-HAM live head is rejected', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    reviewState: {
      verdict: 'request-changes',
      blockingFindingCount: 1,
      blockingFindingState: 'known',
    },
    prMetadata: { headSha: 'fedcba09' },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, {
    env: ENV,
    hamTerminalRemediation: hamEvidence({ headSha: 'def67890' }),
    hamTerminalRemediationGroundTruth: hamGroundTruth({ headSha: 'def67890' }),
  });
  assert.equal(result.eligible, false);
  assert.equal(result.trace.hamTerminalRemediation.ok, false);
  assert.equal(result.trace.hamTerminalRemediation.marker, null);
  assert.ok(result.reasons.includes('stale-review-head'));
});

test('ham terminal remediation: absent audit/provenance evidence is rejected', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    reviewState: {
      verdict: 'request-changes',
      blockingFindingCount: 1,
      blockingFindingState: 'known',
    },
    prMetadata: { headSha: 'def67890' },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, {
    env: ENV,
    hamTerminalRemediation: hamEvidence({ audit: false, workerClass: 'codex' }),
    hamTerminalRemediationGroundTruth: hamGroundTruth({ audit: false, workerClass: 'codex' }),
  });
  assert.equal(result.eligible, false);
  assert.equal(result.trace.hamTerminalRemediation.ok, false);
  assert.equal(result.trace.hamTerminalRemediation.checks.workerClass, false);
  assert.equal(result.trace.hamTerminalRemediation.checks.auditComment, false);
  assert.ok(result.reasons.includes('verdict-not-settled-success'));
});

test('ham terminal remediation: failed live-head checks still block merge', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    reviewState: {
      verdict: 'request-changes',
      blockingFindingCount: 1,
      blockingFindingState: 'known',
    },
    prMetadata: {
      headSha: 'def67890',
      statusCheckRollup: [
        { __typename: 'CheckRun', name: 'test', conclusion: 'FAILURE' },
      ],
    },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, {
    env: ENV,
    hamTerminalRemediation: {
      ...hamEvidence(),
      auditComment: {
        body: 'HAM audit: addressed Auth path not threaded in src/auth.js and README note is stale in README.md. Doc-currency: not applicable for changed files src/auth.js.',
        docCurrency: {
          status: 'not_applicable',
          changedFiles: ['src/auth.js'],
        },
        findings: [
          { title: 'Auth path not threaded', blocking: true, file: 'src/auth.js', addressed: true },
          { title: 'README note is stale', blocking: false, file: 'README.md', addressed: true },
        ],
      },
    },
    hamTerminalRemediationGroundTruth: hamGroundTruth(),
  });
  assert.equal(result.eligible, false);
  assert.equal(result.trace.hamTerminalRemediation.marker, 'ham_terminal_remediation_validated');
  assert.ok(result.reasons.includes('ci-not-green'));
});

test('ham terminal remediation: forged self-attested parent and trailers do not waive gates', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    reviewState: {
      verdict: 'request-changes',
      blockingFindingCount: 1,
      blockingFindingState: 'known',
    },
    prMetadata: { headSha: 'def67890' },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, {
    env: ENV,
    hamTerminalRemediation: {
      ...hamEvidence(),
      auditComment: {
        body: 'HAM audit: addressed Auth path not threaded in src/auth.js and README note is stale in README.md. Doc-currency: not applicable for changed files src/auth.js.',
        docCurrency: {
          status: 'not_applicable',
          changedFiles: ['src/auth.js'],
        },
        findings: [
          { title: 'Auth path not threaded', blocking: true, file: 'src/auth.js', addressed: true },
          { title: 'README note is stale', blocking: false, file: 'README.md', addressed: true },
        ],
      },
    },
    hamTerminalRemediationGroundTruth: hamGroundTruth({
      parentSha: '00000000',
      workerClass: 'codex',
    }),
  });
  assert.equal(result.eligible, false);
  assert.equal(result.trace.hamTerminalRemediation.ok, false);
  assert.equal(result.trace.hamTerminalRemediation.checks.workerClass, false);
  assert.equal(result.trace.hamTerminalRemediation.checks.parent, false);
  assert.ok(result.reasons.includes('verdict-not-settled-success'));
});

test('ham terminal remediation: forged audit author, loose closed-by, bad counts, or empty diff are rejected', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    reviewState: {
      verdict: 'request-changes',
      blockingFindingCount: 1,
      blockingFindingState: 'known',
    },
    prMetadata: { headSha: 'def67890' },
  });
  const validEvidence = {
    ...hamEvidence(),
    auditComment: {
      body: 'HAM audit: addressed Auth path not threaded in src/auth.js and README note is stale in README.md. Doc-currency: not applicable for changed files src/auth.js.',
      docCurrency: {
        status: 'not_applicable',
        changedFiles: ['src/auth.js'],
      },
      findings: [
        { title: 'Auth path not threaded', blocking: true, file: 'src/auth.js', addressed: true },
        { title: 'README note is stale', blocking: false, file: 'README.md', addressed: true },
      ],
    },
  };

  const forgedAuthor = isEligibleForAmaClosure(reviewState, prMetadata, cfg, {
    env: ENV,
    hamTerminalRemediation: validEvidence,
    hamTerminalRemediationGroundTruth: hamGroundTruth({ auditAuthor: 'codex-worker-bot' }),
  });
  assert.equal(forgedAuthor.eligible, false);
  assert.equal(forgedAuthor.trace.hamTerminalRemediation.checks.auditCommentAuthor, false);

  const looseClosedBy = isEligibleForAmaClosure(reviewState, prMetadata, cfg, {
    env: ENV,
    hamTerminalRemediation: validEvidence,
    hamTerminalRemediationGroundTruth: hamGroundTruth({ closedBy: 'hammer-closer (adversarial-pipe-mode)' }),
  });
  assert.equal(looseClosedBy.eligible, false);
  assert.equal(looseClosedBy.trace.hamTerminalRemediation.checks.closedBy, false);

  const mismatchedCounts = isEligibleForAmaClosure(reviewState, prMetadata, cfg, {
    env: ENV,
    hamTerminalRemediation: validEvidence,
    hamTerminalRemediationGroundTruth: hamGroundTruth({ remediatedFindings: '2 addressed (0 blocking, 2 non-blocking)' }),
  });
  assert.equal(mismatchedCounts.eligible, false);
  assert.equal(mismatchedCounts.trace.hamTerminalRemediation.checks.remediatedFindings, false);

  const emptyDiff = isEligibleForAmaClosure(reviewState, prMetadata, cfg, {
    env: ENV,
    hamTerminalRemediation: validEvidence,
    hamTerminalRemediationGroundTruth: hamGroundTruth({ changedFiles: [] }),
  });
  assert.equal(emptyDiff.eligible, false);
  assert.equal(emptyDiff.trace.hamTerminalRemediation.checks.nonEmptyCommit, false);
});

test('exhausted request-changes with blocking findings is eligible after validated HAM remediation without operator-approved', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    reviewState: {
      verdict: 'request-changes',
      blockingFindingCount: 1,
      blockingFindingState: 'known',
      reviewCycleExhausted: true,
    },
    prMetadata: {
      headSha: 'def67890',
    },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, {
    env: ENV,
    hamTerminalRemediation: {
      ...hamEvidence(),
      auditComment: {
        body: 'HAM audit: addressed Auth path not threaded in src/auth.js and README note is stale in README.md. Doc-currency: not applicable for changed files src/auth.js.',
        docCurrency: {
          status: 'not_applicable',
          changedFiles: ['src/auth.js'],
        },
        findings: [
          { title: 'Auth path not threaded', blocking: true, file: 'src/auth.js', addressed: true },
          { title: 'README note is stale', blocking: false, file: 'README.md', addressed: true },
        ],
      },
    },
    hamTerminalRemediationGroundTruth: hamGroundTruth(),
  });
  assert.equal(result.eligible, true, JSON.stringify(result, null, 2));
  assert.equal(result.trace.verdict.operatorOverride, false);
  assert.equal(result.trace.finalHammer.active, true);
  assert.equal(result.trace.hamTerminalRemediation.marker, 'ham_terminal_remediation_validated');
  assert.ok(result.trace.hamTerminalRemediation.waived.includes('blocking-findings-present'));
  assert.ok(result.trace.hamTerminalRemediation.waived.includes('verdict-not-settled-success'));
});
