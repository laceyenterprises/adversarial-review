// NOOWNER-01 (SEV1): a PR whose hammer cannot launch or has stopped never sits
// without an owner. Each case is built from the 2026-10-10 watcher log lines
// quoted in the ticket; every test here fails on the pre-NOOWNER-01 main.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';

import { primaryChangeFixture } from './helpers/primary-change.mjs';
import {
  __testables__,
  maybeDispatchAmaCloser,
  readAmaCloserDispatchRecord,
  updateAmaCloserDispatchRecord,
} from '../src/ama/dispatch-closer.mjs';
import { amaAuditFilePath, readAmaAuditEntry, writeAmaAuditEntry } from '../src/ama/audit.mjs';
import {
  _resetPrelaunchRefusalPageDebounceForTests,
  PRELAUNCH_REFUSAL_SLOW_RETRY_WINDOW_MS,
} from '../src/ama/prelaunch-refusal-retry.mjs';
import {
  _resetHammerStopHoldPageDebounceForTests,
  changedHammerStopInputs,
  evaluateHammerStopHold,
  hammerStopInputs,
  hammerStopPrIsConflicting,
  HAMMER_STOP_HOLD_REASON,
  readHammerStopForHead,
} from '../src/ama/hammer-stop-hold.mjs';
import { recordHammerRetryDispatch } from '../src/ama/hammer-retry-cap.mjs';
import { recoverAmaAutomation } from '../src/ama/automated-recovery.mjs';
import {
  closerHeadRereviewDeclinedReason,
  declineSuppressedAmaRecoveryRereview,
} from '../src/closer-head-rereview-decline.mjs';
import { tryRetriggerRemediationFromLabel } from '../src/follow-up-retrigger-label.mjs';
import { handOffRetriggerWithoutJob } from '../src/retrigger-no-job-handoff.mjs';
import { findLatestFollowUpJob } from '../src/operator-retrigger-helpers.mjs';
import { ensureReviewStateSchema } from '../src/review-state.mjs';
import { REREVIEW_CI_BLOCKED_STATUS } from '../src/review-statuses.mjs';

const CURRENT_USER = userInfo().username || process.env.USER || 'unknown';
const SILENT = { log() {}, info() {}, warn() {}, error() {} };

function tmpRoot(t, prefix) {
  const rootDir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  return rootDir;
}

function closerArgs(rootDir, { repo, prNumber, reviewedSha, headSha, reviewState = {}, prMetadata = {}, dispatchContext = {} }) {
  return {
    reviewState: {
      verdict: 'comment-only',
      headSha: reviewedSha,
      riskClass: 'low',
      remediationPending: false,
      blockingFindingState: 'known',
      blockingFindingCount: 0,
      nonBlockingFindingState: 'known',
      nonBlockingFindingCount: 0,
      operatorApprovedEvidence: null,
      prAuthor: 'builder',
      ...reviewState,
    },
    prMetadata: {
      prNumber,
      title: 'fixture',
      headSha,
      isOpen: true,
      isDraft: false,
      mergeableState: 'MERGEABLE',
      labels: [],
      statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }],
      branchProtection: { requiredContexts: [] },
      author: 'builder',
      ...prMetadata,
    },
    cfg: {
      enabled: true,
      workerClass: 'hammer',
      mergeMethod: 'squash',
      eligibility: { riskClasses: ['low'], highRiskRequiresTwoKey: false },
      branchProtection: { required: false },
    },
    dispatchContext: {
      rootDir,
      repo,
      prUrl: `https://github.com/${repo}/pull/${prNumber}`,
      reviewedSha,
      targetRemediationSha: headSha,
      dispatchRecordHeadSha: headSha,
      riskClass: 'low',
      requiredGateContext: 'agent-os/adversarial-gate',
      reviewedBy: 'codex-reviewer-lacey',
      reviewer: 'codex',
      parentSession: 'session:test:watcher',
      hqPath: '/bin/hq-test',
      hqRoot: join(rootDir, 'hq-root'),
      hqOwnerUser: CURRENT_USER,
      currentUser: CURRENT_USER,
      closerTokenRollupPollDelaysMs: [],
      livePrProbeImpl: async () => ({ state: 'OPEN', headBranchExists: true, headRefName: 'feature/x' }),
      ...dispatchContext,
    },
  };
}

function closerDeps({ dispatch, alerts = [], status = null } = {}) {
  const execCalls = [];
  return {
    execCalls,
    alerts,
    fetchPrimaryChangeImpl: async ({ headSha }) => primaryChangeFixture(headSha),
    execFileImpl: async (cmd, args) => {
      execCalls.push({ cmd, args });
      if (args[0] === 'dispatch' && args[1] === 'status') {
        return { stdout: JSON.stringify(status || { status: 'running' }), stderr: '' };
      }
      if (dispatch) return dispatch(cmd, args);
      return { stdout: JSON.stringify({ dispatchId: 'dispatch_hammer', launchRequestId: 'lrq_hammer' }), stderr: '' };
    },
    readLaunchRequestStatusImpl: () => ({ ok: false, reason: 'missing-launch-request-row' }),
    readTemplateImpl: () => 'hammer prompt <<PR_URL>> <<REVIEWED_SHA>> <<TARGET_REMEDIATION_SHA>> <<AMA_TRAILERS>>',
    writeFileImpl: () => {},
    resolveCloserDispatchHarnessImpl: async ({ workerClass }) => ({ workerClass, fellBack: false }),
    readBuildCompletionSignalForPrImpl: () => ({ ok: false, reason: 'missing-build-completion-signal' }),
    readBuildCompletionProducerEvidenceImpl: () => ({ ok: false, reason: 'missing-build-completion-producer-evidence' }),
    fetchPullRequestRollupImpl: async () => ({ state: 'OPEN', comments: [] }),
    deliverAlertImpl: async (text, options) => { alerts.push({ text, options }); },
    logger: SILENT,
  };
}

const hqLaunches = (deps) => deps.execCalls.filter((call) => call.args[0] === 'dispatch' && call.args[1] !== 'status');

