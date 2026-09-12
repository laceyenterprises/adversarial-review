// RSP-01 — first-pass review queue depth, and the break-glass lever that lets
// first-pass review SPILL OFF the cheap single-class reviewer when the backlog
// gets expensive.
//
// ── Why this exists ──────────────────────────────────────────────────────────
// First-pass review is not single-threaded, but it is single-CLASS, which
// produces the same ceiling. Measured on this host: the last 60 reviewer spawns
// were 100% `gemini` (the `agy` harness), and `agy` is the one reviewer harness
// that does NOT parallelize — it serializes. Six pool slots all queue behind one
// provider, so arrival above what that class can absorb grows the queue without
// bound.
//
// `review-worker-class-fallback.mjs` already knows how to spill first-pass
// review to another worker class, but its ONLY trigger is provider quota
// (`primary-grounded-fallback`). A healthy-but-saturated primary never yields no
// matter how deep the backlog — and `gemini` is not even a tracked quota harness
// (`QUOTA_HARNESS_PROVIDER` covers openai/anthropic only), so that path returns
// `primary-provider-untracked` and does nothing at all. This module supplies the
// missing trigger: QUEUE DEPTH.
//
// ── This is a COST lever, not a parallelism tuning knob ──────────────────────
// `agy` is serialized on purpose: it is cheap, and keeping review on it
// preserves provider quota for the work that actually ships code (builds and
// remediations). Every other reviewer class parallelizes AND spends that same
// quota. So the threshold is not a static "how much parallelism do we want" knob
// — it is derived from live effective reviewer concurrency and measured p50 pass
// duration against a wait SLO. Hence:
//
//   1. MEASURED BY DEFAULT. The threshold follows credential count and pass
//      duration changes instead of silently aging into the wrong value.
//   2. GRADED, not on/off. Each full multiple of the threshold sitting in the
//      queue buys exactly ONE concurrent non-primary reviewer
//      (`floor(depth / threshold)`), so a marginal overflow spends marginally.
//   3. AUTO-DISENGAGES. The moment depth falls back under the threshold review
//      returns to the cheap class. It is a lever, not a ratchet.
//   4. REPORTS ITS COST. Engage/disengage transitions and the number of
//      non-primary reviews the lever actually bought are written to a durable
//      JSON report, so "spillover engaged" can be weighed against the builds it
//      displaced without grepping a 245 MB watcher log.
//
// Long run, the operator's exit from this trade is OMB (a local model backend),
// at which point parallel review stops competing with builds. That is why this
// stays a lever rather than becoming the default path.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeFileAtomic } from './atomic-write.mjs';
import { loadRoleConfig } from './role-config.mjs';
import { resolveGeminiDispatchConcurrencyLimit } from './watcher-reviewer-pool.mjs';

// ── The unit ─────────────────────────────────────────────────────────────────
// "Queue depth" is stated precisely, because an operator sets a threshold in it:
//
//   depth = OPEN PRs THAT HAVE NEVER RECEIVED A FIRST-PASS REVIEW.
//
// This is NOT a new number. It is exactly `countOpenPrsAwaitingFirstPassReview`
// in `review-state-db.mjs` — the same count the review-stall pager already
// reports — injected here as `readDepth`. Defining a second, subtly different
// "queue depth" beside it would give the operator two numbers that disagree
// during exactly the incident where both get read. Its predicate, verbatim from
// that module:
//   - `pr_state = 'open'` — merged/closed PRs are not waiting for anything.
//   - NO `reviewer_passes` row with a non-empty `gh_comment_id` — that is
//     GitHub-artifact evidence that a review really landed, deliberately chosen
//     over `reviewed_prs.posted_at`/`review_status` because those are maskable
//     by a stale success claim and are reset on re-entry.
//   - `review_status NOT IN ('malformed','unroutable-bot-author',
//     'argus-security-queued')` — work the dispatch loop explicitly refuses. It
//     will never get a first pass, so more reviewers cannot drain it.
//
// SAY WHAT ELSE IT COUNTS, AND WHAT IT DOES NOT:
//   - It DOES count a PR whose FIRST pass is in flight (`review_status =
//     'reviewing'` with no delivered pass yet) — that PR still has no review. So
//     the count cannot fall below the number of FIRST-PASS reviewers currently
//     in flight. A threshold at or under the first-pass pool ceiling (default 6,
//     max 12) could therefore be satisfied by a saturated-but-healthy pipeline
//     and pin the lever on; set it meaningfully ABOVE the pool ceiling, which is
//     also where arrivals genuinely exceed what one class absorbs.
//   - It does NOT count re-review churn at all. A PR that already has a
//     delivered pass is excluded even while a re-review is in flight for it.
//     That is the intended scope: the ticket is about first-pass throughput, and
//     re-review is not what the operator asked to parallelize. Observed on this
//     host 2026-09-06: 9 open PRs, 6 reviewers in flight, depth = 0 — every open
//     PR had already been first-passed, so the backlog was re-review, not
//     first-pass, and the lever correctly would not engage at any threshold.
//
// One-tick lag, by design: a PR discovered seconds ago gets its `reviewed_prs`
// row created later in the same tick that routes it, so it joins the count on
// the next tick. PRs sit in this queue for tens of minutes (measured p90
// time-to-merge 282 min), so one tick is immaterial to a depth threshold.
export const FIRST_PASS_REVIEW_QUEUE_DEPTH_UNIT =
  'open PRs that have never received a first-pass review '
  + '(review-state-db.countOpenPrsAwaitingFirstPassReview: pr_state open, no reviewer_passes row '
  + 'with a gh_comment_id, excluding malformed/unroutable-bot/argus-queued; '
  + 'INCLUDES first passes currently in flight)';

