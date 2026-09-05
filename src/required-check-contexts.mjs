/**
 * TQL-01 — required check contexts: an expected check that never ran is
 * PENDING, never green.
 *
 * WHY THIS EXISTS. Until now the merge gate could only reason about checks it
 * could SEE. `summarizeChecksConclusion()` fails closed on an EMPTY rollup
 * (LAC-1559) and `requiredChecksGreen()` fails closed on an empty required-check
 * array — but neither can notice that ONE expected context is missing from an
 * otherwise-populated rollup. When the `Unit Tests` and `Operational CI
 * Gauntlet` workflows were disabled on 2026-08-29, their contexts simply stopped
 * appearing; the lint-and-guards rollup that remained classified SUCCESS, and
 * every merge after that date was gated by lint and guards alone
 * (`projects/trust-the-quality-loop/SPEC.md` §1). A check that never runs must
 * read as "has not reported yet", not as "nothing to see here".
 *
 * WHAT THIS MODULE IS. The registry side of that gate: pure, side-effect-free
 * helpers that turn the operator-configured
 * `roles.adversarial.merge_authority.required_check_contexts` list into (a) the
 * set of context names required for a given PR and (b) the subset of those that
 * the head's rollup has not reported. No config load, no filesystem, no clock —
 * callers resolve the configured list (from `getMergeAuthorityConfig()`) and
 * pass it in, exactly as `src/ama/merge-eligibility.mjs` requires of its inputs.
 *
 * ENTRY GRAMMAR — `[<owner>/<repo>:]<context>`
 *
 *   repo-guards                                  → required on EVERY repo
 *   laceyenterprises/agent-os:repo-guards        → required only on that repo
 *   laceyenterprises/adversarial-review:npm test (Node 20)
 *
 * The repo scope exists because ONE daemon gates PRs across several
 * repositories and no check name is common to all of them: agent-os PRs run
 * `repo-guards` / `release-freeze-gate`, adversarial-review PRs run
 * `npm test (Node NN)`. A flat, unscoped seed list would therefore make every
 * merge in whichever repo lacks that context wait forever. An unscoped entry is
 * still the right shape for a context that genuinely runs everywhere — e.g. the
 * `local-battery` context TQL-02 will publish for every push, which is why the
 * grammar keeps bare names as the simple case.
 *
 * FAIL-CLOSED ON AN UNKNOWN REPO. `selectRequiredCheckContexts()` applies a
 * scoped entry when the caller's repo MATCHES it — and also when the caller did
 * not supply a repo at all. A call site that forgets to plumb the repo therefore
 * over-requires (PRs read pending and park, visibly) rather than silently
 * dropping the requirement. For a merge gate that is the correct direction: a
 * parked PR is an operator ping, a merge on unverified CI is the incident this
 * ticket exists to prevent.
 *
 * SELF-GATE EXCLUSION. Contexts owned by the adversarial-review pipeline itself
 * are dropped from the required list. `summarizeChecksConclusion()` filters
 * those items out of the rollup before classifying (that exclusion is unchanged
 * here), so a listed self-gate context could never be observed as reported and
 * would wedge every merge permanently.
 *
 * @module required-check-contexts
 */

import { resolveGateStatusContext } from './adversarial-gate-context.mjs';

const DEFAULT_ADVERSARIAL_GATE_CONTEXT = 'agent-os/adversarial-gate';

// `owner/repo`. Deliberately narrow so a colon inside an ordinary check name
// (e.g. `build: linux`) is never mistaken for a repo scope — the prefix has to
// look like a GitHub nwo before the first colon is treated as a separator.
const REPO_SCOPE_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/**
 * Contexts the adversarial-review pipeline posts for itself. Mirrors the
 * exclusion `summarizeChecksConclusion()` applies to the rollup; kept here so a
 * self-gate context in the operator's list is dropped instead of becoming an
 * unsatisfiable requirement.
 *
 * @param {Object} [env]
 * @returns {Set<string>} lowercased context names
 */
function adversarialOwnContextNames(env = process.env) {
  const contexts = new Set([DEFAULT_ADVERSARIAL_GATE_CONTEXT]);
  try {
    contexts.add(String(resolveGateStatusContext(env)).trim().toLowerCase());
  } catch {
    // A malformed ADV_GATE_STATUS_CONTEXT must not break the merge gate; the
    // default constant is already in the set.
  }
  return contexts;
}