function minutesAfter(iso, minutes) {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ── Case 1 ──────────────────────────────────────────────────────────────────
// agent-os PR 7997: provisioning refusal at 18:27, then `dispatch-retry-exhausted`.
// HAMHOLDER-01 deployed by 20:34; at 20:39 the watcher still refused without trying:
//   [watcher] AMA hammer background dispatch settled for laceyenterprises/agent-os#7997@7de4ca99…:
//   dispatched=false reason=dispatch-retry-exhausted elapsed_ms=543
const AOS = 'laceyenterprises/agent-os';
const HEAD_7997 = '7de4ca99c03720ab7968a58f8761d34aa3287248';
const HAM_ADOPT_REFUSAL = "[hq] error: hammer close branch-holder resolution refused or did not free branch "
  + "'codex-7997/LAC-7997' at /Users/airlock/agent-os-hq/workers/codex-7997/agent-os; inspect the HAM-ADOPT-01 audit record";

function seedRefusedRecord(rootDir, { repo, prNumber, headSha, lastError, retryCount = 2, at }) {
  updateAmaCloserDispatchRecord(rootDir, { repo, prNumber, headSha }, () => ({
    schemaVersion: 1,
    repo,
    prNumber,
    headSha,
    reviewedSha: headSha,
    targetRemediationSha: headSha,
    workerClass: 'hammer',
    dispatchWorkerClass: 'hammer',
    retryCount,
    branchHolderBlockCount: 0,
    state: 'dispatch-failed',
    lastAttemptedAt: at,
    lastObservedAt: null,
    dispatchedAt: null,
    dispatchId: null,
    launchRequestId: null,
    lastFailureTransient: false,
    lastError,
  }));
}

test('Case 1: the HAM-ADOPT-01 provisioning refusal is a branch-holder block, not a spent dispatch', () => {
  assert.equal(__testables__.isProvisionBranchHolderBlocked(`code: 1\nstderr: ${HAM_ADOPT_REFUSAL}`), true);
  assert.equal(__testables__.isProvisionBranchHolderBlocked(
    "stderr: [hq] error: hammer close could not provision a private branch for 'feature/x' while /w/agent-os holds it; inspect the HAM-ADOPT-01 audit record",
  ), true);
  assert.equal(__testables__.isProvisionBranchHolderBlocked('stderr: [hq] error: unrelated provision failure'), false);
});

test('Case 1: PR 7997 exhausted by the HAM-ADOPT-01 refusal re-dispatches once hq accepts, without an operator relabel', async (t) => {
  _resetPrelaunchRefusalPageDebounceForTests();
  const rootDir = tmpRoot(t, 'noowner-case1-');
  seedRefusedRecord(rootDir, {
    repo: AOS, prNumber: 7997, headSha: HEAD_7997, at: '2026-10-10T18:27:00Z',
    lastError: `code: 1\nmessage: Command failed: hq dispatch\nstderr: ${HAM_ADOPT_REFUSAL}`,
  });
  const deps = closerDeps();
  const result = await maybeDispatchAmaCloser({
    ...closerArgs(rootDir, {
      repo: AOS, prNumber: 7997, reviewedSha: HEAD_7997, headSha: HEAD_7997,
      dispatchContext: { dispatchedAt: '2026-10-10T20:39:00Z' },
    }),
    ...deps,
  });
  assert.notEqual(result.reason, 'dispatch-retry-exhausted');
  assert.equal(result.dispatched, true, JSON.stringify(result));
  assert.equal(hqLaunches(deps).length, 1);
});

test('Case 1: a pre-launch refusal keeps a slow bounded cadence, pages once with the refusal, and pages at the bound', async (t) => {
  _resetPrelaunchRefusalPageDebounceForTests();
  const rootDir = tmpRoot(t, 'noowner-case1-slow-');
  const refusal = '[hq] dispatch refused: admission: worker class hammer is not dispatchable (auth: oauth provider not servable)';
  const exhaustedAt = '2026-10-10T18:30:00Z';
  seedRefusedRecord(rootDir, {
    repo: AOS, prNumber: 8025, headSha: HEAD_7997, at: exhaustedAt,
    lastError: `code: 1\nmessage: Command failed: hq dispatch\nstderr: ${refusal}`,
  });
  const alerts = [];
  const refuse = async () => {
    const err = new Error('Command failed: hq dispatch');
    err.code = 1;
    err.stderr = refusal;
    throw err;
  };
  const tick = async (at) => {
    const deps = closerDeps({ dispatch: refuse, alerts });
    const result = await maybeDispatchAmaCloser({
      ...closerArgs(rootDir, {
        repo: AOS, prNumber: 8025, reviewedSha: HEAD_7997, headSha: HEAD_7997,
        dispatchContext: { dispatchedAt: at },
      }),
      ...deps,
    });
    return { result, launches: hqLaunches(deps).length };
  };

  // Fast retries spent: the closer owns the PR on a bounded clock and pages once.
  const first = await tick(minutesAfter(exhaustedAt, 1));
  assert.equal(first.launches, 0);
  assert.equal(first.result.reason, 'dispatch-refusal-slow-retry-wait');
  assert.equal(first.result.recoveryWait, true);
  assert.equal(first.result.skipMergeAgent, true);
  assert.equal(alerts.length, 1);
  assert.ok(alerts[0].text.includes(refusal), alerts[0].text);
  assert.equal(alerts[0].options.event, 'ama_closer.prelaunch_refusal_slow_retry');

  const second = await tick(minutesAfter(exhaustedAt, 5));
  assert.equal(second.launches, 0);
  assert.equal(alerts.length, 1, 'the slow-cadence page is sent once');

  // One attempt per reclaim window (about 31 minutes).
  const due = await tick(minutesAfter(exhaustedAt, 40));
  assert.equal(due.launches, 1, 'a slow-cadence attempt is made once the reclaim window passes');
  const record = readAmaCloserDispatchRecord(rootDir, { repo: AOS, prNumber: 8025, headSha: HEAD_7997 });
  assert.equal(Date.parse(record.prelaunchRefusalSlowRetry.startedAt), Date.parse(minutesAfter(exhaustedAt, 1)),
    'a failed slow attempt keeps the original window start');
  const after = await tick(minutesAfter(exhaustedAt, 45));
  assert.equal(after.launches, 0, 'no hot loop after a slow attempt');
  assert.equal(alerts.length, 1);

  // The bound: retries stop when the window closes, and the operator is paged once more.
  const closed = minutesAfter(exhaustedAt, 1 + PRELAUNCH_REFUSAL_SLOW_RETRY_WINDOW_MS / 60_000 + 1);
  const bound = await tick(closed);
  assert.equal(bound.launches, 0);
  assert.equal(bound.result.reason, 'dispatch-retry-exhausted');
  assert.equal(alerts.length, 2);
  assert.equal(alerts[1].options.event, 'ama_closer.prelaunch_refusal_exhausted');
  assert.ok(alerts[1].text.includes(refusal), alerts[1].text);
  const later = await tick(minutesAfter(closed, 90));
  assert.equal(later.launches, 0);
  assert.equal(alerts.length, 2, 'the exhaustion page is sent once');
});

test('branch-holder slow retries retain the original window across counter resets and watcher restarts', async (t) => {
  _resetPrelaunchRefusalPageDebounceForTests();
  const rootDir = tmpRoot(t, 'noowner-holder-slow-');
  const identity = { repo: AOS, prNumber: 8025, headSha: HEAD_7997 };
  const exhaustedAt = '2026-10-10T18:30:00Z';
  seedRefusedRecord(rootDir, { ...identity, lastError: HAM_ADOPT_REFUSAL, at: exhaustedAt });
  updateAmaCloserDispatchRecord(rootDir, identity, (record) => ({
    ...record, branchHolderBlockCount: 3, state: 'dispatch-branch-holder-block-exhausted',
  }));
  const alerts = [];
  const tick = async (minutes) => {
    const deps = closerDeps({ alerts, dispatch: async () => {
      const err = new Error('Command failed: hq dispatch');
      err.code = 1;
      err.stderr = HAM_ADOPT_REFUSAL;
      throw err;
    } });
    const result = await maybeDispatchAmaCloser({
      ...closerArgs(rootDir, {
        ...identity, reviewedSha: HEAD_7997,
        dispatchContext: { dispatchedAt: minutesAfter(exhaustedAt, minutes) },
      }), ...deps,
    });
    return { result, launches: hqLaunches(deps).length };
  };
  assert.equal((await tick(1)).launches, 0);
  const start = minutesAfter(exhaustedAt, 1);
  for (const minutes of [40, 80, 120, 160, 200, 240, 280, 320, 360]) {
    assert.equal((await tick(minutes)).launches, 1, `one attempt at minute ${minutes}`);
    const record = readAmaCloserDispatchRecord(rootDir, identity);
    assert.equal(record.branchHolderBlockCount, 1, 'aged retry resets the holder counter');
    assert.equal(Date.parse(record.prelaunchRefusalSlowRetry.startedAt), Date.parse(start));
    assert.ok(record.prelaunchRefusalSlowRetry.pagedAt);
    _resetPrelaunchRefusalPageDebounceForTests();
    const wait = await tick(minutes + 1);
    assert.equal(wait.launches, 0, 'no fast retry after another refusal');
    assert.equal(wait.result.recoveryWait, true);
  }
  for (const minutes of [362, 450]) {
    const stopped = await tick(minutes);
    assert.equal(stopped.launches, 0);
    assert.equal(stopped.result.reason, 'dispatch-branch-holder-block-exhausted');
  }
  assert.deepEqual(alerts.map((alert) => alert.options.event), [
    'ama_closer.prelaunch_refusal_slow_retry', 'ama_closer.prelaunch_refusal_exhausted',
  ]);
});

// ── Case 4 ──────────────────────────────────────────────────────────────────
// podium PR 15: both hammer runs stopped at ci-not-green ("GitHub reports zero
// check runs, zero commit statuses"), then
//   [watcher] AMA enabled but not eligible for laceyenterprises/podium#15
//   (hammer-retry-cap-exhausted; reasons: hammer-retry-cap-exhausted); safety hold requires operator action
const PODIUM = 'laceyenterprises/podium';
const PODIUM_REVIEWED = '1a6685f654904faf8a2078b00484ba0c21c6c471';
const PODIUM_HEAD = '9a1372c80a343f999cdb49b45873c5d50130e67e';

// The fixture reviews the stopped head itself, so the closer reaches its
// ordinary hammer route exactly as it did before run 2. (Case 3 below covers a
// stop on a closer head whose review is stale.)
function podiumArgs(rootDir, { at, rollup = [], baseSha = 'base-0' }) {
  return closerArgs(rootDir, {
    repo: PODIUM, prNumber: 15, reviewedSha: PODIUM_HEAD, headSha: PODIUM_HEAD,
    // Run 1 remediated the review's three non-blocking findings.
    prMetadata: { statusCheckRollup: rollup, baseSha },
    dispatchContext: { dispatchedAt: at },
  });
}

function recordPodiumStop(rootDir, at, { file = PODIUM_HEAD } = {}) {
  writeAmaAuditEntry({
    hqRoot: join(rootDir, 'hq-root'), repo: PODIUM, prNumber: 15, headSha: file, now: at,
    attempt: {
      outcome: 'failed-without-merge',
      reason: 'ci-not-green',
      head: PODIUM_HEAD,
      closingStatus: 'HAM closing status — no merge.',
      requiredChecks: { remoteCI: 'zero check runs and statuses; pending' },
    },
  });
}

test('hammer stop reader uses attempt provenance with an explicit legacy compatibility rule', () => {
  const stop = { outcome: 'failed-without-merge', reason: 'ci-not-green', validatedHead: PODIUM_HEAD };
  const read = (doc) => readHammerStopForHead({
    hqRoot: '/fixture', repo: PODIUM, prNumber: 15, headSha: PODIUM_HEAD,
    readAuditImpl: () => doc,
  });
  for (const path of ['daemon-merge', 'daemon-operator-approved-override', 'ham-terminal-remediation']) {
    assert.equal(read({ attempts: [{ ...stop, path, attemptPhase: 'daemon-failed' }] }), null);
  }
  assert.equal(read({ attempts: [stop] })?.predicate, 'ci-not-green', 'unattributed legacy hammer');
  assert.equal(read({ closureAuthority: 'ham-terminal-remediation', appendedRecords: [stop] })?.predicate, 'ci-not-green');
  assert.equal(read({ closureAuthority: 'daemon-merge', attempts: [stop] }), null, 'unmarked daemon-owned history');
  assert.equal(read({ attempts: [{ ...stop, attemptPhase: 'other-producer' }] }), null);
  const hammer = { ...stop, attemptPhase: 'hammer-gh-pr-merge', startedAt: '2026-10-10T18:00:00Z' };
  assert.equal(read({ closureAuthority: 'daemon-merge', attempts: [hammer] })?.predicate, 'ci-not-green',
    'explicit hammer provenance overrides document ownership');
  for (const outcome of ['failed-without-merge', 'deferred', 'succeeded']) {
    assert.equal(read({ attempts: [hammer, {
      ...stop, outcome, attemptPhase: 'daemon-failed', path: 'daemon-merge', startedAt: '2026-10-10T19:00:00Z',
    }] })?.predicate, 'ci-not-green', 'daemon attempts cannot set or clear a hammer stop');
  }
  assert.equal(read({ attempts: [hammer, {
    ...hammer, outcome: 'deferred', startedAt: '2026-10-10T19:00:00Z',
  }] }), null, 'a later hammer defer clears the stop');
});

test('daemon failure followed by capacity deferral does not hold the first repair hammer on the next dirty tick', async (t) => {
  const rootDir = tmpRoot(t, 'noowner-daemon-fallback-');
  writeAmaAuditEntry({
    hqRoot: join(rootDir, 'hq-root'), repo: PODIUM, prNumber: 15, headSha: PODIUM_HEAD,
    now: '2026-10-10T18:00:00Z', metadata: { closureAuthority: 'daemon-merge' },
    attempt: { outcome: 'failed-without-merge', reason: 'gate-not-eligible',
      validatedHead: PODIUM_HEAD, attemptPhase: 'daemon-failed', path: 'daemon-merge' },
  });
  const other = { repo: PODIUM, prNumber: 99, headSha: PODIUM_REVIEWED };
  updateAmaCloserDispatchRecord(rootDir, other, () => ({
    ...other, state: 'dispatched', launchRequestId: 'lrq_other', dispatchId: 'dispatch_other',
    lastAttemptedAt: '2026-10-10T18:00:00Z', dispatchedAt: '2026-10-10T18:00:00Z',
  }));
  const tick = async (at, forceHammerAfterDaemonFailure) => {
    const args = podiumArgs(rootDir, { at, rollup: [
      { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' },
    ] });
    args.cfg.amaCloserMaxConcurrentLaunches = 1;
    args.dispatchContext.forceHammerAfterDaemonFailure = forceHammerAfterDaemonFailure;
    const deps = closerDeps();
    deps.readLaunchRequestStatusImpl = () => ({ ok: true, status: 'running' });
    const result = await maybeDispatchAmaCloser({ ...args, ...deps });
    assert.equal(deps.alerts.length, 0, 'no false hammer-stop page');
    return { result, launches: hqLaunches(deps).length };
  };
  const deferred = await tick('2026-10-10T18:01:00Z', true);
  assert.equal(deferred.result.reason, 'ama-closer-launch-in-progress');
  assert.equal(deferred.launches, 0);
  updateAmaCloserDispatchRecord(rootDir, other, (record) => ({ ...record, state: 'completed' }));
  const retry = await tick('2026-10-10T18:02:00Z', false);
  assert.equal(retry.result.dispatched, true, JSON.stringify(retry.result));
  assert.equal(retry.launches, 1);
});

test('own StatusContext is ignored while a same-name external CheckRun releases the hold', async (t) => {
  const rootDir = tmpRoot(t, 'noowner-external-check-');
  recordPodiumStop(rootDir, '2026-10-10T18:00:00Z');
  const context = 'agent-os/adversarial-gate';
  const rollup = (external, own) => [
    { __typename: 'CheckRun', name: context, status: 'COMPLETED', conclusion: external, completedAt: '2026-10-10T18:00:00Z' },
    { __typename: 'StatusContext', context, state: own, createdAt: '2026-10-10T18:01:00Z' },
    { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' },
  ];
  const inputs = hammerStopInputs({ statusCheckRollup: rollup('FAILURE', 'SUCCESS') }, { excludeContexts: [context] });
  assert.match(inputs.checks, /agent-os\/adversarial-gate=FAILURE/);
  const tick = (at, external, own) => maybeDispatchAmaCloser({
    ...podiumArgs(rootDir, { at, rollup: rollup(external, own) }), ...closerDeps(),
  });
  assert.equal((await tick('2026-10-10T18:02:00Z', 'FAILURE', 'SUCCESS')).reason, HAMMER_STOP_HOLD_REASON);
  assert.equal((await tick('2026-10-10T18:03:00Z', 'FAILURE', 'FAILURE')).reason, HAMMER_STOP_HOLD_REASON);
  const released = await tick('2026-10-10T18:04:00Z', 'SUCCESS', 'FAILURE');
  assert.equal(released.dispatched, true, JSON.stringify(released));
});

test('hammer stop inputs recognize newly available readings but ignore missing current readings', () => {
  const known = { headSha: PODIUM_HEAD, baseSha: 'base-0', mergeability: 'MERGEABLE', checks: '' };
  for (const [field, label, different] of [
    ['headSha', 'head', PODIUM_REVIEWED],
    ['baseSha', 'base', 'base-1'],
    ['mergeability', 'mergeability', 'CONFLICTING'],
  ]) {
    for (const missing of [null, undefined]) {
      assert.deepEqual(changedHammerStopInputs({ ...known, [field]: missing }, known), [label],
        `${field}: recovery from a missing reading releases the hold`);
      assert.deepEqual(changedHammerStopInputs(known, { ...known, [field]: missing }), [],
        `${field}: a missing current reading is not evidence of change`);
      assert.deepEqual(changedHammerStopInputs({ ...known, [field]: missing }, { ...known, [field]: missing }), []);
    }
    assert.deepEqual(changedHammerStopInputs(known, { ...known, [field]: different }), [label]);
  }
  assert.deepEqual(changedHammerStopInputs(known, known), []);
});

test('Case 4: UNKNOWN mergeability keeps the stop hold until a known reading allows one re-dispatch', async (t) => {
  _resetHammerStopHoldPageDebounceForTests();
  const rootDir = tmpRoot(t, 'noowner-case4-unknown-');
  recordPodiumStop(rootDir, '2026-10-10T19:25:52Z');
  const alerts = [];
  const args = (at, mergeableState) => {
    const result = podiumArgs(rootDir, { at });
    result.prMetadata.mergeableState = mergeableState;
    return result;
  };
  for (const at of ['2026-10-10T19:36:00Z', '2026-10-10T19:40:00Z']) {
    const held = closerDeps({ alerts });
    const result = await maybeDispatchAmaCloser({ ...args(at, 'UNKNOWN'), ...held });
    assert.equal(result.reason, HAMMER_STOP_HOLD_REASON);
    assert.equal(hqLaunches(held).length, 0);
  }
  const statePath = join(rootDir, 'data', 'follow-up-jobs', 'hammer-stop-hold', 'laceyenterprises-podium-pr-15.json');
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).heads[PODIUM_HEAD].inputs.mergeability, null);

  const released = closerDeps({ alerts });
  const result = await maybeDispatchAmaCloser({ ...args('2026-10-10T20:00:00Z', 'MERGEABLE'), ...released });
  assert.equal(result.dispatched, true, JSON.stringify(result));
  assert.equal(hqLaunches(released).length, 1);
  assert.deepEqual(JSON.parse(readFileSync(statePath, 'utf8')).heads[PODIUM_HEAD].releasedBy, ['mergeability']);
  assert.equal(alerts.length, 1, 'recovery does not send another hold page');

  const again = closerDeps({ alerts });
  await maybeDispatchAmaCloser({ ...args('2026-10-10T20:01:00Z', 'MERGEABLE'), ...again });
  assert.equal(hqLaunches(again).length, 0, 'the ordinary dispatch guards prevent a duplicate launch');
});

test('Case 4: a second hammer run on podium#15 is not launched until an input changes, and the cap page names the predicate', async (t) => {
  _resetHammerStopHoldPageDebounceForTests();
  const rootDir = tmpRoot(t, 'noowner-case4-');
  // Run 1 (19:22-19:26) launched and stopped at ci-not-green on its own head.
  recordHammerRetryDispatch(rootDir, { repo: PODIUM, prNumber: 15 }, {
    jobKey: PODIUM_HEAD, headSha: PODIUM_HEAD, now: '2026-10-10T19:22:00Z',
  });
  recordPodiumStop(rootDir, '2026-10-10T19:25:52Z');
  const alerts = [];

  // 19:36: same head, same zero-check rollup, same base. No second run.
  const held = closerDeps({ alerts });
  const first = await maybeDispatchAmaCloser({ ...podiumArgs(rootDir, { at: '2026-10-10T19:36:37Z' }), ...held });
  assert.equal(hqLaunches(held).length, 0, 'the second run could not end differently; it must not launch');
  assert.equal(first.reason, HAMMER_STOP_HOLD_REASON, JSON.stringify(first));
  assert.equal(first.recoveryWait, true);
  assert.equal(first.reasons, undefined, 'no reasons: orphan recovery and automated recovery read a wait');
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].text, /ci-not-green/);
  const again = closerDeps({ alerts });
  await maybeDispatchAmaCloser({ ...podiumArgs(rootDir, { at: '2026-10-10T19:40:00Z' }), ...again });
  assert.equal(hqLaunches(again).length, 0);
  assert.equal(alerts.length, 1, 'the hold page is sent once per head');

  // CI appears on the head (PODIUMCI-01): an input changed, so run 2 launches.
  const ci = [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }];
  const released = closerDeps({ alerts });
  const second = await maybeDispatchAmaCloser({ ...podiumArgs(rootDir, { at: '2026-10-10T20:00:00Z', rollup: ci }), ...released });
  assert.equal(second.dispatched, true, JSON.stringify(second));

  // Run 2 also stops; when inputs change again the cap is reached and its page names the predicate.
  recordPodiumStop(rootDir, '2026-10-10T20:05:00Z');
  const capped = closerDeps({ alerts, status: { status: 'succeeded' } });
  let third;
  // The first released tick terminalizes run 2's lease; the next one meets the cap.
  for (const at of ['2026-10-10T20:30:00Z', '2026-10-10T20:31:00Z']) {
    third = await maybeDispatchAmaCloser({
      ...podiumArgs(rootDir, { at, rollup: ci, baseSha: 'base-1' }),
      ...capped,
    });
    if (third.reason !== 'stale-dispatched-lease-terminalized') break;
  }
  assert.equal(hqLaunches(capped).length, 0);
  assert.equal(third.reason, 'hammer-retry-cap-exhausted', JSON.stringify(third));
  assert.equal(third.hammerStopPredicate, 'ci-not-green');
  const capPage = alerts.find((alert) => alert.options.event === 'ama_closer.hammer_retry_cap_exhausted');
  assert.ok(capPage, JSON.stringify(alerts.map((alert) => alert.options.event)));
  assert.match(capPage.text, /Last hammer stop on head 9a1372c80a34: ci-not-green/);
});

