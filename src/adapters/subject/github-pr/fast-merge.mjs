// Fast-merge / GitHub-mechanics helpers extracted from watcher.mjs (ARC-18).
//
// Pure decision, diff-shape, and audit-persistence helpers for the fast-merge
// authorization path. These are the review-agnostic "subject" mechanics the
// watcher used to carry inline; they now live behind the github-pr subject
// adapter so watcher.mjs can shrink toward a scheduler loop. Behavior is
// preserved exactly — parity is verified end-to-end through `pollOnce` in
// test/watcher-fast-merge.test.mjs. The live GitHub network reads (labels,
// head SHA, timeline events, changed files) remain in watcher.mjs pending a
// follow-up extraction commit; this module holds only the pure + filesystem
// helpers they call.

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { writeFileAtomic } from '../../../atomic-write.mjs';
import { fetchConditionalRestPage } from '../../../conditional-request.mjs';
import { fastMergeAuditPath } from '../../../fast-merge-audit-storage.mjs';
import { fetchPullRequestHeadAndState } from '../../../github-api.mjs';

const execFileAsync = promisify(execFile);

// Repo root, computed identically to watcher.mjs's ROOT (repo root), resolved
// from this module's location so the conditional-request cache dir and audit
// paths resolve to the exact same absolute path the watcher used inline.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

const FAST_MERGE_TIMELINE_MAX_PAGES = Math.max(
  1,
  Number.parseInt(process.env.FML_WATCHER_TIMELINE_MAX_PAGES || '3', 10) || 3,
);

const FAST_MERGE_CHANGED_FILES_MAX_PAGES = Math.max(
  1,
  Number.parseInt(process.env.FML_WATCHER_CHANGED_FILES_MAX_PAGES || '3', 10) || 3,
);

export const FAST_MERGE_VETO_LABEL = 'fast-merge-veto';
export const FAST_MERGE_CATEGORY_BY_LABEL = Object.freeze({
  'fast-merge:spec-hash-rebind': 'spec-hash-rebind',
  'fast-merge:docs': 'docs',
  'fast-merge:test-fixtures': 'test-fixtures',
  'fast-merge:submodule-bump': 'submodule-bump',
});
export const DEFAULT_FAST_MERGE_OPERATOR_ACTORS = Object.freeze(['VirtualPaul']);
export const DEFAULT_FAST_MERGE_SUBMODULE_PATHS = Object.freeze([
  'tools/adversarial-review',
  'modules/agent-control/vendor/agent-control',
]);
export const FAST_MERGE_TIMELINE_HEAD_EVENT_NAMES = new Set([
  'committed',
  'head_ref_force_pushed',
  'head_ref_restored',
]);

export function normalizeLabelName(label) {
  return String(typeof label === 'string' ? label : label?.name || '').trim();
}

export function fastMergeDecisionFromLabels(labels) {
  const labelNames = (Array.isArray(labels) ? labels : [])
    .map(normalizeLabelName)
    .filter(Boolean);
  const categories = [...new Set(
    labelNames
      .map((name) => FAST_MERGE_CATEGORY_BY_LABEL[name])
      .filter(Boolean)
  )];
  return {
    hasFastMergeLabel: categories.length > 0,
    hasVeto: labelNames.includes(FAST_MERGE_VETO_LABEL),
    categories,
    labelNames,
  };
}

export function parseFastMergeEventTime(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : null;
}

export function parseFastMergeList(value, fallback = []) {
  const raw = String(value || '').trim();
  const source = raw ? raw.split(',') : fallback;
  return new Set(
    source
      .map((item) => String(item || '').trim())
      .filter(Boolean)
  );
}

export function fastMergeOperatorActorSet(env = process.env) {
  return parseFastMergeList(env.FML_WATCHER_OPERATOR_ACTORS, DEFAULT_FAST_MERGE_OPERATOR_ACTORS);
}

export function fastMergeSubmodulePathSet(env = process.env) {
  return parseFastMergeList(env.FML_WATCHER_SUBMODULE_PATHS, DEFAULT_FAST_MERGE_SUBMODULE_PATHS);
}

export function normalizeTimelineActor(actor) {
  return String(actor?.login || actor?.name || actor || '').trim();
}

