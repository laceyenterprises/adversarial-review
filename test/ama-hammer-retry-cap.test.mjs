import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';

import {
  _resetHammerRetryCapAlertDebounceForTests,
  AMA_CLOSER_DISPATCHED_LEASE_RECLAIM_AGE_MS,
  AMA_CLOSER_REDISPATCH_BOUND,
  amaCloserDispatchFilePath,
  isReclaimableDispatchedAmaCloserLease,
  maybeDispatchAmaCloser,
  readAmaCloserDispatchRecord,
  updateAmaCloserDispatchRecord,
} from '../src/ama/dispatch-closer.mjs';
import { writeAmaAuditEntry } from '../src/ama/audit.mjs';
import {
  acquireAmaCloserLease,
  AMA_CLOSER_LEASE_STATUS,
  readAmaCloserLease,
  updateAmaCloserLease,
} from '../src/ama/closer-lease.mjs';
import {
  HAMMER_RETRY_CAP_SUPPRESSION_STATE,
  HAMMER_RETRY_CAP_TOTAL_DISPATCHES,
  HAMMER_RETRY_CAP_LIFETIME_TOTAL_DISPATCHES,
  HAMMER_RETRY_CAP_LIFETIME_SUPPRESSION_STATE,
  evaluateHammerRetryCap,
  hammerRetryCapFilePath,
  markHammerRetryCapExhausted,
  normalizeHammerLifetimeDispatchCeiling,
  readHammerRetryCapLedger,
  recordHammerRetryDispatch,
} from '../src/ama/hammer-retry-cap.mjs';

const REPO = 'acme/myrepo';
const PR_NUMBER = 3116;
const REVIEWED_HEAD = 'a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0';
const ADVANCED_HEAD = 'b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1';
const CURRENT_USER = userInfo().username || process.env.USER || process.env.LOGNAME || 'unknown';

function hammerDispatchArgs(rootDir, overrides = {}) {
  return {
    reviewState: {
      verdict: 'request changes',
      headSha: REVIEWED_HEAD,
      riskClass: 'low',
      remediationPending: false,
      blockingFindingState: 'known',
      blockingFindingCount: 1,
      nonBlockingFindingState: 'known',
      nonBlockingFindingCount: 0,
      operatorApprovedEvidence: null,
      prAuthor: 'builder',
      ...overrides.reviewState,
    },
    prMetadata: {
      prNumber: PR_NUMBER,
      headSha: REVIEWED_HEAD,
      isOpen: true,
      isDraft: false,
      mergeableState: 'MERGEABLE',
      labels: [],
      statusCheckRollup: [],
      branchProtection: { requiredContexts: [] },
      author: 'builder',
      ...overrides.prMetadata,
    },
    cfg: {
      enabled: true,
      workerClass: 'hammer',
      mergeMethod: 'squash',
      eligibility: {
        riskClasses: ['low'],
        highRiskRequiresTwoKey: false,
      },
      branchProtection: { required: false },
      ...overrides.cfg,
    },
    dispatchContext: {
      rootDir,
      repo: REPO,
      prUrl: `https://github.com/${REPO}/pull/${PR_NUMBER}`,
      reviewedSha: REVIEWED_HEAD,
      riskClass: 'low',
      requiredGateContext: 'agent-os/adversarial-gate',
      reviewedBy: 'codex-reviewer-lacey',
      reviewer: 'codex',
      parentSession: 'session:test:watcher',
      hqPath: '/bin/hq-test',
      hqRoot: join(rootDir, 'hq-root'),
      hqOwnerUser: CURRENT_USER,
      currentUser: CURRENT_USER,
      dispatchedAt: '2026-07-06T12:00:00Z',
      ...overrides.dispatchContext,
    },
  };
}

function hammerDispatchDeps(overrides = {}) {
  const execCalls = [];
  return {
    execCalls,
    execFileImpl: async (cmd, args) => {
      execCalls.push({ cmd, args });
      return { stdout: JSON.stringify({ dispatchId: 'dispatch_hammer', launchRequestId: 'lrq_hammer' }), stderr: '' };
    },
    readTemplateImpl: () => 'hammer prompt <<PR_URL>> <<REVIEWED_SHA>> <<TARGET_REMEDIATION_SHA>> <<AMA_TRAILERS>>',
    writeFileImpl: () => {},
    resolveCloserDispatchHarnessImpl: async ({ workerClass }) => ({ workerClass, fellBack: false }),
    readBuildCompletionSignalForPrImpl: () => ({ ok: false, reason: 'missing-build-completion-signal' }),
    readBuildCompletionProducerEvidenceImpl: () => ({ ok: false, reason: 'missing-build-completion-producer-evidence' }),
    logger: { log() {}, info() {}, warn() {}, error() {} },
    ...overrides,
  };
}

function seedExhaustedHammerCap(rootDir, identity = { repo: REPO, prNumber: PR_NUMBER }) {
  for (let i = 1; i <= HAMMER_RETRY_CAP_LIFETIME_TOTAL_DISPATCHES; i += 1) {
    recordHammerRetryDispatch(rootDir, identity, {
      jobKey: `${REVIEWED_HEAD}-${i}`,
      headSha: `head-${i}`,
      now: `2026-07-06T12:${String(i).padStart(2, '0')}:00Z`,
    });
  }
}

function validHamTerminalRemediationOptions({
  reviewedHead = REVIEWED_HEAD,
  currentHead = ADVANCED_HEAD,
} = {}) {
  const auditBody = 'HAM audit: addressed Auth path not threaded in src/auth.js. Doc-currency: not applicable for changed files src/auth.js.';
  const finding = { title: 'Auth path not threaded', blocking: true, file: 'src/auth.js', addressed: true };
  return {
    env: {},
    hamTerminalRemediation: {
      active: true,
      commit: {
        sha: currentHead,
        parentSha: reviewedHead,
      },
      auditComment: {
        body: auditBody,
        docCurrency: {
          status: 'not_applicable',
          changedFiles: ['src/auth.js'],
        },
        findings: [finding],
      },
    },
    hamTerminalRemediationGroundTruth: {
      commit: {
        sha: currentHead,
        parentSha: reviewedHead,
        author: 'hammer-worker',
        changedFiles: ['src/auth.js'],
        trailers: {
          'Worker-Class': 'hammer',
          'Worker-Ticket': 'HAM',
          'Reviewed-Head': reviewedHead,
          'Closed-By': 'hammer (adversarial-pipe-mode)',
          'Remediated-Findings': '1 addressed (1 blocking, 0 non-blocking)',
        },
      },
      auditComment: {
        body: auditBody,
        author: 'hammer-worker',
        createdAt: '2026-07-06T12:01:00Z',
        id: 'IC_ham_audit',
      },
    },
  };
}

