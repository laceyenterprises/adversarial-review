// WPS-01 regression suite — new-PR discovery must survive a backlog of PRs the
// poll loop cannot advance, and a starved loop must page.
//
// Incident being regressed (agent-os#5915): a live watcher, 0% CPU, no child
// processes, `poll_counter` frozen, one tick in flight for 40+ minutes. Three
// `posted` PRs with a `stale-review-head` gate were re-walked every tick — 72 of
// the last 400 log lines, 13 auto-hammer dispatches in the last 2000 — while a
// brand-new PR got zero log lines and zero `reviews.db` rows. Not stuck in
// review: never seen. Every component was individually correct; the composition
// starved the loop.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createWatcherHeartbeat,
  createWatcherStallWatchdog,
} from '../src/watcher-heartbeat.mjs';
import {
  DEFAULT_NO_PROGRESS_LANE_CAP,
  DEFAULT_OPERATOR_BLOCKED_ALERT_NO_PROGRESS_TICKS,
  DEFAULT_OPERATOR_BLOCKED_REWALK_TICKS,
  LANE_ACTIVE,
  LANE_OPERATOR_BLOCKED,
  LANE_SLOW,
  PROGRESS_CLASS_OPERATOR_DECISION_REQUIRED,
  backoffTicksFor,
  clearNoProgressLane,
  evaluateNoProgressLane,
  maybeFireOperatorDecisionRequiredAlert,
  noProgressLaneFilePath,
  operatorDecisionAlertStateDir,
  readNoProgressLane,
  recordNoProgressLaneRun,
  recordNoProgressLaneSkip,
  subjectProgressFingerprint,
} from '../src/watcher-no-progress-lane.mjs';
import {
  createPostedReviewFairnessState,
  orderSubjectEntriesDiscoveryFirst,
  runPostedReviewHandlersFairly,
} from '../src/watcher-poll-fairness.mjs';
import { createNoProgressLaneGate } from '../src/posted-review-row.mjs';
import {
  createPollStarvationHandler,
  resolvePollStarvationConfig,
} from '../src/watcher-poll-starvation-signal.mjs';
import { processReviewSubject } from '../src/pollonce-phases.mjs';

const HEAD_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HEAD_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const REPO = 'laceyenterprises/agent-os';

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'wps-01-'));
}

const silentLogger = { log() {}, warn() {}, error() {} };

// ── The required regression fixture ──────────────────────────────────────────
//
// N unadvanceable PRs plus one new PR. The new PR must be ingested within ONE
// tick, and every tick must terminate so the NEXT tick's discovery can run.
//
// Without the fix this test cannot pass: `orderSubjectEntriesDiscoveryFirst` is
// what puts the never-seen PR ahead of a backlog that the pre-existing
// `compareReviewerDispatchCandidates` sort orders oldest-created-FIRST, and the
// per-handler deadline in `runPostedReviewHandlersFairly` is what stops PR 5911's
// never-settling handler from wedging the tick the way the live one did.

function buildStarvationFixture() {
  const laneRoot = tempRoot();
  const rows = new Map();
  const fairness = createPostedReviewFairnessState();
  const walked = [];
  const handlerRuns = [];
  let tick = 0;

  const key = (prNumber) => `${REPO}#${prNumber}`;

  // Three PRs that mirror #5908/#5909/#5911: settled `posted` rows whose handler
  // completes cleanly every tick and changes precisely nothing (correct
  // auto-hammer refusal + correct closer-commit-identity suppression).
  for (const prNumber of [5908, 5909, 5911]) {
    rows.set(key(prNumber), {
      review_status: 'posted',
      pr_state: 'open',
      reviewer_head_sha: HEAD_A,
      review_attempts: 1,
      posted_at: '2026-08-25T10:00:00.000Z',
      failed_at: null,
      merged_at: null,
    });
  }
  // One PR whose handler never settles at all — the shape that froze the live
  // tick for 40 minutes.
  rows.set(key(5912), {
    review_status: 'posted',
    pr_state: 'open',
    reviewer_head_sha: HEAD_A,
    review_attempts: 1,
    posted_at: '2026-08-25T10:00:00.000Z',
    failed_at: null,
    merged_at: null,
  });

  const laneGate = {
    evaluate(handler) {
      const identity = { repo: handler.repoPath, prNumber: handler.prNumber };
      const decision = evaluateNoProgressLane(
        readNoProgressLane(laneRoot, identity, { logger: silentLogger }),
        { headSha: handler.headSha },
      );
      if (!decision.due) {
        recordNoProgressLaneSkip(laneRoot, identity, {
          headSha: handler.headSha,
          now: `tick-${tick}`,
          logger: silentLogger,
        });
      }
      return { run: decision.due, ...decision };
    },
    record(handler, { timedOut = false } = {}) {
      const identity = { repo: handler.repoPath, prNumber: handler.prNumber };
      const fingerprint = timedOut
        ? 'timed-out'
        : subjectProgressFingerprint(rows.get(key(handler.prNumber)), {
          headSha: handler.headSha,
        });
      return recordNoProgressLaneRun(laneRoot, identity, {
        headSha: handler.headSha,
        fingerprint,
        now: `tick-${tick}`,
        logger: silentLogger,
      });
    },
  };

  // One tick, in pollOnce's real phase order: discover + per-subject ingest,
  // then run the queued posted-review handlers.
  async function runTick(subjectEntries) {
    tick += 1;
    const ordered = orderSubjectEntriesDiscoveryFirst(subjectEntries, {
      hasReviewRow: (entry) => rows.has(key(entry.prNumber)),
      logger: silentLogger,
    });
    const postedHandlers = [];
    for (const entry of ordered) {
      walked.push({ tick, prNumber: entry.prNumber });
      if (!rows.has(key(entry.prNumber))) {
        // Ingest: the `reviewed_prs` row that #5915 never got.
        rows.set(key(entry.prNumber), {
          review_status: 'pending',
          pr_state: 'open',
          reviewer_head_sha: null,
          review_attempts: 0,
          posted_at: null,
          failed_at: null,
          merged_at: null,
          ingestedOnTick: tick,
        });
        continue;
      }
      const row = rows.get(key(entry.prNumber));
      if (row.review_status !== 'posted') continue;
      postedHandlers.push({
        repoPath: REPO,
        prNumber: entry.prNumber,
        headSha: entry.headSha,
        run: async () => {
          handlerRuns.push({ tick, prNumber: entry.prNumber });
          // #5912 never settles; the rest return having changed nothing.
          if (entry.prNumber === 5912) return new Promise(() => {});
          return undefined;
        },
      });
    }
    const summary = await runPostedReviewHandlersFairly({
      handlers: postedHandlers,
      state: fairness,
      budgetMs: 60_000,
      handlerTimeoutMs: 25,
      laneGate,
      logger: silentLogger,
    });
    return summary;
  }

  return {
    laneRoot,
    rows,
    walked,
    handlerRuns,
    runTick,
    key,
    cleanup: () => rmSync(laneRoot, { recursive: true, force: true }),
  };
}

