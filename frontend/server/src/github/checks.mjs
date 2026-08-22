/**
 * Check normalization and the required-check rollup (ARF-02).
 *
 * GitHub reports a PR's CI through two unrelated APIs with two different
 * vocabularies — modern **check runs** (`status` + `conclusion`) and legacy
 * **commit statuses** (`state`) — and branch protection's required set is a
 * third list that names contexts from either. The dashboard needs one answer, so
 * both are normalized into one entry shape here and summarized into one rollup.
 *
 * The summary is deliberately **conservative about green**, because this repo
 * has already paid for the other bias: PR #4223 was merged over a repo-guards
 * FAILURE, and #4224/#4233/#4235 merged with no reviews at all. Concretely:
 *
 *   - A required context that has not reported at all is `pending`, not absent.
 *     A rollup computed only over checks that showed up reads "all green" for a
 *     PR whose required workflow never started, which is exactly how a red PR
 *     looks mergeable.
 *   - A conclusion outside the known vocabulary counts as `pending`, not
 *     success. New GitHub conclusions should degrade toward "don't merge yet".
 *   - `neutral` and `skipped` count as passing, because that is what GitHub's
 *     own branch protection does; treating them as failures would report a
 *     correctly-mergeable PR as blocked.
 *
 * When branch protection is unreadable (the common case — it needs admin, and a
 * reviewer identity is not an admin), `requiredKnown` is false and the rollup
 * covers **every** reported check. That is a broader gate than GitHub's, and it
 * is labelled as such rather than quietly presented as the required-check answer.
 */

export const ROLLUP_SUCCESS = 'success';
export const ROLLUP_FAILURE = 'failure';
export const ROLLUP_PENDING = 'pending';
export const ROLLUP_NONE = 'none';

/** Check-run conclusions that block. `stale` blocks: its result is not about this head. */
const FAILING_CONCLUSIONS = new Set([
  'failure', 'timed_out', 'action_required', 'cancelled', 'stale', 'startup_failure',
]);

/** Conclusions GitHub's own required-check gate treats as satisfied. */
const PASSING_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);

/** Legacy commit-status `state` -> check-run `conclusion`. `pending` has none yet. */
const STATUS_STATE_TO_CONCLUSION = new Map([
  ['success', 'success'],
  ['failure', 'failure'],
  ['error', 'failure'],
  ['pending', null],
]);

function text(value) {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  return str || null;
}

/** One check run from `GET /repos/{repo}/commits/{sha}/check-runs`. */
export function normalizeCheckRun(run) {
  return {
    name: text(run?.name),
    kind: 'check-run',
    status: text(run?.status),
    conclusion: text(run?.conclusion),
    url: text(run?.html_url) ?? text(run?.details_url),
    completedAt: text(run?.completed_at),
  };
}

/**
 * One commit status from `GET /repos/{repo}/commits/{sha}/status`.
 *
 * Mapped onto the check-run vocabulary so the dashboard has one shape to render.
 * A commit status has no in-progress/completed axis of its own — `pending` is
 * the only non-terminal state — so it is projected onto that axis here.
 */
export function normalizeCommitStatus(status) {
  const state = String(status?.state ?? '').toLowerCase();
  const known = STATUS_STATE_TO_CONCLUSION.has(state);
  return {
    name: text(status?.context),
    kind: 'status',
    // An unrecognised state is not asserted to be finished: `null` status flows
    // into the pending bucket below rather than into a conclusion check.
    status: known ? (state === 'pending' ? 'in_progress' : 'completed') : null,
    conclusion: known ? STATUS_STATE_TO_CONCLUSION.get(state) : null,
    url: text(status?.target_url),
    completedAt: text(status?.updated_at),
  };
}

/**
 * Roll normalized entries up into one verdict.
 *
 * @param {object[]} entries normalized check entries
 * @param {{requiredContexts?: string[]|null}} [options] required contexts from
 *   branch protection, or null when protection could not be read.
 * @returns {{
 *   rollup: string, requiredKnown: boolean, required: string[], missingRequired: string[],
 *   total: number, gating: number, success: number, failure: number, pending: number,
 *   entries: object[]
 * }}
 */
export function summarizeChecks(entries, { requiredContexts = null } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const requiredKnown = Array.isArray(requiredContexts);
  const required = requiredKnown
    ? [...new Set(requiredContexts.map((name) => String(name)))]
    : [];
  const requiredSet = new Set(required);

  const marked = list.map((entry) => ({
    ...entry,
    // `null` (not `false`) when protection is unreadable: "we could not find out
    // whether this check is required" is a different claim from "it is not".
    required: requiredKnown ? requiredSet.has(entry.name) : null,
  }));

  const gating = requiredKnown ? marked.filter((entry) => entry.required) : marked;
  const reported = new Set(gating.map((entry) => entry.name));
  const missingRequired = required.filter((name) => !reported.has(name));

  let success = 0;
  let failure = 0;
  let pending = 0;
  for (const entry of gating) {
    if (entry.status !== 'completed' || entry.conclusion === null) {
      pending += 1;
    } else if (FAILING_CONCLUSIONS.has(entry.conclusion)) {
      failure += 1;
    } else if (PASSING_CONCLUSIONS.has(entry.conclusion)) {
      success += 1;
    } else {
      pending += 1;
    }
  }

  let rollup;
  if (failure > 0) rollup = ROLLUP_FAILURE;
  else if (pending > 0 || missingRequired.length > 0) rollup = ROLLUP_PENDING;
  else if (gating.length === 0) rollup = ROLLUP_NONE;
  else rollup = ROLLUP_SUCCESS;

  return {
    rollup,
    requiredKnown,
    required,
    missingRequired,
    total: marked.length,
    gating: gating.length,
    success,
    failure,
    pending,
    entries: marked,
  };
}