test('Case 4: the stop is read from the reviewed head audit that names the stopped head, and a later defer clears it', (t) => {
  const rootDir = tmpRoot(t, 'noowner-case4-reader-');
  const hqRoot = join(rootDir, 'hq-root');
  // Run 1 on podium#15 recorded its stop on 1a6685f6's audit with `head: 9a1372c8`.
  recordPodiumStop(rootDir, '2026-10-10T19:25:52Z', { file: PODIUM_REVIEWED });
  const stop = readHammerStopForHead({ hqRoot, repo: PODIUM, prNumber: 15, headSha: PODIUM_HEAD, reviewedSha: PODIUM_REVIEWED });
  assert.equal(stop?.predicate, 'ci-not-green');
  assert.equal(readHammerStopForHead({ hqRoot, repo: PODIUM, prNumber: 15, headSha: PODIUM_REVIEWED, reviewedSha: PODIUM_REVIEWED }), null,
    'the reviewed head itself did not stop');
  writeAmaAuditEntry({
    hqRoot, repo: PODIUM, prNumber: 15, headSha: PODIUM_HEAD, now: '2026-10-10T19:30:00Z',
    attempt: { outcome: 'deferred', reason: 'required-checks-pending' },
  });
  assert.equal(readHammerStopForHead({ hqRoot, repo: PODIUM, prNumber: 15, headSha: PODIUM_HEAD, reviewedSha: PODIUM_REVIEWED }), null,
    'a later certified park is not a stop');
});