export const REVIEW_QUEUE_DEPTH_FAILOVER_CFG_KEY =
  'watcher.first_pass_review_queue_depth_failover_threshold';

const REPORT_RELATIVE_PATH = ['data', 'review-queue-depth-failover.json'];
const REPORT_SCHEMA_VERSION = 1;
const MAX_RETAINED_TRANSITIONS = 20;
const DEFAULT_TARGET_FIRST_PASS_WAIT_MS = 10 * 60 * 1000;
const DEFAULT_FIRST_PASS_P50_REVIEW_DURATION_MS = 4 * 60 * 1000;

export function reviewQueueDepthFailoverReportPath(rootDir) {
  return join(rootDir, ...REPORT_RELATIVE_PATH);
}

/**
 * Read the queue depth through the injected counter (the composition root
 * supplies `countOpenPrsAwaitingFirstPassReview`; this module stays free of the
 * singleton review-state DB so it can be unit-tested without opening it).
 *
 * Fails OPEN — returns `null` on a missing or throwing counter. An unreadable
 * depth must leave the lever DISENGAGED: this knob spends quota, and spending it
 * on a guessed backlog is the one failure mode that costs money for nothing.
 */
export function readFirstPassReviewQueueDepth(readDepth, { logger = null } = {}) {
  if (typeof readDepth !== 'function') return null;
  try {
    const depth = Number(readDepth());
    return Number.isFinite(depth) && depth >= 0 ? Math.trunc(depth) : null;
  } catch (err) {
    logger?.warn?.(
      `[watcher] review-queue-depth read failed; leaving depth failover disengaged: ${err?.message || err}`
    );
    return null;
  }
}

/**
 * The break-glass threshold, in units of {@link FIRST_PASS_REVIEW_QUEUE_DEPTH_UNIT}.
 *
 * `null` (the default) means "derive from live concurrency and measured pass
 * duration". Any integer >= 1 is an explicit static override for operators who
 * need to pin the threshold during an incident.
 *
 * CFG parity note: the key is declared in this repo's Node schema and reachable
 * from `AGENT_OS_WATCHER_FIRST_PASS_REVIEW_QUEUE_DEPTH_FAILOVER_THRESHOLD`
 * WITHOUT any config.yaml entry, so arming it needs no shared-file edit. Writing
 * it into the shared top-level config.yaml additionally requires the companion
 * Python (`platform/agent-os-config`) and shell (`agent-os-config-loader.sh`)
 * schema entries — a strict loader that does not know the key crash-loops its
 * daemon, which is the documented config-schema multi-loader-parity failure.
 */
export function resolveFirstPassReviewQueueDepthFailoverThreshold({
  env = process.env,
  topPath,
  modulePaths,
  loaderImpl,
} = {}) {
  const raw = loadRoleConfig({
    env,
    topPath,
    modulePaths,
    loaderImpl,
    contextKey: REVIEW_QUEUE_DEPTH_FAILOVER_CFG_KEY,
  }).get(REVIEW_QUEUE_DEPTH_FAILOVER_CFG_KEY, null);
  if (raw === undefined || raw === null || raw === '') return null;
  const parsed = Number.parseInt(String(raw), 10);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : null;
}

