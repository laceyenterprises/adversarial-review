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
const DEFAULT_GH_RETRY_ATTEMPTS = 3;
const DEFAULT_GH_RETRY_DELAY_MS = 50;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorText(err) {
  return String(
    [
      err?.stderr,
      err?.stdout,
      err?.message,
      err?.code,
      err?.signal,
    ].filter(Boolean).join('\n'),
  );
}

function isTransientGhError(err) {
  const text = errorText(err).toLowerCase();
  return [
    'timeout',
    'timed out',
    'temporarily unavailable',
    'temporary failure',
    'econnreset',
    'econnrefused',
    'etimedout',
    'eai_again',
    'enotfound',
    'tls handshake',
    'http 429',
    'http 500',
    'http 502',
    'http 503',
    'http 504',
    'bad gateway',
    'service unavailable',
    'gateway timeout',
    'rate limit',
  ].some((needle) => text.includes(needle));
}

function isDuplicateLabelError(err) {
  const text = errorText(err).toLowerCase();
  return (
    text.includes('already_exists') ||
    text.includes('already exists') ||
    text.includes('name already exists') ||
    text.includes('label already exists') ||
    (text.includes('http 422') && text.includes('name'))
  );
}

async function withGhRetry(operation, {
  retryAttempts = DEFAULT_GH_RETRY_ATTEMPTS,
  retryDelayMs = DEFAULT_GH_RETRY_DELAY_MS,
  sleepImpl = sleep,
} = {}) {
  const attempts = Math.max(1, Number(retryAttempts) || 1);
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (err) {
      lastErr = err;
      if (attempt >= attempts || !isTransientGhError(err)) {
        throw err;
      }
      const delay = Math.max(0, Number(retryDelayMs) || 0) * (2 ** (attempt - 1));
      if (delay > 0) {
        await sleepImpl(delay);
      }
    }
  }
  throw lastErr;
}

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
 * @param {number=}  opts.retryAttempts
 * @param {number=}  opts.retryDelayMs
 * @param {Function=} opts.sleepImpl
 * @returns {Promise<Map<string, {name: string, color: string, description: string}>>}
 */
async function fetchRepoLabels(repo, {
  execFileImpl = execFileAsync,
  env = process.env,
  retryAttempts = DEFAULT_GH_RETRY_ATTEMPTS,
  retryDelayMs = DEFAULT_GH_RETRY_DELAY_MS,
  sleepImpl = sleep,
} = {}) {
  const { stdout } = await withGhRetry(
    () => execFileImpl(
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
    ),
    { retryAttempts, retryDelayMs, sleepImpl },
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
async function createLabel(repo, spec, {
  execFileImpl = execFileAsync,
  env = process.env,
  retryAttempts = DEFAULT_GH_RETRY_ATTEMPTS,
  retryDelayMs = DEFAULT_GH_RETRY_DELAY_MS,
  sleepImpl = sleep,
} = {}) {
  await withGhRetry(
    () => execFileImpl(
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
    ),
    { retryAttempts, retryDelayMs, sleepImpl },
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
  retryAttempts = DEFAULT_GH_RETRY_ATTEMPTS,
  retryDelayMs = DEFAULT_GH_RETRY_DELAY_MS,
  sleepImpl = sleep,
} = {}) {
  if (!repo || typeof repo !== 'string' || !repo.includes('/')) {
    throw new Error(`ensureAmaLabelsOnRepo: invalid repo '${repo}' (need '<owner>/<name>')`);
  }
  const retryOpts = { retryAttempts, retryDelayMs, sleepImpl };
  const existing = await fetchRepoLabelsImpl(repo, { execFileImpl, env, ...retryOpts });
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
    try {
      await createLabelImpl(repo, spec, { execFileImpl, env, ...retryOpts });
      ensured.push(spec.name);
      created.push(spec.name);
    } catch (err) {
      if (!isDuplicateLabelError(err)) {
        throw err;
      }
      const refreshed = await fetchRepoLabelsImpl(repo, { execFileImpl, env, ...retryOpts });
      const reconciled = refreshed.get(spec.name.toLowerCase());
      if (!reconciled) {
        throw err;
      }
      ensured.push(reconciled.name);
      preserved.push(reconciled.name);
    }
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

export const __testables__ = {
  fetchRepoLabels,
  createLabel,
  isDuplicateLabelError,
  isTransientGhError,
  withGhRetry,
};