// ── Case 3 ──────────────────────────────────────────────────────────────────
// agent-os PR 8022: the hammer rebased, pushed closer head c9006987 and ended
// "HAM closing status — no merge" (a fix lives in another repository), then
//   AMA hammer background dispatch settled ...: dispatched=false reason=not-eligible
//   reasons=[stale-review-head,verdict-not-settled-success,blocking-findings-unknown,ci-not-green]
// and automated recovery asked for a re-review the watcher never spawns.
const REVIEWED_8022 = '84da9e4ebbb57b7712fb4c0452f146658ffce3f2';
const CLOSER_8022 = 'c9006987f6de962b8e42283edffb4c8682bfd1d2';

test('Case 3: after a hammer no-merge on its own closer head the closer holds and pages once, then re-dispatches when the base moves', async (t) => {
  _resetHammerStopHoldPageDebounceForTests();
  const rootDir = tmpRoot(t, 'noowner-case3-');
  writeAmaAuditEntry({
    hqRoot: join(rootDir, 'hq-root'), repo: AOS, prNumber: 8022, headSha: CLOSER_8022, now: '2026-10-10T18:28:31Z',
    attempt: {
      outcome: 'failed-without-merge',
      reason: 'unmerged-subrepo-parity-fix',
      reviewedHead: REVIEWED_8022,
      currentHead: CLOSER_8022,
      closingStatus: 'HAM closing status — no merge. The fix lives in laceyenterprises/podium PR 15.',
    },
  });
  const args = (at, baseSha) => closerArgs(rootDir, {
    repo: AOS, prNumber: 8022, reviewedSha: REVIEWED_8022, headSha: CLOSER_8022,
    reviewState: { verdict: 'comment-only' },
    prMetadata: {
      // 8022 was CONFLICTING on 2026-10-10; REMCONFLICT-01 never holds a
      // conflicting PR (the REMCONFLICT-01 cases below). This case pins the hold
      // for the non-conflict stop it still owns.
      mergeableState: 'MERGEABLE',
      baseSha,
      statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    },
    dispatchContext: { dispatchedAt: at, liveHeadCloserAuthored: true, dispatchRecordHeadSha: REVIEWED_8022 },
  });
  const alerts = [];
  const held = closerDeps({ alerts });
  const first = await maybeDispatchAmaCloser({ ...args('2026-10-10T18:36:00Z', '12badc0823fa'), ...held });
  assert.equal(first.reason, HAMMER_STOP_HOLD_REASON, JSON.stringify(first));
  assert.equal(first.recoveryWait, true);
  assert.equal(first.reasons, undefined);
  assert.equal(hqLaunches(held).length, 0);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].text, /unmerged-subrepo-parity-fix/);
  await maybeDispatchAmaCloser({ ...args('2026-10-10T20:39:00Z', '12badc0823fa'), ...closerDeps({ alerts }) });
  assert.equal(alerts.length, 1, 'one page, not one per tick');

  // The dependency merged and main moved: the hammer gets one more run on this head.
  const released = closerDeps({ alerts });
  const result = await maybeDispatchAmaCloser({ ...args('2026-10-10T21:00:00Z', 'ffee00112233'), ...released });
  assert.equal(result.dispatched, true, JSON.stringify(result));
  assert.equal(hqLaunches(released).length, 1);
});