test('evaluateHammerRetryCap accumulates by logical review job key', () => {
  const first = evaluateHammerRetryCap(null, { jobKey: REVIEWED_HEAD, headSha: 'h1' });
  assert.equal(first.priorAttemptCount, 0);
  assert.equal(first.nextAttemptCount, 1);
  assert.equal(first.capExhausted, false);

  const second = evaluateHammerRetryCap(
    { jobKey: REVIEWED_HEAD, attemptCount: 1 },
    { jobKey: REVIEWED_HEAD, headSha: 'h2' },
  );
  assert.equal(second.nextAttemptCount, 2);
  assert.equal(second.capExhausted, false);

  const third = evaluateHammerRetryCap(
    { jobKey: REVIEWED_HEAD, attemptCount: 2 },
    { jobKey: REVIEWED_HEAD, headSha: 'h3' },
  );
  assert.equal(third.nextAttemptCount, 3);
  assert.equal(third.capExhausted, false);
  assert.equal(HAMMER_RETRY_CAP_TOTAL_DISPATCHES, 2);
});

test('hammer lifetime ceiling is injectable, defaults to 6, and 0 disables hammer', () => {
  assert.equal(HAMMER_RETRY_CAP_LIFETIME_TOTAL_DISPATCHES, 6);
  assert.equal(normalizeHammerLifetimeDispatchCeiling(1), 1);
  assert.equal(normalizeHammerLifetimeDispatchCeiling(3), 3);
  assert.equal(normalizeHammerLifetimeDispatchCeiling(0), 0);
  assert.equal(normalizeHammerLifetimeDispatchCeiling('nope'), 6);

  assert.equal(
    evaluateHammerRetryCap(
      { jobKey: 'job', lifetimeAttemptCount: 1 },
      { jobKey: 'fresh', headSha: 'h', lifetimeDispatchCeiling: 1 },
    ).capExhausted,
    true,
  );
  assert.equal(
    evaluateHammerRetryCap(
      { jobKey: 'job', lifetimeAttemptCount: 2 },
      { jobKey: 'fresh', headSha: 'h', lifetimeDispatchCeiling: 3 },
    ).capExhausted,
    false,
  );
  assert.equal(
    evaluateHammerRetryCap(
      null,
      { jobKey: 'job', headSha: 'h', lifetimeDispatchCeiling: 0 },
    ).capExhausted,
    true,
  );
});

test('evaluateHammerRetryCap resets for a genuinely fresh review head', () => {
  const decision = evaluateHammerRetryCap(
    { jobKey: REVIEWED_HEAD, attemptCount: 2, suppressed: true },
    {
      jobKey: 'b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1',
      headSha: 'newhead',
      lifetimeDispatchCeiling: 3,
    },
  );
  assert.equal(decision.jobKeyChanged, true);
  assert.equal(decision.priorAttemptCount, 0);
  assert.equal(decision.alreadySuppressed, false);
  assert.equal(decision.capExhausted, false);
});

