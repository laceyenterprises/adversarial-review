// Hammer retry cap — hard single-retry ceiling per PR + fail-loud GBI alert.
//
// Regression cover for the 2026-07-05 incident: the AMA closer re-dispatched a
// terminal-remediation hammer on the SAME logical PR over and over (189 hammer
// worker dispatches in a day; #3116 ×10, #3120 ×7), burning the entire weekly
// Codex quota. The hammer remediated + moved the PR head but didn't close →
// stale-review-head → re-dispatch → repeat, unbounded. The per-head redispatch
// bound couldn't catch it because a hammer that moves the head creates a fresh
// per-head record (retryCount=0) — it reset its own counter every loop.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

import { maybeDispatchAmaCloser } from '../src/ama/dispatch-closer.mjs';
import {
  HAMMER_RETRY_CAP_SUPPRESSION_STATE,
  HAMMER_RETRY_CAP_TOTAL_DISPATCHES,
  evaluateHammerRetryCap,
  markHammerRetryCapExhausted,
  readHammerRetryCapLedger,
  recordHammerRetryDispatch,
} from '../src/ama/hammer-retry-cap.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const HAMMER_TEMPLATE_PATH = join(REPO_ROOT, 'templates', 'hammer-prompt.md');
const CURRENT_USER = userInfo().username || process.env.USER || process.env.LOGNAME || 'unknown';

const REPO = 'acme/myrepo';
const PR_NUMBER = 3116;
const REVIEWED_HEAD = 'a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0';

// ── module unit tests ────────────────────────────────────────────────────────

test('evaluateHammerRetryCap: same job key accumulates and caps at 2 total dispatches', () => {
  // No ledger yet → first dispatch is within cap.
  const first = evaluateHammerRetryCap(null, { jobKey: REVIEWED_HEAD, headSha: 'h1' });
  assert.equal(first.priorAttemptCount, 0);
  assert.equal(first.nextAttemptCount, 1);
  assert.equal(first.capExhausted, false);

  // One prior dispatch, SAME job key (a hammer moved the head, same reviewed
  // head) → second dispatch still within cap.
  const second = evaluateHammerRetryCap(
    { jobKey: REVIEWED_HEAD, attemptCount: 1 },
    { jobKey: REVIEWED_HEAD, headSha: 'h2' },
  );
  assert.equal(second.priorAttemptCount, 1);
  assert.equal(second.nextAttemptCount, 2);
  assert.equal(second.capExhausted, false);

  // Two prior dispatches, SAME job key → the third would exceed the cap.
  const third = evaluateHammerRetryCap(
    { jobKey: REVIEWED_HEAD, attemptCount: 2 },
    { jobKey: REVIEWED_HEAD, headSha: 'h3' },
  );
  assert.equal(third.nextAttemptCount, 3);
  assert.equal(third.capExhausted, true);
  assert.equal(HAMMER_RETRY_CAP_TOTAL_DISPATCHES, 2);
});

test('evaluateHammerRetryCap: a fresh review head (new job key) resets the counter', () => {
  const decision = evaluateHammerRetryCap(
    { jobKey: REVIEWED_HEAD, attemptCount: 2, suppressed: true },
    { jobKey: 'b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1', headSha: 'newhead' },
  );
  assert.equal(decision.jobKeyChanged, true);
  assert.equal(decision.priorAttemptCount, 0, 'fresh review head resets the count');
  assert.equal(decision.alreadySuppressed, false, 'a new job key clears the prior suppression');
  assert.equal(decision.capExhausted, false);
});

test('evaluateHammerRetryCap: already-suppressed same series stays capped', () => {
  const decision = evaluateHammerRetryCap(
    { jobKey: REVIEWED_HEAD, attemptCount: 2, suppressed: true, alertedAt: '2026-07-05T00:00:00Z' },
    { jobKey: REVIEWED_HEAD, headSha: 'churned-head' },
  );
  assert.equal(decision.alreadySuppressed, true);
  assert.equal(decision.capExhausted, true);
  assert.equal(decision.alertAlreadyEmitted, true, 'a prior alert is not re-fired');
});

