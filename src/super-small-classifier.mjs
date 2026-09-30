// SINGLEREVIEW-01 — which PRs are small enough to get exactly one review.
//
// Operator decision (2026-09-29): a super-small PR gets one review round. That
// review is the final round (the lenient `reviewer.last.md` bar); with no
// findings the PR takes the normal clean path, with findings it goes straight
// to the hammer through the ROUNDCAP / final-to-hammer handoff, and the hammer
// fixes and merges with no re-review.
//
// This module is the pure predicate. It reuses `slim-review-eligibility.mjs`
// for diff stats, the docs/tests path classes, the force-full label, the
// operator deny prefixes and the slim size limits, and reuses
// `security-surface-classifier.mjs` for sensitive paths and dependency
// manifests, so a table extended there is honoured here without a copy.
//
// It deliberately does NOT reuse the slim gate-keeper token table: that table
// refuses any code path whose name contains `merge`, `gate`, `reviewer`, …,
// which is right for "skip the full context bundle" but would exclude most of
// this repository from a decision the operator scoped to "any path, small code
// fixes included". The never-qualifies list below is the operator's list.

import { loadRoleConfig } from './role-config.mjs';
import {
  FORCE_FULL_REVIEW_LABEL,
  LOW_RISK_CLASS,
  SLIM_REVIEW_FORCE_FULL_ENV,
  countPatchLines,
  hasForceFullReviewLabel,
  isBinaryPatch,
  lowRiskClassForPath,
  resolveSlimReviewPolicy,
} from './slim-review-eligibility.mjs';
import {
  SECURITY_TRIGGER,
  classifySecuritySurface,
  manifestEcosystemForPath,
  sensitiveCategoriesForPath,
} from './security-surface-classifier.mjs';
import { parseDiffEntries } from './reviewer-util.mjs';

export const SINGLE_REVIEW_CONFIG_KEY = 'roles.adversarial.single_review';

// Interim kill switch. The config key is registered in the JS loader only, so
// the strict Python and shell loaders reject it until agent-os registers it;
// this env var turns the lane off (or back on) without touching config.yaml.
export const SINGLE_REVIEW_ENABLED_ENV = 'ADVERSARIAL_REVIEW_SINGLE_REVIEW_ENABLED';

export const SINGLE_REVIEW_DEFAULTS = Object.freeze({
  enabled: true,
  maxChangedLines: 50,
  maxFiles: 5,
  docsTestsFollowSlimLimits: true,
});

// How a PR qualified. `small-change` is the any-path size rule; `docs-tests`
// is the docs/tests-only rule bounded by the slim limits.
export const SUPER_SMALL_BASIS = Object.freeze({
  SMALL_CHANGE: 'small-change',
  DOCS_TESTS: 'docs-tests',
});

export const SUPER_SMALL_REFUSAL = Object.freeze({
  DISABLED: 'single-review-disabled',
  OPERATOR_FORCED_FULL: 'operator-forced-full-review',
  CHANGED_FILES_UNKNOWN: 'changed-files-unknown',
  EMPTY_CHANGE_SET: 'empty-change-set',
  TOO_LARGE: 'too-large',
  GATE_KEEPER_PATH: 'gate-keeper-path',
  MIGRATION_PATH: 'migration-path',
  SECRET_AUTH_PATH: 'secret-or-auth-path',
  WORKFLOW_PATH: 'github-workflow-path',
  DEPENDENCY_MANIFEST: 'dependency-manifest',
  OPERATOR_DENIED_PREFIX: 'operator-denied-prefix',
  BINARY_CHANGE: 'binary-change',
  // Structural diff entries. A submodule pointer bump shows two SHA lines while
  // shipping any amount of change; a rename or copy moves a file out of (or
  // into) a protected path; a mode change can make a file executable. None is
  // a "small code fix", so each refuses outright.
  GITLINK_CHANGE: 'submodule-gitlink-change',
  RENAME_OR_COPY: 'rename-or-copy',
  MODE_CHANGE: 'file-mode-change',
  // Security-surface PRs are out of the lane. Path and manifest triggers
  // already refuse per file above; a bot author (Dependabot, Renovate, …) has
  // no path to match, and any trigger the shared classifier grows later lands
  // here instead of being silently admitted.
  BOT_AUTHOR: 'bot-author',
  SECURITY_SURFACE: 'security-surface',
});

