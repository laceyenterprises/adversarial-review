// CIWAITLANE-01: a clean PR merges within one watcher pass of its CI passing,
// even after the no-progress lane demoted it while it waited on CI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNoProgressLaneGate, handlePostedReviewRow, preparePostedReviewHandlers }
  from '../src/posted-review-row.mjs';
import { createPostedReviewFairnessState, runPostedReviewHandlersFairly } from '../src/watcher-poll-fairness.mjs';
import { evaluateNoProgressLane, readNoProgressLane } from '../src/watcher-no-progress-lane.mjs';

const headSha = 'c'.repeat(40);
const repoPath = 'example/project';
const prNumber = 7;
const identity = { repo: repoPath, prNumber };
const quiet = { log() {}, warn() {}, info() {}, error() {} };
const settledGate = { state: 'success', reason: 'review-settled' };
const ciWait = () => ({ head: headSha, row: 'R11-pending',
  action: 'wait-for-CI', actor: 'ci', reason: 'checks-pending',
  deadline: { at: '2099-01-01T00:00:00.000Z', anchoredAt: '2026-11-15T03:00:00.000Z' } });
const pendingRollup = [{ name: 'build', status: 'IN_PROGRESS', conclusion: null }];
const greenRollup = [{ name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }];
const row = { review_status: 'posted', pr_state: 'open', reviewer_head_sha: headSha,
  posted_at: '2026-11-15T03:00:00Z' };

function fixture(t) {
  const rootDir = mkdtempSync(join(tmpdir(), 'ciwaitlane-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const gate = createNoProgressLaneGate({ rootDir, hqRoot: rootDir, logger: quiet, readReviewRow: () => row,
    deliverAlertFn: async () => {} });
  return { rootDir, gate };
}

// The real handler's return value for the shared CI-wait closure result.
async function walkWithClosure(rootDir, coexistence) {
  return handlePostedReviewRow({ rootDir, repoPath, prNumber, existing: row, currentRevisionRef: headSha,
    labelNames: [], logger: quiet, projectGateStatusSafe: async () => ({ decision: settledGate }),
    fetchMergeAgentCandidateImpl: async () => ({ merged: false, prState: 'open', headSha }),
    buildMergeAgentDispatchJobImpl: () => ({}), latestFollowUpJobFinder: () => null,
    latestPostedReviewBodyFinder: () => null, reviewBodyHasScopeViolationFindingImpl: () => false,
    currentReviewRowReader: () => row, resolveMergeAgentCoexistenceForWatcherImpl: coexistence });
}

const ciWaitClosure = () => async () => ({ outcome: 'ama-pending', amaClosureResult: {
  dispatched: false, skipMergeAgent: true, recoveryWait: true, amaEnabled: true,
  reason: 'pending-required-checks', nextAction: ciWait(), retryAfterMs: 30_000 } });

async function demoteWhileWaitingOnCi(rootDir, gate) {
  const handler = { repoPath, prNumber, headSha };
  let outcome;
  // First walk opens the series; six identical walks reach backoff 1, 2, 4, 8.
  for (let walk = 0; walk < 7; walk++) {
    outcome = await gate.record(handler, { value: await walkWithClosure(rootDir, ciWaitClosure()) });
  }
  return outcome;
}

test('CIWAITLANE-01 the ama-pending CI wait reaches the lane ledger as its next action', async (t) => {
  const { rootDir, gate } = fixture(t);
  const value = await walkWithClosure(rootDir, ciWaitClosure());
  assert.deepEqual(value.amaClosureResult?.nextAction, ciWait());
  await gate.record({ repoPath, prNumber, headSha }, { value });
  const ledger = readNoProgressLane(rootDir, identity);
  assert.equal(ledger.nextAction?.action, 'wait-for-CI');
  assert.equal(ledger.nextAction?.actor, 'ci');
  assert.equal(ledger.nextAction?.row, 'R11-pending');
  assert.deepEqual(JSON.parse(ledger.decisionFingerprint).closure,
    { row: 'r11-pending', action: 'wait-for-ci', reason: 'checks-pending' });
  // A CI wait is not a live hammer route: it must not walk every tick.
  assert.equal(ledger.hammerRouteActive, false);
  assert.equal(ledger.progressClass, 'self-resolving');
});

test('CIWAITLANE-01 a demoted CI wait keeps plain backoff instead of hammer-route-active', async (t) => {
  const { rootDir, gate } = fixture(t);
  const outcome = await demoteWhileWaitingOnCi(rootDir, gate);
  assert.equal(outcome.lane, 'slow');
  assert.equal(outcome.backoffTicks, 8);
  const decision = evaluateNoProgressLane(readNoProgressLane(rootDir, identity), { headSha });
  assert.equal(decision.reason, 'slow-lane-backoff');
  assert.equal(decision.due, false);
});