test('lifetime ceiling trips across fresh-review resets (the runaway loop-breaker)', (t) => {
  // Reproduces the 2026-07-06 runaway: each hammer dispatch earns a FRESH
  // adversarial review on the moved head, so the jobKey advances every cycle and
  // the per-series cap keeps resetting — but the lifetime ceiling must not.
  const rootDir = mkdtempSync(join(tmpdir(), 'hammer-cap-lifetime-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const identity = { repo: REPO, prNumber: 4242 };

  for (let i = 1; i <= HAMMER_RETRY_CAP_LIFETIME_TOTAL_DISPATCHES; i += 1) {
    const decision = evaluateHammerRetryCap(
      readHammerRetryCapLedger(rootDir, identity),
      { jobKey: `job-${i}`, headSha: `head-${i}` },
    );
    assert.equal(decision.jobKeyChanged, i > 1, `dispatch ${i} jobKeyChanged`);
    assert.equal(decision.priorAttemptCount, 0, `dispatch ${i} per-series keeps resetting`);
    assert.equal(decision.capExhausted, false, `dispatch ${i} should be allowed`);
    const doc = recordHammerRetryDispatch(rootDir, identity, {
      jobKey: `job-${i}`,
      headSha: `head-${i}`,
    });
    assert.equal(doc.lifetimeAttemptCount, i, `dispatch ${i} accumulates lifetime`);
    assert.equal(doc.attemptCount, 1, `dispatch ${i} per-series stays at 1 under churn`);
  }

  // The next dispatch is still a fresh review head (would reset the series) but is
  // now blocked by the lifetime ceiling.
  const blocked = evaluateHammerRetryCap(
    readHammerRetryCapLedger(rootDir, identity),
    { jobKey: 'job-final', headSha: 'head-final' },
  );
  assert.equal(blocked.jobKeyChanged, true);
  assert.equal(blocked.lifetimeCapExhausted, true);
  assert.equal(blocked.capExhausted, true);
});

test('lifetime suppression is immune to the fresh-review reset', (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hammer-cap-lifetime-supp-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const identity = { repo: REPO, prNumber: 4243 };

  const suppressed = markHammerRetryCapExhausted(rootDir, identity, {
    jobKey: 'jobX',
    headSha: 'headX',
    attemptCount: 2,
    lifetime: true,
    now: '2026-07-06T00:00:00Z',
  });
  assert.equal(suppressed.lifetimeSuppressed, true);
  assert.equal(suppressed.suppressionState, HAMMER_RETRY_CAP_LIFETIME_SUPPRESSION_STATE);

  // A genuinely fresh review head clears the PER-SERIES suppression but the
  // lifetime suppression HOLDS — the loop cannot be re-armed by a new review.
  const afterFreshReview = evaluateHammerRetryCap(
    readHammerRetryCapLedger(rootDir, identity),
    { jobKey: 'totally-new-review-head', headSha: 'newhead' },
  );
  assert.equal(afterFreshReview.jobKeyChanged, true);
  assert.equal(afterFreshReview.alreadySuppressed, false);
  assert.equal(afterFreshReview.lifetimeAlreadySuppressed, true);
  assert.equal(afterFreshReview.capExhausted, true);
});

test('a non-finite lifetimeAttemptCount fails CLOSED (no silent NaN bypass)', () => {
  // An operator hand-editing the ledger to a non-numeric truthy value must not
  // re-arm the loop by making `NaN > ceiling` evaluate false.
  for (const corrupt of ['foo', 'NaN', {}, Infinity]) {
    const decision = evaluateHammerRetryCap(
      { jobKey: 'jobY', lifetimeAttemptCount: corrupt },
      { jobKey: 'jobY', headSha: 'headY' },
    );
    assert.equal(
      decision.capExhausted,
      true,
      `corrupt lifetimeAttemptCount ${JSON.stringify(corrupt)} must fail closed`,
    );
    assert.equal(decision.lifetimeCapExhausted, true);
  }
  // A valid numeric value is unaffected.
  const ok = evaluateHammerRetryCap(
    { jobKey: 'jobY', lifetimeAttemptCount: 1 },
    { jobKey: 'jobY', headSha: 'headY' },
  );
  assert.equal(ok.capExhausted, false);
});

test('hammer retry cap ledger round-trips and corrupt ledgers fail closed', (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hammer-cap-unit-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const identity = { repo: REPO, prNumber: PR_NUMBER };

  const afterFirst = recordHammerRetryDispatch(rootDir, identity, {
    jobKey: REVIEWED_HEAD,
    headSha: 'h1',
    now: '2026-07-05T00:00:00Z',
  });
  assert.equal(afterFirst.attemptCount, 1);

  const afterSecond = recordHammerRetryDispatch(rootDir, identity, {
    jobKey: REVIEWED_HEAD,
    headSha: 'h2',
    now: '2026-07-05T00:05:00Z',
  });
  assert.equal(afterSecond.attemptCount, 2);
  assert.deepEqual(afterSecond.dispatchHeads, ['h1', 'h2']);

  const suppressed = markHammerRetryCapExhausted(rootDir, identity, {
    jobKey: REVIEWED_HEAD,
    headSha: 'h3',
    attemptCount: 2,
    alertEmitted: true,
    now: '2026-07-05T00:10:00Z',
  });
  assert.equal(suppressed.suppressed, true);
  assert.equal(suppressed.suppressionState, HAMMER_RETRY_CAP_SUPPRESSION_STATE);
  assert.equal(readHammerRetryCapLedger(rootDir, identity).alertedAt, '2026-07-05T00:10:00Z');

  const corruptRoot = mkdtempSync(join(tmpdir(), 'hammer-cap-corrupt-'));
  t.after(() => rmSync(corruptRoot, { recursive: true, force: true }));
  const corruptPath = hammerRetryCapFilePath(corruptRoot, identity);
  mkdirSync(dirname(corruptPath), { recursive: true });
  writeFileSync(corruptPath, '{ "attemptCount": 2, "jobKey":', 'utf8');
  const corrupt = readHammerRetryCapLedger(corruptRoot, identity, { logger: { warn() {} } });
  assert.equal(corrupt?.__corrupt, true);
  assert.equal(
    evaluateHammerRetryCap(corrupt, { jobKey: REVIEWED_HEAD, headSha: 'h1' }).capExhausted,
    true,
  );
});

test('maybeDispatchAmaCloser records confirmed hammer launches in the retry-cap ledger', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hammer-cap-integration-record-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const deps = hammerDispatchDeps();

  const result = await maybeDispatchAmaCloser({
    ...hammerDispatchArgs(rootDir),
    ...deps,
  });

  assert.equal(result.dispatched, true);
  assert.equal(deps.execCalls.length, 1);
  const ledger = readHammerRetryCapLedger(rootDir, { repo: REPO, prNumber: PR_NUMBER });
  assert.equal(ledger.jobKey, REVIEWED_HEAD);
  assert.equal(ledger.attemptCount, 1);
  assert.deepEqual(ledger.dispatchHeads, [REVIEWED_HEAD]);
});

test('per-head redispatch budget resets on new head before lifetime ceiling', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hammer-cap-per-head-reset-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const oldHead = 'old-head-exhausted';
  const oldRecordPath = amaCloserDispatchFilePath(rootDir, {
    repo: REPO,
    prNumber: PR_NUMBER,
    headSha: oldHead,
  });
  mkdirSync(dirname(oldRecordPath), { recursive: true });
  writeFileSync(oldRecordPath, `${JSON.stringify({
    repo: REPO,
    prNumber: PR_NUMBER,
    headSha: oldHead,
    workerClass: 'hammer',
    state: 'dispatch-failed',
    retryCount: AMA_CLOSER_REDISPATCH_BOUND,
  })}\n`);

  const blockedOldHead = await maybeDispatchAmaCloser({
    ...hammerDispatchArgs(rootDir, {
      prMetadata: { headSha: oldHead },
      reviewState: { headSha: oldHead },
      dispatchContext: { reviewedSha: oldHead, targetRemediationSha: oldHead, dispatchRecordHeadSha: oldHead },
    }),
    ...hammerDispatchDeps(),
  });
  assert.equal(blockedOldHead.dispatched, false);
  assert.equal(blockedOldHead.reason, 'dispatch-retry-exhausted');

  const deps = hammerDispatchDeps();
  const newHead = 'new-head-before-lifetime';
  const dispatchedNewHead = await maybeDispatchAmaCloser({
    ...hammerDispatchArgs(rootDir, {
      prMetadata: { headSha: newHead },
      reviewState: { headSha: newHead },
      dispatchContext: { reviewedSha: newHead, targetRemediationSha: newHead, dispatchRecordHeadSha: newHead },
    }),
    ...deps,
  });
  assert.equal(dispatchedNewHead.dispatched, true);
  assert.equal(deps.execCalls.length, 1);
  assert.equal(
    readHammerRetryCapLedger(rootDir, { repo: REPO, prNumber: PR_NUMBER }).lifetimeAttemptCount,
    1,
  );
});

