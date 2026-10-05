import { resolveGateStatusContext } from './adversarial-gate-context.mjs';
import { resolveRequiredCheckContextsFromCfg } from './ama/required-check-contexts.mjs';
import { loadConfigCached } from './config-loader.mjs';

const DEFAULT_ADVERSARIAL_GATE_CONTEXT = 'agent-os/adversarial-gate';

const SUCCESSFUL_CHECK_STATES = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const PENDING_CHECK_STATES = new Set([
  'PENDING',
  'IN_PROGRESS',
  'QUEUED',
  'EXPECTED',
  'WAITING',
  'REQUESTED',
]);

function checkIdentity(item) {
  return String(item?.context || item?.name || item?.workflowName || '').trim().toLowerCase();
}

function checkTimestampMs(item) {
  const values = [
    item?.completedAt,
    item?.startedAt,
    item?.updatedAt,
    item?.createdAt,
  ];
  let latest = null;
  for (const value of values) {
    const parsed = Date.parse(String(value || ''));
    if (!Number.isFinite(parsed)) continue;
    latest = latest === null ? parsed : Math.max(latest, parsed);
  }
  return latest;
}

function latestCheckRollupItems(items) {
  if (!Array.isArray(items)) return [];
  const latestByIdentity = new Map();
  const result = [];
  for (const item of items) {
    const identity = checkIdentity(item);
    const timestampMs = checkTimestampMs(item);
    if (!identity || timestampMs === null) {
      result.push(item);
      continue;
    }
    const prior = latestByIdentity.get(identity);
    if (!prior) {
      latestByIdentity.set(identity, { index: result.length, timestampMs });
      result.push(item);
      continue;
    }
    if (timestampMs >= prior.timestampMs) {
      result[prior.index] = item;
      prior.timestampMs = timestampMs;
    }
  }
  return result;
}

// Identify status-rollup items that belong to the adversarial-review
// pipeline's own gate. CheckRun names remain external CI surface area even
// when they reuse the configured context string.
function adversarialOwnCheckContexts(env = process.env) {
  const contexts = new Set([DEFAULT_ADVERSARIAL_GATE_CONTEXT.toLowerCase()]);
  try {
    contexts.add(String(resolveGateStatusContext(env)).trim().toLowerCase());
  } catch {
    // A malformed ADV_GATE_STATUS_CONTEXT must not break the merge gate; the
    // default constant is already in the set.
  }
  return contexts;
}

function isAdversarialOwnStatusContext(item, excludeContexts) {
  if (item?.__typename && item.__typename !== 'StatusContext') {
    return false;
  }
  const ctx = String(item?.context || '').trim().toLowerCase();
  if (!ctx) return false;
  return excludeContexts.has(ctx);
}

// A check run whose `status` has not reached COMPLETED is not done, whatever its
// `conclusion` field says. A StatusContext reports through `state`; everything
// else (including the flattened `{ name, conclusion }` shape that
// `fetchPullRequestRollup` emits) reports through `conclusion`.
function checkItemState(item) {
  const status = String(item?.status || '').trim().toUpperCase();
  if (status && status !== 'COMPLETED' && !SUCCESSFUL_CHECK_STATES.has(status)) {
    return PENDING_CHECK_STATES.has(status) ? 'PENDING' : status;
  }
  const raw = item?.__typename === 'StatusContext'
    ? item?.state || item?.status || item?.conclusion
    : item?.conclusion || item?.status || item?.state || item?.statusCheckRollup?.state;
  return String(raw || '').trim().toUpperCase();
}

