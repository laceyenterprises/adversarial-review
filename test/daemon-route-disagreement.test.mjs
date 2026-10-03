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
  resolveMergeAgentCoexistenceForWatcher,
} from '../src/ama-closure-orchestration.mjs';
import { DAEMON_MERGE_DISPOSITION } from '../src/ama/daemon-merge.mjs';
import { parkRecordPath } from '../src/daemon-merge-park-log.mjs';
import {
  DAEMON_ROUTE_DISAGREEMENT_BOUND,
  DAEMON_ROUTE_DISAGREEMENT_REASON,
  MERGEABILITY_UNKNOWN_STUCK_MS,
  clearDaemonRouteDisagreement,
  daemonRouteDisagreementFilePath,
  daemonRouteTransientReadFilePath,
  observeDaemonRouteDisagreement,
  readDaemonRouteDisagreement,
  recordDaemonRouteDisagreement,
} from '../src/daemon-route-disagreement.mjs';
import { createAmaHammerBackgroundQueue } from '../src/ama-hammer-background-dispatch.mjs';

// CIDEDUPE-01 — no silent refusal. When the AMA closer answers
// `daemon-clean-route` and the daemon declined the same tick, the disagreement is
// logged with the daemon's reason and counted per head. Past the bound the PR
// goes to the capped hammer (hammer-remediable gates) or parks with an
// operator-visible alert (everything else). SEV3 2026-09-28, agent-os#7314.

