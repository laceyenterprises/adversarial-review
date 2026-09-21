// RPL-08 — the low-risk slim review fast lane.
//
// One question, answered before the reviewer builds its prompt: may this PR be
// reviewed with the slim context path, and if not, exactly which rule refused?
//
// WHAT SLIM DOES AND DOES NOT CHANGE
//
// Slim mode trims *supplementary context*, never the review contract. The
// reviewer stage prompt (`prompts/<set>/reviewer.<stage>.md`) — verdict
// vocabulary, blocking-issue format, evidence discipline — is loaded and sent
// byte-identically in every mode. What slim drops is the two expensive
// context builders that a docs/test-only diff cannot benefit from:
//
//   * `fetchLinkedSpecContents` — up to 12 sequential `gh api` content reads,
//     up to 12 KB each. On AGY that is also prompt-argv budget, and blowing the
//     budget reroutes the review to a more expensive model or to chunking.
//   * `buildHardeningReviewContext` — spawns python3 against the session
//     ledger and matches hardening contracts by *location path*. Every
//     registered contract location is a gate-keeper surface, and gate-keeper
//     surfaces are refused from slim mode by construction, so for an eligible
//     PR this query is guaranteed to add latency and no signal.
//
// In their place slim mode states the classified surface and the refusal-free
// derivation inline, so the reviewer knows why its context is short rather than
// guessing that context fetching failed.
//
// DENY BY DEFAULT
//
// Eligibility is a conjunction of positive classification and the absence of
// every refusal. A path this module does not recognise is NOT low risk. A
// changed-file list this module could not obtain is NOT low risk. The predicate
// can only ever be wrong in the direction of running the review we run today.
//
// Purity is a hard constraint: no I/O, no network, no DB, no clock. The inputs
// are a parsed diff, the PR labels, the author, and a policy record, so the same
// decision can be reproduced from a test fixture, a dry-run CLI, or the live
// reviewer.
//
// This module returns a MODE, never a verdict. It decides how much context a
// review gets. It has no opinion on what is wrong with the code, it cannot
// approve anything, and it does not touch required-check or merge gating —
// merge authority stays exactly where RPL-05 and the AMA closure path left it.

import { classifySecuritySurface } from './security-surface-classifier.mjs';
import { parseDiffFiles } from './reviewer-util.mjs';

/**
 * The three modes a review can run in.
 *
 * `full` and `forced-full` are deliberately distinct. `full` means the PR did
 * not classify as low risk; `forced-full` means it may well have, and an
 * operator took the decision away from the classifier. Collapsing them would
 * make the latency report unable to answer "is the fast lane being refused by
 * the rules, or switched off by hand?".
 */
export const REVIEW_MODE = Object.freeze({
  FULL: 'full',
  SLIM: 'slim',
  FORCED_FULL: 'forced-full',
});

/**
 * Operator override. Matches the `operator-approved: advisory-only-review`
 * naming already used for reviewer-behaviour labels in `reviewer.mjs`.
 */
export const FORCE_FULL_REVIEW_LABEL = 'operator-approved: full-review';

/** Environment kill switch for the whole fast lane. */
export const SLIM_REVIEW_ENABLED_ENV = 'ADVERSARIAL_REVIEW_SLIM_REVIEW_ENABLED';
/** Environment escape hatch: force full review for every PR in this process. */
export const SLIM_REVIEW_FORCE_FULL_ENV = 'ADVERSARIAL_REVIEW_FORCE_FULL_REVIEW';
/** Comma-separated extra denied path prefixes, for policy that outlives a deploy. */
export const SLIM_REVIEW_DENY_PREFIXES_ENV = 'ADVERSARIAL_REVIEW_SLIM_DENY_PREFIXES';

export const SLIM_REVIEW_REFUSAL = Object.freeze({
  DISABLED: 'slim-mode-disabled',
  OPERATOR_FORCED_FULL: 'operator-forced-full',
  CHANGED_FILES_UNKNOWN: 'changed-files-unknown',
  EMPTY_CHANGE_SET: 'empty-change-set',
  SECURITY_SURFACE: 'security-surface',
  GATE_KEEPER_PATH: 'gate-keeper-path',
  GENERATED_CHURN: 'generated-churn',
  BINARY_CHANGE: 'binary-change',
  NON_LOW_RISK_PATH: 'non-low-risk-path',
  OPERATOR_DENIED_PREFIX: 'operator-denied-prefix',
  TOO_MANY_FILES: 'too-many-files',
  TOO_MANY_CHANGED_LINES: 'too-many-changed-lines',
});