test('CIWAITLANE-01 backoff 8: pending CI stays deferred; green CI is walked on the next pass', async (t) => {
  const { rootDir, gate } = fixture(t);
  await demoteWhileWaitingOnCi(rootDir, gate);
  let rollup = pendingRollup;
  let reads = 0;
  const walks = [];
  const handlers = [{ repoPath, prNumber, headSha, run: async ({ preparedCandidate } = {}) => {
    walks.push(preparedCandidate);
    // The handler's merge attempt: the coexistence stub stands in for the daemon clean merge.
    return walkWithClosure(rootDir, async () => ({ outcome: 'pr-terminal', terminalReason: 'merged',
      amaClosureResult: { reason: 'daemon-merged', daemonCleanMerge: { attempted: true, merged: true,
        remoteMergedConfirmed: true } } }));
  } }];
  const pass = async () => {
    const prepared = await preparePostedReviewHandlers(handlers, { rootDir, logger: quiet, laneGate: gate,
      readReviewRow: () => row, resolveSettled: () => ({ verdict: 'approved', remediationPending: false }),
      fetchSnapshot: async () => { reads++; return { headRefOid: headSha, state: 'OPEN', mergeable: 'MERGEABLE',
        statusCheckRollup: rollup }; } });
    return runPostedReviewHandlersFairly({ handlers: prepared, state: createPostedReviewFairnessState(),
      // No idle-tick starvation floor here: it would admit the lone handler regardless.
      budgetMs: 60_000, minimumHandlerStartBudgetMs: 1, laneGate: gate, laneStarvationFloor: 0, logger: quiet });
  };
  for (let tick = 1; tick <= 3; tick++) {
    const summary = await pass();
    assert.equal(summary.skippedByLane, 1, `pending CI tick ${tick} must stay deferred`);
    assert.equal(walks.length, 0);
    assert.equal(readNoProgressLane(rootDir, identity).skippedTicks, tick);
  }
  assert.equal(reads, 3, 'one bounded candidate read per pass, no walk');
  rollup = greenRollup;
  const summary = await pass();
  assert.equal(summary.skippedByLane, 0);
  assert.equal(walks.length, 1, 'CI success admits the demoted PR on the next pass');
  assert.equal(walks[0].value.headRefOid, headSha, 'the handler reuses the admission read');
  assert.equal(summary.mergeReadyHandled, 1);
});

test('CIWAITLANE-01 one cleared CI signal admits one walk, not every pass', async (t) => {
  const { rootDir, gate } = fixture(t);
  await demoteWhileWaitingOnCi(rootDir, gate);
  const signal = JSON.stringify(['SUCCESS', 'MERGEABLE']);
  const handler = { repoPath, prNumber, headSha };
  assert.equal(gate.evaluate({ ...handler, ciWaitSignal: signal }).reason, 'ci-wait-settled');
  // The walk still reports a CI wait (for example, the closure disagrees).
  await gate.record(handler, { value: await walkWithClosure(rootDir, ciWaitClosure()) });
  const again = gate.evaluate({ ...handler, ciWaitSignal: signal });
  assert.equal(again.run, false);
  assert.equal(again.reason, 'slow-lane-backoff');
  // A different cleared signal is new evidence.
  assert.equal(gate.evaluate({ ...handler, ciWaitSignal: JSON.stringify(['FAILURE', 'MERGEABLE']) }).run, true);
});

test('CIWAITLANE-01 a demoted PR with any other recorded action gets no CI read', async (t) => {
  const { rootDir, gate } = fixture(t);
  const handler = { repoPath, prNumber, headSha };
  const remediate = async () => ({ outcome: 'ama-pending', amaClosureResult: { reason: 'remediation-job-missing',
    recoveryWait: true, nextAction: { head: headSha, action: 'remediate', actor: 'remediator', reason: 'ci-red' } } });
  for (let walk = 0; walk < 7; walk++) {
    await gate.record(handler, { value: await walkWithClosure(rootDir, remediate) });
  }
  assert.equal(gate.evaluate(handler, { recordSkip: false }).run, false);
  let reads = 0;
  await preparePostedReviewHandlers([{ ...handler, run: async () => {} }], { rootDir, logger: quiet, laneGate: gate,
    readReviewRow: () => row, resolveSettled: () => ({ verdict: 'approved', remediationPending: false }),
    fetchSnapshot: async () => { reads++; return { headRefOid: headSha, statusCheckRollup: greenRollup }; } });
  assert.equal(reads, 0);
});
