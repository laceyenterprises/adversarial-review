// REVIEWSPILLSTALL-01 — a spilled review is admitted to the free alternate
// reviewer pool instead of being refunded to a saturated primary lane, and
// review queue depth counts every unreviewed head.
//
// Contracts pinned here (synthetic PRs only):
//   1. Pool 3/8, the single Gemini seat busy, five PRs awaiting re-review:
//      every one of them starts on a non-Gemini class in one drain. A queued
//      duplicate of a head this process is already dispatching does not
//      consume a spill slot.
//   2. A PR reviewed at an older head counts in queue depth.
//   3. A spilled pass the pool defers stays queued on its alternate class,
//      keeps its reservation and is not refunded to Gemini; the next drain
//      starts it there.
//   4. Cycles with a free Gemini seat, and a disarmed lever, behave as before.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createFirstPassSpilloverController } from '../src/review-queue-depth.mjs';
import { createReviewerDispatchDrain } from '../src/watcher-reviewer-dispatch.mjs';
import { createReviewerAdmissionQueue } from '../src/watcher-reviewer-admission.mjs';

const REPO = 'sample/project';
const quiet = { log() {}, warn() {}, error() {} };

function tempRoot(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

async function openSyntheticDb() {
  const { ensureReviewStateSchema, openReviewStateDb } = await import('../src/review-state.mjs');
  const root = tempRoot('reviewspillstall-db-');
  const db = openReviewStateDb(root);
  ensureReviewStateSchema(db);
  return { db, cleanup() { db.close(); rmSync(root, { recursive: true, force: true }); } };
}

// A row whose last delivered review is at `reviewedHead` and whose live
// revision is `currentHead` (the in-place repair shape: status stays posted).
function seedReviewedRow(db, prNumber, {
  status = 'posted', reviewedHead = `old-${prNumber}`, currentHead = `new-${prNumber}`,
  passHead = reviewedHead, state = 'open', draft = 0, labels = null,
} = {}) {
  db.prepare(
    'INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, pr_state, is_draft, review_status,'
    + ' posted_at, revision_ref, reviewer_head_sha, labels_json)'
    + " VALUES (?, ?, '2026-11-01T00:00:00Z', 'gemini', ?, ?, ?, '2026-11-01T00:05:00Z', ?, ?, ?)"
  ).run(REPO, prNumber, state, draft, status, currentHead, reviewedHead, labels);
  db.prepare(
    'INSERT INTO reviewer_passes (repo, pr_number, attempt_number, reviewer_class, reviewer_model,'
    + ' pass_kind, started_at, ended_at, status, body_md, gh_comment_id, head_sha)'
    + " VALUES (?, ?, 1, 'gemini', 'gemini', 'first-pass', '2026-11-01T00:00:00Z',"
    + " '2026-11-01T00:05:00Z', 'completed', 'body', ?, ?)"
  ).run(REPO, prNumber, `synthetic-review-${prNumber}`, passHead);
}

function controllerOver(readDepth, threshold = 1) {
  return createFirstPassSpilloverController({
    readDepth, readRereviewDepth: readDepth,
    resolveThresholdImpl: () => threshold,
    resolveRereviewThresholdImpl: () => threshold,
    logger: quiet, writeFileImpl() {},
  });
}

// Mirrors the production candidate's spill closures: reserve on the
// controller and move to the alternate class; a refund of a queued snapshot
// restores the primary route; a deferred reservation is retained.
function spillCandidate(ctl, prNumber, {
  alternate = 'claude', started, refunds, retained, blockReason = null, waitSeconds = 60,
} = {}) {
  let reserved = false;
  return {
    repoPath: REPO, prNumber, reviewerModel: 'gemini', depthPassKind: 'rereview',
    subject: { headSha: `synthetic-head-${prNumber}` },
    hasPriorPostedReview: true,
    current: { head_wait_started_at: new Date(Date.now() - waitSeconds * 1000).toISOString() },
    admissionBlockReason: () => blockReason,
    admissionBlocked() { return this.admissionBlockReason() !== null; },
    async reevaluateDepthSpill(pressure) {
      if (reserved) return;
      reserved = ctl.recordSpill({ repo: REPO, prNumber, toWorkerClass: alternate,
        passKind: 'rereview', reason: pressure?.reason || 'queue-depth-pressure' });
      if (reserved) this.reviewerModel = alternate;
    },
    refundDepthSpill(reason) {
      refunds?.push([prNumber, reason]);
      if (!reserved) return;
      ctl.refundSpill({ repo: REPO, prNumber, reason });
      reserved = false;
      this.reviewerModel = 'gemini';
    },
    retainDepthSpill(reason) {
      if (!reserved) return false;
      retained?.push([prNumber, reason]);
      return true;
    },
    async run() {
      started?.push([prNumber, this.reviewerModel]);
      if (reserved) ctl.commitSpill({ repo: REPO, prNumber });
      reserved = false;
      return { dispatched: true };
    },
  };
}

function drainFor(queue, ctl, { activeGemini = 1, activeTotal = 3, maxConcurrent = 8, logger = quiet, ...extra } = {}) {
  return createReviewerDispatchDrain({
    reviewerPoolConfig: { enabled: true, maxConcurrent },
    reviewerDispatchCandidates: queue,
    firstPassSpilloverController: ctl,
    detachedReviewerDispatchTracker: {
      activeCounts: () => new Map([['gemini', activeGemini], ['__total__', activeTotal]]),
      track() {},
    },
    readWatcherDrainState: () => ({ active: false }),
    resolveGeminiCredentialConcurrencyForDispatchCandidates: async () => 1,
    singleWaveSettleGraceMs: 0, logger,
    ...extra,
  });
}

test('a retained spill survives a poll with no budget and completes on its original alternate class', async () => {
  const previous = controllerOver(() => 2);
  const current = controllerOver(() => 0);
  const admission = createReviewerAdmissionQueue({ logger: quiet });
  const started = [], refunds = [];
  const retained = spillCandidate(previous, 51, { alternate: 'codex', started, refunds });
  admission.enqueue(retained);
  await drainFor(admission.candidates, previous, {
    async runQueue(candidates) {
      await candidates[0].prepareForGeminiSaturation();
      return { dispatched: 0, deferred: 1, deferredCandidates: candidates,
        deferredReasons: [{ reason: 'rereview-cap-reserves-first-pass-capacity' }] };
    },
  })('initial poll');
  assert.equal(retained.reviewerModel, 'codex');
  admission.enqueue(spillCandidate(current, 51, { started, refunds }));
  assert.deepEqual(admission.candidates, [retained]);
  assert.deepEqual(refunds, []);
  assert.equal(previous.granted(), 1);
  assert.equal(current.granted(), 0);

  await drainFor(admission.candidates, current)('refreshed poll');
  assert.deepEqual(started, [[51, 'codex']]);
  assert.deepEqual(admission.candidates, []);
  assert.equal(previous.refundSpill({ repo: REPO, prNumber: 51 }), false,
    'completion settles the original reservation');
});

test('new spills use the current poll budget while a retained spill keeps its previous reservation', async () => {
  const previous = controllerOver(() => 3);
  const current = controllerOver(() => 1);
  const admission = createReviewerAdmissionQueue({ logger: quiet });
  const started = [], refunds = [];
  const retained = spillCandidate(previous, 61, { alternate: 'codex', started, refunds });
  await retained.reevaluateDepthSpill();
  admission.enqueue(retained);
  admission.enqueue(spillCandidate(current, 61, { started, refunds }));
  admission.enqueue(spillCandidate(current, 62, { started, refunds }));
  admission.enqueue(spillCandidate(current, 63, { started, refunds }));

  await drainFor(admission.candidates, current)('refreshed poll');
  assert.deepEqual(started, [[61, 'codex'], [62, 'claude']]);
  assert.deepEqual(admission.candidates.map(candidate => [candidate.prNumber, candidate.reviewerModel]),
    [[63, 'gemini']]);
  assert.equal(current.granted(), 1, 'new spills spend only the new tick budget');
  assert.equal(current.depthPressure('rereview').remaining, 0);
  assert.deepEqual(refunds, [[63, 'gemini-credential-concurrency-saturated']],
    'only the unspilled candidate reaches ordinary deferred cleanup');
});

test('pool 3/8 with the Gemini seat busy starts every awaiting re-review on a non-Gemini class in one drain', async () => {
  const { countOpenPrsAwaitingReview } = await import('../src/review-state-db.mjs');
  const fixture = await openSyntheticDb();
  try {
    // Five in-place repairs: each PR was reviewed at an older head and its
    // row stayed posted when the repair head landed.
    for (const prNumber of [11, 12, 13, 14, 15]) seedReviewedRow(fixture.db, prNumber);
    assert.equal(countOpenPrsAwaitingReview(fixture.db), 5);
    const ctl = controllerOver(() => countOpenPrsAwaitingReview(fixture.db));
    assert.equal(ctl.plan('rereview').spillSlots, 5);

    const started = [];
    const refunds = [];
    // A refreshed snapshot of a head already under review in this process.
    // Queued first, it must not take a slot from a PR that can actually start.
    const duplicate = spillCandidate(ctl, 15, { started, refunds, blockReason: 'head-dispatch-lease-held' });
    const queue = [duplicate, ...[11, 12, 13, 14, 15].map((prNumber, index) => spillCandidate(ctl, prNumber, {
      alternate: index % 2 ? 'codex' : 'claude', started, refunds,
    }))];
    const logs = [];
    const result = await drainFor(queue, ctl, { logger: { log: line => logs.push(line), warn() {} } })('synthetic admission');

    assert.equal(result.dispatched, 5);
    assert.ok(started.length >= 4, 'at least four spilled reviews start in one cycle');
    assert.deepEqual(started.map(([prNumber]) => prNumber).sort(), [11, 12, 13, 14, 15]);
    assert.ok(started.every(([, model]) => model !== 'gemini'), JSON.stringify(started));
    assert.equal(ctl.granted(), 5, 'the blocked duplicate reserved no spill slot');
    assert.deepEqual(queue, [duplicate], 'the duplicate waits for the in-flight review');
    assert.equal(duplicate.reviewerModel, 'gemini');
    assert.ok(refunds.every(([, reason]) => reason !== 'pool-admission-deferred'), JSON.stringify(refunds));
  } finally {
    fixture.cleanup();
  }
});

test('a PR reviewed at an older head counts in review queue depth; a covered head does not', async () => {
  const {
    countOpenPrsAwaitingFirstPassReview, countOpenPrsAwaitingRereview, countOpenPrsAwaitingReview,
  } = await import('../src/review-state-db.mjs');
  const fixture = await openSyntheticDb();
  try {
    const { db } = fixture;
    seedReviewedRow(db, 21); // reviewed at old-21, current head new-21: awaiting review
    seedReviewedRow(db, 22, { currentHead: 'old-22' }); // current head already reviewed
    seedReviewedRow(db, 23, { passHead: 'new-23' }); // a delivered review covers the new head
    seedReviewedRow(db, 24, { labels: '["no-merge-hold"]' }); // operator hold
    seedReviewedRow(db, 25, { draft: 1 }); // draft
    seedReviewedRow(db, 26, { currentHead: '' }); // no recorded current head
    seedReviewedRow(db, 27, { state: 'merged' }); // not open
    seedReviewedRow(db, 28, { status: 'malformed' }); // refused work
    seedReviewedRow(db, 29, { status: 'reviewing' }); // already admitted
    // The existing re-armed shape still counts exactly once.
    seedReviewedRow(db, 30, { status: 'pending' });
    db.prepare("UPDATE reviewed_prs SET posted_at = NULL WHERE pr_number = 30").run();

    assert.equal(countOpenPrsAwaitingRereview(db), 3, 'rereview lane: 21, 25 (draft filtered later) and 30');
    assert.equal(countOpenPrsAwaitingReview(db), 2, 'actionable depth: 21 and 30');
    assert.equal(countOpenPrsAwaitingFirstPassReview(db), 0, 'the first-pass pager population is unchanged');
  } finally {
    fixture.cleanup();
  }
});

test('a pool-deferred spill stays queued on its alternate class with its reservation and starts there next drain', async () => {
  const ctl = controllerOver(() => 1);
  const started = [];
  const refunds = [];
  const retained = [];
  const spilled = spillCandidate(ctl, 41, { started, refunds, retained });
  const queue = [spilled];
  let drains = 0;
  const logs = [];
  const drain = drainFor(queue, ctl, {
    logger: { log: line => logs.push(line), warn() {} },
    async runQueue(candidates, options) {
      if (++drains > 1) {
        const { runBoundedReviewerDispatchQueue } = await import('../src/watcher-reviewer-pool.mjs');
        return runBoundedReviewerDispatchQueue(candidates, options);
      }
      // The alternate class is at its own limit this drain: the pass was
      // spilled, then the pool deferred it.
      await candidates[0].prepareForGeminiSaturation();
      return {
        dispatched: 0, deferred: 1, deferredCandidates: [candidates[0]],
        deferredReasons: [{ reason: 'rereview-cap-reserves-first-pass-capacity' }],
      };
    },
  });

  await drain('synthetic admission');
  assert.equal(spilled.reviewerModel, 'claude');
  assert.deepEqual(queue, [spilled]);
  assert.deepEqual(refunds, [], 'a deferred spill is not refunded to Gemini');
  assert.deepEqual(retained, [[41, 'rereview-cap-reserves-first-pass-capacity']]);
  assert.equal(ctl.granted(), 1);
  assert.equal(ctl.depthPressure('rereview').remaining, 0, 'the slot stays with the queued spill');

  // Gemini is still saturated; the retained pass starts on its own class.
  await drain('capacity-freed');
  assert.deepEqual(started, [[41, 'claude']]);
  assert.deepEqual(queue, []);
  assert.deepEqual(refunds, []);
});

test('a refused spill is refunded under its refusal reason, never the generic not-started label', async () => {
  const ctl = controllerOver(() => 1);
  const refunds = [];
  const candidate = spillCandidate(ctl, 51, { refunds });
  candidate.run = async () => ({ dispatched: false, reason: 'claim-race-lost' });
  const queue = [candidate];
  await drainFor(queue, ctl)('synthetic admission');
  assert.deepEqual(refunds, [[51, 'claim-race-lost']]);
  assert.equal(ctl.granted(), 0);
});

test('a free Gemini seat, or a disarmed lever, admits exactly as before', async () => {
  // Free seat: the cheap primary takes the pass; nothing is reserved.
  const armed = controllerOver(() => 5);
  const started = [];
  const refunds = [];
  const retained = [];
  const queue = [spillCandidate(armed, 61, { started, refunds, retained })];
  const result = await drainFor(queue, armed, { activeGemini: 0, activeTotal: 2 })('synthetic admission');
  assert.equal(result.dispatched, 1);
  assert.deepEqual(started, [[61, 'gemini']]);
  assert.equal(armed.granted(), 0);
  assert.deepEqual(retained, []);

  // Disarmed lever with a saturated seat: the pass waits for Gemini.
  const disarmed = controllerOver(() => 5, null);
  const waiting = spillCandidate(disarmed, 62, { started, refunds, retained });
  const waitingQueue = [waiting];
  const deferred = await drainFor(waitingQueue, disarmed)('synthetic admission');
  assert.equal(deferred.dispatched, 0);
  assert.equal(deferred.deferredReasons[0].reason, 'gemini-credential-concurrency-saturated');
  assert.equal(waiting.reviewerModel, 'gemini');
  assert.deepEqual(waitingQueue, [waiting]);
  assert.equal(disarmed.granted(), 0);
  assert.deepEqual(retained, []);
  assert.deepEqual(refunds, [[62, 'gemini-credential-concurrency-saturated']]);
});
