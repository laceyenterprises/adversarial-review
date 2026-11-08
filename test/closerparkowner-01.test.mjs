// CLOSERPARKOWNER-01: a PR parked after a comment-only final round must reach the
// closer. Synthetic fixtures only. The park was the overdue-ownership check that
// runs before every walk: with no recorded owner action it selected an R04
// `closure-recovery` default, paged the lapsed transition, and returned
// `recovery-exhausted`, which ended the walk before the posted-review handler
// (the only caller of the closer) could run. The lane record was then never
// rewritten, so the lapsed deadline could not clear.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { recoverOverdueOwnership } from '../src/ownerproof-review-recovery.mjs';
import { probeOrphanOwnership, recoverOrphan } from '../src/ama/orphan-watchdog.mjs';
import { noProgressLaneFilePath } from '../src/watcher-no-progress-lane.mjs';
import { maybeDispatchAmaClosureFor } from '../src/ama-closure-orchestration.mjs';
import { acquireAmaCloserLease, readAmaCloserLease, updateAmaCloserLease } from '../src/ama/closer-lease.mjs';
import { dispatchReadTransport } from '../src/dispatch-read-client.mjs';
import { observeClosureWait } from '../src/ama/closure-wait.mjs';

const REPO = 'fixture/project';
const PR = 4242;
const REVIEWED = '1'.repeat(40);
const PUSHED = '2'.repeat(40);
const IDENTITY = { repo: REPO, prNumber: PR };
const FIRST_SEEN = '2026-11-01T10:00:00.000Z';
const NOW = '2026-11-03T10:00:00.000Z';
const QUIET = { log() {}, info() {}, warn() {}, error() {} };
const BODY = ['## Summary', 'Docs only.', '', '## Blocking issues', '- None.', '',
  '## Non-blocking issues', '- **Ambiguous timestamp**', '  - **Problem:** unclear zone.', '',
  '## Verdict', 'Comment only'].join('\n');

function scratch(t) {
  const rootDir = mkdtempSync(join(tmpdir(), 'closerparkowner-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  return rootDir;
}

// The completed final-round job a parked PR carries: pushed head, wait-for-CI
// handoff whose observer deadline has lapsed, no re-review requested.
function seedFinalRoundPush(rootDir) {
  const dir = join(rootDir, 'data', 'follow-up-jobs', 'completed');
  mkdirSync(dir, { recursive: true });
  const jobId = `fixture__project-pr-${PR}-2026-11-01T09-00-00-000Z`;
  writeFileSync(join(dir, `${jobId}.json`), JSON.stringify({
    schemaVersion: 1, kind: 'adversarial-review-follow-up', jobId, status: 'completed',
    repo: REPO, prNumber: PR, domainId: 'code-pr', revisionRef: REVIEWED, riskClass: 'low',
    finalRound: 'comment-only', nonBlockingOnly: true, reviewBody: BODY,
    remediationPlan: { currentRound: 1, maxRounds: 2, stop: null },
    remediationWorker: { state: 'completed' },
    completedAt: FIRST_SEEN,
    completion: { workerPushedHeadSha: PUSHED, finalRemediationPush: true, pendingCiOnly: true },
    reReview: { requested: false, status: 'suppressed', suppressed: 'comment-only-final-round',
      nextAction: { action: 'wait-for-CI', actor: 'ci', reason: 'checks-pending', head: PUSHED,
        deadline: { at: '2026-11-01T10:30:00.000Z', class: 'observer', budgetMs: 1800000 } } },
  }));
}

// Production shape: the last watcher walk recorded no selected action.
function seedLaneWithoutAction(rootDir) {
  const path = noProgressLaneFilePath(rootDir, IDENTITY);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, ...IDENTITY, headSha: PUSHED,
    noProgressTicks: 1, skippedTicks: 0, lane: 'active', progressClass: 'self-resolving',
    firstNoProgressAt: FIRST_SEEN, lastRunAt: FIRST_SEEN, updatedAt: FIRST_SEEN }));
}

function discovery(rootDir, { owned = false, dispatches = [], pages = [], dispatchResult } = {}) {
  return { rootDir, ...IDENTITY, enabled: true, now: NOW, env: {},
    subject: { headSha: PUSHED, labels: [] }, reviewStateRow: { review_status: 'posted' },
    domainId: 'code-pr', logger: QUIET,
    recoverImpl: input => recoverOrphan({ ...input, hasOwnerImpl: async () => ({ owned }),
      pageImpl: async (message, options) => { pages.push({ message, event: options?.event }); return { queued: true }; },
      logger: QUIET }),
    fetchCandidateImpl: async () => ({ headSha: PUSHED, prState: 'open', labels: [] }),
    dispatchImpl: async () => { dispatches.push(PUSHED); return dispatchResult ?? { dispatched: true }; } };
}