// REMCONFLICT-01 (SEV1): on 2026-10-10 PR 8022 was CONFLICTING and sat in this
// hold. The only input change that helps a conflicting PR is a rebase, and the
// hold was stopping the hammer, which owns merge-conflict resolution.
test('REMCONFLICT-01: a CONFLICTING PR is never held; the closer re-dispatches the hammer without a hold page', async (t) => {
  _resetHammerStopHoldPageDebounceForTests();
  const rootDir = tmpRoot(t, 'remconflict-hold-');
  writeAmaAuditEntry({
    hqRoot: join(rootDir, 'hq-root'), repo: AOS, prNumber: 8022, headSha: CLOSER_8022, now: '2026-10-10T18:28:31Z',
    attempt: {
      outcome: 'failed-without-merge',
      reason: 'unmerged-subrepo-parity-fix',
      reviewedHead: REVIEWED_8022,
      currentHead: CLOSER_8022,
      closingStatus: 'HAM closing status — no merge. The fix lives in laceyenterprises/podium PR 15.',
    },
  });
  const alerts = [];
  const deps = closerDeps({ alerts });
  const result = await maybeDispatchAmaCloser({
    ...closerArgs(rootDir, {
      repo: AOS, prNumber: 8022, reviewedSha: REVIEWED_8022, headSha: CLOSER_8022,
      reviewState: { verdict: 'comment-only' },
      prMetadata: {
        mergeableState: 'CONFLICTING',
        baseSha: '12badc0823fa',
        statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      },
      dispatchContext: { dispatchedAt: '2026-10-10T20:39:00Z', liveHeadCloserAuthored: true, dispatchRecordHeadSha: REVIEWED_8022 },
    }),
    ...deps,
  });
  assert.notEqual(result.reason, HAMMER_STOP_HOLD_REASON, JSON.stringify(result));
  assert.equal(result.dispatched, true, JSON.stringify(result));
  assert.equal(hqLaunches(deps).length, 1, 'the conflict owner runs');
  assert.equal(alerts.filter((alert) => alert.options.event === 'ama_closer.hammer_stop_hold').length, 0,
    'no "no further hammer run" page for a stop the hammer can fix');
  const state = JSON.parse(readFileSync(
    join(rootDir, 'data', 'follow-up-jobs', 'hammer-stop-hold', 'laceyenterprises-agent-os-pr-8022.json'), 'utf8'));
  assert.deepEqual(state.heads[CLOSER_8022].releasedBy, ['conflicting']);
});

