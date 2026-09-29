// HAMBG-02: a hammer whose LRQ ended `succeeded` has closed its PR only when the
// PR merged or a terminal no-merge audit exists for the current head. Otherwise
// the closer records `hammer-exited-without-close`, releases the single-flight
// and re-arms within a bounded, refunded retry budget.
//
// The integration tests drive the real maybeDispatchAmaCloser through the
// shapes of the PRs the SEV2 stranded (2026-09-29): adversarial-review#1178
// (hammer pushed, its lease rekeyed, the close backgrounded), agent-os#7341
// (the only record keyed on the dispatch-time head), agent-os#7334 (a truthful
// no-merge comment and no local audit). Only hq and gh are stubbed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

import {
  _resetHammerRetryCapAlertDebounceForTests,
  HAM_TERMINAL_REMEDIATION_AUDIT_MARKER,
  maybeDispatchAmaCloser,
  readAmaCloserDispatchRecord,
  updateAmaCloserDispatchRecord,
} from '../src/ama/dispatch-closer.mjs';
import { writeAmaAuditEntry } from '../src/ama/audit.mjs';
import {
  acquireAmaCloserLease,
  AMA_CLOSER_LEASE_STATUS,
  readAmaCloserLease,
  rekeyAmaCloserLease,
  updateAmaCloserLease,
} from '../src/ama/closer-lease.mjs';
import {
  HAMMER_EXITED_WITHOUT_CLOSE_RETRY_BUDGET,
  markHammerRetryCapExhausted,
  readHammerRetryCapLedger,
  recordHammerRetryDispatch,
  refundHammerRetryDispatch,
} from '../src/ama/hammer-retry-cap.mjs';
import { beginReviewerPass, completeReviewerPass } from '../src/reviewer-pass-tokens.mjs';
import {
  HAMMER_EXITED_WITHOUT_CLOSE,
  HAMMER_OUTCOME_UNCONFIRMED,
  classifySucceededHammerOutcome,
  hasHamNoMergeAuditCommentForHead,
  isLeaseOfRecordedLaunch,
  selectNewerHammerLaunchRecord,
} from '../src/ama/hammer-outcome-truth.mjs';

const REPO = 'laceyenterprises/adversarial-review';
const PR_NUMBER = 1178;
// adversarial-review#1178: reviewed head, and the head its first hammer pushed.
const REVIEWED_HEAD = '5b421b00d7e916a8e8d8531e72ead9cc439a9d94';
const PUSHED_HEAD = '09bcd6813aeacc0294b0714cc836453e7b9c882d';
// agent-os#7341: the head its hammer was dispatched on (neither reviewed nor current).
const DISPATCH_HEAD = 'cd7faaea2c2587066418ad5d409f947f294e1b5f';
const LRQ_FIRST = 'lrq_6d107190-54c3-480c-bffc-328d118c7caf';
const LRQ_SECOND = 'lrq_42d452bd-9c39-42df-bb2b-1cae4375fff9';
const LRQ_THIRD = 'lrq_third-hammer';
const CURRENT_USER = userInfo().username || process.env.USER || process.env.LOGNAME || 'unknown';

// adversarial-review#1178's audit comment (03:41:40Z): published for the pushed
// head before the merge phase, which the hammer then backgrounded.
const PREMERGE_AUDIT_COMMENT = {
  author: { login: 'the-hammer-lacey' },
  body: [
    HAM_TERMINAL_REMEDIATION_AUDIT_MARKER,
    '',
    '**Findings addressed**',
    '',
    '- **Rubric bypassed for newly added manifest trees** (blocking) — fixed in `src/watcher.mjs`',
    '',
    '<sub>',
    `HAM-Terminal-Remediation-Head: ${PUSHED_HEAD}`,
    'Remediated-Findings: 1 addressed (1 blocking, 0 non-blocking)',
    'Closed-By: hammer (adversarial-pipe-mode)',
    '</sub>',
  ].join('\n'),
};

// agent-os#7334's audit comment after its hammer edited it in place into the
// no-merge closing status (08:14:01Z).
function noMergeAuditComment(headSha, statement = 'Merge: not performed (ama-check not eligible; lease released)') {
  return {
    author: { login: 'the-hammer-lacey' },
    body: [
      HAM_TERMINAL_REMEDIATION_AUDIT_MARKER,
      '',
      '**Findings addressed**',
      '',
      '- **Scratch dir leaks and shared-tmp predictability** (non-blocking) — `op_adapter.py`',
      '',
      '<sub>',
      `HAM-Terminal-Remediation-Head: ${headSha}`,
      'Remediated-Findings: 5 addressed (0 blocking, 5 non-blocking)',
      statement,
      '</sub>',
    ].join('\n'),
  };
}

