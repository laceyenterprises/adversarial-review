import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ADVERSARIAL_MERGE_BLOCKED_LABEL,
  ADVERSARIAL_MERGE_REQUESTED_LABEL,
  __testables__,
  ensureAmaLabelsOnRepo,
  ensureAmaLabelsOnRepos,
  listAmaLabelSpecs,
} from '../src/ama/labels.mjs';
import { isEligibleForAmaClosure } from '../src/ama/eligibility.mjs';
import { DEFAULT_ADVERSARIAL_GATE_CONTEXT } from '../src/adversarial-gate-context.mjs';

const GATE_CONTEXT = DEFAULT_ADVERSARIAL_GATE_CONTEXT;
const ENV = { ADV_GATE_STATUS_CONTEXT: GATE_CONTEXT };

// ---------------------------------------------------------------------------
// Helpers — share the eligibility fixture across the predicate tests so each
// test mutates one input only (matches the AMA-02 / AMA-03 test style).
// ---------------------------------------------------------------------------

function eligibleFixture(overrides = {}) {
  const headSha = 'abc12345abc12345abc12345abc12345abc12345';
  const reviewState = {
    verdict: 'approved',
    headSha,
    riskClass: 'low',
    remediationPending: false,
    blockingFindingState: 'known',
    blockingFindingCount: 0,
    nonBlockingFindingState: 'known',
    nonBlockingFindingCount: 0,
    operatorApprovedEvidence: null,
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

function ghError(message) {
  const err = new Error(message);
  err.stderr = message;
  return err;
}

// ---------------------------------------------------------------------------
// Test 1 — label initializer creates both labels on first tick; second is
//          idempotent.
// ---------------------------------------------------------------------------

test('ensureAmaLabelsOnRepo creates both labels on first tick; second tick is no-op', async () => {
  // Mock the gh client. First call: repo has no AMA labels yet. Second call
  // after creation: both labels present.
  const created = [];
  const fetchCalls = [];
  let state = new Map();
  const fetchRepoLabelsImpl = async (repo) => {
    fetchCalls.push(repo);
    return state;
  };
  const createLabelImpl = async (repo, spec) => {
    created.push({ repo, name: spec.name });
    state.set(spec.name.toLowerCase(), { name: spec.name, color: spec.color, description: spec.description });
  };
  const r1 = await ensureAmaLabelsOnRepo('acme/myrepo', { fetchRepoLabelsImpl, createLabelImpl });
  assert.deepEqual(r1.created.sort(), [ADVERSARIAL_MERGE_BLOCKED_LABEL, ADVERSARIAL_MERGE_REQUESTED_LABEL].sort());
  assert.deepEqual(r1.preserved, []);
  assert.equal(created.length, 2);
  // Second tick: state now has both labels — initializer is a no-op.
  const r2 = await ensureAmaLabelsOnRepo('acme/myrepo', { fetchRepoLabelsImpl, createLabelImpl });
  assert.deepEqual(r2.created, []);
  assert.deepEqual(r2.preserved.sort(), [ADVERSARIAL_MERGE_BLOCKED_LABEL, ADVERSARIAL_MERGE_REQUESTED_LABEL].sort());
  assert.equal(created.length, 2, 'no further createLabel calls on second tick');
});

test('ensureAmaLabelsOnRepo preserves operator customizations on existing labels', async () => {
  const state = new Map();
  state.set(ADVERSARIAL_MERGE_BLOCKED_LABEL.toLowerCase(), {
    name: ADVERSARIAL_MERGE_BLOCKED_LABEL,
    color: 'cf222e',                    // operator-customized
    description: 'operator wording',
  });
  const created = [];
  await ensureAmaLabelsOnRepo('acme/myrepo', {
    fetchRepoLabelsImpl: async () => state,
    createLabelImpl: async (repo, spec) => { created.push(spec.name); },
  });
  // Only the missing label is created; the customized one is left as-is.
  assert.deepEqual(created, [ADVERSARIAL_MERGE_REQUESTED_LABEL]);
});

test('fetchRepoLabels retries transient gh api failures', async () => {
  let calls = 0;
  const labels = await __testables__.fetchRepoLabels('acme/myrepo', {
    retryDelayMs: 0,
    sleepImpl: async () => {},
    execFileImpl: async () => {
      calls += 1;
      if (calls === 1) {
        throw ghError('TLS handshake timeout');
      }
      return {
        stdout:
          '{"name":"adversarial-merge-requested","color":"fbca04","description":"request"}\n',
      };
    },
  });
  assert.equal(calls, 2);
  assert.equal(labels.get(ADVERSARIAL_MERGE_REQUESTED_LABEL).color, 'fbca04');
});

test('createLabel retries transient gh api failures', async () => {
  let calls = 0;
  await __testables__.createLabel('acme/myrepo', {
    name: ADVERSARIAL_MERGE_BLOCKED_LABEL,
    color: 'b60205',
    description: 'Block AMA closure.',
  }, {
    retryDelayMs: 0,
    sleepImpl: async () => {},
    execFileImpl: async () => {
      calls += 1;
      if (calls === 1) {
        throw ghError('HTTP 503 Service Unavailable');
      }
      return { stdout: '{}' };
    },
  });
  assert.equal(calls, 2);
});

test('ensureAmaLabelsOnRepo reconciles duplicate-create races as success', async () => {
  const state = new Map();
  let fetchCalls = 0;
  let duplicateOnce = true;
  const result = await ensureAmaLabelsOnRepo('acme/myrepo', {
    fetchRepoLabelsImpl: async () => {
      fetchCalls += 1;
      return new Map(state);
    },
    createLabelImpl: async (repo, spec) => {
      if (spec.name === ADVERSARIAL_MERGE_BLOCKED_LABEL && duplicateOnce) {
        duplicateOnce = false;
        state.set(spec.name.toLowerCase(), {
          name: spec.name,
          color: spec.color,
          description: spec.description,
        });
        throw ghError('HTTP 422 Validation Failed: already_exists name');
      }
      state.set(spec.name.toLowerCase(), {
        name: spec.name,
        color: spec.color,
        description: spec.description,
      });
    },
  });
  assert.equal(fetchCalls, 2);
  assert.deepEqual(result.created, [ADVERSARIAL_MERGE_REQUESTED_LABEL]);
  assert.deepEqual(result.preserved, [ADVERSARIAL_MERGE_BLOCKED_LABEL]);
  assert.deepEqual(
    result.ensured.sort(),
    [ADVERSARIAL_MERGE_BLOCKED_LABEL, ADVERSARIAL_MERGE_REQUESTED_LABEL].sort(),
  );
});

test('ensureAmaLabelsOnRepos aggregates errors per-repo without aborting', async () => {
  const result = await ensureAmaLabelsOnRepos(['acme/ok', 'acme/broken'], {
    fetchRepoLabelsImpl: async (repo) => {
      if (repo === 'acme/broken') {
        const err = new Error('gh exec failed');
        err.stderr = 'simulated';
        throw err;
      }
      return new Map();
    },
    createLabelImpl: async () => {},
  });
  assert.equal(result.ok.length, 1);
  assert.equal(result.ok[0].repo, 'acme/ok');
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].repo, 'acme/broken');
  assert.match(result.errors[0].error, /simulated/);
});