test('REMCONFLICT-01: the hold releases a conflicting stop (CONFLICTING or DIRTY) and still holds every non-conflict stop', async (t) => {
  const stopDoc = { attempts: [{ outcome: 'failed-without-merge', reason: 'ci-not-green', head: PODIUM_HEAD, startedAt: '2026-10-10T19:25:52Z' }] };
  const evaluate = (rootDir, prMetadata, now) => evaluateHammerStopHold({
    rootDir, hqRoot: '/fixture', repo: PODIUM, prNumber: 15, headSha: PODIUM_HEAD,
    prMetadata: { headSha: PODIUM_HEAD, baseSha: 'base-0', statusCheckRollup: [], ...prMetadata },
    readAuditImpl: () => stopDoc, logger: SILENT, now,
  });
  for (const mergeableState of ['MERGEABLE', 'UNKNOWN', 'BLOCKED', '']) {
    _resetHammerStopHoldPageDebounceForTests();
    const rootDir = tmpRoot(t, 'remconflict-hold-nonconflict-');
    assert.equal((await evaluate(rootDir, { mergeableState }, '2026-10-10T19:30:00Z')).action, 'hold', mergeableState);
    assert.equal((await evaluate(rootDir, { mergeableState }, '2026-10-10T19:40:00Z')).action, 'hold', `${mergeableState}: next tick`);
  }
  for (const prMetadata of [{ mergeableState: 'CONFLICTING' }, { mergeableState: 'DIRTY' }, { mergeable: 'CONFLICTING' }]) {
    const rootDir = tmpRoot(t, 'remconflict-hold-conflict-');
    const decision = await evaluate(rootDir, prMetadata, '2026-10-10T19:30:00Z');
    assert.equal(decision.action, 'release', JSON.stringify(prMetadata));
    assert.deepEqual(decision.changed, ['conflicting']);
  }
  // A hold armed while mergeable releases once the PR becomes conflicting.
  _resetHammerStopHoldPageDebounceForTests();
  const rootDir = tmpRoot(t, 'remconflict-hold-turns-');
  assert.equal((await evaluate(rootDir, { mergeableState: 'MERGEABLE' }, '2026-10-10T19:30:00Z')).action, 'hold');
  assert.equal((await evaluate(rootDir, { mergeableState: 'DIRTY' }, '2026-10-10T19:45:00Z')).action, 'release');
  assert.equal(hammerStopPrIsConflicting({ mergeableState: 'MERGEABLE', mergeStateStatus: 'BEHIND' }), false);
});