export const LOW_RISK_CLASS = Object.freeze({
  DOCS: 'docs',
  TESTS: 'tests',
});

// Conservative defaults. A low-risk classification over a very wide diff is
// still a wide diff: reviewer attention per file falls as the file count rises,
// and "10 000 lines of regenerated documentation" is exactly the broad
// generated churn the ticket names.
const DEFAULT_MAX_FILES = 20;
const DEFAULT_MAX_CHANGED_LINES = 400;

// ---------------------------------------------------------------------------
// Low-risk surfaces. Allowlists, not heuristics.
// ---------------------------------------------------------------------------

const DOC_EXTENSIONS = Object.freeze(new Set(['.md', '.mdx', '.markdown', '.rst', '.txt', '.adoc']));
const DOC_BASENAMES = Object.freeze(new Set(['license', 'notice', 'authors', 'codeowners', 'copying']));

const TEST_DIRECTORY_SEGMENTS = Object.freeze(new Set(['test', 'tests', 'spec', 'specs', '__tests__', 'testdata', '__fixtures__']));
const TEST_BASENAME_PATTERNS = Object.freeze([
  /\.(?:test|spec)\.[a-z0-9]+$/, // foo.test.mjs, foo.spec.ts
  /^test_[^/]+\.py$/, // test_foo.py
  /_test\.[a-z0-9]+$/, // foo_test.go, foo_test.py
]);

// ---------------------------------------------------------------------------
// Gate-keeper surfaces. The pipeline's own control plane.
// ---------------------------------------------------------------------------

