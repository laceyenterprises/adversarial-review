import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfigCached } from './config-loader.mjs';
import { fetchPullRequestCommitSubjects } from './github-api.mjs';

const execFileAsync = promisify(execFile);

const VOCABULARY_FATIGUE_DETAIL =
  "This often signals that the agent has reached the bottom of its vocabulary for change descriptors — a soft churn indicator. See docs/POSTMORTEM-codex-tui-remediation-runaway-2026-06-03.md §6 and §7.";

function normalizeVocabularyFatigueStem(subject) {
  // Strip the builder tag (e.g. `[codex] `) first.
  let withoutPrefix = String(subject || '').replace(/^\[[^\]]*\]\s+/, '').trim();
  // Then strip a leading ticket-id token (e.g. `CRG-09:` / `LAC-1234`) so that
  // ordinary same-ticket iteration is keyed off the change *verb*, not the
  // ticket id. Without this, five commits on one ticket all stem to the ticket
  // slug and the detector fires vocabulary fatigue on the normal remediation
  // pattern. (Ported from closed PR #337's sharpest review finding.)
  withoutPrefix = withoutPrefix.replace(/^[A-Z]{2,}-\d+:?\s+/, '').trim();
  const firstWord = withoutPrefix.split(/\s+/, 1)[0]?.trim();
  if (!firstWord) return null;
  let normalized = firstWord
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  if (!normalized) return null;
  // Uniform stemmer (ported from closed PR #337's `stemFromCommitSubject`):
  // strip `ing`/`ed` regardless of length so mixed-tense runs collapse to one
  // stem (`Update`/`Updated`/`Updating` -> `updat`). The previous `length > 5`
  // guard left `Update`(6)->`update` but `Updated`(7)->`updat`, silently
  // under-counting real fatigue.
  normalized = normalized
    .replace(/ing$/, '')
    .replace(/ed$/, '');
  // Collapse a trailing `e` so the bare verb and its `-ed` form unify
  // (`update` <-> `updat`). Guarded to keep the stem at least 3 chars so short
  // verbs aren't mangled.
  if (normalized.length > 4 && normalized.endsWith('e')) {
    normalized = normalized.slice(0, -1);
  }
  // Plural rules.
  if (/[^s]ies$/.test(normalized)) {
    normalized = normalized.replace(/ies$/, 'y');
  } else if (/(ches|shes|xes|zes|sses)$/.test(normalized)) {
    normalized = normalized.replace(/es$/, '');
  } else if (/s$/.test(normalized) && !/ss$/.test(normalized)) {
    normalized = normalized.slice(0, -1);
  }
  if (!normalized) return null;
  // After ticket-prefix stripping, a non-alphabetic residue (e.g. a stray
  // number or punctuation token) is not a real change verb — filter it out so
  // it counts as an unparseable subject rather than a spurious stem.
  if (!/[a-z]/.test(normalized)) return null;
  return normalized;
}

export function detectCommitVocabularyFatigue(subjects, {
  windowCommits = 5,
  minRepeats = 3,
  logger = null,
} = {}) {
  const window = Number(windowCommits);
  const threshold = Number(minRepeats);
  if (!Number.isInteger(window) || window <= 0) return null;
  if (!Number.isInteger(threshold) || threshold <= 0) return null;
  if (!Array.isArray(subjects) || subjects.length < window) return null;

  const windowSubjects = subjects.slice(-window);
  const stems = windowSubjects
    .map(normalizeVocabularyFatigueStem)
    .filter(Boolean);
  // A single subject that normalizes to empty (a merge/punctuation commit, or a
  // ticket-prefix-only subject) used to drop the array below `window` and
  // suppress the whole scan. Instead, count `minRepeats` against the stems that
  // actually parsed, so a lone weird commit doesn't silently disable detection.
  if (stems.length < window) {
    logger?.debug?.(
      `[watcher] vocabulary fatigue scan: parsed ${stems.length} ` +
      `of ${window} commit subjects in the configured window`
    );
  }
  if (stems.length < threshold) return null;

  const counts = new Map();
  for (const stem of stems) {
    counts.set(stem, (counts.get(stem) || 0) + 1);
  }
  // Report the *dominant* (most-repeated) stem rather than the first to cross
  // the threshold (ported from closed PR #342). Ties break on the
  // lexicographically smallest stem so the result is deterministic.
  let dominant = null;
  for (const [stem, count] of counts.entries()) {
    if (count < threshold) continue;
    if (
      dominant === null ||
      count > dominant.count ||
      (count === dominant.count && stem < dominant.stem)
    ) {
      dominant = { stem, count };
    }
  }
  if (dominant) {
    return {
      kind: 'remediation-vocabulary-fatigue',
      severity: 'info',
      blocking: false,
      stem: dominant.stem,
      count: dominant.count,
      window,
      detail: `The verb '${dominant.stem}' appears in ${dominant.count} of the last ${window} commit messages. ${VOCABULARY_FATIGUE_DETAIL}`,
    };
  }
  return null;
}

export function resolveVocabularyFatigueConfig({ cfg = null, env = process.env, logger = console } = {}) {
  let loaded = cfg;
  if (!loaded) {
    try {
      loaded = loadConfigCached({ env });
    } catch (err) {
      logger?.warn?.(
        `[watcher] vocabulary fatigue config load failed; using defaults: ${err?.message || err}`
      );
    }
  }
  return {
    windowCommits: Number(
      loaded?.get?.('agent_control.codex_runaway_guardrails.vocabulary_fatigue_window_commits', 5) ?? 5
    ),
    minRepeats: Number(
      loaded?.get?.('agent_control.codex_runaway_guardrails.vocabulary_fatigue_min_repeats', 3) ?? 3
    ),
  };
}

export async function computeVocabularyFatigueFindingForPR({
  repoPath,
  prNumber,
  fetchCommitSubjectsImpl = fetchPullRequestCommitSubjects,
  logger = console,
} = {}) {
  const cfg = resolveVocabularyFatigueConfig({ logger });
  try {
    const subjects = await fetchCommitSubjectsImpl(repoPath, prNumber, {
      execFileImpl: execFileAsync,
      limit: cfg.windowCommits,
    });
    return detectCommitVocabularyFatigue(subjects, { ...cfg, logger });
  } catch (err) {
    logger?.warn?.(
      `[watcher] vocabulary fatigue commit scan failed for ${repoPath}#${prNumber}: ${err?.message || err}`
    );
    return null;
  }
}
