// Poll-loop fairness — keep new-PR discovery alive when the loop is carrying a
// backlog of PRs it cannot advance.
//
// WPS-01. The starvation this fixes had a specific shape, worth stating exactly
// because the fix is shaped to match it:
//
//   pollOnce used to run three phases per tick, in this order:
//     1. discover subjects + per-subject routing/claim (creates the reviewed_prs
//        row for a brand-new PR and queues its reviewer)
//     2. drain the reviewer dispatch queue (spawns reviewers)
//     3. run the queued posted-review handlers (AMA closer, auto-hammer, merge
//        routing) then the maintenance sweep
//
//   Phase 3 was unbounded — every queued handler ran to completion, however long
//   that took, however many of them there were, and however certainly they had
//   already decided "nothing can move here". A tick that never finishes phase 3
//   never returns to phase 1, so DISCOVERY never runs again. That is why
//   agent-os#5915 had no `reviews.db` row and no watcher log line at all: not
//   stuck in review, never seen. The poll deadline could not catch it either —
//   `computeWorkloadAwarePollDeadlineMs` budgets 50 PRs × 15m for a single repo,
//   i.e. ~12.5 hours, which is a safety bound, not a schedule.
//
// The current scheduler keeps phase 1 first, then runs phase 3 before launching
// the next reviewer wave. Closure work must not sit behind a slow reviewer spawn.
//
// Two mechanisms here, addressing the two halves:
//
//   `orderSubjectEntriesDiscoveryFirst` — phase 1 fairness. Subjects with no
//   review row yet are walked before subjects that already have one. Note the
//   existing pool-disabled sort (`compareReviewerDispatchCandidates`) is
//   oldest-created-first, which orders a NEW PR dead last, behind precisely the
//   long-lived backlog most likely to be unadvanceable. First-look latency is
//   the one thing that cannot be recovered later, so it goes first.
//
//   Scope note: this reorders the WALK — row creation, routing, claim, queueing —
//   not the dispatch. In the pooled path `runBoundedReviewerDispatchQueue`
//   re-sorts its own queue oldest-created-first, and that FIFO-by-PR-age policy
//   is left exactly as it was. Changing who reviews first is a separate policy
//   decision; this only guarantees that a new PR is SEEN.
//
//   `runPostedReviewHandlersFairly` — phase 3 boundedness. A per-tick wall-clock
//   budget plus a per-handler deadline, with budget-deferred handlers promoted
//   to the front of the next tick so the budget rotates instead of always
//   cutting off the same tail. A single timed-out handler is abandoned and
//   recorded, but the phase keeps walking other PRs until the total phase budget
//   is spent. Combined with the no-progress lane (see
//   `watcher-no-progress-lane.mjs`), the PRs that cannot move stop consuming the
//   budget at all, and the tick reliably returns to discovery.
//
// Nothing here changes what any handler DECIDES. The auto-hammer eligibility
// decision, the blocking-findings hard stop, and `closer-commit-identity`
// auto-refresh suppression are untouched — this module only bounds when and how
// often they are asked, which is the one degree of freedom the incident left.

// Per-tick wall-clock budget for the posted-review phase. Two poll intervals at
// the production 5m cadence: generous enough that a busy-but-productive tick is
// never cut short, tight enough that discovery cadence degrades to ~10m in the
// worst case instead of the 40m+ the unbounded loop actually produced. Not
// derived from `pollIntervalMs` because this module sits below config — override
// with ADVERSARIAL_WATCHER_POSTED_REVIEW_PHASE_BUDGET_MS if you retune the poll.
export const DEFAULT_POSTED_REVIEW_PHASE_BUDGET_MS = 10 * 60 * 1000;
export const DEFAULT_POSTED_REVIEW_BOUNDED_EXPENSIVE_STEP_COUNT = 2;
export const DEFAULT_POSTED_REVIEW_HANDLER_HEADROOM_MS = 5 * 1000;

