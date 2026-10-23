// Gemini process deadlines share the claim/parent budget and extend only when
// the harness builds its actual chunk plan. No cap-sized default lease.
import { resolveGeminiReviewerProcessTimeoutMs } from './reviewer-timeout.mjs';
import { timerDelayMs } from './load-aware-timeout.mjs';

const REVIEWER_PROCESS_DEADLINE_EXIT_GRACE_MS = 30_000;

function createReviewerProcessDeadline({
  initialMs,
  graceMs = REVIEWER_PROCESS_DEADLINE_EXIT_GRACE_MS,
  now = Date.now,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  exitImpl = (code) => process.exit(code),
  log = console,
} = {}) {
  if (!Number.isFinite(initialMs) || initialMs <= 0) {
    throw new TypeError('initialMs must be a positive number');
  }
  const controller = new AbortController();
  const startedAt = now();
  let deadlineAt = startedAt + timerDelayMs(initialMs);
  let timer = null;
  let graceTimer = null;
  let disposed = false;

  function clearTimers() {
    if (timer) clearTimeoutImpl(timer);
    if (graceTimer) clearTimeoutImpl(graceTimer);
    timer = null;
    graceTimer = null;
  }

  function expire() {
    timer = null;
    if (disposed || controller.signal.aborted) return;
    const budgetMs = Math.max(0, Math.round(deadlineAt - startedAt));
    const error = Object.assign(
      new Error(`Command timed out after ${budgetMs}ms (reviewer process deadline)`),
      { timedOut: true, reviewerProcessDeadline: true },
    );
    log.error?.(`[reviewer] process deadline reached: ${error.message}`);
    controller.abort(error);
    graceTimer = setTimeoutImpl(() => {
      graceTimer = null;
      if (disposed) return;
      log.error?.(`[reviewer] AI review failed: ${error.message}; exiting after ${graceMs}ms grace`);
      exitImpl(1);
    }, graceMs);
    graceTimer?.unref?.();
  }

  function arm() {
    if (timer) clearTimeoutImpl(timer);
    timer = setTimeoutImpl(expire, timerDelayMs(deadlineAt - now()));
    timer?.unref?.();
  }

  arm();

  return {
    signal: controller.signal,
    get deadlineAt() { return deadlineAt; },
    get expired() { return controller.signal.aborted; },
    // Only ever extends: a chunk plan never shortens the budget already granted.
    extendTo(ms) {
      if (disposed || controller.signal.aborted) return false;
      if (!Number.isFinite(ms) || ms <= 0) return false;
      const candidate = startedAt + timerDelayMs(ms);
      if (candidate <= deadlineAt) return false;
      deadlineAt = candidate;
      arm();
      return true;
    },
    // Called once the review is posted: a finished review is never failed by
    // its own deadline.
    dispose() {
      disposed = true;
      clearTimers();
    },
  };
}

// reviewer.mjs wiring, kept here so the entrypoint stays inside its size budget
// (ARC-10). arm() is idempotent; extendForPlan() takes the chunk plan that
// reviewAgyOversizedInChunks reports through onChunkPlan.
function createGeminiReviewerProcessDeadline({ env = process.env, initialMs = null,
  reportPlan = plan => { if (process.connected) process.send({ type: 'gemini-chunk-plan', plan }, () => {}); },
  ...options } = {}) {
  let deadline = null;
  return {
    arm() {
      deadline ??= createReviewerProcessDeadline({
        initialMs: initialMs ?? resolveGeminiReviewerProcessTimeoutMs(env),
        ...options,
      });
      return deadline;
    },
    get signal() { return deadline?.signal; },
    extendForPlan: (plan) => {
      if (plan && Number.isFinite(plan.timeoutMs)) {
        reportPlan(plan);
        deadline?.extendTo(resolveGeminiReviewerProcessTimeoutMs(env, { plan }));
      }
    },
    dispose() { deadline?.dispose(); },
  };
}

export {
  REVIEWER_PROCESS_DEADLINE_EXIT_GRACE_MS,
  createGeminiReviewerProcessDeadline,
  createReviewerProcessDeadline,
};