test('classifySucceededHammerOutcome: merged, no-merge audit, exited, unconfirmed', () => {
  assert.deepEqual(classifySucceededHammerOutcome({ livePrState: 'MERGED' }), { closed: true, outcome: 'merged' });
  assert.deepEqual(classifySucceededHammerOutcome({ livePrState: 'CLOSED' }), { closed: true, outcome: 'pr-closed' });
  assert.deepEqual(
    classifySucceededHammerOutcome({ livePrState: 'OPEN', noMergeAuditForCurrentHead: true }),
    { closed: true, outcome: 'failed-without-merge' },
  );
  assert.deepEqual(
    classifySucceededHammerOutcome({ livePrState: 'OPEN' }),
    { closed: false, outcome: HAMMER_EXITED_WITHOUT_CLOSE },
  );
  assert.deepEqual(
    classifySucceededHammerOutcome({ livePrState: 'OPEN', concurrentWriter: true }),
    { closed: false, outcome: 'no-merge:concurrent-writer' },
  );
  for (const livePrState of [null, '', 'UNKNOWN']) {
    assert.equal(classifySucceededHammerOutcome({ livePrState }).outcome, HAMMER_OUTCOME_UNCONFIRMED);
  }
  // Unreadable comments cannot rule out an honest no-merge report.
  assert.deepEqual(
    classifySucceededHammerOutcome({ livePrState: 'OPEN', noMergeAuditForCurrentHead: null }),
    { closed: false, outcome: HAMMER_OUTCOME_UNCONFIRMED },
  );
});

test('a pre-merge audit comment for the current head is not a no-merge audit (#1178, #7345)', () => {
  assert.equal(
    hasHamNoMergeAuditCommentForHead([PREMERGE_AUDIT_COMMENT], {
      marker: HAM_TERMINAL_REMEDIATION_AUDIT_MARKER,
      headSha: PUSHED_HEAD,
    }),
    false,
  );
});

test('a no-merge closing status for the current head is a no-merge audit (#7334, gate-cap park)', () => {
  const marker = HAM_TERMINAL_REMEDIATION_AUDIT_MARKER;
  assert.equal(hasHamNoMergeAuditCommentForHead([noMergeAuditComment(PUSHED_HEAD)], { marker, headSha: PUSHED_HEAD }), true);
  assert.equal(
    hasHamNoMergeAuditCommentForHead(
      [noMergeAuditComment(PUSHED_HEAD, 'HAM closing status — no merge. The gate-attempt cap stopped this head.')],
      { marker, headSha: PUSHED_HEAD },
    ),
    true,
  );
  // Another head's no-merge status says nothing about this head.
  assert.equal(hasHamNoMergeAuditCommentForHead([noMergeAuditComment(REVIEWED_HEAD)], { marker, headSha: PUSHED_HEAD }), false);
  // Only a hammer identity can write the hammer's audit.
  assert.equal(
    hasHamNoMergeAuditCommentForHead(
      [{ ...noMergeAuditComment(PUSHED_HEAD), author: { login: 'someone-else' } }],
      { marker, headSha: PUSHED_HEAD },
    ),
    false,
  );
});

test('selectNewerHammerLaunchRecord follows the series\' newest launch (#1178, #7341)', () => {
  const reviewedHeadRecord = {
    headSha: REVIEWED_HEAD, reviewedSha: REVIEWED_HEAD, launchRequestId: LRQ_FIRST, dispatchedAt: '2026-09-29T03:30:42Z',
  };
  const pushedHeadRecord = {
    headSha: PUSHED_HEAD, reviewedSha: REVIEWED_HEAD, launchRequestId: LRQ_SECOND, dispatchedAt: '2026-09-29T05:08:39Z',
  };
  const args = { reviewedSha: REVIEWED_HEAD, reviewedHeadSha: REVIEWED_HEAD, reviewedHeadRecord };
  assert.equal(selectNewerHammerLaunchRecord([reviewedHeadRecord, pushedHeadRecord], args), pushedHeadRecord);
  // agent-os#7341: no reviewed-head record; the only one is at the dispatch head.
  const dispatchHeadRecord = { ...pushedHeadRecord, headSha: DISPATCH_HEAD };
  assert.equal(
    selectNewerHammerLaunchRecord([dispatchHeadRecord], { ...args, reviewedHeadRecord: null }),
    dispatchHeadRecord,
  );
  // A pre-launch copy carries the reviewed-head record's LRQ and no new launch.
  assert.equal(
    selectNewerHammerLaunchRecord([{ ...pushedHeadRecord, launchRequestId: LRQ_FIRST }], args),
    null,
  );
  // An earlier series never takes over.
  assert.equal(
    selectNewerHammerLaunchRecord([{ ...pushedHeadRecord, reviewedSha: 'f'.repeat(40) }], args),
    null,
  );
  // An older launch never takes over.
  assert.equal(
    selectNewerHammerLaunchRecord([{ ...pushedHeadRecord, dispatchedAt: '2026-09-29T03:00:00Z' }], args),
    null,
  );
  // A record that never launched is not a launch.
  assert.equal(selectNewerHammerLaunchRecord([{ ...pushedHeadRecord, dispatchedAt: null }], args), null);
});

