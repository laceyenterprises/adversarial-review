import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runQueuedReviewAdoptionPhase } from '../src/watcher.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

function watcherSource() {
  return readFileSync(path.join(ROOT, 'src', 'watcher.mjs'), 'utf8');
}

// ARC-18: runQueuedReviewAdoptionPhase and its internal drain/maintenance
// ordering moved to src/posted-review-row.mjs. The reviewer/posted-review queue
// initialization still lives in pollOnce (watcher.mjs), so the two halves of
// this structural check now read from two different source files.
function postedReviewRowSource() {
  return readFileSync(path.join(ROOT, 'src', 'posted-review-row.mjs'), 'utf8');
}

// ARC-18: the per-PR loop body — which enqueues posted-review handoffs — moved
// out of pollOnce into processReviewSubject (src/pollonce-phases.mjs). The queue
// is still initialized in pollOnce (watcher.mjs) and threaded into that phase.
function pollOncePhasesSource() {
  return readFileSync(path.join(ROOT, 'src', 'pollonce-phases.mjs'), 'utf8');
}

test('watcher drains queued reviewer dispatches before merge-side handoffs', () => {
  const watcher = watcherSource();
  const phase = postedReviewRowSource();
  const pollPhases = pollOncePhasesSource();

  // Queue initialization is part of pollOnce and stays in watcher.mjs.
  const candidateQueue = watcher.indexOf('const reviewerDispatchCandidates = [];');
  const detachedTrackerImport = watcher.indexOf('createDetachedReviewerDispatchTracker,');
  const detachedTracker = watcher.indexOf('const detachedReviewerDispatchTracker = createDetachedReviewerDispatchTracker');
  const postedQueue = watcher.indexOf('const postedReviewHandlers = [];');
  const discoveryDrainHelper = watcher.indexOf('async function drainReviewerDispatchCandidatesIfBatchReady(reason)');
  const subjectFifoSort = watcher.indexOf(
    'compareWatcherWakeSubjectEntries(wakePayloadForPoll(), repoPath, a, b, compareReviewerDispatchCandidates)',
  );
  const orgRefresh = watcher.indexOf('await refreshOrgRepos(octokit);');
  const frontLifecycleCleanup = watcher.indexOf('await retryPendingMergeAgentLifecycleCleanups();', orgRefresh);
  const frontLifecycleSync = watcher.indexOf(
    'await syncPRLifecycle(octokit, operatorSurface, WATCHER_PRIMARY_DOMAIN_ID);',
    frontLifecycleCleanup,
  );
  // pollOnce drives the per-PR processing phase, which is where the posted
  // handoff is enqueued (ARC-18: the enqueue moved to pollonce-phases.mjs).
  const perPrPhaseCall = watcher.indexOf('await processReviewSubject(subjectEntry, {');
  const midDiscoveryDrain = watcher.indexOf(
    "await drainReviewerDispatchCandidatesIfBatchReady('continuing reviewer discovery');",
    perPrPhaseCall,
  );
  const postedEnqueue = pollPhases.indexOf('postedReviewHandlers.push({');
  // The executable phase ordering moved into the runQueuedReviewAdoptionPhase
  // helper, now in posted-review-row.mjs.
  const phaseHelper = phase.indexOf('async function runQueuedReviewAdoptionPhase');
  const drainBeforePostedHandlers = phase.indexOf("await drainReviewerDispatchCandidates('posted-review handlers');");
  // WPS-01/RVHAND-01: the unbounded `for (const postedReviewHandler of
  // postedReviewHandlers)` loop became a budgeted, lane-gated scheduler call.
  // Reviewer dispatch now drains ahead of that handler lane so review claims are
  // not held behind a single slow hammer path.
  const postedDrain = phase.indexOf('await runPostedReviewHandlersFairlyImpl({');
  const lifecycleCleanup = phase.indexOf('await retryPendingMergeAgentLifecycleCleanupsImpl();');
  const lifecycleSync = phase.indexOf('await syncPRLifecycleImpl(octokit, operatorSurface, primaryDomainId);');
  const dagAutowalk = phase.indexOf('await retryPendingDagAutowalkOnMergeImpl();');
  const maintenanceLoop = phase.indexOf('for (const postReviewMaintenanceHandler of postReviewMaintenanceHandlers)');

  assert.notEqual(candidateQueue, -1, 'reviewer dispatch candidate queue exists');
  assert.notEqual(detachedTrackerImport, -1, 'watcher imports detached reviewer dispatch tracking');
  assert.notEqual(detachedTracker, -1, 'watcher tracks detached reviewer dispatch starts');
  assert.notEqual(postedQueue, -1, 'posted review handoffs are queued');
  assert.notEqual(discoveryDrainHelper, -1, 'watcher has a bounded mid-discovery reviewer drain');
  assert.notEqual(subjectFifoSort, -1, 'discovered subjects are wake-aware reviewer-FIFO sorted before bounded drains');
  assert.notEqual(orgRefresh, -1, 'pollOnce refreshes org repos');
  assert.notEqual(frontLifecycleCleanup, -1, 'pollOnce runs front-of-tick lifecycle cleanup');
  assert.notEqual(frontLifecycleSync, -1, 'pollOnce runs front-of-tick lifecycle sync');
  assert.notEqual(perPrPhaseCall, -1, 'pollOnce drives the per-PR processing phase');
  assert.notEqual(midDiscoveryDrain, -1, 'pollOnce can drain a full reviewer batch before discovery completes');
  assert.notEqual(postedEnqueue, -1, 'posted review rows enqueue their handoff');
  assert.notEqual(phaseHelper, -1, 'post-review phase helper exists');
  assert.notEqual(drainBeforePostedHandlers, -1, 'reviewer dispatch drain exists before posted-review handlers');
  assert.notEqual(postedDrain, -1, 'queued posted-review handlers still drain');
  assert.notEqual(lifecycleCleanup, -1, 'merge-agent cleanup still runs');
  assert.notEqual(lifecycleSync, -1, 'lifecycle sync still runs');
  assert.notEqual(dagAutowalk, -1, 'dag autowalk retry still runs');
  assert.notEqual(maintenanceLoop, -1, 'post-review maintenance handlers still run');

  assert.ok(candidateQueue < postedQueue, 'queues are initialized near the reviewer scheduler');
  assert.ok(detachedTracker < candidateQueue, 'detached launch tracker is initialized before queue drains');
  assert.ok(candidateQueue < discoveryDrainHelper, 'bounded drain helper is scoped to the tick candidate queue');
  assert.ok(subjectFifoSort < perPrPhaseCall, 'subjects are wake-aware FIFO sorted before processReviewSubject can enqueue candidates');
  assert.ok(postedQueue < perPrPhaseCall, 'posted handler queue is initialized before the per-PR phase that enqueues into it');
  assert.ok(orgRefresh < frontLifecycleCleanup, 'lifecycle cleanup runs after repo refresh gives the tick its operator surface');
  assert.ok(frontLifecycleCleanup < frontLifecycleSync, 'front-of-tick cleanup runs before front-of-tick lifecycle sync');
  assert.ok(frontLifecycleSync < perPrPhaseCall, 'lifecycle sync runs before the per-PR discovery/retry sweep');
  assert.ok(perPrPhaseCall < midDiscoveryDrain, 'mid-discovery drain runs immediately after per-PR enqueue opportunity');
  assert.ok(phaseHelper < lifecycleCleanup, 'ordering lives in the executable phase helper');
  assert.ok(lifecycleCleanup < lifecycleSync, 'merge-agent lifecycle cleanup runs before lifecycle sync');
  assert.ok(lifecycleSync < drainBeforePostedHandlers, 'lifecycle sync runs before reviewer dispatch');
  assert.ok(drainBeforePostedHandlers < postedDrain, 'queued reviewers drain before posted-review handlers');
  assert.ok(postedDrain < dagAutowalk, 'posted-review handoffs remain ahead of post-review maintenance');
  assert.ok(dagAutowalk < maintenanceLoop, 'dag autowalk remains ahead of per-repo maintenance');
  assert.ok(drainBeforePostedHandlers < maintenanceLoop, 'reviewer dispatch does not wait for merge-side maintenance');
  assert.match(
    watcher,
    /activeReviewerCounts: detachedReviewerDispatchTracker\.activeCounts\(\),[\s\S]*onCandidateStarted: detachedReviewerDispatchTracker\.track,/,
    'reviewer drains include detached pre-registration launch reservations in model caps',
  );
});

