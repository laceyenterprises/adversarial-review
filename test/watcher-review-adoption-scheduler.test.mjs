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

test('watcher runs merge-side handoffs before queued reviewer dispatches', () => {
  const watcher = watcherSource();
  const phase = postedReviewRowSource();
  const pollPhases = pollOncePhasesSource();

  // Queue initialization is part of pollOnce and stays in watcher.mjs.
  const candidateQueue = watcher.indexOf('const reviewerDispatchCandidates = [];');
  const postedQueue = watcher.indexOf('const postedReviewHandlers = [];');
  // pollOnce drives the per-PR processing phase, which is where the posted
  // handoff is enqueued (ARC-18: the enqueue moved to pollonce-phases.mjs).
  const perPrPhaseCall = watcher.indexOf('await processReviewSubject(subjectEntry, {');
  const postedEnqueue = pollPhases.indexOf('postedReviewHandlers.push({');
  // The executable phase ordering moved into the runQueuedReviewAdoptionPhase
  // helper, now in posted-review-row.mjs.
  const phaseHelper = phase.indexOf('async function runQueuedReviewAdoptionPhase');
  const drainAfterMaintenance = phase.indexOf("await drainReviewerDispatchCandidates('the next reviewer wave');");
  // WPS-01/RVHAND-01: the unbounded `for (const postedReviewHandler of
  // postedReviewHandlers)` loop became a budgeted, lane-gated scheduler call.
  // Lifecycle sync runs ahead of that handler drain so stale terminal rows are
  // not held behind a single slow hammer path.
  const postedDrain = phase.indexOf('await runPostedReviewHandlersFairly({');
  const lifecycleCleanup = phase.indexOf('await retryPendingMergeAgentLifecycleCleanupsImpl();');
  const lifecycleSync = phase.indexOf('await syncPRLifecycleImpl(octokit, operatorSurface, primaryDomainId);');
  const dagAutowalk = phase.indexOf('await retryPendingDagAutowalkOnMergeImpl();');
  const maintenanceLoop = phase.indexOf('for (const postReviewMaintenanceHandler of postReviewMaintenanceHandlers)');

  assert.notEqual(candidateQueue, -1, 'reviewer dispatch candidate queue exists');
  assert.notEqual(postedQueue, -1, 'posted review handoffs are queued');
  assert.notEqual(perPrPhaseCall, -1, 'pollOnce drives the per-PR processing phase');
  assert.notEqual(postedEnqueue, -1, 'posted review rows enqueue their handoff');
  assert.notEqual(phaseHelper, -1, 'post-review phase helper exists');
  assert.notEqual(drainAfterMaintenance, -1, 'reviewer dispatch drain exists after maintenance');
  assert.notEqual(postedDrain, -1, 'queued posted-review handlers drain before reviewers');
  assert.notEqual(lifecycleCleanup, -1, 'merge-agent cleanup still runs');
  assert.notEqual(lifecycleSync, -1, 'lifecycle sync still runs');
  assert.notEqual(dagAutowalk, -1, 'dag autowalk retry still runs');
  assert.notEqual(maintenanceLoop, -1, 'post-review maintenance handlers still run');

  assert.ok(candidateQueue < postedQueue, 'queues are initialized near the reviewer scheduler');
  assert.ok(postedQueue < perPrPhaseCall, 'posted handler queue is initialized before the per-PR phase that enqueues into it');
  assert.ok(phaseHelper < lifecycleCleanup, 'ordering lives in the executable phase helper');
  assert.ok(lifecycleCleanup < lifecycleSync, 'merge-agent lifecycle cleanup runs before lifecycle sync');
  assert.ok(lifecycleSync < postedDrain, 'lifecycle sync runs before posted-review handlers');
  assert.ok(postedDrain < dagAutowalk, 'posted-review handoffs remain ahead of post-review maintenance');
  assert.ok(dagAutowalk < maintenanceLoop, 'dag autowalk remains ahead of per-repo maintenance');
  assert.ok(maintenanceLoop < drainAfterMaintenance, 'reviewer dispatch waits until merge-side maintenance has run');
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
});

test('watcher post-review phase behavior preserves hammer-first ordering and isolates maintenance failures', async () => {
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
    'posted-review-handoff',
    'dag-autowalk',
    'merge-closeouts',
    'remediation-ack',
    'review-ack',
    'maintenance-a',
    'maintenance-b',
    'drain:the next reviewer wave',
  ]);
  assert.equal(logs.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /post-review maintenance failed for laceyenterprises\/adversarial-review/);
  assert.match(errors[0], /boom/);
});