test('WPS-01: a new PR is ingested on the first tick despite a backlog of unadvanceable PRs', async () => {
  const fixture = buildStarvationFixture();
  try {
    // GitHub hands back the backlog first — and the pool-disabled watcher sort
    // is oldest-created-first, so the new PR would otherwise be walked LAST.
    const subjects = [5908, 5909, 5911, 5912, 5915].map((prNumber) => ({
      prNumber,
      headSha: HEAD_A,
    }));

    const summary = await fixture.runTick(subjects);

    const newRow = fixture.rows.get(fixture.key(5915));
    assert.ok(newRow, 'the new PR must have a review row after one tick');
    assert.equal(newRow.ingestedOnTick, 1, 'ingest must happen on the tick the PR appears');

    const firstWalked = fixture.walked.filter((entry) => entry.tick === 1)[0];
    assert.equal(
      firstWalked.prNumber,
      5915,
      'the never-reviewed PR is walked before the already-tracked backlog',
    );

    // The tick TERMINATED even though one handler never settles. That is the
    // whole point: a tick that does not return never discovers anything again.
    assert.equal(summary.timedOut, 1, 'the never-settling handler is abandoned, not awaited forever');
    assert.equal(summary.ran, 3, 'the three completing handlers still ran in full');
  } finally {
    fixture.cleanup();
  }
});

test('WPS-01: unadvanceable PRs back off to the slow lane while the new PR keeps full speed', async () => {
  const fixture = buildStarvationFixture();
  try {
    const subjects = [5908, 5909, 5911, 5912, 5915].map((prNumber) => ({
      prNumber,
      headSha: HEAD_A,
    }));

    let sawLaneSkip = false;
    for (let i = 0; i < 8; i += 1) {
      const summary = await fixture.runTick(subjects);
      if (summary.skippedByLane > 0) sawLaneSkip = true;
    }

    assert.ok(
      sawLaneSkip,
      'PRs that produce no state change for consecutive ticks must stop being re-walked every tick',
    );

    // Bounded, not dropped: every backlog PR is still walked repeatedly across
    // the run, and its ledger is on disk for the operator to read.
    for (const prNumber of [5908, 5909, 5911]) {
      const runs = fixture.handlerRuns.filter((entry) => entry.prNumber === prNumber);
      assert.ok(runs.length >= 4, `#${prNumber} is still re-walked on a slower cadence`);
      assert.ok(runs.length < 8, `#${prNumber} is no longer re-walked on every single tick`);
      const ledger = readNoProgressLane(fixture.laneRoot, { repo: REPO, prNumber }, { logger: silentLogger });
      assert.equal(ledger.lane, LANE_SLOW, `#${prNumber} lane state is visible on disk`);
    }

    // The new PR moved (pending, then reviewed) and never entered the lane at all.
    const newLedger = readNoProgressLane(
      fixture.laneRoot,
      { repo: REPO, prNumber: 5915 },
      { logger: silentLogger },
    );
    assert.equal(newLedger, null, 'a PR that never queued a posted-review handler is never demoted');
  } finally {
    fixture.cleanup();
  }
});