// Per-handler deadline. The phase budget alone cannot save a tick, because it is
// only checked BETWEEN handlers: one handler that never settles (an `hq` dispatch
// that hangs, a GitHub call with no timeout) wedges the tick forever regardless
// of how much budget is left. This bounds the individual handler too. Keep this
// short enough that one pathological PR cannot hold lifecycle reconciliation and
// hammer maintenance for an entire poll interval.
//
// Same trade-off `safePollOnce` already documents and accepts: the abandoned
// promise is still alive and may still complete its side effects later. That is
// tolerable here because every side effect downstream of a posted-review handler
// is already guarded by a lease or a CAS, and the alternative — a tick that never
// returns to discovery — is exactly the outage being fixed.
//
// A timed-out handler is also a phase-level stop. Continuing through a backlog of
// slow hammer/merge handlers just serializes one abandoned 60s dispatch after
// another, which recreates poll starvation while the first abandoned promise is
// still alive. Defer the tail to the next tick instead; the fairness state
// promotes it, and the no-progress lane slows repeatedly unproductive PRs.
export const DEFAULT_POSTED_REVIEW_HANDLER_TIMEOUT_MS = 60 * 1000;

function parsePositiveMs(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

export function resolvePostedReviewPhaseBudgetMs(env = process.env) {
  return parsePositiveMs(
    env?.ADVERSARIAL_WATCHER_POSTED_REVIEW_PHASE_BUDGET_MS,
    DEFAULT_POSTED_REVIEW_PHASE_BUDGET_MS,
  );
}

export function resolvePostedReviewHandlerTimeoutMs(env = process.env) {
  return parsePositiveMs(
    env?.ADVERSARIAL_WATCHER_POSTED_REVIEW_HANDLER_TIMEOUT_MS,
    DEFAULT_POSTED_REVIEW_HANDLER_TIMEOUT_MS,
  );
}

export function resolvePostedReviewHandlerHeadroomMs(env = process.env) {
  return parsePositiveMs(
    env?.ADVERSARIAL_WATCHER_POSTED_REVIEW_HANDLER_HEADROOM_MS,
    DEFAULT_POSTED_REVIEW_HANDLER_HEADROOM_MS,
  );
}

export function derivePostedReviewExpensiveStepBudgetMs(
  handlerTimeoutMs,
  {
    headroomMs = DEFAULT_POSTED_REVIEW_HANDLER_HEADROOM_MS,
    stepCount = DEFAULT_POSTED_REVIEW_BOUNDED_EXPENSIVE_STEP_COUNT,
  } = {},
) {
  const effectiveHandlerTimeoutMs = parsePositiveMs(
    handlerTimeoutMs,
    DEFAULT_POSTED_REVIEW_HANDLER_TIMEOUT_MS,
  );
  const effectiveStepCount = Number.isInteger(stepCount) && stepCount > 0
    ? stepCount
    : DEFAULT_POSTED_REVIEW_BOUNDED_EXPENSIVE_STEP_COUNT;
  const effectiveHeadroomMs = Math.min(
    parsePositiveMs(headroomMs, DEFAULT_POSTED_REVIEW_HANDLER_HEADROOM_MS),
    effectiveHandlerTimeoutMs - 1,
  );
  const availableForStepsMs = Math.max(1, effectiveHandlerTimeoutMs - effectiveHeadroomMs);
  return Math.max(1, Math.floor(availableForStepsMs / effectiveStepCount));
}

/**
 * Stable partition: subjects with no review row first, everything else after, each
 * group keeping its incoming relative order.
 *
 * `hasReviewRow` is injected rather than reading SQLite here so this stays a pure,
 * cheaply-testable ordering decision.
 */
export function orderSubjectEntriesDiscoveryFirst(entries, {
  hasReviewRow,
  repoPath = null,
  logger = console,
} = {}) {
  if (!Array.isArray(entries) || entries.length === 0) return entries ?? [];
  if (typeof hasReviewRow !== 'function') return entries;
  const undiscovered = [];
  const known = [];
  for (const entry of entries) {
    let seen = true;
    try {
      seen = Boolean(hasReviewRow(entry));
    } catch (err) {
      // Fail toward "already known": a lookup fault must not let a bad probe
      // reshuffle the whole tick.
      logger?.warn?.(
        `[watcher] discovery-first ordering: review-row lookup failed for PR ` +
          `${entry?.prNumber ?? 'unknown'} (${err?.message || err}); treating as already discovered`,
      );
      seen = true;
    }
    (seen ? known : undiscovered).push(entry);
  }
  if (undiscovered.length === 0 || known.length === 0) return entries;
  logger?.log?.(
    `[watcher] discovery-first ordering${repoPath ? ` for ${repoPath}` : ''}: ` +
      `${undiscovered.length} never-reviewed PR(s) (${undiscovered
        .map((entry) => `#${entry?.prNumber}`)
        .join(',')}) promoted ahead of ${known.length} already-tracked PR(s)`,
  );
  return [...undiscovered, ...known];
}

export function postedReviewHandlerKey(handler) {
  return `${handler?.repoPath ?? ''}#${handler?.prNumber ?? ''}`;
}