// Security-surface triggers already refused by a per-path rule above.
const PATH_REFUSAL_FOR_TRIGGER = Object.freeze({
  [SECURITY_TRIGGER.SENSITIVE_PATH]: SUPER_SMALL_REFUSAL.SECRET_AUTH_PATH,
  [SECURITY_TRIGGER.MANIFEST_CHANGE]: SUPER_SMALL_REFUSAL.DEPENDENCY_MANIFEST,
});

// The adversarial-review gate-keeper surface (agent-os AGENTS.md): the files
// that ARE the gate of every other PR. Matched against the repo-relative path
// and against the same path under the `tools/adversarial-review/` submodule
// mount, so a PR against agent-os that touches the submodule copy is refused
// the same way. The mount itself (the gitlink entry a pointer bump produces)
// and `.gitmodules` are gate-keeper paths too.
const GATE_KEEPER_PATTERNS = Object.freeze([
  /^tools\/adversarial-review$/,
  /(?:^|\/)\.gitmodules$/,
  /^src\/(?:watcher|reviewer|review-state|process-group-spawn|reviewer-reattach|reviewer-cascade)\.mjs$/,
  /^src\/kernel\//,
  /^src\/adapters\//,
  // Watcher / follow-up launchd templates.
  /(?:^|\/)launchd\//,
  /\.plist(?:\.template)?$/,
  // The orchestration scripts that drive them.
  /^scripts\//,
  /^bin\//,
]);

const MIGRATION_PATTERNS = Object.freeze([
  /(?:^|\/)alembic\//,
  /(?:^|\/)migrations\//,
  /(?:^|\/)versions\/[^/]+\.py$/,
  /\.sql$/,
]);

const WORKFLOW_PATTERN = /(?:^|\/)\.github\/workflows\//;

// Substrings, not whole tokens: `githubOAuthBroker.mjs` and `op_adapter.py`
// must both match. `auth` is the one word with a common innocent superstring,
// so `author`/`authors`/`authored`/`authorship` are carved out while
// `authorize`/`authorization` still match.
const SECRET_AUTH_PATTERNS = Object.freeze([
  /secret/,
  /credential/,
  /oauth/,
  /keychain/,
  /op[_-]adapter/,
  /auth(?!or(?:s|ed|ship)?(?:[^a-z]|$))/,
]);

const SUBMODULE_MOUNT = 'tools/adversarial-review/';