test('exhausted final-hammer path counts lifetime dispatches across heads and trips default ceiling at 6', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hammer-cap-exhaustion-path-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const alertCalls = [];
  const deps = hammerDispatchDeps({
    deliverAlertImpl: async (text, opts) => {
      alertCalls.push({ text, opts });
    },
  });

  for (let i = 1; i <= HAMMER_RETRY_CAP_LIFETIME_TOTAL_DISPATCHES; i += 1) {
    const result = await maybeDispatchAmaCloser({
      ...hammerDispatchArgs(rootDir, {
        reviewState: { reviewCycleExhausted: true, headSha: `job-${i}` },
        prMetadata: { headSha: `head-${i}`, mergeableState: 'DIRTY' },
        dispatchContext: {
          reviewedSha: `job-${i}`,
          targetRemediationSha: `head-${i}`,
          dispatchRecordHeadSha: `job-${i}`,
          allowStaleReviewHeadHammerResume: true,
          dispatchedAt: `2026-07-06T12:${String(i).padStart(2, '0')}:00Z`,
        },
      }),
      ...deps,
    });
    assert.equal(result.dispatched, true, `dispatch ${i} should be allowed`);
  }
  const blocked = await maybeDispatchAmaCloser({
    ...hammerDispatchArgs(rootDir, {
      reviewState: { reviewCycleExhausted: true, headSha: 'job-7' },
      prMetadata: { headSha: 'head-7', mergeableState: 'DIRTY' },
      dispatchContext: {
        reviewedSha: 'job-7',
        targetRemediationSha: 'head-7',
        dispatchRecordHeadSha: 'job-7',
        allowStaleReviewHeadHammerResume: true,
        dispatchedAt: '2026-07-06T12:07:00Z',
      },
    }),
    ...deps,
  });

  assert.equal(blocked.dispatched, false);
  assert.equal(blocked.reason, 'hammer-lifetime-ceiling-reached');
  assert.equal(blocked.suppressionState, HAMMER_RETRY_CAP_LIFETIME_SUPPRESSION_STATE);
  assert.equal(deps.execCalls.length, HAMMER_RETRY_CAP_LIFETIME_TOTAL_DISPATCHES);
  assert.equal(alertCalls.length, 1);
  assert.equal(alertCalls[0].opts.event, 'hammer_lifetime_ceiling_reached');
  const ledger = readHammerRetryCapLedger(rootDir, { repo: REPO, prNumber: PR_NUMBER });
  assert.equal(
    ledger.lifetimeAttemptCount,
    HAMMER_RETRY_CAP_LIFETIME_TOTAL_DISPATCHES,
    'ledger equals the actual terminal-remediation launches',
  );
  assert.equal(ledger.suppressionState, HAMMER_RETRY_CAP_LIFETIME_SUPPRESSION_STATE);
});

test('configured hammer lifetime ceiling disables hammer at 0 and controls dispatch at 1 and 3', async (t) => {
  const rootZero = mkdtempSync(join(tmpdir(), 'hammer-cap-cfg-zero-'));
  const rootOne = mkdtempSync(join(tmpdir(), 'hammer-cap-cfg-one-'));
  const rootThree = mkdtempSync(join(tmpdir(), 'hammer-cap-cfg-three-'));
  t.after(() => {
    rmSync(rootZero, { recursive: true, force: true });
    rmSync(rootOne, { recursive: true, force: true });
    rmSync(rootThree, { recursive: true, force: true });
  });

  const depsZero = hammerDispatchDeps();
  const disabledZero = await maybeDispatchAmaCloser({
    ...hammerDispatchArgs(rootZero, { cfg: { hammerLifetimeDispatchCeiling: 0 } }),
    ...depsZero,
  });
  assert.equal(disabledZero.dispatched, false);
  assert.equal(disabledZero.skipMergeAgent, false);
  assert.equal(disabledZero.reason, 'hammer-disabled');
  assert.equal(depsZero.execCalls.length, 0);
  assert.equal(readHammerRetryCapLedger(rootZero, { repo: REPO, prNumber: PR_NUMBER }), null);

  const depsOne = hammerDispatchDeps();
  const firstOne = await maybeDispatchAmaCloser({
    ...hammerDispatchArgs(rootOne, { cfg: { hammerLifetimeDispatchCeiling: 1 } }),
    ...depsOne,
  });
  const blockedOne = await maybeDispatchAmaCloser({
    ...hammerDispatchArgs(rootOne, {
      cfg: { hammerLifetimeDispatchCeiling: 1 },
      prMetadata: { headSha: 'fresh-job' },
      reviewState: { headSha: 'fresh-job' },
      dispatchContext: { reviewedSha: 'fresh-job', targetRemediationSha: 'fresh-job' },
    }),
    ...depsOne,
  });
  assert.equal(firstOne.dispatched, true);
  assert.equal(blockedOne.dispatched, false);
  assert.equal(blockedOne.reason, 'hammer-lifetime-ceiling-reached');
  assert.equal(depsOne.execCalls.length, 1);

  const depsThree = hammerDispatchDeps();
  for (let i = 1; i <= 3; i += 1) {
    const result = await maybeDispatchAmaCloser({
      ...hammerDispatchArgs(rootThree, {
        cfg: { hammerLifetimeDispatchCeiling: 3 },
        prMetadata: { headSha: `cfg-job-${i}` },
        reviewState: { headSha: `cfg-job-${i}` },
        dispatchContext: { reviewedSha: `cfg-job-${i}`, targetRemediationSha: `cfg-job-${i}` },
      }),
      ...depsThree,
    });
    assert.equal(result.dispatched, true, `dispatch ${i} should be allowed`);
  }
  const blockedThree = await maybeDispatchAmaCloser({
    ...hammerDispatchArgs(rootThree, {
      cfg: { hammerLifetimeDispatchCeiling: 3 },
      prMetadata: { headSha: 'cfg-job-4' },
      reviewState: { headSha: 'cfg-job-4' },
      dispatchContext: { reviewedSha: 'cfg-job-4', targetRemediationSha: 'cfg-job-4' },
    }),
    ...depsThree,
  });
  assert.equal(blockedThree.dispatched, false);
  assert.equal(blockedThree.reason, 'hammer-lifetime-ceiling-reached');
  assert.equal(depsThree.execCalls.length, 3);
});

test('same validated HAM target head can recover until hammer cap is exhausted', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hammer-cap-same-head-dedup-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  recordHammerRetryDispatch(rootDir, { repo: REPO, prNumber: PR_NUMBER }, {
    jobKey: 'reviewed-before-ham',
    headSha: '52d98936',
  });
  const deps = hammerDispatchDeps();
  const result = await maybeDispatchAmaCloser({
    ...hammerDispatchArgs(rootDir, {
      reviewState: { reviewCycleExhausted: true, headSha: 'reviewed-after-ham' },
      prMetadata: { headSha: '52d98936', mergeableState: 'DIRTY' },
      dispatchContext: {
        reviewedSha: 'reviewed-after-ham',
        targetRemediationSha: '52d98936',
        dispatchRecordHeadSha: 'reviewed-after-ham',
        allowStaleReviewHeadHammerResume: true,
      },
    }),
    ...deps,
  });

  assert.equal(result.dispatched, true);
  assert.equal(deps.execCalls.length, 1);
  const ledger = readHammerRetryCapLedger(rootDir, { repo: REPO, prNumber: PR_NUMBER });
  assert.equal(ledger.lifetimeAttemptCount, 2);
});