const HEAD = 'head-7314';
const REPO = 'acme/repo';
const PR = 7314;

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
  return async ({ dispatchContext }) => {
    calls.push({ force: dispatchContext.forceHammerAfterDaemonFailure === true, reasons: dispatchContext.daemonFailureReasons });
    if (dispatchContext.forceHammerAfterDaemonFailure === true) {
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
      statusCheckRollup: [],
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

test('DIRTYOWN-01: a pre-lease UNKNOWN decline is logged but never counted, parked, or paged', async () => {
  const rootDir = tempRoot();
  try {
    const closerCalls = [];
    const logs = [];
    const warns = [];
    const args = closureArgs(rootDir, {
      daemonResult: { ...CI_NOT_GREEN, reasons: ['pr-mergeability-unknown'] },
      closerCalls,
      logs,
      warns,
    });

    for (let tick = 1; tick <= DAEMON_ROUTE_DISAGREEMENT_BOUND + 3; tick += 1) {
      const result = await maybeDispatchAmaClosureFor(args);
      assert.equal(result.reason, 'daemon-clean-route', `tick ${tick} still waits on the daemon`);
      assert.equal(result.needsOperator, undefined);
    }
    assert.ok(closerCalls.every((c) => c.force === false), 'a transient read never forces the hammer');
    const events = jsonEvents(logs, 'ama.daemon_route_disagreement');
    assert.equal(events.length, DAEMON_ROUTE_DISAGREEMENT_BOUND + 3, 'every tick is still logged');
    assert.ok(events.every((e) => e.transientRead === true && e.disagreements === 0 && e.escalation === null));
    assert.deepEqual(events[0].daemonReasons, ['pr-mergeability-unknown']);
    assert.match(warns.join('\n'), /declined on a transient GitHub read.*not counted/);
    assert.equal(jsonEvents(logs, 'ama.daemon_clean_park.manual_close_required').length, 0);
    assert.equal(existsSync(parkRecordPath(rootDir, REPO, PR)), false);
    assert.equal(existsSync(daemonRouteDisagreementFilePath(rootDir, { repo: REPO, prNumber: PR })), false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('DIRTYOWN-01: the closer holds UNKNOWN+CLEAN like the daemon instead of routing it to the daemon', async () => {
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

    await maybeDispatchAmaClosureFor(args);
    assert.equal(closerMergeableState, 'UNKNOWN', 'the closer sees the same UNKNOWN the daemon gates on');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('a closer→daemon disagreement is logged every tick, then falls back to the capped hammer past the bound', async () => {
  const rootDir = tempRoot();
  try {
    const closerCalls = [];
    const logs = [];
    const warns = [];
    const args = closureArgs(rootDir, { daemonResult: CI_NOT_GREEN, closerCalls, logs, warns });

    for (let tick = 1; tick <= DAEMON_ROUTE_DISAGREEMENT_BOUND; tick += 1) {
      const result = await maybeDispatchAmaClosureFor(args);
      assert.equal(result.reason, 'daemon-clean-route', `tick ${tick} still routes to the daemon`);
      assert.equal(result.needsOperator, undefined);
      const events = jsonEvents(logs, 'ama.daemon_route_disagreement');
      assert.equal(events.length, tick, `tick ${tick} logs the disagreement`);
      const last = events.at(-1);
      assert.equal(last.repo, REPO);
      assert.equal(last.pr, PR);
      assert.equal(last.headSha, HEAD);
      assert.equal(last.disagreements, tick);
      assert.equal(last.bound, DAEMON_ROUTE_DISAGREEMENT_BOUND);
      assert.equal(last.daemonDisposition, 'not-taken');
      assert.equal(last.daemonReason, 'not-eligible');
      assert.deepEqual(last.daemonReasons, ['ci-not-green']);
      assert.equal(last.hammerRemediable, true);
      assert.equal(last.escalation, null);
    }
    assert.match(warns.join('\n'), /daemon-clean-route\) but the daemon declined: not-taken not-eligible; gates=ci-not-green/);
    assert.ok(closerCalls.every((c) => c.force === false), 'within the bound the closer is not forced');

    // Past the bound the closer is told the daemon failed, so it dispatches the hammer.
    const escalated = await maybeDispatchAmaClosureFor(args);
    assert.equal(closerCalls.at(-1).force, true);
    assert.deepEqual(closerCalls.at(-1).reasons, ['ci-not-green'], 'the hammer alert carries the daemon gates');
    assert.equal(escalated.dispatched, true);
    assert.equal(escalated.launchRequestId, 'lrq_hammer');
    const fallback = jsonEvents(logs, 'ama.daemon_route_disagreement.hammer_fallback');
    assert.equal(fallback.length, 1);
    assert.equal(fallback[0].disagreements, DAEMON_ROUTE_DISAGREEMENT_BOUND);
    assert.deepEqual(fallback[0].daemonReasons, ['ci-not-green']);
    assert.equal(jsonEvents(logs, 'ama.daemon_clean_park.manual_close_required').length, 0);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('a non-remediable disagreement parks with an operator-visible alert past the bound', async () => {
  const rootDir = tempRoot();
  try {
    const closerCalls = [];
    const logs = [];
    const warns = [];
    const args = closureArgs(rootDir, { daemonResult: DUPLICATE_FAMILY, closerCalls, logs, warns });

    for (let tick = 1; tick <= DAEMON_ROUTE_DISAGREEMENT_BOUND; tick += 1) {
      const result = await maybeDispatchAmaClosureFor(args);
      assert.equal(result.reason, 'daemon-clean-route');
    }
    assert.equal(existsSync(parkRecordPath(rootDir, REPO, PR)), false, 'no park inside the bound');

    const parked = await maybeDispatchAmaClosureFor(args);
    assert.ok(closerCalls.every((c) => c.force === false), 'a non-remediable decline never forces the hammer');
    assert.equal(parked.dispatched, false);
    assert.equal(parked.skipMergeAgent, true);
    assert.equal(parked.needsOperator, true);
    assert.equal(parked.reason, DAEMON_ROUTE_DISAGREEMENT_REASON);
    assert.equal(parked.operatorReason, 'daemon-route-disagreement:duplicate-family-unresolved');
    assert.equal(parked.routeDisagreement.count, DAEMON_ROUTE_DISAGREEMENT_BOUND + 1);

    const alert = jsonEvents(logs, 'ama.daemon_clean_park.manual_close_required');
    assert.equal(alert.length, 1, 'the pageable park event fires');
    assert.equal(alert[0].reason, DAEMON_ROUTE_DISAGREEMENT_REASON);
    assert.deepEqual(alert[0].reasons, ['duplicate-family-unresolved']);
    assert.equal(alert[0].hammerFallback, false);
    assert.equal(jsonEvents(logs, 'ama.daemon_route_disagreement').at(-1).escalation, 'park');
    assert.match(warns.join('\n'), /not hammer-remediable; parking for the operator/);

    const park = JSON.parse(readFileSync(parkRecordPath(rootDir, REPO, PR), 'utf8'));
    assert.equal(park.reason, DAEMON_ROUTE_DISAGREEMENT_REASON);
    assert.match(park.remedy, /daemon merges on its next tick/);

    // It stays parked on later ticks, but pages once per head.
    const stillParked = await maybeDispatchAmaClosureFor(args);
    assert.equal(stillParked.needsOperator, true);
    assert.equal(jsonEvents(logs, 'ama.daemon_clean_park.manual_close_required').length, 1);
    assert.equal(jsonEvents(logs, 'ama.daemon_route_disagreement').at(-1).escalation, 'park');
    assert.equal(
      JSON.parse(readFileSync(parkRecordPath(rootDir, REPO, PR), 'utf8')).observationCount,
      2,
      'the park record keeps counting for review-pipeline-health',
    );

    // The watcher's coexistence step turns the park into await-operator, not a
    // silent ama-pending and not a merge-agent fall-through.
    const coexistence = await resolveMergeAgentCoexistenceForWatcher({
      rootDir,
      reviewStateRow: args.reviewStateRow,
      dispatchJob: args.dispatchJob,
      candidate: args.candidate,
      labelNames: [],
      repoPath: REPO,
      prNumber: PR,
      currentRevisionRef: HEAD,
      logger: args.logger,
      maybeDispatchAmaClosureForImpl: (callArgs) => maybeDispatchAmaClosureFor({ ...args, ...callArgs, rootDir }),
    });
    assert.equal(coexistence.outcome, 'await-operator');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('a new head restarts the count, and a daemon merge clears it', async () => {
  const rootDir = tempRoot();
  try {
    const closerCalls = [];
    const logs = [];
    const warns = [];
    const oldHead = closureArgs(rootDir, { daemonResult: CI_NOT_GREEN, closerCalls, logs, warns });
    for (let tick = 1; tick <= DAEMON_ROUTE_DISAGREEMENT_BOUND; tick += 1) {
      await maybeDispatchAmaClosureFor(oldHead);
    }
    const newHead = closureArgs(rootDir, { daemonResult: CI_NOT_GREEN, closerCalls, logs, warns, head: 'head-pushed' });
    const afterPush = await maybeDispatchAmaClosureFor(newHead);
    assert.equal(afterPush.reason, 'daemon-clean-route', 'a new head is not escalated on its first disagreement');
    assert.equal(closerCalls.at(-1).force, false);
    assert.equal(jsonEvents(logs, 'ama.daemon_route_disagreement').at(-1).disagreements, 1);

    const merged = await maybeDispatchAmaClosureFor({
      ...newHead,
      runDaemonCleanMergeAttemptImpl: async () => ({
        disposition: DAEMON_MERGE_DISPOSITION.MERGED,
        reason: 'merged',
        merged: true,
        attempts: 1,
      }),
    });
    assert.equal(merged.reason, `daemon-${DAEMON_MERGE_DISPOSITION.MERGED}`);
    assert.equal(existsSync(daemonRouteDisagreementFilePath(rootDir, { repo: REPO, prNumber: PR })), false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('background dispatch mode counts the settled daemon-clean-route outcome too', async () => {
  const rootDir = tempRoot();
  try {
    const closerCalls = [];
    const logs = [];
    const warns = [];
    const queue = createAmaHammerBackgroundQueue({ maxConcurrent: 1 });
    const args = closureArgs(rootDir, {
      daemonResult: CI_NOT_GREEN,
      closerCalls,
      logs,
      warns,
      resolveAmaHammerDispatchModeImpl: () => 'background',
      amaHammerBackgroundQueueImpl: () => queue,
      fetchCurrentPrStateImpl: async () => ({ state: 'OPEN', headSha: HEAD, isDraft: false, mergeable: 'MERGEABLE' }),
    });

    // The live #7314 shape: submit, settle to daemon-clean-route, apply next tick.
    const submitted = await maybeDispatchAmaClosureFor(args);
    assert.equal(submitted.backgroundDispatch.state, 'started');
    await queue.drain();
    const applied = await maybeDispatchAmaClosureFor(args);
    assert.equal(applied.reason, 'daemon-clean-route');
    const events = jsonEvents(logs, 'ama.daemon_route_disagreement');
    assert.equal(events.length, 1, 'the applied background outcome is a logged disagreement');
    assert.deepEqual(events[0].daemonReasons, ['ci-not-green']);
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

test('DIRTYOWN-01: a pre-lease remediable miss with UNKNOWN alongside reaches the capped hammer, not a park', async () => {
  const rootDir = tempRoot();
  try {
    const closerCalls = [];
    const logs = [];
    const warns = [];
    const reasons = ['stale-head', 'pr-mergeability-unknown'];
    const args = closureArgs(rootDir, {
      daemonResult: { ...CI_NOT_GREEN, reasons },
      closerCalls,
      logs,
      warns,
    });

    for (let tick = 1; tick <= DAEMON_ROUTE_DISAGREEMENT_BOUND; tick += 1) {
      const result = await maybeDispatchAmaClosureFor(args);
      assert.equal(result.reason, 'daemon-clean-route', `tick ${tick} still routes to the daemon`);
      assert.equal(result.needsOperator, undefined);
    }
    const events = jsonEvents(logs, 'ama.daemon_route_disagreement');
    assert.ok(events.every((e) => e.hammerRemediable === true && e.transientRead !== true));
    assert.equal(events.at(-1).disagreements, DAEMON_ROUTE_DISAGREEMENT_BOUND);

    const escalated = await maybeDispatchAmaClosureFor(args);
    assert.equal(closerCalls.at(-1).force, true, 'past the bound the hammer is forced');
    assert.equal(escalated.dispatched, true);
    assert.equal(jsonEvents(logs, 'ama.daemon_route_disagreement.hammer_fallback').length, 1);
    assert.equal(jsonEvents(logs, 'ama.daemon_clean_park.manual_close_required').length, 0);
    assert.equal(existsSync(parkRecordPath(rootDir, REPO, PR)), false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
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


test('primary-change transport failure beside red CI dispatches hammer without manual park', async () => {
  const rootDir = tempRoot();
  try {
    const closerCalls = [], logs = [], warns = [];
    const result = await maybeDispatchAmaClosureFor(closureArgs(rootDir, {
      daemonResult: { disposition: DAEMON_MERGE_DISPOSITION.FAILED_CLOSED,
        reason: 'gate-not-eligible', permanent: false,
        reasons: ['primary-change-read-failed', 'ci-not-green'] },
      closerCalls, logs, warns,
    }));
    assert.equal(result.dispatched, true);
    assert.equal(closerCalls.at(-1).force, true);
    assert.equal(jsonEvents(logs, 'ama.daemon_clean_park.manual_close_required').length, 0);
    assert.equal(existsSync(parkRecordPath(rootDir, REPO, PR)), false);
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});