export function deriveFirstPassReviewQueueDepthFailoverThreshold({
  reviewerPoolMaxConcurrent = 1,
  geminiCredentialConcurrency = null,
  p50PassDurationMs = null,
  targetWaitMs = DEFAULT_TARGET_FIRST_PASS_WAIT_MS,
} = {}) {
  const poolCeiling = Math.max(1, Number.parseInt(String(reviewerPoolMaxConcurrent), 10) || 1);
  const effectiveReviewerConcurrency = resolveGeminiDispatchConcurrencyLimit({
    geminiCredentialConcurrency,
    ceiling: poolCeiling,
  });
  const observedP50PassDurationMs = Number(p50PassDurationMs);
  const passDurationMs = Number.isFinite(observedP50PassDurationMs) && observedP50PassDurationMs > 0
    ? observedP50PassDurationMs
    : DEFAULT_FIRST_PASS_P50_REVIEW_DURATION_MS;
  const waitBudgetMs = Number.isFinite(Number(targetWaitMs)) && Number(targetWaitMs) > 0
    ? Number(targetWaitMs)
    : DEFAULT_TARGET_FIRST_PASS_WAIT_MS;
  const slotsPerReviewerBeforeSlo = Math.floor(waitBudgetMs / passDurationMs) + 1;
  const threshold = Math.max(
    1,
    Math.max(0, effectiveReviewerConcurrency) * slotsPerReviewerBeforeSlo
  );
  return {
    threshold,
    source: 'derived-wait-slo',
    targetWaitMs: waitBudgetMs,
    p50PassDurationMs: passDurationMs,
    p50PassDurationSource: Number.isFinite(observedP50PassDurationMs) && observedP50PassDurationMs > 0
      ? 'reviewer_passes'
      : 'fallback',
    reviewerPoolMaxConcurrent: poolCeiling,
    effectiveReviewerConcurrency,
    geminiCredentialConcurrency:
      geminiCredentialConcurrency === null || geminiCredentialConcurrency === undefined || geminiCredentialConcurrency === ''
        ? null
        : Math.max(0, Number.parseInt(String(geminiCredentialConcurrency), 10) || 0),
  };
}

/**
 * The graded response.
 *
 * `spillSlots = floor(depth / threshold)` — each FULL multiple of the threshold
 * sitting in the queue buys one concurrent non-primary reviewer, and nothing
 * more. At depth == threshold that is exactly 1: the minimum that changes
 * anything. At 2x threshold it is 2. This keeps the grading derived from the one
 * armed value rather than introducing a second knob, and it errs late/cheap:
 * a queue 1.9x the threshold still only spends one extra reviewer.
 *
 * An unreadable depth => never engaged.
 */
export function firstPassSpilloverPlan({ depth = null, threshold = null } = {}) {
  const normalizedThreshold = Number.isInteger(threshold) && threshold >= 1 ? threshold : null;
  const normalizedDepth = Number.isInteger(depth) && depth >= 0 ? depth : null;
  const armed = normalizedThreshold !== null;
  if (!armed || normalizedDepth === null || normalizedDepth < normalizedThreshold) {
    return {
      armed,
      engaged: false,
      depth: normalizedDepth,
      threshold: normalizedThreshold,
      spillSlots: 0,
    };
  }
  return {
    armed: true,
    engaged: true,
    depth: normalizedDepth,
    threshold: normalizedThreshold,
    spillSlots: Math.max(1, Math.floor(normalizedDepth / normalizedThreshold)),
  };
}

function emptyReport() {
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    knob: REVIEW_QUEUE_DEPTH_FAILOVER_CFG_KEY,
    depthUnit: FIRST_PASS_REVIEW_QUEUE_DEPTH_UNIT,
    armed: false,
    engaged: false,
    depth: null,
    threshold: null,
    spillSlots: 0,
    engagedSince: null,
    engagedAtDepth: null,
    updatedAt: null,
    evaluatedAt: null,
    lastTransition: null,
    transitions: [],
    sizing: {
      source: null,
      targetWaitMs: null,
      p50PassDurationMs: null,
      p50PassDurationSource: null,
      reviewerPoolMaxConcurrent: null,
      effectiveReviewerConcurrency: null,
      geminiCredentialConcurrency: null,
    },
    cost: {
      spilloverReviewsTotal: 0,
      byWorkerClass: {},
      currentEngagementSpilloverReviews: 0,
      lastEngagementSpilloverReviews: null,
    },
  };
}