test('recordHammerRetryDispatch + markHammerRetryCapExhausted round-trip on disk', (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hammer-cap-unit-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const identity = { repo: REPO, prNumber: PR_NUMBER };

  const afterFirst = recordHammerRetryDispatch(rootDir, identity, {
    jobKey: REVIEWED_HEAD, headSha: 'h1', now: '2026-07-05T00:00:00Z',
  });
  assert.equal(afterFirst.attemptCount, 1);
  assert.deepEqual(afterFirst.dispatchHeads, ['h1']);

  const afterSecond = recordHammerRetryDispatch(rootDir, identity, {
    jobKey: REVIEWED_HEAD, headSha: 'h2', now: '2026-07-05T00:05:00Z',
  });
  assert.equal(afterSecond.attemptCount, 2, 'same job key accumulates across head moves');
  assert.deepEqual(afterSecond.dispatchHeads, ['h1', 'h2']);

  const suppressed = markHammerRetryCapExhausted(rootDir, identity, {
    jobKey: REVIEWED_HEAD, headSha: 'h3', attemptCount: 2, alertEmitted: true, now: '2026-07-05T00:10:00Z',
  });
  assert.equal(suppressed.suppressed, true);
  assert.equal(suppressed.suppressionState, HAMMER_RETRY_CAP_SUPPRESSION_STATE);
  assert.equal(suppressed.alertedAt, '2026-07-05T00:10:00Z');

  const reloaded = readHammerRetryCapLedger(rootDir, identity);
  assert.equal(reloaded.suppressed, true);
  assert.equal(reloaded.suppressedJobKey, REVIEWED_HEAD);

  // A fresh review head clears the suppression via a new dispatch.
  const reset = recordHammerRetryDispatch(rootDir, identity, {
    jobKey: 'c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1', headSha: 'fresh', now: '2026-07-05T01:00:00Z',
  });
  assert.equal(reset.attemptCount, 1);
  assert.equal(reset.suppressed, false);
  assert.deepEqual(reset.dispatchHeads, ['fresh']);
});

test('recordHammerRetryDispatch preserves the existing job key when incoming job key is missing', (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hammer-cap-anchor-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const identity = { repo: REPO, prNumber: PR_NUMBER };

  recordHammerRetryDispatch(rootDir, identity, {
    jobKey: REVIEWED_HEAD,
    headSha: 'anchor-h1',
    now: '2026-07-05T00:00:00Z',
  });
  const afterMissingJobKey = recordHammerRetryDispatch(rootDir, identity, {
    jobKey: null,
    headSha: 'anchor-h2',
    now: '2026-07-05T00:05:00Z',
  });

  assert.equal(afterMissingJobKey.jobKey, REVIEWED_HEAD);
  assert.equal(afterMissingJobKey.attemptCount, 2);
  assert.deepEqual(afterMissingJobKey.dispatchHeads, ['anchor-h1', 'anchor-h2']);
});

// ── integration through maybeDispatchAmaCloser ───────────────────────────────

/**
 * A hammer terminal-remediation dispatch fixture. `currentHead` is the live PR
 * head (which a hammer moves each loop); `reviewedHead` is the STABLE posted
 * review head (the stale-review job key). Blocking findings + reviewCycleExhausted
 * make the PR ineligible so the auto-hammer terminal-remediation lane fires.
 */
