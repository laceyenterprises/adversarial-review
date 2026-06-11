/**
 * AMA-05 — operator labels + auto-initializer.
 *
 * Two labels per SPEC §4.5 + §4.6:
 *
 *   adversarial-merge-blocked      — current-head hard stop. Overrides
 *                                    every other eligibility input
 *                                    including operator-approved.
 *                                    PR-author self-application is
 *                                    permitted (blocking your own PR
 *                                    is fine; requesting closure of
 *                                    your own PR is not).
 *   adversarial-merge-requested    — current-head request for AMA
 *                                    closure on an otherwise risk-class
 *                                    -blocked PR. Bypasses ONLY the
 *                                    risk-class gate; CI green, branch
 *                                    protection, no remediation pending,
 *                                    no hard-stop labels, mergeability —
 *                                    all still enforced. PR-author self-
 *                                    application is rejected (same
 *                                    attribution contract as
 *                                    operator-approved).
 *
 * The initializer is the watcher's "ensure these two labels exist in
 * every watched repo" pass. It runs idempotently: a repo that already
 * has both labels is a no-op.
 *
 * @module ama/labels
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Public constants — exported so consumers (eligibility module, the
 * watcher hook) don't re-derive the string.
 */
export const ADVERSARIAL_MERGE_BLOCKED_LABEL = 'adversarial-merge-blocked';
export const ADVERSARIAL_MERGE_REQUESTED_LABEL = 'adversarial-merge-requested';

/**
 * Canonical color + description for each label. Colors picked to match
 * the existing convention: red-ish for hard stop, amber-ish for
 * operator-driven request. Descriptions are surfaced in the GitHub
 * label browser so operators can self-serve discovery.
 */
const LABEL_SPECS = Object.freeze([
  {
    name: ADVERSARIAL_MERGE_BLOCKED_LABEL,
    color: 'b60205',
    description:
      'Block AMA closure on this PR\'s current head. Overrides eligibility — ' +
      'no risk class, no operator-approved label, nothing bypasses it. ' +
      'Operator hands required to remove.',
  },
  {
    name: ADVERSARIAL_MERGE_REQUESTED_LABEL,
    color: 'fbca04',
    description:
      'Operator-requested AMA closure on an otherwise risk-class-blocked PR. ' +
      'Bypasses ONLY the risk-class gate — CI green, branch protection, no ' +
      'block label, no remediation pending, mergeability all still enforced. ' +
      'Author self-application is rejected.',
  },
]);

/**
 * Fetch the labels on a repo via `gh api`. Returns a `Map<name, spec>`
 * keyed by lowercase name for case-insensitive lookups (GitHub treats
 * label names as case-insensitive on dedupe). On gh failure the
 * caller bubbles the error.
 *
 * @param {string} repo            `<owner>/<name>`
 * @param {Object=} opts
 * @param {Function=} opts.execFileImpl
 * @param {Object=}  opts.env
 * @returns {Promise<Map<string, {name: string, color: string, description: string}>>}
 */
async function fetchRepoLabels(repo, { execFileImpl = execFileAsync, env = process.env } = {}) {
  const { stdout } = await execFileImpl(
    'gh',
    [
      'api',
      `repos/${repo}/labels`,
      '--paginate',
      '--jq',
      '.[] | {name: .name, color: .color, description: .description}',
    ],
    {
      env: {
        PATH: env.PATH ?? '/usr/bin:/bin',
        HOME: env.HOME ?? '',
        GH_TOKEN: env.GH_TOKEN ?? env.GITHUB_TOKEN ?? '',
      },
      maxBuffer: 5 * 1024 * 1024,
    },
  );
  const out = new Map();
  for (const line of String(stdout || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const name = String(parsed?.name || '');
    if (!name) continue;
    out.set(name.toLowerCase(), {
      name,
      color: String(parsed?.color || ''),
      description: String(parsed?.description || ''),
    });
  }
  return out;
}

/**
 * Create a single label via `gh api`. Returns the parsed label JSON.
 */
async function createLabel(repo, spec, { execFileImpl = execFileAsync, env = process.env } = {}) {
  await execFileImpl(
    'gh',
    [
      'api',
      `repos/${repo}/labels`,
      '-X', 'POST',
      '-f', `name=${spec.name}`,
      '-f', `color=${spec.color}`,
      '-f', `description=${spec.description}`,
    ],
    {
      env: {
        PATH: env.PATH ?? '/usr/bin:/bin',
        HOME: env.HOME ?? '',
        GH_TOKEN: env.GH_TOKEN ?? env.GITHUB_TOKEN ?? '',
      },
      maxBuffer: 1 * 1024 * 1024,
    },
  );
}

/**
 * Ensure both AMA-05 labels exist on the given repo.
 *
 * Idempotent: a repo that already has both labels is a no-op. A repo
 * with neither label has both created. A repo with one and not the
 * other has the missing one created.
 *
 * The function does NOT update an existing label's color or description
 * if the operator has customized either — the operator wins. Existing
 * label name match (case-insensitive) is the idempotency check.
 *
 * @param {string} repo                `<owner>/<name>`
 * @param {Object=} opts
 * @param {Function=} opts.execFileImpl
 * @param {Function=} opts.fetchRepoLabelsImpl
 * @param {Function=} opts.createLabelImpl
 * @param {Object=}  opts.env
 * @returns {Promise<{ repo: string, ensured: string[], created: string[], preserved: string[] }>}
 */
export async function ensureAmaLabelsOnRepo(repo, {
  execFileImpl = execFileAsync,
  fetchRepoLabelsImpl = fetchRepoLabels,
  createLabelImpl = createLabel,
  env = process.env,
} = {}) {
  if (!repo || typeof repo !== 'string' || !repo.includes('/')) {
    throw new Error(`ensureAmaLabelsOnRepo: invalid repo '${repo}' (need '<owner>/<name>')`);
  }
  const existing = await fetchRepoLabelsImpl(repo, { execFileImpl, env });
  const ensured = [];
  const created = [];
  const preserved = [];
  for (const spec of LABEL_SPECS) {
    const present = existing.get(spec.name.toLowerCase());
    if (present) {
      ensured.push(present.name);
      preserved.push(present.name);
      continue;
    }
    await createLabelImpl(repo, spec, { execFileImpl, env });
    ensured.push(spec.name);
    created.push(spec.name);
  }
  return { repo, ensured, created, preserved };
}

/**
 * Ensure the labels exist across a list of watched repos. Failures on
 * one repo do NOT abort the others — the result aggregates errors per
 * repo so the watcher can log them without losing the rest.
 *
 * @param {string[]} repos
 * @param {Object=} opts
 * @returns {Promise<{ ok: Array<object>, errors: Array<{ repo: string, error: string }> }>}
 */
export async function ensureAmaLabelsOnRepos(repos, opts = {}) {
  const ok = [];
  const errors = [];
  for (const repo of repos) {
    try {
      ok.push(await ensureAmaLabelsOnRepo(repo, opts));
    } catch (err) {
      errors.push({ repo, error: String(err?.stderr || err?.message || err) });
    }
  }
  return { ok, errors };
}

/**
 * Returns the canonical label specs. Exported so the test suite can
 * pin the color + description without re-deriving them.
 */
export function listAmaLabelSpecs() {
  return LABEL_SPECS.map((spec) => ({ ...spec }));
}
