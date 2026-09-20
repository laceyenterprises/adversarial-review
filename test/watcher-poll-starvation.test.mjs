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
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveClaudeLaunchctlUidFromConfig } from '../src/claude-launchctl-uid.mjs';
import {
  createWatcherHeartbeat,
  createWatcherStallWatchdog,
  DEFAULT_WATCHER_STALL_EXIT_CODE,
} from '../src/watcher-heartbeat.mjs';
import {
  DEFAULT_NO_PROGRESS_LANE_CAP,
  DEFAULT_NO_PROGRESS_STALLED_EVENT_TICKS,
  DEFAULT_OPERATOR_BLOCKED_ALERT_NO_PROGRESS_TICKS,
  DEFAULT_OPERATOR_BLOCKED_REWALK_TICKS,
  LANE_ACTIVE,
  LANE_OPERATOR_BLOCKED,
  LANE_SLOW,
  PROGRESS_CLASS_OPERATOR_DECISION_REQUIRED,
  backoffTicksFor,
  clearNoProgressLane,
  clearOperatorDecisionAlertState,
  evaluateNoProgressLane,
  maybeFireOperatorDecisionRequiredAlert,
  noProgressLaneFilePath,
  operatorDecisionAlertStateDir,
  promoteStarvedNoProgressLaneLedgers,
  readNoProgressLane,
  recordNoProgressLaneRun,
  recordNoProgressLaneSkip,
  subjectProgressFingerprint,
} from '../src/watcher-no-progress-lane.mjs';
// LANESTARVE-01 symbols are reached through a namespace import on purpose: a
// named import of a symbol `main` does not export is a module-load error, which
// would take the WHOLE file down and make the required A/B ("this test fails on
// main, passes with the change") unreadable. Through the namespace, each new
// test fails on its own assertion — on behaviour — which is the evidence the
// ticket asks for.
import * as noProgressLane from '../src/watcher-no-progress-lane.mjs';
import {
  createPostedReviewFairnessState,
  orderSubjectEntriesDiscoveryFirst,
  orderSubjectEntriesRereviewOldestFirst,
  runPostedReviewHandlersFairly,
} from '../src/watcher-poll-fairness.mjs';
import { createNoProgressLaneGate, handlePostedReviewRow } from '../src/posted-review-row.mjs';
import {
  createPollStarvationHandler,
  createPollStarvationRestartRequester,
  resolvePollStarvationConfig,
} from '../src/watcher-poll-starvation-signal.mjs';
import {
  enforceHcpPreSpawnReadiness,
  processReviewSubject,
  resolveClaudeRuntimeProbeUidForWatcher,
} from '../src/pollonce-phases.mjs';

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