function hammerFixture({ rootDir, reviewedHead = REVIEWED_HEAD, currentHead }) {
  const hqRoot = join(rootDir, 'hq-root');
  const reviewState = {
    verdict: 'request-changes',
    headSha: reviewedHead,
    riskClass: 'medium',
    remediationPending: true,
    reviewCycleExhausted: true,
    blockingFindingState: 'known',
    blockingFindingCount: 1,
    nonBlockingFindingState: 'known',
    nonBlockingFindingCount: 0,
    operatorApprovedEvidence: null,
    prAuthor: 'codex-worker-bot',
  };
  const prMetadata = {
    prNumber: PR_NUMBER,
    headSha: currentHead,
    isOpen: true,
    isDraft: false,
    mergeableState: 'MERGEABLE',
    labels: [],
    statusCheckRollup: [
      { __typename: 'CheckRun', name: 'lint', conclusion: 'SUCCESS' },
      { __typename: 'CheckRun', name: 'test', conclusion: 'SUCCESS' },
    ],
    branchProtection: { requiredContexts: ['agent-os/adversarial-gate'] },
    author: 'codex-worker-bot',
  };
  const cfg = {
    enabled: true,
    workerClass: 'hammer',
    autoHammerOnEligibilityMiss: true,
    mergeMethod: 'squash',
    eligibility: { riskClasses: ['low', 'medium'], fastMergeLabels: [] },
    branchProtection: {},
  };
  const dispatchContext = {
    repo: REPO,
    prUrl: `https://github.com/acme/myrepo/pull/${PR_NUMBER}`,
    reviewedSha: reviewedHead,
    riskClass: 'medium',
    requiredGateContext: 'agent-os/adversarial-gate',
    reviewedBy: 'claude-reviewer-lacey',
    reviewer: 'claude',
    parentSession: 'session:test:watcher',
    hqProject: 'adversarial-merge-authority',
    hqPath: '/bin/true-stub-hq',
    hqRoot,
    hqOwnerUser: CURRENT_USER,
    currentUser: CURRENT_USER,
    rootDir,
    dispatchedAt: '2026-07-05T20:00:00Z',
  };
  return { reviewState, prMetadata, cfg, dispatchContext };
}

function buildDispatchExecMock() {
  const calls = [];
  const impl = async (_cmd, args) => {
    calls.push(args);
    if (args[0] === 'dispatch' && args[1] === 'status') {
      return { stdout: '{"status":"failed"}', stderr: '' };
    }
    if (args[0] === 'dispatch') {
      return { stdout: 'dispatchId=lrq_hammer_loop\n', stderr: '' };
    }
    // worker tear-down and anything else: succeed quietly.
    return { stdout: '', stderr: '' };
  };
  const launches = () => calls.filter((args) => args[0] === 'dispatch' && args[1] !== 'status');
  return { impl, calls, launches };
}

const NO_MERGE_SIGNAL = {
  readBuildCompletionSignalForPrImpl: () => ({ ok: false, reason: 'sqlite-read-failed' }),
  readBuildCompletionProducerEvidenceImpl: () => ({ ok: false, reason: 'missing-build-completion-producer-evidence' }),
};

// The closer lease is keyed on the STABLE reviewed head; in production a
// non-succeeded terminal audit releases it between loop iterations. Simulate that
// release so the test exercises the per-PR cap (not the per-head lease).
function releaseCloserLeases(rootDir) {
  rmSync(join(rootDir, 'data', 'ama-closer-leases'), { recursive: true, force: true });
}