function normalizePath(raw) {
  return String(raw || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .toLowerCase();
}

function pathVariants(path) {
  return path.startsWith(SUBMODULE_MOUNT) ? [path, path.slice(SUBMODULE_MOUNT.length)] : [path];
}

function matchesAny(patterns, path) {
  return pathVariants(path).some((variant) => patterns.some((pattern) => pattern.test(variant)));
}

// Facts read from a file's diff entry beyond its line counts. The header
// (everything before the first `@@`) carries rename/copy/mode lines; a gitlink
// shows as mode 160000 in the header or `Subproject commit` lines in the body.
function diffEntryFacts(patch) {
  const text = String(patch || '');
  const firstHunk = text.search(/^@@/m);
  const header = firstHunk === -1 ? text : text.slice(0, firstHunk);
  return {
    gitlink: /^(?:new file mode|deleted file mode|old mode|new mode) 160000\b/m.test(header)
      || /^index [0-9a-f]+\.\.[0-9a-f]+ 160000\b/m.test(header)
      || /^[-+]Subproject commit /m.test(text),
    renamed: /^(?:rename from|rename to) /m.test(header),
    copied: /^(?:copy from|copy to) /m.test(header),
    modeChanged: /^(?:old mode|new mode) /m.test(header),
  };
}

function parseBooleanEnv(raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  return null;
}

function toPositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Resolve the single-review policy.
 *
 * Size knobs come from `roles.adversarial.single_review.*`. The slim limits,
 * operator deny prefixes and env force-full switch come from
 * `resolveSlimReviewPolicy`, so one operator control refuses both fast lanes.
 * A config load failure disables single review (today's behaviour) rather than
 * failing the review.
 *
 * @param {object} [options]
 * @param {object} [options.env]
 * @param {Function} [options.loadRoleConfigImpl]
 * @returns {{enabled: boolean, maxChangedLines: number, maxFiles: number, docsTestsFollowSlimLimits: boolean, slimMaxFiles: number, slimMaxChangedLines: number, deniedPrefixes: string[], forceFull: boolean, configError?: string}}
 */
export function resolveSingleReviewPolicy({ env = process.env, loadRoleConfigImpl = loadRoleConfig } = {}) {
  const slim = resolveSlimReviewPolicy(env);
  const envEnabled = parseBooleanEnv(env?.[SINGLE_REVIEW_ENABLED_ENV]);
  const base = {
    slimMaxFiles: slim.maxFiles,
    slimMaxChangedLines: slim.maxChangedLines,
    deniedPrefixes: slim.deniedPrefixes,
    forceFull: slim.forceFull,
  };
  try {
    const config = loadRoleConfigImpl({ env, contextKey: SINGLE_REVIEW_CONFIG_KEY });
    const get = (key, fallback) => config.get(`${SINGLE_REVIEW_CONFIG_KEY}.${key}`, fallback);
    return {
      ...base,
      enabled: envEnabled ?? (get('enabled', SINGLE_REVIEW_DEFAULTS.enabled) === true),
      maxChangedLines: toPositiveInt(get('max_changed_lines', SINGLE_REVIEW_DEFAULTS.maxChangedLines), SINGLE_REVIEW_DEFAULTS.maxChangedLines),
      maxFiles: toPositiveInt(get('max_files', SINGLE_REVIEW_DEFAULTS.maxFiles), SINGLE_REVIEW_DEFAULTS.maxFiles),
      docsTestsFollowSlimLimits: get('docs_tests_follow_slim_limits', SINGLE_REVIEW_DEFAULTS.docsTestsFollowSlimLimits) === true,
    };
  } catch (err) {
    // A config error keeps normal rounds even if the env var says enabled.
    return { ...base, ...SINGLE_REVIEW_DEFAULTS, enabled: false, configError: String(err?.message || err) };
  }
}

/**
 * Is this PR super-small, and if not, why not?
 *
 * Pure. `reasons` lists every rule that fired (refusals when `superSmall` is
 * false, the qualifying basis when it is true), so the log line and the job
 * record say which rule decided.
 *
 * @param {object} input
 * @param {Array<{path: string, oldPath?: string, added?: number, removed?: number, binary?: boolean, gitlink?: boolean, renamed?: boolean, copied?: boolean, modeChanged?: boolean}>|null} [input.changedFiles]
 *   `oldPath` is the pre-image path of a rename or copy; every path rule runs
 *   against both sides.
 * @param {Array<string|{name?: string}>} [input.labels]
 * @param {string|{login?: string}|null} [input.author]  PR author; a bot author
 *   is a security-surface trigger and refuses.
 * @param {object} [input.policy]  From {@link resolveSingleReviewPolicy}.
 * @returns {{superSmall: boolean, basis: string|null, reasons: Array<object>, stats: {files: number, added: number, removed: number, changedLines: number}}}
 */
export function classifySuperSmall({ changedFiles = null, labels = [], author = null, policy = SINGLE_REVIEW_DEFAULTS } = {}) {
  const effective = {
    ...SINGLE_REVIEW_DEFAULTS,
    slimMaxFiles: 20,
    slimMaxChangedLines: 400,
    deniedPrefixes: [],
    forceFull: false,
    ...policy,
  };
  const refusals = [];
  const files = Array.isArray(changedFiles)
    ? changedFiles
        .map((file) => (typeof file === 'string' ? { path: file } : file))
        .map((file) => ({
          path: normalizePath(file?.path || file?.filename),
          oldPath: normalizePath(file?.oldPath || file?.previous_filename),
          added: Number(file?.added) || 0,
          removed: Number(file?.removed) || 0,
          binary: Boolean(file?.binary),
          gitlink: Boolean(file?.gitlink),
          renamed: Boolean(file?.renamed),
          copied: Boolean(file?.copied),
          modeChanged: Boolean(file?.modeChanged),
        }))
        .filter((file) => file.path && file.path !== 'dev/null')
    : null;
  const stats = {
    files: files ? files.length : 0,
    added: files ? files.reduce((sum, file) => sum + file.added, 0) : 0,
    removed: files ? files.reduce((sum, file) => sum + file.removed, 0) : 0,
  };
  stats.changedLines = stats.added + stats.removed;

  if (!effective.enabled) refusals.push({ code: SUPER_SMALL_REFUSAL.DISABLED });
  if (effective.forceFull) {
    refusals.push({ code: SUPER_SMALL_REFUSAL.OPERATOR_FORCED_FULL, forcedBy: `env:${SLIM_REVIEW_FORCE_FULL_ENV}` });
  } else if (hasForceFullReviewLabel(labels)) {
    refusals.push({ code: SUPER_SMALL_REFUSAL.OPERATOR_FORCED_FULL, forcedBy: `label:${FORCE_FULL_REVIEW_LABEL}` });
  }
  if (files === null) refusals.push({ code: SUPER_SMALL_REFUSAL.CHANGED_FILES_UNKNOWN });
  else if (files.length === 0) refusals.push({ code: SUPER_SMALL_REFUSAL.EMPTY_CHANGE_SET });

  let basis = null;
  if (files && files.length > 0) {
    for (const file of files) {
      if (file.binary) refusals.push({ code: SUPER_SMALL_REFUSAL.BINARY_CHANGE, path: file.path });
      if (file.gitlink) refusals.push({ code: SUPER_SMALL_REFUSAL.GITLINK_CHANGE, path: file.path });
      if (file.renamed || file.copied) {
        refusals.push({ code: SUPER_SMALL_REFUSAL.RENAME_OR_COPY, path: file.path, oldPath: file.oldPath || null });
      }
      if (file.modeChanged) refusals.push({ code: SUPER_SMALL_REFUSAL.MODE_CHANGE, path: file.path });
      // A rename touches both paths; moving a protected file out is as much a
      // change to the protected path as editing it.
      for (const path of new Set([file.path, file.oldPath].filter(Boolean))) {
        if (matchesAny(GATE_KEEPER_PATTERNS, path)) refusals.push({ code: SUPER_SMALL_REFUSAL.GATE_KEEPER_PATH, path });
        if (matchesAny(MIGRATION_PATTERNS, path)) refusals.push({ code: SUPER_SMALL_REFUSAL.MIGRATION_PATH, path });
        if (matchesAny([WORKFLOW_PATTERN], path)) refusals.push({ code: SUPER_SMALL_REFUSAL.WORKFLOW_PATH, path });
        const sensitive = sensitiveCategoriesForPath(path);
        if (matchesAny(SECRET_AUTH_PATTERNS, path) || sensitive.length > 0) {
          refusals.push({ code: SUPER_SMALL_REFUSAL.SECRET_AUTH_PATH, path, categories: sensitive });
        }
        const ecosystem = manifestEcosystemForPath(path);
        if (ecosystem) refusals.push({ code: SUPER_SMALL_REFUSAL.DEPENDENCY_MANIFEST, path, ecosystem });
        const deniedPrefix = (effective.deniedPrefixes || []).find(
          (prefix) => path === prefix || path.startsWith(`${prefix}/`),
        );
        if (deniedPrefix) refusals.push({ code: SUPER_SMALL_REFUSAL.OPERATOR_DENIED_PREFIX, path, prefix: deniedPrefix });
      }
    }

    const smallChange = stats.changedLines <= effective.maxChangedLines && files.length <= effective.maxFiles;
    const docsTestsOnly = effective.docsTestsFollowSlimLimits
      && files.every((file) => [file.path, file.oldPath].filter(Boolean).every(
        (path) => [LOW_RISK_CLASS.DOCS, LOW_RISK_CLASS.TESTS].includes(lowRiskClassForPath(path)),
      ))
      && stats.changedLines <= effective.slimMaxChangedLines
      && files.length <= effective.slimMaxFiles;
    if (smallChange) basis = SUPER_SMALL_BASIS.SMALL_CHANGE;
    else if (docsTestsOnly) basis = SUPER_SMALL_BASIS.DOCS_TESTS;
    else {
      refusals.push({
        code: SUPER_SMALL_REFUSAL.TOO_LARGE,
        changedLines: stats.changedLines,
        files: files.length,
        limit: { changedLines: effective.maxChangedLines, files: effective.maxFiles },
      });
    }
  }

  // The shared security-surface classifier is the authority on what needs a
  // security review; any trigger it reports keeps the PR on normal rounds.
  const surface = classifySecuritySurface({
    author,
    changedFiles: (files || []).flatMap((file) => [file.path, file.oldPath].filter(Boolean)),
  });
  for (const reason of surface.reasons) {
    if (reason.trigger === SECURITY_TRIGGER.BOT_AUTHOR) {
      refusals.push({ code: SUPER_SMALL_REFUSAL.BOT_AUTHOR, author: reason.author });
    } else if (!refusals.some((refusal) => refusal.code === PATH_REFUSAL_FOR_TRIGGER[reason.trigger])) {
      refusals.push({ code: SUPER_SMALL_REFUSAL.SECURITY_SURFACE, trigger: reason.trigger });
    }
  }

  const superSmall = refusals.length === 0 && basis !== null;
  return {
    superSmall,
    basis: superSmall ? basis : null,
    reasons: superSmall ? [{ code: basis }] : refusals,
    stats,
  };
}

/**
 * The changed files of a unified diff, with the pre-image path and structural
 * facts (gitlink / rename / copy / mode change) the size rules alone would miss.
 * Line counts and binary detection are the slim lane's, so both lanes agree.
 *
 * Returns null (changed files unknown, so the lane refuses) when any
 * `diff --git` header could not be parsed: a file the classifier cannot name is
 * a file it cannot prove is outside the protected paths.
 */
export function superSmallFilesFromDiff(diffText) {
  const entries = parseDiffEntries(diffText);
  if (entries.some((entry) => !entry.parsed)) return null;
  if (entries.some((entry) => {
    const facts = diffEntryFacts(entry.patch);
    return !isBinaryPatch(entry.patch) && !/^@@ /m.test(entry.patch)
      && !facts.gitlink && !facts.renamed && !facts.copied && !facts.modeChanged;
  })) return null;
  return entries.map((file) => {
    const binary = isBinaryPatch(file.patch);
    const { added, removed } = binary ? { added: 0, removed: 0 } : countPatchLines(file.patch);
    return {
      path: file.path,
      oldPath: file.oldPath && file.oldPath !== file.path && file.oldPath !== '/dev/null' ? file.oldPath : null,
      added,
      removed,
      binary,
      ...diffEntryFacts(file.patch),
    };
  });
}

/** Convenience wrapper: classify straight from the diff the reviewer already has. */
export function classifySuperSmallForDiff({ diff, labels = [], author = null, policy } = {}) {
  const changedFiles = typeof diff === 'string' ? superSmallFilesFromDiff(diff) : null;
  return classifySuperSmall({ changedFiles, labels, author, policy });
}

/** One-line summary for the `single-review: super-small …` log line. */
export function describeSuperSmallDecision(decision) {
  const stats = decision?.stats || {};
  const size = `${stats.files ?? 0} file(s), ${stats.changedLines ?? 0} changed line(s)`;
  if (decision?.superSmall) return `super-small (${decision.basis}; ${size}) — first review is final`;
  const codes = [...new Set((decision?.reasons || []).map((reason) => reason.code))].join(',') || 'unknown';
  return `not super-small (${codes}; ${size})`;
}
