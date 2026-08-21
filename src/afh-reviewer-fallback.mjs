// AFH-04 — reviewer ordered fallback: codex-reviewer → gemini-reviewer →
// claude-reviewer (LAST RESORT).
//
// Why this exists. When a provider's OAuth quota is grounded, a reviewer on that
// harness cannot spawn at all — the PR is not "reviewed slowly", it is not
// reviewed. Today the reviewer route never consults provider health: the gemini
// layer (`reviewer.gemini.mode` always-on/fallback) covers a *per-row* quota cap
// (`primaryReviewerQuotaCappedForRow`), and nothing covers "openai has been
// effectively down for an hour". AFH-02 (agent-os #4999) publishes exactly that
// verdict — `afhGrounding` on each `providerStatuses[]` row of
// `hq fleet quota status --json` — and this module is its reviewer consumer.
//
// The ordering is the whole point (SPEC §6, diversity-collapse risk). A
// `[claude-code]`-built PR routes primary → codex-reviewer. If codex grounds and
// we fell straight back to claude-reviewer, claude would be reviewing claude and
// the adversarial guarantee would silently evaporate exactly when the fleet is
// least healthy. So gemini is tried FIRST and claude-reviewer is reachable ONLY
// when gemini is unavailable too:
//
//   1. the currently-selected reviewer (the gemini layer has already run, so in
//      `always-on` deployments this is gemini),
//   2. the per-tag cross-model primary (`ROUTE_BY_BUILDER_CLASS`) — this is what
//      makes a grounded gemini fall BACK to a healthy codex rather than forward
//      to claude,
//   3. gemini,
//   4. claude — last resort.
//
// The first candidate that is neither hard-grounded (`GROUNDED_PROVIDER_STATES`)
// nor AFH-02 soft-grounded wins. If every candidate is grounded, the configured
// route is kept unchanged — a doomed spawn on the primary is no worse than a
// doomed spawn on an equally-grounded fallback, and it preserves auto-revert.
//
// Auto-revert is structural: this is a per-attempt, stateless read. The moment
// openai stops being grounded, the very next attempt returns to the configured
// primary with no operator action and nothing to un-pin.
//
// FAIL OPEN, ALWAYS. Every failure mode of the `hq` read — command missing,
// non-zero exit, timeout, unparseable JSON, no `providerStatuses`, absent
// `afhGrounding` verdict — either retries/stale-serves a recent good quota
// snapshot or degrades to "no AFH signal", which means the configured
// primary/gemini behavior, unchanged. This module never throws at its public
// boundary; routing must not be able to crash the watcher daemon.
//
// Gemini availability deliberately means *enabled AND not grounded*: with
// `reviewer.gemini.mode: off` the operator has told us gemini is not a usable
// reviewer (no Antigravity accounts, broken agy auth), and routing a fallback
// into a disabled reviewer would orphan the PR instead of covering it. That is
// the one case where a claude-built PR can reach claude-reviewer while google's
// provider row looks healthy — and it is recorded as `last-resort` in the audit
// stamp so an operator can see the diversity loss.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  isGroundedProviderState,
  parseHqFleetQuotaStatus,
} from './fleet-quota-status.mjs';
import {
  GEMINI_REVIEWABLE_BUILDER_CLASSES,
  REVIEWER_ROUTE_BY_MODEL,
  ROUTE_BY_BUILDER_CLASS,
  geminiMayReviewBuilder,
  normalizeBuilderClass,
  normalizeReviewerModel,
} from './adapters/subject/github-pr/routing.mjs';

const execFileAsync = promisify(execFile);

export const AFH_FLEET_QUOTA_STATUS_TIMEOUT_MS = 10_000;
export const AFH_FLEET_QUOTA_STATUS_RETRY_DELAYS_MS = Object.freeze([250, 1000]);
export const AFH_FLEET_QUOTA_STATUS_RETRY_TIMEOUT_FRACTION = 0.25;
export const DEFAULT_AFH_GROUNDING_TTL_MS = 60_000;
export const DEFAULT_AFH_STALE_IF_ERROR_MS = 10 * 60_000;
export const AFH_LAST_RESORT_REVIEWER_MODEL = 'claude';