test('terminal-remediation success finalizes lease and failure redispatches replacement', async (t) => {
  const successRoot = mkdtempSync(join(tmpdir(), 'hammer-lease-success-'));
  const failureRoot = mkdtempSync(join(tmpdir(), 'hammer-lease-failure-'));
  t.after(() => {
    rmSync(successRoot, { recursive: true, force: true });
    rmSync(failureRoot, { recursive: true, force: true });
  });

  const successDeps = hammerDispatchDeps();
  const first = await maybeDispatchAmaCloser({
    ...hammerDispatchArgs(successRoot),
    ...successDeps,
  });
  assert.equal(first.dispatched, true);
  const successProbe = await maybeDispatchAmaCloser({
    ...hammerDispatchArgs(successRoot, {
      reviewState: { reviewCycleExhausted: true },
      dispatchContext: { dispatchedAt: '2026-07-06T12:02:00Z' },
    }),
    ...hammerDispatchDeps({
      execFileImpl: async (_cmd, args) => {
        if (args[0] === 'dispatch' && args[1] === 'status') {
          return { stdout: JSON.stringify({ status: 'succeeded' }), stderr: '' };
        }
        return { stdout: JSON.stringify({ dispatchId: 'unexpected', launchRequestId: 'unexpected' }), stderr: '' };
      },
    }),
  });
  assert.equal(successProbe.reason, 'current-head-hammer-already-ran-needs-operator');
  assert.equal(successProbe.needsOperator, true);
  // The hammer dispatch reached a terminal-HOLD status but produced NO merged
  // signal — so the closer parks the PR for the operator. The lease must stay
  // non-terminal: a false terminal 'succeeded' would falsify the §4.4 audit
  // trail, and any non-null terminalOutcome hides the still-open PR from
  // review-pipeline-health / recovery-reaper.
  assert.equal(
    readAmaCloserLease(successRoot, { repo: REPO, prNumber: PR_NUMBER, headSha: REVIEWED_HEAD }).terminalOutcome,
    null,
  );

  const failureDeps = hammerDispatchDeps();
  const failedFirst = await maybeDispatchAmaCloser({
    ...hammerDispatchArgs(failureRoot),
    ...failureDeps,
  });
  assert.equal(failedFirst.dispatched, true);
  const failureProbe = await maybeDispatchAmaCloser({
    ...hammerDispatchArgs(failureRoot, {
      dispatchContext: { dispatchedAt: '2026-07-06T12:02:00Z' },
    }),
    ...hammerDispatchDeps({
      execFileImpl: async (_cmd, args) => {
        if (args[0] === 'dispatch' && args[1] === 'status') {
          return { stdout: JSON.stringify({ status: 'failed' }), stderr: '' };
        }
        return { stdout: JSON.stringify({ dispatchId: 'unexpected', launchRequestId: 'unexpected' }), stderr: '' };
      },
    }),
  });
  assert.equal(failureProbe.dispatched, true);
  const replacementLease = readAmaCloserLease(failureRoot, { repo: REPO, prNumber: PR_NUMBER, headSha: REVIEWED_HEAD });
  assert.equal(replacementLease.status, AMA_CLOSER_LEASE_STATUS.DISPATCHED);
  assert.equal(replacementLease.lrqId, 'unexpected');
});

test('terminal old-head hammer dispatch is superseded when remediation advanced the head', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hammer-lease-head-advanced-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  acquireAmaCloserLease({
    rootDir,
    repo: REPO,
    prNumber: PR_NUMBER,
    headSha: REVIEWED_HEAD,
    now: '2026-07-06T12:00:00Z',
  });
  updateAmaCloserLease({
    rootDir,
    repo: REPO,
    prNumber: PR_NUMBER,
    headSha: REVIEWED_HEAD,
    status: AMA_CLOSER_LEASE_STATUS.DISPATCHED,
    lrqId: 'lrq_old_head',
    now: '2026-07-06T12:00:00Z',
  });
  updateAmaCloserDispatchRecord(rootDir, { repo: REPO, prNumber: PR_NUMBER, headSha: REVIEWED_HEAD }, () => ({
    schemaVersion: 1,
    repo: REPO,
    prNumber: PR_NUMBER,
    headSha: REVIEWED_HEAD,
    reviewedSha: REVIEWED_HEAD,
    targetRemediationSha: ADVANCED_HEAD,
    workerClass: 'hammer',
    dispatchWorkerClass: 'hammer',
    promptPath: '/tmp/old-prompt.md',
    promptDir: '/tmp',
    hqRoot: join(rootDir, 'hq-root'),
    launchRequestId: 'lrq_old_head',
    dispatchId: 'dispatch_old_head',
    retryCount: 1,
    state: 'dispatched',
    lastObservedStatus: 'starting',
  }));

  const result = await maybeDispatchAmaCloser({
    ...hammerDispatchArgs(rootDir, {
      reviewState: { reviewCycleExhausted: true },
      prMetadata: { headSha: ADVANCED_HEAD },
      dispatchContext: {
        targetRemediationSha: ADVANCED_HEAD,
        dispatchRecordHeadSha: REVIEWED_HEAD,
        allowStaleReviewHeadHammerResume: true,
        dispatchedAt: '2026-07-06T12:02:00Z',
      },
    }),
    ...hammerDispatchDeps({
      execFileImpl: async (_cmd, args) => {
        if (args[0] === 'dispatch' && args[1] === 'status') {
          return { stdout: JSON.stringify({ status: 'succeeded' }), stderr: '' };
        }
        return { stdout: JSON.stringify({ dispatchId: 'dispatch_new_head', launchRequestId: 'lrq_new_head' }), stderr: '' };
      },
    }),
  });

  assert.equal(result.dispatched, true);
  assert.equal(result.launchRequestId, 'lrq_new_head');
  const oldLease = readAmaCloserLease(rootDir, { repo: REPO, prNumber: PR_NUMBER, headSha: REVIEWED_HEAD });
  assert.equal(oldLease.status, AMA_CLOSER_LEASE_STATUS.TERMINAL);
  assert.equal(oldLease.terminalOutcome, 'superseded');
  const currentLease = readAmaCloserLease(rootDir, { repo: REPO, prNumber: PR_NUMBER, headSha: ADVANCED_HEAD });
  assert.equal(currentLease.status, AMA_CLOSER_LEASE_STATUS.DISPATCHED);
  assert.equal(currentLease.lrqId, 'lrq_new_head');
  const oldRecord = readAmaCloserDispatchRecord(rootDir, { repo: REPO, prNumber: PR_NUMBER, headSha: REVIEWED_HEAD });
  assert.equal(oldRecord.headSha, REVIEWED_HEAD);
  assert.equal(oldRecord.launchRequestId, 'lrq_old_head');
  assert.equal(oldRecord.lastError, 'terminal-dispatch-superseded-by-head-advance');
  const currentRecord = readAmaCloserDispatchRecord(rootDir, { repo: REPO, prNumber: PR_NUMBER, headSha: ADVANCED_HEAD });
  assert.equal(currentRecord.headSha, ADVANCED_HEAD);
  assert.equal(currentRecord.reviewedSha, REVIEWED_HEAD);
  assert.equal(currentRecord.launchRequestId, 'lrq_new_head');
  assert.equal(currentRecord.state, 'dispatched');
});