/**
 * Cross-tick fairness state. Lives for the process lifetime in the watcher, so a
 * handler cut off by the budget is promoted to the front of the next tick rather
 * than being cut off again in the same position.
 */
export function createPostedReviewFairnessState() {
  return { deferredKeys: new Set() };
}

function orderDeferredFirst(handlers, state) {
  const deferred = state?.deferredKeys;
  if (!deferred || deferred.size === 0) return handlers;
  const handlersByKey = new Map();
  for (const handler of handlers) {
    const key = postedReviewHandlerKey(handler);
    const bucket = handlersByKey.get(key);
    if (bucket) {
      bucket.push(handler);
    } else {
      handlersByKey.set(key, [handler]);
    }
  }
  const promoted = [];
  const promotedKeys = new Set();
  for (const key of deferred) {
    const bucket = handlersByKey.get(key);
    if (!bucket) continue;
    promoted.push(...bucket);
    promotedKeys.add(key);
  }
  if (promoted.length === 0) return handlers;
  const rest = [];
  for (const handler of handlers) {
    if (!promotedKeys.has(postedReviewHandlerKey(handler))) rest.push(handler);
  }
  return [...promoted, ...rest];
}

function runWithDeadline(run, {
  timeoutMs,
  setTimeoutFn,
  clearTimeoutFn,
}) {
  let timer = null;
  const deadline = new Promise((resolve) => {
    timer = setTimeoutFn(() => resolve({ timedOut: true }), timeoutMs);
  });
  const work = Promise.resolve()
    .then(() => run())
    .then((value) => ({ timedOut: false, value }), (error) => ({ timedOut: false, error }));
  return Promise.race([work, deadline]).finally(() => {
    if (timer !== null) clearTimeoutFn(timer);
  });
}

/**
 * Run the tick's queued posted-review handlers under a wall-clock budget, a
 * per-handler deadline, and (optionally) the no-progress lane gate.
 *
 * `laneGate` is `{ evaluate(handler) -> { run, ... }, record(handler, outcome) }`;
 * it is injected so this scheduler stays free of SQLite and the filesystem.
 *
 * Never throws: a handler fault, a lane fault, or an exhausted budget all resolve
 * into the returned summary so the tick always reaches its next phase.
 */