test('Case 3: a stale review on a worker-pushed head is not held; the exact-head re-review stays its owner', async (t) => {
  const rootDir = tmpRoot(t, 'noowner-case3-worker-head-');
  writeAmaAuditEntry({
    hqRoot: join(rootDir, 'hq-root'), repo: AOS, prNumber: 8022, headSha: CLOSER_8022, now: '2026-10-10T18:28:31Z',
    attempt: { outcome: 'failed-without-merge', reason: 'ci-not-green', currentHead: CLOSER_8022 },
  });
  const result = await maybeDispatchAmaCloser({
    ...closerArgs(rootDir, {
      repo: AOS, prNumber: 8022, reviewedSha: REVIEWED_8022, headSha: CLOSER_8022,
      dispatchContext: { dispatchedAt: '2026-10-10T18:36:00Z', liveHeadCloserAuthored: false },
    }),
    ...closerDeps(),
  });
  assert.notEqual(result.reason, HAMMER_STOP_HOLD_REASON);
});

function reviewDbWithPostedPass(t) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  ensureReviewStateSchema(db);
  db.prepare(`INSERT INTO reviewer_passes
    (repo, pr_number, attempt_number, reviewer_class, pass_kind, started_at, ended_at, status,
     head_sha, gh_comment_id, body_md, body_captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(AOS, 8022, 1, 'gemini', 'first-pass', '2026-10-10T18:00:00Z', '2026-10-10T18:10:00Z',
      'completed', REVIEWED_8022, 'IC_8022_review', '## Verdict\nComment only', '2026-10-10T18:10:00Z');
  return db;
}

test('Case 3: a suppressed AMA-recovery re-review is declined back to posted, and recovery does not ask again', async (t) => {
  const db = reviewDbWithPostedPass(t);
  // The row as the 18:36 re-arm left it: pending, posted_at and reviewer_head_sha cleared.
  db.prepare(`INSERT INTO reviewed_prs
      (repo, pr_number, reviewed_at, reviewer, pr_state, review_status, review_attempts,
       revision_ref, rereview_requested_at, rereview_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(AOS, 8022, '2026-10-10T18:10:00Z', 'gemini', 'open', 'pending', 0, CLOSER_8022,
      '2026-10-10T18:36:00Z', 'AMA automated recovery: stale-review-head');
  const row = db.prepare('SELECT * FROM reviewed_prs WHERE repo = ? AND pr_number = ?').get(AOS, 8022);
  const declined = declineSuppressedAmaRecoveryRereview({
    db, repoPath: AOS, prNumber: 8022, reviewRow: row, headSha: CLOSER_8022,
    reviewedHeadSha: REVIEWED_8022, suppressionReason: 'closer-commit-trailer', logger: SILENT,
  });
  assert.equal(declined.declined, true);
  const restored = db.prepare('SELECT * FROM reviewed_prs WHERE repo = ? AND pr_number = ?').get(AOS, 8022);
  assert.equal(restored.review_status, 'posted');
  assert.equal(restored.reviewer_head_sha, REVIEWED_8022);
  assert.ok(restored.posted_at);
  assert.equal(restored.rereview_requested_at, null);
  assert.equal(restored.rereview_reason, closerHeadRereviewDeclinedReason(CLOSER_8022));

  const rootDir = tmpRoot(t, 'noowner-case3-recovery-');
  const rereviews = [];
  const outcome = await recoverAmaAutomation({
    rootDir, repo: AOS, prNumber: 8022, headSha: CLOSER_8022,
    result: { reason: 'not-eligible', reasons: ['stale-review-head', 'verdict-not-settled-success', 'blocking-findings-unknown', 'ci-not-green'] },
    reviewStateRow: restored,
    requestRereviewImpl: async (options) => { rereviews.push(options); return { triggered: true }; },
    dispatchHammer: async () => ({ dispatched: false }),
    pageImpl: async () => {},
    logger: SILENT,
  });
  assert.equal(rereviews.length, 0, 'a declined closer-head re-review is not requested again');
  assert.equal(outcome.outcome, 'ama-pending');
  assert.equal(outcome.recovery.action, 'rereview-declined-closer-head');
});

// ── Case 2 ──────────────────────────────────────────────────────────────────
//   [watcher] retrigger-remediation label on laceyenterprises/agent-os#8007:
//   no-job (no follow-up job exists for this PR yet)
const HEAD_8007 = 'c6ceb79b0000000000000000000000000000c6ce';

function labelArgs(rootDir, overrides = {}) {
  const ghCalls = [];
  const auditRows = [];
  return {
    ghCalls,
    auditRows,
    args: {
      rootDir,
      repo: AOS,
      prNumber: 8007,
      labelEvent: { id: 'LE_8007', actor: 'operator', createdAt: '2026-10-10T20:37:32Z', headSha: HEAD_8007 },
      revisionRef: HEAD_8007,
      execFileImpl: async (cmd, args) => { ghCalls.push({ cmd, args }); return { stdout: '', stderr: '' }; },
      appendAuditRow: (_root, row) => auditRows.push(row),
      findAuditRow: () => null,
      now: () => '2026-10-10T20:37:40Z',
      ...overrides,
    },
  };
}