test('active target-head lease on head advance defers without overwriting old-head dispatch', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hammer-lease-target-active-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  acquireAmaCloserLease({
    rootDir,
    repo: REPO,
    prNumber: PR_NUMBER,
    headSha: ADVANCED_HEAD,
    watcherPid: process.pid,
    now: '2026-07-06T12:00:00Z',
  });

  const deps = hammerDispatchDeps();
  const result = await maybeDispatchAmaCloser({
    ...hammerDispatchArgs(rootDir, {
      reviewState: { reviewCycleExhausted: true },
      prMetadata: { headSha: ADVANCED_HEAD },
      dispatchContext: {
        targetRemediationSha: ADVANCED_HEAD,
        dispatchRecordHeadSha: REVIEWED_HEAD,
        allowStaleReviewHeadHammerResume: true,
        dispatchedAt: '2026-07-06T12:00:30Z',
      },
    }),
    ...deps,
  });

  assert.equal(result.dispatched, false);
  assert.equal(result.reason, 'closer-lease-held-by-other-process');
  assert.equal(result.existingLease.headSha, ADVANCED_HEAD);
  assert.equal(deps.execCalls.length, 0);
  assert.equal(
    readAmaCloserDispatchRecord(rootDir, { repo: REPO, prNumber: PR_NUMBER, headSha: ADVANCED_HEAD }),
    null,
  );
});

test('stale target-head pending lease on head advance is reclaimed before dispatch', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hammer-lease-target-stale-pending-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  acquireAmaCloserLease({
    rootDir,
    repo: REPO,
    prNumber: PR_NUMBER,
    headSha: ADVANCED_HEAD,
    watcherPid: 999999,
    now: '2026-07-06T12:00:00Z',
  });

  const result = await maybeDispatchAmaCloser({
    ...hammerDispatchArgs(rootDir, {
      reviewState: { reviewCycleExhausted: true },
      prMetadata: { headSha: ADVANCED_HEAD },
      dispatchContext: {
        targetRemediationSha: ADVANCED_HEAD,
        dispatchRecordHeadSha: REVIEWED_HEAD,
        allowStaleReviewHeadHammerResume: true,
        dispatchedAt: '2026-07-06T12:01:00Z',
      },
    }),
    processKillImpl: () => {
      const err = new Error('missing process');
      err.code = 'ESRCH';
      throw err;
    },
    ...hammerDispatchDeps({
      execFileImpl: async (_cmd, args) => {
        if (args[0] === 'dispatch' && args[1] === 'status') {
          return { stdout: JSON.stringify({ status: 'not-found' }), stderr: '' };
        }
        return { stdout: JSON.stringify({ dispatchId: 'dispatch_new_head', launchRequestId: 'lrq_new_head' }), stderr: '' };
      },
    }),
  });

  assert.equal(result.dispatched, true);
  assert.equal(result.launchRequestId, 'lrq_new_head');
  const currentLease = readAmaCloserLease(rootDir, { repo: REPO, prNumber: PR_NUMBER, headSha: ADVANCED_HEAD });
  assert.equal(currentLease.status, AMA_CLOSER_LEASE_STATUS.DISPATCHED);
  assert.equal(currentLease.lrqId, 'lrq_new_head');
});

test('terminal current-head hammer dispatch is not superseded after remediation advances the PR head', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hammer-lease-current-head-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  acquireAmaCloserLease({
    rootDir,
    repo: REPO,
    prNumber: PR_NUMBER,
    headSha: ADVANCED_HEAD,
    now: '2026-07-06T12:00:00Z',
  });
  updateAmaCloserLease({
    rootDir,
    repo: REPO,
    prNumber: PR_NUMBER,
    headSha: ADVANCED_HEAD,
    status: AMA_CLOSER_LEASE_STATUS.DISPATCHED,
    lrqId: 'lrq_current_head',
    now: '2026-07-06T12:00:00Z',
  });
  updateAmaCloserDispatchRecord(rootDir, { repo: REPO, prNumber: PR_NUMBER, headSha: ADVANCED_HEAD }, () => ({
    schemaVersion: 1,
    repo: REPO,
    prNumber: PR_NUMBER,
    headSha: ADVANCED_HEAD,
    reviewedSha: REVIEWED_HEAD,
    targetRemediationSha: ADVANCED_HEAD,
    workerClass: 'hammer',
    dispatchWorkerClass: 'hammer',
    promptPath: '/tmp/current-prompt.md',
    promptDir: '/tmp',
    hqRoot: join(rootDir, 'hq-root'),
    launchRequestId: 'lrq_current_head',
    dispatchId: 'dispatch_current_head',
    retryCount: 1,
    state: 'dispatched',
    lastObservedStatus: 'starting',
  }));

  const result = await maybeDispatchAmaCloser({
    ...hammerDispatchArgs(rootDir, {
      reviewState: { reviewCycleExhausted: true },
      prMetadata: { headSha: ADVANCED_HEAD },
      dispatchContext: {
        targetRemediationSha: ADVANCED_HEAD,
        allowStaleReviewHeadHammerResume: true,
        dispatchedAt: '2026-07-06T12:02:00Z',
      },
    }),
    ...hammerDispatchDeps({
      execFileImpl: async (_cmd, args) => {
        if (args[0] === 'dispatch' && args[1] === 'status') {
          return { stdout: JSON.stringify({ status: 'succeeded' }), stderr: '' };
        }
        return { stdout: JSON.stringify({ dispatchId: 'unexpected', launchRequestId: 'unexpected' }), stderr: '' };
      },
    }),
  });

  assert.equal(result.dispatched, false);
  assert.equal(result.reason, 'current-head-hammer-already-ran-needs-operator');
  assert.equal(result.needsOperator, true);
  const currentLease = readAmaCloserLease(rootDir, { repo: REPO, prNumber: PR_NUMBER, headSha: ADVANCED_HEAD });
  assert.equal(currentLease.status, AMA_CLOSER_LEASE_STATUS.DISPATCHED);
  assert.equal(currentLease.terminalOutcome, null);
  const currentRecord = updateAmaCloserDispatchRecord(
    rootDir,
    { repo: REPO, prNumber: PR_NUMBER, headSha: ADVANCED_HEAD },
    (record) => record,
  );
  assert.equal(currentRecord.lastError, 'current-head-hammer-already-ran-needs-operator');
});