test('queued reviewer dispatch candidates carry reviewer model for concurrency caps', () => {
  const pollPhases = pollOncePhasesSource();
  const candidateStart = pollPhases.indexOf('const dispatchCandidate = {');
  assert.notEqual(candidateStart, -1, 'reviewer dispatch candidate is constructed');
  const runStart = pollPhases.indexOf('async run() {', candidateStart);
  assert.notEqual(runStart, -1, 'candidate run closure exists');
  const candidateFields = pollPhases.slice(candidateStart, runStart);

  assert.match(
    candidateFields,
    /reviewerModel:\s*route\.reviewerModel/,
    'pooled dispatch candidates must expose reviewerModel so Gemini credential caps apply',
  );
  assert.match(
    candidateFields,
    /wakePriority:\s*watcherWakeMatchesSubject\(/,
    'pooled dispatch candidates must preserve exact wake priority for reviewer scheduling',
  );
});

test('watcher post-review phase behavior drains reviewers first and isolates maintenance failures', async () => {
  const events = [];
  const errors = [];
  const logs = [];

  await runQueuedReviewAdoptionPhase({
    drainReviewerDispatchCandidates: async (reason) => {
      events.push(`drain:${reason}`);
    },
    postedReviewHandlers: [
      {
        repoPath: 'laceyenterprises/adversarial-review',
        prNumber: 365,
        run: async () => {
          events.push('posted-review-handoff');
        },
      },
    ],
    retryPendingMergeAgentLifecycleCleanupsImpl: async () => {
      events.push('lifecycle-cleanup');
    },
    syncPRLifecycleImpl: async () => {
      events.push('lifecycle-sync');
    },
    retryPendingDagAutowalkOnMergeImpl: async () => {
      events.push('dag-autowalk');
    },
    retryPendingMergeCloseoutsImpl: async () => {
      events.push('merge-closeouts');
    },
    retryPendingRetriggerAckCommentsImpl: async () => {
      events.push('remediation-ack');
      return { attempted: 0, posted: 0 };
    },
    retryPendingRetriggerReviewAckCommentsImpl: async () => {
      events.push('review-ack');
      return { attempted: 0, posted: 0 };
    },
    postReviewMaintenanceHandlers: [
      {
        repoPath: 'laceyenterprises/adversarial-review',
        run: async () => {
          events.push('maintenance-a');
          throw new Error('boom');
        },
      },
      {
        repoPath: 'laceyenterprises/agent-os',
        run: async () => {
          events.push('maintenance-b');
        },
      },
    ],
    logger: {
      log: (...args) => logs.push(args.join(' ')),
      error: (...args) => errors.push(args.join(' ')),
    },
  });

  assert.deepEqual(events, [
    'lifecycle-cleanup',
    'lifecycle-sync',
    'drain:posted-review handlers',
    'posted-review-handoff',
    'dag-autowalk',
    'merge-closeouts',
    'remediation-ack',
    'review-ack',
    'maintenance-a',
    'maintenance-b',
  ]);
  assert.equal(logs.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /post-review maintenance failed for laceyenterprises\/adversarial-review/);
  assert.match(errors[0], /boom/);
});

test('watcher caps posted-review phase budget when reviewer dispatch is under pressure', async () => {
  const events = [];
  const warnings = [];
  const fairnessCalls = [];

  await runQueuedReviewAdoptionPhase({
    drainReviewerDispatchCandidates: async (reason) => {
      events.push(`drain:${reason}`);
      return { dispatched: 1, deferred: 2, maxObservedConcurrency: 1 };
    },
    postedReviewHandlers: [
      {
        repoPath: 'laceyenterprises/agent-os',
        prNumber: 6528,
        run: async () => {
          events.push('posted-review-handoff');
        },
      },
    ],
    retryPendingMergeAgentLifecycleCleanupsImpl: async () => {
      events.push('lifecycle-cleanup');
    },
    syncPRLifecycleImpl: async () => {
      events.push('lifecycle-sync');
    },
    retryPendingTriageSyncsImpl: async () => ({ attempted: 0, synced: 0, pending: 0 }),
    retryPendingDagAutowalkOnMergeImpl: async () => {
      events.push('dag-autowalk');
    },
    retryPendingMergeCloseoutsImpl: async () => {
      events.push('merge-closeouts');
    },
    retryPendingRetriggerAckCommentsImpl: async () => ({ attempted: 0, posted: 0 }),
    retryPendingRetriggerReviewAckCommentsImpl: async () => ({ attempted: 0, posted: 0 }),
    runPostedReviewHandlersFairlyImpl: async (args) => {
      fairnessCalls.push(args);
      events.push(`posted-budget:${args.budgetMs}`);
      return {
        queued: args.handlers.length,
        ran: args.handlers.length,
        failed: 0,
        timedOut: 0,
        skippedByLane: 0,
        deferredByBudget: 0,
        deferredAfterTimeout: 0,
        continuedAfterTimeout: 0,
        daemonCleanMerges: 1,
        deferred: [],
      };
    },
    postedReviewPhaseBudgetMs: 600_000,
    postedReviewReviewerPressurePhaseBudgetMs: 120_000,
    logger: {
      log: () => {},
      warn: (...args) => warnings.push(args.join(' ')),
      error: () => {},
    },
  });

  assert.deepEqual(events, [
    'lifecycle-cleanup',
    'lifecycle-sync',
    'drain:posted-review handlers',
    'posted-budget:360000',
    'dag-autowalk',
    'merge-closeouts',
  ]);
  assert.equal(fairnessCalls.length, 1);
  assert.equal(fairnessCalls[0].budgetMs, 360_000);
  assert.equal(fairnessCalls[0].handlers.length, 1);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /raised to handler-capacity floor/);
  assert.match(warnings[1], /posted-review phase budget capped under reviewer pressure/);
  assert.match(warnings[1], /dispatched=1 deferred=2/);
});