function closureArgs(rootDir, overrides = {}) {
  return {
    rootDir,
    reviewStateRow: { repo: REPO, pr_number: PR, pr_state: 'open', review_status: 'posted',
      last_verdict: 'Comment only', risk_class: 'low', remediation_pending: 0, reviewer: 'gemini',
      reviewer_head_sha: REVIEWED, posted_at: FIRST_SEEN },
    dispatchJob: {},
    candidate: { headSha: PUSHED, riskClass: 'low', prAuthor: 'claude-code-worker', prState: 'open',
      mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', isDraft: false,
      statusCheckRollup: [{ __typename: 'CheckRun', name: 'repo-guards', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      branchProtection: { requiredContexts: [] } },
    labelNames: [], operatorApprovalEvent: null, adversarialMergeRequestedEvent: null,
    repoPath: REPO, prNumber: PR, currentRevisionRef: PUSHED, logger: QUIET,
    loadConfigImpl: () => ({ getMergeAuthorityConfig: () => ({ enabled: true }) }),
    resolveAmaHammerDispatchModeImpl: () => 'inline',
    fetchLatestHeadReviewBodiesImpl: async () => [BODY],
    resolveHeadCloserCommitSuppressionImpl: async () => ({ suppressed: false, reason: 'not-closer-commit' }),
    fetchMergedProtectiveDependentsImpl: async () => [],
    runDaemonCleanMergeAttemptImpl: async () => ({ disposition: 'not-taken', reason: 'non-blocking-findings-present' }),
    requestEligibleHammerWakeImpl: () => ({ requested: false }),
    proveCommentOnlyFinalRoundHeadImpl: async ({ reviewedHead, currentHead, completedRevisionRefs, completedPushedHeads }) =>
      completedRevisionRefs.includes(reviewedHead) && completedPushedHeads.some(
        entry => entry.reviewedHead === reviewedHead && entry.workerPushedHeadSha === currentHead),
    ...overrides,
  };
}

test('the park gets an owner: the lapsed evidence-free deadline pages once and the closer then dispatches the hammer', async t => {
  const rootDir = scratch(t);
  seedFinalRoundPush(rootDir);
  seedLaneWithoutAction(rootDir);
  const pages = [];
  const dispatches = [];
  // Pass 1 and pass 2 (the same lapsed deadline): neither may end the walk.
  for (const pass of [1, 2]) {
    const recovered = await recoverOverdueOwnership(discovery(rootDir, { pages, dispatches }));
    assert.equal(recovered, null, `pass ${pass} must let the posted-review handler run`);
  }
  assert.equal(pages.length, 1, 'the lapsed transition is surfaced exactly once');
  assert.equal(pages[0].event, 'ama.orphan_recovery.missing-transition');
  assert.equal(dispatches.length, 0, 'discovery recovery has no executor for a closure-recovery default');

  // The walk reaches the closer, which owns the green final-round push.
  let payload = null;
  const closed = await maybeDispatchAmaClosureFor(closureArgs(rootDir, {
    maybeDispatchAmaCloserImpl: async args => { payload = args; return { dispatched: true, launchRequestId: 'lrq_fixture' }; },
  }));
  assert.equal(closed.dispatched, true);
  assert.equal(payload.sharedNextAction.decision.action, 'hammer');
  assert.equal(payload.dispatchContext.targetRemediationSha, PUSHED);
});

test('an owned park is not double-owned: a proven owner clears discovery recovery and nothing is dispatched or paged', async t => {
  const rootDir = scratch(t);
  seedFinalRoundPush(rootDir);
  seedLaneWithoutAction(rootDir);
  const pages = [];
  const dispatches = [];
  const recovered = await recoverOverdueOwnership(discovery(rootDir, { owned: true, pages, dispatches }));
  assert.equal(recovered, null);
  assert.deepEqual(pages, []);
  assert.deepEqual(dispatches, []);

  // An executable selected hammer action with a live owner is likewise left alone.
  const lane = { schemaVersion: 1, ...IDENTITY, headSha: PUSHED, noProgressTicks: 1, skippedTicks: 0,
    lane: 'active', progressClass: 'self-resolving', firstNoProgressAt: FIRST_SEEN, lastRunAt: FIRST_SEEN,
    nextAction: { head: PUSHED, row: 'R12-final-push', action: 'hammer', actor: 'hammer',
      reason: 'suppressed-final-push', queue: { intent: 'dispatch' }, deadline: { at: FIRST_SEEN } } };
  writeFileSync(noProgressLaneFilePath(rootDir, IDENTITY), JSON.stringify(lane));
  await recoverOverdueOwnership(discovery(rootDir, { owned: true, pages, dispatches }));
  assert.deepEqual(dispatches, []);

  // The closer's own custody keeps a second pass from launching a second hammer.
  const execCalls = [];
  const leaseIdentity = { rootDir, ...IDENTITY, headSha: PUSHED };
  const launchRequestId = 'lrq_fixture';
  let ledgerReads = 0;
  t.mock.method(dispatchReadTransport, 'lookup', async selector => {
    if (selector.observation === 'workers') {
      assert.equal(selector.launch_request_id, launchRequestId);
      return { schema_version: 1, observation: 'workers', status: 'not_found',
        items: [], complete: true, next_offset: null, scope_complete: false, mutation_authority: false };
    }
    ledgerReads++;
    assert.deepEqual(selector.launch_request_ids, [launchRequestId]);
    assert.equal(selector.include_retry_chain, true);
    return { schema_version: 1, status: 'found', complete: true, roots: [launchRequestId],
      items: [{ launch_request_id: launchRequestId, ticket_id: `AMA-PR-${PR}`,
        repo: REPO, status: 'running', requested_at: NOW }], retry_edges: [] };
  });
  let custodyProbes = 0;
  const args = () => closureArgs(rootDir, {
    now: () => Date.parse(NOW),
    observeClosureWaitImpl: options => observeClosureWait({ ...options, now: Date.parse(NOW),
      pageImpl: async message => { pages.push(message); } }),
    maybeDispatchAmaCloserImpl: async () => {
      execCalls.push('dispatch');
      assert.equal(acquireAmaCloserLease({ ...leaseIdentity, watcherPid: process.pid, now: NOW }).acquired, true);
      updateAmaCloserLease({ ...leaseIdentity, status: 'dispatched', lrqId: launchRequestId, now: NOW });
      return { dispatched: true, launchRequestId };
    },
    probeClosureOwnershipImpl: async options => {
      custodyProbes++;
      assert.equal(readAmaCloserLease(rootDir, leaseIdentity).lrqId, launchRequestId);
      const ownership = await probeOrphanOwnership({ ...options, now: NOW });
      assert.equal(ownership.owned, true);
      assert.equal(ownership.uncertain, false);
      assert.deepEqual(ownership.launchIds, [launchRequestId]);
      return ownership;
    },
  });
  const first = await maybeDispatchAmaClosureFor(args());
  assert.equal(first.dispatched, true);
  assert.equal(execCalls.length, 1);
  const persistedLease = readAmaCloserLease(rootDir, leaseIdentity);
  assert.equal(persistedLease.status, 'dispatched');
  assert.equal(persistedLease.headSha, PUSHED);
  assert.equal(persistedLease.lrqId, launchRequestId);

  const second = await maybeDispatchAmaClosureFor(args());
  assert.equal(second.dispatched, false);
  assert.equal(second.reason, `in-flight:${launchRequestId}`);
  assert.equal(second.nextAction.row, 'R03-live-owner');
  assert.equal(second.nextAction.queue.intent, 'owned');
  assert.ok(ledgerReads > 0, 'the second pass resolves the persisted launch through the ledger adapter');
  assert.equal(custodyProbes, 1, 'the second pass checks closer custody');
  assert.equal(execCalls.length, 1, 'the second closure pass must not invoke the executor');
  assert.deepEqual(readAmaCloserLease(rootDir, leaseIdentity), persistedLease, 'the first owner keeps its lease');
  assert.deepEqual(pages, [], 'live custody does not page during its progress window');
});

test('an exhausted, non-remediable park surfaces as stuck: an executable route spends two attempts, pages once, and keeps the pass', async t => {
  const rootDir = scratch(t);
  seedFinalRoundPush(rootDir);
  const lane = { schemaVersion: 1, ...IDENTITY, headSha: PUSHED, noProgressTicks: 1, skippedTicks: 0,
    lane: 'active', progressClass: 'self-resolving', firstNoProgressAt: FIRST_SEEN, lastRunAt: FIRST_SEEN,
    nextAction: { head: PUSHED, row: 'R12-final-push', action: 'hammer', actor: 'hammer',
      reason: 'suppressed-final-push', queue: { intent: 'dispatch' }, deadline: { at: FIRST_SEEN } } };
  mkdirSync(join(noProgressLaneFilePath(rootDir, IDENTITY), '..'), { recursive: true });
  writeFileSync(noProgressLaneFilePath(rootDir, IDENTITY), JSON.stringify(lane));
  const pages = [];
  const dispatches = [];
  const refused = { dispatched: false, reason: 'hammer-lifetime-cap-exhausted' };
  const outcomes = [];
  for (let pass = 1; pass <= 4; pass += 1) {
    outcomes.push((await recoverOverdueOwnership(discovery(rootDir, { pages, dispatches, dispatchResult: refused })))?.outcome);
  }
  assert.equal(dispatches.length, 2, 'the retry budget is two attempts, never more');
  assert.deepEqual(outcomes.slice(2), ['recovery-exhausted', 'recovery-exhausted'],
    'an executable route that cannot be remediated still ends the pass: its owner is the page');
  assert.equal(pages.length, 1, 'the existing stuck signal fires once, not per tick');
  assert.match(pages[0].message, /lapsed|exhausted|ownerless/i);
  assert.ok(['ama.orphan_recovery.missing-transition', 'ama.orphan_recovery.exhausted'].includes(pages[0].event));
});