test('RVHAND-08: posted-review timeout continues to the rest of the bounded phase', async () => {
  const state = createPostedReviewFairnessState();
  const events = [];
  const errors = [];
  const warnings = [];
  const logs = [];

  const summary = await runPostedReviewHandlersFairly({
    handlers: [
      {
        repoPath: REPO,
        prNumber: 5908,
        run: async () => new Promise(() => {}),
      },
      {
        repoPath: REPO,
        prNumber: 5909,
        run: async () => {
          events.push('second-handler-ran');
        },
      },
    ],
    state,
    budgetMs: 60_000,
    handlerTimeoutMs: 10,
    laneGate: {
      evaluate: () => ({ run: true }),
      record: async () => {},
    },
    logger: {
      log: (...args) => logs.push(args.join(' ')),
      warn: (...args) => warnings.push(args.join(' ')),
      error: (...args) => errors.push(args.join(' ')),
    },
  });

  assert.equal(summary.timedOut, 1);
  assert.equal(summary.ran, 1);
  assert.equal(summary.deferredAfterTimeout, 0);
  assert.equal(summary.continuedAfterTimeout, 1);
  assert.deepEqual(summary.deferred, []);
  assert.deepEqual(events, ['second-handler-ran']);
  assert.match(errors[0], /posted-review handler for laceyenterprises\/agent-os#5908 exceeded 10ms/);
  assert.match(warnings[0], /posted-review phase continuing after timeout/);
  assert.match(logs[0], /timeout_deferred=0 continued_after_timeout=1/);
});

test('RVHAND-09: posted-review timeout still defers when the phase budget is spent', async () => {
  const state = createPostedReviewFairnessState();
  const events = [];
  const warnings = [];
  let clock = 0;
  let pendingTimer = null;

  const summary = await runPostedReviewHandlersFairly({
    handlers: [
      {
        repoPath: REPO,
        prNumber: 5908,
        run: () => {
          queueMicrotask(() => {
            clock += pendingTimer.delay;
            pendingTimer.callback();
          });
          return new Promise(() => {});
        },
      },
      {
        repoPath: REPO,
        prNumber: 5909,
        run: async () => {
          events.push('second-handler-ran');
        },
      },
    ],
    state,
    budgetMs: 10,
    handlerTimeoutMs: 10,
    minimumHandlerStartBudgetMs: 1,
    nowMs: () => clock,
    setTimeoutFn: (callback, delay) => {
      pendingTimer = { callback, delay };
      return pendingTimer;
    },
    clearTimeoutFn: (timer) => {
      if (pendingTimer === timer) pendingTimer = null;
    },
    laneGate: {
      evaluate: () => ({ run: true }),
      record: async () => {},
    },
    logger: {
      log() {},
      warn: (...args) => warnings.push(args.join(' ')),
      error() {},
    },
  });

  assert.equal(summary.timedOut, 1);
  assert.equal(summary.ran, 0);
  assert.equal(summary.deferredAfterTimeout, 1);
  assert.equal(summary.continuedAfterTimeout, 0);
  assert.deepEqual(summary.deferred, ['laceyenterprises/agent-os#5909']);
  assert.deepEqual(events, []);
  assert.match(warnings.join('\n'), /posted-review phase yielding after timeout/);
  assert.match(warnings.join('\n'), /minimum_start_budget=1ms/);
});

test('RVHAND-06: posted-review phase warns when queued handlers make zero progress', async () => {
  const warnings = [];

  const summary = await runPostedReviewHandlersFairly({
    handlers: [
      {
        repoPath: REPO,
        prNumber: 6486,
        run: async () => {},
      },
    ],
    state: createPostedReviewFairnessState(),
    budgetMs: 60_000,
    handlerTimeoutMs: 60_000,
    // LANESTARVE-01: this test owns the zero-progress WARNING — that the phase
    // says so, in the documented format, when a tick achieves nothing. It is not
    // a claim that an all-lane-deferred tick SHOULD achieve nothing; the
    // starvation floor now prevents that state from arising with budget in hand
    // (see 'an all-slow-lane tick drains instead of reporting ran=0'). Pin the
    // floor off here so the warning itself stays under test.
    laneStarvationFloor: 0,
    laneGate: {
      evaluate: () => ({ run: false, lane: 'slow', noProgressTicks: 4, backoffTicks: 8, skippedTicks: 1 }),
      record: async () => {},
    },
    logger: {
      log() {},
      warn: (...args) => warnings.push(args.join(' ')),
      error() {},
    },
  });

  assert.equal(summary.queued, 1);
  assert.equal(summary.ran, 0);
  assert.match(warnings.join('\n'), /posted-review phase made zero progress/);
  assert.match(warnings.join('\n'), /queued=1 ran=0/);
});

test('RVHAND-03: per-handler timeout lets slow hammer launch finish without raising the global default', async () => {
  const state = createPostedReviewFairnessState();
  const events = [];
  const errors = [];

  const summary = await runPostedReviewHandlersFairly({
    handlers: [
      {
        repoPath: REPO,
        prNumber: 5910,
        timeoutMs: 100,
        run: async () => {
          await new Promise((resolve) => setTimeout(resolve, 25));
          events.push('slow-handler-finished');
        },
      },
      {
        repoPath: REPO,
        prNumber: 5911,
        run: async () => {
          events.push('next-handler-ran');
        },
      },
    ],
    state,
    budgetMs: 60_000,
    handlerTimeoutMs: 5,
    laneGate: {
      evaluate: () => ({ run: true }),
      record: async () => {},
    },
    logger: {
      log() {},
      warn() {},
      error: (...args) => errors.push(args.join(' ')),
    },
  });

  assert.equal(summary.ran, 2);
  assert.equal(summary.timedOut, 0);
  assert.deepEqual(events, ['slow-handler-finished', 'next-handler-ran']);
  assert.deepEqual(errors, []);
});

test('RVHAND-05: posted-review phase defers before starting when remaining budget cannot cover a step', async () => {
  const state = createPostedReviewFairnessState();
  const events = [];
  const warnings = [];
  let clock = 0;

  const summary = await runPostedReviewHandlersFairly({
    handlers: [
      {
        repoPath: REPO,
        prNumber: 6504,
        run: async () => {
          events.push('first-handler-ran');
          clock += 270_000;
        },
      },
      {
        repoPath: REPO,
        prNumber: 6505,
        run: async () => {
          events.push('second-handler-ran');
        },
      },
    ],
    state,
    budgetMs: 330_000,
    handlerTimeoutMs: 330_000,
    minimumHandlerStartBudgetMs: 66_000,
    nowMs: () => clock,
    laneGate: {
      evaluate: () => ({ run: true }),
      record: async () => {},
    },
    logger: {
      log() {},
      warn: (...args) => warnings.push(args.join(' ')),
      error() {},
    },
  });

  assert.equal(summary.ran, 1);
  assert.equal(summary.deferredByBudget, 1);
  assert.deepEqual(summary.deferred, ['laceyenterprises/agent-os#6505']);
  assert.deepEqual(events, ['first-handler-ran']);
  assert.match(warnings[0], /posted-review phase budget insufficient/);
  assert.match(warnings[0], /remaining=60000ms minimum_start_budget=66000ms/);
});

test('RVHAND-04: resolveMergeAgentCoexistence soft deadline does not consume the remaining phase budget', async () => {
  const oldDeadline = process.env.ADVERSARIAL_WATCHER_RESOLVE_MERGE_AGENT_COEXISTENCE_DEADLINE_MS;
  process.env.ADVERSARIAL_WATCHER_RESOLVE_MERGE_AGENT_COEXISTENCE_DEADLINE_MS = '10';
  const state = createPostedReviewFairnessState();
  const events = [];
  let firstStepAborted = false;

  const baseHandlerArgs = {
    rootDir: tempRoot(),
    repoPath: REPO,
    existing: { body_md: null },
    subjectRef: null,
    currentRevisionRef: HEAD_A,
    labelNames: [],
    projectGateStatusSafe: async () => ({}),
    fetchMergeAgentCandidateImpl: async () => ({ merged: false, prState: 'open' }),
    buildMergeAgentDispatchJobImpl: () => ({}),
    latestFollowUpJobFinder: () => null,
    latestPostedReviewBodyFinder: () => null,
    reviewBodyHasScopeViolationFindingImpl: () => false,
    currentReviewRowReader: () => ({ review_status: 'posted', reviewer_head_sha: HEAD_A }),
    logger: silentLogger,
  };

  try {
    const summary = await runPostedReviewHandlersFairly({
      handlers: [
        {
          repoPath: REPO,
          prNumber: 6504,
          run: () => handlePostedReviewRow({
            ...baseHandlerArgs,
            prNumber: 6504,
            resolveMergeAgentCoexistenceForWatcherImpl: ({ signal }) =>
              new Promise((_, reject) => {
                signal.addEventListener('abort', () => {
                  firstStepAborted = true;
                  reject(signal.reason);
                });
              }),
          }),
        },
        {
          repoPath: REPO,
          prNumber: 6505,
          run: async () => {
            events.push('second-handler-ran');
          },
        },
      ],
      state,
      budgetMs: 60_000,
      handlerTimeoutMs: 1_000,
      laneGate: {
        evaluate: () => ({ run: true }),
        record: async () => {},
      },
      logger: silentLogger,
    });

    assert.equal(firstStepAborted, false);
    assert.equal(summary.timedOut, 0);
    assert.equal(summary.ran, 2);
    assert.equal(summary.deferredAfterTimeout, 0);
    assert.deepEqual(events, ['second-handler-ran']);
  } finally {
    rmSync(baseHandlerArgs.rootDir, { recursive: true, force: true });
    if (oldDeadline === undefined) {
      delete process.env.ADVERSARIAL_WATCHER_RESOLVE_MERGE_AGENT_COEXISTENCE_DEADLINE_MS;
    } else {
      process.env.ADVERSARIAL_WATCHER_RESOLVE_MERGE_AGENT_COEXISTENCE_DEADLINE_MS = oldDeadline;
    }
  }
});

test('RVHAND-02: timeout log reports phase elapsed at handler start', async () => {
  const state = createPostedReviewFairnessState();
  const errors = [];
  let clock = 0;
  let pendingTimer = null;

  const summary = await runPostedReviewHandlersFairly({
    handlers: [
      {
        repoPath: REPO,
        prNumber: 5908,
        run: async () => {
          clock += 599_000;
        },
      },
      {
        repoPath: REPO,
        prNumber: 5909,
        run: () => {
          queueMicrotask(() => {
            clock += pendingTimer.delay;
            pendingTimer.callback();
          });
          return new Promise(() => {});
        },
      },
    ],
    state,
    budgetMs: 600_000,
    handlerTimeoutMs: 60_000,
    minimumHandlerStartBudgetMs: 1,
    nowMs: () => clock,
    setTimeoutFn: (callback, delay) => {
      pendingTimer = { callback, delay };
      return pendingTimer;
    },
    clearTimeoutFn: (timer) => {
      if (pendingTimer === timer) pendingTimer = null;
    },
    logger: {
      log() {},
      warn() {},
      error: (...args) => errors.push(args.join(' ')),
    },
  });

  assert.equal(summary.ran, 1);
  assert.equal(summary.timedOut, 1);
  assert.match(errors[0], /phase_elapsed_at_start=599000ms/);
  assert.match(errors[0], /phase_elapsed_total=659000ms/);
  assert.doesNotMatch(errors[0], /phase_elapsed=659000ms/);
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

test('WPS-01: terminal PR cleanup removes no-progress lane ledger and alert debounce files', async () => {
  const rootDir = tempRoot();
  try {
    const identity = { repo: REPO, prNumber: 5908 };
    recordNoProgressLaneRun(rootDir, identity, {
      headSha: HEAD_A,
      fingerprint: 'same-state',
      now: 'tick-1',
      logger: silentLogger,
    });
    await maybeFireOperatorDecisionRequiredAlert({
      rootDir,
      identity,
      headSha: HEAD_A,
      fingerprint: 'same-state',
      noProgressTicks: DEFAULT_OPERATOR_BLOCKED_ALERT_NO_PROGRESS_TICKS,
      deliverAlertFn: async () => {},
      logger: silentLogger,
    });
    assert.equal(existsSync(noProgressLaneFilePath(rootDir, identity)), true);
    assert.equal(readdirSync(operatorDecisionAlertStateDir(rootDir)).length, 1);

    assert.equal(clearNoProgressLane(rootDir, identity, { logger: silentLogger }), true);
    assert.equal(readNoProgressLane(rootDir, identity, { logger: silentLogger }), null);
    assert.equal(readdirSync(operatorDecisionAlertStateDir(rootDir)).length, 0);
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
  assert.equal(
    Object.hasOwn(postedReviewHandlers[0], 'timeoutMs'),
    false,
    'posted-review handlers use the scheduler ceiling, not the merge-authority dispatch timeout',
  );
});

test('WATCHSTARVE-01: pollOnce threads one bounded fleet quota cache through the per-PR resolver', () => {
  const watcherSource = readFileSync(new URL('../src/watcher.mjs', import.meta.url), 'utf8');
  const pollonceSource = readFileSync(new URL('../src/pollonce-phases.mjs', import.meta.url), 'utf8');

  assert.match(
    watcherSource,
    /createReviewerTickState\(\{/,
    'pollOnce creates per-tick reviewer state through the phase leaf',
  );
  assert.match(
    pollonceSource,
    /reviewerTickCaches: \{ fleetQuotaStatusCache: new Map\(\) \},/,
    'the phase leaf owns a quota cache for the tick',
  );
  assert.match(
    watcherSource,
    /reviewerTickCaches,/,
    'pollOnce passes the tick cache into processReviewSubject',
  );
  assert.match(
    pollonceSource,
    /reviewerTickCaches,\n\s+reviewerMemoryAdmissionSampleForTick,/,
    'processReviewSubject receives the tick cache separately from memory reservation state',
  );
  assert.match(
    pollonceSource,
    /fleetQuotaStatusCache: reviewerTickCaches\.fleetQuotaStatusCache,/,
    'processReviewSubject threads the tick cache into the quota resolver',
  );
  assert.doesNotMatch(
    pollonceSource,
    /fleetQuotaStatusCacheTtlMs: Number\.MAX_SAFE_INTEGER/,
    'the watcher quota cache must remain bounded within long polls',
  );
});

test('RVHAND-10: Claude runtime probe UID prefers configured admin_uid', async () => {
  let lookups = 0;
  const uid = await resolveClaudeRuntimeProbeUidForWatcher({
    loadConfigImpl: () => ({
      get(key, fallback = null) {
        if (key === 'roots.admin_uid') return 501;
        if (key === 'roots.admin_user') return 'placey';
        return fallback;
      },
    }),
    execFileImpl: async () => {
      lookups += 1;
      return { stdout: '502\n' };
    },
    env: {},
    logger: silentLogger,
  });

  assert.equal(uid, 501);
  assert.equal(lookups, 0, 'the pinned admin UID is authoritative');
});

test('RVHAND-10: Claude runtime probe UID resolves configured admin_user', async () => {
  const calls = [];
  const uid = await resolveClaudeRuntimeProbeUidForWatcher({
    loadConfigImpl: () => ({
      get(key, fallback = null) {
        if (key === 'roots.admin_uid') return null;
        if (key === 'roots.admin_user') return 'placey';
        return fallback;
      },
    }),
    execFileImpl: async (cmd, args, options) => {
      calls.push({ cmd, args, timeout: options.timeout });
      return { stdout: '501\n' };
    },
    env: { PATH: process.env.PATH },
    logger: silentLogger,
  });

  assert.equal(uid, 501);
  assert.deepEqual(calls, [
    { cmd: '/usr/bin/id', args: ['-u', 'placey'], timeout: 2_000 },
  ]);
});

test('RVHAND-10: Claude runtime UID lookup retries transient id failures', async () => {
  let attempts = 0;
  const delays = [];
  const warnings = [];
  const uid = await resolveClaudeLaunchctlUidFromConfig({
    loadConfigImpl: () => ({
      get(key, fallback = null) {
        if (key === 'roots.admin_uid') return null;
        if (key === 'roots.admin_user') return 'placey';
        return fallback;
      },
    }),
    execFileImpl: async () => {
      attempts += 1;
      if (attempts < 3) {
        const err = new Error('OpenDirectory temporary lookup failure');
        err.code = 'EIO';
        throw err;
      }
      return { stdout: '501\n' };
    },
    lookupRetryDelaysMs: [1, 2],
    sleepImpl: async (delay) => delays.push(delay),
    env: {},
    logger: { warn: (message) => warnings.push(message) },
  });

  assert.equal(uid, 501);
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [1, 2]);
  assert.match(warnings.join('\n'), /retrying in 1ms/);
  assert.doesNotMatch(warnings.join('\n'), /skipping local runtime grounding/);
});

test('RVHAND-10: Claude runtime probe UID skips local grounding on malformed ownership config', async () => {
  let lookups = 0;
  const warnings = [];
  const uid = await resolveClaudeRuntimeProbeUidForWatcher({
    loadConfigImpl: () => ({
      get(key, fallback = null) {
        if (key === 'roots.admin_uid') return 'not-a-uid';
        if (key === 'roots.admin_user') return 'placey';
        return fallback;
      },
    }),
    execFileImpl: async () => {
      lookups += 1;
      return { stdout: '501\n' };
    },
    env: {},
    logger: { warn: (message) => warnings.push(message) },
  });

  assert.equal(uid, null);
  assert.equal(lookups, 0, 'a malformed explicit UID must not fall back to guessing by user');
  assert.match(warnings.join('\n'), /invalid/);
  assert.doesNotMatch(warnings.join('\n'), /skipping local runtime grounding/);
});

test('HCP pre-spawn precheck requeues when down and proceeds when up', async () => {
  const settles = [];
  const statements = { getReviewRow: { get() {} } };
  const down = await enforceHcpPreSpawnReadiness({
    repoPath: REPO,
    prNumber: 6157,
    rootDir: '/tmp/adversarial-review-test',
    statements,
    attemptAt: '2026-09-03T20:00:00.000Z',
    maxRemediationRounds: 4,
    getHcpHealthzForTick: async () => ({
      ready: false,
      reason: 'timeout',
      failureClass: 'hcp-unavailable',
      failureMessage: 'HCP healthz http://127.0.0.1:8002/v1/healthz failed: timeout',
    }),
    settleReviewerAttemptImpl: (payload) => settles.push(payload),
    logger: silentLogger,
  });
  assert.equal(down.proceed, false);
  assert.equal(settles.length, 1);
  assert.equal(settles[0].statements, statements);
  assert.equal(settles[0].result.failureClass, 'hcp-unavailable');
  assert.equal(settles[0].failureAt, '2026-09-03T20:00:00.000Z');

  const up = await enforceHcpPreSpawnReadiness({
    repoPath: REPO,
    prNumber: 6157,
    rootDir: '/tmp/adversarial-review-test',
    attemptAt: '2026-09-03T20:01:00.000Z',
    maxRemediationRounds: 4,
    getHcpHealthzForTick: async () => ({ ready: true, reason: 'ok' }),
    settleReviewerAttemptImpl: (payload) => settles.push(payload),
    logger: silentLogger,
  });
  assert.equal(up.proceed, true);
  assert.equal(settles.length, 1);
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

test('orderSubjectEntriesRereviewOldestFirst drains pending re-reviews FIFO', () => {
  const entries = [
    {
      prNumber: 6671,
      current: {
        review_status: 'pending',
        rereview_requested_at: '2026-09-13T01:26:45.000Z',
      },
    },
    {
      prNumber: 6696,
      current: {
        review_status: 'pending',
        rereview_requested_at: '2026-09-12T19:28:36.000Z',
      },
    },
    {
      prNumber: 6689,
      current: {
        review_status: 'pending',
        rereview_requested_at: '2026-09-12T19:31:42.000Z',
      },
    },
    { prNumber: 6700, current: { review_status: 'posted' } },
  ];

  const ordered = orderSubjectEntriesRereviewOldestFirst(entries, { logger: silentLogger });

  assert.deepEqual(
    ordered.map((entry) => entry.prNumber),
    [6696, 6689, 6671, 6700],
    'older queued re-reviews must run before a PR that re-requested again',
  );
});

test('orderSubjectEntriesRereviewOldestFirst is stable outside pending re-reviews', () => {
  const entries = [
    { prNumber: 1, current: { review_status: 'pending', rereview_requested_at: null } },
    { prNumber: 2, current: { review_status: 'posted' } },
    {
      prNumber: 3,
      current: {
        review_status: 'pending',
        rereview_requested_at: 'not-a-date',
      },
    },
  ];

  assert.equal(
    orderSubjectEntriesRereviewOldestFirst(entries, { logger: silentLogger }),
    entries,
  );
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
    minimumHandlerStartBudgetMs: 1,
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
    minimumHandlerStartBudgetMs: 1,
    nowMs: () => clock,
    logger: silentLogger,
  });
  assert.deepEqual(ran, [3, 4], 'handlers cut off by the budget lead the next tick');
  assert.equal(second.deferredByBudget, 2);
  assert.deepEqual(second.deferred.sort(), [`${REPO}#1`, `${REPO}#2`]);
});

test('RVHAND-10: budget-deferred handlers do not record no-progress lane runs', async () => {
  const state = createPostedReviewFairnessState();
  let clock = 0;
  const recorded = [];
  const handlers = [1, 2, 3].map((prNumber) => ({
    repoPath: REPO,
    prNumber,
    headSha: HEAD_A,
    run: async () => {
      clock += 60;
    },
  }));

  const summary = await runPostedReviewHandlersFairly({
    handlers,
    state,
    budgetMs: 100,
    minimumHandlerStartBudgetMs: 1,
    nowMs: () => clock,
    laneGate: {
      evaluate: () => ({ run: true }),
      record: (handler) => recorded.push(handler.prNumber),
    },
    logger: silentLogger,
  });

  assert.equal(summary.deferredByBudget, 1);
  assert.deepEqual(recorded, [1, 2], 'only handlers that actually ran can count toward no-progress');
});

test('watcher wake priority runs the exact PR head ahead of slow-lane backlog', async () => {
  const ran = [];
  const laneEvaluations = [];
  const recorded = [];
  const handlers = [
    { repoPath: REPO, prNumber: 1, headSha: HEAD_A, run: async () => { ran.push(1); } },
    { repoPath: REPO, prNumber: 6569, headSha: HEAD_B, run: async () => { ran.push(6569); } },
    { repoPath: REPO, prNumber: 2, headSha: HEAD_A, run: async () => { ran.push(2); } },
  ];

  const summary = await runPostedReviewHandlersFairly({
    handlers,
    priorityTargets: [{
      repoPath: REPO,
      prNumber: 6569,
      headSha: HEAD_B,
      reason: 'hammer-pr-eligible',
    }],
    laneGate: {
      evaluate(handler) {
        laneEvaluations.push(handler.prNumber);
        return {
          run: false,
          lane: 'slow',
          noProgressTicks: 12,
          backoffTicks: 12,
          skippedTicks: 3,
        };
      },
      record(handler) {
        recorded.push(handler.prNumber);
      },
    },
    logger: silentLogger,
  });

  assert.deepEqual(ran, [6569], 'the woken PR/head bypasses slow-lane backoff and runs first');
  assert.deepEqual(laneEvaluations, [6569, 1, 2]);
  assert.deepEqual(recorded, [6569], 'only the bypassed handler records a run');
  assert.equal(summary.priorityLaneBypasses, 1);
  assert.equal(summary.skippedByLane, 2);
});

test('watcher wake priority is head-scoped and does not bypass a stale head', async () => {
  const ran = [];
  const summary = await runPostedReviewHandlersFairly({
    handlers: [{
      repoPath: REPO,
      prNumber: 6569,
      headSha: HEAD_B,
      run: async () => { ran.push(6569); },
    }],
    priorityTargets: [{
      repoPath: REPO,
      prNumber: 6569,
      headSha: HEAD_A,
    }],
    // LANESTARVE-01: this test is about wake-priority HEAD SCOPING, not about
    // the slow-lane starvation floor. Disable the floor so "did it run?" answers
    // only the question being asked — otherwise the sole queued handler would be
    // admitted by the floor (the tick ran nothing else) and the head-scoping
    // assertion would be testing two mechanisms at once.
    laneStarvationFloor: 0,
    laneGate: {
      evaluate() {
        return {
          run: false,
          lane: 'slow',
          noProgressTicks: 12,
          backoffTicks: 12,
          skippedTicks: 3,
        };
      },
      record() {
        throw new Error('stale wake target must not run');
      },
    },
    logger: silentLogger,
  });

  assert.deepEqual(ran, []);
  assert.equal(summary.priorityLaneBypasses, 0);
  assert.equal(summary.skippedByLane, 1);
});

test('RVPRESS-01: posted-review phase warns on one-handler budget stall signature', async () => {
  let clock = 0;
  const warnings = [];
  const logs = [];
  const handlers = [1, 2, 3].map((prNumber) => ({
    repoPath: REPO,
    prNumber,
    headSha: HEAD_A,
    run: async () => {
      clock += 100;
    },
  }));

  const summary = await runPostedReviewHandlersFairly({
    handlers,
    budgetMs: 100,
    minimumHandlerStartBudgetMs: 1,
    nowMs: () => clock,
    logger: {
      log: (...args) => logs.push(args.join(' ')),
      warn: (...args) => warnings.push(args.join(' ')),
      error: () => {},
    },
  });

  assert.equal(summary.queued, 3);
  assert.equal(summary.ran, 1);
  assert.equal(summary.deferredByBudget, 2);
  assert.match(warnings.join('\n'), /posted-review phase stall signature/);
  assert.match(warnings.join('\n'), /queued=3 ran=1/);
  assert.match(warnings.join('\n'), /budget_deferred=2/);
  assert.match(logs.join('\n'), /posted-review phase: queued=3 ran=1/);
});

test('RVHAND-10: timeout-deferred handlers do not record no-progress lane runs', async () => {
  const recorded = [];
  const summary = await runPostedReviewHandlersFairly({
    handlers: [
      { repoPath: REPO, prNumber: 1, headSha: HEAD_A, run: () => new Promise(() => {}) },
      { repoPath: REPO, prNumber: 2, headSha: HEAD_A, run: async () => {} },
      { repoPath: REPO, prNumber: 3, headSha: HEAD_A, run: async () => {} },
    ],
    budgetMs: 30,
    handlerTimeoutMs: 25,
    minimumHandlerStartBudgetMs: 10,
    laneGate: {
      evaluate: () => ({ run: true }),
      record: (handler) => recorded.push(handler.prNumber),
    },
    logger: silentLogger,
  });

  assert.equal(summary.timedOut, 1);
  assert.equal(summary.deferredAfterTimeout, 2);
  assert.deepEqual(recorded, [1], 'tail handlers deferred after a timeout were never examined');
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
      minimumHandlerStartBudgetMs: 1,
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
  assert.equal(summary.deferredAfterTimeout, 0);
  assert.equal(summary.continuedAfterTimeout, 1);
  assert.deepEqual(summary.deferred, []);
  assert.deepEqual(ran, [2], 'the handler behind the wedged one still runs in this tick');
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

test('RVHAND-10: posted-review summary counts nested AMA daemon clean merges', async () => {
  const summary = await runPostedReviewHandlersFairly({
    handlers: [{
      repoPath: REPO,
      prNumber: 6529,
      run: async () => ({
        handled: true,
        prTerminal: true,
        amaClosureResult: {
          daemonCleanMerge: { merged: true, disposition: 'merged' },
        },
      }),
    }],
    logger: silentLogger,
  });

  assert.equal(summary.ran, 1);
  assert.equal(summary.daemonCleanMerges, 1);
});

// ── No-progress lane ─────────────────────────────────────────────────────────

test('no-progress lane demotes at the cap, and any state change resets it', () => {
  const rootDir = tempRoot();
  try {
    const identity = { repo: REPO, prNumber: 5909 };
    const stuck = subjectProgressFingerprint(
      { review_status: 'posted', pr_state: 'open', reviewer_head_sha: HEAD_A, review_attempts: 1 },
      { headSha: HEAD_A },
    );

    let outcome = null;
    for (let i = 0; i < DEFAULT_NO_PROGRESS_LANE_CAP; i += 1) {
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
      now: `t${DEFAULT_NO_PROGRESS_LANE_CAP}`,
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
  assert.equal(backoffTicksFor(DEFAULT_NO_PROGRESS_LANE_CAP - 1), 0, 'below the cap it is still active');
  assert.equal(backoffTicksFor(DEFAULT_NO_PROGRESS_LANE_CAP), 1, 'at the cap it enters the slow lane');
  assert.equal(backoffTicksFor(DEFAULT_NO_PROGRESS_LANE_CAP + 1), 2);
  assert.equal(backoffTicksFor(DEFAULT_NO_PROGRESS_LANE_CAP + 2), 4);
  assert.equal(backoffTicksFor(DEFAULT_NO_PROGRESS_LANE_CAP + 3), 8);
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

test('legacy no-progress ledgers without progressClass are due immediately for reclassification', () => {
  const rootDir = tempRoot();
  try {
    const identity = { repo: REPO, prNumber: 6028 };
    for (let i = 0; i < DEFAULT_NO_PROGRESS_LANE_CAP + 6; i += 1) {
      recordNoProgressLaneRun(rootDir, identity, {
        headSha: HEAD_A,
        fingerprint: 'legacy-self-resolving',
        now: `t${i}`,
        logger: silentLogger,
      });
    }
    const legacy = readNoProgressLane(rootDir, identity, { logger: silentLogger });
    assert.equal(legacy.progressClass, 'self-resolving');
    delete legacy.progressClass;
    delete legacy.lane;
    writeFileSync(noProgressLaneFilePath(rootDir, identity), `${JSON.stringify(legacy, null, 2)}\n`);

    const decision = evaluateNoProgressLane(
      readNoProgressLane(rootDir, identity, { logger: silentLogger }),
      { headSha: HEAD_A },
    );
    assert.equal(decision.due, true);
    assert.equal(decision.lane, LANE_OPERATOR_BLOCKED);
    assert.equal(decision.reason, 'legacy-progress-class-missing');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('RVHAND-10: starvation recovery promotes existing slow-lane ledgers once', async () => {
  const rootDir = tempRoot();
  try {
    const identity = { repo: REPO, prNumber: 6527 };
    for (let i = 0; i < DEFAULT_NO_PROGRESS_LANE_CAP + 2; i += 1) {
      recordNoProgressLaneRun(rootDir, identity, {
        headSha: HEAD_A,
        fingerprint: 'starved-clean-pr',
        now: `t${i}`,
        logger: silentLogger,
      });
    }
    assert.equal(readNoProgressLane(rootDir, identity, { logger: silentLogger }).lane, LANE_SLOW);
    const ledgerPath = noProgressLaneFilePath(rootDir, identity);
    const priorPromotion = {
      lane: LANE_SLOW,
      noProgressTicks: 12,
      skippedTicks: 3,
      promotionId: 'older-recovery',
      promotedAt: 'earlier',
    };
    writeFileSync(
      ledgerPath,
      `${JSON.stringify({
        ...JSON.parse(readFileSync(ledgerPath, 'utf8')),
        promotedFrom: priorPromotion,
      }, null, 2)}\n`,
    );

    const first = await promoteStarvedNoProgressLaneLedgers(rootDir, {
      now: 'recover',
      logger: silentLogger,
    });
    const recovered = readNoProgressLane(rootDir, identity, { logger: silentLogger });
    assert.equal(first.promoted, 1);
    assert.equal(recovered.lane, LANE_ACTIVE);
    assert.equal(recovered.noProgressTicks, 0);
    assert.equal(recovered.skippedTicks, 0);
    assert.equal(recovered.promotedFrom.noProgressTicks > 0, true);
    assert.deepEqual(recovered.promotionHistory[0], priorPromotion);
    assert.deepEqual(recovered.promotionHistory[1], recovered.promotedFrom);

    const second = await promoteStarvedNoProgressLaneLedgers(rootDir, {
      now: 'recover-again',
      logger: silentLogger,
    });
    assert.equal(second.attempted, false);
    assert.equal(second.reason, 'already-promoted');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('RVHAND-10: walked promoted ledgers preserve promotion audit fields', async () => {
  const rootDir = tempRoot();
  try {
    const identity = { repo: REPO, prNumber: 6539 };
    for (let i = 0; i < DEFAULT_NO_PROGRESS_LANE_CAP + 2; i += 1) {
      recordNoProgressLaneRun(rootDir, identity, {
        headSha: HEAD_A,
        fingerprint: 'starved-clean-pr-preserve-history',
        now: `t${i}`,
        logger: silentLogger,
      });
    }

    await promoteStarvedNoProgressLaneLedgers(rootDir, {
      now: 'recover-preserve-history',
      logger: silentLogger,
    });
    const promoted = readNoProgressLane(rootDir, identity, { logger: silentLogger });

    recordNoProgressLaneRun(rootDir, identity, {
      headSha: HEAD_A,
      fingerprint: 'post-promotion-walk',
      now: 'after-recovery-walk',
      logger: silentLogger,
    });
    const walked = readNoProgressLane(rootDir, identity, { logger: silentLogger });

    assert.deepEqual(walked.promotedFrom, promoted.promotedFrom);
    assert.deepEqual(walked.promotionHistory, promoted.promotionHistory);

    recordNoProgressLaneRun(rootDir, identity, {
      headSha: HEAD_B,
      fingerprint: 'new-head-starts-fresh',
      now: 'new-head',
      logger: silentLogger,
    });
    const freshHead = readNoProgressLane(rootDir, identity, { logger: silentLogger });

    assert.equal(freshHead.promotedFrom, undefined);
    assert.equal(freshHead.promotionHistory, undefined);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('RVHAND-10: starvation recovery yields between ledger batches', async () => {
  const rootDir = tempRoot();
  try {
    for (const identity of [
      { repo: REPO, prNumber: 6527 },
      { repo: REPO, prNumber: 6528 },
    ]) {
      for (let i = 0; i < DEFAULT_NO_PROGRESS_LANE_CAP + 2; i += 1) {
        recordNoProgressLaneRun(rootDir, identity, {
          headSha: HEAD_A,
          fingerprint: `starved-clean-pr-${identity.prNumber}`,
          now: `t${i}`,
          logger: silentLogger,
        });
      }
    }
    let yieldCount = 0;

    const result = await promoteStarvedNoProgressLaneLedgers(rootDir, {
      now: 'recover-yield',
      logger: silentLogger,
      yieldEveryLedgers: 1,
      yieldImpl: async () => {
        yieldCount += 1;
      },
    });

    assert.equal(result.promoted, 2);
    assert.equal(yieldCount, 1);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('RVHAND-10: starvation recovery reports marker write failures without crashing', async () => {
  const rootDir = tempRoot();
  try {
    const warnings = [];
    const result = await promoteStarvedNoProgressLaneLedgers(rootDir, {
      now: 'recover-marker-failure',
      logger: { ...silentLogger, warn: (...args) => warnings.push(args.join(' ')) },
      mkdirSyncImpl: () => {
        throw new Error('permission denied creating no-progress lane');
      },
    });

    assert.equal(result.attempted, false);
    assert.equal(result.promoted, 0);
    assert.equal(result.reason, 'marker-write-failed');
    assert.match(warnings.join('\n'), /failed to write starvation recovery marker/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('RVHAND-10: starvation recovery reports final marker write failures after promotion', async () => {
  const rootDir = tempRoot();
  try {
    const identity = { repo: REPO, prNumber: 6536 };
    for (let i = 0; i < DEFAULT_NO_PROGRESS_LANE_CAP + 2; i += 1) {
      recordNoProgressLaneRun(rootDir, identity, {
        headSha: HEAD_A,
        fingerprint: 'starved-clean-pr-6536',
        now: `t${i}`,
        logger: silentLogger,
      });
    }
    const markerWrites = [];
    const warnings = [];
    const result = await promoteStarvedNoProgressLaneLedgers(rootDir, {
      now: 'recover-final-marker-failure',
      logger: { ...silentLogger, warn: (...args) => warnings.push(args.join(' ')) },
      writeFileAtomicImpl: (filePath, contents) => {
        if (filePath.endsWith('.promotion.json')) {
          markerWrites.push({ filePath, contents });
          throw new Error('disk full writing marker');
        }
        writeFileSync(filePath, contents);
      },
    });

    assert.equal(result.attempted, true);
    assert.equal(result.promoted, 1);
    assert.equal(result.reason, 'marker-write-failed');
    assert.equal(markerWrites.length, 1);
    assert.match(warnings.join('\n'), /failed to write starvation recovery marker/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('RVHAND-10: starvation recovery quarantines corrupt ledgers and writes campaign marker', async () => {
  const rootDir = tempRoot();
  try {
    const identity = { repo: REPO, prNumber: 6528 };
    for (let i = 0; i < DEFAULT_NO_PROGRESS_LANE_CAP + 2; i += 1) {
      recordNoProgressLaneRun(rootDir, identity, {
        headSha: HEAD_A,
        fingerprint: 'starved-clean-pr',
        now: `t${i}`,
        logger: silentLogger,
      });
    }
    assert.equal(readNoProgressLane(rootDir, identity, { logger: silentLogger }).lane, LANE_SLOW);
    const laneDir = join(rootDir, 'data', 'watcher-no-progress-lane');
    const badLedgerPath = join(laneDir, 'transient-read-failure.json');
    writeFileSync(badLedgerPath, '{');

    const first = await promoteStarvedNoProgressLaneLedgers(rootDir, {
      now: 'recover',
      logger: silentLogger,
    });
    assert.equal(first.attempted, true);
    assert.equal(first.promoted, 1);
    assert.equal(first.reason, 'scheduler-starvation-recovery');
    const markerPath = join(laneDir, 'rvhand-10-starved-slow-lane-recovery.promotion.json');
    assert.equal(existsSync(markerPath), true);
    assert.equal(JSON.parse(readFileSync(markerPath, 'utf8')).quarantined, 1);
    assert.equal(existsSync(badLedgerPath), false);
    assert.equal(existsSync(join(laneDir, 'quarantine', 'recover-transient-read-failure.json')), true);

    const second = await promoteStarvedNoProgressLaneLedgers(rootDir, {
      now: 'recover-again',
      logger: silentLogger,
    });
    assert.equal(second.attempted, false);
    assert.equal(second.promoted, 0);
    assert.equal(second.reason, 'already-promoted');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('RVHAND-10: starvation recovery leaves transient read failures for the next tick', async () => {
  const rootDir = tempRoot();
  try {
    const identity = { repo: REPO, prNumber: 6535 };
    for (let i = 0; i < DEFAULT_NO_PROGRESS_LANE_CAP + 2; i += 1) {
      recordNoProgressLaneRun(rootDir, identity, {
        headSha: HEAD_A,
        fingerprint: 'starved-clean-pr',
        now: `t${i}`,
        logger: silentLogger,
      });
    }
    assert.equal(readNoProgressLane(rootDir, identity, { logger: silentLogger }).lane, LANE_SLOW);
    const laneDir = join(rootDir, 'data', 'watcher-no-progress-lane');
    const ledgerPath = noProgressLaneFilePath(rootDir, identity);
    const warnings = [];

    const first = await promoteStarvedNoProgressLaneLedgers(rootDir, {
      now: 'recover-transient-read',
      logger: { ...silentLogger, warn: (...args) => warnings.push(args.join(' ')) },
      readFileSyncImpl: (filePath, encoding) => {
        if (filePath === ledgerPath) {
          const err = new Error('too many open files');
          err.code = 'EMFILE';
          throw err;
        }
        return readFileSync(filePath, encoding);
      },
    });

    assert.equal(first.attempted, true);
    assert.equal(first.promoted, 0);
    assert.equal(first.reason, 'ledger-read-failed');
    assert.equal(existsSync(ledgerPath), true);
    assert.equal(existsSync(join(laneDir, 'quarantine')), false);
    assert.equal(existsSync(join(laneDir, 'rvhand-10-starved-slow-lane-recovery.promotion.json')), false);
    assert.match(warnings.join('\n'), /transient read error/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('RVHAND-10: starvation recovery retries campaign marker when quarantine fails', async () => {
  const rootDir = tempRoot();
  try {
    const identity = { repo: REPO, prNumber: 6534 };
    for (let i = 0; i < DEFAULT_NO_PROGRESS_LANE_CAP + 2; i += 1) {
      recordNoProgressLaneRun(rootDir, identity, {
        headSha: HEAD_A,
        fingerprint: 'starved-clean-pr',
        now: `t${i}`,
        logger: silentLogger,
      });
    }
    assert.equal(readNoProgressLane(rootDir, identity, { logger: silentLogger }).lane, LANE_SLOW);
    const laneDir = join(rootDir, 'data', 'watcher-no-progress-lane');
    const badLedgerPath = join(laneDir, 'unmovable-read-failure.json');
    writeFileSync(badLedgerPath, '{');

    const first = await promoteStarvedNoProgressLaneLedgers(rootDir, {
      now: 'recover',
      logger: silentLogger,
      mkdirSyncImpl: () => {
        throw new Error('permission denied creating quarantine');
      },
    });

    assert.equal(first.attempted, true);
    assert.equal(first.promoted, 1);
    assert.equal(first.reason, 'ledger-read-failed');
    assert.equal(existsSync(join(laneDir, 'rvhand-10-starved-slow-lane-recovery.promotion.json')), false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('RVHAND-10: starvation recovery ignores ledgers deleted by terminal cleanup', async () => {
  const rootDir = tempRoot();
  try {
    const missingIdentity = { repo: REPO, prNumber: 6529 };
    const promotedIdentity = { repo: REPO, prNumber: 6532 };
    for (const identity of [missingIdentity, promotedIdentity]) {
      for (let i = 0; i < DEFAULT_NO_PROGRESS_LANE_CAP + 2; i += 1) {
        recordNoProgressLaneRun(rootDir, identity, {
          headSha: HEAD_A,
          fingerprint: `starved-clean-pr-${identity.prNumber}`,
          now: `t${i}`,
          logger: silentLogger,
        });
      }
      assert.equal(readNoProgressLane(rootDir, identity, { logger: silentLogger }).lane, LANE_SLOW);
    }

    const missingLedgerPath = noProgressLaneFilePath(rootDir, missingIdentity);
    const laneDir = join(rootDir, 'data', 'watcher-no-progress-lane');
    const warnings = [];
    const first = await promoteStarvedNoProgressLaneLedgers(rootDir, {
      now: 'recover-enoent',
      logger: { ...silentLogger, warn: (...args) => warnings.push(args.join(' ')) },
      readFileSyncImpl: (filePath, encoding) => {
        if (filePath === missingLedgerPath) {
          rmSync(filePath, { force: true });
          const err = new Error('ledger disappeared');
          err.code = 'ENOENT';
          throw err;
        }
        return readFileSync(filePath, encoding);
      },
    });

    assert.equal(first.attempted, true);
    assert.equal(first.promoted, 1);
    assert.equal(first.reason, 'scheduler-starvation-recovery');
    assert.equal(readNoProgressLane(rootDir, promotedIdentity, { logger: silentLogger }).lane, LANE_ACTIVE);
    assert.equal(
      existsSync(join(laneDir, 'rvhand-10-starved-slow-lane-recovery.promotion.json')),
      true,
    );
    assert.equal(warnings.some((line) => /failed to read ledger/.test(line)), false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('RVHAND-10: starvation recovery skips a ledger write failure and promotes the rest', async () => {
  const rootDir = tempRoot();
  try {
    const failedIdentity = { repo: REPO, prNumber: 6530 };
    const promotedIdentity = { repo: REPO, prNumber: 6531 };
    for (const identity of [failedIdentity, promotedIdentity]) {
      for (let i = 0; i < DEFAULT_NO_PROGRESS_LANE_CAP + 2; i += 1) {
        recordNoProgressLaneRun(rootDir, identity, {
          headSha: HEAD_A,
          fingerprint: `starved-clean-pr-${identity.prNumber}`,
          now: `t${i}`,
          logger: silentLogger,
        });
      }
      assert.equal(readNoProgressLane(rootDir, identity, { logger: silentLogger }).lane, LANE_SLOW);
    }

    const failedLedgerPath = noProgressLaneFilePath(rootDir, failedIdentity);
    const laneDir = join(rootDir, 'data', 'watcher-no-progress-lane');
    const warnings = [];
    const first = await promoteStarvedNoProgressLaneLedgers(rootDir, {
      now: 'recover-write-failure',
      logger: { ...silentLogger, warn: (...args) => warnings.push(args.join(' ')) },
      writeFileAtomicImpl: (filePath, contents) => {
        if (filePath === failedLedgerPath) throw new Error('disk full while writing ledger');
        writeFileSync(filePath, contents);
      },
    });

    assert.equal(first.attempted, true);
    assert.equal(first.promoted, 1);
    assert.equal(first.reason, 'ledger-write-failed');
    assert.equal(readNoProgressLane(rootDir, failedIdentity, { logger: silentLogger }).lane, LANE_SLOW);
    assert.equal(readNoProgressLane(rootDir, promotedIdentity, { logger: silentLogger }).lane, LANE_ACTIVE);
    assert.equal(
      existsSync(join(laneDir, 'rvhand-10-starved-slow-lane-recovery.promotion.json')),
      false,
    );
    assert.match(warnings.join('\n'), /failed to write promoted ledger/);
    assert.match(warnings.join('\n'), /left campaign marker unwritten after write errors/);

    const second = await promoteStarvedNoProgressLaneLedgers(rootDir, {
      now: 'recover-write-retry',
      logger: silentLogger,
    });
    const marker = JSON.parse(
      readFileSync(join(laneDir, 'rvhand-10-starved-slow-lane-recovery.promotion.json'), 'utf8'),
    );
    assert.equal(second.promoted, 1);
    assert.equal(second.previouslyPromoted, 1);
    assert.equal(marker.promoted, 2);
    assert.equal(marker.promotedThisPass, 1);
    assert.equal(marker.previouslyPromoted, 1);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('RVHAND-10: starvation recovery caps promotion history in persistent ledgers', async () => {
  const rootDir = tempRoot();
  try {
    const identity = { repo: REPO, prNumber: 6533 };
    for (let i = 0; i < DEFAULT_NO_PROGRESS_LANE_CAP + 2; i += 1) {
      recordNoProgressLaneRun(rootDir, identity, {
        headSha: HEAD_A,
        fingerprint: 'starved-clean-pr-history',
        now: `t${i}`,
        logger: silentLogger,
      });
    }
    const ledgerPath = noProgressLaneFilePath(rootDir, identity);
    writeFileSync(
      ledgerPath,
      `${JSON.stringify({
        ...JSON.parse(readFileSync(ledgerPath, 'utf8')),
        promotionHistory: Array.from({ length: 12 }, (_value, index) => ({
          lane: LANE_SLOW,
          noProgressTicks: index,
          skippedTicks: 0,
          promotionId: `older-recovery-${index}`,
          promotedAt: `earlier-${index}`,
        })),
      }, null, 2)}\n`,
    );

    const result = await promoteStarvedNoProgressLaneLedgers(rootDir, {
      now: 'recover-capped-history',
      logger: silentLogger,
    });
    const recovered = readNoProgressLane(rootDir, identity, { logger: silentLogger });

    assert.equal(result.promoted, 1);
    assert.equal(recovered.promotionHistory.length, 10);
    assert.equal(recovered.promotionHistory[0].promotionId, 'older-recovery-3');
    assert.deepEqual(recovered.promotionHistory.at(-1), recovered.promotedFrom);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('RVHAND-10: starvation recovery dedupes promotion history by promotion id', async () => {
  const rootDir = tempRoot();
  try {
    const identity = { repo: REPO, prNumber: 6538 };
    for (let i = 0; i < DEFAULT_NO_PROGRESS_LANE_CAP + 2; i += 1) {
      recordNoProgressLaneRun(rootDir, identity, {
        headSha: HEAD_A,
        fingerprint: 'starved-clean-pr-history-dedupe',
        now: `t${i}`,
        logger: silentLogger,
      });
    }
    const ledgerPath = noProgressLaneFilePath(rootDir, identity);
    const doc = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    doc.promotedFrom = {
      noProgressTicks: 11,
      lane: LANE_SLOW,
      reason: 'scheduler-starvation-recovery',
      promotedAt: 'previous-pass',
      promotionId: 'same-promotion',
    };
    doc.promotionHistory = [{
      promotionId: 'same-promotion',
      promotedAt: 'previous-pass',
      reason: 'scheduler-starvation-recovery',
      lane: LANE_SLOW,
      noProgressTicks: 11,
    }];
    writeFileSync(ledgerPath, `${JSON.stringify(doc, null, 2)}\n`);

    const result = await promoteStarvedNoProgressLaneLedgers(rootDir, {
      promotionId: 'next-promotion',
      now: 'dedupe-recover',
      logger: silentLogger,
    });
    const recovered = readNoProgressLane(rootDir, identity, { logger: silentLogger });

    assert.equal(result.promoted, 1);
    assert.equal(recovered.promotionHistory.length, 2);
    assert.deepEqual(
      recovered.promotionHistory.map((entry) => entry.promotionId),
      ['same-promotion', 'next-promotion'],
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

test('operator-decision alert debounce key includes fingerprint for same-head retries', async () => {
  const rootDir = tempRoot();
  try {
    const identity = { repo: REPO, prNumber: 6028 };
    const alerts = [];
    const deliverAlertFn = async (text, meta) => { alerts.push({ text, meta }); };

    assert.equal(await maybeFireOperatorDecisionRequiredAlert({
      rootDir,
      identity,
      headSha: HEAD_A,
      fingerprint: 'retry-attempt-1',
      noProgressTicks: DEFAULT_OPERATOR_BLOCKED_ALERT_NO_PROGRESS_TICKS,
      deliverAlertFn,
      logger: silentLogger,
    }), true);
    assert.equal(await maybeFireOperatorDecisionRequiredAlert({
      rootDir,
      identity,
      headSha: HEAD_A,
      fingerprint: 'retry-attempt-1',
      noProgressTicks: DEFAULT_OPERATOR_BLOCKED_ALERT_NO_PROGRESS_TICKS + 1,
      deliverAlertFn,
      logger: silentLogger,
    }), false);

    assert.equal(await maybeFireOperatorDecisionRequiredAlert({
      rootDir,
      identity,
      headSha: HEAD_A,
      fingerprint: 'retry-attempt-2',
      noProgressTicks: DEFAULT_OPERATOR_BLOCKED_ALERT_NO_PROGRESS_TICKS,
      deliverAlertFn,
      logger: silentLogger,
    }), true);
    assert.equal(alerts.length, 2, 'same-head material state changes get a fresh operator page');
    assert.notEqual(
      alerts[0].meta.payload.fingerprintKey,
      alerts[1].meta.payload.fingerprintKey,
      'alert payload exposes the debounce key that distinguished the retries',
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('operator-decision alert cleanup removes every head and fingerprint debounce for a PR', async () => {
  const rootDir = tempRoot();
  try {
    const identity = { repo: REPO, prNumber: 6028 };
    const other = { repo: REPO, prNumber: 6029 };
    const deliverAlertFn = async () => {};
    await maybeFireOperatorDecisionRequiredAlert({
      rootDir,
      identity,
      headSha: HEAD_A,
      fingerprint: 'attempt-a',
      noProgressTicks: DEFAULT_OPERATOR_BLOCKED_ALERT_NO_PROGRESS_TICKS,
      deliverAlertFn,
      logger: silentLogger,
    });
    await maybeFireOperatorDecisionRequiredAlert({
      rootDir,
      identity,
      headSha: HEAD_B,
      fingerprint: 'attempt-b',
      noProgressTicks: DEFAULT_OPERATOR_BLOCKED_ALERT_NO_PROGRESS_TICKS,
      deliverAlertFn,
      logger: silentLogger,
    });
    await maybeFireOperatorDecisionRequiredAlert({
      rootDir,
      identity: other,
      headSha: HEAD_A,
      fingerprint: 'attempt-other',
      noProgressTicks: DEFAULT_OPERATOR_BLOCKED_ALERT_NO_PROGRESS_TICKS,
      deliverAlertFn,
      logger: silentLogger,
    });

    assert.equal(readdirSync(operatorDecisionAlertStateDir(rootDir)).length, 3);
    assert.equal(clearOperatorDecisionAlertState(rootDir, identity, { logger: silentLogger }), true);
    const remaining = readdirSync(operatorDecisionAlertStateDir(rootDir));
    assert.equal(remaining.length, 1);
    assert.match(remaining[0], /-pr-6029-/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('no-progress gate can use the production alert delivery fallback', () => {
  const rootDir = tempRoot();
  try {
    assert.doesNotThrow(() => createNoProgressLaneGate({
      rootDir,
      readReviewRow: () => null,
      logger: silentLogger,
    }));
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
    assert.equal(alerts[0].meta.payload.firstNoProgressAt, '2026-08-31T13:00:00.000Z');
    const alertStateFile = readdirSync(operatorDecisionAlertStateDir(rootDir))[0];
    const alertState = JSON.parse(readFileSync(
      join(operatorDecisionAlertStateDir(rootDir), alertStateFile),
      'utf8',
    ));
    assert.equal(alertState.alertedAt, '2026-08-31T13:00:00.000Z');

    await gate.record(handler, { value });
    assert.equal(alerts.length, 1, 'operator decision alert does not repeat every tick');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('CLZ-03: progressing subjects never emit no-progress stalled events', async () => {
  const rootDir = tempRoot();
  try {
    let attempts = 0;
    const stalledEvents = [];
    const gate = createNoProgressLaneGate({
      rootDir,
      readReviewRow: () => {
        attempts += 1;
        return {
          review_status: 'posted',
          pr_state: 'open',
          reviewer_head_sha: HEAD_A,
          review_attempts: attempts,
          posted_at: '2026-08-31T07:00:00.000Z',
          failed_at: null,
          merged_at: null,
        };
      },
      now: () => '2026-08-31T13:00:00.000Z',
      emitStalledEventFn: async (event) => { stalledEvents.push(event); },
      logger: silentLogger,
    });
    const handler = { repoPath: REPO, prNumber: 6059, headSha: HEAD_A };

    for (let i = 0; i < DEFAULT_NO_PROGRESS_STALLED_EVENT_TICKS + 3; i += 1) {
      await gate.record(handler, {
        value: { amaClosureResult: { reasons: ['blocking-findings-unknown'] } },
      });
    }

    assert.deepEqual(stalledEvents, []);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('CLZ-03: unchanged non-terminal subject emits exactly one stalled event with missing input', async () => {
  const rootDir = tempRoot();
  try {
    const stalledEvents = [];
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
      emitStalledEventFn: async (event) => { stalledEvents.push(event); },
      logger: silentLogger,
    });
    const handler = { repoPath: REPO, prNumber: 6059, headSha: HEAD_A };

    for (let i = 0; i < DEFAULT_NO_PROGRESS_STALLED_EVENT_TICKS + 5; i += 1) {
      await gate.record(handler, {
        value: { amaClosureResult: { reasons: ['blocking-findings-unknown'] } },
      });
    }

    assert.equal(stalledEvents.length, 1);
    assert.equal(stalledEvents[0].event, 'adversarial_review.no_progress_stalled');
    assert.equal(stalledEvents[0].missingInput, 'blocking-findings-unknown');
    assert.equal(stalledEvents[0].producer.exists, null);
    assert.equal(stalledEvents[0].repo, REPO);
    assert.equal(stalledEvents[0].pr, 6059);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('CLZ-03: stalled event emission failure remains retryable until acknowledged', async () => {
  const rootDir = tempRoot();
  try {
    const identity = { repo: REPO, prNumber: 6059 };
    const stalledEvents = [];
    let emitAttempts = 0;
    let observedAt = '2026-08-31T13:00:00.000Z';
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
      now: () => observedAt,
      emitStalledEventFn: async (event) => {
        emitAttempts += 1;
        if (emitAttempts === 1) throw new Error('event bus unavailable');
        stalledEvents.push(event);
      },
      logger: silentLogger,
    });
    const handler = { repoPath: REPO, prNumber: 6059, headSha: HEAD_A };

    for (let i = 0; i < DEFAULT_NO_PROGRESS_STALLED_EVENT_TICKS; i += 1) {
      await gate.record(handler, {
        value: { amaClosureResult: { reasons: ['blocking-findings-unknown'] } },
      });
    }
    await gate.record(handler, {
      value: { amaClosureResult: { reasons: ['blocking-findings-unknown'] } },
    });
    const pending = readNoProgressLane(rootDir, identity, { logger: silentLogger }).stalledEvent;
    assert.equal(emitAttempts, 1);
    assert.equal(pending.pendingSince, '2026-08-31T13:00:00.000Z');
    assert.equal(
      pending.emitted,
      false,
      'failed delivery is recorded as pending, not emitted',
    );

    observedAt = '2026-08-31T13:05:00.000Z';
    await gate.record(handler, {
      value: { amaClosureResult: { reasons: ['blocking-findings-unknown'] } },
    });
    await gate.record(handler, {
      value: { amaClosureResult: { reasons: ['blocking-findings-unknown'] } },
    });

    assert.equal(emitAttempts, 2);
    assert.equal(stalledEvents.length, 1);
    assert.equal(stalledEvents[0].missingInput, 'blocking-findings-unknown');
    const emitted = readNoProgressLane(rootDir, identity, { logger: silentLogger }).stalledEvent;
    assert.equal(emitted.emitted, true, 'successful retry acknowledges the stalled event');
    assert.equal(emitted.pendingSince, '2026-08-31T13:00:00.000Z');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('no-progress gate treats AMA needsOperator as operator-blocked', async () => {
  const rootDir = tempRoot();
  try {
    const identity = { repo: REPO, prNumber: 6030 };
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
      logger: silentLogger,
    });
    const handler = { repoPath: identity.repo, prNumber: identity.prNumber, headSha: HEAD_A };

    await gate.record(handler, {
      value: {
        outcome: 'ama-pending',
        amaClosureResult: {
          needsOperator: true,
          reason: 'dispatch-branch-holder-block-exhausted',
          reasons: ['branch-holder-blocked'],
        },
      },
    });

    const ledger = readNoProgressLane(rootDir, identity, { logger: silentLogger });
    assert.equal(ledger.lane, LANE_OPERATOR_BLOCKED);
    assert.equal(ledger.progressClass, PROGRESS_CLASS_OPERATOR_DECISION_REQUIRED);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('CLZ-03: stalled event delivery failure does not abort operator alerts', async () => {
  const rootDir = tempRoot();
  try {
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
      emitStalledEventFn: async () => { throw new Error('event bus unavailable'); },
      deliverAlertFn: async (text, meta) => { alerts.push({ text, meta }); },
      logger: silentLogger,
    });
    const handler = { repoPath: REPO, prNumber: 6059, headSha: HEAD_A };

    for (let i = 0; i <= DEFAULT_OPERATOR_BLOCKED_ALERT_NO_PROGRESS_TICKS; i += 1) {
      await gate.record(handler, {
        value: {
          amaClosureResult: { reasons: ['blocking-findings-unknown'] },
          gateDecision: { operatorDecisionRequired: true },
        },
      });
    }

    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].meta.event, 'adversarial_review.operator_decision_required');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('CLZ-03: stalled verdict event records no producer when auto-refresh is suppressed', async () => {
  const rootDir = tempRoot();
  try {
    const stalledEvents = [];
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
      emitStalledEventFn: async (event) => { stalledEvents.push(event); },
      logger: silentLogger,
    });
    const handler = {
      repoPath: REPO,
      prNumber: 6059,
      headSha: HEAD_A,
      stalledProducerHints: {
        'verdict-not-settled-success': {
          exists: false,
          reason: 'auto-refresh-suppressed:closer-commit-trailer',
          source: 'head-closer-commit-suppression',
        },
      },
    };

    for (let i = 0; i < DEFAULT_NO_PROGRESS_STALLED_EVENT_TICKS + 1; i += 1) {
      await gate.record(handler, {
        value: { amaClosureResult: { reasons: ['verdict-not-settled-success'] } },
      });
    }

    assert.equal(stalledEvents.length, 1);
    assert.equal(stalledEvents[0].missingInput, 'verdict-not-settled-success');
    assert.equal(stalledEvents[0].producer.exists, false);
    assert.equal(stalledEvents[0].producer.reason, 'auto-refresh-suppressed:closer-commit-trailer');
    assert.equal(stalledEvents[0].producer.source, 'head-closer-commit-suppression');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('CLZ-03: terminal subject never emits no-progress stalled events', async () => {
  const rootDir = tempRoot();
  try {
    const stalledEvents = [];
    const gate = createNoProgressLaneGate({
      rootDir,
      readReviewRow: () => ({
        review_status: 'posted',
        pr_state: 'merged',
        reviewer_head_sha: HEAD_A,
        review_attempts: 1,
        posted_at: '2026-08-31T07:00:00.000Z',
        failed_at: null,
        merged_at: '2026-08-31T13:00:00.000Z',
      }),
      now: () => '2026-08-31T13:00:00.000Z',
      emitStalledEventFn: async (event) => { stalledEvents.push(event); },
      logger: silentLogger,
    });
    const handler = { repoPath: REPO, prNumber: 6059, headSha: HEAD_A };

    for (let i = 0; i < DEFAULT_NO_PROGRESS_STALLED_EVENT_TICKS + 5; i += 1) {
      await gate.record(handler, {
        value: { amaClosureResult: { reasons: ['verdict-not-settled-success'] } },
      });
    }

    assert.deepEqual(stalledEvents, []);
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

test('poll-starvation handler marks the heartbeat, pages, and requests respawn without touching last_poll_at', async () => {
  const persisted = [];
  const alerts = [];
  const restarts = [];
  const handler = createPollStarvationHandler({
    getHeartbeat: () => ({ persist: (event, extra) => persisted.push({ event, extra }) }),
    deliverAlertFn: async (text, meta) => { alerts.push({ text, meta }); },
    requestRestartFn: (event) => { restarts.push(event); },
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
  assert.equal(restarts.length, 1);
  assert.equal(restarts[0].reason, 'poll-in-flight-past-sla-with-frozen-poll-counter');
  assert.equal(restarts[0].inFlightMs, 2_400_000);
  assert.equal(restarts[0].heartbeat.poll_counter, 41);
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

test('poll-starvation handler requests respawn even when alert delivery is disabled', () => {
  const restarts = [];
  const handler = createPollStarvationHandler({
    getHeartbeat: () => null,
    requestRestartFn: (event) => { restarts.push(event); },
    logger: silentLogger,
  });
  handler({ inFlightMs: 1_000_000, starvationMs: 900_000, checks: 3, heartbeat: {} });
  assert.equal(restarts.length, 1);
});

test('poll-starvation restart requester preserves reviewer sessions for launchd respawn', () => {
  const exits = [];
  const requestRestart = createPollStarvationRestartRequester({
    exitAfterReviewerCleanup: (event) => { exits.push(event); },
    exitCode: DEFAULT_WATCHER_STALL_EXIT_CODE,
  });
  requestRestart({ inFlightMs: 1_000_000, heartbeat: { poll_counter: 12, last_poll_at: '2026-08-25T10:00:00.000Z' } });
  assert.equal(exits.length, 1);
  assert.equal(exits[0].code, DEFAULT_WATCHER_STALL_EXIT_CODE);
  assert.equal(exits[0].reason, 'watcher poll-starvation watchdog');
  assert.equal(exits[0].preserveInFlightReviewers, undefined);
  assert.match(exits[0].err.message, /poll_counter=12/);
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

// ── LANESTARVE-01: the slow lane must not absorb the whole queue ─────────────
//
// Measured shape, /Users/airlock/Library/Logs/adversarial-watcher.log 2026-09-12:
// `slow_lane_deferred=1040` against `ran=278`, with 95 phases logging
// "posted-review phase made zero progress: queued=5 ran=0 ... slow_lane_deferred=5
// budget_deferred=0 timeout_deferred=0". Queued work, a 10-minute phase budget
// untouched, and nothing run. The lane is advisory; the scheduler was treating
// it as absolute, so an entirely lane-deferred tick spent its whole interval
// doing nothing while the fleet's autonomous merge share fell from 96% to 49%.
//
// Two defects, regressed separately below:
//   1. no minimum-service floor — `ran=0` with budget in hand was reachable;
//   2. a self-reinforcing demotion — the progress signal is blind to CI,
//      mergeability, and lease ownership, and every unproductive walk doubled
//      the wait for the next one, so escaping the lane got monotonically harder.

// Build the decision fingerprint through the module when it exports one, and
// through an equivalent local encoding when it does not. That keeps the A/B
// honest: against `main` the tests below fail because the lane IGNORES a changed
// handler decision, not merely because a symbol is missing.
function decisionFingerprintOf(value) {
  return typeof noProgressLane.handlerDecisionFingerprint === 'function'
    ? noProgressLane.handlerDecisionFingerprint(value)
    : JSON.stringify(value);
}

test('LANESTARVE-01: an all-slow-lane tick drains instead of reporting ran=0', async () => {
  const ran = [];
  const warnings = [];
  const handlers = [1, 2, 3, 4, 5].map((prNumber) => ({
    repoPath: REPO,
    prNumber,
    headSha: HEAD_A,
    run: async () => { ran.push(prNumber); },
  }));

  const summary = await runPostedReviewHandlersFairly({
    handlers,
    // Every PR slow-lane classified and none of them due: the exact live shape.
    laneGate: {
      evaluate: (handler) => ({
        run: false,
        lane: LANE_SLOW,
        noProgressTicks: 7,
        backoffTicks: 12,
        // #3 has waited the longest since its last walk.
        skippedTicks: handler.prNumber === 3 ? 9 : 2,
      }),
      record: () => {},
    },
    logger: { log() {}, warn: (line) => warnings.push(String(line)), error() {} },
  });

  assert.equal(summary.queued, 5);
  assert.equal(
    summary.ran,
    1,
    'a tick with queued work and an untouched budget must not run nothing at all',
  );
  assert.deepEqual(ran, [3], 'the floor admits the most-starved deferred PR');
  assert.equal(summary.laneFloorAdmissions, 1);
  assert.equal(summary.skippedByLane, 4, 'the admitted handler is no longer counted as deferred');
  assert.ok(
    warnings.some((line) => /slow-lane floor: admitting .*#3/.test(line)),
    'the admission is operator-visible, not silent',
  );
  assert.equal(
    warnings.some((line) => /made zero progress/.test(line)),
    false,
    'the zero-progress signature is gone because the tick is no longer idle',
  );
});

test('LANESTARVE-01: the floor never preempts a PR the lane considers live', async () => {
  const ran = [];
  const summary = await runPostedReviewHandlersFairly({
    handlers: [
      // A fast PR the lane is happy to walk...
      { repoPath: REPO, prNumber: 10, headSha: HEAD_A, run: async () => { ran.push(10); } },
      // ...and a genuinely slow one, deeply backed off.
      { repoPath: REPO, prNumber: 20, headSha: HEAD_A, run: async () => { ran.push(20); } },
    ],
    laneGate: {
      evaluate: (handler) => (handler.prNumber === 10
        ? { run: true, lane: LANE_ACTIVE }
        : { run: false, lane: LANE_SLOW, noProgressTicks: 9, backoffTicks: 12, skippedTicks: 11 }),
      record: () => {},
    },
    logger: silentLogger,
  });

  assert.deepEqual(ran, [10], 'the slow PR stays deprioritised while a fast PR wants the tick');
  assert.equal(summary.skippedByLane, 1);
  // Deliberately an invariant guard, not an A/B test: "a genuinely slow PR stays
  // deprioritised behind a fast one" must hold BOTH before and after this change.
  // Written so it passes on `main` too — if it ever goes red, the fix has traded
  // starvation for the loss of the prioritisation the lane exists to provide.
  assert.ok(!summary.laneFloorAdmissions, 'the floor only claims a slot nothing else wanted');
});

test('LANESTARVE-01: the floor stands down when the budget cannot cover a handler', async () => {
  let clock = 0;
  const ran = [];
  const warnings = [];
  const summary = await runPostedReviewHandlersFairly({
    handlers: [{
      repoPath: REPO,
      prNumber: 42,
      headSha: HEAD_A,
      run: async () => { ran.push(42); },
    }],
    budgetMs: 100,
    // Enough budget to walk the queue and evaluate the lane, not enough left
    // by the time the floor pass asks.
    minimumHandlerStartBudgetMs: 50,
    nowMs: () => { clock += 40; return clock; },
    laneGate: {
      evaluate: () => ({ run: false, lane: LANE_SLOW, noProgressTicks: 5, backoffTicks: 4, skippedTicks: 1 }),
      record: () => {},
    },
    logger: { log() {}, warn: (line) => warnings.push(String(line)), error() {} },
  });

  assert.deepEqual(ran, [], 'the floor never overruns the phase budget it is bounded by');
  assert.ok(
    warnings.some((line) => /slow-lane floor could not run/.test(line)),
    'a floor that cannot fire reports why instead of failing silently',
  );
  assert.equal(summary.laneFloorAdmissions, 0);
});

test('LANESTARVE-01: a floor-admitted walk does not escalate the backoff it did not earn', async () => {
  const rootDir = tempRoot();
  try {
    const identity = { repo: REPO, prNumber: 6649 };
    const stuck = subjectProgressFingerprint(
      { review_status: 'posted', pr_state: 'open', reviewer_head_sha: HEAD_A, review_attempts: 1 },
      { headSha: HEAD_A },
    );

    // Walk it into the slow lane the ordinary way.
    let outcome = null;
    for (let i = 0; i <= DEFAULT_NO_PROGRESS_LANE_CAP; i += 1) {
      outcome = recordNoProgressLaneRun(rootDir, identity, {
        headSha: HEAD_A,
        fingerprint: stuck,
        now: `t${i}`,
        logger: silentLogger,
      });
    }
    assert.equal(outcome.lane, LANE_SLOW);
    const demotedTicks = outcome.noProgressTicks;
    const demotedBackoff = outcome.backoffTicks;

    // A walk the lane never scheduled. It still could not move the PR, but the
    // lane did not ask for it, so it must not cost the PR anything.
    const floorWalk = recordNoProgressLaneRun(rootDir, identity, {
      headSha: HEAD_A,
      fingerprint: stuck,
      escalate: false,
      now: 'floor',
      logger: silentLogger,
    });
    assert.equal(
      floorWalk.noProgressTicks,
      demotedTicks,
      'an opportunistic look must not push the next real walk further away',
    );
    assert.equal(floorWalk.escalated, false);
    assert.equal(floorWalk.backoffTicks, demotedBackoff);
    assert.equal(
      readNoProgressLane(rootDir, identity, { logger: silentLogger }).skippedTicks,
      0,
      'the PR was walked, so its backoff window restarts',
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('LANESTARVE-01: a changed handler decision breaks the self-reinforcing demotion', async () => {
  const rootDir = tempRoot();
  try {
    const identity = { repo: REPO, prNumber: 1046 };
    // The review row NEVER changes: the watcher writes nothing for a clean PR
    // that is only waiting on CI. This is what the lane reads as "cannot move".
    const unchangedRow = subjectProgressFingerprint(
      { review_status: 'posted', pr_state: 'open', reviewer_head_sha: HEAD_A, review_attempts: 1 },
      { headSha: HEAD_A },
    );
    const blockedOnCi = decisionFingerprintOf({
      outcome: 'await-operator',
      gateDecision: { state: 'success', reason: 'review-settled' },
      amaClosureResult: { reason: 'not-eligible', reasons: ['ci-not-green'] },
    });
    const ciGreen = decisionFingerprintOf({
      outcome: 'await-operator',
      gateDecision: { state: 'success', reason: 'review-settled' },
      amaClosureResult: { reason: 'not-eligible', reasons: ['pr-not-mergeable'] },
    });
    assert.notEqual(blockedOnCi, ciGreen);

    let outcome = null;
    for (let i = 0; i <= DEFAULT_NO_PROGRESS_LANE_CAP; i += 1) {
      outcome = recordNoProgressLaneRun(rootDir, identity, {
        headSha: HEAD_A,
        fingerprint: unchangedRow,
        decisionFingerprint: blockedOnCi,
        now: `t${i}`,
        logger: silentLogger,
      });
    }
    assert.equal(outcome.lane, LANE_SLOW, 'a PR whose blocker never moves is still demoted');

    // CI goes green. The review row is byte-identical — the watcher wrote
    // nothing — but the handler now reports a different blocker, which is
    // observable evidence that the world moved.
    const recovered = recordNoProgressLaneRun(rootDir, identity, {
      headSha: HEAD_A,
      fingerprint: unchangedRow,
      decisionFingerprint: ciGreen,
      now: 'ci-green',
      logger: silentLogger,
    });
    assert.equal(recovered.noProgressTicks, 0);
    assert.equal(recovered.decisionChanged, true);
    assert.equal(recovered.decisionReset, true);
    assert.equal(
      recovered.lane,
      LANE_ACTIVE,
      'the PR is walked every tick again instead of waiting out a 12-tick backoff it no longer deserves',
    );
    assert.equal(
      evaluateNoProgressLane(readNoProgressLane(rootDir, identity, { logger: silentLogger }), {
        headSha: HEAD_A,
      }).due,
      true,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('LANESTARVE-01: decision-only resets are capped so a flapping PR still demotes', async () => {
  const rootDir = tempRoot();
  try {
    const identity = { repo: REPO, prNumber: 6654 };
    const unchangedRow = subjectProgressFingerprint(
      { review_status: 'posted', pr_state: 'open', reviewer_head_sha: HEAD_A, review_attempts: 1 },
      { headSha: HEAD_A },
    );

    // Alternate the reported blocker on every single walk. Without a cap this
    // would hold the PR in the active lane forever and recreate the unbounded
    // posted-review phase WPS-01 exists to prevent.
    const RESET_CAP = 5;

    let outcome = null;
    for (let i = 0; i < (RESET_CAP + DEFAULT_NO_PROGRESS_LANE_CAP + 2); i += 1) {
      outcome = recordNoProgressLaneRun(rootDir, identity, {
        headSha: HEAD_A,
        fingerprint: unchangedRow,
        decisionFingerprint: decisionFingerprintOf({
          amaClosureResult: { reasons: [i % 2 === 0 ? 'ci-not-green' : 'pr-not-mergeable'] },
        }),
        now: `t${i}`,
        logger: silentLogger,
      });
    }

    assert.equal(
      outcome.decisionResets,
      RESET_CAP,
      'the escape hatch is bounded per head',
    );
    assert.equal(outcome.lane, LANE_SLOW, 'once the cap is spent the lane demotes as it always did');
    assert.equal(noProgressLane.DEFAULT_NO_PROGRESS_DECISION_RESET_CAP, RESET_CAP);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('LANESTARVE-01: a slow-lane PR is re-walked within the ceiling however deep its backoff', () => {
  // 12 ticks = one hour at the production 5m cadence, the ceiling the module
  // already documents. Asserted as a literal so the claim survives the constant
  // being renamed, and cross-checked against the export below.
  const CEILING = 12;
  const ledger = {
    headSha: HEAD_A,
    progressClass: 'self-resolving',
    fingerprint: 'x',
    noProgressTicks: 40,
    skippedTicks: CEILING,
  };
  // Even asked for an absurd backoff, the ceiling is what decides.
  const decision = evaluateNoProgressLane(ledger, {
    headSha: HEAD_A,
    maxBackoffTicks: 10_000,
  });
  assert.equal(decision.lane, LANE_SLOW);
  assert.equal(decision.backoffTicks, CEILING);
  assert.equal(decision.due, true, 'no PR sits in the slow lane past the re-walk ceiling');
  assert.equal(decision.reason, 'slow-lane-rewalk-ceiling');
  assert.equal(noProgressLane.DEFAULT_NO_PROGRESS_REWALK_CEILING_TICKS, CEILING);
});

test('LANESTARVE-01: the gate threads the handler decision and floor admission into the ledger', async () => {
  const rootDir = tempRoot();
  try {
    const row = { review_status: 'posted', pr_state: 'open', reviewer_head_sha: HEAD_A, review_attempts: 1 };
    const gate = createNoProgressLaneGate({
      rootDir,
      readReviewRow: () => row,
      now: () => '2026-09-12T00:00:00.000Z',
      logger: silentLogger,
    });
    const handler = { repoPath: REPO, prNumber: 777, headSha: HEAD_A };

    await gate.record(handler, {
      value: { outcome: 'await-operator', amaClosureResult: { reasons: ['ci-not-green'] } },
    });
    const first = readNoProgressLane(rootDir, { repo: REPO, prNumber: 777 }, { logger: silentLogger });
    assert.equal(
      first.decisionFingerprint,
      decisionFingerprintOf({ outcome: 'await-operator', amaClosureResult: { reasons: ['ci-not-green'] } }),
      'the gate persists what the handler actually decided, not just the review row',
    );

    // Same row, same decision, but admitted by the starvation floor: no escalation.
    await gate.record(handler, {
      value: { outcome: 'await-operator', amaClosureResult: { reasons: ['ci-not-green'] } },
      laneAdmission: 'starvation-floor',
    });
    const second = readNoProgressLane(rootDir, { repo: REPO, prNumber: 777 }, { logger: silentLogger });
    assert.equal(
      second.noProgressTicks,
      first.noProgressTicks,
      'a floor admission recorded through the real gate does not escalate either',
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

// --- LANESTARVE-01 review follow-up: the operator-alert debounce must not
// --- survive a decision-only reset ------------------------------------------
//
// The no-progress ledger and the operator-decision alert debounce are SEPARATE
// durable stores. The debounce is keyed by repo/PR/head/review-state
// fingerprint and NOT by decisionFingerprint, so a decision-only reset leaves
// the key identical.
//
// That is exactly the case the reset represents: "the blocker moved even though
// the row did not." Restarting the counter while holding the old debounce parks
// a PR on a DIFFERENT operator-required condition and never tells the operator —
// the alert the new series earns is swallowed by a debounce written for a
// blocker that no longer applies.
//
// `clearNoProgressLane` already clears this store when the whole lane is
// dropped; a decision-only reset has the same claim on it.

test('LANESTARVE-01: a decision-only reset re-arms the operator-decision alert', async () => {
  const rootDir = tempRoot();
  try {
    const identity = { repo: REPO, prNumber: 1061 };
    // The review row never changes — the watcher writes nothing for a PR that is
    // only waiting on an operator — so the debounce key is stable across both
    // series. That stability is the whole bug.
    const unchangedRow = subjectProgressFingerprint(
      { review_status: 'posted', pr_state: 'open', reviewer_head_sha: HEAD_A, review_attempts: 1 },
      { headSha: HEAD_A },
    );
    const blockerOne = decisionFingerprintOf({
      outcome: 'await-operator',
      gateDecision: { state: 'blocked', reason: 'blocking-findings' },
      amaClosureResult: { reason: 'not-eligible', reasons: ['blocking-findings'] },
    });
    const blockerTwo = decisionFingerprintOf({
      outcome: 'await-operator',
      gateDecision: { state: 'blocked', reason: 'operator-skip-label' },
      amaClosureResult: { reason: 'not-eligible', reasons: ['operator-skip-label'] },
    });
    assert.notEqual(blockerOne, blockerTwo, 'the two blockers must differ for this test to mean anything');

    const alerts = [];
    const deliverAlertFn = async (text, meta) => { alerts.push({ text, meta }); };

    // Series 1: drive past the alert threshold and fire the operator alert.
    let outcome = null;
    for (let i = 0; i <= DEFAULT_OPERATOR_BLOCKED_ALERT_NO_PROGRESS_TICKS; i += 1) {
      outcome = recordNoProgressLaneRun(rootDir, identity, {
        headSha: HEAD_A,
        fingerprint: unchangedRow,
        decisionFingerprint: blockerOne,
        progressClass: PROGRESS_CLASS_OPERATOR_DECISION_REQUIRED,
        now: `a${i}`,
        logger: silentLogger,
      });
    }
    const firedFirst = await maybeFireOperatorDecisionRequiredAlert({
      rootDir,
      identity,
      headSha: HEAD_A,
      fingerprint: unchangedRow,
      noProgressTicks: outcome.noProgressTicks,
      deliverAlertFn,
      logger: silentLogger,
    });
    assert.equal(firedFirst, true, 'the first operator alert must fire');
    assert.equal(alerts.length, 1);

    // Debounce holds while the SAME blocker persists — this must keep working.
    const suppressed = await maybeFireOperatorDecisionRequiredAlert({
      rootDir,
      identity,
      headSha: HEAD_A,
      fingerprint: unchangedRow,
      noProgressTicks: outcome.noProgressTicks,
      deliverAlertFn,
      logger: silentLogger,
    });
    assert.equal(suppressed, false, 'the debounce must still suppress a repeat of the same blocker');
    assert.equal(alerts.length, 1);

    // The blocker moves. Row is byte-identical, so the debounce key is too.
    const reset = recordNoProgressLaneRun(rootDir, identity, {
      headSha: HEAD_A,
      fingerprint: unchangedRow,
      decisionFingerprint: blockerTwo,
      progressClass: PROGRESS_CLASS_OPERATOR_DECISION_REQUIRED,
      now: 'blocker-moved',
      logger: silentLogger,
    });
    assert.equal(reset.decisionReset, true, 'the decision change must reset the series');
    assert.equal(reset.noProgressTicks, 0);

    // Series 2: the NEW blocker earns its own alert.
    let second = reset;
    for (let i = 0; i <= DEFAULT_OPERATOR_BLOCKED_ALERT_NO_PROGRESS_TICKS; i += 1) {
      second = recordNoProgressLaneRun(rootDir, identity, {
        headSha: HEAD_A,
        fingerprint: unchangedRow,
        decisionFingerprint: blockerTwo,
        progressClass: PROGRESS_CLASS_OPERATOR_DECISION_REQUIRED,
        now: `b${i}`,
        logger: silentLogger,
      });
    }
    const firedSecond = await maybeFireOperatorDecisionRequiredAlert({
      rootDir,
      identity,
      headSha: HEAD_A,
      fingerprint: unchangedRow,
      noProgressTicks: second.noProgressTicks,
      deliverAlertFn,
      logger: silentLogger,
    });
    assert.equal(
      firedSecond,
      true,
      'a decision-only reset must re-arm the alert: the PR is parked on a DIFFERENT operator blocker and the operator has not been told',
    );
    assert.equal(alerts.length, 2);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