test('listAmaLabelSpecs pins the public label spec shape', () => {
  const specs = listAmaLabelSpecs();
  assert.equal(specs.length, 2);
  const blocked = specs.find((s) => s.name === ADVERSARIAL_MERGE_BLOCKED_LABEL);
  const requested = specs.find((s) => s.name === ADVERSARIAL_MERGE_REQUESTED_LABEL);
  assert.ok(blocked && requested);
  assert.equal(typeof blocked.color, 'string');
  assert.match(blocked.color, /^[0-9a-fA-F]{6}$/);
  assert.match(requested.color, /^[0-9a-fA-F]{6}$/);
  assert.ok(blocked.description.length > 20);
  assert.ok(requested.description.length > 20);
});

// ---------------------------------------------------------------------------
// Test 2 — `adversarial-merge-blocked` on current head → eligibility false.
// ---------------------------------------------------------------------------

test('adversarial-merge-blocked label on current head → eligibility blocked (head-scoped evidence)', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    prMetadata: { labels: ['adversarial-merge-blocked'] },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, {
    env: ENV,
    adversarialMergeBlocked: {
      applied: true,
      observedRevisionRef: prMetadata.headSha,
      actor: 'paul-the-operator',
      eventId: 'LE_block',
      observedAt: '2026-06-11T22:00:00Z',
    },
  });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes('label-adversarial-merge-blocked'));
});

