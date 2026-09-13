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
// derived from `pollIntervalMs` because this module sits below config. Keep this
// as the hard default even when the handler timeout is longer; production once
// carried a 30m override and fresh PR discovery stalled.
export const DEFAULT_POSTED_REVIEW_PHASE_BUDGET_MS = 10 * 60 * 1000;
export const DEFAULT_POSTED_REVIEW_PHASE_HANDLER_CAPACITY = 3;
export const DEFAULT_POSTED_REVIEW_REVIEWER_PRESSURE_HANDLER_CAPACITY = 2;
export const DEFAULT_POSTED_REVIEW_BOUNDED_EXPENSIVE_STEP_COUNT = 2;
export const DEFAULT_POSTED_REVIEW_HANDLER_HEADROOM_MS = 5 * 1000;

// LANESTARVE-01. Minimum-service floor for the no-progress lane.
//
// The lane is advisory; the scheduler was treating it as absolute. When every
// queued handler was lane-deferred the phase returned `ran=0` having spent none
// of its 10-minute budget — 95 such ticks in one day, against `ran=278` and
// `slow_lane_deferred=1040`. A tick that does nothing is not "bounded", it is
// idle, and the budget the lane exists to protect goes to waste.
//
// This floor admits up to N lane-deferred handlers into a tick that would
// otherwise run nothing at all. It cannot cost a faster PR anything: it fires
// ONLY when no handler ran, failed, or timed out, so the slot it consumes is a
// slot no other work wanted. Prioritisation is fully preserved — active-lane
// PRs are walked first and every tick, slow-lane PRs get the leftovers.
//
// Keep this small. It is a liveness guarantee ("a tick with queued work and
// spare budget never does nothing"), not a capacity knob; raising it would walk
// the unadvanceable backlog the lane was built to stop walking, which is the
// WPS-01 outage.
export const DEFAULT_POSTED_REVIEW_LANE_STARVATION_FLOOR = 1;

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
// slow hammer/merge handlers just serializes one abandoned 3m dispatch after
// another, which recreates poll starvation while the first abandoned promise is
// still alive. Defer the tail to the next tick instead; the fairness state
// promotes it, and the no-progress lane slows repeatedly unproductive PRs.
export const DEFAULT_POSTED_REVIEW_HANDLER_TIMEOUT_MS = 3 * 60 * 1000;
export const DEFAULT_POSTED_REVIEW_REVIEWER_PRESSURE_PHASE_BUDGET_MS =
  DEFAULT_POSTED_REVIEW_HANDLER_TIMEOUT_MS *
  DEFAULT_POSTED_REVIEW_REVIEWER_PRESSURE_HANDLER_CAPACITY;

