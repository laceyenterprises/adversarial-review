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

test('final hammer: exhausted cycle does NOT waive verdict/blocking without an operator override (fail-open fix)', () => {
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
  // blocking finding (#1830 fail-open). The merge gate stays strict.
  assert.equal(result.eligible, false, JSON.stringify(result, null, 2));
  assert.equal(result.trace.finalHammer.active, true);
  assert.ok(result.reasons.includes('verdict-not-settled-success'));
  assert.ok(result.reasons.includes('blocking-findings-present'));
  assert.ok(!result.trace.finalHammer.waived.includes('verdict-not-settled-success'));
});

test('final hammer: adversarial-merge-requested without operator-approved does not waive verdict/blocking', () => {
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

test('final hammer + current-head operator override waives verdict/blocking and is eligible', () => {
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

test('final hammer: waives the structural branch-protection-missing-gate', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    // verdict satisfied by a current-head operator override so this isolates the
    // structural branch-protection waiver (verdict gate now needs the override).
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
  assert.equal(result.eligible, true, JSON.stringify(result, null, 2));
  assert.ok(result.trace.finalHammer.waived.includes('branch-protection-missing-gate'));
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

test('final hammer: by default still requires the two-key override for high/critical risk', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    reviewState: { verdict: 'request-changes', riskClass: 'critical', reviewCycleExhausted: true },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, { env: ENV });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes('risk-class-not-permitted'));
});

test('final hammer: high/critical are single-key eligible when explicitly configured', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    // verdict satisfied via operator override so this isolates the risk-class path.
    prMetadata: { labels: ['operator-approved'] },
    reviewState: {
      verdict: 'request-changes',
      riskClass: 'critical',
      reviewCycleExhausted: true,
      operatorApprovedEvidence: {
        applied: true,
        observedRevisionRef: 'abc12345',
        actor: 'paul-the-operator',
        eventId: 'LE_abc',
        observedAt: '2026-06-10T20:00:00Z',
      },
    },
    cfg: eligibilityCfg(false),
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, { env: ENV });
  assert.equal(result.eligible, true, JSON.stringify(result, null, 2));
  assert.equal(result.trace.riskClass.allowed, true);
  assert.equal(result.trace.riskClass.requiresTwoKey, false);
  assert.equal(result.trace.riskClass.permitted, true);
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