// ---------------------------------------------------------------------------
// Test 3 — stale `adversarial-merge-blocked` evidence → ignored.
// ---------------------------------------------------------------------------

test('adversarial-merge-blocked label with stale head evidence → ignored', () => {
  // The label is still attached to the PR but the labeled timeline event
  // observed an OLDER head. The watcher's job is to consume the stale
  // evidence and the predicate's job is to ignore it.
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    prMetadata: { labels: ['adversarial-merge-blocked'] },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, {
    env: ENV,
    adversarialMergeBlocked: {
      applied: true,
      observedRevisionRef: 'OLD-head-1111111',           // older than current head
      actor: 'paul-the-operator',
      eventId: 'LE_stale',
      observedAt: '2026-06-11T18:00:00Z',
    },
  });
  assert.equal(result.eligible, true, JSON.stringify(result, null, 2));
});

test('adversarial-merge-blocked label without evidence supplied → fail-closed (label-presence blocks)', () => {
  // Backward-compat default for watchers that haven't yet wired the
  // timeline-event fetch. The label's presence is enough to block —
  // safer than failing open.
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    prMetadata: { labels: ['adversarial-merge-blocked'] },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, { env: ENV });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes('label-adversarial-merge-blocked'));
});

test('adversarial-merge-blocked label with null evidence → fail-closed (label-presence blocks)', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    prMetadata: { labels: ['adversarial-merge-blocked'] },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, {
    env: ENV,
    adversarialMergeBlocked: null,
  });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes('label-adversarial-merge-blocked'));
});

// ---------------------------------------------------------------------------
// Test 4 — `adversarial-merge-requested` (non-author) bypasses ONLY the
//          risk-class gate, leaving other structural hard gates enforced.
// ---------------------------------------------------------------------------

test('adversarial-merge-requested (non-author) bypasses risk-class gate but not other gates', () => {
  // The eligibility predicate requires both the label name be present in
  // `prMetadata.labels` AND the timeline evidence be current-head + non-
  // author. The watcher passes both shapes side by side; tests mirror.
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    reviewState: {
      riskClass: 'high',
      operatorApprovedEvidence: {
        applied: true,
        observedRevisionRef: 'abc12345abc12345abc12345abc12345abc12345',
        actor: 'paul-the-operator',
        eventId: 'LE_op_approve',
        observedAt: '2026-06-11T22:00:00Z',
      },
    },
    prMetadata: {
      labels: ['operator-approved', 'adversarial-merge-requested'],
    },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, {
    env: ENV,
    adversarialMergeRequested: {
      applied: true,
      observedRevisionRef: prMetadata.headSha,
      actor: 'paul-the-operator',
      eventId: 'LE_merge_requested',
      observedAt: '2026-06-11T22:00:00Z',
    },
  });
  // Risk-class permitted via the two-key turn (operator-approved +
  // adversarial-merge-requested both current-head). Other structural gates
  // pass via the eligible fixture.
  assert.equal(result.eligible, true, JSON.stringify(result, null, 2));
});

test('adversarial-merge-requested cannot bypass branch-protection or CI', () => {
  // Even with both operator labels current-head, AMA refuses when CI is
  // red or branch protection isn't requiring the configured gate.
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    reviewState: {
      riskClass: 'high',
      operatorApprovedEvidence: {
        applied: true,
        observedRevisionRef: 'abc12345abc12345abc12345abc12345abc12345',
        actor: 'paul-the-operator',
        eventId: 'LE_op_approve',
        observedAt: '2026-06-11T22:00:00Z',
      },
    },
    prMetadata: {
      labels: ['operator-approved', 'adversarial-merge-requested'],
      // CI red.
      statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', conclusion: 'FAILURE' }],
    },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, {
    env: ENV,
    adversarialMergeRequested: {
      applied: true,
      observedRevisionRef: prMetadata.headSha,
      actor: 'paul-the-operator',
      eventId: 'LE_x',
      observedAt: '2026-06-11T22:00:00Z',
    },
  });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes('ci-not-green'));
});

// ---------------------------------------------------------------------------
// Test 5 — author self-application of `adversarial-merge-requested` → rejected.
// ---------------------------------------------------------------------------