test('WPS-01: terminal PR cleanup removes no-progress lane ledger', () => {
  const rootDir = tempRoot();
  try {
    const identity = { repo: REPO, prNumber: 5908 };
    recordNoProgressLaneRun(rootDir, identity, {
      headSha: HEAD_A,
      fingerprint: 'same-state',
      now: 'tick-1',
      logger: silentLogger,
    });
    assert.equal(existsSync(noProgressLaneFilePath(rootDir, identity)), true);

    assert.equal(clearNoProgressLane(rootDir, identity, { logger: silentLogger }), true);
    assert.equal(readNoProgressLane(rootDir, identity, { logger: silentLogger }), null);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

// Retargeted: this asserted the handler picked up a top-level `entry.headSha`,
// and its fixture supplied one. Real subjectEntries (watcher.mjs) are
// `{ subjectRef, subject, prNumber }` and have no such field, so the assertion
// could only ever pass against a fixture that did not resemble production --
// which is how a null head reached `recordNoProgressLaneRun` unnoticed.
test('WPS-01: processReviewSubject queues posted-review handler with the SUBJECT head SHA', async () => {
  const rootDir = tempRoot();
  const postedReviewHandlers = [];
  // Production shape: the head lives on `subject`, and the entry has none.
  const subject = {
    title: '[codex] WPS fixture',
    labels: [],
    headSha: HEAD_A,
    ref: { revisionRef: HEAD_A },
  };
  const row = {
    review_status: 'posted',
    pr_state: 'open',
    reviewer_head_sha: HEAD_A,
    review_attempts: 1,
    posted_at: '2026-08-25T10:00:00.000Z',
    failed_at: null,
    merged_at: null,
  };

  try {
    await processReviewSubject({
      // No top-level `headSha`: watcher.mjs builds
      // `{ subjectRef, subject, prNumber }`, so supplying one here would let a
      // wrong property name pass the test while nulling the head in production.
      subject,
      prNumber: 5908,
      current: row,
    }, {
      operatorSurface: { extractLinearTicketId: () => null },
      watcherDrain: { active: false },
      postedReviewHandlers,
      domainId: 'github-pr',
      repoPath: REPO,
      currentRepoPRs: [],
      activeMergeAgentPRs: [],
      ROOT: rootDir,
      execFileAsync: async () => ({ stdout: '', stderr: '' }),
      WATCHER_PRIMARY_DOMAIN_ID: 'github-pr',
    });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }

  assert.equal(postedReviewHandlers.length, 1);
  assert.equal(postedReviewHandlers[0].headSha, HEAD_A);
});

// ── Discovery-first ordering ─────────────────────────────────────────────────

test('orderSubjectEntriesDiscoveryFirst promotes never-reviewed PRs and is otherwise stable', () => {
  const entries = [
    { prNumber: 1 },
    { prNumber: 2 },
    { prNumber: 3 },
    { prNumber: 4 },
  ];
  const known = new Set([1, 3]);
  const ordered = orderSubjectEntriesDiscoveryFirst(entries, {
    hasReviewRow: (entry) => known.has(entry.prNumber),
    logger: silentLogger,
  });
  assert.deepEqual(
    ordered.map((entry) => entry.prNumber),
    [2, 4, 1, 3],
    'undiscovered first, each group keeping its incoming order',
  );
});

test('orderSubjectEntriesDiscoveryFirst is a no-op when every PR is in the same group', () => {
  const entries = [{ prNumber: 1 }, { prNumber: 2 }];
  assert.equal(
    orderSubjectEntriesDiscoveryFirst(entries, { hasReviewRow: () => true, logger: silentLogger }),
    entries,
  );
  assert.equal(
    orderSubjectEntriesDiscoveryFirst(entries, { hasReviewRow: () => false, logger: silentLogger }),
    entries,
  );
});

test('orderSubjectEntriesDiscoveryFirst fails toward already-discovered when the lookup throws', () => {
  const entries = [{ prNumber: 1 }, { prNumber: 2 }];
  const ordered = orderSubjectEntriesDiscoveryFirst(entries, {
    hasReviewRow: (entry) => {
      if (entry.prNumber === 1) throw new Error('db is busy');
      return false;
    },
    logger: silentLogger,
  });
  assert.deepEqual(
    ordered.map((entry) => entry.prNumber),
    [2, 1],
    'a lookup fault must not let a bad probe reshuffle the whole tick',
  );
});

test('discovery-first review-row callback caches the fetched row on the entry', () => {
  const row = { review_status: 'posted' };
  const entry = { prNumber: 42 };
  let reads = 0;

  const ordered = orderSubjectEntriesDiscoveryFirst([entry], {
    hasReviewRow: (candidate) => Boolean(candidate.current ?? (candidate.current = (() => {
      reads += 1;
      return row;
    })())),
    logger: silentLogger,
  });

  assert.equal(ordered[0], entry);
  assert.equal(reads, 1);
  assert.equal(entry.current, row);
});

// ── Posted-review phase budget + per-handler deadline ────────────────────────

test('runPostedReviewHandlersFairly defers the tail when the budget runs out and rotates it next tick', async () => {
  const state = createPostedReviewFairnessState();
  let clock = 0;
  const ran = [];
  const handlers = [1, 2, 3, 4].map((prNumber) => ({
    repoPath: REPO,
    prNumber,
    headSha: HEAD_A,
    run: async () => {
      ran.push(prNumber);
      clock += 60;
    },
  }));

  const first = await runPostedReviewHandlersFairly({
    handlers,
    state,
    budgetMs: 100,
    nowMs: () => clock,
    logger: silentLogger,
  });
  assert.deepEqual(ran, [1, 2]);
  assert.equal(first.deferredByBudget, 2);
  assert.deepEqual(first.deferred.sort(), [`${REPO}#3`, `${REPO}#4`]);

  clock = 0;
  ran.length = 0;
  const second = await runPostedReviewHandlersFairly({
    handlers,
    state,
    budgetMs: 100,
    nowMs: () => clock,
    logger: silentLogger,
  });
  assert.deepEqual(ran, [3, 4], 'handlers cut off by the budget lead the next tick');
  assert.equal(second.deferredByBudget, 2);
  assert.deepEqual(second.deferred.sort(), [`${REPO}#1`, `${REPO}#2`]);
});

test('runPostedReviewHandlersFairly preserves deferred order across more than two budgeted ticks', async () => {
  const state = createPostedReviewFairnessState();
  let clock = 0;
  const ran = [];
  const handlers = [1, 2, 3].map((prNumber) => ({
    repoPath: REPO,
    prNumber,
    headSha: HEAD_A,
    run: async () => {
      ran.push(prNumber);
      clock += 60;
    },
  }));

  for (const expected of [1, 2, 3, 1, 2, 3]) {
    clock = 0;
    ran.length = 0;
    const summary = await runPostedReviewHandlersFairly({
      handlers,
      state,
      budgetMs: 50,
      nowMs: () => clock,
      logger: silentLogger,
    });
    assert.deepEqual(ran, [expected]);
    assert.equal(summary.deferredByBudget, 2);
  }
});

test('runPostedReviewHandlersFairly bounds a single never-settling handler', async () => {
  const ran = [];
  const summary = await runPostedReviewHandlersFairly({
    handlers: [
      { repoPath: REPO, prNumber: 1, headSha: HEAD_A, run: () => new Promise(() => {}) },
      { repoPath: REPO, prNumber: 2, headSha: HEAD_A, run: async () => { ran.push(2); } },
    ],
    handlerTimeoutMs: 25,
    logger: silentLogger,
  });
  assert.equal(summary.timedOut, 1);
  assert.equal(summary.ran, 1);
  assert.deepEqual(ran, [2], 'the handler behind the wedged one still runs');
});

test('runPostedReviewHandlersFairly isolates a throwing handler', async () => {
  const ran = [];
  const summary = await runPostedReviewHandlersFairly({
    handlers: [
      { repoPath: REPO, prNumber: 1, headSha: HEAD_A, run: async () => { throw new Error('boom'); } },
      { repoPath: REPO, prNumber: 2, headSha: HEAD_A, run: async () => { ran.push(2); } },
    ],
    logger: silentLogger,
  });
  assert.equal(summary.failed, 1);
  assert.equal(summary.ran, 1);
  assert.deepEqual(ran, [2]);
});

test('runPostedReviewHandlersFairly runs the handler when the lane gate faults', async () => {
  const ran = [];
  const summary = await runPostedReviewHandlersFairly({
    handlers: [{ repoPath: REPO, prNumber: 1, headSha: HEAD_A, run: async () => { ran.push(1); } }],
    laneGate: {
      evaluate() { throw new Error('ledger unreadable'); },
      record() {},
    },
    logger: silentLogger,
  });
  assert.equal(summary.ran, 1);
  assert.deepEqual(ran, [1], 'a lane fault must never suppress a PR');
});

// ── No-progress lane ─────────────────────────────────────────────────────────

test('no-progress lane demotes only after the cap, and any state change resets it', () => {
  const rootDir = tempRoot();
  try {
    const identity = { repo: REPO, prNumber: 5909 };
    const stuck = subjectProgressFingerprint(
      { review_status: 'posted', pr_state: 'open', reviewer_head_sha: HEAD_A, review_attempts: 1 },
      { headSha: HEAD_A },
    );

    let outcome = null;
    for (let i = 0; i <= DEFAULT_NO_PROGRESS_LANE_CAP; i += 1) {
      outcome = recordNoProgressLaneRun(rootDir, identity, {
        headSha: HEAD_A,
        fingerprint: stuck,
        now: `t${i}`,
        logger: silentLogger,
      });
      assert.equal(outcome.lane, LANE_ACTIVE, `tick ${i} is still full speed`);
    }
    outcome = recordNoProgressLaneRun(rootDir, identity, {
      headSha: HEAD_A,
      fingerprint: stuck,
      now: 'demote',
      logger: silentLogger,
    });
    assert.equal(outcome.lane, LANE_SLOW);
    assert.equal(outcome.demoted, true);
    assert.equal(outcome.progressed, false);

    // Any observable change puts it straight back to full speed.
    const moved = subjectProgressFingerprint(
      { review_status: 'posted', pr_state: 'merged', reviewer_head_sha: HEAD_A, review_attempts: 1 },
      { headSha: HEAD_A },
    );
    const recovered = recordNoProgressLaneRun(rootDir, identity, {
      headSha: HEAD_A,
      fingerprint: moved,
      now: 'moved',
      logger: silentLogger,
    });
    assert.equal(recovered.lane, LANE_ACTIVE);
    assert.equal(recovered.progressed, true);
    assert.equal(recovered.noProgressTicks, 0);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('no-progress lane treats a new head as fresh evidence and walks it immediately', () => {
  const rootDir = tempRoot();
  try {
    const identity = { repo: REPO, prNumber: 5909 };
    const stuck = 'stuck-fingerprint';
    for (let i = 0; i < DEFAULT_NO_PROGRESS_LANE_CAP + 3; i += 1) {
      recordNoProgressLaneRun(rootDir, identity, {
        headSha: HEAD_A,
        fingerprint: stuck,
        now: `t${i}`,
        logger: silentLogger,
      });
    }
    const demoted = evaluateNoProgressLane(
      readNoProgressLane(rootDir, identity, { logger: silentLogger }),
      { headSha: HEAD_A },
    );
    assert.equal(demoted.lane, LANE_SLOW);
    assert.equal(demoted.due, false, 'a demoted head waits out its backoff');

    const newHead = evaluateNoProgressLane(
      readNoProgressLane(rootDir, identity, { logger: silentLogger }),
      { headSha: HEAD_B },
    );
    assert.equal(newHead.due, true, 'a new head is never held back');
    assert.equal(newHead.reason, 'head-changed');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('no-progress lane backoff is bounded, so a demoted PR is never dropped', () => {
  assert.equal(backoffTicksFor(DEFAULT_NO_PROGRESS_LANE_CAP), 0, 'at the cap it is still active');
  assert.equal(backoffTicksFor(DEFAULT_NO_PROGRESS_LANE_CAP + 1), 1);
  assert.equal(backoffTicksFor(DEFAULT_NO_PROGRESS_LANE_CAP + 2), 2);
  assert.equal(backoffTicksFor(DEFAULT_NO_PROGRESS_LANE_CAP + 3), 4);
  // Saturates at the ceiling however long the series runs — an hour at the
  // production 5m interval, never longer.
  assert.equal(backoffTicksFor(DEFAULT_NO_PROGRESS_LANE_CAP + 500, { maxBackoffTicks: 12 }), 12);
  assert.ok(Number.isFinite(backoffTicksFor(1e9)));
});

test('no-progress lane skips walk a demoted PR back toward due', () => {
  const rootDir = tempRoot();
  try {
    const identity = { repo: REPO, prNumber: 5909 };
    for (let i = 0; i < DEFAULT_NO_PROGRESS_LANE_CAP + 2; i += 1) {
      recordNoProgressLaneRun(rootDir, identity, {
        headSha: HEAD_A,
        fingerprint: 'stuck',
        now: `t${i}`,
        logger: silentLogger,
      });
    }
    const backoff = evaluateNoProgressLane(
      readNoProgressLane(rootDir, identity, { logger: silentLogger }),
      { headSha: HEAD_A },
    ).backoffTicks;
    assert.ok(backoff >= 1);
    for (let i = 0; i < backoff; i += 1) {
      recordNoProgressLaneSkip(rootDir, identity, { headSha: HEAD_A, now: `s${i}`, logger: silentLogger });
    }
    const due = evaluateNoProgressLane(
      readNoProgressLane(rootDir, identity, { logger: silentLogger }),
      { headSha: HEAD_A },
    );
    assert.equal(due.due, true, 'the backoff always expires — the PR is deferred, never dropped');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('operator-blocked lane keeps a flat re-walk cadence instead of escalating backoff', () => {
  const rootDir = tempRoot();
  try {
    const identity = { repo: REPO, prNumber: 6028 };
    for (let i = 0; i < DEFAULT_NO_PROGRESS_LANE_CAP + 20; i += 1) {
      const outcome = recordNoProgressLaneRun(rootDir, identity, {
        headSha: HEAD_A,
        fingerprint: 'operator-parked',
        progressClass: PROGRESS_CLASS_OPERATOR_DECISION_REQUIRED,
        now: `t${i}`,
        logger: silentLogger,
      });
      assert.equal(outcome.lane, LANE_OPERATOR_BLOCKED);
      assert.equal(outcome.backoffTicks, DEFAULT_OPERATOR_BLOCKED_REWALK_TICKS);
    }

    const decision = evaluateNoProgressLane(
      readNoProgressLane(rootDir, identity, { logger: silentLogger }),
      { headSha: HEAD_A },
    );
    assert.equal(decision.lane, LANE_OPERATOR_BLOCKED);
    assert.equal(decision.due, false);
    assert.equal(decision.backoffTicks, DEFAULT_OPERATOR_BLOCKED_REWALK_TICKS);

    for (let i = 0; i < DEFAULT_OPERATOR_BLOCKED_REWALK_TICKS; i += 1) {
      recordNoProgressLaneSkip(rootDir, identity, { headSha: HEAD_A, now: `s${i}`, logger: silentLogger });
    }
    assert.equal(
      evaluateNoProgressLane(
        readNoProgressLane(rootDir, identity, { logger: silentLogger }),
        { headSha: HEAD_A },
      ).due,
      true,
      'operator-blocked PRs stay on a fixed re-walk interval',
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('operator-decision alert fires once after threshold, not every tick', async () => {
  const rootDir = tempRoot();
  try {
    const identity = { repo: REPO, prNumber: 6028 };
    const alerts = [];
    const deliverAlertFn = async (text, meta) => { alerts.push({ text, meta }); };

    assert.equal(await maybeFireOperatorDecisionRequiredAlert({
      rootDir,
      identity,
      headSha: HEAD_A,
      noProgressTicks: DEFAULT_OPERATOR_BLOCKED_ALERT_NO_PROGRESS_TICKS - 1,
      deliverAlertFn,
      logger: silentLogger,
    }), false);
    assert.equal(alerts.length, 0);

    assert.equal(await maybeFireOperatorDecisionRequiredAlert({
      rootDir,
      identity,
      headSha: HEAD_A,
      noProgressTicks: DEFAULT_OPERATOR_BLOCKED_ALERT_NO_PROGRESS_TICKS,
      firstNoProgressAt: '2026-08-31T12:00:00.000Z',
      deliverAlertFn,
      logger: silentLogger,
      now: Date.parse('2026-08-31T13:00:00.000Z'),
    }), true);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].meta.event, 'adversarial_review.operator_decision_required');
    assert.equal(alerts[0].meta.payload.prNumber, 6028);
    assert.match(alerts[0].text, /parked awaiting operator decision/);

    assert.equal(await maybeFireOperatorDecisionRequiredAlert({
      rootDir,
      identity,
      headSha: HEAD_A,
      noProgressTicks: DEFAULT_OPERATOR_BLOCKED_ALERT_NO_PROGRESS_TICKS + 50,
      deliverAlertFn,
      logger: silentLogger,
    }), false);
    assert.equal(alerts.length, 1, 'debounce state suppresses same PR/head repeats');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('no-progress gate classifies operator decision required and pages once', async () => {
  const rootDir = tempRoot();
  try {
    const identity = { repo: REPO, prNumber: 6028 };
    const alerts = [];
    const gate = createNoProgressLaneGate({
      rootDir,
      readReviewRow: () => ({
        review_status: 'posted',
        pr_state: 'open',
        reviewer_head_sha: HEAD_A,
        review_attempts: 1,
        posted_at: '2026-08-31T07:00:00.000Z',
        failed_at: null,
        merged_at: null,
      }),
      now: () => '2026-08-31T13:00:00.000Z',
      deliverAlertFn: async (text, meta) => { alerts.push({ text, meta }); },
      logger: silentLogger,
    });
    const handler = { repoPath: identity.repo, prNumber: identity.prNumber, headSha: HEAD_A };
    const value = {
      gateDecision: {
        state: 'success',
        reason: 'remediation-stopped',
        operatorDecisionRequired: true,
      },
    };

    for (let i = 0; i < DEFAULT_OPERATOR_BLOCKED_ALERT_NO_PROGRESS_TICKS + 2; i += 1) {
      await gate.record(handler, { value });
    }
    const ledger = readNoProgressLane(rootDir, identity, { logger: silentLogger });
    assert.equal(ledger.lane, LANE_OPERATOR_BLOCKED);
    assert.equal(ledger.progressClass, PROGRESS_CLASS_OPERATOR_DECISION_REQUIRED);
    assert.equal(alerts.length, 1);

    await gate.record(handler, { value });
    assert.equal(alerts.length, 1, 'operator decision alert does not repeat every tick');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('operator decision alert delivery failure does not persist debounce state', async () => {
  const rootDir = tempRoot();
  try {
    const identity = { repo: REPO, prNumber: 6028 };
    await assert.rejects(
      maybeFireOperatorDecisionRequiredAlert({
        rootDir,
        identity,
        headSha: HEAD_A,
        noProgressTicks: DEFAULT_OPERATOR_BLOCKED_ALERT_NO_PROGRESS_TICKS,
        firstNoProgressAt: '2026-08-31T12:00:00.000Z',
        deliverAlertFn: async () => { throw new Error('alert bus unavailable'); },
        logger: silentLogger,
        now: Date.parse('2026-08-31T13:00:00.000Z'),
      }),
      /alert bus unavailable/,
    );
    assert.equal(
      existsSync(operatorDecisionAlertStateDir(rootDir)),
      false,
      'a failed delivery must not create a durable debounce marker',
    );

    const alerts = [];
    assert.equal(await maybeFireOperatorDecisionRequiredAlert({
      rootDir,
      identity,
      headSha: HEAD_A,
      noProgressTicks: DEFAULT_OPERATOR_BLOCKED_ALERT_NO_PROGRESS_TICKS,
      firstNoProgressAt: '2026-08-31T12:00:00.000Z',
      deliverAlertFn: async (text, meta) => { alerts.push({ text, meta }); },
      logger: silentLogger,
      now: Date.parse('2026-08-31T13:05:00.000Z'),
    }), true);
    assert.equal(alerts.length, 1, 'the next tick can retry after the alert bus recovers');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('no-progress lane writes nothing for a subject with no head to key on', () => {
  const rootDir = tempRoot();
  try {
    const identity = { repo: REPO, prNumber: 5909 };
    assert.equal(
      recordNoProgressLaneRun(rootDir, identity, { headSha: null, fingerprint: 'x', logger: silentLogger }),
      null,
    );
    assert.equal(readNoProgressLane(rootDir, identity, { logger: silentLogger }), null);
    assert.equal(evaluateNoProgressLane(null, { headSha: null }).due, true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('subjectProgressFingerprint ignores churn the watcher does not cause', () => {
  const base = {
    review_status: 'posted',
    pr_state: 'open',
    reviewer_head_sha: HEAD_A,
    review_attempts: 1,
    labels_json: '["a"]',
    updated_at: '2026-08-25T10:00:00.000Z',
  };
  const churned = { ...base, labels_json: '["a","b"]', updated_at: '2026-08-25T11:00:00.000Z' };
  assert.equal(
    subjectProgressFingerprint(base, { headSha: HEAD_A }),
    subjectProgressFingerprint(churned, { headSha: HEAD_A }),
    'external label/timestamp churn must not read as watcher progress',
  );
  assert.notEqual(
    subjectProgressFingerprint(base, { headSha: HEAD_A }),
    subjectProgressFingerprint({ ...base, review_attempts: 2 }, { headSha: HEAD_A }),
  );
});

// ── Starvation detection ─────────────────────────────────────────────────────

function starvationHarness({ starvationMs = 1000, starvationChecksRequired = 3 } = {}) {
  let now = 0;
  const signals = [];
  const heartbeat = createWatcherHeartbeat({
    filePath: join(tempRoot(), 'heartbeat.json'),
    now: () => new Date('2026-08-25T10:00:00.000Z'),
    writeFile() {},
    readFile() { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    logger: silentLogger,
  });
  const watchdog = createWatcherStallWatchdog({
    heartbeat,
    stallMs: 10_000,
    checkIntervalMs: 100,
    starvationMs,
    starvationChecksRequired,
    nowMs: () => now,
    onStarvation: (event) => signals.push(event),
    logger: silentLogger,
  });
  return {
    heartbeat,
    watchdog,
    signals,
    advance: (ms) => { now += ms; },
    at: (ms) => { now = ms; },
  };
}

test('starvation signal fires for a live poll that is in flight past its SLA with a frozen counter', () => {
  const harness = starvationHarness({ starvationMs: 1000, starvationChecksRequired: 3 });
  harness.heartbeat.markPoll();
  harness.watchdog.beginPoll();

  harness.at(500);
  assert.equal(harness.watchdog.check(), false);
  assert.equal(harness.signals.length, 0, 'a poll inside its SLA is not starved');

  // Past the SLA, but a single observation is not yet evidence.
  harness.at(1_200);
  harness.watchdog.check();
  harness.at(1_300);
  harness.watchdog.check();
  assert.equal(harness.signals.length, 0, 'requires N consecutive observations');

  harness.at(1_400);
  harness.watchdog.check();
  assert.equal(harness.signals.length, 1, 'the starved poll pages');
  assert.equal(harness.signals[0].checks, 3);
  assert.equal(harness.signals[0].heartbeat.poll_counter, 1);

  // One signal per poll — the condition is durable, so re-arming would page on a loop.
  harness.at(9_000);
  harness.watchdog.check();
  assert.equal(harness.signals.length, 1);
});

test('starvation signal does not fire once the poll finishes, and re-arms for the next one', () => {
  const harness = starvationHarness({ starvationMs: 1000, starvationChecksRequired: 2 });
  harness.heartbeat.markPoll();
  harness.watchdog.beginPoll();
  harness.at(2_000);
  harness.watchdog.check();
  harness.watchdog.check();
  assert.equal(harness.signals.length, 1);

  harness.watchdog.endPoll();
  assert.equal(harness.watchdog.getState().starvationSignalled, false);
  assert.equal(harness.watchdog.getState().pollInFlightMs, null);

  harness.heartbeat.markPoll();
  harness.watchdog.beginPoll();
  harness.at(2_100);
  harness.watchdog.check();
  assert.equal(harness.signals.length, 1, 'a fresh poll starts inside its SLA again');
});

test('starvation detection leaves the idle stall watchdog contract untouched', () => {
  const harness = starvationHarness({ starvationMs: 1000, starvationChecksRequired: 1 });
  harness.heartbeat.markPoll();
  harness.watchdog.beginPoll();
  harness.at(50_000);
  // Well past `stallMs`, but a poll is in flight: `check()` must still report no
  // stall, because exiting is the poll-deadline path's decision, not this one's.
  assert.equal(harness.watchdog.check(), false);
  assert.equal(harness.signals.length, 1, 'it pages instead');
});

// ── Starvation signal delivery ───────────────────────────────────────────────

test('resolvePollStarvationConfig scales with the poll interval and honours env overrides', () => {
  const scaled = resolvePollStarvationConfig({ env: {}, intervalMs: 20 * 60 * 1000 });
  assert.equal(scaled.starvationMs, 60 * 60 * 1000, 'three poll intervals when that exceeds the floor');
  assert.equal(scaled.checksRequired, 3);

  const floored = resolvePollStarvationConfig({ env: {}, intervalMs: 60_000 });
  assert.equal(floored.starvationMs, 15 * 60 * 1000, 'never shorter than the shipped floor');

  const pinned = resolvePollStarvationConfig({
    env: {
      ADVERSARIAL_WATCHER_POLL_STARVATION_MS: '90000',
      ADVERSARIAL_WATCHER_POLL_STARVATION_CHECKS: '5',
    },
    intervalMs: 20 * 60 * 1000,
  });
  assert.equal(pinned.starvationMs, 90_000, 'an explicit override always wins');
  assert.equal(pinned.checksRequired, 5);

  const garbage = resolvePollStarvationConfig({
    env: { ADVERSARIAL_WATCHER_POLL_STARVATION_MS: 'soon', ADVERSARIAL_WATCHER_POLL_STARVATION_CHECKS: '0' },
    intervalMs: 0,
  });
  assert.equal(garbage.starvationMs, 15 * 60 * 1000);
  assert.equal(garbage.checksRequired, 3);
});

test('poll-starvation handler marks the heartbeat and pages without touching last_poll_at', async () => {
  const persisted = [];
  const alerts = [];
  const handler = createPollStarvationHandler({
    getHeartbeat: () => ({ persist: (event, extra) => persisted.push({ event, extra }) }),
    deliverAlertFn: async (text, meta) => { alerts.push({ text, meta }); },
    logger: silentLogger,
  });

  handler({
    inFlightMs: 2_400_000,
    starvationMs: 900_000,
    checks: 3,
    heartbeat: { poll_counter: 41, last_poll_at: '2026-08-25T10:00:00.000Z' },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].event, 'poll-starvation');
  assert.equal(persisted[0].extra.poll_starvation.in_flight_ms, 2_400_000);
  assert.equal(
    Object.prototype.hasOwnProperty.call(persisted[0].extra, 'last_poll_at'),
    false,
    'the marker must not refresh the field the external watchdog reads for freshness',
  );

  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].meta.event, 'adversarial_review.poll_starved');
  assert.equal(alerts[0].meta.payload.poll_counter, 41);
  assert.match(alerts[0].text, /in flight for 40m/);
});

test('poll-starvation handler survives a heartbeat write fault and still pages', async () => {
  const alerts = [];
  const handler = createPollStarvationHandler({
    getHeartbeat: () => ({ persist: () => { throw new Error('disk full'); } }),
    deliverAlertFn: async (text, meta) => { alerts.push({ text, meta }); },
    logger: silentLogger,
  });
  handler({ inFlightMs: 1_000_000, starvationMs: 900_000, checks: 3, heartbeat: {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(alerts.length, 1, 'a reporting fault must not become a second outage');
});

test('poll-starvation handler swallows an alert-delivery rejection', async () => {
  const errors = [];
  const handler = createPollStarvationHandler({
    getHeartbeat: () => null,
    deliverAlertFn: async () => { throw new Error('sink down'); },
    logger: { ...silentLogger, error: (msg) => errors.push(msg) },
  });
  handler({ inFlightMs: 1_000_000, starvationMs: 900_000, checks: 3, heartbeat: {} });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /alert delivery failed/);
});

// WPS-01 follow-up. The no-progress lane keys on (repo, pr, head), and
// `recordNoProgressLaneRun` SKIPS the ledger write when the head is null. So a
// null head does not degrade the lane, it disables it: every unadvanceable PR is
// re-walked at full speed and the starvation this ticket removes comes straight
// back, silently and with all tests green.
//
// The head must come from `subject`, not `entry`. `entry` is the subjectEntry
// built in watcher.mjs as `{ subjectRef, subject, prNumber }` (+ a later
// `current`); it has no `headSha`. The tests above construct their handler list
// by hand, so they cannot catch a wrong property name in the production
// queueing path -- which is how `entry.headSha` shipped. This is a source guard
// rather than a behavioural test, deliberately: it pins the one fact that makes
// the bug invisible, that `entry` has no head to read.
test('the queued posted-review handler reads the head from subject, not entry', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');

  const here = dirname(fileURLToPath(import.meta.url));
  const phasesRaw = readFileSync(join(here, '..', 'src', 'pollonce-phases.mjs'), 'utf8');
  // Strip comments: the fix's own explanatory comment names `entry.headSha`,
  // and a guard that trips on prose describing the bug is worthless.
  const phases = phasesRaw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  const watcher = readFileSync(join(here, '..', 'src', 'watcher.mjs'), 'utf8');

  assert.equal(
    /\bentry\.headSha\b/.test(phases),
    false,
    'pollonce-phases must not read entry.headSha: the subjectEntry carries no head, '
      + 'so it silently resolves to null and disables the no-progress lane',
  );

  // And the reason it carries no head: the literal that builds it.
  assert.match(
    watcher,
    /return\s*\{\s*subjectRef,\s*subject,\s*prNumber\s*\}/,
    'subjectEntry shape changed; re-check which object owns headSha before trusting this guard',
  );
});