// Reviewer model → the provider whose OAuth quota gates whether that reviewer
// can spawn at all. Kept in sync with QUOTA_HARNESS_PROVIDER
// (fleet-quota-status.mjs) and CLOSER_WORKER_CLASS_PROVIDER
// (ama/harness-fallback.mjs), which speak in harness/worker-class terms.
export const AFH_REVIEWER_MODEL_PROVIDER = Object.freeze({
  codex: 'openai',
  claude: 'anthropic',
  'claude-code': 'anthropic',
  gemini: 'google',
});

export function providerForReviewerModel(reviewerModel) {
  const normalized = normalizeReviewerModel(reviewerModel)
    || String(reviewerModel || '').trim().toLowerCase();
  return AFH_REVIEWER_MODEL_PROVIDER[normalized] || null;
}

function unavailableGrounding(reason, error = null) {
  return Object.freeze({
    available: false,
    reason,
    error: error === null || error === undefined ? null : String(error?.message || error),
    verdictPresent: false,
    providers: Object.freeze({}),
  });
}

/**
 * Build the AFH grounding snapshot from `hq fleet quota status --json` stdout.
 * Throws only on unparseable input; `readAfhReviewerGrounding` is the fail-open
 * wrapper every production caller should use.
 */
export function afhGroundingSnapshotFromStdout(stdout) {
  const rows = parseHqFleetQuotaStatus(stdout);
  if (!rows.length) return unavailableGrounding('no-provider-statuses');
  const providers = {};
  let verdictPresent = false;
  for (const row of rows) {
    if (!row.provider) continue;
    // Prefer the OAuth auth-path row (the path a native-harness reviewer spawn
    // actually uses); first non-oauth row is the fallback, matching
    // providerAvailabilityFromFleetStatus.
    const existing = providers[row.provider];
    if (existing && !(row.authPath === 'oauth' && existing.authPath !== 'oauth')) continue;
    const softVerdict = row.afhGrounding || null;
    providers[row.provider] = Object.freeze({
      provider: row.provider,
      authPath: row.authPath,
      state: row.state || 'unknown',
      hardGrounded: isGroundedProviderState(row.state),
      softGrounded: Boolean(softVerdict?.grounded),
      softVerdict,
    });
  }
  for (const entry of Object.values(providers)) {
    if (entry.softVerdict) verdictPresent = true;
  }
  if (!Object.keys(providers).length) return unavailableGrounding('no-provider-statuses');
  return Object.freeze({
    available: true,
    reason: 'ok',
    error: null,
    verdictPresent,
    providers: Object.freeze(providers),
  });
}

function afhReviewerFallbackDisabled(env = process.env) {
  return /^(0|false|no|off)$/i.test(String(env?.ADVERSARIAL_AFH_REVIEWER_FALLBACK ?? '').trim());
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer?.unref === 'function') timer.unref();
  });
}

function errorTextPart(value) {
  if (value === undefined || value === null) return '';
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return String(value);
}

function fleetQuotaStatusErrorText(error, seen = new Set()) {
  if (!error) return '';
  if (typeof error !== 'object') return errorTextPart(error);
  if (seen.has(error)) return '';
  seen.add(error);
  const parts = [
    errorTextPart(error.message),
    errorTextPart(error.stderr),
    errorTextPart(error.stdout),
    errorTextPart(error.code),
    errorTextPart(error.errno),
    errorTextPart(error.syscall),
    errorTextPart(error.signal),
    fleetQuotaStatusErrorText(error.cause, seen),
  ];
  return parts.filter(Boolean).join('\n');
}

