// CLZ-03 regression suite — a stalled PR must stop reading as an idle one.
//
// Incident being regressed (agent-os#6059): clean, unmerged, 12.7 hours. The
// watcher logged it every single tick, and every line said
//
//   [watcher] no-progress lane: deferring laceyenterprises/agent-os#6059 this tick
//             (lane=slow no_progress_ticks=15 backoff_ticks=12) — still tracked,
//             re-walked in 12 tick(s)
//
// which is exactly what a healthy quiet PR emits. The backoff was RIGHT. The
// signal was wrong. The true statement — available in state the whole time —
// was "needs a settled verdict at head a111abc7f, and no producer exists,
// because auto-refresh is suppressed for that head (closer-commit-trailer)".
//
// These tests pin the five properties the signal has to hold: it fires only on
// a genuine stall, it fires exactly once, it names the SPECIFIC missing input,
// it says whether anything can produce that input, and it never fires on a
// terminal subject.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createNoProgressLaneGate } from '../src/posted-review-row.mjs';
import { clearNoProgressLane } from '../src/watcher-no-progress-lane.mjs';
import {
  DEFAULT_STALLED_SIGNAL_TICKS,
  PRODUCER_NO,
  PRODUCER_UNKNOWN,
  PRODUCER_YES,
  STALLED_SIGNAL_EVENT,
  deriveMissingInput,
  evaluateStalledSignal,
  formatStalledSignalLine,
  resolveStalledSignalTicks,
  stalledSignalEventDir,
  stalledSignalStateDir,
} from '../src/watcher-stalled-signal.mjs';

const REPO = 'laceyenterprises/agent-os';
const PR = 6059;
// The head #6059 was pinned to, padded to a real 40-char sha shape.
const HEAD_CURRENT = 'a111abc7f00000000000000000000000000000000';
const HEAD_REVIEWED = 'c0ffee0000000000000000000000000000000000';

const silentLogger = { log() {}, warn() {}, error() {} };

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'clz-03-'));
}

function readStalledEvents(rootDir) {
  const dir = stalledSignalEventDir(rootDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .sort()
    .flatMap((name) => readFileSync(join(dir, name), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line)));
}

/**
 * The #6059 shape: a `posted` review on an older head, the current head is a
 * closer-authored commit, and auto-refresh is therefore suppressed for it. AMA
 * is not eligible because the verdict at the current head is not settled.
 */
function sixThousandFiftyNineRow(overrides = {}) {
  return {
    review_status: 'posted',
    pr_state: 'open',
    reviewer_head_sha: HEAD_REVIEWED,
    review_attempts: 1,
    posted_at: '2026-09-02T09:00:00.000Z',
    failed_at: null,
    merged_at: null,
    ...overrides,
  };
}

function sixThousandFiftyNineHandler() {
  return {
    repoPath: REPO,
    prNumber: PR,
    headSha: HEAD_CURRENT,
    autoRefreshSuppression: {
      headMoved: true,
      reviewerHeadSha: HEAD_REVIEWED,
      suppressed: true,
      reason: 'closer-commit-trailer',
    },
  };
}

const AWAIT_OPERATOR_VALUE = {
  handled: true,
  outcome: 'await-operator',
  gateDecision: { state: 'failure', reason: 'verdict-not-settled', operatorDecisionRequired: false },
  amaClosureResult: { reason: 'not-eligible', reasons: ['verdict-not-settled-success'] },
};

// ── The event itself ─────────────────────────────────────────────────────────