test('adversarial-merge-requested from PR author → rejected; eligibility unchanged', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    reviewState: {
      riskClass: 'high',
      operatorApprovedEvidence: {
        applied: true,
        observedRevisionRef: 'abc12345abc12345abc12345abc12345abc12345',
        actor: 'paul-the-operator',
        eventId: 'LE_op_approve',
        observedAt: '2026-06-11T22:00:00Z',
      },
    },
    prMetadata: { labels: ['operator-approved', 'adversarial-merge-requested'] },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, {
    env: ENV,
    adversarialMergeRequested: {
      applied: true,
      observedRevisionRef: prMetadata.headSha,
      actor: prMetadata.author,                  // author == labeler ⇒ self-label
      eventId: 'LE_self',
      observedAt: '2026-06-11T22:00:00Z',
    },
  });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes('risk-class-not-permitted'));
});

// ---------------------------------------------------------------------------
// Test 6 — stale `adversarial-merge-requested` evidence → ignored.
// ---------------------------------------------------------------------------

test('adversarial-merge-requested with stale head evidence → ignored', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    reviewState: {
      riskClass: 'high',
      operatorApprovedEvidence: {
        applied: true,
        observedRevisionRef: 'abc12345abc12345abc12345abc12345abc12345',
        actor: 'paul-the-operator',
        eventId: 'LE_op_approve',
        observedAt: '2026-06-11T22:00:00Z',
      },
    },
    prMetadata: { labels: ['operator-approved', 'adversarial-merge-requested'] },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, {
    env: ENV,
    adversarialMergeRequested: {
      applied: true,
      observedRevisionRef: 'OLD-head-1111111',
      actor: 'paul-the-operator',
      eventId: 'LE_stale',
      observedAt: '2026-06-11T18:00:00Z',
    },
  });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes('risk-class-not-permitted'));
});

// ---------------------------------------------------------------------------
// Test 7 — interaction with `operator-approved`: both can coexist.
// ---------------------------------------------------------------------------

test('operator-approved + adversarial-merge-requested can both be active simultaneously', () => {
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    reviewState: {
      verdict: 'request-changes',                // verdict gate would fail
      riskClass: 'high',                          // risk-class gate would fail
      operatorApprovedEvidence: {
        applied: true,
        observedRevisionRef: 'abc12345abc12345abc12345abc12345abc12345',
        actor: 'paul-the-operator',
        eventId: 'LE_op_approve',
        observedAt: '2026-06-11T22:00:00Z',
      },
    },
    prMetadata: {
      labels: ['operator-approved', 'adversarial-merge-requested'],
    },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, {
    env: ENV,
    adversarialMergeRequested: {
      applied: true,
      observedRevisionRef: prMetadata.headSha,
      actor: 'paul-the-operator',
      eventId: 'LE_merge_requested',
      observedAt: '2026-06-11T22:00:00Z',
    },
  });
  // Both overrides scope to the current head; verdict + risk-class gates
  // both bypassed; structural gates pass via the eligible fixture.
  assert.equal(result.eligible, true, JSON.stringify(result, null, 2));
});

// ---------------------------------------------------------------------------
// Test 8 — `adversarial-merge-blocked` wins over both override labels.
// ---------------------------------------------------------------------------

test('adversarial-merge-blocked overrides operator-approved AND adversarial-merge-requested', () => {
  // All three labels present + current-head evidence for each. Block
  // still wins; the predicate refuses closure.
  const { reviewState, prMetadata, cfg } = eligibleFixture({
    reviewState: {
      verdict: 'request-changes',
      riskClass: 'high',
      operatorApprovedEvidence: {
        applied: true,
        observedRevisionRef: 'abc12345abc12345abc12345abc12345abc12345',
        actor: 'paul-the-operator',
        eventId: 'LE_op',
        observedAt: '2026-06-11T22:00:00Z',
      },
    },
    prMetadata: { labels: ['operator-approved', 'adversarial-merge-requested', 'adversarial-merge-blocked'] },
  });
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, {
    env: ENV,
    adversarialMergeRequested: {
      applied: true,
      observedRevisionRef: prMetadata.headSha,
      actor: 'paul-the-operator',
      eventId: 'LE_req',
      observedAt: '2026-06-11T22:00:00Z',
    },
    adversarialMergeBlocked: {
      applied: true,
      observedRevisionRef: prMetadata.headSha,
      actor: 'paul-the-operator',
      eventId: 'LE_block',
      observedAt: '2026-06-11T22:01:00Z',
    },
  });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes('label-adversarial-merge-blocked'));
});
