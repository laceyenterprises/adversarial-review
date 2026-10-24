import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiReviewerProcessDeadline, createReviewerProcessDeadline } from '../src/reviewer-process-deadline.mjs';
import { classifyReviewerFailure } from '../src/adapters/reviewer-runtime/cli-direct/classification.mjs';
import { REVIEWER_CHUNK_BUDGET_EXCEEDED_EXIT_CODE } from '../src/reviewer-outcomes.mjs';
import { dispatchReviewerModel } from '../src/reviewer-harness.mjs';
import { MAX_TIMER_DELAY_MS } from '../src/load-aware-timeout.mjs';
import { resolveAgyChunkTimeoutPlan, resolveGeminiReviewerProcessTimeoutMs } from '../src/reviewer-timeout.mjs';
import { underMaxLoad } from './helpers/load-time-kit.mjs';

function fakeClock() {
  let nowMs = 1_000_000;
  const timers = new Set();
  return {
    now: () => nowMs,
    setTimeoutImpl(fn, ms) {
      const timer = { fn, at: nowMs + ms, unref() {} };
      timers.add(timer);
      return timer;
    },
    clearTimeoutImpl(timer) { timers.delete(timer); },
    advance(ms) {
      nowMs += ms;
      for (const timer of [...timers].sort((a, b) => a.at - b.at)) {
        if (timer.at <= nowMs && timers.has(timer)) {
          timers.delete(timer);
          timer.fn();
        }
      }
    },
    pending: () => timers.size,
  };
}

const quietLog = { error() {} };

test('LAC-2100: saturated actual plan preserves process-start anchoring and parent budget', t => {
  underMaxLoad(t);
  const clock = fakeClock();
  const reports = [];
  const wiring = createGeminiReviewerProcessDeadline({ env: {}, ...clock, log: quietLog,
    reportPlan: plan => reports.push(plan), exitImpl: () => assert.fail('dispose before grace') });
  const startedAt = clock.now();
  const armed = wiring.arm();
  clock.advance(60_000);
  const plan = resolveAgyChunkTimeoutPlan({ chunkCount: 6, env: {} });
  wiring.extendForPlan(plan);
  const processMs = resolveGeminiReviewerProcessTimeoutMs({}, { plan });
  assert.deepEqual(reports, [plan]);
  assert.equal(processMs, plan.capMs);
  assert.equal(armed.deadlineAt, startedAt + processMs);
  clock.advance(processMs - 60_000 - 1);
  assert.equal(wiring.signal.aborted, false);
  clock.advance(1);
  assert.equal(wiring.signal.aborted, true);
  wiring.dispose();
});

test('WATCHERTIMER-01: process deadline clamps initial and extended chunk budgets after slack', () => {
  const clock = fakeClock();
  const scheduled = [];
  const deadline = createGeminiReviewerProcessDeadline({
    env: { ADVERSARIAL_REVIEW_AGY_CHUNK_TIMEOUT_CAP_MS: String(MAX_TIMER_DELAY_MS) },
    initialMs: MAX_TIMER_DELAY_MS + 300_000,
    ...clock,
    setTimeoutImpl(fn, ms) {
      scheduled.push(ms);
      return clock.setTimeoutImpl(fn, ms);
    },
    log: quietLog,
  });
  const armed = deadline.arm();
  assert.equal(armed.deadlineAt, clock.now() + MAX_TIMER_DELAY_MS);
  clock.advance(1000);
  deadline.extendForPlan({ chunkCount: 1, perChunkTimeoutMs: MAX_TIMER_DELAY_MS, timeoutMs: MAX_TIMER_DELAY_MS });
  assert.equal(armed.deadlineAt, clock.now() - 1000 + MAX_TIMER_DELAY_MS);
  assert.deepEqual(scheduled, [MAX_TIMER_DELAY_MS]);
  armed.dispose();
});

test('CHUNKTIME-01 follow-up: the process deadline aborts as a reviewer-timeout and exits after the grace', () => {
  const clock = fakeClock();
  const exits = [];
  const deadline = createReviewerProcessDeadline({
    initialMs: 25 * 60_000, graceMs: 30_000, ...clock, exitImpl: (code) => exits.push(code), log: quietLog,
  });
  clock.advance(25 * 60_000 - 1);
  assert.equal(deadline.signal.aborted, false);
  clock.advance(1);
  assert.equal(deadline.signal.aborted, true);
  assert.equal(deadline.signal.reason.timedOut, true);
  // The watcher classifies the reviewer's stderr; the abort text must land in reviewer-timeout.
  assert.equal(classifyReviewerFailure(`[reviewer] AI review failed: ${deadline.signal.reason.message}`, 1), 'reviewer-timeout');
  assert.deepEqual(exits, []);
  clock.advance(30_000);
  assert.deepEqual(exits, [1]);
});