function parsePositiveMs(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

export function resolvePostedReviewPhaseBudgetMs(env = process.env) {
  const configured = env?.ADVERSARIAL_WATCHER_POSTED_REVIEW_PHASE_BUDGET_MS;
  if (configured !== undefined && configured !== null && configured !== '') {
    return parsePositiveMs(configured, DEFAULT_POSTED_REVIEW_PHASE_BUDGET_MS);
  }
  return DEFAULT_POSTED_REVIEW_PHASE_BUDGET_MS;
}

export function resolvePostedReviewReviewerPressurePhaseBudgetMs(
  env = process.env,
  { phaseBudgetMs = resolvePostedReviewPhaseBudgetMs(env) } = {},
) {
  const handlerTimeoutMs = resolvePostedReviewHandlerTimeoutMs(env);
  const minimumPressureBudgetMs = derivePostedReviewReviewerPressureBudgetFloorMs(handlerTimeoutMs);
  const resolvedPhaseBudgetMs = parsePositiveMs(
    phaseBudgetMs,
    resolvePostedReviewPhaseBudgetMs(env),
  );
  const configured = env?.ADVERSARIAL_WATCHER_POSTED_REVIEW_REVIEWER_PRESSURE_PHASE_BUDGET_MS;
  const capAtNormalBudget = (pressureBudgetMs) => Math.min(
    resolvedPhaseBudgetMs,
    Math.max(pressureBudgetMs, minimumPressureBudgetMs),
  );
  if (configured === undefined || configured === null || configured === '') {
    return capAtNormalBudget(Math.min(
      resolvedPhaseBudgetMs,
      DEFAULT_POSTED_REVIEW_REVIEWER_PRESSURE_PHASE_BUDGET_MS,
    ));
  }
  const configuredBudgetMs = parsePositiveMs(
    configured,
    minimumPressureBudgetMs,
  );
  return capAtNormalBudget(configuredBudgetMs);
}

export function derivePostedReviewReviewerPressureBudgetFloorMs(handlerTimeoutMs) {
  const effectiveHandlerTimeoutMs = parsePositiveMs(
    handlerTimeoutMs,
    DEFAULT_POSTED_REVIEW_HANDLER_TIMEOUT_MS,
  );
  return effectiveHandlerTimeoutMs * DEFAULT_POSTED_REVIEW_REVIEWER_PRESSURE_HANDLER_CAPACITY;
}

export function enforcePostedReviewReviewerPressureBudgetFloor({
  pressureBudgetMs,
  handlerTimeoutMs,
  minimumHandlerStartBudgetMs = null,
  headroomMs = DEFAULT_POSTED_REVIEW_HANDLER_HEADROOM_MS,
  logger = console,
} = {}) {
  const effectiveHandlerTimeoutMs = resolvePostedReviewHandlerTimeoutMs({
    ADVERSARIAL_WATCHER_POSTED_REVIEW_HANDLER_TIMEOUT_MS: handlerTimeoutMs,
  });
  const handlerCapacityFloorMs =
    derivePostedReviewReviewerPressureBudgetFloorMs(effectiveHandlerTimeoutMs);
  const hasRequestedPressureBudget =
    pressureBudgetMs !== undefined && pressureBudgetMs !== null && pressureBudgetMs !== '';
  const requestedPressureBudgetMs = parsePositiveMs(
    pressureBudgetMs,
    handlerCapacityFloorMs,
  );
  if (!hasRequestedPressureBudget || requestedPressureBudgetMs >= handlerCapacityFloorMs) {
    return requestedPressureBudgetMs;
  }
  const effectiveMinimumHandlerStartBudgetMs = parsePositiveMs(
    minimumHandlerStartBudgetMs,
    derivePostedReviewExpensiveStepBudgetMs(effectiveHandlerTimeoutMs),
  );
  const effectiveHeadroomMs = parsePositiveMs(
    headroomMs,
    DEFAULT_POSTED_REVIEW_HANDLER_HEADROOM_MS,
  );
  logger?.warn?.(
    `[watcher] posted-review reviewer-pressure phase budget raised to handler-capacity floor: ` +
      `requested_budget_ms=${requestedPressureBudgetMs} ` +
      `minimum_budget_ms=${handlerCapacityFloorMs} ` +
      `minimum_start_budget_ms=${effectiveMinimumHandlerStartBudgetMs} ` +
      `headroom_ms=${effectiveHeadroomMs} ` +
      `handler_timeout_ms=${effectiveHandlerTimeoutMs} ` +
      `handler_capacity=${DEFAULT_POSTED_REVIEW_REVIEWER_PRESSURE_HANDLER_CAPACITY}`,
  );
  return handlerCapacityFloorMs;
}

function isDaemonCleanMergeMerged(value) {
  const daemonCleanMerge = value?.amaClosureResult?.daemonCleanMerge || value?.daemonCleanMerge;
  return daemonCleanMerge?.merged === true
    || daemonCleanMerge?.disposition === 'merged';
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

function pendingRereviewRequestedAt(entry) {
  const row = entry?.current;
  if (!row || row.review_status !== 'pending' || !row.rereview_requested_at) return null;
  const requestedAtMs = Date.parse(String(row.rereview_requested_at));
  return Number.isFinite(requestedAtMs) ? requestedAtMs : null;
}

/**
 * Stable partition for within-lane re-review fairness.
 *
 * Pending re-review rows are reviewer work the pipeline has already promised.
 * Walk them oldest-first so the queue drains FIFO and no job can be starved by
 * a steady stream of fast remediation churn from one PR. Everything else keeps
 * its incoming relative order, so first-pass discovery and posted-row handling
 * retain their existing policy.
 */
export function orderSubjectEntriesRereviewOldestFirst(entries, {
  repoPath = null,
  logger = console,
} = {}) {
  if (!Array.isArray(entries) || entries.length === 0) return entries ?? [];

  const rereviews = [];
  const rest = [];
  entries.forEach((entry, index) => {
    const requestedAtMs = pendingRereviewRequestedAt(entry);
    if (requestedAtMs === null) {
      rest.push({ entry, index });
      return;
    }
    rereviews.push({ entry, index, requestedAtMs });
  });

  if (rereviews.length <= 1) return entries;

  rereviews.sort((a, b) => (
    a.requestedAtMs - b.requestedAtMs
    || a.index - b.index
  ));
  logger?.log?.(
    `[watcher] re-review FIFO ordering${repoPath ? ` for ${repoPath}` : ''}: ` +
      `${rereviews.length} pending re-review PR(s) ordered oldest-first (` +
      rereviews
        .map(({ entry }) => `#${entry?.prNumber}`)
        .join(',') +
      ')',
  );
  return [
    ...rereviews.map(({ entry }) => entry),
    ...rest.map(({ entry }) => entry),
  ];
}

export function postedReviewHandlerKey(handler) {
  return `${handler?.repoPath ?? ''}#${handler?.prNumber ?? ''}`;
}

function normalizePostedReviewPriorityTargets(priorityTargets) {
  const rawTargets = Array.isArray(priorityTargets)
    ? priorityTargets
    : (priorityTargets ? [priorityTargets] : []);
  return rawTargets
    .map((target) => ({
      repoPath: String(target?.repoPath || target?.repo || '').trim(),
      prNumber: Number(target?.prNumber ?? target?.pr_number ?? target?.pr),
      headSha: String(target?.headSha || target?.head_sha || '').trim(),
      reason: String(target?.reason || '').trim(),
    }))
    .filter((target) => (
      target.repoPath
      && Number.isInteger(target.prNumber)
      && target.prNumber > 0
    ));
}

function postedReviewHandlerMatchesPriorityTarget(handler, target) {
  if (String(handler?.repoPath || '') !== target.repoPath) return false;
  if (Number(handler?.prNumber) !== target.prNumber) return false;
  if (target.headSha && String(handler?.headSha || '') !== target.headSha) return false;
  return true;
}

function postedReviewHandlerMatchesPriority(handler, priorityTargets) {
  return priorityTargets.some((target) => postedReviewHandlerMatchesPriorityTarget(handler, target));
}

function orderPriorityFirst(handlers, priorityTargets) {
  if (!priorityTargets.length) return handlers;
  const priority = [];
  const rest = [];
  for (const handler of handlers) {
    (postedReviewHandlerMatchesPriority(handler, priorityTargets) ? priority : rest).push(handler);
  }
  return priority.length > 0 ? [...priority, ...rest] : handlers;
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
  priorityTargets = [],
  laneStarvationFloor = DEFAULT_POSTED_REVIEW_LANE_STARVATION_FLOOR,
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
    daemonCleanMerges: 0,
    priorityLaneBypasses: 0,
    laneFloorAdmissions: 0,
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
  const normalizedPriorityTargets = normalizePostedReviewPriorityTargets(priorityTargets);
  const ordered = orderPriorityFirst(orderDeferredFirst(handlers, state), normalizedPriorityTargets);
  const nextDeferred = new Set();
  // LANESTARVE-01: every handler the lane turned away this tick, in queue order,
  // with the decision that turned it away. The starvation floor picks from here.
  const laneDeferred = [];

  /**
   * Run one handler under its deadline, fold the result into the summary, and
   * tell the lane what happened. Shared by the normal walk and the starvation
   * floor so a floor-admitted handler is accounted for and recorded identically.
   *
   * `laneAdmission` is passed straight through to `laneGate.record`. A run the
   * lane did not schedule is reported as non-escalating so an opportunistic look
   * cannot double the PR's backoff.
   */
  async function executeHandler({ handler, key, positionLabel, laneAdmission = null }) {
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
          'abandoning this handler; remaining phase budget will decide whether the posted-review phase continues ' +
          `(elapsed=${handlerElapsedMs}ms position=${positionLabel} ` +
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
      if (isDaemonCleanMergeMerged(outcome.value)) {
        summary.daemonCleanMerges += 1;
      }
    }

    if (laneGate && typeof laneGate.record === 'function') {
      try {
        await laneGate.record(handler, {
          timedOut: outcome.timedOut,
          error: outcome.error || null,
          value: outcome.value,
          ...(laneAdmission ? { laneAdmission } : {}),
        });
      } catch (err) {
        logger?.warn?.(
          `[watcher] no-progress lane record failed for ${key} (${err?.message || err})`,
        );
      }
    }

    return { outcome, handlerElapsedMs };
  }

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
    const priorityMatched = postedReviewHandlerMatchesPriority(handler, normalizedPriorityTargets);
    if (!laneDecision.run && priorityMatched) {
      summary.priorityLaneBypasses += 1;
      logger?.log?.(
        `[watcher] posted-review wake priority: running ${key} despite ` +
          `no-progress lane=${laneDecision.lane || 'slow'} ` +
          `no_progress_ticks=${laneDecision.noProgressTicks ?? 0} ` +
          `backoff_ticks=${laneDecision.backoffTicks ?? 0} ` +
          `skipped_ticks=${laneDecision.skippedTicks ?? 0}`,
      );
    } else if (!laneDecision.run) {
      summary.skippedByLane += 1;
      laneDeferred.push({ handler, key, index, decision: laneDecision });
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

    const { outcome, handlerElapsedMs } = await executeHandler({
      handler,
      key,
      positionLabel: `${index + 1}/${ordered.length}`,
    });

    if (outcome.timedOut) {
      const remainingAfterTimeout = ordered.length - index - 1;
      const phaseElapsedAfterTimeoutMs = Math.round(nowMs() - startedMs);
      const remainingBudgetAfterTimeoutMs = effectiveBudgetMs - phaseElapsedAfterTimeoutMs;
      if (
        remainingAfterTimeout > 0
        && remainingBudgetAfterTimeoutMs >= effectiveMinimumHandlerStartBudgetMs
      ) {
        summary.continuedAfterTimeout += 1;
        logger?.warn?.(
          `[watcher] posted-review phase continuing after timeout for ${key} ` +
            `elapsed_ms=${handlerElapsedMs}: ${remainingAfterTimeout} handler(s) still eligible ` +
            `this tick (remaining=${Math.max(0, remainingBudgetAfterTimeoutMs)}ms ` +
            `minimum_start_budget=${effectiveMinimumHandlerStartBudgetMs}ms)`,
        );
        continue;
      }
      if (remainingAfterTimeout > 0) {
        for (let rest = index + 1; rest < ordered.length; rest += 1) {
          nextDeferred.add(postedReviewHandlerKey(ordered[rest]));
        }
        summary.deferredAfterTimeout = remainingAfterTimeout;
        logger?.warn?.(
          `[watcher] posted-review phase yielding after timeout for ${key} ` +
            `elapsed_ms=${handlerElapsedMs}: ${remainingAfterTimeout} handler(s) deferred ` +
            `to the front of the next tick (remaining=${Math.max(0, remainingBudgetAfterTimeoutMs)}ms ` +
            `minimum_start_budget=${effectiveMinimumHandlerStartBudgetMs}ms; ` +
            `${[...nextDeferred].join(' ')})`,
        );
      }
      break;
    }
  }

  // ── LANESTARVE-01: minimum-service floor ───────────────────────────────────
  //
  // The tick reaches here having walked the whole queue. If it ran NOTHING — no
  // handler succeeded, failed, or timed out — while the lane turned handlers
  // away and the phase budget is still largely unspent, the tick is idle, not
  // bounded. Admit the most-starved deferred handler(s) rather than burn the
  // interval.
  //
  // Guarded on `ran===0 && failed===0 && timedOut===0`: any executed handler
  // means the slot was wanted by work the lane considered live, and the floor
  // stands down. That is what keeps the slow lane a real deprioritisation — it
  // never preempts a fast PR, it only uses a slot nothing else claimed.
  // `deferredByBudget===0` because a budget-deferred tail means there is no
  // budget to spend; the budget check below is belt-and-braces on top of that.
  const laneFloor = Number.isInteger(laneStarvationFloor) && laneStarvationFloor > 0
    ? laneStarvationFloor
    : 0;
  if (
    laneFloor > 0
    && laneDeferred.length > 0
    && summary.ran === 0
    && summary.failed === 0
    && summary.timedOut === 0
    && summary.deferredByBudget === 0
  ) {
    // Most-starved first: the PR that has waited the most ticks since its last
    // walk, then the one with the longest no-progress series, then queue order.
    // Ties fall back to the order the queue already chose, so the promotion set
    // and wake-priority ordering upstream still carry through.
    const byStarvation = [...laneDeferred].sort((a, b) => (
      (b.decision?.skippedTicks ?? 0) - (a.decision?.skippedTicks ?? 0)
      || (b.decision?.noProgressTicks ?? 0) - (a.decision?.noProgressTicks ?? 0)
      || a.index - b.index
    ));
    for (const candidate of byStarvation) {
      if (summary.laneFloorAdmissions >= laneFloor) break;
      const phaseElapsedMs = nowMs() - startedMs;
      const remainingBudgetMs = effectiveBudgetMs - phaseElapsedMs;
      if (
        phaseElapsedMs >= effectiveBudgetMs
        || remainingBudgetMs < effectiveMinimumHandlerStartBudgetMs
      ) {
        // No budget left to honour the floor. Say so rather than silently
        // skipping it — an invisible floor is indistinguishable from no floor.
        logger?.warn?.(
          `[watcher] posted-review slow-lane floor could not run ${candidate.key}: ` +
            `remaining=${Math.max(0, Math.round(remainingBudgetMs))}ms ` +
            `minimum_start_budget=${effectiveMinimumHandlerStartBudgetMs}ms ` +
            `phase_budget=${effectiveBudgetMs}ms; still deferred`,
        );
        break;
      }
      summary.laneFloorAdmissions += 1;
      summary.skippedByLane = Math.max(0, summary.skippedByLane - 1);
      logger?.warn?.(
        `[watcher] posted-review slow-lane floor: admitting ${candidate.key} into an otherwise ` +
          `idle tick (queued=${summary.queued} ran=0 lane_deferred=${laneDeferred.length} ` +
          `lane=${candidate.decision?.lane || 'slow'} ` +
          `no_progress_ticks=${candidate.decision?.noProgressTicks ?? 0} ` +
          `skipped_ticks=${candidate.decision?.skippedTicks ?? 0} ` +
          `backoff_ticks=${candidate.decision?.backoffTicks ?? 0}). This walk does not ` +
          'escalate its backoff — it was not due, the tick simply had nothing else to do.',
      );
      const { outcome } = await executeHandler({
        handler: candidate.handler,
        key: candidate.key,
        positionLabel: `floor ${summary.laneFloorAdmissions}/${laneFloor}`,
        laneAdmission: 'starvation-floor',
      });
      // A floor admission that times out has consumed the same budget a normal
      // handler would; stop here exactly as the main loop does after a timeout.
      if (outcome.timedOut) break;
    }
  }

  state.deferredKeys = nextDeferred;
  summary.deferred = [...nextDeferred];
  if (summary.queued > 0 && summary.ran === 0) {
    logger?.warn?.(
      `[watcher] posted-review phase made zero progress: queued=${summary.queued} ` +
        `ran=0 failed=${summary.failed} timed_out=${summary.timedOut} ` +
        `slow_lane_deferred=${summary.skippedByLane} budget_deferred=${summary.deferredByBudget} ` +
        `timeout_deferred=${summary.deferredAfterTimeout} ` +
        `slow_lane_floor_admissions=${summary.laneFloorAdmissions}`,
    );
  }
  if (
    summary.queued > 1
    && summary.ran <= 1
    && summary.deferredByBudget >= summary.queued - 1
  ) {
    logger?.warn?.(
      `[watcher] posted-review phase stall signature: queued=${summary.queued} ` +
        `ran=${summary.ran} failed=${summary.failed} timed_out=${summary.timedOut} ` +
        `slow_lane_deferred=${summary.skippedByLane} budget_deferred=${summary.deferredByBudget} ` +
        `timeout_deferred=${summary.deferredAfterTimeout}`,
    );
  }
  if (
    summary.skippedByLane > 0
    || summary.deferredByBudget > 0
    || summary.deferredAfterTimeout > 0
    || summary.timedOut > 0
    || summary.laneFloorAdmissions > 0
  ) {
    // One operator-facing line per tick that summarises everything NOT walked at
    // full speed. A PR in the slow lane is visible here even when nobody is
    // reading the per-PR lines above.
    logger?.log?.(
      `[watcher] posted-review phase: queued=${summary.queued} ran=${summary.ran} ` +
        `failed=${summary.failed} timed_out=${summary.timedOut} ` +
        `slow_lane_deferred=${summary.skippedByLane} budget_deferred=${summary.deferredByBudget} ` +
        `timeout_deferred=${summary.deferredAfterTimeout} ` +
        `continued_after_timeout=${summary.continuedAfterTimeout}` +
        (summary.priorityLaneBypasses > 0 ? ` priority_lane_bypasses=${summary.priorityLaneBypasses}` : '') +
        (summary.laneFloorAdmissions > 0 ? ` slow_lane_floor_admissions=${summary.laneFloorAdmissions}` : ''),
    );
  }
  return summary;
}