test('current-head hammer dispatch ignores old-head audit terminal outcome while audit is pending', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hammer-audit-current-head-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const hqRoot = join(rootDir, 'hq-root');
  writeAmaAuditEntry({
    hqRoot,
    repo: REPO,
    prNumber: PR_NUMBER,
    headSha: REVIEWED_HEAD,
    now: '2026-07-06T12:00:00Z',
    attempt: { outcome: 'succeeded' },
  });
  acquireAmaCloserLease({
    rootDir,
    repo: REPO,
    prNumber: PR_NUMBER,
    headSha: ADVANCED_HEAD,
    now: '2026-07-06T12:00:00Z',
  });
  updateAmaCloserLease({
    rootDir,
    repo: REPO,
    prNumber: PR_NUMBER,
    headSha: ADVANCED_HEAD,
    status: AMA_CLOSER_LEASE_STATUS.DISPATCHED,
    lrqId: 'lrq_current_head',
    now: '2026-07-06T12:00:00Z',
  });
  updateAmaCloserDispatchRecord(rootDir, { repo: REPO, prNumber: PR_NUMBER, headSha: ADVANCED_HEAD }, () => ({
    schemaVersion: 1,
    repo: REPO,
    prNumber: PR_NUMBER,
    headSha: ADVANCED_HEAD,
    reviewedSha: REVIEWED_HEAD,
    targetRemediationSha: ADVANCED_HEAD,
    workerClass: 'hammer',
    dispatchWorkerClass: 'hammer',
    promptPath: '/tmp/current-prompt.md',
    promptDir: '/tmp',
    hqRoot,
    launchRequestId: 'lrq_current_head',
    dispatchId: 'dispatch_current_head',
    retryCount: 1,
    state: 'dispatched',
    lastObservedStatus: 'starting',
  }));

  const result = await maybeDispatchAmaCloser({
    ...hammerDispatchArgs(rootDir, {
      reviewState: { reviewCycleExhausted: true },
      prMetadata: { headSha: ADVANCED_HEAD },
      dispatchContext: {
        hqRoot,
        targetRemediationSha: ADVANCED_HEAD,
        allowStaleReviewHeadHammerResume: true,
        dispatchedAt: '2026-07-06T12:02:00Z',
      },
    }),
    ...hammerDispatchDeps({
      execFileImpl: async (_cmd, args) => {
        if (args[0] === 'dispatch' && args[1] === 'status') {
          return { stdout: JSON.stringify({ status: 'running' }), stderr: '' };
        }
        return { stdout: JSON.stringify({ dispatchId: 'unexpected', launchRequestId: 'unexpected' }), stderr: '' };
      },
      readBuildCompletionSignalForPrImpl: () => ({ ok: false, reason: 'missing-build-completion-signal' }),
      readBuildCompletionProducerEvidenceImpl: () => ({
        ok: true,
        row: { signal_kind: 'merged', head_sha: ADVANCED_HEAD },
        target: { repo: REPO, prNumber: PR_NUMBER },
      }),
    }),
  });

  assert.equal(result.dispatched, false);
  assert.equal(result.reason, 'existing-dispatch-running');
  const currentLease = readAmaCloserLease(rootDir, { repo: REPO, prNumber: PR_NUMBER, headSha: ADVANCED_HEAD });
  assert.equal(currentLease.status, AMA_CLOSER_LEASE_STATUS.DISPATCHED);
  assert.equal(currentLease.terminalOutcome, null);
});

test('valid current-head HAM terminal remediation escalates structural misses instead of re-hammering', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hammer-valid-ham-no-rehammer-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const deps = hammerDispatchDeps();

  const result = await maybeDispatchAmaCloser({
    ...hammerDispatchArgs(rootDir, {
      reviewState: {
        reviewCycleExhausted: true,
      },
      prMetadata: {
        headSha: ADVANCED_HEAD,
        statusCheckRollup: [
          { __typename: 'CheckRun', name: 'test', conclusion: 'FAILURE' },
        ],
      },
      dispatchContext: {
        targetRemediationSha: ADVANCED_HEAD,
        allowStaleReviewHeadHammerResume: true,
      },
    }),
    options: validHamTerminalRemediationOptions(),
    ...deps,
  });

  assert.equal(result.dispatched, false);
  assert.equal(result.reason, 'current-head-ham-terminal-remediation-needs-operator');
  assert.equal(result.needsOperator, true);
  assert.ok(result.reasons.includes('ci-not-green'));
  assert.equal(deps.execCalls.length, 0);
});

test('stale dispatched/null closer lease is terminalized instead of held forever', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hammer-lease-stale-dispatched-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  acquireAmaCloserLease({
    rootDir,
    repo: REPO,
    prNumber: PR_NUMBER,
    headSha: REVIEWED_HEAD,
    now: '2026-07-06T12:00:00Z',
  });
  updateAmaCloserLease({
    rootDir,
    repo: REPO,
    prNumber: PR_NUMBER,
    headSha: REVIEWED_HEAD,
    status: AMA_CLOSER_LEASE_STATUS.DISPATCHED,
    lrqId: 'lrq_stale',
    now: '2026-07-06T12:00:00Z',
  });
  assert.equal(
    isReclaimableDispatchedAmaCloserLease(
      readAmaCloserLease(rootDir, { repo: REPO, prNumber: PR_NUMBER, headSha: REVIEWED_HEAD }),
      { now: new Date(Date.parse('2026-07-06T12:00:00Z') + AMA_CLOSER_DISPATCHED_LEASE_RECLAIM_AGE_MS + 1).toISOString() },
    ),
    true,
  );

  const result = await maybeDispatchAmaCloser({
    ...hammerDispatchArgs(rootDir, {
      dispatchContext: {
        dispatchedAt: new Date(Date.parse('2026-07-06T12:00:00Z') + AMA_CLOSER_DISPATCHED_LEASE_RECLAIM_AGE_MS + 1).toISOString(),
      },
    }),
    ...hammerDispatchDeps(),
  });

  assert.equal(result.dispatched, false);
  assert.equal(result.reason, 'stale-dispatched-lease-terminalized');
  assert.equal(result.existingLease.status, AMA_CLOSER_LEASE_STATUS.TERMINAL);
  assert.equal(result.existingLease.terminalOutcome, 'failed-without-merge');
  const lease = readAmaCloserLease(rootDir, { repo: REPO, prNumber: PR_NUMBER, headSha: REVIEWED_HEAD });
  assert.equal(lease.status, AMA_CLOSER_LEASE_STATUS.TERMINAL);
  assert.equal(lease.terminalOutcome, 'failed-without-merge');
});