// CIDEDUPE-01 — the ONE CI classifier. The AMA closer (`summarizeChecksConclusion`
// → `classifyCiGreen`) and the merge daemon / hammer gate (`requiredChecksGreen`
// in `src/ama/merge-eligibility.mjs`) both call this, so the closer can no
// longer route a PR to a daemon that reads the same rollup as red (SEV3
// 2026-09-28, agent-os#7314: a concurrency-cancelled `release-freeze-gate` run
// that was re-run green on the same head).
//
// Each check identity resolves to its LATEST run first (`latestCheckRollupItems`):
// cancelled-then-success is green, success-then-cancelled is not. The fail-closed
// rules are unchanged:
//   - a missing/non-array rollup → `null` (unknown);
//   - an empty rollup (after `excludeContexts`) → `null`, or `PENDING` when
//     `requiredContexts` are configured;
//   - a required context that never reported → `PENDING`;
//   - a pending or state-less latest run → `PENDING`;
//   - any other non-success latest run → that state (e.g. `FAILURE`).
// Only `SUCCESS` is green. Callers differ only in scope: which contexts are
// required, and whether the pipeline's own gate context is excluded.
function classifyCheckRollup(statusCheckRollup, { requiredContexts = [], excludeContexts = null } = {}) {
  if (!Array.isArray(statusCheckRollup)) {
    return null;
  }
  const required = (Array.isArray(requiredContexts) ? requiredContexts : [])
    .map(c => String(c).trim().toLowerCase())
    .filter(Boolean);
  const relevant = latestCheckRollupItems(excludeContexts
    ? statusCheckRollup.filter((item) => !isAdversarialOwnStatusContext(item, excludeContexts))
    : statusCheckRollup);
  if (relevant.length === 0) {
    // Fail closed (LAC-1559): "no external checks reported" is unknown, not green.
    return required.length > 0 ? 'PENDING' : null;
  }

  const reportedContexts = new Set(
    relevant
      .map(checkIdentity)
      .filter(Boolean)
  );

  let sawPending = required.some((ctx) => !reportedContexts.has(ctx));

  for (const item of relevant) {
    const state = checkItemState(item);
    if (!state || PENDING_CHECK_STATES.has(state)) {
      sawPending = true;
      continue;
    }
    if (SUCCESSFUL_CHECK_STATES.has(state)) {
      continue;
    }
    return state;
  }

  return sawPending ? 'PENDING' : 'SUCCESS';
}

// The merge-agent and AMA must not gate on the adversarial-review pipeline's
// own convergence check. Real external CI still gates.
//
// FAIL-CLOSED CONTRACT (LAC-1559) — read before "restoring" the old empty→SUCCESS
// branch in `classifyCheckRollup`. This classifier used to fail OPEN: an EXPLICIT
// empty array — including a rollup that became empty after the self-gate
// exclusion — returned 'SUCCESS' so repos with no external CI could still
// classify green. LAC-1559 RETIRED that: an empty relevant-checks rollup now
// returns `null` (unknown), exactly like a non-array/missing rollup, so a PR with
// zero external checks can never classify green. The retired behavior carried a
// premature-merge hazard — a rollup read that races GitHub BEFORE any checks
// register on a fresh head is indistinguishable from "no CI exists" and also read
// 'SUCCESS', authorizing a merge on a head whose checks had not yet reported.
//
// Consumers of this classifier — both treat `null` as fail-closed already:
//   - `fetchMergeAgentCandidate()` in `follow-up-merge-agent.mjs`
//     (`checksConclusion` on merge-agent dispatch candidates): `null` →
//     `skip-checks-unknown`, so a zero-external-check PR is not dispatched.
//   - `classifyCiGreen()` in `src/ama/eligibility.mjs` (AMA SPEC §4.2 #5):
//     `green = conclusion === 'SUCCESS'`, so `null` → not green → `ci-not-green`.
// The MSM merge predicate (`requiredChecksGreen` in
// `src/ama/merge-eligibility.mjs`) runs the same `classifyCheckRollup`, so the
// two agree on every rollup; only the self-gate exclusion and the source of the
// required contexts are specific to this entry point. `--match-head-commit
// <reviewedSha>` at merge time remains the head-move backstop; the fail-closed
// empty read is the checks-registration backstop.
// Behavior pinned by test/follow-up-merge-agent.test.mjs
// ('summarizeChecksConclusion distinguishes missing and empty status check
// rollups': undefined→null, {}→null, []→null). Required check contexts are the
// one exception: [] with configured required contexts means "waiting on those
// named checks" and returns PENDING.
function summarizeChecksConclusion(statusCheckRollup, { env = process.env, cfg = null } = {}) {
  if (!Array.isArray(statusCheckRollup)) {
    return null;
  }
  const config = cfg || loadConfigCached({ env });
  return classifyCheckRollup(statusCheckRollup, {
    requiredContexts: resolveRequiredCheckContextsFromCfg(config),
    excludeContexts: adversarialOwnCheckContexts(env),
  });
}

export { checkItemState, classifyCheckRollup, latestCheckRollupItems, summarizeChecksConclusion };