test('hammer that fails to close twice → exactly 2 dispatches, then GBI alert + suppression, no 3rd', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hammer-cap-loop-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const exec = buildDispatchExecMock();
  const alerts = [];
  const deliverAlertImpl = async (text, opts) => { alerts.push({ text, opts }); };
  const readTemplateImpl = () => readFileSync(HAMMER_TEMPLATE_PATH, 'utf8');

  // Loop 1: initial hammer against the human head.
  const r1 = await maybeDispatchAmaCloser({
    ...hammerFixture({ rootDir, currentHead: 'head-1111111111111111111111111111111111111' }),
    execFileImpl: exec.impl,
    readTemplateImpl,
    deliverAlertImpl,
    ...NO_MERGE_SIGNAL,
  });
  assert.equal(r1.dispatched, true, 'first hammer dispatches');
  releaseCloserLeases(rootDir);

  // Loop 2: the hammer moved the head (head-1 → head-2) but didn't close. The
  // reviewed head is unchanged (stale-review). This is the #3116 loop shape.
  const r2 = await maybeDispatchAmaCloser({
    ...hammerFixture({ rootDir, currentHead: 'head-2222222222222222222222222222222222222' }),
    execFileImpl: exec.impl,
    readTemplateImpl,
    deliverAlertImpl,
    ...NO_MERGE_SIGNAL,
  });
  assert.equal(r2.dispatched, true, 'the one allowed retry dispatches');
  releaseCloserLeases(rootDir);

  // Loop 3: the hammer moved the head again (head-2 → head-3). The cap is now
  // exhausted → NO 3rd dispatch; fail loud + suppress.
  const r3 = await maybeDispatchAmaCloser({
    ...hammerFixture({ rootDir, currentHead: 'head-3333333333333333333333333333333333333' }),
    execFileImpl: exec.impl,
    readTemplateImpl,
    deliverAlertImpl,
    ...NO_MERGE_SIGNAL,
  });

  assert.equal(r3.dispatched, false, 'the 3rd hammer is suppressed');
  assert.equal(r3.reason, 'hammer-retry-cap-exhausted');
  assert.equal(r3.needsOperator, true);
  assert.equal(r3.skipMergeAgent, true, 'suppression stops merge-agent fallback too');
  assert.equal(r3.suppressionState, HAMMER_RETRY_CAP_SUPPRESSION_STATE);

  // Exactly 2 hammer launches occurred — the 3rd was blocked before any exec.
  assert.equal(exec.launches().length, 2, 'exactly 2 hammer dispatches, no 3rd');

  // A single GBI alert fired, naming the repo + PR + head + attempt count.
  assert.equal(alerts.length, 1, 'exactly one operator alert');
  const alert = alerts[0];
  assert.equal(alert.opts.event, 'ama_closer.hammer_retry_cap_exhausted');
  assert.equal(alert.opts.payload.repo, REPO);
  assert.equal(alert.opts.payload.prNumber, PR_NUMBER);
  assert.equal(alert.opts.payload.headSha, 'head-3333333333333333333333333333333333333');
  assert.equal(alert.opts.payload.attemptCount, 2);
  assert.match(alert.text, new RegExp(`${REPO}#${PR_NUMBER}`));
  assert.match(alert.text, /suppressed to protect quota/);

  // The PR is durably in the suppression state.
  const ledger = readHammerRetryCapLedger(rootDir, { repo: REPO, prNumber: PR_NUMBER });
  assert.equal(ledger.suppressed, true);
  assert.equal(ledger.suppressionState, HAMMER_RETRY_CAP_SUPPRESSION_STATE);
  assert.equal(ledger.attemptCount, 2);

  // A 4th tick (still churning head, same stale review) does NOT re-dispatch and
  // does NOT re-alert (debounced by the suppression ledger).
  const r4 = await maybeDispatchAmaCloser({
    ...hammerFixture({ rootDir, currentHead: 'head-4444444444444444444444444444444444444' }),
    execFileImpl: exec.impl,
    readTemplateImpl,
    deliverAlertImpl,
    ...NO_MERGE_SIGNAL,
  });
  assert.equal(r4.dispatched, false);
  assert.equal(r4.reason, 'hammer-retry-cap-exhausted');
  assert.equal(exec.launches().length, 2, 'still exactly 2 launches');
  assert.equal(alerts.length, 1, 'no re-alert while suppressed');
});