export function isFastMergeOperatorActor(actor, env = process.env) {
  const actorName = normalizeTimelineActor(actor);
  if (!actorName) return false;
  return fastMergeOperatorActorSet(env).has(actorName);
}

export function fastMergeEventTimestamp(event) {
  const eventName = String(event?.event || '').trim().toLowerCase();
  return event?.created_at
    || event?.createdAt
    || (
      eventName === 'committed'
        ? event?.committer?.date
          || event?.author?.date
          || event?.commit?.committer?.date
          || event?.commit?.author?.date
        : null
    );
}

export function latestTimelineFastMergeAuthorization(
  events,
  allowedLabelNames,
  { liveHeadSha = null, env = process.env } = {},
) {
  const allowed = new Set(
    (Array.isArray(allowedLabelNames) ? allowedLabelNames : [])
      .map((name) => normalizeLabelName(name).toLowerCase())
      .filter(Boolean)
  );
  if (allowed.size === 0 || !Array.isArray(events)) return null;

  const normalizedEvents = events
    .map((event, index) => {
      const createdAt = fastMergeEventTimestamp(event);
      const createdAtMs = parseFastMergeEventTime(createdAt);
      if (createdAtMs == null) return null;
      return {
        event,
        index,
        createdAt,
        createdAtMs,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.createdAtMs - b.createdAtMs || a.index - b.index);

  let latestLabel = null;

  for (const entry of normalizedEvents) {
    const eventName = String(entry.event?.event || '').trim().toLowerCase();

    if (eventName === 'labeled') {
      const labelName = normalizeLabelName(
        entry.event?.label?.name || entry.event?.label || entry.event?.name || ''
      ).toLowerCase();
      if (!allowed.has(labelName)) continue;
      const actor = normalizeTimelineActor(entry.event?.actor);
      if (!isFastMergeOperatorActor(actor, env)) continue;
      if (
        !latestLabel
        || entry.createdAtMs > latestLabel.createdAtMs
        || (entry.createdAtMs === latestLabel.createdAtMs && entry.index > latestLabel.index)
      ) {
        latestLabel = {
          createdAt: entry.createdAt,
          createdAtMs: entry.createdAtMs,
          index: entry.index,
          label: labelName,
          actor,
        };
      }
    }
  }

  if (!latestLabel) return null;

  const latestHeadAdvanceAtOrAfterLabel = normalizedEvents.findLast((entry) => {
    const eventName = String(entry.event?.event || '').trim().toLowerCase();
    return FAST_MERGE_TIMELINE_HEAD_EVENT_NAMES.has(eventName)
      && (
        entry.createdAtMs > latestLabel.createdAtMs
        || (entry.createdAtMs === latestLabel.createdAtMs && entry.index > latestLabel.index)
      );
  });
  if (latestHeadAdvanceAtOrAfterLabel) {
    return null;
  }

  const authorizedHeadSha = String(liveHeadSha || '').trim();
  if (!authorizedHeadSha) return null;

  return {
    authorizedAt: latestLabel.createdAt,
    label: latestLabel.label,
    authorizedHeadSha,
    actor: latestLabel.actor,
  };
}

export function normalizeChangedFile(file) {
  return {
    filename: String(file?.filename || file?.path || '').trim(),
    status: String(file?.status || '').trim().toLowerCase(),
    additions: Number.isFinite(Number(file?.additions)) ? Number(file.additions) : 0,
    deletions: Number.isFinite(Number(file?.deletions)) ? Number(file.deletions) : 0,
  };
}

export function isMarkdownOrDocsPath(filename) {
  return /\.(adoc|md|mdx|rst|txt)$/i.test(filename);
}

export function isTestFixturePath(filename) {
  return /(^|\/)(fixtures?|testdata|snapshots?)(\/|$)/i.test(filename);
}

export function isKnownSubmodulePath(filename) {
  return fastMergeSubmodulePathSet().has(String(filename || '').trim());
}

export function fastMergeFileMatchesCategory(file, category) {
  const normalized = normalizeChangedFile(file);
  if (!normalized.filename) return false;
  if (category === 'docs') {
    return isMarkdownOrDocsPath(normalized.filename);
  }
  if (category === 'test-fixtures') {
    return normalized.deletions === 0 && isTestFixturePath(normalized.filename);
  }
  if (category === 'submodule-bump') {
    return normalized.status === 'modified'
      && normalized.additions <= 1
      && normalized.deletions <= 1
      && isKnownSubmodulePath(normalized.filename);
  }
  if (category === 'spec-hash-rebind') {
    return normalized.additions <= 5
      && normalized.deletions <= 5
      && (
        /(^|\/)SPEC[^/]*\.md$/i.test(normalized.filename)
        || /(^|\/)spec-hash/i.test(normalized.filename)
        || /(^|\/)spec-lock/i.test(normalized.filename)
      );
  }
  return false;
}

export function evaluateFastMergeDiffShape(files, categories) {
  const normalizedFiles = (Array.isArray(files) ? files : [])
    .map(normalizeChangedFile)
    .filter((file) => file.filename);
  const allowedCategories = Array.isArray(categories) ? categories.filter(Boolean) : [];
  if (normalizedFiles.length === 0) {
    return { ok: false, reason: 'changed-files-empty', files: normalizedFiles };
  }
  if (allowedCategories.length === 0) {
    return { ok: false, reason: 'fast-merge-category-missing', files: normalizedFiles };
  }
  const mismatches = normalizedFiles.filter((file) => (
    !allowedCategories.some((category) => fastMergeFileMatchesCategory(file, category))
  ));
  if (mismatches.length > 0) {
    return {
      ok: false,
      reason: `shape-mismatch:${mismatches.map((file) => file.filename).join(',')}`,
      files: normalizedFiles,
      mismatches,
    };
  }
  return { ok: true, reason: 'shape-ok', files: normalizedFiles };
}

export function buildFastMergeAuditEntry({
  action,
  repo,
  prNumber,
  categories = [],
  labels = [],
  changedFiles = [],
  shapeCheck = null,
  authorizedHeadSha = null,
  authorizedAt = new Date().toISOString(),
  skippedAt = null,
  vetoedAt = null,
  requeueResult = null,
}) {
  const sessionUuid = `fast-merge-${action}-${randomUUID()}`;
  const entry = {
    kind: 'fast-merge-audit',
    schemaVersion: 1,
    auditType: 'fast-merge-skip',
    sessionUuid,
    fast_merge: true,
    action,
    categories,
    repo,
    pr_number: prNumber,
    labels,
    changed_files: changedFiles,
    shape_check: shapeCheck,
    authorized_at: authorizedAt,
    skipped_at: skippedAt,
    vetoed_at: vetoedAt,
    fast_merge_authorized_head_sha: authorizedHeadSha,
    authorizing_head_sha: authorizedHeadSha,
    requeue_result: requeueResult,
  };
  return entry;
}

export function writeFastMergeAuditPayload(rootDir, entry) {
  const targetPath = fastMergeAuditPath(rootDir, {
    repo: entry?.repo,
    prNumber: entry?.pr_number,
    action: entry?.action,
    at: entry?.authorized_at,
  });
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileAtomic(targetPath, `${JSON.stringify(entry, null, 2)}\n`, { overwrite: false });
  return { entry, path: targetPath };
}

export function writeFastMergeAuditEntry(rootDir, args) {
  return writeFastMergeAuditPayload(rootDir, buildFastMergeAuditEntry(args));
}

// Live GitHub reads used by the fast-merge authorization path. These do network
// I/O through the conditional-request cache (labels, timeline) and the gh-cli
// head/state helper (head SHA). fetchFastMergeChangedFiles remains in watcher.mjs
// for now because it threads watcher-owned API throttle/telemetry state
// (withApiTelemetry); it moves once that telemetry seam is extracted.

export async function fetchLivePRLabels(octokit, { owner, repo, prNumber, logger = console } = {}) {
  try {
    if (typeof octokit?.rest?.issues?.listLabelsOnIssue !== 'function') {
      throw new Error('octokit.rest.issues.listLabelsOnIssue unavailable');
    }
    const params = {
      owner,
      repo,
      issue_number: prNumber,
      per_page: 100,
    };
    const { data } = await fetchConditionalRestPage({
      category: 'labels_list',
      endpoint: 'issues.labels',
      repo: `${owner}/${repo}`,
      prNumber,
      rootDir: ROOT,
      logger,
      params: { per_page: params.per_page },
      request: (requestParams) => octokit.rest.issues.listLabelsOnIssue({
        ...params,
        ...requestParams,
      }),
    });
    return Array.isArray(data) ? data : [];
  } catch (err) {
    logger.warn?.(
      `[watcher] fast-merge label fetch failed for ${owner}/${repo}#${prNumber}; using normal review path: ${err?.message || err}`
    );
    return null;
  }
}

export async function fetchLivePRHeadSha({ owner, repo, prNumber, fallbackHeadSha = null, logger = console } = {}) {
  try {
    const pr = await fetchPullRequestHeadAndState(`${owner}/${repo}`, prNumber, {
      execFileImpl: execFileAsync,
      withLabels: false,
    });
    return pr?.headRefOid ? String(pr.headRefOid) : fallbackHeadSha;
  } catch (err) {
    logger.warn?.(
      `[watcher] fast-merge head SHA fetch failed for ${owner}/${repo}#${prNumber}; using normal review path: ${err?.message || err}`
    );
    return null;
  }
}

export async function fetchFastMergeAuthorizationFromTimeline(
  octokit,
  { owner, repo, prNumber, allowedLabelNames = [], liveHeadSha = null, logger = console } = {},
) {
  try {
    if (typeof octokit?.rest?.issues?.listEventsForTimeline !== 'function') {
      throw new Error('octokit.rest.issues.listEventsForTimeline unavailable');
    }
    const params = {
      owner,
      repo,
      issue_number: prNumber,
      per_page: 100,
    };
    const events = [];
    let finalPageWasFull = false;
    for (let page = 1; page <= FAST_MERGE_TIMELINE_MAX_PAGES; page += 1) {
      const response = await fetchConditionalRestPage({
        category: 'timeline_events',
        endpoint: 'issues.timeline',
        repo: `${owner}/${repo}`,
        prNumber,
        rootDir: ROOT,
        logger,
        params: { page, per_page: params.per_page },
        request: (requestParams) => octokit.rest.issues.listEventsForTimeline({
          ...params,
          ...requestParams,
          page,
        }),
      });
      const pageEvents = Array.isArray(response?.data) ? response.data : [];
      events.push(...pageEvents);
      finalPageWasFull = pageEvents.length === params.per_page;
      if (pageEvents.length < params.per_page) break;
    }
    if (finalPageWasFull) {
      logger.warn?.(
        `[watcher] fast-merge timeline truncated for ${owner}/${repo}#${prNumber}; using normal review path`,
      );
      return null;
    }
    return latestTimelineFastMergeAuthorization(events, allowedLabelNames, { liveHeadSha });
  } catch (err) {
    logger.warn?.(
      `[watcher] fast-merge timeline fetch failed for ${owner}/${repo}#${prNumber}; using normal review path: ${err?.message || err}`
    );
    return null;
  }
}

// The changed-files read threads the watcher's API throttle/telemetry wrapper
// (recordApiCall + rate-limit observation) via the `withApiTelemetry` parameter,
// because that seam is still watcher-owned. The single caller (pollOnce) passes
// its module-level withApiTelemetry, preserving behavior exactly.
export async function fetchFastMergeChangedFiles(
  octokit,
  { owner, repo, prNumber, logger = console, withApiTelemetry } = {},
) {
  try {
    if (typeof octokit?.rest?.pulls?.listFiles !== 'function') {
      throw new Error('octokit.rest.pulls.listFiles unavailable');
    }
    const params = {
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    };
    const files = [];
    for (let page = 1; page <= FAST_MERGE_CHANGED_FILES_MAX_PAGES; page += 1) {
      const response = await withApiTelemetry('files_list', { repo: `${owner}/${repo}`, prNumber }, () => octokit.rest.pulls.listFiles({ ...params, page }));
      const pageFiles = Array.isArray(response?.data) ? response.data : [];
      files.push(...pageFiles);
      if (pageFiles.length < params.per_page) break;
    }
    return files;
  } catch (err) {
    logger.warn?.(
      `[watcher] fast-merge changed-file fetch failed for ${owner}/${repo}#${prNumber}; using normal review path: ${err?.message || err}`
    );
    return null;
  }
}
