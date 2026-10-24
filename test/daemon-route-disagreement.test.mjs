import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  isDaemonFailClosedHammerRemediable,
  isDaemonNotTakenHammerRemediable,
  isDaemonNotTakenTransientRead,
  maybeDispatchAmaClosureFor,
} from '../src/ama-closure-orchestration.mjs';
import { DAEMON_MERGE_DISPOSITION } from '../src/ama/daemon-merge.mjs';
import { parkRecordPath } from '../src/daemon-merge-park-log.mjs';
import {
  DAEMON_ROUTE_DISAGREEMENT_BOUND,
  MERGEABILITY_UNKNOWN_STUCK_MS,
  clearDaemonRouteDisagreement,
  daemonRouteDisagreementFilePath,
  daemonRouteTransientReadFilePath,
  observeDaemonRouteDisagreement,
  readDaemonRouteDisagreement,
  recordDaemonRouteDisagreement,
} from '../src/daemon-route-disagreement.mjs';

// Retained CIDEDUPE-01 helper/ledger behavior is covered for source rollback.
// Runtime daemon selection and handoff consume the common next action.

const HEAD = 'a'.repeat(40);
const REPO = 'subject-route';
const PR = 6;

const CLEAN_REVIEW_BODY = [
  '## Blocking Issues', '', '- None.', '',
  '## Non-blocking Issues', '', '- None.', '',
  '## Verdict', '', 'Comment only',
].join('\n');

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'daemon-route-disagreement-'));
}

function jsonEvents(lines, event) {
  return lines
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter((doc) => doc?.event === event);
}

const CI_NOT_GREEN = Object.freeze({
  disposition: DAEMON_MERGE_DISPOSITION.NOT_TAKEN,
  reason: 'not-eligible',
  reasons: ['ci-not-green'],
  merged: false,
  attempts: 0,
});

const DUPLICATE_FAMILY = Object.freeze({
  disposition: DAEMON_MERGE_DISPOSITION.NOT_TAKEN,
  reason: 'not-eligible',
  reasons: ['duplicate-family-unresolved'],
  merged: false,
  attempts: 0,
});

// A closer that routes to the daemon whenever it may, exactly like
// `maybeDispatchAmaCloser` for an eligible clean PR, and dispatches the hammer
// only when told the daemon failed.
function routingCloser(calls) {
  return async ({ dispatchContext, sharedNextAction }) => {
    calls.push({ decision: sharedNextAction.decision, reasons: dispatchContext.daemonFailureReasons });
    if (sharedNextAction.decision.action === 'hammer' && sharedNextAction.decision.queue.intent === 'dispatch') {
      return { dispatched: true, reason: 'dispatched', launchRequestId: 'lrq_hammer' };
    }
    return { dispatched: false, skipMergeAgent: true, reason: 'daemon-clean-route' };
  };
}