test('RVHAND-10: watcher stays quiet when pending handlers run but clean merges stay at zero', async () => {
  const warnings = [];

  await runQueuedReviewAdoptionPhase({
    drainReviewerDispatchCandidates: async () => ({ dispatched: 0, deferred: 0 }),
    retryPendingMergeAgentLifecycleCleanupsImpl: async () => {},
    syncPRLifecycleImpl: async () => {},
    retryPendingTriageSyncsImpl: async () => ({ attempted: 0, synced: 0, pending: 0 }),
    retryPendingDagAutowalkOnMergeImpl: async () => {},
    retryPendingMergeCloseoutsImpl: async () => {},
    retryPendingRetriggerAckCommentsImpl: async () => ({ attempted: 0, posted: 0 }),
    retryPendingRetriggerReviewAckCommentsImpl: async () => ({ attempted: 0, posted: 0 }),
    runPostedReviewHandlersFairlyImpl: async () => ({
      queued: 4,
      ran: 4,
      failed: 0,
      timedOut: 0,
      skippedByLane: 0,
      deferredByBudget: 0,
      deferredAfterTimeout: 0,
      continuedAfterTimeout: 0,
      daemonCleanMerges: 0,
      deferred: [],
    }),
    logger: {
      log: () => {},
      warn: (...args) => warnings.push(args.join(' ')),
      error: () => {},
    },
  });

  assert.equal(warnings.length, 0);
});