export function readReviewQueueDepthFailoverReport(rootDir, { readFileImpl = readFileSync } = {}) {
  try {
    const parsed = JSON.parse(String(readFileImpl(reviewQueueDepthFailoverReportPath(rootDir), 'utf8')));
    if (!parsed || typeof parsed !== 'object') return emptyReport();
    const base = emptyReport();
    return {
      ...base,
      ...parsed,
      cost: { ...base.cost, ...(parsed.cost && typeof parsed.cost === 'object' ? parsed.cost : {}) },
      transitions: Array.isArray(parsed.transitions) ? parsed.transitions : [],
    };
  } catch {
    return emptyReport();
  }
}

/**
 * Per-tick spillover controller.
 *
 * Created once per watcher tick at the composition root and threaded through
 * ctx. It owns three things the pure helpers above deliberately do not:
 *   - ONE depth read per tick (memoized), so the per-PR routing loop cannot turn
 *     a depth check into N SQL counts.
 *   - the per-tick spill BUDGET (`spillSlots`), consumed only when a spill
 *     actually applies to a route — so the reported cost is reviews that really
 *     ran elsewhere, not attempts.
 *   - the durable engage/disengage + cost report.
 *
 * Every method is fail-open where the measured inputs are unreadable: a depth
 * read failure leaves the lever disengaged, and a duration-sample failure uses
 * the conservative p50 fallback.
 */