test('cap-exhausted hammer dispatch asserts owner before mutating suppression ledger', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hammer-cap-owner-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const identity = { repo: REPO, prNumber: PR_NUMBER };
  const exec = buildDispatchExecMock();
  const alerts = [];
  const deliverAlertImpl = async (text, opts) => { alerts.push({ text, opts }); };

  recordHammerRetryDispatch(rootDir, identity, {
    jobKey: REVIEWED_HEAD,
    headSha: 'owner-h1',
    now: '2026-07-05T00:00:00Z',
  });
  recordHammerRetryDispatch(rootDir, identity, {
    jobKey: REVIEWED_HEAD,
    headSha: 'owner-h2',
    now: '2026-07-05T00:05:00Z',
  });

  const fixture = hammerFixture({ rootDir, currentHead: 'owner-h3' });
  await assert.rejects(
    () => maybeDispatchAmaCloser({
      ...fixture,
      dispatchContext: {
        ...fixture.dispatchContext,
        hqOwnerUser: `${CURRENT_USER}-different`,
        currentUser: CURRENT_USER,
      },
      execFileImpl: exec.impl,
      readTemplateImpl: () => readFileSync(HAMMER_TEMPLATE_PATH, 'utf8'),
      deliverAlertImpl,
      ...NO_MERGE_SIGNAL,
    }),
    /does not match HQ ownerUser/,
  );

  const ledger = readHammerRetryCapLedger(rootDir, identity);
  assert.equal(ledger.suppressed, false, 'owner mismatch failed before suppression write');
  assert.equal(ledger.attemptCount, 2, 'attempt count was not modified');
  assert.equal(ledger.jobKey, REVIEWED_HEAD, 'job key anchor was preserved');
  assert.equal(alerts.length, 0, 'owner mismatch failed before alert delivery');
  assert.equal(exec.launches().length, 0, 'owner mismatch failed before dispatch exec');
});