function closureArgs(rootDir, { daemonResult, closerCalls, logs, warns, head = HEAD, ...overrides }) {
  return {
    rootDir,
    reviewStateRow: {
      review_status: 'posted',
      review_body: CLEAN_REVIEW_BODY,
      reviewer_head_sha: head,
      reviewer: 'gemini',
    },
    dispatchJob: { blockingFindingCount: 0, blockingFindingState: 'known' },
    candidate: {
      headSha: head,
      baseBranch: 'main',
      prState: 'open',
      isDraft: false,
      riskClass: 'low',
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      statusCheckRollup: [{ name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      branchProtection: { requiredContexts: ['agent-os/adversarial-gate'] },
      prAuthor: 'builder',
    },
    labelNames: [],
    repoPath: REPO,
    prNumber: PR,
    currentRevisionRef: head,
    loadConfigImpl: () => ({
      getMergeAuthorityConfig() {
        return {
          enabled: true,
          mergeMethod: 'squash',
          autonomousMergeExecutionEnabled: true,
          strictMode: true,
          lha: { consumeAttestations: false },
        };
      },
      getOrchestrationMode() {
        return 'native';
      },
    }),
    fetchLatestHeadReviewBodiesImpl: async () => [CLEAN_REVIEW_BODY],
    liveReviewRetryDelaysMs: [0, 0],
    fetchMergedProtectiveDependentsImpl: async () => [],
    logger: { log: (m) => logs.push(String(m)), warn: (m) => warns.push(String(m)) },
    runDaemonCleanMergeAttemptImpl: async () => daemonResult,
    maybeDispatchAmaCloserImpl: routingCloser(closerCalls),
    ...overrides,
  };
}

test('ledger counts per head, resets on a new head, and escalates only past the bound', () => {
  const rootDir = tempRoot();
  try {
    const id = { repo: REPO, prNumber: PR };
    const logger = { warn() {} };
    for (let i = 1; i <= DAEMON_ROUTE_DISAGREEMENT_BOUND; i += 1) {
      const r = recordDaemonRouteDisagreement(rootDir, id, { headSha: HEAD, daemonCleanMerge: CI_NOT_GREEN, logger });
      assert.equal(r.count, i);
      assert.equal(r.escalate, false, `observation ${i} is within the bound`);
    }
    assert.equal(readDaemonRouteDisagreement(rootDir, id, { headSha: HEAD, logger }).boundReached, true);
    const past = recordDaemonRouteDisagreement(rootDir, id, { headSha: HEAD, daemonCleanMerge: CI_NOT_GREEN, logger });
    assert.equal(past.escalate, true);

    const doc = JSON.parse(readFileSync(daemonRouteDisagreementFilePath(rootDir, id), 'utf8'));
    assert.equal(doc.headSha, HEAD);
    assert.equal(doc.daemonReason, 'not-eligible');
    assert.deepEqual(doc.daemonReasons, ['ci-not-green']);

    // A new head is a fresh series.
    const fresh = recordDaemonRouteDisagreement(rootDir, id, { headSha: 'head-next', logger });
    assert.equal(fresh.count, 1);
    assert.equal(readDaemonRouteDisagreement(rootDir, id, { headSha: HEAD, logger }).count, 0);

    // Without a head the series cannot be bounded: it logs but never escalates.
    for (let i = 0; i <= DAEMON_ROUTE_DISAGREEMENT_BOUND + 1; i += 1) {
      assert.equal(recordDaemonRouteDisagreement(rootDir, id, { headSha: null, logger }).escalate, false);
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('only pre-lease gate declines the hammer can fix are hammer-remediable', () => {
  assert.equal(isDaemonNotTakenHammerRemediable(CI_NOT_GREEN), true);
  assert.equal(isDaemonNotTakenHammerRemediable({ ...CI_NOT_GREEN, reasons: ['pr-not-mergeable', 'stale-head'] }), true);
  assert.equal(isDaemonNotTakenHammerRemediable(DUPLICATE_FAMILY), false);
  // DIRTYOWN-01: GitHub's still-computing UNKNOWN is a transient read, not a conflict.
  assert.equal(isDaemonNotTakenHammerRemediable({ ...CI_NOT_GREEN, reasons: ['pr-mergeability-unknown'] }), false);
  assert.equal(isDaemonNotTakenHammerRemediable({ ...CI_NOT_GREEN, reasons: ['ci-not-green', 'labels-unavailable'] }), false);
  // ...but an UNKNOWN riding along a real remediable miss must not turn it into a park.
  assert.equal(isDaemonNotTakenHammerRemediable({ ...CI_NOT_GREEN, reasons: ['ci-not-green', 'pr-mergeability-unknown'] }), true);
  assert.equal(isDaemonNotTakenHammerRemediable({ ...CI_NOT_GREEN, reasons: ['lease-not-held', 'pr-mergeability-unknown'] }), false);
  assert.equal(isDaemonNotTakenHammerRemediable({ ...CI_NOT_GREEN, reasons: [] }), false);
  assert.equal(isDaemonNotTakenHammerRemediable({ disposition: DAEMON_MERGE_DISPOSITION.NOT_TAKEN, reason: 'prior-daemon-terminal-failure' }), false);
  assert.equal(isDaemonNotTakenHammerRemediable({ ...CI_NOT_GREEN, disposition: DAEMON_MERGE_DISPOSITION.FAILED_CLOSED }), false);
});

test('DIRTYOWN-01: only all-transient pre-lease declines are transient reads', () => {
  const unknown = { ...CI_NOT_GREEN, reasons: ['pr-mergeability-unknown'] };
  assert.equal(isDaemonNotTakenTransientRead(unknown), true);
  assert.equal(isDaemonNotTakenTransientRead({ ...CI_NOT_GREEN, reasons: ['labels-unavailable', 'pr-mergeability-unknown'] }), true);
  assert.equal(isDaemonNotTakenTransientRead({ ...CI_NOT_GREEN, reasons: ['ci-not-green', 'pr-mergeability-unknown'] }), false);
  assert.equal(isDaemonNotTakenTransientRead(CI_NOT_GREEN), false);
  assert.equal(isDaemonNotTakenTransientRead({ ...CI_NOT_GREEN, reasons: [] }), false);
  assert.equal(isDaemonNotTakenTransientRead({ ...unknown, disposition: DAEMON_MERGE_DISPOSITION.FAILED_CLOSED }), false);
  assert.equal(isDaemonNotTakenTransientRead({ ...unknown, reason: 'prior-daemon-terminal-failure' }), false);
});

test('DIRTYOWN-01 / NXA-05: UNKNOWN+CLEAN selects the CI observer without invoking the closer', async () => {
  const rootDir = tempRoot();
  try {
    const closerCalls = [];
    const logs = [];
    const warns = [];
    let closerMergeableState = null;
    const args = closureArgs(rootDir, {
      daemonResult: { ...CI_NOT_GREEN, reasons: ['pr-mergeability-unknown'] },
      closerCalls,
      logs,
      warns,
      maybeDispatchAmaCloserImpl: async ({ prMetadata }) => {
        closerMergeableState = prMetadata?.mergeableState;
        return { dispatched: false, reason: 'not-eligible', reasons: ['pr-mergeability-unknown'] };
      },
    });
    args.candidate = { ...args.candidate, mergeable: 'UNKNOWN', mergeStateStatus: 'CLEAN' };

    const result = await maybeDispatchAmaClosureFor(args);
    assert.equal(closerMergeableState, null, 'the selected observer does not launch a closer');
    assert.equal(result.nextAction.action, 'wait-for-CI');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('DIRTYOWN-01: a post-lease gate-not-eligible with UNKNOWN beside a remediable gate is hammer-remediable', () => {
  const failed = (reasons) => ({
    disposition: DAEMON_MERGE_DISPOSITION.FAILED_CLOSED,
    reason: 'gate-not-eligible',
    permanent: false,
    reasons,
  });
  assert.equal(isDaemonFailClosedHammerRemediable(failed(['ci-not-green', 'pr-mergeability-unknown'])), true);
  assert.equal(isDaemonFailClosedHammerRemediable(failed(['stale-head', 'pr-mergeability-unknown'])), true);
  assert.equal(isDaemonFailClosedHammerRemediable(failed(['pr-mergeability-unknown'])), false);
  assert.equal(isDaemonFailClosedHammerRemediable(failed(['lease-not-held', 'pr-mergeability-unknown'])), false);
});

test('DIRTYOWN-01: a head stuck on transient reads past the bound logs one stuck event and never parks', () => {
  const rootDir = tempRoot();
  try {
    const logs = [];
    const warns = [];
    const logger = { log: (m) => logs.push(String(m)), warn: (m) => warns.push(String(m)) };
    const daemonCleanMerge = { ...CI_NOT_GREEN, reasons: ['pr-mergeability-unknown'] };
    const observe = (headSha, minutes) => observeDaemonRouteDisagreement({
      rootDir,
      repo: REPO,
      prNumber: PR,
      headSha,
      daemonCleanMerge,
      hammerRemediable: false,
      transientRead: true,
      now: new Date(Date.UTC(2026, 8, 29, 0, minutes)).toISOString(),
      logger,
    });
    const stuckEvents = () => jsonEvents(logs, 'ama.mergeability_unknown_stuck');
    const stuckMinutes = MERGEABILITY_UNKNOWN_STUCK_MS / 60_000;

    assert.equal(observe(HEAD, 0).stuck, false);
    assert.equal(observe(HEAD, stuckMinutes - 1).stuck, false);
    assert.equal(stuckEvents().length, 0, 'inside the bound nothing is reported');
    assert.ok(existsSync(daemonRouteTransientReadFilePath(rootDir, { repo: REPO, prNumber: PR })));

    const stuck = observe(HEAD, stuckMinutes + 1);
    assert.equal(stuck.stuck, true);
    assert.equal(stuck.escalate, false);
    assert.equal(stuck.parkResult, null);
    assert.equal(stuckEvents().length, 1);
    assert.equal(stuckEvents()[0].headSha, HEAD);
    assert.equal(stuckEvents()[0].elapsedMs, (stuckMinutes + 1) * 60_000);
    assert.deepEqual(stuckEvents()[0].daemonReasons, ['pr-mergeability-unknown']);

    observe(HEAD, stuckMinutes + 5);
    assert.equal(stuckEvents().length, 1, 'the stuck event fires once per head');

    // A new head restarts the clock.
    assert.equal(observe('head-next', stuckMinutes + 6).stuck, false);
    assert.equal(observe('head-next', 2 * stuckMinutes + 7).stuck, true);
    assert.equal(stuckEvents().length, 2);
    assert.equal(stuckEvents()[1].headSha, 'head-next');

    assert.equal(jsonEvents(logs, 'ama.daemon_clean_park.manual_close_required').length, 0);
    assert.equal(existsSync(parkRecordPath(rootDir, REPO, PR)), false);
    assert.equal(existsSync(daemonRouteDisagreementFilePath(rootDir, { repo: REPO, prNumber: PR })), false);

    clearDaemonRouteDisagreement(rootDir, { repo: REPO, prNumber: PR });
    assert.equal(existsSync(daemonRouteTransientReadFilePath(rootDir, { repo: REPO, prNumber: PR })), false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('DIRTYOWN-01: a transient read reports the caller head and ignores a ledger kept on another head', () => {
  const rootDir = tempRoot();
  try {
    const logs = [];
    const logger = { log: (m) => logs.push(String(m)), warn: () => {} };
    const id = { repo: REPO, prNumber: PR };
    for (let i = 0; i < 2; i += 1) {
      recordDaemonRouteDisagreement(rootDir, id, { headSha: 'head-old', daemonCleanMerge: CI_NOT_GREEN, logger });
    }

    const result = observeDaemonRouteDisagreement({
      rootDir,
      repo: REPO,
      prNumber: PR,
      headSha: HEAD,
      daemonCleanMerge: { ...CI_NOT_GREEN, reasons: ['pr-mergeability-unknown'] },
      hammerRemediable: false,
      transientRead: true,
      logger,
    });
    assert.equal(result.headSha, HEAD);
    assert.equal(result.count, 0);
    const event = jsonEvents(logs, 'ama.daemon_route_disagreement').at(-1);
    assert.equal(event.headSha, HEAD, 'the log names the head this tick observed');
    assert.equal(event.disagreements, 0, 'another head\'s count is not reported against this one');
    assert.equal(readDaemonRouteDisagreement(rootDir, id, { headSha: 'head-old', logger }).count, 2, 'the ledger is not touched');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});


test('REVIEWNOTICE-01: closer final operator outcome is available to the next notice evaluation', async () => {
  const rootDir = tempRoot();
  try {
    const { maybeDeliverOperatorDecisionNotice } = await import('../src/operator-decision-notice.mjs');
    const result = await maybeDispatchAmaClosureFor(closureArgs(rootDir, {
      maybeDispatchAmaCloserImpl: async () => ({ dispatched: false, needsOperator: true, reason: 'synthetic-structural-hold' }),
    }));
    assert.equal(result.needsOperator, true);
    const alerts = [];
    await maybeDeliverOperatorDecisionNotice({ rootDir, repo: REPO, prNumber: PR, headSha: HEAD,
      decision: { operatorDecisionRequired: true, state: 'success', reason: 'remediation-stopped' },
      now: 0, deliverAlertFn: async (_text, meta) => alerts.push(meta) });
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].payload.reason, 'no-route');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

// NXA-06: runtime ownership uses the shared generation. The legacy counter
// helpers above remain covered for a caller-local source rollback.
for (const [name, liveGate, action, actor] of [
  ['UNKNOWN', { mergeable: 'UNKNOWN' }, 'wait-for-CI', 'ci'],
  ['red CI', { requiredChecks: [{ name: 'unit', status: 'COMPLETED', conclusion: 'FAILURE' }] }, 'hammer', 'hammer'],
  ['conflict', { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }, 'hammer', 'hammer'],
  ['stale head', { candidateHead: 'c'.repeat(40) }, 'review', 'reviewer'],
]) test(`common daemon decline owns ${name} on the first eligible pass without disagreement counting`, async () => {
  const rootDir = tempRoot();
  try {
    const closerCalls = [], logs = [], warns = [];
    const args = closureArgs(rootDir, { closerCalls, logs, warns,
      dispatchJob: { remediationStopCode: 'max-rounds-reached' },
      daemonResult: { ...CI_NOT_GREEN, liveGate: { candidateHead: HEAD, prState: 'OPEN',
        mergeable: 'MERGEABLE', requiredChecks: [{ name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' }], ...liveGate } },
    });
    // A historical disagreement count cannot select or block a next owner.
    for (let i = 0; i < 4; i++) recordDaemonRouteDisagreement(rootDir, { repo: REPO, prNumber: PR },
      { headSha: HEAD, daemonCleanMerge: CI_NOT_GREEN, logger: args.logger });
    for (let i = 0; i < 2; i++) {
      const result = await maybeDispatchAmaClosureFor(args);
      assert.equal(result.nextAction.action, action);
      assert.equal(result.nextAction.actor, actor);
      assert.equal(result.dispatched, action === 'hammer');
      if (action === 'hammer') assert.equal(closerCalls.at(-1).decision, result.nextAction);
    }
    assert.equal(readDaemonRouteDisagreement(rootDir, { repo: REPO, prNumber: PR }, { headSha: HEAD }).count, 4);
    assert.equal(existsSync(parkRecordPath(rootDir, REPO, PR)), false);
    assert.equal(jsonEvents(logs, 'ama.daemon_route_disagreement.hammer_fallback').length, 0);
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test('unreadable decline details retain a snapshot refresh owner without speculative hammer admission', async () => {
  const rootDir = tempRoot();
  try {
    const closerCalls = [], logs = [], warns = [];
    const args = closureArgs(rootDir, { closerCalls, logs, warns, daemonResult: { ...CI_NOT_GREEN, reasons: ['labels-unavailable'] } });
    for (let i = 0; i < 5; i++) {
      const result = await maybeDispatchAmaClosureFor(args);
      assert.equal(result.nextAction.actor, 'watcher');
      assert.equal(result.nextAction.reason, 'snapshot-refresh');
      assert.equal(result.dispatched, false);
    }
    assert.equal(closerCalls.length, 0);
    assert.equal(existsSync(daemonRouteDisagreementFilePath(rootDir, { repo: REPO, prNumber: PR })), false);
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});