export function createFirstPassSpilloverController({
  readDepth = null,
  env = process.env,
  rootDir,
  logger = console,
  now = () => new Date(),
  readDepthImpl = readFirstPassReviewQueueDepth,
  resolveThresholdImpl = resolveFirstPassReviewQueueDepthFailoverThreshold,
  readReportImpl = readReviewQueueDepthFailoverReport,
  writeFileImpl = writeFileAtomic,
  reviewerPoolMaxConcurrent = 1,
  geminiCredentialConcurrency = null,
  readPassDurationStats = null,
  targetWaitMs = DEFAULT_TARGET_FIRST_PASS_WAIT_MS,
} = {}) {
  let plan = null;
  let remaining = 0;
  let granted = 0;
  let report = null;

  function persist() {
    if (!rootDir || !report) return;
    try {
      writeFileImpl(reviewQueueDepthFailoverReportPath(rootDir), `${JSON.stringify(report, null, 2)}\n`);
    } catch (err) {
      logger?.warn?.(
        `[watcher] review-queue-depth-failover report write failed: ${err?.message || err}`
      );
    }
  }

  function evaluate() {
    if (plan) return plan;
    let staticThreshold = null;
    try {
      staticThreshold = resolveThresholdImpl({ env });
    } catch (err) {
      logger?.warn?.(
        `[watcher] review-queue-depth-failover static threshold unreadable; using derived sizing: ${err?.message || err}`
      );
      staticThreshold = null;
    }
    let passDurationStats = { sampleCount: 0, p50Ms: null };
    try {
      passDurationStats = typeof readPassDurationStats === 'function'
        ? (readPassDurationStats() || passDurationStats)
        : passDurationStats;
    } catch (err) {
      logger?.warn?.(
        `[watcher] review-queue-depth-failover duration sample unreadable; using fallback p50: ${err?.message || err}`
      );
    }
    const currentGeminiCredentialConcurrency = typeof geminiCredentialConcurrency === 'function'
      ? geminiCredentialConcurrency()
      : geminiCredentialConcurrency;
    const derived = deriveFirstPassReviewQueueDepthFailoverThreshold({
      reviewerPoolMaxConcurrent,
      geminiCredentialConcurrency: currentGeminiCredentialConcurrency,
      p50PassDurationMs: passDurationStats.p50Ms,
      targetWaitMs,
    });
    const threshold = staticThreshold ?? derived.threshold;
    const thresholdSource = staticThreshold === null ? derived.source : 'static-override';
    const depth = readDepthImpl(readDepth, { logger });
    plan = firstPassSpilloverPlan({ depth, threshold });
    remaining = plan.spillSlots;
    granted = 0;

    report = readReportImpl(rootDir);
    const at = now().toISOString();
    const wasEngaged = report.engaged === true;
    report.schemaVersion = REPORT_SCHEMA_VERSION;
    report.knob = REVIEW_QUEUE_DEPTH_FAILOVER_CFG_KEY;
    report.depthUnit = FIRST_PASS_REVIEW_QUEUE_DEPTH_UNIT;
    report.armed = plan.armed;
    report.engaged = plan.engaged;
    report.depth = plan.depth;
    report.threshold = plan.threshold;
    report.spillSlots = plan.spillSlots;
    report.evaluatedAt = at;
    report.updatedAt = at;
    report.sizing = {
      source: thresholdSource,
      targetWaitMs: derived.targetWaitMs,
      p50PassDurationMs: derived.p50PassDurationMs,
      p50PassDurationSource: derived.p50PassDurationSource,
      p50PassDurationSampleCount: Number(passDurationStats.sampleCount || 0),
      reviewerPoolMaxConcurrent: derived.reviewerPoolMaxConcurrent,
      effectiveReviewerConcurrency: derived.effectiveReviewerConcurrency,
      geminiCredentialConcurrency: derived.geminiCredentialConcurrency,
    };

    if (plan.engaged !== wasEngaged) {
      const event = plan.engaged ? 'engage' : 'disengage';
      const transition = {
        event,
        at,
        depth: plan.depth,
        threshold: plan.threshold,
        spillSlots: plan.spillSlots,
        // The cost the operator is owed: what the engagement that just ended
        // actually bought in non-primary reviews.
        engagementSpilloverReviews: plan.engaged
          ? 0
          : Number(report.cost.currentEngagementSpilloverReviews || 0),
      };
      if (plan.engaged) {
        report.engagedSince = at;
        report.engagedAtDepth = plan.depth;
        report.cost.currentEngagementSpilloverReviews = 0;
      } else {
        report.cost.lastEngagementSpilloverReviews = transition.engagementSpilloverReviews;
        report.cost.currentEngagementSpilloverReviews = 0;
        report.engagedSince = null;
        report.engagedAtDepth = null;
      }
      report.lastTransition = transition;
      report.transitions = [...report.transitions, transition].slice(-MAX_RETAINED_TRANSITIONS);
      logger?.warn?.(
        `[watcher] review-queue-depth-failover ${event} `
        + `depth=${plan.depth} threshold=${plan.threshold} spill_slots=${plan.spillSlots} `
        + `engagement_spillover_reviews=${transition.engagementSpilloverReviews} `
        + `unit="${FIRST_PASS_REVIEW_QUEUE_DEPTH_UNIT}"`
      );
      persist();
    } else {
      persist();
    }
    return plan;
  }

  return {
    /** Memoized per-tick plan. */
    plan() {
      return evaluate();
    },
    /**
     * Snapshot handed to `resolveReviewerWorkerClassWithFallback`. `engaged` is
     * false whenever depth is under threshold or the tick's spill budget is
     * spent — in both cases the resolver takes its primary path unchanged.
     */
    depthPressure() {
      const current = evaluate();
      return {
        engaged: current.engaged && remaining > 0,
        depth: current.depth,
        threshold: current.threshold,
        spillSlots: current.spillSlots,
        remaining,
      };
    },
    /**
     * Consume one slot and charge the cost ledger. Call ONLY once a depth-driven
     * fallback has actually been applied to a route.
     */
    recordSpill({ repo = null, prNumber = null, fromWorkerClass = null, toWorkerClass = null } = {}) {
      const current = evaluate();
      if (!current.engaged || remaining <= 0) return false;
      remaining -= 1;
      granted += 1;
      const to = String(toWorkerClass || 'unknown').trim().toLowerCase() || 'unknown';
      report.cost.spilloverReviewsTotal = Number(report.cost.spilloverReviewsTotal || 0) + 1;
      report.cost.byWorkerClass[to] = Number(report.cost.byWorkerClass[to] || 0) + 1;
      report.cost.currentEngagementSpilloverReviews =
        Number(report.cost.currentEngagementSpilloverReviews || 0) + 1;
      report.updatedAt = now().toISOString();
      logger?.warn?.(
        `[watcher] review-queue-depth-spillover repo=${repo} pr=${prNumber} `
        + `from=${fromWorkerClass} to=${to} depth=${current.depth} threshold=${current.threshold} `
        + `slot=${granted}/${current.spillSlots} `
        + `engagement_spillover_reviews=${report.cost.currentEngagementSpilloverReviews} `
        + `total_spillover_reviews=${report.cost.spilloverReviewsTotal}`
      );
      persist();
      return true;
    },
    /** Test/observability accessor: slots consumed so far this tick. */
    granted() {
      return granted;
    },
  };
}
