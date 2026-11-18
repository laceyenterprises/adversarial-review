// ORPHANDAEMONMERGE-01 (SEV2): ownerless recovery must run the daemon clean
// merge when the re-derived decision is a clean exact-head daemon merge, and an
// empty pass must spend its attempt instead of being refunded as a wait forever.
// Synthetic fixtures only; the real watchdog drives the real closure orchestration.
import './helpers/rate-limit-state-isolation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';

import { deriveNextActionSnapshot, nextAction } from '../src/pr-next-action.mjs';
import { recoverOrphan, isOrphanRecoveryWait } from '../src/ama/orphan-watchdog.mjs';
import { maybeDispatchAmaClosureFor } from '../src/ama-closure-orchestration.mjs';
import { resolveGateStatusContext } from '../src/adversarial-gate-context.mjs';

const HEAD = 'a'.repeat(40);
const AT = '2026-01-01T00:00:00.000Z';
const DUE = '2026-01-01T00:05:00.000Z';
const REPO = 'fixture/project';
const PR = 4343;
const QUIET = { log() {}, info() {}, warn() {}, error() {} };
const CLEAN_BODY = ['## Summary', 'Docs only.', '', '## Blocking issues', '- None.', '',
  '## Non-blocking issues', '- None.', '', '## Verdict', 'Comment only'].join('\n');

// The stored (stale) decision that put the PR into ownerless recovery: a hammer
// receipt whose deadline lapsed.
function storedHammerDecision() {
  const snapshot = deriveNextActionSnapshot({ subjectKey: `${REPO}#${PR}`, head: HEAD, observedAt: DUE,
    anchors: { firstActionableAt: AT }, observations: {
      pr: { headSha: HEAD, state: 'OPEN', prState: 'OPEN', mergeable: 'MERGEABLE' },
      reviews: { headSha: HEAD, verdict: 'approved', blockingFindingState: 'known', blockingFindingCount: 0,
        nonBlockingFindingState: 'known', nonBlockingFindingCount: 0 },
      checks: { conclusion: 'SUCCESS' }, remediation: { roundsLeft: false }, leases: { closer: null },
      launches: { closer: null }, policy: { autonomousMergeExecutionEnabled: true }, controls: {},
      progress: { mergeReceipt: { merged: true, headSha: HEAD, path: 'hammer' } } } });
  const decision = nextAction(snapshot);
  assert.equal(decision.action, 'hammer');
  return decision;
}