test('maybeDispatchAmaCloser suppresses after lifetime ceiling and emits operator alert once', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hammer-cap-integration-suppress-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  _resetHammerRetryCapAlertDebounceForTests();
  seedExhaustedHammerCap(rootDir);
  const alertCalls = [];
  const infoLogs = [];
  const deps = hammerDispatchDeps({
    deliverAlertImpl: async (text, opts) => {
      alertCalls.push({ text, opts });
    },
    logger: {
      log() {},
      info(line) { infoLogs.push(JSON.parse(line)); },
      warn() {},
      error() {},
    },
  });

  const result = await maybeDispatchAmaCloser({
    ...hammerDispatchArgs(rootDir, {
      cfg: { hammerLifetimeDispatchCeiling: 3 },
    }),
    ...deps,
  });

  assert.equal(result.dispatched, false);
  assert.equal(result.skipMergeAgent, true);
  assert.equal(result.reason, 'hammer-lifetime-ceiling-reached');
  assert.equal(result.needsOperator, true);
  assert.equal(result.attemptCount, HAMMER_RETRY_CAP_LIFETIME_TOTAL_DISPATCHES);
  assert.equal(deps.execCalls.length, 0, 'suppression must happen before hq dispatch');
  assert.equal(alertCalls.length, 1);
  assert.equal(alertCalls[0].opts.event, 'hammer_lifetime_ceiling_reached');
  assert.match(alertCalls[0].text, /6\/3 hammer terminal-remediation dispatches/);
  assert.equal(alertCalls[0].opts.payload.cap, 3);
  assert.equal(
    infoLogs.filter((entry) => entry.event === 'hammer_lifetime_ceiling_reached').length,
    1,
  );
  assert.equal(
    infoLogs.find((entry) => entry.event === 'hammer_lifetime_ceiling_reached')?.cap,
    3,
  );
  const ledger = readHammerRetryCapLedger(rootDir, { repo: REPO, prNumber: PR_NUMBER });
  assert.equal(ledger.suppressed, true);
  assert.equal(ledger.suppressionState, HAMMER_RETRY_CAP_LIFETIME_SUPPRESSION_STATE);
  assert.equal(ledger.alertedAt, '2026-07-06T12:00:00Z');

  const repeated = await maybeDispatchAmaCloser({
    ...hammerDispatchArgs(rootDir, {
      prMetadata: { headSha: 'after-ceiling-head', mergeableState: 'DIRTY' },
      reviewState: { headSha: 'after-ceiling-job', reviewCycleExhausted: true },
      dispatchContext: {
        reviewedSha: 'after-ceiling-job',
        targetRemediationSha: 'after-ceiling-head',
        dispatchRecordHeadSha: 'after-ceiling-job',
        allowStaleReviewHeadHammerResume: true,
        dispatchedAt: '2026-07-06T12:01:00Z',
      },
    }),
    ...deps,
  });
  assert.equal(repeated.reason, 'hammer-lifetime-ceiling-reached');
  assert.equal(alertCalls.length, 1);
  assert.equal(
    infoLogs.filter((entry) => entry.event === 'hammer_lifetime_ceiling_reached').length,
    1,
  );
});

test('maybeDispatchAmaCloser asserts audit owner before retry-cap suppression mutation', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hammer-cap-owner-before-suppress-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  seedExhaustedHammerCap(rootDir);
  let alertCalls = 0;

  await assert.rejects(
    () => maybeDispatchAmaCloser({
      ...hammerDispatchArgs(rootDir, {
        dispatchContext: { currentUser: 'not-the-hq-owner' },
      }),
      ...hammerDispatchDeps({
        deliverAlertImpl: async () => {
          alertCalls += 1;
        },
      }),
    }),
    /does not match HQ ownerUser/,
  );

  assert.equal(alertCalls, 0);
  const ledger = readHammerRetryCapLedger(rootDir, { repo: REPO, prNumber: PR_NUMBER });
  assert.equal(ledger.suppressed, false);
  assert.equal(ledger.alertedAt, null);
});

test('retry-cap alert transport failure fails open but records suppression', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hammer-cap-alert-fail-open-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  seedExhaustedHammerCap(rootDir);

  const result = await maybeDispatchAmaCloser({
    ...hammerDispatchArgs(rootDir),
    ...hammerDispatchDeps({
      deliverAlertImpl: async () => {
        throw new Error('ALERT_TO must be configured');
      },
    }),
  });

  assert.equal(result.reason, 'hammer-lifetime-ceiling-reached');
  assert.equal(result.alertEmitted, false);
  const ledger = readHammerRetryCapLedger(rootDir, { repo: REPO, prNumber: PR_NUMBER });
  assert.equal(ledger.suppressed, true);
  assert.equal(ledger.alertedAt, null);
});

test('retry-cap alert is debounced in-process when suppression ledger write fails', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hammer-cap-alert-debounce-'));
  t.after(() => {
    try {
      chmodSync(dirname(hammerRetryCapFilePath(rootDir, { repo: REPO, prNumber: PR_NUMBER })), 0o755);
    } catch {}
    rmSync(rootDir, { recursive: true, force: true });
  });
  _resetHammerRetryCapAlertDebounceForTests();
  seedExhaustedHammerCap(rootDir);
  const capDir = dirname(hammerRetryCapFilePath(rootDir, { repo: REPO, prNumber: PR_NUMBER }));
  chmodSync(capDir, 0o555);
  const alertCalls = [];
  const args = {
    ...hammerDispatchArgs(rootDir),
    ...hammerDispatchDeps({
      deliverAlertImpl: async (text, opts) => {
        alertCalls.push({ text, opts });
      },
    }),
  };

  const first = await maybeDispatchAmaCloser(args);
  const second = await maybeDispatchAmaCloser({
    ...args,
    dispatchContext: {
      ...args.dispatchContext,
      dispatchedAt: '2026-07-06T12:01:00Z',
    },
  });

  assert.equal(first.reason, 'hammer-lifetime-ceiling-reached');
  assert.equal(second.reason, 'hammer-lifetime-ceiling-reached');
  assert.equal(alertCalls.length, 1, 'in-process debounce prevents re-page storms when ledger writes fail');
});