test('watcher keeps normal posted-review phase budget when reviewer drain is idle', async () => {
  const fairnessCalls = [];
  const warnings = [];

  await runQueuedReviewAdoptionPhase({
    drainReviewerDispatchCandidates: async () => ({ dispatched: 0, deferred: 0 }),
    retryPendingMergeAgentLifecycleCleanupsImpl: async () => {},
    syncPRLifecycleImpl: async () => {},
    retryPendingTriageSyncsImpl: async () => ({ attempted: 0, synced: 0, pending: 0 }),
    retryPendingDagAutowalkOnMergeImpl: async () => {},
    retryPendingMergeCloseoutsImpl: async () => {},
    retryPendingRetriggerAckCommentsImpl: async () => ({ attempted: 0, posted: 0 }),
    retryPendingRetriggerReviewAckCommentsImpl: async () => ({ attempted: 0, posted: 0 }),
    runPostedReviewHandlersFairlyImpl: async (args) => {
      fairnessCalls.push(args);
      return {
        queued: 0,
        ran: 0,
        failed: 0,
        timedOut: 0,
        skippedByLane: 0,
        deferredByBudget: 0,
        deferredAfterTimeout: 0,
        continuedAfterTimeout: 0,
        deferred: [],
      };
    },
    postedReviewPhaseBudgetMs: 600_000,
    postedReviewReviewerPressurePhaseBudgetMs: 120_000,
    logger: {
      log: () => {},
      warn: (...args) => warnings.push(args.join(' ')),
      error: () => {},
    },
  });

  assert.equal(fairnessCalls.length, 1);
  assert.equal(fairnessCalls[0].budgetMs, 600_000);
  assert.equal(warnings.length, 0);
});