test('isLeaseOfRecordedLaunch matches a dispatched lease carrying the record\'s LRQ', () => {
  const record = { launchRequestId: LRQ_FIRST };
  assert.equal(isLeaseOfRecordedLaunch({ status: 'dispatched', lrqId: LRQ_FIRST }, record), true);
  assert.equal(isLeaseOfRecordedLaunch({ status: 'dispatched', lrqId: LRQ_SECOND }, record), false);
  assert.equal(isLeaseOfRecordedLaunch({ status: 'terminal', lrqId: LRQ_FIRST }, record), false);
  assert.equal(isLeaseOfRecordedLaunch(null, record), false);
  assert.equal(isLeaseOfRecordedLaunch({ status: 'dispatched', lrqId: LRQ_FIRST }, null), false);
});

test('refundHammerRetryDispatch hands back one charged attempt per launch, within the budget', (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hambg02-refund-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const identity = { repo: REPO, prNumber: PR_NUMBER };
  assert.equal(refundHammerRetryDispatch(rootDir, identity, { jobKey: REVIEWED_HEAD }).reason, 'no-ledger');

  recordHammerRetryDispatch(rootDir, identity, { jobKey: REVIEWED_HEAD, headSha: REVIEWED_HEAD, now: '2026-09-29T03:30:42Z' });
  const refund = refundHammerRetryDispatch(rootDir, identity, {
    jobKey: REVIEWED_HEAD, headSha: REVIEWED_HEAD, launchRequestId: LRQ_FIRST, now: '2026-09-29T03:45:00Z',
  });
  assert.deepEqual(refund, { refunded: true, reason: 'hammer-exited-without-close', retryable: 1 });
  let ledger = readHammerRetryCapLedger(rootDir, identity);
  assert.equal(ledger.attemptCount, 0);
  assert.equal(ledger.targetAttemptCount, 0);
  assert.equal(ledger.lifetimeAttemptCount, 1, 'the lifetime ceiling is never refunded');
  assert.equal(ledger.retryable, 1);
  assert.deepEqual(ledger.retryableLaunchRequestIds, [LRQ_FIRST]);

  // The same launch observed on a later tick is not refunded twice.
  assert.equal(
    refundHammerRetryDispatch(rootDir, identity, { jobKey: REVIEWED_HEAD, launchRequestId: LRQ_FIRST }).reason,
    'already-refunded',
  );

  // The next dispatch keeps the series' refund history.
  recordHammerRetryDispatch(rootDir, identity, { jobKey: REVIEWED_HEAD, headSha: PUSHED_HEAD, now: '2026-09-29T05:08:39Z' });
  ledger = readHammerRetryCapLedger(rootDir, identity);
  assert.equal(ledger.attemptCount, 1);
  assert.equal(ledger.retryable, 1);

  assert.equal(HAMMER_EXITED_WITHOUT_CLOSE_RETRY_BUDGET, 1);
  assert.equal(
    refundHammerRetryDispatch(rootDir, identity, { jobKey: REVIEWED_HEAD, launchRequestId: LRQ_SECOND }).reason,
    'retry-budget-exhausted',
  );
  assert.equal(readHammerRetryCapLedger(rootDir, identity).attemptCount, 1, 'an exit past the budget stays charged');

  // A fresh review starts a new series: its refunds do not apply to the old one.
  assert.equal(
    refundHammerRetryDispatch(rootDir, identity, { jobKey: 'e'.repeat(40), launchRequestId: 'lrq_other' }).reason,
    'series-changed',
  );
  recordHammerRetryDispatch(rootDir, identity, { jobKey: 'e'.repeat(40), headSha: 'e'.repeat(40) });
  ledger = readHammerRetryCapLedger(rootDir, identity);
  assert.equal(ledger.retryable, undefined, 'a fresh series starts with no refunds');
});

test('a suppression stamped for a fresh review does not carry the old series\' spent refund', (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hambg02-exhaust-series-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const identity = { repo: REPO, prNumber: PR_NUMBER };
  const freshReview = 'e'.repeat(40);
  recordHammerRetryDispatch(rootDir, identity, { jobKey: REVIEWED_HEAD, headSha: REVIEWED_HEAD });
  refundHammerRetryDispatch(rootDir, identity, { jobKey: REVIEWED_HEAD, headSha: REVIEWED_HEAD, launchRequestId: LRQ_FIRST });
  assert.equal(readHammerRetryCapLedger(rootDir, identity).retryable, 1);

  // Same series: the refund history stays.
  markHammerRetryCapExhausted(rootDir, identity, { jobKey: REVIEWED_HEAD, headSha: REVIEWED_HEAD, target: true });
  assert.equal(readHammerRetryCapLedger(rootDir, identity).retryable, 1);

  // A fresh review suppressed before it dispatches starts with no refunds, so
  // its first dispatch (no job-key change against the rewritten ledger) does
  // not inherit a spent budget.
  markHammerRetryCapExhausted(rootDir, identity, { jobKey: freshReview, headSha: REVIEWED_HEAD, target: true });
  let ledger = readHammerRetryCapLedger(rootDir, identity);
  assert.equal(ledger.jobKey, freshReview);
  assert.equal(ledger.retryable, undefined);
  assert.equal(ledger.retryableLaunchRequestIds, undefined);
  recordHammerRetryDispatch(rootDir, identity, { jobKey: freshReview, headSha: freshReview });
  assert.equal(
    refundHammerRetryDispatch(rootDir, identity, { jobKey: freshReview, headSha: freshReview, launchRequestId: LRQ_SECOND }).refunded,
    true,
  );
});