// Anchored path patterns. These apply to EVERY path including documentation:
// a markdown file living inside `.github/` or `src/ama/` is part of the control
// surface it sits in, whatever its extension.
const GATE_KEEPER_PATH_PATTERNS = Object.freeze([
  { pattern: /^\.github\//, category: 'ci' },
  { pattern: /^\.git-?hooks\//, category: 'ci' },
  { pattern: /^(?:.*\/)?launchd\//, category: 'launchd-service-template' },
  { pattern: /^migrations\//, category: 'schema-migration' },
  { pattern: /^prompts\//, category: 'reviewer-core' },
  { pattern: /^domains\//, category: 'reviewer-core' },
  { pattern: /^bin\//, category: 'pipeline-entrypoint' },
  { pattern: /^scripts\//, category: 'pipeline-entrypoint' },
  { pattern: /^hooks\//, category: 'ci' },
  { pattern: /^config(?:\.[^/]+)?\.(?:ya?ml|json)$/, category: 'pipeline-config' },
  { pattern: /^src\/ama\//, category: 'merge-authority' },
  { pattern: /^src\/kernel\//, category: 'reviewer-core' },
  { pattern: /^src\/finalization\//, category: 'merge-authority' },
  { pattern: /^src\/adapters\//, category: 'reviewer-core' },
  { pattern: /^src\/secret-source\//, category: 'secrets' },
  { pattern: /^modules\/worker-pool\/lib\//, category: 'merge-authority' },
  { pattern: /^modules\/worker-pool\/post-merge-actions\//, category: 'merge-authority' },
]);

// Whole path-segment TOKENS, compared after splitting on every non-alphanumeric
// character — the same discipline `security-surface-classifier.mjs` uses, and
// for the same reason: a substring match on `gate` fires on `delegate`, and a
// substring match on `merge` fires on `submerged`.
//
// Tokens are NOT applied to documentation files (see `gateKeeperCategoriesForPath`).
// In a filename a token like `merge` or `verdict` denotes a *privilege* only
// when the file is executable policy; in `docs/RUNBOOK-fast-merge-lane.md` it
// denotes a topic. Anchored patterns still cover documentation that lives
// inside a control-plane directory, so this exemption cannot reach `.github/`
// or `src/ama/`.
const GATE_KEEPER_TOKENS = Object.freeze(new Map(Object.entries({
  watcher: 'reviewer-core',
  reviewer: 'reviewer-core',
  reviewers: 'reviewer-core',
  pollonce: 'reviewer-core',
  verdict: 'reviewer-core',
  adjudicate: 'merge-authority',
  adjudication: 'merge-authority',
  merge: 'merge-authority',
  mergeability: 'merge-authority',
  hammer: 'merge-authority',
  closer: 'merge-authority',
  ama: 'merge-authority',
  attest: 'attestation',
  attestation: 'attestation',
  attestations: 'attestation',
  gate: 'gate-keeper',
  gates: 'gate-keeper',
  gatekeeper: 'gate-keeper',
  eligibility: 'gate-keeper',
  lease: 'gate-keeper',
  quota: 'gate-keeper',
  daemon: 'daemon',
  daemons: 'daemon',
  launchd: 'launchd-service-template',
  plist: 'launchd-service-template',
  sudoers: 'privilege',
  entitlement: 'privilege',
  entitlements: 'privilege',
  sandbox: 'privilege',
})));

// ---------------------------------------------------------------------------
// Generated / vendored churn.
// ---------------------------------------------------------------------------

const GENERATED_DIRECTORY_SEGMENTS = Object.freeze(new Set([
  'node_modules', 'dist', 'build', 'out', 'coverage', 'vendor', 'target',
  '__snapshots__', '__generated__', 'generated', '.next', '.nuxt', 'site-packages',
]));

const GENERATED_BASENAME_PATTERNS = Object.freeze([
  /\.min\.(?:js|css)$/,
  /\.(?:js|css)\.map$/,
  /\.snap$/,
  /\.generated\.[a-z0-9]+$/,
  /\.pb\.go$/,
  /_pb2(?:_grpc)?\.py$/,
  /\.lock$/,
]);

// ---------------------------------------------------------------------------
// Normalisation.
// ---------------------------------------------------------------------------

function normalizePath(entry) {
  const raw = typeof entry === 'string' ? entry : (entry?.path || entry?.filename || '');
  return String(raw || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '');
}

function basenameOf(path) {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

function extensionOf(basename) {
  const dot = basename.lastIndexOf('.');
  return dot > 0 ? basename.slice(dot) : '';
}

function tokensOf(path) {
  return path.split(/[^a-z0-9]+/i).filter(Boolean);
}

function directorySegmentsOf(path) {
  return path.split('/').slice(0, -1);
}

// ---------------------------------------------------------------------------
// Per-path classification.
// ---------------------------------------------------------------------------

/**
 * Is this path documentation?
 *
 * Extension-driven rather than directory-driven: `docs/` is the common case but
 * a top-level `README.md` or a module-local `RUNBOOK.md` is the same kind of
 * change, and pinning the directory would send both down the full path.
 *
 * @param {unknown} entry  A changed-file entry (string, `{path}`, or `{filename}`).
 * @returns {boolean}
 */
export function isDocumentationPath(entry) {
  const path = normalizePath(entry).toLowerCase();
  if (!path) return false;
  const basename = basenameOf(path);
  if (DOC_BASENAMES.has(basename)) return true;
  return DOC_EXTENSIONS.has(extensionOf(basename));
}

/**
 * Is this path a test?
 *
 * @param {unknown} entry  A changed-file entry.
 * @returns {boolean}
 */
export function isTestPath(entry) {
  const path = normalizePath(entry).toLowerCase();
  if (!path) return false;
  if (directorySegmentsOf(path).some((segment) => TEST_DIRECTORY_SEGMENTS.has(segment))) return true;
  const basename = basenameOf(path);
  return TEST_BASENAME_PATTERNS.some((pattern) => pattern.test(basename));
}

/**
 * Which low-risk class, if any, does this path belong to?
 *
 * Documentation wins over tests when a path is both (`test/README.md`), because
 * the class travels into the slim context banner as a description of what the
 * reviewer is looking at, and "docs" is the more accurate description there.
 *
 * @param {unknown} entry  A changed-file entry.
 * @returns {string|null}  A {@link LOW_RISK_CLASS} value, or null.
 */
export function lowRiskClassForPath(entry) {
  if (isDocumentationPath(entry)) return LOW_RISK_CLASS.DOCS;
  if (isTestPath(entry)) return LOW_RISK_CLASS.TESTS;
  return null;
}

/**
 * Which gate-keeper categories, if any, does this path fall into?
 *
 * @param {unknown} entry  A changed-file entry.
 * @returns {string[]}     Sorted unique categories; empty when not gate-keeper.
 */
export function gateKeeperCategoriesForPath(entry) {
  const path = normalizePath(entry).toLowerCase();
  if (!path) return [];
  const categories = new Set();

  for (const { pattern, category } of GATE_KEEPER_PATH_PATTERNS) {
    if (pattern.test(path)) categories.add(category);
  }

  // See GATE_KEEPER_TOKENS: topic words in a document title are not privileges.
  if (!isDocumentationPath(path)) {
    for (const token of tokensOf(path)) {
      const category = GATE_KEEPER_TOKENS.get(token);
      if (category) categories.add(category);
    }
  }

  return [...categories].sort();
}

/**
 * Is this path generated, vendored, or otherwise machine-authored?
 *
 * @param {unknown} entry  A changed-file entry.
 * @returns {string|null}  The matched marker, or null.
 */
export function generatedChurnMarkerForPath(entry) {
  const path = normalizePath(entry).toLowerCase();
  if (!path) return null;
  for (const segment of directorySegmentsOf(path)) {
    if (GENERATED_DIRECTORY_SEGMENTS.has(segment)) return segment;
  }
  const basename = basenameOf(path);
  for (const pattern of GENERATED_BASENAME_PATTERNS) {
    if (pattern.test(basename)) return basename;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Diff parsing.
// ---------------------------------------------------------------------------

function isBinaryPatch(patch) {
  return /^GIT binary patch$|^Binary files .* differ$/m.test(String(patch || ''));
}

function countPatchLines(patch) {
  let added = 0;
  let removed = 0;
  // Count only inside hunks. Skipping everything before the first `@@` drops the
  // `diff --git` / `index` / `--- a/x` / `+++ b/x` preamble without having to
  // special-case `+++`/`---` prefixes, which would also silently drop a content
  // line whose text begins `+++`. Undercounting would matter: these totals are a
  // ceiling check, so a low count is what lets a diff into the fast lane.
  let inHunk = false;
  for (const line of String(patch || '').split('\n')) {
    if (line.startsWith('@@')) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+')) added += 1;
    else if (line.startsWith('-')) removed += 1;
  }
  return { added, removed };
}

/**
 * Reduce a unified diff to the changed-file records this module classifies.
 *
 * The reviewer has already fetched and paid for this diff, so deriving the
 * changed-file list from it costs nothing — no extra GitHub round trip is
 * added to the review hot path, which is the whole point of RPL-08.
 *
 * @param {string} diffText  A unified diff.
 * @returns {Array<{path: string, added: number, removed: number, binary: boolean}>}
 */
export function changedFilesFromDiff(diffText) {
  return parseDiffFiles(diffText)
    .map((file) => {
      const path = normalizePath(file.path);
      const binary = isBinaryPatch(file.patch);
      const { added, removed } = binary ? { added: 0, removed: 0 } : countPatchLines(file.patch);
      return { path, added, removed, binary };
    })
    .filter((file) => file.path && file.path !== '/dev/null');
}

// ---------------------------------------------------------------------------
// Policy.
// ---------------------------------------------------------------------------

function parseBooleanEnv(raw, fallback) {
  const text = String(raw ?? '').trim().toLowerCase();
  if (!text) return fallback;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  return fallback;
}

function parsePositiveIntEnv(raw, fallback) {
  const parsed = Number.parseInt(String(raw ?? '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Resolve the slim-review policy from the environment.
 *
 * Deliberately NOT read from `config.yaml`: that file is validated by three
 * independent strict loaders (Python `_schema_v1`, this repo's Node
 * `config-loader.mjs`, and the shell `agent-os-config-loader.sh`), two of which
 * live in another repository. A new key here would have to land in all three in
 * the same deploy or the watcher crash-loops on an unknown key — the
 * `config-schema.multi-loader-parity` failure class. Environment variables on
 * the reviewer process carry no such coupling, and the launchd plist is the
 * operator's existing place to set them.
 *
 * @param {object} [env]  Environment record, defaults to `process.env`.
 * @returns {{enabled: boolean, forceFull: boolean, maxFiles: number, maxChangedLines: number, deniedPrefixes: string[]}}
 */
export function resolveSlimReviewPolicy(env = process.env) {
  const deniedPrefixes = String(env?.[SLIM_REVIEW_DENY_PREFIXES_ENV] ?? '')
    .split(',')
    .map((value) => normalizePath(value).toLowerCase())
    .filter(Boolean);
  return {
    enabled: parseBooleanEnv(env?.[SLIM_REVIEW_ENABLED_ENV], true),
    forceFull: parseBooleanEnv(env?.[SLIM_REVIEW_FORCE_FULL_ENV], false),
    maxFiles: parsePositiveIntEnv(env?.ADVERSARIAL_REVIEW_SLIM_MAX_FILES, DEFAULT_MAX_FILES),
    maxChangedLines: parsePositiveIntEnv(
      env?.ADVERSARIAL_REVIEW_SLIM_MAX_CHANGED_LINES,
      DEFAULT_MAX_CHANGED_LINES,
    ),
    deniedPrefixes,
  };
}

function normalizeLabelNames(labels) {
  if (!Array.isArray(labels)) return [];
  return labels
    .map((label) => String(typeof label === 'string' ? label : label?.name || '').trim())
    .filter(Boolean);
}

/**
 * Did an operator ask for a full review on this PR?
 *
 * @param {Array<string|{name?: string}>} labels
 * @returns {boolean}
 */
export function hasForceFullReviewLabel(labels) {
  const wanted = FORCE_FULL_REVIEW_LABEL.toLowerCase();
  return normalizeLabelNames(labels).some((name) => name.toLowerCase() === wanted);
}

// ---------------------------------------------------------------------------
// The predicate.
// ---------------------------------------------------------------------------

function refusal(code, detail = {}) {
  return { code, ...detail };
}

/**
 * May this PR be reviewed in slim mode, and if not, why not?
 *
 * Returns a decision even when it refuses: `refusals` is the complete list of
 * rules that fired, not the first one, so the latency report can say *which*
 * rule keeps a repo out of the fast lane rather than only that it is out.
 *
 * @param {object} input
 * @param {Array<{path: string, added?: number, removed?: number, binary?: boolean}>|null} [input.changedFiles]
 *   The PR's changed files. `null` or a non-array means "could not be
 *   determined", which refuses.
 * @param {Array<string|{name?: string}>} [input.labels]  PR labels.
 * @param {string|{login?: string}} [input.author]        PR author login.
 * @param {object} [input.policy]                         From {@link resolveSlimReviewPolicy}.
 * @returns {{mode: string, slim: boolean, refusals: Array<object>, lowRiskClasses: string[], stats: object, forcedBy: string|null}}
 */
export function evaluateSlimReviewEligibility({
  changedFiles = null,
  labels = [],
  author = null,
  policy = resolveSlimReviewPolicy(),
} = {}) {
  const refusals = [];
  const lowRiskClasses = new Set();

  const files = Array.isArray(changedFiles)
    ? changedFiles
        .map((file) => (typeof file === 'string' ? { path: file } : file))
        .map((file) => ({
          path: normalizePath(file),
          added: Number(file?.added) || 0,
          removed: Number(file?.removed) || 0,
          binary: Boolean(file?.binary),
        }))
        .filter((file) => file.path)
    : null;

  const stats = {
    files: files ? files.length : 0,
    added: files ? files.reduce((sum, file) => sum + file.added, 0) : 0,
    removed: files ? files.reduce((sum, file) => sum + file.removed, 0) : 0,
  };
  stats.changedLines = stats.added + stats.removed;

  // The operator override is evaluated first and reported first, but it does
  // NOT short-circuit: an operator reading the latency report for a forced-full
  // PR should still be able to see whether the classifier would have agreed.
  let forcedBy = null;
  if (policy.forceFull) {
    forcedBy = `env:${SLIM_REVIEW_FORCE_FULL_ENV}`;
  } else if (hasForceFullReviewLabel(labels)) {
    forcedBy = `label:${FORCE_FULL_REVIEW_LABEL}`;
  }
  if (forcedBy) refusals.push(refusal(SLIM_REVIEW_REFUSAL.OPERATOR_FORCED_FULL, { forcedBy }));

  if (!policy.enabled) refusals.push(refusal(SLIM_REVIEW_REFUSAL.DISABLED));

  if (files === null) {
    refusals.push(refusal(SLIM_REVIEW_REFUSAL.CHANGED_FILES_UNKNOWN));
  } else if (files.length === 0) {
    refusals.push(refusal(SLIM_REVIEW_REFUSAL.EMPTY_CHANGE_SET));
  }

  if (files && files.length > 0) {
    if (files.length > policy.maxFiles) {
      refusals.push(refusal(SLIM_REVIEW_REFUSAL.TOO_MANY_FILES, {
        files: files.length,
        limit: policy.maxFiles,
      }));
    }
    if (stats.changedLines > policy.maxChangedLines) {
      refusals.push(refusal(SLIM_REVIEW_REFUSAL.TOO_MANY_CHANGED_LINES, {
        changedLines: stats.changedLines,
        limit: policy.maxChangedLines,
      }));
    }

    // The security classifier is the authority on auth, secrets, CI workflow
    // pins, launchd plists, worker-class definitions, and dependency
    // manifests. RPL-08 reuses it rather than re-deriving those tables, so a
    // sensitive path added there is automatically refused here.
    const security = classifySecuritySurface({
      author,
      changedFiles: files.map((file) => file.path),
    });
    if (security.needsReview) {
      refusals.push(refusal(SLIM_REVIEW_REFUSAL.SECURITY_SURFACE, {
        triggers: security.reasons.map((reason) => reason.trigger),
        reasons: security.reasons,
      }));
    }

    for (const file of files) {
      if (file.binary) {
        refusals.push(refusal(SLIM_REVIEW_REFUSAL.BINARY_CHANGE, { path: file.path }));
      }

      const deniedPrefix = policy.deniedPrefixes.find(
        (prefix) => file.path.toLowerCase() === prefix || file.path.toLowerCase().startsWith(`${prefix}/`),
      );
      if (deniedPrefix) {
        refusals.push(refusal(SLIM_REVIEW_REFUSAL.OPERATOR_DENIED_PREFIX, {
          path: file.path,
          prefix: deniedPrefix,
        }));
      }

      const gateKeeper = gateKeeperCategoriesForPath(file.path);
      if (gateKeeper.length > 0) {
        refusals.push(refusal(SLIM_REVIEW_REFUSAL.GATE_KEEPER_PATH, {
          path: file.path,
          categories: gateKeeper,
        }));
      }

      const generated = generatedChurnMarkerForPath(file.path);
      if (generated) {
        refusals.push(refusal(SLIM_REVIEW_REFUSAL.GENERATED_CHURN, {
          path: file.path,
          marker: generated,
        }));
      }

      const lowRiskClass = lowRiskClassForPath(file.path);
      if (lowRiskClass) lowRiskClasses.add(lowRiskClass);
      else refusals.push(refusal(SLIM_REVIEW_REFUSAL.NON_LOW_RISK_PATH, { path: file.path }));
    }
  }

  const slim = refusals.length === 0;
  const mode = slim
    ? REVIEW_MODE.SLIM
    : (forcedBy ? REVIEW_MODE.FORCED_FULL : REVIEW_MODE.FULL);

  return {
    mode,
    slim,
    forcedBy,
    refusals,
    lowRiskClasses: [...lowRiskClasses].sort(),
    stats,
  };
}

/**
 * Convenience wrapper: classify straight from the diff the reviewer already has.
 *
 * @param {object} input
 * @param {string} input.diff                              A unified diff.
 * @param {Array<string|{name?: string}>} [input.labels]   PR labels.
 * @param {string|{login?: string}} [input.author]         PR author login.
 * @param {object} [input.policy]                          From {@link resolveSlimReviewPolicy}.
 * @returns {ReturnType<typeof evaluateSlimReviewEligibility>}
 */
export function evaluateSlimReviewEligibilityForDiff({ diff, labels = [], author = null, policy } = {}) {
  return evaluateSlimReviewEligibility({
    changedFiles: changedFilesFromDiff(diff),
    labels,
    author,
    policy: policy || resolveSlimReviewPolicy(),
  });
}

// ---------------------------------------------------------------------------
// Rendering.
// ---------------------------------------------------------------------------

function summarizeRefusals(decision, { limit = 4 } = {}) {
  const seen = new Map();
  for (const item of decision.refusals) {
    if (!seen.has(item.code)) seen.set(item.code, []);
    const paths = seen.get(item.code);
    if (item.path && paths.length < limit) paths.push(item.path);
  }
  return [...seen.entries()].map(([code, paths]) => (
    paths.length > 0 ? `${code} (${paths.join(', ')})` : code
  ));
}

/**
 * The slim-mode context block that replaces the dropped context builders.
 *
 * Stating the classification is not decoration. Without it a reviewer that is
 * used to seeing linked specs and hardening context has to guess whether the
 * short prompt means "this change is small" or "context fetching broke", and a
 * reviewer that guesses the second way spends its budget re-deriving context
 * the fast lane exists to skip.
 *
 * @param {ReturnType<typeof evaluateSlimReviewEligibility>} decision
 * @returns {string}  Empty string when the decision is not slim.
 */
export function buildSlimReviewContextBanner(decision) {
  if (!decision?.slim) return '';
  const classes = decision.lowRiskClasses.length > 0
    ? decision.lowRiskClasses.join(' + ')
    : 'low-risk';
  return [
    '',
    '---',
    '',
    '## Review Scope — Slim Context (RPL-08 low-risk fast lane)',
    '',
    `Every changed file in this PR classified as low risk (${classes}): ` +
      `${decision.stats.files} file(s), +${decision.stats.added}/-${decision.stats.removed} lines.`,
    'No gate-keeper, auth, secrets, CI, merge-authority, launchd-template, reviewer-core,',
    'dependency-manifest, or generated-churn path is present — that is a precondition of this',
    'lane, not an assumption you should re-verify.',
    '',
    'Linked-spec and hardening-ledger context were deliberately omitted for this classification.',
    'Review the diff below on its own terms. Your verdict contract is unchanged: the same',
    'blocking threshold, the same required sections, the same evidence discipline. If the diff',
    'turns out to touch a surface the classification above does not describe, say so as a',
    'blocking issue — a misclassification is itself a finding.',
    '',
  ].join('\n');
}

/**
 * One-line operator-facing description of the mode, for the posted review body.
 *
 * @param {ReturnType<typeof evaluateSlimReviewEligibility>} decision
 * @returns {string}  Empty string for an ordinary full review.
 */
export function buildReviewModeAuditBlock(decision) {
  if (!decision) return '';
  if (decision.mode === REVIEW_MODE.SLIM) {
    const classes = decision.lowRiskClasses.join(' + ') || 'low-risk';
    return `> Review mode: **slim** (RPL-08 low-risk fast lane; classified ${classes}, ` +
      `${decision.stats.files} file(s), +${decision.stats.added}/-${decision.stats.removed}). ` +
      'Verdict semantics and required checks are unchanged.\n\n';
  }
  if (decision.mode === REVIEW_MODE.FORCED_FULL) {
    return `> Review mode: **forced-full** (slim fast lane overridden by ${decision.forcedBy}).\n\n`;
  }
  return '';
}

/**
 * Compact structured summary for logs and latency-event payloads.
 *
 * @param {ReturnType<typeof evaluateSlimReviewEligibility>} decision
 * @returns {object}
 */
export function summarizeReviewModeDecision(decision) {
  return {
    mode: decision?.mode || REVIEW_MODE.FULL,
    slim: Boolean(decision?.slim),
    forcedBy: decision?.forcedBy || null,
    lowRiskClasses: decision?.lowRiskClasses || [],
    refusalCodes: [...new Set((decision?.refusals || []).map((item) => item.code))],
    refusals: summarizeRefusals(decision || { refusals: [] }),
    stats: decision?.stats || { files: 0, added: 0, removed: 0, changedLines: 0 },
  };
}