test('CLZ-03: a non-terminal subject with no state change emits exactly one stalled event naming the missing input', async () => {
  const rootDir = tempRoot();
  try {
    let clock = Date.parse('2026-09-02T10:00:00.000Z');
    const gate = createNoProgressLaneGate({
      rootDir,
      readReviewRow: () => sixThousandFiftyNineRow(),
      now: () => new Date(clock).toISOString(),
      logger: silentLogger,
    });
    const handler = sixThousandFiftyNineHandler();

    // Ten ticks that change nothing — the live #6059 cadence, not a contrived
    // single step over the threshold.
    for (let i = 0; i < 10; i += 1) {
      await gate.record(handler, { value: AWAIT_OPERATOR_VALUE });
      clock += 5 * 60 * 1000;
    }

    const events = readStalledEvents(rootDir);
    assert.equal(events.length, 1, 'exactly one stalled event per stall');
    const [event] = events;
    assert.equal(event.event, STALLED_SIGNAL_EVENT);
    assert.equal(event.repo, REPO);
    assert.equal(event.prNumber, PR);
    assert.equal(event.headSha, HEAD_CURRENT);
    assert.equal(event.noProgressTicks, DEFAULT_STALLED_SIGNAL_TICKS);
    assert.equal(event.thresholdTicks, DEFAULT_STALLED_SIGNAL_TICKS);

    // The specific missing input, not a generic "blocked".
    assert.equal(event.missingInput.input, 'settled-verdict');
    assert.equal(event.missingInput.amaReason, 'verdict-not-settled-success');
    assert.match(event.missingInput.description, /a settled verdict at head a111abc7f/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('CLZ-03: the stalled event records that NO producer exists when auto-refresh is suppressed for the head', async () => {
  const rootDir = tempRoot();
  try {
    const logged = [];
    const gate = createNoProgressLaneGate({
      rootDir,
      readReviewRow: () => sixThousandFiftyNineRow(),
      now: () => '2026-09-02T10:00:00.000Z',
      logger: { log() {}, error() {}, warn: (line) => logged.push(String(line)) },
    });
    const handler = sixThousandFiftyNineHandler();

    // K+1 walks: the first establishes the fingerprint baseline, the next K
    // observe it unchanged. `noProgressTicks` counts the unchanged observations.
    for (let i = 0; i <= DEFAULT_STALLED_SIGNAL_TICKS; i += 1) {
      await gate.record(handler, { value: AWAIT_OPERATOR_VALUE });
    }

    const [event] = readStalledEvents(rootDir);
    assert.ok(event, 'the stall was reported');
    assert.equal(event.producer.exists, PRODUCER_NO);
    assert.equal(event.producer.name, null);
    assert.match(event.producer.detail, /auto-refresh is suppressed for this head \(closer-commit-trailer\)/);

    // And the operator-facing line cannot be mistaken for the idle line it
    // replaces: it says STALLED, names the input, and says nothing can produce it.
    const line = logged.find((entry) => entry.includes('STALLED'));
    assert.ok(line, `expected a STALLED log line, got: ${JSON.stringify(logged)}`);
    assert.match(line, /STALLED laceyenterprises\/agent-os#6059 for 3 ticks/);
    assert.match(line, /needs a settled verdict at head a111abc7f/);
    assert.match(line, /No producer exists/);
    assert.match(line, /This cannot self-resolve/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('CLZ-03: a subject whose state changes between ticks never emits stalled', async () => {
  const rootDir = tempRoot();
  try {
    let attempts = 1;
    const gate = createNoProgressLaneGate({
      rootDir,
      // Each tick observably advances the row, exactly as a productive tick does.
      readReviewRow: () => sixThousandFiftyNineRow({ review_attempts: attempts++ }),
      now: () => '2026-09-02T10:00:00.000Z',
      logger: silentLogger,
    });
    const handler = sixThousandFiftyNineHandler();

    for (let i = 0; i < DEFAULT_STALLED_SIGNAL_TICKS * 4; i += 1) {
      await gate.record(handler, { value: AWAIT_OPERATOR_VALUE });
    }

    assert.deepEqual(readStalledEvents(rootDir), [], 'a progressing subject is never stalled');
    assert.equal(existsSync(stalledSignalStateDir(rootDir)), false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('CLZ-03: a terminal subject never emits stalled, however many unchanged ticks it takes', async () => {
  const rootDir = tempRoot();
  try {
    const gate = createNoProgressLaneGate({
      rootDir,
      readReviewRow: () => sixThousandFiftyNineRow({
        pr_state: 'merged',
        merged_at: '2026-09-02T09:30:00.000Z',
      }),
      now: () => '2026-09-02T10:00:00.000Z',
      logger: silentLogger,
    });
    const handler = sixThousandFiftyNineHandler();

    for (let i = 0; i < DEFAULT_STALLED_SIGNAL_TICKS * 4; i += 1) {
      await gate.record(handler, { value: AWAIT_OPERATOR_VALUE });
    }

    assert.deepEqual(readStalledEvents(rootDir), [], 'a merged PR has no missing input');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('CLZ-03: a PR the live candidate read shows as terminal mid-tick never emits stalled', async () => {
  const rootDir = tempRoot();
  try {
    const gate = createNoProgressLaneGate({
      rootDir,
      // The row has not caught up yet — the handler's own live read has.
      readReviewRow: () => sixThousandFiftyNineRow(),
      now: () => '2026-09-02T10:00:00.000Z',
      logger: silentLogger,
    });
    const handler = sixThousandFiftyNineHandler();
    const value = { handled: true, prTerminal: true, gateDecision: null };

    for (let i = 0; i < DEFAULT_STALLED_SIGNAL_TICKS * 2; i += 1) {
      await gate.record(handler, { value });
    }

    assert.deepEqual(readStalledEvents(rootDir), []);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('CLZ-03: repeated ticks after the first stalled event do not re-emit it', async () => {
  const rootDir = tempRoot();
  try {
    const gate = createNoProgressLaneGate({
      rootDir,
      readReviewRow: () => sixThousandFiftyNineRow(),
      now: () => '2026-09-02T10:00:00.000Z',
      logger: silentLogger,
    });
    const handler = sixThousandFiftyNineHandler();

    for (let i = 0; i <= DEFAULT_STALLED_SIGNAL_TICKS; i += 1) {
      await gate.record(handler, { value: AWAIT_OPERATOR_VALUE });
    }
    assert.equal(readStalledEvents(rootDir).length, 1);

    // 40 more identical ticks — the #6059 duration at a 5m cadence would be
    // ~150 of these. None of them may add a second event.
    for (let i = 0; i < 40; i += 1) {
      await gate.record(handler, { value: AWAIT_OPERATOR_VALUE });
    }
    assert.equal(readStalledEvents(rootDir).length, 1, 'one event per stall, not one per tick');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('CLZ-03: a new head ends the stall and a fresh stall on that head reports again', async () => {
  const rootDir = tempRoot();
  try {
    let row = sixThousandFiftyNineRow();
    const gate = createNoProgressLaneGate({
      rootDir,
      readReviewRow: () => row,
      now: () => '2026-09-02T10:00:00.000Z',
      logger: silentLogger,
    });

    const first = sixThousandFiftyNineHandler();
    for (let i = 0; i < DEFAULT_STALLED_SIGNAL_TICKS + 2; i += 1) {
      await gate.record(first, { value: AWAIT_OPERATOR_VALUE });
    }
    assert.equal(readStalledEvents(rootDir).length, 1);

    // A push lands. The lane resets its series on the new head; so must the
    // signal, or a second, genuinely different stall would be invisible.
    const nextHead = 'd00d000000000000000000000000000000000000';
    row = sixThousandFiftyNineRow({ reviewer_head_sha: HEAD_CURRENT });
    const second = { ...sixThousandFiftyNineHandler(), headSha: nextHead };
    for (let i = 0; i < DEFAULT_STALLED_SIGNAL_TICKS + 2; i += 1) {
      await gate.record(second, { value: AWAIT_OPERATOR_VALUE });
    }

    const events = readStalledEvents(rootDir);
    assert.equal(events.length, 2, 'a distinct stall on a new head is a distinct event');
    assert.deepEqual(events.map((e) => e.headSha), [HEAD_CURRENT, nextHead]);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('CLZ-03: terminal-PR lane cleanup removes the stalled-signal debounce markers', async () => {
  const rootDir = tempRoot();
  try {
    const gate = createNoProgressLaneGate({
      rootDir,
      readReviewRow: () => sixThousandFiftyNineRow(),
      now: () => '2026-09-02T10:00:00.000Z',
      logger: silentLogger,
    });
    const handler = sixThousandFiftyNineHandler();
    for (let i = 0; i <= DEFAULT_STALLED_SIGNAL_TICKS; i += 1) {
      await gate.record(handler, { value: AWAIT_OPERATOR_VALUE });
    }
    assert.equal(readdirSync(stalledSignalStateDir(rootDir)).length, 1);

    clearNoProgressLane(rootDir, { repo: REPO, prNumber: PR }, { logger: silentLogger });
    assert.deepEqual(readdirSync(stalledSignalStateDir(rootDir)), []);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

// ── Producer existence, per input class ──────────────────────────────────────

test('CLZ-03: a producer that exists is reported as existing and named', () => {
  const decision = evaluateStalledSignal({
    reviewRow: { review_status: 'pending', pr_state: 'open', reviewer_head_sha: null },
    headSha: HEAD_CURRENT,
    handlerValue: null,
    noProgressTicks: DEFAULT_STALLED_SIGNAL_TICKS,
  });
  assert.equal(decision.stalled, true);
  assert.equal(decision.missingInput.input, 'first-review-pass');
  assert.equal(decision.producer.exists, PRODUCER_YES);
  assert.equal(decision.producer.name, 'the queued reviewer dispatch');
});

test('CLZ-03: an unsuppressed stale head reports the auto-refresh as the producer', () => {
  const decision = evaluateStalledSignal({
    reviewRow: sixThousandFiftyNineRow(),
    headSha: HEAD_CURRENT,
    handlerValue: AWAIT_OPERATOR_VALUE,
    autoRefreshSuppression: { headMoved: true, suppressed: false, reason: null },
    noProgressTicks: DEFAULT_STALLED_SIGNAL_TICKS,
  });
  assert.equal(decision.producer.exists, PRODUCER_YES);
  assert.equal(decision.producer.name, 'the stale-posted-review auto-refresh');
});

test('CLZ-03: a final posted review at the current head with nothing dispatched has no producer', () => {
  const decision = evaluateStalledSignal({
    reviewRow: sixThousandFiftyNineRow({ reviewer_head_sha: HEAD_CURRENT }),
    headSha: HEAD_CURRENT,
    handlerValue: AWAIT_OPERATOR_VALUE,
    noProgressTicks: DEFAULT_STALLED_SIGNAL_TICKS,
  });
  assert.equal(decision.producer.exists, PRODUCER_NO);
  assert.match(decision.producer.detail, /already posted and final/);
});

test('CLZ-03: a live AMA route at the current head is a producer', () => {
  const decision = evaluateStalledSignal({
    reviewRow: sixThousandFiftyNineRow({ reviewer_head_sha: HEAD_CURRENT }),
    headSha: HEAD_CURRENT,
    handlerValue: { handled: true, outcome: 'ama-pending' },
    noProgressTicks: DEFAULT_STALLED_SIGNAL_TICKS,
  });
  assert.equal(decision.producer.exists, PRODUCER_YES);
  assert.match(decision.producer.name, /AMA hammer route/);
});

test('CLZ-03: an unobservable producer is reported unknown, never as existing', () => {
  const ci = evaluateStalledSignal({
    reviewRow: sixThousandFiftyNineRow({ reviewer_head_sha: HEAD_CURRENT }),
    headSha: HEAD_CURRENT,
    handlerValue: { amaClosureResult: { reasons: ['ci-not-green'] } },
    noProgressTicks: DEFAULT_STALLED_SIGNAL_TICKS,
  });
  assert.equal(ci.missingInput.input, 'green-ci');
  assert.equal(ci.producer.exists, PRODUCER_UNKNOWN);
  assert.notEqual(ci.producer.exists, PRODUCER_YES);
  assert.match(formatStalledSignalLine({
    ...ci,
    repo: REPO,
    prNumber: PR,
    stalledForHuman: null,
  }), /Producer unknown/);
});

test('CLZ-03: an operator-only input reports no automated producer', () => {
  const decision = evaluateStalledSignal({
    reviewRow: sixThousandFiftyNineRow({ reviewer_head_sha: HEAD_CURRENT }),
    headSha: HEAD_CURRENT,
    handlerValue: { amaClosureResult: { reasons: ['label-adversarial-merge-blocked'] } },
    noProgressTicks: DEFAULT_STALLED_SIGNAL_TICKS,
  });
  assert.equal(decision.missingInput.input, 'hard-stop-label-removal');
  assert.match(decision.missingInput.description, /adversarial-merge-blocked/);
  assert.equal(decision.producer.exists, PRODUCER_NO);
});

// ── Missing-input derivation ─────────────────────────────────────────────────

test('CLZ-03: the pipeline gate is named ahead of the structural gates standing with it', () => {
  const derived = deriveMissingInput({
    reviewRow: sixThousandFiftyNineRow(),
    headSha: HEAD_CURRENT,
    handlerValue: {
      amaClosureResult: {
        reasons: ['risk-class-not-permitted', 'verdict-not-settled-success', 'ci-not-green'],
      },
    },
  });
  assert.equal(derived.amaReason, 'verdict-not-settled-success');
  assert.deepEqual(derived.standingReasons, [
    'risk-class-not-permitted',
    'verdict-not-settled-success',
    'ci-not-green',
  ], 'the other standing reasons are still carried, not dropped');
});

test('CLZ-03: an AMA reason this table has not learned is still named verbatim', () => {
  const derived = deriveMissingInput({
    reviewRow: sixThousandFiftyNineRow(),
    headSha: HEAD_CURRENT,
    handlerValue: { amaClosureResult: { reasons: ['some-future-gate'] } },
  });
  assert.equal(derived.input, 'some-future-gate');
  assert.match(derived.description, /'some-future-gate'/);
  assert.equal(derived.source, 'ama-eligibility-unmapped');
});

test('CLZ-03: K is the lane cap by default and is overridable', () => {
  assert.equal(resolveStalledSignalTicks({}), DEFAULT_STALLED_SIGNAL_TICKS);
  assert.equal(resolveStalledSignalTicks({ ADVERSARIAL_WATCHER_STALLED_SIGNAL_TICKS: '8' }), 8);
  assert.equal(
    resolveStalledSignalTicks({ ADVERSARIAL_WATCHER_STALLED_SIGNAL_TICKS: 'nonsense' }),
    DEFAULT_STALLED_SIGNAL_TICKS,
    'a nonsense override falls back rather than disabling the signal',
  );
});

test('CLZ-03: a subject with no head to key on cannot stall', () => {
  const decision = evaluateStalledSignal({
    reviewRow: sixThousandFiftyNineRow(),
    headSha: null,
    noProgressTicks: 99,
  });
  assert.equal(decision.stalled, false);
  assert.equal(decision.skipReason, 'no-head');
});

// ── Non-vacuity ──────────────────────────────────────────────────────────────
//
// Required by the ticket: with the emit removed, "exactly one stalled event"
// must FAIL. `emitStalledSignalImpl` is the seam the production gate binds to
// `maybeEmitStalledSignal`; binding it to a no-op is precisely "the emit
// removed", with every other line of the stall path — the lane counters, the
// terminal guard, the fingerprint comparison — still running.

test('CLZ-03 non-vacuity: with the emit removed, the exactly-one-stalled-event assertion fails', async () => {
  const rootDir = tempRoot();
  try {
    const gate = createNoProgressLaneGate({
      rootDir,
      readReviewRow: () => sixThousandFiftyNineRow(),
      now: () => '2026-09-02T10:00:00.000Z',
      emitStalledSignalImpl: () => null, // the emit, removed
      logger: silentLogger,
    });
    const handler = sixThousandFiftyNineHandler();
    for (let i = 0; i < DEFAULT_STALLED_SIGNAL_TICKS * 4; i += 1) {
      await gate.record(handler, { value: AWAIT_OPERATOR_VALUE });
    }

    // The lane still ran and still counted — the stall is real either way.
    const laneLedger = JSON.parse(readFileSync(
      join(rootDir, 'data', 'watcher-no-progress-lane', `${REPO.replace('/', '__')}-pr-${PR}.json`),
      'utf8',
    ));
    assert.ok(
      laneLedger.noProgressTicks >= DEFAULT_STALLED_SIGNAL_TICKS,
      'the no-progress series is unchanged by removing the emit',
    );

    // …and the load-bearing assertion from the first test now fails.
    assert.throws(
      () => assert.equal(readStalledEvents(rootDir).length, 1, 'exactly one stalled event per stall'),
      /exactly one stalled event per stall/,
      'the exactly-one assertion must be sensitive to the emit',
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