function closerArgs(rootDir, { dispatchedAt, livePr = { state: 'OPEN', headRefOid: PUSHED_HEAD }, livePrProbeImpl = null } = {}) {
  return {
    reviewState: {
      verdict: 'comment-only',
      headSha: REVIEWED_HEAD,
      riskClass: 'low',
      remediationPending: false,
      blockingFindingState: 'known',
      blockingFindingCount: 0,
      nonBlockingFindingState: 'known',
      nonBlockingFindingCount: 0,
      operatorApprovedEvidence: null,
      prAuthor: 'builder',
      reviewCycleExhausted: true,
    },
    prMetadata: {
      prNumber: PR_NUMBER,
      headSha: PUSHED_HEAD,
      isOpen: true,
      isDraft: false,
      mergeableState: 'MERGEABLE',
      labels: [],
      statusCheckRollup: [
        { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' },
      ],
      branchProtection: { requiredContexts: [] },
      author: 'builder',
    },
    cfg: {
      enabled: true,
      workerClass: 'hammer-claude',
      mergeMethod: 'squash',
      eligibility: { riskClasses: ['low'], highRiskRequiresTwoKey: false },
      branchProtection: { required: false },
    },
    dispatchContext: {
      rootDir,
      repo: REPO,
      prUrl: `https://github.com/${REPO}/pull/${PR_NUMBER}`,
      reviewedSha: REVIEWED_HEAD,
      targetRemediationSha: PUSHED_HEAD,
      dispatchRecordHeadSha: REVIEWED_HEAD,
      allowStaleReviewHeadHammerResume: true,
      dispatchReason: 'exhausted-final-hammer',
      riskClass: 'low',
      requiredGateContext: 'agent-os/adversarial-gate',
      reviewedBy: 'claude-reviewer-lacey',
      reviewer: 'claude',
      parentSession: 'session:test:watcher',
      hqPath: '/bin/hq-test',
      hqRoot: join(rootDir, 'hq-root'),
      hqOwnerUser: CURRENT_USER,
      currentUser: CURRENT_USER,
      dispatchedAt,
      livePrProbeImpl: livePrProbeImpl || (async () => ({ headBranchExists: true, headRefName: 'hammer/live', ...livePr })),
    },
  };
}

function closerDeps({ nextLaunch, comments = [PREMERGE_AUDIT_COMMENT], alerts = [] } = {}) {
  const statusProbes = [];
  const launches = [];
  return {
    statusProbes,
    launches,
    alerts,
    execFileImpl: async (_cmd, args) => {
      if (args[0] === 'dispatch' && args[1] === 'status') {
        statusProbes.push(args[2]);
        return { stdout: JSON.stringify({ status: 'succeeded' }), stderr: '' };
      }
      if (args[0] === 'dispatch') {
        launches.push(args);
        return { stdout: JSON.stringify({ dispatchId: nextLaunch, launchRequestId: nextLaunch }), stderr: '' };
      }
      return { stdout: '{}', stderr: '' };
    },
    fetchPullRequestRollupImpl: async () => ({ state: 'OPEN', headSha: PUSHED_HEAD, comments }),
    readTemplateImpl: () => 'hammer prompt <<PR_URL>> <<REVIEWED_SHA>> <<TARGET_REMEDIATION_SHA>> <<AMA_TRAILERS>>',
    writeFileImpl: () => {},
    resolveCloserDispatchHarnessImpl: async ({ workerClass }) => ({ workerClass, fellBack: false }),
    readBuildCompletionSignalForPrImpl: () => ({ ok: false, reason: 'missing-build-completion-signal' }),
    readBuildCompletionProducerEvidenceImpl: () => ({ ok: false, reason: 'missing-build-completion-producer-evidence' }),
    deliverAlertImpl: async (alert) => {
      alerts.push(alert);
      return { ok: true };
    },
    logger: { log() {}, info() {}, warn() {}, error() {} },
  };
}

// adversarial-review#1178 at 03:41Z: the first hammer, dispatched on the
// reviewed head, pushed PUSHED_HEAD (the watcher rekeyed its lease there),
// published its audit comment, backgrounded the close and exited `succeeded`.
function seedIssue1178AfterFirstHammer(rootDir) {
  const identity = { repo: REPO, prNumber: PR_NUMBER };
  updateAmaCloserDispatchRecord(rootDir, { ...identity, headSha: REVIEWED_HEAD }, () => ({
    schemaVersion: 1,
    ...identity,
    headSha: REVIEWED_HEAD,
    reviewedSha: REVIEWED_HEAD,
    targetRemediationSha: REVIEWED_HEAD,
    dispatchReason: 'exhausted-final-hammer',
    workerClass: 'hammer-claude',
    dispatchWorkerClass: 'hammer-claude',
    workerId: `hammer-ama-pr-${PR_NUMBER}-${REVIEWED_HEAD.slice(0, 12)}`,
    dispatchTimeoutMs: 600000,
    lastAttemptedAt: '2026-09-29T03:30:42Z',
    dispatchedAt: '2026-09-29T03:30:42Z',
    dispatchId: LRQ_FIRST,
    launchRequestId: LRQ_FIRST,
    retryCount: 1,
    branchHolderBlockCount: 0,
    state: 'dispatched',
    lastObservedStatus: 'starting',
    lastObservedAt: '2026-09-29T03:30:42Z',
    lastError: null,
  }));
  acquireAmaCloserLease({ rootDir, ...identity, headSha: REVIEWED_HEAD, now: '2026-09-29T03:30:00Z' });
  updateAmaCloserLease({
    rootDir, ...identity, headSha: REVIEWED_HEAD, status: AMA_CLOSER_LEASE_STATUS.DISPATCHED,
    lrqId: LRQ_FIRST, now: '2026-09-29T03:30:42Z',
  });
  assert.equal(
    rekeyAmaCloserLease({ rootDir, ...identity, fromHeadSha: REVIEWED_HEAD, toHeadSha: PUSHED_HEAD, now: '2026-09-29T03:39:33Z' }).rekeyed,
    true,
  );
  recordHammerRetryDispatch(rootDir, identity, { jobKey: REVIEWED_HEAD, headSha: REVIEWED_HEAD, now: '2026-09-29T03:30:42Z' });
}

test('#1178: a hammer that exited without closing is re-armed at once, refunded, not held for 30 minutes', async (t) => {
  _resetHammerRetryCapAlertDebounceForTests();
  const rootDir = mkdtempSync(join(tmpdir(), 'hambg02-1178-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  seedIssue1178AfterFirstHammer(rootDir);
  const deps = closerDeps({ nextLaunch: LRQ_SECOND });

  // 03:44Z, the first tick after the exit. Before HAMBG-02 this answered
  // `closer-lease-held-by-other-process` until the lease aged out at 04:13Z.
  const result = await maybeDispatchAmaCloser({
    ...closerArgs(rootDir, { dispatchedAt: '2026-09-29T03:44:43Z' }),
    ...deps,
  });

  assert.equal(result.dispatched, true, JSON.stringify(result));
  assert.equal(result.launchRequestId, LRQ_SECOND);
  assert.deepEqual(deps.statusProbes, [LRQ_FIRST]);

  const firstRecord = readAmaCloserDispatchRecord(rootDir, { repo: REPO, prNumber: PR_NUMBER, headSha: REVIEWED_HEAD });
  assert.equal(firstRecord.lastObservedStatus, 'succeeded');
  assert.equal(firstRecord.outcome, HAMMER_EXITED_WITHOUT_CLOSE);
  assert.equal(firstRecord.lastError, HAMMER_EXITED_WITHOUT_CLOSE);

  const lease = readAmaCloserLease(rootDir, { repo: REPO, prNumber: PR_NUMBER, headSha: PUSHED_HEAD });
  assert.equal(lease.status, AMA_CLOSER_LEASE_STATUS.DISPATCHED);
  assert.equal(lease.lrqId, LRQ_SECOND, 'the exited hammer\'s lease was released and re-acquired for the re-arm');

  const ledger = readHammerRetryCapLedger(rootDir, { repo: REPO, prNumber: PR_NUMBER });
  assert.equal(ledger.retryable, 1);
  assert.deepEqual(ledger.retryableLaunchRequestIds, [LRQ_FIRST]);
  assert.equal(ledger.attemptCount, 1, 'the exit was refunded; only the re-arm is charged');
  assert.equal(ledger.lifetimeAttemptCount, 2);
});

test('#1178: the re-armed hammer is the one observed next, and the retry budget stays bounded', async (t) => {
  _resetHammerRetryCapAlertDebounceForTests();
  const rootDir = mkdtempSync(join(tmpdir(), 'hambg02-1178-chain-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  seedIssue1178AfterFirstHammer(rootDir);
  const alerts = [];

  const rearmed = await maybeDispatchAmaCloser({
    ...closerArgs(rootDir, { dispatchedAt: '2026-09-29T03:44:43Z' }),
    ...closerDeps({ nextLaunch: LRQ_SECOND, alerts }),
  });
  assert.equal(rearmed.launchRequestId, LRQ_SECOND);
  const firstRecordAfterRearm = readAmaCloserDispatchRecord(rootDir, { repo: REPO, prNumber: PR_NUMBER, headSha: REVIEWED_HEAD });

  // The second hammer exits the same way. Before HAMBG-02 the closer kept
  // reading the reviewed-head record, re-observed LRQ_FIRST, and every tick
  // died on `refusing to reuse terminal reviewer_passes row`.
  const secondDeps = closerDeps({ nextLaunch: LRQ_THIRD, alerts });
  const again = await maybeDispatchAmaCloser({
    ...closerArgs(rootDir, { dispatchedAt: '2026-09-29T04:05:00Z' }),
    ...secondDeps,
  });
  assert.deepEqual(secondDeps.statusProbes, [LRQ_SECOND]);
  assert.equal(again.dispatched, true, JSON.stringify(again));
  assert.equal(again.launchRequestId, LRQ_THIRD);
  assert.deepEqual(
    readAmaCloserDispatchRecord(rootDir, { repo: REPO, prNumber: PR_NUMBER, headSha: REVIEWED_HEAD }),
    firstRecordAfterRearm,
    'the first hammer is reconciled once, not on every tick',
  );
  let ledger = readHammerRetryCapLedger(rootDir, { repo: REPO, prNumber: PR_NUMBER });
  assert.equal(ledger.retryable, 1, 'the budget refunds one exit per series');
  assert.equal(ledger.attemptCount, 2);

  // The third exit meets the normal cap: suppressed, and the operator is paged.
  const thirdDeps = closerDeps({ nextLaunch: 'lrq_unexpected', alerts });
  const capped = await maybeDispatchAmaCloser({
    ...closerArgs(rootDir, { dispatchedAt: '2026-09-29T04:10:00Z' }),
    ...thirdDeps,
  });
  assert.deepEqual(thirdDeps.statusProbes, [LRQ_THIRD]);
  assert.equal(capped.dispatched, false);
  assert.equal(capped.reason, 'hammer-retry-cap-exhausted');
  assert.equal(capped.needsOperator, true);
  assert.equal(thirdDeps.launches.length, 0);
  assert.equal(alerts.length, 1);
  const thirdRecord = readAmaCloserDispatchRecord(rootDir, { repo: REPO, prNumber: PR_NUMBER, headSha: PUSHED_HEAD });
  assert.equal(thirdRecord.launchRequestId, LRQ_THIRD);
  assert.equal(thirdRecord.outcome, HAMMER_EXITED_WITHOUT_CLOSE);
  ledger = readHammerRetryCapLedger(rootDir, { repo: REPO, prNumber: PR_NUMBER });
  assert.equal(ledger.suppressed, true);

  // Observing the same exited launch again must not throw.
  const repeat = await maybeDispatchAmaCloser({
    ...closerArgs(rootDir, { dispatchedAt: '2026-09-29T04:12:00Z' }),
    ...closerDeps({ nextLaunch: 'lrq_unexpected', alerts }),
  });
  assert.equal(repeat.dispatched, false);
  assert.equal(repeat.reason, 'hammer-retry-cap-exhausted');
});

test('#7341: a launch recorded on the dispatch-time head is observed and its rekeyed lease released', async (t) => {
  _resetHammerRetryCapAlertDebounceForTests();
  const rootDir = mkdtempSync(join(tmpdir(), 'hambg02-7341-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const identity = { repo: REPO, prNumber: PR_NUMBER };
  // No record at the reviewed head: the hammer was dispatched on DISPATCH_HEAD,
  // then pushed PUSHED_HEAD, and the watcher rekeyed its lease there.
  updateAmaCloserDispatchRecord(rootDir, { ...identity, headSha: DISPATCH_HEAD }, () => ({
    schemaVersion: 1,
    ...identity,
    headSha: DISPATCH_HEAD,
    reviewedSha: REVIEWED_HEAD,
    targetRemediationSha: DISPATCH_HEAD,
    workerClass: 'hammer-claude',
    dispatchWorkerClass: 'hammer-claude',
    dispatchedAt: '2026-09-29T07:02:39Z',
    lastAttemptedAt: '2026-09-29T07:02:39Z',
    dispatchId: LRQ_FIRST,
    launchRequestId: LRQ_FIRST,
    retryCount: 1,
    state: 'dispatched',
    lastObservedStatus: 'starting',
    lastObservedAt: '2026-09-29T07:02:39Z',
    lastError: null,
  }));
  acquireAmaCloserLease({ rootDir, ...identity, headSha: DISPATCH_HEAD, now: '2026-09-29T07:02:00Z' });
  updateAmaCloserLease({
    rootDir, ...identity, headSha: DISPATCH_HEAD, status: AMA_CLOSER_LEASE_STATUS.DISPATCHED,
    lrqId: LRQ_FIRST, now: '2026-09-29T07:02:39Z',
  });
  rekeyAmaCloserLease({ rootDir, ...identity, fromHeadSha: DISPATCH_HEAD, toHeadSha: PUSHED_HEAD, now: '2026-09-29T07:10:00Z' });
  recordHammerRetryDispatch(rootDir, identity, { jobKey: REVIEWED_HEAD, headSha: DISPATCH_HEAD, now: '2026-09-29T07:02:39Z' });
  const deps = closerDeps({ nextLaunch: LRQ_SECOND, comments: [] });

  const result = await maybeDispatchAmaCloser({
    ...closerArgs(rootDir, { dispatchedAt: '2026-09-29T07:20:00Z' }),
    ...deps,
  });

  assert.deepEqual(deps.statusProbes, [LRQ_FIRST]);
  assert.equal(result.dispatched, true, JSON.stringify(result));
  assert.equal(result.launchRequestId, LRQ_SECOND);
  const dispatchHeadRecord = readAmaCloserDispatchRecord(rootDir, { ...identity, headSha: DISPATCH_HEAD });
  assert.equal(dispatchHeadRecord.outcome, HAMMER_EXITED_WITHOUT_CLOSE);
  assert.equal(readAmaCloserLease(rootDir, { ...identity, headSha: PUSHED_HEAD }).lrqId, LRQ_SECOND);
});

test('#7334: a truthful no-merge audit comment is a closed run, charged, not refunded', async (t) => {
  _resetHammerRetryCapAlertDebounceForTests();
  const rootDir = mkdtempSync(join(tmpdir(), 'hambg02-7334-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  seedIssue1178AfterFirstHammer(rootDir);

  const result = await maybeDispatchAmaCloser({
    ...closerArgs(rootDir, { dispatchedAt: '2026-09-29T03:44:43Z' }),
    ...closerDeps({ nextLaunch: LRQ_SECOND, comments: [PREMERGE_AUDIT_COMMENT, noMergeAuditComment(PUSHED_HEAD)] }),
  });

  assert.equal(result.dispatched, true, JSON.stringify(result));
  const record = readAmaCloserDispatchRecord(rootDir, { repo: REPO, prNumber: PR_NUMBER, headSha: REVIEWED_HEAD });
  assert.equal(record.outcome, 'failed-without-merge');
  const ledger = readHammerRetryCapLedger(rootDir, { repo: REPO, prNumber: PR_NUMBER });
  assert.equal(ledger.retryable, undefined);
  assert.equal(ledger.attemptCount, 2, 'a run that reported its no-merge spends a real attempt');
});

test('the local failed-without-merge audit for the current head is a closed run', async (t) => {
  _resetHammerRetryCapAlertDebounceForTests();
  const rootDir = mkdtempSync(join(tmpdir(), 'hambg02-local-audit-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  seedIssue1178AfterFirstHammer(rootDir);
  // What `ham_append_terminal_audit failed-without-merge github-gate-red` writes.
  writeAmaAuditEntry({
    hqRoot: join(rootDir, 'hq-root'),
    repo: REPO,
    prNumber: PR_NUMBER,
    headSha: PUSHED_HEAD,
    now: '2026-09-29T03:41:00Z',
    attempt: { outcome: 'failed-without-merge', reason: 'github-gate-red' },
    metadata: { closureAuthority: 'ham-terminal-remediation' },
  });

  await maybeDispatchAmaCloser({
    ...closerArgs(rootDir, { dispatchedAt: '2026-09-29T03:44:43Z' }),
    ...closerDeps({ nextLaunch: LRQ_SECOND, comments: [] }),
  });

  const record = readAmaCloserDispatchRecord(rootDir, { repo: REPO, prNumber: PR_NUMBER, headSha: REVIEWED_HEAD });
  assert.equal(record.outcome, 'failed-without-merge');
  assert.equal(readHammerRetryCapLedger(rootDir, { repo: REPO, prNumber: PR_NUMBER }).retryable, undefined);
});

test('an unreadable PR state confirms nothing: the launch is retained, no re-arm', async (t) => {
  _resetHammerRetryCapAlertDebounceForTests();
  const rootDir = mkdtempSync(join(tmpdir(), 'hambg02-unconfirmed-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  seedIssue1178AfterFirstHammer(rootDir);
  const deps = closerDeps({ nextLaunch: 'lrq_unexpected' });

  const result = await maybeDispatchAmaCloser({
    ...closerArgs(rootDir, {
      dispatchedAt: '2026-09-29T03:44:43Z',
      livePrProbeImpl: async () => {
        throw new Error('gh: HTTP 502');
      },
    }),
    ...deps,
  });

  assert.equal(result.dispatched, false);
  assert.equal(result.reason, 'existing-dispatch-succeeded');
  assert.equal(deps.launches.length, 0);
  const record = readAmaCloserDispatchRecord(rootDir, { repo: REPO, prNumber: PR_NUMBER, headSha: REVIEWED_HEAD });
  assert.equal(record.lastError, `${HAMMER_OUTCOME_UNCONFIRMED}:live-pr-probe-failed`);
  assert.equal(record.outcome, undefined);
  const lease = readAmaCloserLease(rootDir, { repo: REPO, prNumber: PR_NUMBER, headSha: PUSHED_HEAD });
  assert.equal(lease.status, AMA_CLOSER_LEASE_STATUS.DISPATCHED);
  assert.equal(readHammerRetryCapLedger(rootDir, { repo: REPO, prNumber: PR_NUMBER }).attemptCount, 1);
});

test('an unreadable comment list confirms nothing: the launch is retained, the refund unspent', async (t) => {
  _resetHammerRetryCapAlertDebounceForTests();
  const rootDir = mkdtempSync(join(tmpdir(), 'hambg02-comments-unreadable-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  seedIssue1178AfterFirstHammer(rootDir);
  const deps = closerDeps({ nextLaunch: 'lrq_unexpected' });
  deps.fetchPullRequestRollupImpl = async () => {
    throw new Error('gh: context deadline exceeded');
  };

  const result = await maybeDispatchAmaCloser({
    ...closerArgs(rootDir, { dispatchedAt: '2026-09-29T03:44:43Z' }),
    ...deps,
  });

  assert.equal(result.dispatched, false);
  assert.equal(deps.launches.length, 0);
  const record = readAmaCloserDispatchRecord(rootDir, { repo: REPO, prNumber: PR_NUMBER, headSha: REVIEWED_HEAD });
  assert.equal(record.lastError, `${HAMMER_OUTCOME_UNCONFIRMED}:audit-comments-unreadable`);
  assert.equal(record.outcome, undefined, 'an honest no-merge report is not recorded as an exit without close');
  const ledger = readHammerRetryCapLedger(rootDir, { repo: REPO, prNumber: PR_NUMBER });
  assert.equal(ledger.retryable, undefined, 'the series\' refund is not spent on an unconfirmed outcome');
  assert.equal(ledger.attemptCount, 1);
});

// A terminal closer pass at attempt 1 written by `launchRequestId` for this PR.
function seedTerminalCloserPass(rootDir, launchRequestId) {
  const metadata = { amaCloser: true, launchRequestId };
  beginReviewerPass(rootDir, {
    repo: REPO, prNumber: PR_NUMBER, attemptNumber: 1, reviewerClass: 'hammer-claude', passKind: 'closer',
    workerRunId: `wr-${launchRequestId}`, startedAt: '2026-09-28T01:00:00Z', metadata,
  });
  completeReviewerPass(rootDir, {
    repo: REPO, prNumber: PR_NUMBER, attemptNumber: 1, passKind: 'closer', status: 'failed',
    endedAt: '2026-09-28T01:10:00Z', workerRunId: `wr-${launchRequestId}`, metadata,
  });
}

async function reconcileFirstHammerWarnings(rootDir) {
  const warnings = [];
  const deps = closerDeps({ nextLaunch: LRQ_SECOND });
  deps.logger = { ...deps.logger, warn: (line) => warnings.push(String(line)) };
  const result = await maybeDispatchAmaCloser({
    ...closerArgs(rootDir, { dispatchedAt: '2026-09-29T03:44:43Z' }),
    ...deps,
  });
  assert.equal(result.dispatched, true, JSON.stringify(result));
  return warnings;
}

test('a closer pass from another series at the same attempt number is reported as a collision', async (t) => {
  _resetHammerRetryCapAlertDebounceForTests();
  const rootDir = mkdtempSync(join(tmpdir(), 'hambg02-pass-collision-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  // An earlier review series' first closer (retryCount 1) already holds attempt 1.
  seedTerminalCloserPass(rootDir, 'lrq_earlier-series');
  seedIssue1178AfterFirstHammer(rootDir);

  const warnings = await reconcileFirstHammerWarnings(rootDir);

  const collision = warnings.find((line) => line.includes('attempt-number collision'));
  assert.ok(collision, warnings.join('\n'));
  assert.match(collision, new RegExp(`launchRequestId=${LRQ_FIRST}`));
  assert.match(collision, /lrq_earlier-series/);
  assert.equal(warnings.some((line) => line.includes('closer pass already recorded')), false);
});

test('re-reconciling a launch whose closer pass is recorded says so, and is not a collision', async (t) => {
  _resetHammerRetryCapAlertDebounceForTests();
  const rootDir = mkdtempSync(join(tmpdir(), 'hambg02-pass-same-launch-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  seedTerminalCloserPass(rootDir, LRQ_FIRST);
  seedIssue1178AfterFirstHammer(rootDir);

  const warnings = await reconcileFirstHammerWarnings(rootDir);

  assert.ok(warnings.some((line) => line.includes('closer pass already recorded')), warnings.join('\n'));
  assert.equal(warnings.some((line) => line.includes('attempt-number collision')), false);
});