export async function runPostedReviewHandlersFairly({
  handlers = [],
  state = createPostedReviewFairnessState(),
  budgetMs = DEFAULT_POSTED_REVIEW_PHASE_BUDGET_MS,
  handlerTimeoutMs = DEFAULT_POSTED_REVIEW_HANDLER_TIMEOUT_MS,
  minimumHandlerStartBudgetMs = null,
  laneGate = null,
  nowMs = () => Date.now(),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  logger = console,
} = {}) {
  const summary = {
    queued: handlers.length,
    ran: 0,
    failed: 0,
    timedOut: 0,
    skippedByLane: 0,
    deferredByBudget: 0,
    deferredAfterTimeout: 0,
    continuedAfterTimeout: 0,
    deferred: [],
  };
  if (handlers.length === 0) {
    // Nothing queued means nothing outstanding: clear the promotion set so a
    // long-gone PR is not still carrying priority when handlers reappear.
    state.deferredKeys = new Set();
    return summary;
  }

  // A zero/NaN budget would silently defer EVERY handler, disabling the whole
  // posted-review phase — a worse outage than the one this bounds. Fall back to
  // the shipped defaults rather than honouring a nonsense value.
  const effectiveBudgetMs = parsePositiveMs(budgetMs, DEFAULT_POSTED_REVIEW_PHASE_BUDGET_MS);
  const effectiveHandlerTimeoutMs = parsePositiveMs(
    handlerTimeoutMs,
    DEFAULT_POSTED_REVIEW_HANDLER_TIMEOUT_MS,
  );
  const effectiveMinimumHandlerStartBudgetMs = parsePositiveMs(
    minimumHandlerStartBudgetMs,
    derivePostedReviewExpensiveStepBudgetMs(effectiveHandlerTimeoutMs),
  );
  const startedMs = nowMs();
  const ordered = orderDeferredFirst(handlers, state);
  const nextDeferred = new Set();

  for (let index = 0; index < ordered.length; index += 1) {
    const handler = ordered[index];
    const key = postedReviewHandlerKey(handler);
    const phaseElapsedMs = nowMs() - startedMs;
    const remainingBudgetMs = effectiveBudgetMs - phaseElapsedMs;

    if (
      phaseElapsedMs >= effectiveBudgetMs ||
      remainingBudgetMs < effectiveMinimumHandlerStartBudgetMs
    ) {
      // Budget exhausted. Everything left is deferred — NOT dropped: each key is
      // promoted to the front of the next tick, so the cut point rotates and the
      // same tail cannot be starved tick after tick.
      for (let rest = index; rest < ordered.length; rest += 1) {
        nextDeferred.add(postedReviewHandlerKey(ordered[rest]));
      }
      summary.deferredByBudget = ordered.length - index;
      logger?.warn?.(
        `[watcher] posted-review phase budget insufficient after ` +
          `${Math.round(nowMs() - startedMs)}ms (budget=${effectiveBudgetMs}ms): ` +
          `remaining=${Math.max(0, Math.round(remainingBudgetMs))}ms ` +
          `minimum_start_budget=${effectiveMinimumHandlerStartBudgetMs}ms; ` +
          `${summary.deferredByBudget} handler(s) deferred to the front of the next tick ` +
          `(${[...nextDeferred].join(' ')})`,
      );
      break;
    }

    let laneDecision = { run: true };
    if (laneGate && typeof laneGate.evaluate === 'function') {
      try {
        laneDecision = laneGate.evaluate(handler) ?? { run: true };
      } catch (err) {
        // Fail open: a lane fault must never suppress a PR's handler.
        logger?.warn?.(
          `[watcher] no-progress lane evaluate failed for ${key} ` +
            `(${err?.message || err}); running the handler`,
        );
        laneDecision = { run: true };
      }
    }
    if (!laneDecision.run) {
      summary.skippedByLane += 1;
      logger?.log?.(
        `[watcher] no-progress lane: deferring ${key} this tick ` +
          `(lane=${laneDecision.lane || 'slow'} ` +
          `no_progress_ticks=${laneDecision.noProgressTicks ?? 0} ` +
          `backoff_ticks=${laneDecision.backoffTicks ?? 0} ` +
          `skipped_ticks=${laneDecision.skippedTicks ?? 0}) — still tracked, ` +
          `re-walked in ${Math.max(0, (laneDecision.backoffTicks ?? 0) - (laneDecision.skippedTicks ?? 0))} tick(s)`,
      );
      continue;
    }

    const handlerStartedMs = nowMs();
    const handlerDeadlineMs = parsePositiveMs(handler?.timeoutMs, effectiveHandlerTimeoutMs);
    const outcome = await runWithDeadline(() => handler.run(), {
      timeoutMs: handlerDeadlineMs,
      setTimeoutFn,
      clearTimeoutFn,
    });
    const handlerElapsedMs = Math.round(nowMs() - handlerStartedMs);
    if (outcome.timedOut) {
      summary.timedOut += 1;
      // RVHAND-01: the abandon log used to report only the budget, so a timeout
      // said nothing about WHERE the time went. An operator could not tell
      // "this one PR is pathologically slow" from "the phase was already
      // saturated when this handler started". Those are different defects and
      // they want opposite fixes, so raising the timeout without knowing which
      // one you have just moves the threshold.
      //
      // Every value below is already available in this loop and was simply
      // being discarded. `position` separates an early handler (slow in
      // isolation) from a late one (starved by its predecessors);
      // `phase_elapsed_at_start` against the phase budget shows how much room
      // was left when it began, while `phase_elapsed_total` captures where the
      // phase stood after the handler timed out.
      const phaseElapsedAtStartMs = Math.round(handlerStartedMs - startedMs);
      const phaseElapsedTotalMs = Math.round(nowMs() - startedMs);
      logger?.error?.(
        `[watcher] posted-review handler for ${key} exceeded ${handlerDeadlineMs}ms; ` +
          'abandoning it so the tick can return to new-PR discovery ' +
          `(elapsed=${handlerElapsedMs}ms position=${index + 1}/${ordered.length} ` +
          `phase_elapsed_at_start=${phaseElapsedAtStartMs}ms ` +
          `phase_elapsed_total=${phaseElapsedTotalMs}ms phase_budget=${effectiveBudgetMs}ms ` +
          `ran_before=${summary.ran} timed_out_before=${summary.timedOut - 1})`,
      );
    } else if (outcome.error) {
      summary.failed += 1;
      logger?.error?.(
        `[watcher] posted-review handler failed for ${key}:`,
        outcome.error?.message || outcome.error,
      );
    } else {
      summary.ran += 1;
    }

    if (laneGate && typeof laneGate.record === 'function') {
      try {
        await laneGate.record(handler, {
          timedOut: outcome.timedOut,
          error: outcome.error || null,
          value: outcome.value,
        });
      } catch (err) {
        logger?.warn?.(
          `[watcher] no-progress lane record failed for ${key} (${err?.message || err})`,
        );
      }
    }

    if (outcome.timedOut) {
      const remainingAfterTimeout = ordered.length - index - 1;
      if (remainingAfterTimeout > 0) {
        for (let rest = index + 1; rest < ordered.length; rest += 1) {
          nextDeferred.add(postedReviewHandlerKey(ordered[rest]));
        }
        summary.deferredAfterTimeout = remainingAfterTimeout;
        logger?.warn?.(
          `[watcher] posted-review phase yielding after timeout for ${key} ` +
            `elapsed_ms=${handlerElapsedMs}: ${remainingAfterTimeout} handler(s) deferred ` +
            `to the front of the next tick (${[...nextDeferred].join(' ')})`,
        );
      }
      break;
    }
  }

  state.deferredKeys = nextDeferred;
  summary.deferred = [...nextDeferred];
  if (summary.queued > 0 && summary.ran === 0) {
    logger?.warn?.(
      `[watcher] posted-review phase made zero progress: queued=${summary.queued} ` +
        `ran=0 failed=${summary.failed} timed_out=${summary.timedOut} ` +
        `slow_lane_deferred=${summary.skippedByLane} budget_deferred=${summary.deferredByBudget} ` +
        `timeout_deferred=${summary.deferredAfterTimeout}`,
    );
  }
  if (
    summary.skippedByLane > 0
    || summary.deferredByBudget > 0
    || summary.deferredAfterTimeout > 0
    || summary.timedOut > 0
  ) {
    // One operator-facing line per tick that summarises everything NOT walked at
    // full speed. A PR in the slow lane is visible here even when nobody is
    // reading the per-PR lines above.
    logger?.log?.(
      `[watcher] posted-review phase: queued=${summary.queued} ran=${summary.ran} ` +
        `failed=${summary.failed} timed_out=${summary.timedOut} ` +
        `slow_lane_deferred=${summary.skippedByLane} budget_deferred=${summary.deferredByBudget} ` +
        `timeout_deferred=${summary.deferredAfterTimeout} ` +
        `continued_after_timeout=${summary.continuedAfterTimeout}`,
    );
  }
  return summary;
}