/**
 * Normalize a repository identifier to `owner/repo`, lowercased.
 *
 * Accepts what the call sites actually carry: `owner/repo`, a longer path whose
 * last two segments are the nwo, and an optional `.git` suffix. Returns `''`
 * when nothing usable was supplied — the "repo unknown" case.
 *
 * @param {string=} repo
 * @returns {string}
 */
function normalizeRepoKey(repo) {
  const raw = String(repo ?? '').trim().toLowerCase().replace(/\.git$/, '');
  if (!raw) return '';
  const segments = raw.split('/').filter(Boolean);
  if (segments.length < 2) return segments.join('/');
  return segments.slice(-2).join('/');
}

/**
 * Normalize a check name for comparison. Check-run names and status contexts
 * are compared case-insensitively after trimming; nothing else is folded (an
 * inner space is significant — `npm test (Node 20)` is one name).
 *
 * @param {string=} name
 * @returns {string}
 */
function normalizeContextName(name) {
  return String(name ?? '').trim().toLowerCase();
}

/**
 * Parse one configured entry into `{ repo, context }`.
 *
 * @param {string} entry
 * @returns {{ repo: string|null, context: string }|null} null for a blank entry
 */
export function parseRequiredCheckContextEntry(entry) {
  const raw = String(entry ?? '').trim();
  if (!raw) return null;
  const separator = raw.indexOf(':');
  if (separator > 0) {
    const scope = raw.slice(0, separator).trim();
    const context = raw.slice(separator + 1).trim();
    if (context && REPO_SCOPE_PATTERN.test(scope)) {
      return { repo: normalizeRepoKey(scope), context: normalizeContextName(context) };
    }
  }
  return { repo: null, context: normalizeContextName(raw) };
}

/**
 * The required context names that apply to one PR.
 *
 * @param {Array<string>|null|undefined} configured Raw
 *   `roles.adversarial.merge_authority.required_check_contexts` value. An empty
 *   / missing list returns `[]`, which every consumer treats as "no required
 *   contexts" — byte-for-byte the pre-TQL-01 behavior.
 * @param {Object}   [options]
 * @param {string=}  options.repo Repository the PR lives in (`owner/repo`).
 *   Omitted / blank ⇒ every entry applies (fail closed; see module header).
 * @param {Object=}  options.env  Env used to resolve the self-gate context.
 * @returns {string[]} lowercased, de-duplicated context names, config order
 */
export function selectRequiredCheckContexts(configured, { repo = null, env = process.env } = {}) {
  if (!Array.isArray(configured) || configured.length === 0) return [];
  const target = normalizeRepoKey(repo);
  const excluded = adversarialOwnContextNames(env);
  const selected = [];
  for (const raw of configured) {
    const entry = parseRequiredCheckContextEntry(raw);
    if (!entry || !entry.context) continue;
    // Scoped to a DIFFERENT repo. When `target` is empty the repo is unknown and
    // the entry is kept (fail closed).
    if (entry.repo && target && entry.repo !== target) continue;
    if (excluded.has(entry.context)) continue;
    if (!selected.includes(entry.context)) selected.push(entry.context);
  }
  return selected;
}

/**
 * Names a status-check rollup item reports under. A `StatusContext` carries
 * `context`; a `CheckRun` carries `name`. Both are accepted so an operator can
 * list either kind of check by the name GitHub shows.
 *
 * @param {Object} item
 * @returns {string[]}
 */
function reportedNamesForItem(item) {
  return [normalizeContextName(item?.name), normalizeContextName(item?.context)].filter(Boolean);
}

/**
 * Required contexts that have NOT reported for this head.
 *
 * "Reported" means present in the head's rollup in ANY state — a context that is
 * present but queued/in-progress is handled by the caller's existing pending
 * logic, not here. Absent means GitHub has no check of that name for the head:
 * the workflow is disabled, was never triggered, or has not registered yet.
 *
 * @param {Array} rollupItems  Status-check rollup for the PR head.
 * @param {string[]} requiredContexts Output of {@link selectRequiredCheckContexts}.
 * @returns {string[]} the missing context names, in `requiredContexts` order
 */
export function missingRequiredCheckContexts(rollupItems, requiredContexts) {
  if (!Array.isArray(requiredContexts) || requiredContexts.length === 0) return [];
  const reported = new Set();
  if (Array.isArray(rollupItems)) {
    for (const item of rollupItems) {
      for (const name of reportedNamesForItem(item)) reported.add(name);
    }
  }
  return requiredContexts.filter((context) => !reported.has(context));
}