test('a hammer-authored head move does NOT reset the counter', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hammer-cap-nomove-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const exec = buildDispatchExecMock();
  const readTemplateImpl = () => readFileSync(HAMMER_TEMPLATE_PATH, 'utf8');
  const alerts = [];
  const deliverAlertImpl = async (text, opts) => { alerts.push({ text, opts }); };

  // Two dispatches against the SAME reviewed head but two DIFFERENT PR heads
  // (the hammer moved the head between them).
  await maybeDispatchAmaCloser({
    ...hammerFixture({ rootDir, currentHead: 'move-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }),
    execFileImpl: exec.impl, readTemplateImpl, deliverAlertImpl, ...NO_MERGE_SIGNAL,
  });
  releaseCloserLeases(rootDir);
  await maybeDispatchAmaCloser({
    ...hammerFixture({ rootDir, currentHead: 'move-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }),
    execFileImpl: exec.impl, readTemplateImpl, deliverAlertImpl, ...NO_MERGE_SIGNAL,
  });
  releaseCloserLeases(rootDir);

  const ledger = readHammerRetryCapLedger(rootDir, { repo: REPO, prNumber: PR_NUMBER });
  assert.equal(ledger.attemptCount, 2, 'head move under the same reviewed head did not reset the counter');
  assert.deepEqual(
    ledger.dispatchHeads,
    ['move-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'move-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
  );
});

test('a genuinely fresh non-hammer review head resets the counter and re-enables dispatch', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hammer-cap-reset-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const exec = buildDispatchExecMock();
  const readTemplateImpl = () => readFileSync(HAMMER_TEMPLATE_PATH, 'utf8');
  const alerts = [];
  const deliverAlertImpl = async (text, opts) => { alerts.push({ text, opts }); };

  // Burn both dispatches against reviewed head R1, then hit the cap.
  for (const head of ['r1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'r1-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb']) {
    await maybeDispatchAmaCloser({
      ...hammerFixture({ rootDir, reviewedHead: REVIEWED_HEAD, currentHead: head }),
      execFileImpl: exec.impl, readTemplateImpl, deliverAlertImpl, ...NO_MERGE_SIGNAL,
    });
    releaseCloserLeases(rootDir);
  }
  const capped = await maybeDispatchAmaCloser({
    ...hammerFixture({ rootDir, reviewedHead: REVIEWED_HEAD, currentHead: 'r1-cccccccccccccccccccccccccccccccccccccc' }),
    execFileImpl: exec.impl, readTemplateImpl, deliverAlertImpl, ...NO_MERGE_SIGNAL,
  });
  assert.equal(capped.dispatched, false, 'cap reached on reviewed head R1');
  assert.equal(exec.launches().length, 2);
  releaseCloserLeases(rootDir);

  // A genuinely fresh review posts against a NEW reviewed head R2 (a human push
  // earned a new adversarial review). The counter resets and dispatch resumes.
  const freshReviewedHead = 'd2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2';
  const afterFresh = await maybeDispatchAmaCloser({
    ...hammerFixture({ rootDir, reviewedHead: freshReviewedHead, currentHead: 'r2-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }),
    execFileImpl: exec.impl, readTemplateImpl, deliverAlertImpl, ...NO_MERGE_SIGNAL,
  });
  assert.equal(afterFresh.dispatched, true, 'fresh review head resets the cap → dispatch resumes');
  assert.equal(exec.launches().length, 3, 'the reset produced a genuine new dispatch');

  const ledger = readHammerRetryCapLedger(rootDir, { repo: REPO, prNumber: PR_NUMBER });
  assert.equal(ledger.attemptCount, 1, 'counter reset to 1 for the new review series');
  assert.equal(ledger.suppressed, false, 'suppression cleared by the fresh review head');
  assert.equal(ledger.jobKey, freshReviewedHead);
});

test('the alert path fails open: transport down still suppresses + never crashes the closer', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hammer-cap-failopen-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const exec = buildDispatchExecMock();
  const readTemplateImpl = () => readFileSync(HAMMER_TEMPLATE_PATH, 'utf8');
  // Alert transport is down — every delivery throws.
  const deliverAlertImpl = async () => { throw new Error('alert-bus unreachable'); };
  const errorLogs = [];
  const logger = {
    error(line) { errorLogs.push(line); },
    info() {}, warn() {}, log() {},
  };

  for (const head of ['fo-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'fo-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb']) {
    await maybeDispatchAmaCloser({
      ...hammerFixture({ rootDir, currentHead: head }),
      execFileImpl: exec.impl, readTemplateImpl, deliverAlertImpl, logger, ...NO_MERGE_SIGNAL,
    });
    releaseCloserLeases(rootDir);
  }

  // The cap-exhausting tick must NOT throw even though the alert transport is down.
  let result;
  await assert.doesNotReject(async () => {
    result = await maybeDispatchAmaCloser({
      ...hammerFixture({ rootDir, currentHead: 'fo-cccccccccccccccccccccccccccccccccccccc' }),
      execFileImpl: exec.impl, readTemplateImpl, deliverAlertImpl, logger, ...NO_MERGE_SIGNAL,
    });
  });
  assert.equal(result.dispatched, false);
  assert.equal(result.reason, 'hammer-retry-cap-exhausted');
  assert.equal(result.alertEmitted, false, 'alert did not go out');

  // Suppression still landed despite the failed alert.
  const ledger = readHammerRetryCapLedger(rootDir, { repo: REPO, prNumber: PR_NUMBER });
  assert.equal(ledger.suppressed, true);
  assert.equal(ledger.suppressionState, HAMMER_RETRY_CAP_SUPPRESSION_STATE);
  assert.equal(ledger.alertedAt, null, 'ledger records the alert did NOT succeed (so a later tick retries)');

  // The failure was logged, not swallowed silently.
  assert.ok(
    errorLogs.some((line) => String(line).includes('hammer_retry_cap_alert_failed')),
    'the alert failure is logged',
  );
});