test('Case 2: retrigger-remediation on PR 8007 with no follow-up job hands the ci-blocked PR to the hammer, removes the label and acknowledges', async (t) => {
  const rootDir = tmpRoot(t, 'noowner-case2-');
  const routed = [];
  const { args, ghCalls, auditRows } = labelArgs(rootDir, {
    noJobHandoffImpl: () => handOffRetriggerWithoutJob({
      rootDir, db: null, repoPath: AOS, prNumber: 8007,
      existing: { repo: AOS, pr_number: 8007, review_status: REREVIEW_CI_BLOCKED_STATUS },
      currentRevisionRef: HEAD_8007,
      routeCiBlockedImpl: async (options) => { routed.push(options); return { handled: true, outcome: 'ama-dispatched' }; },
    }),
  });
  const result = await tryRetriggerRemediationFromLabel(args);
  assert.equal(result.outcome, 'no-job-hammer', JSON.stringify(result));
  assert.equal(routed.length, 1);
  assert.equal(routed[0].ciAdmission.hammerOwner, true);
  assert.deepEqual(ghCalls[0].args, ['pr', 'edit', '8007', '--repo', AOS, '--remove-label', 'retrigger-remediation']);
  const comment = ghCalls.find((call) => call.args[0] === 'pr' && call.args[1] === 'comment');
  assert.ok(comment, JSON.stringify(ghCalls.map((call) => call.args.slice(0, 2))));
  const body = comment.args[comment.args.indexOf('--body') + 1];
  assert.match(body, /handed the PR to the hammer/);
  assert.match(body, /ama-dispatched/);
  assert.equal(auditRows.at(-1).outcome, 'no-job-hammer');

  // The same label event is consumed once: a later tick only retries removal.
  const repeat = await tryRetriggerRemediationFromLabel(args);
  assert.equal(repeat.outcome, 'label-already-consumed');
  assert.equal(routed.length, 1);
});

test('Case 2: with no job and a posted review, the label creates the follow-up job on the live head', async (t) => {
  const rootDir = tmpRoot(t, 'noowner-case2-job-');
  const pass = {
    repo: AOS, pr_number: 8007, pass_kind: 'first-pass', head_sha: '20543470ec00000000000000000000000020543',
    reviewer_model: 'codex', gh_comment_id: 'IC_8007', ended_at: '2026-10-10T15:52:00Z',
    body_md: '## Summary\nfixture\n\n## Blocking issues\n- None.\n\n## Non-blocking issues\n- **Tighten a check**\n  - **File:** a.mjs\n  - **Lines:** 1\n  - **Problem:** loose\n\n## Verdict\nComment only',
    metadata_json: JSON.stringify({ verdictMode: 'enforce' }),
  };
  const { args, ghCalls } = labelArgs(rootDir, {
    noJobHandoffImpl: () => handOffRetriggerWithoutJob({
      rootDir, db: null, repoPath: AOS, prNumber: 8007,
      existing: { repo: AOS, pr_number: 8007, review_status: 'posted' },
      currentRevisionRef: HEAD_8007,
      findPostedPassImpl: () => pass,
    }),
  });
  const result = await tryRetriggerRemediationFromLabel(args);
  assert.equal(result.outcome, 'no-job-job', JSON.stringify(result));
  const latest = findLatestFollowUpJob(rootDir, { repo: AOS, prNumber: 8007 });
  assert.ok(latest, 'a follow-up job now exists');
  assert.equal(latest.job.status, 'pending');
  assert.equal(latest.job.revisionRef, HEAD_8007);
  assert.ok(ghCalls.some((call) => call.args.includes('--remove-label')));
});

// ── JSON error ──────────────────────────────────────────────────────────────
//   [watcher] AMA hammer background dispatch settled for laceyenterprises/agent-os#7991@167974d1…:
//   error=Unexpected non-whitespace character after JSON at position 6804 (line 231 column 1)
const HEAD_7991 = '167974d19bc71b7fdae9da24f64610e283ecd926';

test('JSON error: a hammer line appended after the pretty audit document no longer breaks every closer tick', async (t) => {
  const rootDir = tmpRoot(t, 'noowner-json-');
  const hqRoot = join(rootDir, 'hq-root');
  writeAmaAuditEntry({
    hqRoot, repo: AOS, prNumber: 7991, headSha: HEAD_7991, now: '2026-10-10T18:26:07Z',
    attempt: { outcome: 'in_progress' },
  });
  const path = amaAuditFilePath(hqRoot, AOS, 7991, HEAD_7991);
  const appended = { timestamp: '2026-10-10T18:31:23.484424+00:00', repo: AOS, prNumber: 7991, headSha: HEAD_7991,
    outcome: 'no-merge', reason: 'primary-change-unknown', leaseHeld: false, closingStatus: 'HAM closing status — no merge.' };
  writeFileSync(path, `${readFileSync(path, 'utf8')}${JSON.stringify(appended)}\n`);
  assert.throws(() => JSON.parse(readFileSync(path, 'utf8')), /after JSON at position/);

  const doc = readAmaAuditEntry(hqRoot, AOS, 7991, HEAD_7991);
  assert.equal(doc.status, 'in_progress');
  assert.equal(doc.appendedRecords.length, 1);
  assert.equal(doc.appendedRecords[0].reason, 'primary-change-unknown');
  // Writers append again, and the hammer's evidence survives the rewrite.
  writeAmaAuditEntry({
    hqRoot, repo: AOS, prNumber: 7991, headSha: HEAD_7991, now: '2026-10-10T18:40:00Z',
    attempt: { outcome: 'in_progress' },
  });
  const rewritten = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(rewritten.attempts.length, 2);
  assert.equal(rewritten.appendedRecords[0].reason, 'primary-change-unknown');
  // And the hammer stop reader sees the hand-written no-merge.
  assert.equal(readHammerStopForHead({ hqRoot, repo: AOS, prNumber: 7991, headSha: HEAD_7991 })?.predicate,
    'primary-change-unknown');
  // A genuinely corrupt file still fails closed.
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '{"status": ');
  assert.throws(() => readAmaAuditEntry(hqRoot, AOS, 7991, HEAD_7991), SyntaxError);
});