function closureArgs(calls, { daemon, body = CLEAN_BODY } = {}) {
  return {
    reviewStateRow: { repo: REPO, pr_number: PR, pr_state: 'open', review_status: 'posted',
      last_verdict: 'Comment only', risk_class: 'low', remediation_pending: 0, reviewer: 'codex',
      reviewer_head_sha: HEAD, review_body: body, posted_at: AT },
    dispatchJob: {},
    candidate: { headSha: HEAD, riskClass: 'low', prAuthor: 'claude-code-worker', prState: 'open',
      mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', isDraft: false,
      statusCheckRollup: [{ __typename: 'CheckRun', name: 'repo-guards', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      branchProtection: { requiredContexts: [resolveGateStatusContext(process.env)] } },
    labelNames: [], operatorApprovalEvent: null, adversarialMergeRequestedEvent: null,
    repoPath: REPO, prNumber: PR, currentRevisionRef: HEAD, logger: QUIET,
    loadConfigImpl: () => ({ getMergeAuthorityConfig: () => ({ enabled: true }) }),
    resolveAmaHammerDispatchModeImpl: () => 'inline',
    fetchLatestHeadReviewBodiesImpl: async () => [body],
    resolveHeadCloserCommitSuppressionImpl: async () => ({ suppressed: false, reason: 'not-closer-commit' }),
    fetchMergedProtectiveDependentsImpl: async () => [],
    requestEligibleHammerWakeImpl: () => ({ requested: false }),
    probeClosureOwnershipImpl: async () => ({ owned: false, uncertain: false, launchIds: [] }),
    maybeDispatchAmaCloserImpl: async () => { calls.hammer.push('dispatch'); return { dispatched: false, reason: 'fixture' }; },
    runDaemonCleanMergeAttemptImpl: async args => {
      calls.daemon.push(args.sharedNextAction?.decision);
      return daemon();
    },
  };
}

// The live shape: an overdue hammer decision that is not a closure-recovery row,
// so exhaustion (not a first-pass dispatch refusal) is what pages.
function overdueHammerDecision() {
  return { head: HEAD, row: 'R08-retry', action: 'hammer', actor: 'hammer', reason: 'retry-no-merge',
    decisionKey: 'synthetic-hammer-decision', queue: { intent: 'dispatch' },
    deadline: { at: '2026-01-01T00:00:00Z', anchoredAt: AT } };
}

function fixture(t, options = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'orphandaemonmerge-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const calls = { daemon: [], hammer: [] }, pages = [], outcomes = [];
  const stored = options.stored || overdueHammerDecision();
  const NOW = '2026-01-02T00:00:00.000Z';
  const pass = (executor) => recoverOrphan({ rootDir, repo: REPO, prNumber: PR, headSha: HEAD, logger: QUIET,
    now: options.stored ? DUE : NOW, candidate: { headSha: HEAD, prState: 'OPEN', mergeable: 'MERGEABLE' },
    result: { amaEnabled: true, reason: stored.reason, nextAction: stored },
    hasOwnerImpl: async () => ({ owned: false }),
    dispatchHammer: async evidence => {
      const out = await executor(evidence);
      outcomes.push(out);
      return out;
    },
    pageImpl: async (...args) => { pages.push(args); return { queued: true }; } });
  const viaClosure = (daemon, extra = {}) => evidence => maybeDispatchAmaClosureFor({
    rootDir, ...closureArgs(calls, { daemon, ...options }), orphanRecovery: evidence, ...extra });
  const attempts = () => {
    const key = createHash('sha256').update(`${REPO}#${PR}`).digest('hex');
    const db = new Database(join(rootDir, 'data', 'follow-up-jobs', 'orphan-watchdog', `${key}.db`), { readonly: true });
    try { return db.prepare('SELECT attempts, paged FROM heads WHERE head=?').get(HEAD); } finally { db.close(); }
  };
  return { rootDir, calls, pages, outcomes, pass, viaClosure, attempts };
}

const MERGED = () => ({ disposition: 'merged', reason: 'merged', remoteMergedConfirmed: true, mergedAt: DUE });
const FAIL_CLOSED = () => ({ disposition: 'failed-closed', reason: 'worker-identity-unresolved',
  reasons: ['worker-identity-unresolved'] });

test('ownerless head whose re-derived decision is a clean exact-head daemon merge runs the daemon merge and merges', async t => {
  const f = fixture(t);
  await f.pass(f.viaClosure(MERGED));
  assert.equal(f.calls.daemon.length, 1, 'the daemon clean merge was attempted under ownerless recovery');
  assert.equal(f.calls.daemon[0].action, 'daemon-merge');
  assert.equal(f.calls.daemon[0].reason, 'clean-exact-head');
  assert.deepEqual(f.calls.hammer, []);
  assert.equal(f.outcomes[0].reason, 'daemon-merged');
  assert.equal(f.pages.length, 0);
});

test('a recovery daemon merge on a closure-recovery decision settles terminal and pages nothing', async t => {
  const f = fixture(t, { stored: storedHammerDecision() });
  const out = await f.pass(f.viaClosure(MERGED));
  assert.equal(out.outcome, 'pr-terminal');
  assert.equal(f.calls.daemon.length, 1);
  assert.equal(f.pages.length, 0, 'a landed merge is not a refused dispatch');
});

test('a failing daemon gate does not merge, spends the attempt, and exhaustion pages once', async t => {
  const f = fixture(t);
  for (let i = 0; i < 4; i++) await f.pass(f.viaClosure(FAIL_CLOSED));
  // Two attempts reached the daemon gate and failed closed; later passes never re-run it.
  assert.equal(f.calls.daemon.length, 2, 'only the two budgeted attempts execute');
  assert.equal(f.attempts().attempts, 2, 'fail-closed attempts are spent, not refunded');
  for (const outcome of f.outcomes) assert.equal(isOrphanRecoveryWait(outcome), false, JSON.stringify(outcome.reason));
  assert.equal(f.pages.length, 1, 'recovery exhaustion pages exactly once');
});

test('a decision that is hammer keeps the hammer path unchanged and never runs the daemon merge', async t => {
  const f = fixture(t, { body: ['## Summary', 'Docs only.', '', '## Blocking issues', '- None.', '',
    '## Non-blocking issues', '- **Ambiguous timestamp**', '  - **Problem:** unclear zone.', '',
    '## Verdict', 'Comment only'].join('\n') });
  await f.pass(f.viaClosure(MERGED));
  assert.deepEqual(f.calls.daemon, [], 'strict mode keeps findings on the hammer path');
});

test('real waits (operation timeout, 429, quota read) are still refunded', async t => {
  for (const wait of [
    { dispatched: false, reason: 'ama-coexistence-operation-timeout' },
    { dispatched: false, status: 429, reason: 'rate-limited' },
    { dispatched: false, reason: 'harness-hold:fleet-quota-status-unavailable' },
  ]) {
    const f = fixture(t);
    for (let i = 0; i < 3; i++) await f.pass(async () => wait);
    assert.equal(f.attempts().attempts, 0, JSON.stringify(wait));
    assert.equal(f.pages.length, 0, JSON.stringify(wait));
  }
});

test('a settled daemon-merge pass with no launch is spent even when flagged recoveryWait; real waits stay refunded', async t => {
  const settled = { dispatched: false, recoveryWait: true, reason: 'closure-decision-mismatch',
    decisionMismatch: { resolvedAction: 'daemon-merge', resolvedReason: 'clean-exact-head' } };
  const f = fixture(t);
  await f.pass(async () => settled);
  assert.equal(f.attempts().attempts, 1);
  const g = fixture(t);
  await g.pass(async () => ({ ...settled, reason: 'ama-coexistence-operation-timeout' }));
  assert.equal(g.attempts().attempts, 0, 'a recognized wait reason still refunds');
});

test('a duplicate hammer wake that never launched spends the attempt', async t => {
  const f = fixture(t);
  for (let i = 0; i < 4; i++) {
    await f.pass(async () => ({ dispatched: false, reason: 'wake-already-recorded',
      hammerWake: { outcome: 'duplicate', reason: 'wake-already-recorded' } }));
  }
  assert.equal(f.attempts().attempts, 2);
  assert.equal(f.pages.length, 1);
});
