import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';

import {
  _resetHammerRetryCapAlertDebounceForTests,
  maybeDispatchAmaCloser,
} from '../src/ama/dispatch-closer.mjs';
import {
  HAMMER_RETRY_CAP_SUPPRESSION_STATE,
  HAMMER_RETRY_CAP_TOTAL_DISPATCHES,
  HAMMER_RETRY_CAP_LIFETIME_TOTAL_DISPATCHES,
  HAMMER_RETRY_CAP_LIFETIME_SUPPRESSION_STATE,
  evaluateHammerRetryCap,
  hammerRetryCapFilePath,
  markHammerRetryCapExhausted,
  readHammerRetryCapLedger,
  recordHammerRetryDispatch,
} from '../src/ama/hammer-retry-cap.mjs';

const REPO = 'acme/myrepo';
const PR_NUMBER = 3116;
const REVIEWED_HEAD = 'a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0';
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
  recordHammerRetryDispatch(rootDir, identity, {
    jobKey: REVIEWED_HEAD,
    headSha: REVIEWED_HEAD,
    now: '2026-07-06T12:00:00Z',
  });
  recordHammerRetryDispatch(rootDir, identity, {
    jobKey: REVIEWED_HEAD,
    headSha: REVIEWED_HEAD,
    now: '2026-07-06T12:05:00Z',
  });
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
  assert.equal(third.capExhausted, true);
  assert.equal(HAMMER_RETRY_CAP_TOTAL_DISPATCHES, 2);
});

test('evaluateHammerRetryCap resets for a genuinely fresh review head', () => {
  const decision = evaluateHammerRetryCap(
    { jobKey: REVIEWED_HEAD, attemptCount: 2, suppressed: true },
    { jobKey: 'b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1', headSha: 'newhead' },
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

test('maybeDispatchAmaCloser suppresses third hammer launch and emits operator alert', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hammer-cap-integration-suppress-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  seedExhaustedHammerCap(rootDir);
  const alertCalls = [];
  const deps = hammerDispatchDeps({
    deliverAlertImpl: async (text, opts) => {
      alertCalls.push({ text, opts });
    },
  });

  const result = await maybeDispatchAmaCloser({
    ...hammerDispatchArgs(rootDir),
    ...deps,
  });

  assert.equal(result.dispatched, false);
  assert.equal(result.skipMergeAgent, true);
  assert.equal(result.reason, 'hammer-retry-cap-exhausted');
  assert.equal(result.needsOperator, true);
  assert.equal(result.attemptCount, HAMMER_RETRY_CAP_TOTAL_DISPATCHES);
  assert.equal(deps.execCalls.length, 0, 'suppression must happen before hq dispatch');
  assert.equal(alertCalls.length, 1);
  assert.equal(alertCalls[0].opts.event, 'ama_closer.hammer_retry_cap_exhausted');
  const ledger = readHammerRetryCapLedger(rootDir, { repo: REPO, prNumber: PR_NUMBER });
  assert.equal(ledger.suppressed, true);
  assert.equal(ledger.suppressionState, HAMMER_RETRY_CAP_SUPPRESSION_STATE);
  assert.equal(ledger.alertedAt, '2026-07-06T12:00:00Z');
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

  assert.equal(result.reason, 'hammer-retry-cap-exhausted');
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

  assert.equal(first.reason, 'hammer-retry-cap-exhausted');
  assert.equal(second.reason, 'hammer-retry-cap-exhausted');
  assert.equal(alertCalls.length, 1, 'in-process debounce prevents re-page storms when ledger writes fail');
});