function isTransientFleetQuotaStatusError(error) {
  const code = String(error?.code || '').toUpperCase();
  if (['EIO', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE'].includes(code)) return true;
  if (error?.killed === true) return true;
  const text = fleetQuotaStatusErrorText(error).toLowerCase();
  return (
    /\b(eio|etimedout|econnreset|econnrefused|epipe|eagain|eai_again|enotfound)\b/u.test(text) ||
    /timed?\s*out|timeout|tls handshake|connection reset|connection refused/u.test(text) ||
    /resource temporarily unavailable|temporarily unavailable|try again/u.test(text) ||
    /service unavailable|bad gateway|gateway timeout|http\s*5\d\d/u.test(text) ||
    /socket hang up|remote end hung up/u.test(text)
  );
}

function timeoutMsForFleetQuotaStatusAttempt(timeoutMs, attemptIndex) {
  const parsed = Number(timeoutMs);
  if (!Number.isFinite(parsed) || parsed <= 0) return timeoutMs;
  if (attemptIndex <= 0) return parsed;
  return Math.max(1, Math.ceil(parsed * AFH_FLEET_QUOTA_STATUS_RETRY_TIMEOUT_FRACTION));
}

async function readFleetQuotaStatusStdoutWithRetry({
  resolvedHqPath,
  execFileImpl,
  env,
  timeoutMs,
  retryDelaysMs,
  sleepImpl,
}) {
  const delays = Array.isArray(retryDelaysMs) ? retryDelaysMs : [];
  const pause = typeof sleepImpl === 'function' ? sleepImpl : sleep;
  const attempts = delays.length + 1;
  let lastError = null;
  for (let attemptIndex = 0; attemptIndex < attempts; attemptIndex += 1) {
    try {
      const result = await execFileImpl(resolvedHqPath, ['fleet', 'quota', 'status', '--json'], {
        env,
        encoding: 'utf8',
        maxBuffer: 5 * 1024 * 1024,
        timeout: timeoutMsForFleetQuotaStatusAttempt(timeoutMs, attemptIndex),
      });
      return typeof result === 'string' ? result : (result?.stdout || '');
    } catch (err) {
      lastError = err;
      if (!isTransientFleetQuotaStatusError(err) || attemptIndex >= attempts - 1) break;
      const delayMs = delays[attemptIndex] || 0;
      if (delayMs > 0) await pause(delayMs);
    }
  }
  throw lastError;
}

/**
 * Read AFH-02's per-provider grounding verdict via `hq fleet quota status
 * --json`. Bounded (execFile `timeout`) with tiny transient retries; every
 * remaining failure mode returns an "unavailable" snapshot instead of throwing,
 * so a broken or missing `hq` degrades reviewer routing to its configured
 * behavior rather than crashing the watcher tick.
 */
export async function readAfhReviewerGrounding({
  hqPath = null,
  execFileImpl = execFileAsync,
  env = process.env,
  timeoutMs = AFH_FLEET_QUOTA_STATUS_TIMEOUT_MS,
  retryDelaysMs = AFH_FLEET_QUOTA_STATUS_RETRY_DELAYS_MS,
  sleepImpl = sleep,
} = {}) {
  if (afhReviewerFallbackDisabled(env)) {
    return unavailableGrounding('afh-reviewer-fallback-disabled');
  }
  const resolvedHqPath = hqPath || env?.HQ_BIN || 'hq';
  let stdout;
  try {
    stdout = await readFleetQuotaStatusStdoutWithRetry({
      resolvedHqPath,
      execFileImpl,
      env,
      timeoutMs,
      retryDelaysMs,
      sleepImpl,
    });
  } catch (err) {
    // Missing binary, non-zero exit, and the execFile timeout kill all land here.
    return unavailableGrounding('fleet-quota-status-unavailable', err);
  }
  try {
    return afhGroundingSnapshotFromStdout(stdout);
  } catch (err) {
    return unavailableGrounding('fleet-quota-status-unreadable', err);
  }
}

/**
 * Per-tick memoized grounding getter, mirroring
 * `createRoutingTierReadinessProbeCache`: one `hq` subprocess per TTL window, not
 * one per PR. Concurrent callers share the in-flight read. Never rejects.
 */
export function createAfhReviewerGroundingCache({
  readImpl = readAfhReviewerGrounding,
  ttlMs = DEFAULT_AFH_GROUNDING_TTL_MS,
  nowFn = Date.now,
  env = process.env,
  hqPath = null,
  logger = console,
} = {}) {
  let cached = null;
  let lastGood = null;
  let inFlight = null;

  return async function getAfhReviewerGrounding() {
    const now = nowFn();
    if (cached && now < cached.expiresAt) return cached.snapshot;
    if (!inFlight) {
      inFlight = (async () => {
        let snapshot;
        try {
          snapshot = await readImpl({ env, hqPath });
        } catch (err) {
          // readAfhReviewerGrounding is already fail-open; this is the belt for
          // an injected reader that rejects.
          snapshot = unavailableGrounding('fleet-quota-status-unavailable', err);
        }
        const afterRead = nowFn();
        if (snapshot?.available) {
          if (!snapshot.staleIfError) lastGood = { snapshot, readAt: afterRead };
        } else if (
          lastGood?.snapshot &&
          afterRead - lastGood.readAt <= DEFAULT_AFH_STALE_IF_ERROR_MS
        ) {
          snapshot = Object.freeze({
            ...lastGood.snapshot,
            staleIfError: Object.freeze({
              reason: snapshot?.reason || 'fleet-quota-status-unavailable',
              error: snapshot?.error || null,
              lastGoodAtMs: lastGood.readAt,
            }),
          });
        }
        cached = { snapshot, expiresAt: nowFn() + ttlMs };
        // Degraded-read breadcrumb, once per refresh window rather than once per
        // PR: a watcher without `hq` on PATH would otherwise log this per subject
        // on every tick forever.
        if (!snapshot.available && snapshot.reason !== 'afh-reviewer-fallback-disabled') {
          logger?.warn?.(
            `[watcher] afh-reviewer-grounding degraded (${snapshot.reason}` +
              `${snapshot.error ? `: ${snapshot.error}` : ''}) — reviewer routing keeps the ` +
              'configured primary/gemini behavior until the next read'
          );
        } else if (snapshot.staleIfError) {
          logger?.warn?.(
            `[watcher] afh-reviewer-grounding stale-if-error ` +
              `(${snapshot.staleIfError.reason}` +
              `${snapshot.staleIfError.error ? `: ${snapshot.staleIfError.error}` : ''}) — ` +
              'using recent good quota snapshot for this refresh window'
          );
        }
        return snapshot;
      })().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  };
}

/**
 * Grounding verdict for one reviewer model. `grounded` is hard OR AFH-02 soft.
 * An unknown provider, a missing status row, or an unavailable snapshot are all
 * NOT grounded — HHR's "do not guess" contract, which here means fail open to
 * the configured route.
 */
export function reviewerModelGrounding(grounding, reviewerModel) {
  const model = normalizeReviewerModel(reviewerModel);
  const provider = providerForReviewerModel(reviewerModel);
  const base = {
    model,
    provider,
    state: null,
    hardGrounded: false,
    softGrounded: false,
    grounded: false,
    softVerdict: null,
    known: false,
  };
  if (!grounding?.available || !provider) return base;
  const entry = grounding.providers?.[provider];
  if (!entry) return { ...base, state: 'missing-provider-status' };
  return {
    ...base,
    state: entry.state,
    hardGrounded: entry.hardGrounded,
    softGrounded: entry.softGrounded,
    grounded: entry.hardGrounded || entry.softGrounded,
    softVerdict: entry.softVerdict,
    known: true,
  };
}

function groundedReason(status) {
  if (status.hardGrounded && status.softGrounded) return 'hard+soft-grounded';
  if (status.hardGrounded) return `hard-grounded:${status.state}`;
  if (status.softGrounded) return `soft-grounded:${status.softVerdict?.reason || 'afh'}`;
  return 'not-grounded';
}

/**
 * Is gemini a permissible fallback target for this builder class? Reuses the
 * existing gemini policy verbatim (integrity hard guard + the GMW-02 roster) and
 * adds the availability requirement that `reviewer.gemini.mode: off` means "not
 * a usable reviewer".
 */
export function geminiFallbackEligibility({
  builderClass,
  geminiReviewerMode = null,
  routeTable = ROUTE_BY_BUILDER_CLASS,
} = {}) {
  const mode = String(geminiReviewerMode ?? '').trim().toLowerCase();
  if (mode === 'off' || mode === '') {
    return { eligible: false, reason: 'gemini-reviewer-mode-off' };
  }
  const normalizedBuilder = normalizeBuilderClass(builderClass, routeTable);
  if (!normalizedBuilder) return { eligible: false, reason: 'unknown-builder-class' };
  // Adversarial-integrity hard guard: gemini never reviews a gemini-built PR.
  if (!geminiMayReviewBuilder(normalizedBuilder, routeTable)) {
    return { eligible: false, reason: 'gemini-integrity-guard' };
  }
  if (!GEMINI_REVIEWABLE_BUILDER_CLASSES.includes(normalizedBuilder)) {
    return { eligible: false, reason: 'builder-not-in-gemini-roster' };
  }
  return { eligible: true, reason: 'gemini-eligible' };
}

function orderedFallbackCandidates({ currentModel, crossModelPrimaryModel }) {
  const ordered = [];
  for (const candidate of [crossModelPrimaryModel, 'gemini', AFH_LAST_RESORT_REVIEWER_MODEL]) {
    const normalized = normalizeReviewerModel(candidate);
    if (!normalized) continue;
    if (normalized === currentModel) continue;
    if (ordered.includes(normalized)) continue;
    ordered.push(normalized);
  }
  return ordered;
}

/**
 * Decide the AFH reviewer fallback for one attempt. PURE — the caller supplies
 * the already-read grounding snapshot and the resolved gemini mode, so this is
 * trivially testable and cannot itself block a watcher tick.
 *
 * @returns {{applied: boolean, reason: string, from: string|null, to: string|null,
 *   lastResort: boolean, considered: Array, primary: Object|null}}
 */
export function afhReviewerFallbackDecision({
  builderClass = null,
  baseRoute = null,
  grounding = null,
  geminiReviewerMode = null,
  routeTable = ROUTE_BY_BUILDER_CLASS,
} = {}) {
  const notApplied = (reason, extra = {}) => ({
    applied: false,
    reason,
    from: normalizeReviewerModel(baseRoute?.reviewerModel) || null,
    to: null,
    lastResort: false,
    considered: [],
    primary: null,
    ...extra,
  });

  if (!baseRoute || baseRoute.configBroken) return notApplied('no-route');
  // Fail open: an unreadable/absent/disabled AFH signal keeps the configured
  // primary + gemini behavior exactly as it is today.
  if (!grounding?.available) {
    return notApplied(`afh-grounding-unavailable:${grounding?.reason || 'absent'}`);
  }
  const currentModel = normalizeReviewerModel(baseRoute.reviewerModel);
  if (!currentModel) return notApplied('unknown-reviewer-model');
  // An explicit operator reviewer pin outranks the AFH degradation path, exactly
  // as it outranks the gemini default layer. The grounded-pin case is logged by
  // the caller so the operator can see why reviews stopped.
  if (baseRoute.operatorPinnedReviewer) return notApplied('operator-pinned-reviewer');

  const primary = reviewerModelGrounding(grounding, currentModel);
  if (!primary.grounded) {
    return notApplied('primary-not-grounded', { primary });
  }

  const normalizedBuilder = normalizeBuilderClass(builderClass, routeTable)
    || normalizeBuilderClass(baseRoute.builderClass, routeTable);
  // Fail closed on an unrecognizable builder: without a builder family we cannot
  // tell a cross-model fallback from a same-model one, and a silent same-model
  // reassignment is exactly the failure this ordering exists to prevent.
  if (!normalizedBuilder) return notApplied('unknown-builder-class', { primary });
  const crossModelPrimaryModel = normalizeReviewerModel(
    routeTable?.[normalizedBuilder]?.reviewerModel
  );

  const considered = [];
  for (const candidate of orderedFallbackCandidates({ currentModel, crossModelPrimaryModel })) {
    if (candidate === 'gemini') {
      const eligibility = geminiFallbackEligibility({
        builderClass: normalizedBuilder,
        geminiReviewerMode,
        routeTable,
      });
      if (!eligibility.eligible) {
        considered.push({ reviewerModel: candidate, selected: false, reason: eligibility.reason });
        continue;
      }
    }
    const candidateRoute = REVIEWER_ROUTE_BY_MODEL[candidate];
    if (!candidateRoute) {
      considered.push({ reviewerModel: candidate, selected: false, reason: 'no-route-for-model' });
      continue;
    }
    const status = reviewerModelGrounding(grounding, candidate);
    if (status.grounded) {
      considered.push({ reviewerModel: candidate, selected: false, reason: groundedReason(status) });
      continue;
    }
    considered.push({ reviewerModel: candidate, selected: true, reason: 'available' });
    return {
      applied: true,
      reason: `primary-${groundedReason(primary)}`,
      from: currentModel,
      to: candidate,
      // Diversity bookkeeping: `lastResort` is true only when the selected
      // reviewer is the builder's own model family — reachable ONLY after gemini
      // was rejected above, by construction of the candidate order.
      lastResort:
        candidate === AFH_LAST_RESORT_REVIEWER_MODEL
        && normalizeReviewerModel(normalizedBuilder) === AFH_LAST_RESORT_REVIEWER_MODEL,
      considered,
      primary,
      builderClass: normalizedBuilder,
    };
  }

  return notApplied('all-candidates-grounded', { considered, primary });
}

/**
 * Apply an `afhReviewerFallbackDecision` to a route. Returns the route unchanged
 * when the decision did not fire.
 */
export function applyAfhReviewerFallbackDecision(baseRoute, decision) {
  if (!baseRoute || !decision?.applied) return baseRoute;
  const target = REVIEWER_ROUTE_BY_MODEL[decision.to];
  if (!target) return baseRoute;
  return {
    ...baseRoute,
    reviewerModel: target.reviewerModel,
    botTokenEnv: target.botTokenEnv,
    afhReviewerFallback: {
      fromReviewerModel: decision.from,
      toReviewerModel: decision.to,
      reason: decision.reason,
      lastResort: decision.lastResort,
      builderClass: decision.builderClass ?? null,
      primaryProvider: decision.primary?.provider || null,
      primaryState: decision.primary?.state || null,
      primaryHardGrounded: Boolean(decision.primary?.hardGrounded),
      primarySoftGrounded: Boolean(decision.primary?.softGrounded),
      considered: decision.considered,
    },
  };
}

/** One-shot decide+apply, for callers that do not need the decision separately. */
export function applyAfhReviewerFallback(options = {}) {
  const decision = afhReviewerFallbackDecision(options);
  return applyAfhReviewerFallbackDecision(options.baseRoute, decision);
}

/** Operator-facing audit breadcrumb for a fired fallback. */
export function describeAfhReviewerFallback(decision) {
  if (!decision?.applied) return null;
  const skipped = (decision.considered || [])
    .filter((entry) => !entry.selected)
    .map((entry) => `${entry.reviewerModel}:${entry.reason}`)
    .join(', ');
  return (
    `afh-reviewer-fallback ${decision.from} -> ${decision.to} ` +
    `(${decision.reason}; provider=${decision.primary?.provider || 'unknown'}; ` +
    `state=${decision.primary?.state || 'unknown'})` +
    (skipped ? ` skipped=[${skipped}]` : '') +
    (decision.lastResort
      ? ' — LAST RESORT: same-model as builder, cross-model review diversity is lost for this attempt'
      : '')
  );
}