test('CHUNKTIME-01 follow-up: a chunk plan only ever extends the process deadline', () => {
  const clock = fakeClock();
  const deadline = createReviewerProcessDeadline({ initialMs: 25 * 60_000, ...clock, exitImpl: () => {}, log: quietLog });
  const initialDeadline = deadline.deadlineAt;
  assert.equal(deadline.extendTo(60_000), false, 'a shorter budget must not shorten the deadline');
  assert.equal(deadline.deadlineAt, initialDeadline);
  clock.advance(10 * 60_000);
  assert.equal(deadline.extendTo(4 * 60 * 60_000), true);
  clock.advance(25 * 60_000);
  assert.equal(deadline.signal.aborted, false, 'the extended deadline replaces the initial one');
  clock.advance(4 * 60 * 60_000);
  assert.equal(deadline.signal.aborted, true);
});

test('CHUNKTIME-01 follow-up: a posted review disposes its deadline and is never failed by it', () => {
  const clock = fakeClock();
  const exits = [];
  const deadline = createReviewerProcessDeadline({ initialMs: 1_000, ...clock, exitImpl: (code) => exits.push(code), log: quietLog });
  deadline.dispose();
  clock.advance(10 * 60_000);
  assert.equal(deadline.signal.aborted, false);
  assert.deepEqual(exits, []);
  assert.equal(clock.pending(), 0);
});

test('CHUNKTIME-01 follow-up: exit 77 is the chunk-budget class only with the reviewer marker', () => {
  assert.equal(
    classifyReviewerFailure('[reviewer-chunk-budget-exceeded] chunks=18 requiredMs=1 capMs=1', REVIEWER_CHUNK_BUDGET_EXCEEDED_EXIT_CODE),
    'reviewer-chunk-budget-exceeded',
  );
  assert.notEqual(
    classifyReviewerFailure('permission denied by an unrelated command', REVIEWER_CHUNK_BUDGET_EXCEEDED_EXIT_CODE),
    'reviewer-chunk-budget-exceeded',
  );
});

test('CHUNKTIME-01 follow-up: dispatchReviewerModel forwards the process deadline signal to Gemini', async () => {
  const controller = new AbortController();
  let seen;
  await dispatchReviewerModel('gemini', 'diff', '', {
    signal: controller.signal,
    reviewWithGeminiImpl: async (_diff, _context, options) => {
      seen = options.signal;
      return { reviewText: '## Summary\nok\n## Verdict\nComment only' };
    },
  });
  assert.equal(seen, controller.signal);
});

test('CHUNKTIME-01 follow-up: the reviewer wiring arms once and extends to the chunk plan', () => {
  const clock = fakeClock();
  const wiring = createGeminiReviewerProcessDeadline({ initialMs: 25 * 60_000, ...clock, exitImpl: () => {}, log: quietLog });
  assert.equal(wiring.signal, undefined, 'nothing is armed for non-Gemini reviews');
  const first = wiring.arm();
  assert.equal(wiring.arm(), first, 'arming twice keeps one deadline');
  wiring.extendForPlan({ chunkCount: 9, perChunkTimeoutMs: 20 * 60_000, timeoutMs: 3 * 60 * 60_000 });
  clock.advance(60 * 60_000);
  assert.equal(wiring.signal.aborted, false, 'the chunk plan extends the 25-minute budget');
  wiring.dispose();
  clock.advance(10 * 60 * 60_000);
  assert.equal(wiring.signal.aborted, false);
});


test('GEMTIMEOUT-01: plan extension reports the same bounded budget to the parent', () => {
  const clock = fakeClock();
  const plans = [];
  const wiring = createGeminiReviewerProcessDeadline({ ...clock, log: quietLog, reportPlan: plan => plans.push(plan) });
  const armed = wiring.arm();
  const startedAt = clock.now();
  clock.advance(60_000);
  const plan = { chunkCount: 12, perChunkTimeoutMs: 20 * 60_000, timeoutMs: 4 * 60 * 60_000 };
  wiring.extendForPlan(plan);
  assert.deepEqual(plans, [plan]);
  assert.equal(armed.deadlineAt, startedAt + plan.timeoutMs + 300_000);
  wiring.extendForPlan({ chunkCount: 18, perChunkTimeoutMs: 20 * 60_000, timeoutMs: 6 * 60 * 60_000 });
  assert.equal(armed.deadlineAt, startedAt + 6 * 60 * 60_000);
  wiring.dispose();
});
