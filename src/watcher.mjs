/**
 * LAC-11: PR Watcher
 * Polls GitHub every N minutes for new agent-built PRs and spawns reviewer agents.
 * Also tracks PR lifecycle (merged/closed) and syncs status to Linear automatically.
 */

import { Octokit } from '@octokit/rest';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { signalMalformedTitleFailure } from './watcher-fail-loud.mjs';
import { createGitHubPRSubjectAdapter, parseSubjectExternalId } from './adapters/subject/github-pr/index.mjs';
import {
  defaultReviewerRouteFromEnv,
  describeCrossModelReviewWaiver,
  routeSubject,
} from './adapters/subject/github-pr/routing.mjs';
import { createCompositeOperatorSurface } from './adapters/operator/index.mjs';
import {
  MERGE_AGENT_DISPATCHED_LABEL,
  MERGE_AGENT_REQUESTED_LABEL,
  OPERATOR_APPROVED_LABEL,
  legacyLabelEventFromControlResult,
} from './adapters/operator/github-pr-label-controls/index.mjs';
import {
  buildSafePollOnce,
  computeWorkloadAwarePollDeadlineMs,
  DEFAULT_POLL_DEADLINE_FLOOR_MS,
} from './watcher-poll-guard.mjs';
import { ensureReviewStateSchema, openReviewStateDb, requestReviewRereview } from './review-state.mjs';
import {
  beginReviewerPass,
  completeReviewerPass,
  readBestReviewerEvidenceTokenUsage,
} from './reviewer-pass-tokens.mjs';
import { isSqliteOrphanError } from './sqlite-orphan.mjs';
import {
  CASCADE_FAILURE_CAP,
  clearCascadeState,
  formatTransientFailureBreakdown,
  recordCascadeFailure,
  shouldBackoffReviewerSpawn,
} from './reviewer-cascade.mjs';
import {
  createReviewerRuntimeAdapterForDomain,
  recoverReviewerRunRecords,
} from './adapters/reviewer-runtime/index.mjs';
import { settleReviewerRunRecord } from './adapters/reviewer-runtime/run-state.mjs';
import {
  classifyReviewerFailure,
  isReviewerSubprocessTimeout,
} from './adapters/reviewer-runtime/cli-direct/classification.mjs';
import {
  resolveRoundBudgetForJob,
  summarizePRRemediationLedger,
} from './follow-up-jobs.mjs';
import {
  createBranchProtectionChecker,
  warnForMissingAdversarialGateBranchProtection,
} from './branch-protection.mjs';
import {
  addMergeAgentDispatchedLabel,
  buildMergeAgentDispatchJob,
  cancelMergeAgentDispatchOnMerge,
  clearMergeAgentLifecycleCleanup,
  dispatchMergeAgentForPR,
  fetchMergeAgentCandidate,
  listMergeAgentDispatches,
  listMergeAgentLifecycleCleanups,
  MERGE_AGENT_DISPATCHED_LABEL_ADD_TRANSITION,
  pollFastMergeQueue,
  resolveFastMergePerPollCap,
  scanStuckMergeAgentDispatches,
  updateMergeAgentLifecycleCleanup,
  upsertMergeAgentLifecycleCleanup,
} from './follow-up-merge-agent.mjs';
import { deliverAlert as defaultDeliverAlert } from './alert-delivery.mjs';
import {
  deleteGateRecordsForPR,
  projectAdversarialGateStatus,
} from './adversarial-gate-status.mjs';
import { fastMergeAuditDir, fastMergeAuditPath } from './fast-merge-audit-storage.mjs';
import { resolveGateStatusContext } from './adversarial-gate-context.mjs';
import {
  RETRIGGER_REMEDIATION_LABEL,
  retryPendingRetriggerAckComments,
  tryRetriggerRemediationFromLabel,
} from './follow-up-retrigger-label.mjs';
import {
  RETRIGGER_REVIEW_LABEL,
  retryPendingRetriggerReviewAckComments,
  tryRetriggerReviewFromLabel,
} from './follow-up-retrigger-review-label.mjs';
import { resolveReviewerTimeoutMs } from './reviewer-timeout.mjs';
import { reconcileReviewerSessions } from './reviewer-reattach.mjs';
import { shouldSkipReviewerForStaleDrift } from './stale-drift.mjs';
import { findLatestFollowUpJob } from './operator-retrigger-helpers.mjs';
import { createWatcherHealthProbe } from './health-probe.mjs';
import { writeFileAtomic } from './atomic-write.mjs';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const config = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'));
// Fail fast during watcher bootstrap; a bad gate-context override should not
// leave reviews running while commit-status publication silently stops later.
resolveGateStatusContext(process.env);
const reviewerRuntimeAdapter = createReviewerRuntimeAdapterForDomain({
  rootDir: ROOT,
  domainId: 'code-pr',
  logger: console,
});

// ── DB setup ────────────────────────────────────────────────────────────────

const db = openReviewStateDb(ROOT);
ensureReviewStateSchema(db);
const watcherHealthProbe = createWatcherHealthProbe();
const WATCHER_DRAIN_FILE = join(ROOT, 'data', 'watcher-drain.json');
const WATCHER_DRAIN_MAX_MS = 60 * 60 * 1000;
const DEFAULT_MERGE_AGENT_LIFECYCLE_CLEANUP_RETRY_MS = 60 * 1000;
const DEFAULT_MERGE_AGENT_LIFECYCLE_CLEANUP_PER_POLL = 5;

// Stuck-pre-spawn alert debounce. Once we've alerted on a particular
// (repo, PR, dispatchedAt) tuple, suppress the next alert for this
// many milliseconds. Operator confirmed 30-min stuck threshold; a
// 60-min debounce means at most ~1 alert per hour per stuck PR even
// if the watcher tick keeps observing it. State lives in a tiny
// sidecar JSON file alongside the merge-agent dispatch records.
const STUCK_DISPATCH_ALERT_DEBOUNCE_MS = 60 * 60 * 1000;
const STUCK_DISPATCH_ALERT_STATE_DIR = join(
  ROOT, 'data', 'follow-up-jobs', 'merge-agent-stuck-alerts',
);
const FAST_MERGE_VETO_LABEL = 'fast-merge-veto';
const FAST_MERGE_CATEGORY_BY_LABEL = Object.freeze({
  'fast-merge:spec-hash-rebind': 'spec-hash-rebind',
  'fast-merge:docs': 'docs',
  'fast-merge:test-fixtures': 'test-fixtures',
  'fast-merge:submodule-bump': 'submodule-bump',
});
const DEFAULT_FAST_MERGE_OPERATOR_ACTORS = Object.freeze(['VirtualPaul']);
const DEFAULT_FAST_MERGE_SUBMODULE_PATHS = Object.freeze([
  'tools/adversarial-review',
  'modules/agent-control/vendor/agent-control',
]);
const FAST_MERGE_RECOVERY_PER_TICK = Math.max(
  1,
  Number.parseInt(process.env.FML_WATCHER_RECOVERY_PER_TICK || '50', 10) || 50,
);
const FAST_MERGE_TIMELINE_MAX_PAGES = Math.max(
  1,
  Number.parseInt(process.env.FML_WATCHER_TIMELINE_MAX_PAGES || '3', 10) || 3,
);
const FAST_MERGE_CHANGED_FILES_MAX_PAGES = Math.max(
  1,
  Number.parseInt(process.env.FML_WATCHER_CHANGED_FILES_MAX_PAGES || '3', 10) || 3,
);

function isFastMergeSkipEnabled() {
  return process.env.FML_WATCHER_SKIP_ENABLED === 'true';
}

function normalizeLabelName(label) {
  return String(typeof label === 'string' ? label : label?.name || '').trim();
}

function fastMergeDecisionFromLabels(labels) {
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

async function fetchLivePRLabels(octokit, { owner, repo, prNumber, logger = console } = {}) {
  try {
    if (typeof octokit?.rest?.issues?.listLabelsOnIssue !== 'function') {
      throw new Error('octokit.rest.issues.listLabelsOnIssue unavailable');
    }
    const { data } = await octokit.rest.issues.listLabelsOnIssue({
      owner,
      repo,
      issue_number: prNumber,
      per_page: 100,
    });
    return Array.isArray(data) ? data : [];
  } catch (err) {
    logger.warn?.(
      `[watcher] fast-merge label fetch failed for ${owner}/${repo}#${prNumber}; using normal review path: ${err?.message || err}`
    );
    return null;
  }
}

async function fetchLivePRHeadSha(octokit, { owner, repo, prNumber, fallbackHeadSha = null, logger = console } = {}) {
  try {
    if (typeof octokit?.rest?.pulls?.get !== 'function') {
      throw new Error('octokit.rest.pulls.get unavailable');
    }
    const { data } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });
    return data?.head?.sha ? String(data.head.sha) : fallbackHeadSha;
  } catch (err) {
    logger.warn?.(
      `[watcher] fast-merge head SHA fetch failed for ${owner}/${repo}#${prNumber}; using normal review path: ${err?.message || err}`
    );
    return null;
  }
}

function parseFastMergeEventTime(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : null;
}

const FAST_MERGE_TIMELINE_HEAD_EVENT_NAMES = new Set([
  'committed',
  'head_ref_force_pushed',
  'head_ref_restored',
]);

function parseFastMergeList(value, fallback = []) {
  const raw = String(value || '').trim();
  const source = raw ? raw.split(',') : fallback;
  return new Set(
    source
      .map((item) => String(item || '').trim())
      .filter(Boolean)
  );
}

function fastMergeOperatorActorSet(env = process.env) {
  return parseFastMergeList(env.FML_WATCHER_OPERATOR_ACTORS, DEFAULT_FAST_MERGE_OPERATOR_ACTORS);
}

function fastMergeSubmodulePathSet(env = process.env) {
  return parseFastMergeList(env.FML_WATCHER_SUBMODULE_PATHS, DEFAULT_FAST_MERGE_SUBMODULE_PATHS);
}

function normalizeTimelineActor(actor) {
  return String(actor?.login || actor?.name || actor || '').trim();
}

function isFastMergeOperatorActor(actor, env = process.env) {
  const actorName = normalizeTimelineActor(actor);
  if (!actorName) return false;
  return fastMergeOperatorActorSet(env).has(actorName);
}

function fastMergeEventTimestamp(event) {
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

function latestTimelineFastMergeAuthorization(
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

async function fetchFastMergeAuthorizationFromTimeline(
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
    for (let page = 1; page <= FAST_MERGE_TIMELINE_MAX_PAGES; page += 1) {
      const response = await octokit.rest.issues.listEventsForTimeline({ ...params, page });
      const pageEvents = Array.isArray(response?.data) ? response.data : [];
      events.push(...pageEvents);
      if (pageEvents.length < params.per_page) break;
    }
    return latestTimelineFastMergeAuthorization(events, allowedLabelNames, { liveHeadSha });
  } catch (err) {
    logger.warn?.(
      `[watcher] fast-merge timeline fetch failed for ${owner}/${repo}#${prNumber}; using normal review path: ${err?.message || err}`
    );
    return null;
  }
}

async function fetchFastMergeChangedFiles(octokit, { owner, repo, prNumber, logger = console } = {}) {
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
      const response = await octokit.rest.pulls.listFiles({ ...params, page });
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

function normalizeChangedFile(file) {
  return {
    filename: String(file?.filename || file?.path || '').trim(),
    status: String(file?.status || '').trim().toLowerCase(),
    additions: Number.isFinite(Number(file?.additions)) ? Number(file.additions) : 0,
    deletions: Number.isFinite(Number(file?.deletions)) ? Number(file.deletions) : 0,
  };
}

function isMarkdownOrDocsPath(filename) {
  return /\.(adoc|md|mdx|rst|txt)$/i.test(filename);
}

function isTestFixturePath(filename) {
  return /(^|\/)(fixtures?|testdata|snapshots?)(\/|$)/i.test(filename);
}

function isKnownSubmodulePath(filename) {
  return fastMergeSubmodulePathSet().has(String(filename || '').trim());
}

function fastMergeFileMatchesCategory(file, category) {
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

function evaluateFastMergeDiffShape(files, categories) {
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

function buildFastMergeAuditEntry({
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

function writeFastMergeAuditPayload(rootDir, entry) {
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

function writeFastMergeAuditEntry(rootDir, args) {
  return writeFastMergeAuditPayload(rootDir, buildFastMergeAuditEntry(args));
}

async function maybeFireMergeAgentStuckAlert({
  rootDir,
  repoPath,
  prNumber,
  dispatched,
  deliverAlertFn,
  logger,
  now = Date.now(),
  alertStateDir = STUCK_DISPATCH_ALERT_STATE_DIR,
  debounceMs = STUCK_DISPATCH_ALERT_DEBOUNCE_MS,
  fsImpl = { readFileSync, mkdirSync, writeFileSync, existsSync },
}) {
  // The recorded dispatch object is on `dispatched` (via stuckDetail
  // surfacing in follow-up-merge-agent.mjs); fall back to a derivable
  // key when not present.
  const stuck = dispatched?.stuckDetail;
  if (!stuck) return false;
  // ROUND-2 review fix: stuckDetail now carries `launchRequestId`
  // directly (set by describeStaleDispatch from the validated `lrq`
  // local). The previous chain — `stuck?.lastRefusedAt && (dispatched.
  // recordedDispatch.launchRequestId || dispatched.launchRequestId)` —
  // collapsed to `null` because dispatchMergeAgentForPR's return shape
  // doesn't include either `recordedDispatch` or a top-level
  // `launchRequestId`. The alert payload then went out with
  // `launchRequestId: null` and the debounce key collapsed to
  // `repo-pr-no-lrq` — a single shared slot across every stuck
  // dispatch on the same PR. The fallback chain is retained for any
  // legacy caller that pre-dates the stuckDetail change.
  const lrq = (typeof stuck.launchRequestId === 'string' && stuck.launchRequestId)
    || dispatched?.recordedDispatch?.launchRequestId
    || dispatched?.launchRequestId
    || null;
  // Key the debounce file on a stable identifier — repo + PR + LRQ
  // if available, otherwise repo + PR + age bucket. Sanitize slashes.
  const safeRepo = String(repoPath).replace(/[^A-Za-z0-9._-]/g, '_');
  const dedupeKey = lrq
    ? `${safeRepo}-pr-${prNumber}-${lrq}.json`
    : `${safeRepo}-pr-${prNumber}-no-lrq.json`;
  const statePath = join(alertStateDir, dedupeKey);
  // Read prior alert state (if any) — fail closed on read errors
  // (alert fires; better to over-alert once than to silently swallow).
  let priorAlertAt = null;
  try {
    if (fsImpl.existsSync(statePath)) {
      const doc = JSON.parse(fsImpl.readFileSync(statePath, 'utf8'));
      const at = Date.parse(String(doc?.alertedAt || ''));
      if (Number.isFinite(at)) priorAlertAt = at;
    }
  } catch { /* fall through — over-alert is safer than under-alert */ }
  if (priorAlertAt && (now - priorAlertAt) < debounceMs) {
    return false;
  }
  // Fire the alert. Wrapped by caller try/catch; this layer formats.
  const text = (
    `Adversarial-watcher: merge-agent dispatch for ${repoPath}#${prNumber} `
    + `is stuck pre-spawn ${stuck.stuckForMinutes}min. `
    + `${stuck.refusalCount} admit refusals; primary reason: ${stuck.primaryReason || 'unknown'}. `
    + `Last refused at ${stuck.lastRefusedAt}. `
    + `Run \`scripts/hq-merge-agent-why.sh ${prNumber}\` for details.`
  );
  await deliverAlertFn(text, {
    event: 'merge_agent.stuck_pre_spawn',
    payload: {
      repo: repoPath,
      prNumber,
      launchRequestId: lrq,
      stuckForMinutes: stuck.stuckForMinutes,
      refusalCount: stuck.refusalCount,
      primaryReason: stuck.primaryReason,
      lastRefusedAt: stuck.lastRefusedAt,
    },
  });
  // Persist debounce state. Failure to persist isn't fatal — we may
  // alert again on the next tick which is at worst noisy.
  try {
    fsImpl.mkdirSync(alertStateDir, { recursive: true });
    fsImpl.writeFileSync(statePath, JSON.stringify({
      repo: repoPath,
      prNumber,
      launchRequestId: lrq,
      alertedAt: new Date(now).toISOString(),
      stuckForMinutes: stuck.stuckForMinutes,
    }, null, 2) + '\n');
  } catch (writeErr) {
    logger?.warn?.(
      `[watcher] failed to persist stuck-dispatch alert debounce state: ${writeErr?.message || writeErr}`
    );
  }
  return true;
}

// Fleet-wide false-deferral alert.
//
// Defense-in-depth against the 2026-05-18 bug class — see adversarial-
// review#129 + agent-os#669/#670. The merge-agent's prepareOriginalWorker
// guard returns `dispatch-deferred` with reason `original-worker-run-
// row-missing-but-worktree-present` when it can't find a worker_run row
// matching the worker's workspace.json LRQ. The intended use of that
// guard is to refuse dispatch on an orphaned worker dir; the unintended
// use is to silently mask a wrong-DB-path bug for hours because the
// query returns 0 rows from a stale snapshot. The 2026-05-18 stall took
// >6h to detect because each individual deferral looked benign.
//
// This alert watches for the SIGNATURE: many distinct LRQs hitting the
// same deferral reason in a short window. One stuck LRQ is fine; many
// distinct LRQs simultaneously deferring is the fleet-wide pattern.
//
// Threshold + window: 3 distinct LRQs in 30 min. Set conservatively —
// false positives cost operator attention, so prefer to miss a one-off
// vs page on routine teardown skew. The 2026-05-18 incident would have
// crossed this threshold within ~6 min (vs ~6h to detect manually).
const FLEET_WIDE_FALSE_DEFERRAL_REASON =
  'original-worker-run-row-missing-but-worktree-present';
const FLEET_WIDE_FALSE_DEFERRAL_WINDOW_MS = 30 * 60 * 1000;
const FLEET_WIDE_FALSE_DEFERRAL_DISTINCT_LRQ_THRESHOLD = 3;
const FLEET_WIDE_FALSE_DEFERRAL_ALERT_DEBOUNCE_MS = 60 * 60 * 1000;
const FLEET_WIDE_FALSE_DEFERRAL_STATE_DIR = join(
  ROOT, 'data', 'follow-up-jobs', 'fleet-wide-false-deferral-alerts',
);
const FLEET_WIDE_FALSE_DEFERRAL_STATE_FILE = 'fleet-state.json';
const FLEET_WIDE_FALSE_DEFERRAL_LOCK_FILE = 'fleet-state.lock';
const FLEET_WIDE_FALSE_DEFERRAL_DEGRADED_ALERT_DEBOUNCE_MS = 60 * 60 * 1000;
const FLEET_WIDE_FALSE_DEFERRAL_DEGRADED_STATE_FILE = 'degraded-alert-state.json';
const FLEET_WIDE_FALSE_DEFERRAL_DEGRADED_LOCK_FILE = 'degraded-alert-state.lock';
const FLEET_WIDE_FALSE_DEFERRAL_LOCK_RETRY_MS = 10;
const FLEET_WIDE_FALSE_DEFERRAL_LOCK_TIMEOUT_MS = 5_000;
const FLEET_WIDE_FALSE_DEFERRAL_STALE_LOCK_MS = 2 * 60 * 1000;

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readFleetWideFalseDeferralLock(lockPath) {
  let raw = '';
  try {
    raw = readFileSync(lockPath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      pid: parsed?.pid || null,
      acquiredAt: typeof parsed?.acquiredAt === 'string' ? parsed.acquiredAt : null,
    };
  } catch {
    try {
      const stat = statSync(lockPath);
      return { pid: null, acquiredAtMs: stat.mtimeMs };
    } catch {
      return { pid: null, acquiredAtMs: null };
    }
  }
}

function isFleetWideFalseDeferralLockStale(lockPath, nowMs, staleLockMs) {
  const lock = readFleetWideFalseDeferralLock(lockPath);
  const acquiredAtMs = Number.isFinite(lock.acquiredAtMs)
    ? lock.acquiredAtMs
    : Date.parse(lock.acquiredAt || '');
  return Number.isFinite(acquiredAtMs) && (nowMs - acquiredAtMs) >= staleLockMs;
}

async function acquireFleetWideFalseDeferralLock(lockPath, {
  retryMs = FLEET_WIDE_FALSE_DEFERRAL_LOCK_RETRY_MS,
  timeoutMs = FLEET_WIDE_FALSE_DEFERRAL_LOCK_TIMEOUT_MS,
  staleLockMs = FLEET_WIDE_FALSE_DEFERRAL_STALE_LOCK_MS,
  nowFn = Date.now,
} = {}) {
  const startedAt = nowFn();
  while (true) {
    try {
      writeFileSync(
        lockPath,
        JSON.stringify({ pid: process.pid, acquiredAt: new Date(nowFn()).toISOString() }) + '\n',
        { flag: 'wx' },
      );
      return;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      const nowMs = nowFn();
      if (isFleetWideFalseDeferralLockStale(lockPath, nowMs, staleLockMs)) {
        rmSync(lockPath, { force: true });
        continue;
      }
      if ((nowMs - startedAt) >= timeoutMs) {
        throw new Error(`Timed out waiting for fleet-wide false-deferral lock: ${lockPath}`);
      }
      await sleepMs(retryMs);
    }
  }
}

async function withFleetWideFalseDeferralLock(
  alertStateDir,
  callback,
  { lockFile = FLEET_WIDE_FALSE_DEFERRAL_LOCK_FILE } = {},
) {
  mkdirSync(alertStateDir, { recursive: true });
  const lockPath = join(alertStateDir, lockFile);
  await acquireFleetWideFalseDeferralLock(lockPath);
  try {
    return await callback();
  } finally {
    rmSync(lockPath, { force: true });
  }
}

function readFleetWideFalseDeferralDegradedState({
  degradedStatePath,
  fsImpl,
}) {
  if (!fsImpl.existsSync(degradedStatePath)) return {};
  const doc = JSON.parse(fsImpl.readFileSync(degradedStatePath, 'utf8'));
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return {};
  return doc;
}

function buildFleetWideFalseDeferralDetectorDegradedText({
  operation,
  statePath,
  repoPath,
  prNumber,
  lrq,
  errorMessage,
}) {
  return [
    'Adversarial-watcher: merge_agent.fleet_wide_false_deferral_detector_degraded',
    `Operation: ${operation}`,
    `State file: ${statePath}`,
    `Repo/PR: ${repoPath}#${prNumber}`,
    `LRQ: ${lrq}`,
    `Error: ${errorMessage}`,
    'The detector depends on durable cross-observation state and is failing closed until this state path is valid and writable again.',
  ].join('\n');
}

async function reportFleetWideFalseDeferralDetectorDegraded({
  deliverAlertFn,
  logger,
  operation,
  statePath,
  repoPath,
  prNumber,
  lrq,
  err,
  now = Date.now(),
  degradedAlertDebounceMs = FLEET_WIDE_FALSE_DEFERRAL_DEGRADED_ALERT_DEBOUNCE_MS,
  fsImpl = { readFileSync, existsSync },
  writeDegradedStateFileFn = (filePath, content) => writeFileAtomic(filePath, content),
}) {
  const errorMessage = err?.message || String(err);
  const alertStateDir = dirname(statePath);
  const degradedStatePath = join(alertStateDir, FLEET_WIDE_FALSE_DEFERRAL_DEGRADED_STATE_FILE);

  let shouldDeliver = false;
  try {
    shouldDeliver = await withFleetWideFalseDeferralLock(alertStateDir, async () => {
      const degradedState = readFleetWideFalseDeferralDegradedState({ degradedStatePath, fsImpl });
      const lastAlertedMs = Date.parse(degradedState[statePath] || '');
      if (Number.isFinite(lastAlertedMs) && (now - lastAlertedMs) < degradedAlertDebounceMs) {
        return false;
      }
      degradedState[statePath] = new Date(now).toISOString();
      writeDegradedStateFileFn(degradedStatePath, JSON.stringify(degradedState, null, 2) + '\n');
      return true;
    }, { lockFile: FLEET_WIDE_FALSE_DEFERRAL_DEGRADED_LOCK_FILE });
  } catch (stateErr) {
    logger?.error?.(
      `[watcher] fleet-wide false-deferral degraded alert debounce persistence failed: ${stateErr?.message || stateErr}`
    );
    shouldDeliver = true;
  }
  if (!shouldDeliver) return;

  try {
    await deliverAlertFn(
      buildFleetWideFalseDeferralDetectorDegradedText({
        operation,
        statePath,
        repoPath,
        prNumber,
        lrq,
        errorMessage,
      }),
      {
        event: 'merge_agent.fleet_wide_false_deferral_detector_degraded',
        payload: {
          operation,
          statePath,
          repoPath,
          prNumber,
          launchRequestId: lrq,
          error: errorMessage,
        },
      }
    );
  } catch (alertErr) {
    logger?.error?.(
      `[watcher] fleet-wide false-deferral degraded alert delivery failed: ${alertErr?.message || alertErr}`
    );
  }
}

async function failClosedFleetWideFalseDeferralDetector({
  deliverAlertFn,
  logger,
  operation,
  statePath,
  repoPath,
  prNumber,
  lrq,
  err,
  now,
  degradedAlertDebounceMs,
}) {
  await reportFleetWideFalseDeferralDetectorDegraded({
    deliverAlertFn,
    logger,
    operation,
    statePath,
    repoPath,
    prNumber,
    lrq,
    err,
    now,
    degradedAlertDebounceMs,
  });
  const failure = new Error(
    `[watcher] fleet-wide false-deferral detector state ${operation} failed at ${statePath}: ${err?.message || err}`
  );
  failure.cause = err;
  throw failure;
}

async function maybeFireFleetWideFalseDeferralAlert({
  dispatched,
  repoPath,
  prNumber,
  deliverAlertFn,
  logger,
  now = Date.now(),
  alertStateDir = FLEET_WIDE_FALSE_DEFERRAL_STATE_DIR,
  windowMs = FLEET_WIDE_FALSE_DEFERRAL_WINDOW_MS,
  threshold = FLEET_WIDE_FALSE_DEFERRAL_DISTINCT_LRQ_THRESHOLD,
  debounceMs = FLEET_WIDE_FALSE_DEFERRAL_ALERT_DEBOUNCE_MS,
  degradedAlertDebounceMs = FLEET_WIDE_FALSE_DEFERRAL_DEGRADED_ALERT_DEBOUNCE_MS,
  fsImpl = { readFileSync, existsSync },
  writeStateFileFn = (filePath, content) => writeFileAtomic(filePath, content),
}) {
  if (dispatched?.decision !== 'dispatch-deferred') return false;
  if (dispatched?.reason !== FLEET_WIDE_FALSE_DEFERRAL_REASON) return false;
  const lrq = dispatched?.launchRequestId || null;
  if (!lrq) return false;

  const statePath = join(alertStateDir, FLEET_WIDE_FALSE_DEFERRAL_STATE_FILE);
  let alertToDeliver = null;
  try {
    alertToDeliver = await withFleetWideFalseDeferralLock(alertStateDir, async () => {
      let state = { observations: [], lastAlertedAt: null };
      try {
        if (fsImpl.existsSync(statePath)) {
          const doc = JSON.parse(fsImpl.readFileSync(statePath, 'utf8'));
          if (Array.isArray(doc?.observations)) state.observations = doc.observations;
          if (typeof doc?.lastAlertedAt === 'string') state.lastAlertedAt = doc.lastAlertedAt;
        }
      } catch (readErr) {
        await failClosedFleetWideFalseDeferralDetector({
          deliverAlertFn,
          logger,
          operation: 'read',
          statePath,
          repoPath,
          prNumber,
          lrq,
          err: readErr,
          now,
          degradedAlertDebounceMs,
        });
      }

      // Serialize the entire read-modify-write cycle so concurrent
      // watcher variants cannot overwrite each other's observations.
      const cutoff = now - windowMs;
      const byLrq = new Map();
      for (const obs of state.observations) {
        const observedAtMs = Date.parse(obs?.observedAt || '');
        if (!Number.isFinite(observedAtMs) || observedAtMs < cutoff) continue;
        if (typeof obs?.lrq !== 'string' || !obs.lrq) continue;
        byLrq.set(obs.lrq, {
          lrq: obs.lrq,
          observedAt: obs.observedAt,
          repo: typeof obs?.repo === 'string' ? obs.repo : null,
          prNumber: Number.isFinite(obs?.prNumber) ? obs.prNumber : null,
        });
      }
      byLrq.set(lrq, {
        lrq,
        observedAt: new Date(now).toISOString(),
        repo: repoPath,
        prNumber,
      });
      state.observations = Array.from(byLrq.values());

      try {
        writeStateFileFn(statePath, JSON.stringify(state, null, 2) + '\n');
      } catch (writeErr) {
        await failClosedFleetWideFalseDeferralDetector({
          deliverAlertFn,
          logger,
          operation: 'write-observations',
          statePath,
          repoPath,
          prNumber,
          lrq,
          err: writeErr,
          now,
          degradedAlertDebounceMs,
        });
      }

      if (state.observations.length < threshold) return null;

      const lastAlertedMs = Date.parse(state.lastAlertedAt || '');
      if (Number.isFinite(lastAlertedMs) && (now - lastAlertedMs) < debounceMs) {
        return null;
      }

      const observedTargets = [...new Set(state.observations
        .filter((o) => o.repo && Number.isFinite(o.prNumber))
        .map((o) => `${o.repo}#${o.prNumber}`))];
      const windowMinutes = Math.round(windowMs / 60_000);
      const text = (
        `Adversarial-watcher: ${state.observations.length} distinct LRQs hit `
        + `the '${FLEET_WIDE_FALSE_DEFERRAL_REASON}' merge-agent guard in the `
        + `last ${windowMinutes}min across ${observedTargets.length} PR(s): `
        + `${observedTargets.slice(0, 5).join(', ')}`
        + `${observedTargets.length > 5 ? ` (+${observedTargets.length - 5} more)` : ''}. `
        + `This is the signature of a session-ledger DB resolution bug — see `
        + `adversarial-review#129 + agent-os#669/#670 (2026-05-18 incident). `
        + `Check that consumers are reading the deploy-checkout DB, not the `
        + `managed-service-root DB.`
      );
      const structuredAlert = {
        event: 'merge_agent.fleet_wide_false_deferral',
        payload: {
          reason: FLEET_WIDE_FALSE_DEFERRAL_REASON,
          distinctLrqCount: state.observations.length,
          threshold,
          windowMinutes,
          observedTargets,
          observations: state.observations,
        },
      };

      state.lastAlertedAt = new Date(now).toISOString();
      try {
        writeStateFileFn(statePath, JSON.stringify(state, null, 2) + '\n');
      } catch (writeErr) {
        await failClosedFleetWideFalseDeferralDetector({
          deliverAlertFn,
          logger,
          operation: 'write-lastAlertedAt',
          statePath,
          repoPath,
          prNumber,
          lrq,
          err: writeErr,
          now,
          degradedAlertDebounceMs,
        });
      }
      return { text, structuredAlert };
    });
  } catch (lockErr) {
    if (typeof lockErr?.message === 'string'
      && lockErr.message.startsWith('[watcher] fleet-wide false-deferral detector state ')) {
      throw lockErr;
    }
    await failClosedFleetWideFalseDeferralDetector({
      deliverAlertFn,
      logger,
      operation: 'lock',
      statePath,
      repoPath,
      prNumber,
      lrq,
      err: lockErr,
      now,
      degradedAlertDebounceMs,
    });
  }
  if (!alertToDeliver) return false;
  await deliverAlertFn(alertToDeliver.text, alertToDeliver.structuredAlert);
  return true;
}

function readWatcherDrainState({
  drainFile = WATCHER_DRAIN_FILE,
  now = new Date(),
} = {}) {
  let raw;
  let markerMtimeMs;
  try {
    raw = readFileSync(drainFile, 'utf8');
    markerMtimeMs = statSync(drainFile).mtimeMs;
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return { active: false };
    }
    return {
      active: true,
      reason: `unreadable drain marker at ${drainFile}: ${err?.message || err}`,
    };
  }

  const nowMs = now.getTime();
  const maxExpiresAt = markerMtimeMs + WATCHER_DRAIN_MAX_MS;
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    if (nowMs >= maxExpiresAt) {
      return { active: false, expired: true };
    }
    return {
      active: true,
      reason: `invalid drain marker at ${drainFile}: ${err?.message || err}`,
    };
  }

  const parsedExpiresAt = payload?.expiresAt ? Date.parse(payload.expiresAt) : NaN;
  const hasValidExpiresAt = Number.isFinite(parsedExpiresAt);
  const effectiveExpiresAt = hasValidExpiresAt
    ? Math.min(parsedExpiresAt, maxExpiresAt)
    : maxExpiresAt;
  if (nowMs >= effectiveExpiresAt) {
    return { active: false, expired: true };
  }

  return {
    active: true,
    reason: hasValidExpiresAt
      ? String(payload?.reason || 'watcher drain active')
      : `drain marker missing/invalid expiresAt at ${drainFile}`,
    requestedBy: payload?.requestedBy ? String(payload.requestedBy) : null,
    expiresAt: hasValidExpiresAt ? String(payload.expiresAt) : null,
  };
}

// ── Inode-orphan recovery ───────────────────────────────────────────────────
//
// SQLite returns SQLITE_READONLY_DBMOVED when the file behind a long-
// open database connection has been replaced on disk (the inode the
// connection holds no longer matches the path). better-sqlite3 surfaces
// it as `err.code === 'SQLITE_READONLY_DBMOVED'`. This is a real bite
// in operations because the watcher opens the DB once at module load
// time and reuses it for the process's lifetime — anything that
// replaces `data/reviews.db` (git checkout that touches the file, an
// adversarial-review submodule reset, a `restore.sh` run, a backup
// rollback) leaves the watcher writing to the orphaned inode forever.
// The classic scar from PR #18: a 6-hour readonly-loop window where
// every poll's writes silently failed and the reviews-ledger lost
// dozens of rows.
//
// All prepared statements are bound to the connection above, so we
// can't fix an orphaned handle in place. The cleanest recovery is to
// exit cleanly and let launchd's KeepAlive respawn us with a fresh
// connection. ThrottleInterval=30 in the plist caps the respawn rate.
//
// We use exit code 75 (BSD `EX_TEMPFAIL`) for documentation only;
// KeepAlive=true respawns regardless of exit code.
const SQLITE_ORPHAN_EXIT_CODE = 75;

// Distinct exit code for poll-watchdog-tripped restarts so the launchd
// log shows whether respawns are caused by SQLite orphan recovery (75)
// or a hung poll deadline (86). KeepAlive=true respawns either way.
const POLL_DEADLINE_EXIT_CODE = 86;

function exitForSqliteOrphan(err, contextLabel) {
  console.error(
    `[watcher] FATAL: SQLite database file was replaced on disk while we held it open ` +
    `(SQLITE_READONLY_DBMOVED in ${contextLabel}); exiting so launchd KeepAlive can respawn ` +
    `us with a fresh handle. Original error: ${err?.message || err}`
  );
  // Allow the log line to flush before exit.
  process.exitCode = SQLITE_ORPHAN_EXIT_CODE;
  // setImmediate → next tick gives stdout/stderr a chance to flush
  // before the process disappears. process.exit immediately would
  // sometimes truncate the message.
  setImmediate(() => process.exit(SQLITE_ORPHAN_EXIT_CODE));
}

// LAC-545: head+tail preview for diagnostic log lines. For short payloads
// (under 800 chars) emit verbatim; for longer ones, the first 400 +
// `…<truncated N chars>…` + last 400. Newlines are collapsed to a single
// space so the line stays grep-able. The intent is to surface enough of
// codex's actual output to a) classify the failure mode and b) feed the
// sanitizer's rejection signature back into a real fix.
function previewLogText(text, { head = 400, tail = 400 } = {}) {
  const normalized = String(text ?? '').replace(/\r?\n+/g, ' ').trim();
  if (!normalized) return '<empty>';
  if (normalized.length <= head + tail) return normalized;
  const elided = normalized.length - head - tail;
  return `${normalized.slice(0, head)} …<truncated ${elided} chars>… ${normalized.slice(-tail)}`;
}

function handlePollError(err, source = 'pollOnce') {
  if (isSqliteOrphanError(err)) {
    exitForSqliteOrphan(err, source);
    return;
  }
  console.error(`[watcher] Poll error (source=${source}):`, err);
}

// Track durable reviewer runtime session UUIDs so every exit path can
// ask the runtime adapter to cancel any in-flight reviewer before this
// watcher process dies. Startup reattach/reconcile is the second half
// of the same guard for the residual race where the child outlives the
// watcher long enough to post anyway.
const inFlightReviewerSessions = new Set();
let exitInProgress = false;

async function cancelInFlightReviewerRuntimeSessions(reason) {
  const sessions = Array.from(inFlightReviewerSessions);
  inFlightReviewerSessions.clear();
  await Promise.all(sessions.map(async (sessionUuid) => {
    try {
      await reviewerRuntimeAdapter.cancel(sessionUuid);
    } catch (err) {
      console.error(
        `[watcher] reviewer_runtime_cancel_failed session=${sessionUuid} reason=${reason}:`,
        err?.message || err
      );
    }
  }));
}

function exitAfterReviewerCleanup({
  code,
  reason,
  source,
  message,
  err = null,
  // When the bounce comes from a planned deploy (main-catchup writes
  // `watcher-drain.json` BEFORE sending SIGTERM via `launchctl bootout`),
  // the reviewer subprocesses are bounce-survivable per
  // `projects/daemon-bounce-safety/SPEC.md` — they're in their own pgrps
  // and the next watcher's `reconcileReviewerSessions` will reattach
  // them via the `reviewer_reattach_alive` path. Killing them on bounce
  // throws away minutes of in-flight review work and was the reason
  // main-catchup's drain wait blocked on every long-running review.
  // Other exit paths (uncaughtException, poll deadline, SIGINT,
  // SqliteError) still cancel — those are abnormal-exit signals where
  // leaving zombie reviewers would compound the problem.
  preserveInFlightReviewers = false,
} = {}) {
  if (exitInProgress) return;
  exitInProgress = true;
  const detail = err ? `: ${err?.stack || err?.message || err}` : '';
  console.error(`[watcher] ${message}${source ? ` (source=${source})` : ''}${detail}`);
  process.exitCode = code;
  if (preserveInFlightReviewers) {
    const preserved = inFlightReviewerSessions.size;
    inFlightReviewerSessions.clear();
    console.error(
      `[watcher] reviewer_runtime_preserved_on_drain count=${preserved} reason=${reason} ` +
      `— next watcher will reattach via reconcileReviewerSessions`
    );
    setImmediate(() => process.exit(code));
    return;
  }
  const forceExitTimer = setTimeout(() => {
    process.exit(code);
  }, 5_000);
  forceExitTimer.unref?.();
  cancelInFlightReviewerRuntimeSessions(reason)
    .catch((cleanupErr) => {
      console.error('[watcher] reviewer runtime cancellation failed during exit:', cleanupErr);
    })
    .finally(() => {
      clearTimeout(forceExitTimer);
      setImmediate(() => process.exit(code));
    });
}

function exitForPollDeadline(err, source) {
  exitAfterReviewerCleanup({
    code: POLL_DEADLINE_EXIT_CODE,
    reason: 'poll deadline exceeded',
    source,
    err,
    message:
      'FATAL: poll deadline exceeded. Cancelling in-flight reviewer runtime sessions before exit so launchd can respawn a clean watcher',
  });
}

// Belt-and-suspenders: in case a synchronous SqliteError escapes a
// catch (e.g. from an unawaited promise chain or a setInterval handler
// that re-throws synchronously), catch it at the process level and
// route through the same recovery.
process.on('uncaughtException', (err) => {
  if (isSqliteOrphanError(err)) {
    exitForSqliteOrphan(err, 'uncaughtException');
    return;
  }
  exitAfterReviewerCleanup({
    code: 1,
    reason: 'uncaughtException',
    source: 'uncaughtException',
    err,
    message: 'uncaughtException; cancelling in-flight reviewer runtime sessions before exit',
  });
});
process.on('unhandledRejection', (err) => {
  if (isSqliteOrphanError(err)) {
    exitForSqliteOrphan(err, 'unhandledRejection');
    return;
  }
  exitAfterReviewerCleanup({
    code: 1,
    reason: 'unhandledRejection',
    source: 'unhandledRejection',
    err,
    message: 'unhandledRejection; cancelling in-flight reviewer runtime sessions before exit',
  });
});

// Decision: does a SIGTERM during drain preserve in-flight reviewers?
// Pulled out as a pure function so tests can exercise the rule without
// having to fork the watcher process and capture process.exit. The rule:
// SIGTERM + active drain marker → preserve (planned bounce path);
// SIGTERM without drain marker → cancel (operator stop / launchd hard stop).
//
// See `projects/daemon-bounce-safety/SPEC.md` §6a for the contract.
function shouldPreserveReviewersOnSigterm(drainState) {
  return Boolean(drainState?.active);
}

process.on('SIGTERM', () => {
  // SIGTERM with an active drain marker is the planned-bounce path
  // (main-catchup writes `watcher-drain.json` BEFORE bouncing this
  // launchd service). Preserve in-flight reviewer subprocesses so the
  // next watcher reattaches them via `reconcileReviewerSessions`
  // (the `reviewer_reattach_alive` branch in src/reviewer-reattach.mjs).
  // Without this, every routine deploy would kill in-flight reviews,
  // which is exactly what made main-catchup's drain wait load-bearing
  // for the bounce-survival contract.
  const drainState = readWatcherDrainState();
  const preserveInFlightReviewers = shouldPreserveReviewersOnSigterm(drainState);
  const message = preserveInFlightReviewers
    ? `SIGTERM received during active drain (reason=${drainState?.reason || 'unknown'}); preserving in-flight reviewer subprocesses for the next watcher to reattach`
    : 'SIGTERM received; cancelling active reviewer runtime sessions before exit';
  exitAfterReviewerCleanup({
    code: 143,
    reason: preserveInFlightReviewers ? 'SIGTERM-during-drain' : 'SIGTERM',
    source: 'SIGTERM',
    message,
    preserveInFlightReviewers,
  });
});

process.on('SIGINT', () => {
  exitAfterReviewerCleanup({
    code: 130,
    reason: 'SIGINT',
    source: 'SIGINT',
    message: 'SIGINT received; cancelling active reviewer runtime sessions before exit',
  });
});

const stmtGetReviewRow = db.prepare(
  'SELECT * FROM reviewed_prs WHERE repo = ? AND pr_number = ?'
);
const stmtCreateReviewRow = db.prepare(
  'INSERT OR IGNORE INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, pr_state, linear_ticket, review_status, review_attempts, labels_json) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)'
);
const stmtCreateFastMergeSkippedReviewRow = db.prepare(
  "INSERT OR IGNORE INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, pr_state, linear_ticket, review_status, review_attempts, labels_json, fast_merge_authorized_head_sha, fast_merge_audit_status, fast_merge_audit_payload_json, fast_merge_audit_error) VALUES (?, ?, ?, ?, 'fast_merge_skipped', ?, 'fast_merge_skipped', 0, ?, ?, ?, ?, ?)"
);
const stmtUpdateReviewRouting = db.prepare(
  'UPDATE reviewed_prs SET reviewer = ?, linear_ticket = COALESCE(?, linear_ticket) WHERE repo = ? AND pr_number = ?'
);
const stmtUpdateReviewLabels = db.prepare(
  'UPDATE reviewed_prs SET labels_json = ? WHERE repo = ? AND pr_number = ?'
);
const stmtGetFastMergeSkippedPRs = db.prepare(
  "SELECT * FROM reviewed_prs WHERE pr_state = 'fast_merge_skipped' ORDER BY reviewed_at ASC, id ASC LIMIT ?"
);
const stmtGetPendingFastMergeAudits = db.prepare(
  "SELECT * FROM reviewed_prs WHERE fast_merge_audit_status = 'pending' AND fast_merge_audit_payload_json IS NOT NULL ORDER BY reviewed_at ASC, id ASC LIMIT ?"
);
const stmtMarkFastMergeAuditPending = db.prepare(
  "UPDATE reviewed_prs SET fast_merge_audit_status = 'pending', fast_merge_audit_payload_json = ?, fast_merge_audit_error = NULL WHERE repo = ? AND pr_number = ?"
);
const stmtMarkFastMergeAuditWritten = db.prepare(
  "UPDATE reviewed_prs SET fast_merge_audit_status = 'written', fast_merge_audit_error = NULL WHERE repo = ? AND pr_number = ?"
);
const stmtMarkFastMergeAuditError = db.prepare(
  "UPDATE reviewed_prs SET fast_merge_audit_status = 'pending', fast_merge_audit_error = ? WHERE repo = ? AND pr_number = ?"
);
const stmtMarkMalformed = db.prepare(
  "UPDATE reviewed_prs SET reviewer = 'malformed-title', review_status = 'malformed', failure_message = ?, failed_at = ?, last_attempted_at = ?, review_attempts = review_attempts + 1 WHERE repo = ? AND pr_number = ?"
);
// 'reviewing' is the durable in-progress claim: set BEFORE spawning
// the reviewer subprocess, replaced with 'posted' / 'failed' once the
// spawn resolves. If the watcher exits between these two updates
// (watchdog timeout, OOM kill, launchd restart), the row stays in
// 'reviewing' on disk — that is the operator-visible signal that a
// review subprocess was in flight when the parent died and may have
// posted a review the parent never recorded. On startup, the durable
// reviewer handle below lets reconcileReviewerSessions reattach to a
// still-live reviewer or recover a posted GitHub review before falling
// back to sticky operator action for legacy/anomalous rows.
// Compare-and-swap claim: only flip `pending` / `failed` rows to
// `'reviewing'`. The unconditional UPDATE the previous version of this
// statement performed was safe under the in-process pollOnce
// serialization in this module, but did NOT close the cross-process
// race: if a second watcher instance (operator dev-mode launch racing
// launchd's KeepAlive, accidental double-launch, etc.) reads the same
// `pending` row, both would have called the unconditional UPDATE and
// both would have spawned a reviewer subprocess, producing duplicate
// GitHub reviews. The atomic CAS below is the second of two layers
// (in-process self-scheduled poll loop + cross-process SQL CAS) that
// together close the duplicate-spawn vector at both layers.
//
// Match conditions:
//   - `review_status = 'pending'` — happy-path claim.
//   - `review_status = 'failed'` — automatic-retry path; the pre-CAS
//     code treated `failed` as eligible for retry on the next poll,
//     and we preserve that contract here.
//   - `review_status = 'pending-upstream'` — upstream-cascade backoff
//     path. pollOnce gates this state on file-backed nextRetryAfter,
//     and once that window expires the row may be reclaimed for
//     another attempt without burning review_attempts.
//
// Terminal statuses (`posted`, `malformed`) and the durable in-flight
// states (`reviewing`, `failed-orphan`) are NOT reclaimable by this
// CAS. `failed-orphan` recovery is operator-driven via
// `npm run retrigger-review --allow-failed-reset` after verifying the
// GitHub side; that path resets the row to `pending` and the CAS
// then matches it on the next poll.
//
// Callers must check `result.changes === 1` before proceeding with
// the spawn. A 0-changes result means another watcher (or a parallel
// claim path) won the row, or the row's status moved to a state this
// CAS does not match — log and skip.
const stmtMarkAttemptStarted = db.prepare(
  `UPDATE reviewed_prs
     SET review_status = 'reviewing',
         last_attempted_at = ?,
         reviewer_session_uuid = ?,
         reviewer_started_at = NULL,
         reviewer_head_sha = ?,
         reviewer_timeout_ms = ?,
         reviewer_pgid = NULL,
         failed_at = CASE
           WHEN review_status = 'pending-upstream' THEN failed_at
           ELSE NULL
         END,
         failure_message = CASE
           WHEN review_status = 'pending-upstream' THEN failure_message
           ELSE NULL
         END
   WHERE repo = ?
     AND pr_number = ?
     AND review_status IN ('pending', 'failed', 'pending-upstream')`
);
const stmtMarkReviewerPgid = db.prepare(
  `UPDATE reviewed_prs
      SET reviewer_pgid = ?,
          reviewer_started_at = ?
    WHERE reviewer_session_uuid = ?
      AND repo = ?
      AND pr_number = ?
      AND review_status = 'reviewing'`
);
const stmtMarkPosted = db.prepare(
  "UPDATE reviewed_prs SET review_status = 'posted', posted_at = ?, failed_at = NULL, failure_message = NULL, review_attempts = review_attempts + 1 WHERE repo = ? AND pr_number = ?"
);
const stmtMarkFailed = db.prepare(
  "UPDATE reviewed_prs SET review_status = 'failed', failed_at = ?, failure_message = ?, review_attempts = review_attempts + 1 WHERE repo = ? AND pr_number = ?"
);
const stmtMarkCascadeFailed = db.prepare(
  "UPDATE reviewed_prs SET review_status = 'failed', failed_at = ?, failure_message = ? WHERE repo = ? AND pr_number = ?"
);
const stmtMarkPendingUpstream = db.prepare(
  "UPDATE reviewed_prs SET review_status = 'pending-upstream', failed_at = ?, failure_message = ? WHERE repo = ? AND pr_number = ?"
);
const stmtGetOpenPRs = db.prepare(
  "SELECT repo, pr_number, linear_ticket, labels_json FROM reviewed_prs WHERE pr_state = 'open'"
);
const stmtMarkMerged = db.prepare(
  "UPDATE reviewed_prs SET pr_state = 'merged', merged_at = ? WHERE repo = ? AND pr_number = ?"
);
const stmtMarkClosed = db.prepare(
  "UPDATE reviewed_prs SET pr_state = 'closed', closed_at = ? WHERE repo = ? AND pr_number = ?"
);

// ── Reviewer session reconciliation (startup) ────────────────────────────────
//
// On startup, find any rows still in 'reviewing' from a previous
// watcher run that exited (watchdog timeout, crash, OOM, launchd
// restart) before transitioning them to 'posted' or 'failed'. Those
// rows mean a reviewer subprocess was in flight when the parent died
// — and may have posted a review to GitHub the parent never recorded.
//
// Rows created before reviewer handles existed still fall through to
// sticky failed-orphan so pollOnce skips them and the operator gets a
// clear, durable record. Rows with handles are probed first: a live,
// current reviewer remains 'reviewing', a dead reviewer with a posted
// GitHub review is recovered to 'posted', and dead/stale sessions move
// to retryable 'failed'.
//
//   1. Inspect the GitHub PR to see whether a review was already posted.
//   2. If yes: leave the row alone (it's effectively done) — or use
//      the operator tooling to mark it posted; either way the row
//      stops blocking.
//   3. If no: run `npm run retrigger-review --repo <slug> --pr <n>
//      --reason "verified no orphan review present"` to clear the
//      sticky state and re-arm review_status='pending'.
//
// This remains the durable half of the duplicate-review guard; the
// cross-process claim CAS below is still the only place new reviewer
// subprocesses are admitted.
async function reconcileOrphanedReviewing(octokit) {
  return reconcileReviewerSessions({
    db,
    octokit,
    onTerminalDeadSession: ({ row, state, settledAt }) => settleDurableReviewerRunState({
      sessionUuid: row?.reviewer_session_uuid,
      state,
      settledAt,
    }),
  });
}

function shouldReconcileStaleReviewerSession(row, now, {
  reviewerTimeoutMs = resolveReviewerTimeoutMs(),
} = {}) {
  const persistedTimeoutMs = Number(row?.reviewer_timeout_ms);
  const effectiveTimeoutMs = Number.isInteger(persistedTimeoutMs) && persistedTimeoutMs > 0
    ? persistedTimeoutMs
    : reviewerTimeoutMs;
  const startedAtMs = Date.parse(row?.reviewer_started_at || '');
  if (!Number.isFinite(startedAtMs)) {
    const claimedAtMs = Date.parse(row?.last_attempted_at || '');
    if (Number.isFinite(claimedAtMs)) {
      return (claimedAtMs + effectiveTimeoutMs) <= now.getTime();
    }
    return true;
  }
  return (startedAtMs + effectiveTimeoutMs) <= now.getTime();
}

function settleDurableReviewerRunState({
  rootDir = ROOT,
  sessionUuid,
  state,
  settledAt = new Date().toISOString(),
  log = console,
} = {}) {
  if (!sessionUuid || !state) return null;
  try {
    return settleReviewerRunRecord(rootDir, sessionUuid, { state, settledAt });
  } catch (err) {
    log.warn?.(
      `[watcher] reviewer_run_state_settle_failed session=${sessionUuid} state=${state} ` +
      `error=${err?.message || err}`
    );
    return null;
  }
}

function persistReviewerPgid({
  pgid,
  reviewerSessionUuid,
  repoPath,
  prNumber,
  startedAt = new Date().toISOString(),
  log = console,
}) {
  try {
    const result = stmtMarkReviewerPgid.run(
      pgid,
      startedAt,
      reviewerSessionUuid,
      repoPath,
      prNumber
    );
    if (result.changes === 0) {
      log.warn?.(
        `[watcher] reviewer_session_handle_cas_miss repo=${repoPath} pr=${prNumber} ` +
        `session=${reviewerSessionUuid} pgid=${pgid}`
      );
      return false;
    }
    log.log?.(
      `[watcher] reviewer_session_handle_persisted repo=${repoPath} pr=${prNumber} ` +
      `session=${reviewerSessionUuid} pgid=${pgid}`
    );
    return true;
  } catch (err) {
    handlePollError(err, 'stmtMarkReviewerPgid');
    log.warn?.(
      `[watcher] reviewer_session_handle_persist_failed repo=${repoPath} pr=${prNumber} ` +
      `session=${reviewerSessionUuid} pgid=${pgid} error=${err?.message || err}`
    );
    return false;
  }
}

// ── Reviewer spawning ────────────────────────────────────────────────────────

async function spawnReviewer({
  repo,
  prNumber,
  reviewerModel,
  botTokenEnv,
  linearTicketId,
  labels = [],
  builderTag,
  reviewerHeadSha,
  reviewAttemptNumber,
  reviewDbAttemptNumber,
  passKind = 'first-pass',
  maxRemediationRounds,
  reviewerSessionUuid,
  reviewerTimeoutMs = resolveReviewerTimeoutMs(),
  workspacePath = null,
  crossModelReviewWaived = false,
  crossModelReviewWaiverReason = null,
  onReviewerPgid = () => {},
}) {
  const finalRound = (
    Number.isFinite(reviewAttemptNumber) &&
    Number.isFinite(maxRemediationRounds) &&
    reviewAttemptNumber > maxRemediationRounds
  );
  const roundLabel = Number.isFinite(reviewAttemptNumber)
    ? ` attempt=${reviewAttemptNumber}/${1 + Number(maxRemediationRounds || 0)}${finalRound ? ' [FINAL — lenient threshold]' : ''}`
    : '';
  console.log(`[watcher] Spawning reviewer for ${repo}#${prNumber} (model: ${reviewerModel})${roundLabel}`);

  inFlightReviewerSessions.add(reviewerSessionUuid);
  try {
    const startedAt = new Date().toISOString();
    beginReviewerPass(ROOT, {
      repo,
      prNumber,
      attemptNumber: reviewDbAttemptNumber ?? reviewAttemptNumber ?? 0,
      reviewerClass: reviewerModel,
      reviewerModel,
      passKind,
      workspacePath: workspacePath || ROOT,
      startedAt,
      metadata: {
        reviewerSessionUuid,
        reviewerModel,
        reviewAttemptNumber,
        maxRemediationRounds,
      },
    });

    // The reviewer-runtime adapter (LAC-563) owns the spawn contract:
    // canonical OAuth env-strip, atomic run-state records, process-group
    // isolation, failure classification. The `forbiddenFallbacks` arg is
    // additive opt-in beyond the canonical 8-env set the adapter always
    // strips when `oauthStripEnforced: true`.
    const result = await reviewerRuntimeAdapter.spawnReviewer({
      model: reviewerModel,
      prompt: '',
      subjectContext: {
        domainId: 'code-pr',
        repo,
        prNumber,
        reviewerModel,
        botTokenEnv,
        linearTicketId,
        labels,
        builderTag,
        reviewerHeadSha,
        reviewAttemptNumber,
        maxRemediationRounds,
        reviewerSessionUuid,
        crossModelReviewWaived,
        crossModelReviewWaiverReason,
      },
      timeoutMs: reviewerTimeoutMs,
      sessionUuid: reviewerSessionUuid,
      forbiddenFallbacks: ['api-key', 'anthropic-api-key'],
      onReviewerPgid,
    });
    if (result.stdoutTail) console.log(`[reviewer:${prNumber}] ${String(result.stdoutTail).trim()}`);
    if (result.stderrTail) console.error(`[reviewer:${prNumber}] stderr: ${String(result.stderrTail).trim()}`);
    try {
      const endedAt = new Date().toISOString();
      const tokenUsage = result.tokenUsage || readBestReviewerEvidenceTokenUsage({
        adapterSessionKey: result.reattachToken || reviewerSessionUuid,
        sessionKeys: [
          reviewerSessionUuid,
          result.reattachToken,
          result.sessionUuid,
        ],
        workspacePath: workspacePath || ROOT,
        startedAt,
        endedAt,
        reviewerModel,
        rootDir: ROOT,
      });
      completeReviewerPass(ROOT, {
        repo,
        prNumber,
        attemptNumber: reviewDbAttemptNumber ?? reviewAttemptNumber ?? 0,
        passKind,
        status: result.ok ? 'completed' : (result.failureClass === 'cancelled' ? 'cancelled' : 'failed'),
        endedAt,
        tokenUsage,
        tokenSource: tokenUsage?.source || 'unknown',
        metadata: {
          reviewerSessionUuid,
          reattachToken: result.reattachToken || null,
          failureClass: result.failureClass || null,
        },
      });
    } catch (err) {
      console.warn(
        `[watcher] reviewer_pass_token_update_failed repo=${repo} pr=${prNumber} ` +
        `session=${reviewerSessionUuid}: ${err?.message || err}`
      );
    }
    return result;
  } catch (err) {
    try {
      completeReviewerPass(ROOT, {
        repo,
        prNumber,
        attemptNumber: reviewDbAttemptNumber ?? reviewAttemptNumber ?? 0,
        passKind,
        status: 'failed',
        endedAt: new Date().toISOString(),
        metadata: {
          reviewerSessionUuid,
          reviewerModel,
          error: err?.message || String(err),
        },
      });
    } catch (settleErr) {
      console.warn(
        `[watcher] reviewer_pass_token_update_failed repo=${repo} pr=${prNumber} ` +
        `session=${reviewerSessionUuid}: ${settleErr?.message || settleErr}`
      );
    }
    throw err;
  } finally {
    inFlightReviewerSessions.delete(reviewerSessionUuid);
  }
}

function settleReviewerAttempt({
  rootDir = ROOT,
  repoPath,
  prNumber,
  result,
  failureAt = new Date().toISOString(),
  maxRemediationRounds,
  statements = {
    markPosted: stmtMarkPosted,
    markFailed: stmtMarkFailed,
    markCascadeFailed: stmtMarkCascadeFailed,
    markPendingUpstream: stmtMarkPendingUpstream,
    getReviewRow: stmtGetReviewRow,
  },
  log = console,
}) {
  if (result.ok) {
    statements.markPosted.run(new Date().toISOString(), repoPath, prNumber);
    clearCascadeState(rootDir, { repo: repoPath, prNumber });
    return;
  }

  const failureClass = result.failureClass || 'unknown';

  // LAC-545: every reviewer failure now logs its captured stderr/stdout
  // with the failure class. Previously these were swallowed by the
  // classifier — the silent-stall on every `[claude-code]` PR codex
  // reviewer attempt was invisible until forensic instrumentation got
  // bolted on. Mirror the success-path `[reviewer:<N>] stderr: ...`
  // shape so success and failure produce parallel diagnostic lines.
  const failureStderrText = String(result.stderr || '').trim();
  const failureStdoutText = String(result.stdout || '').trim();
  if (failureStderrText) {
    log.warn(
      `[reviewer:${prNumber}] stderr (failure-class=${failureClass}): ${previewLogText(failureStderrText)}`
    );
  }
  if (failureStdoutText) {
    log.warn(
      `[reviewer:${prNumber}] stdout (failure-class=${failureClass}): ${previewLogText(failureStdoutText)}`
    );
  }

  const transientFailureClasses = new Set([
    'cascade',
    'reviewer-timeout',
    'launchctl-bootstrap',
    'daemon-bounce',
  ]);
  const defaultFailureMessages = {
    cascade: 'Reviewer hit a LiteLLM/upstream cascade failure; watcher backoff engaged.',
    'reviewer-timeout': 'Reviewer command timed out before posting; watcher backoff engaged.',
    'launchctl-bootstrap': 'Claude launchctl session bootstrap failed; watcher backoff engaged.',
    'daemon-bounce': 'Reviewer runtime could not reattach after daemon bounce; watcher backoff engaged.',
    bug: 'Reviewer failed due to an invocation or implementation bug.',
    unknown: 'Unknown reviewer failure',
  };
  const failureMessage = String(result.error || '').trim() || defaultFailureMessages[failureClass] || defaultFailureMessages.unknown;
  const classifiedMessage = `[${failureClass}] ${failureMessage}`;
  if (transientFailureClasses.has(failureClass)) {
    const cascadeState = recordCascadeFailure(rootDir, {
      repo: repoPath,
      prNumber,
      failedAt: failureAt,
      failureClass,
    });
    if (cascadeState.consecutiveTransientFailures >= CASCADE_FAILURE_CAP) {
      statements.markPendingUpstream.run(failureAt, classifiedMessage, repoPath, prNumber);
      const breakdown = formatTransientFailureBreakdown(cascadeState.transientFailureBreakdown);
      log.warn(
        `[watcher] PR #${prNumber} marked pending-upstream after ${cascadeState.consecutiveTransientFailures} transient reviewer failures (${breakdown}); will resume when the reviewer lane recovers`
      );
    } else {
      statements.markCascadeFailed.run(failureAt, classifiedMessage, repoPath, prNumber);
    }
    log.warn(
      `[watcher] Reviewer ${failureClass} failure on #${prNumber} (consecutiveTransient=${cascadeState.consecutiveTransientFailures}); backing off ${cascadeState.backoffMinutes}m`
    );
    return;
  }

  clearCascadeState(rootDir, { repo: repoPath, prNumber });
  statements.markFailed.run(failureAt, classifiedMessage, repoPath, prNumber);
  const updatedRow = statements.getReviewRow.get(repoPath, prNumber);
  if (failureClass === 'bug') {
    log.warn(
      `[watcher] Reviewer bug-class failure on #${prNumber} (attempt ${updatedRow.review_attempts}/${1 + Number(maxRemediationRounds || 0)})`
    );
  } else {
    log.warn(
      `[watcher] Reviewer unknown-class failure on #${prNumber}; counting against attempt budget (${updatedRow.review_attempts}/${1 + Number(maxRemediationRounds || 0)})`
    );
  }
}

function evaluateRoundBudgetForReview({
  rootDir = ROOT,
  repo,
  prNumber,
  linearTicketId,
  reviewStatus,
  reviewAttempts = 0,
  log = console.log,
}) {
  // Convergence loop, post-2026-05-06:
  // The rereview is ALWAYS allowed to fire after a remediation round —
  // the cap on the convergence loop lives on the *remediation* side
  // (`claimNextFollowUpJob` refuses when `currentRound >= maxRounds`),
  // not on the *rereview* side. Rationale: the reviewer's verdict is
  // the only signal that can replace a stale `Request changes`, so
  // skipping the rereview after remediation strands the PR even when
  // the remediator addressed the findings. The previous gate
  // (round-budget-exhausted) hid converged remediations behind a
  // halt-without-rereview state — exactly what the 2026-05-06 PR #267
  // verification surfaced.
  //
  // This function is retained (and still returns the round-counters
  // for caller observability) so the callsite shape is unchanged.
  if (reviewStatus !== 'pending' || Number(reviewAttempts) <= 0) {
    return { skip: false };
  }

  const ledger = summarizePRRemediationLedger(rootDir, { repo, prNumber });
  const resolution = resolveRoundBudgetForJob({
    linearTicketId,
    riskClass: ledger.latestRiskClass,
  }, { rootDir });
  const latestMaxRounds = Number(ledger.latestMaxRounds);
  const roundBudget = Number.isInteger(latestMaxRounds) && latestMaxRounds > resolution.roundBudget
    ? latestMaxRounds
    : resolution.roundBudget;

  return {
    skip: false,
    completedRoundsForPR: ledger.completedRoundsForPR,
    roundBudget,
    riskClass: resolution.riskClass,
  };
}

function isActiveFollowUpJob(job) {
  return ['pending', 'inProgress', 'in-progress'].includes(job?.status);
}

function shouldDeferReviewForActiveFollowUp({
  rootDir = ROOT,
  repo,
  prNumber,
  latestJobFinder = findLatestFollowUpJob,
}) {
  const latest = latestJobFinder(rootDir, { repo, prNumber });
  if (!isActiveFollowUpJob(latest?.job)) {
    return {
      defer: false,
      latestJobStatus: latest?.job?.status || null,
      jobPath: latest?.jobPath || null,
    };
  }
  return {
    defer: true,
    latestJobStatus: latest.job.status,
    jobPath: latest.jobPath || null,
    jobId: latest.job.jobId || null,
  };
}

// ── Operator surface ─────────────────────────────────────────────────────────

function createWatcherOperatorSurface() {
  return createCompositeOperatorSurface({
    controls: {
      execFileImpl: execFileAsync,
    },
    triage: {
      stateNames: {
        inReview: config.linearStates?.inReview ?? 'In Review',
        inProgress: config.linearStates?.inProgress ?? 'In Progress',
        done: config.linearStates?.done ?? 'Done',
        cancelled: config.linearStates?.cancelled ?? 'Cancelled',
      },
      logger: console,
    },
  });
}

function parseStoredLabels(labelsJson) {
  try {
    const parsed = JSON.parse(labelsJson || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function subjectRefWithLinearTicket(subjectRef, linearTicketId, labels = []) {
  return {
    ...subjectRef,
    linearTicketId,
    labels: Array.isArray(labels) ? labels : [],
  };
}

// ── Org repo discovery ───────────────────────────────────────────────────────

let activeRepos = config.repos ?? [];
let lastRepoRefresh = 0;
const adversarialGateBranchProtectionChecker = createBranchProtectionChecker({
  execFileImpl: execFileAsync,
});
const DEFAULT_STALE_REVIEWER_RECONCILE_PER_POLL = 3;

function resolveStaleReviewerReconcilePerPoll(env = process.env) {
  const raw = env.ADVERSARIAL_STALE_REVIEWER_RECONCILE_PER_POLL;
  if (raw === undefined || raw === null || raw === '') return DEFAULT_STALE_REVIEWER_RECONCILE_PER_POLL;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) return DEFAULT_STALE_REVIEWER_RECONCILE_PER_POLL;
  return parsed;
}

async function refreshOrgRepos(octokit) {
  if (!config.org) return;

  const now = Date.now();
  const refreshInterval = config.repoRefreshIntervalMs ?? 3_600_000;
  if (now - lastRepoRefresh < refreshInterval) return;

  try {
    const all = await octokit.paginate(octokit.rest.repos.listForOrg, {
      org: config.org,
      type: 'all',
      per_page: 100,
    });

    const excluded = new Set(config.excludeRepos ?? []);
    activeRepos = all
      .filter((r) => !r.archived && !excluded.has(r.name) && !excluded.has(`${config.org}/${r.name}`))
      .map((r) => `${config.org}/${r.name}`);

    lastRepoRefresh = now;
    console.log(`[watcher] Org repos refreshed — watching ${activeRepos.length} repos: ${activeRepos.join(', ')}`);
  } catch (err) {
    console.error(`[watcher] Failed to list org repos for ${config.org}:`, err.message);
  }
}

// ── Lifecycle sync: check open PRs for merge/close ──────────────────────────

async function attemptMergeAgentLifecycleCleanup({
  rootDir = ROOT,
  repo,
  prNumber,
  transition = 'unknown',
  source = 'retry-loop',
  cancelImpl = cancelMergeAgentDispatchOnMerge,
} = {}) {
  try {
    const cancelResult = await cancelImpl({
      rootDir,
      repo,
      prNumber,
      hqPath: process.env.HQ_BIN || 'hq',
      ghExecFileImpl: execFileAsync,
    });
    updateMergeAgentLifecycleCleanup(rootDir, {
      repo,
      prNumber,
      result: {
        ...cancelResult,
        transition,
        source,
      },
      attemptedAt: cancelResult.attemptedAt,
    });
    if (cancelResult.cleanupComplete) {
      clearMergeAgentLifecycleCleanup(rootDir, { repo, prNumber });
    }
    console.log(
      `[watcher] cancel-on-${transition} (${source}) for ${repo}#${prNumber}: `
      + `lrq=${cancelResult.launchRequestId || 'none'} `
      + `cancelled=${cancelResult.cancelled} `
      + `labelRemoved=${cancelResult.labelRemoved} `
      + `retryable=${cancelResult.retryable}`
      + (cancelResult.cancelError ? ` cancelError=${cancelResult.cancelError}` : '')
      + (cancelResult.labelRemovalError ? ` labelRemovalError=${cancelResult.labelRemovalError}` : '')
    );
    return cancelResult;
  } catch (err) {
    console.warn(
      `[watcher] cancel-on-${transition} (${source}) for ${repo}#${prNumber} raised:`,
      err?.message || err
    );
    updateMergeAgentLifecycleCleanup(rootDir, {
      repo,
      prNumber,
      result: {
        attempted: true,
        repo,
        prNumber,
        attemptedAt: new Date().toISOString(),
        cancelled: false,
        labelRemoved: false,
        cleanupComplete: false,
        retryable: true,
        transition,
        source,
        cancelError: err?.message || String(err),
      },
    });
    return null;
  }
}

async function attemptMergeAgentDispatchedLabelAddCleanup({
  rootDir = ROOT,
  repo,
  prNumber,
  transition = MERGE_AGENT_DISPATCHED_LABEL_ADD_TRANSITION,
  source = 'retry-loop',
  labelAddImpl = addMergeAgentDispatchedLabel,
} = {}) {
  try {
    const labelResult = await labelAddImpl({
      repo,
      prNumber,
      ghExecFileImpl: execFileAsync,
    });
    const cleanupResult = {
      attempted: true,
      repo,
      prNumber,
      attemptedAt: labelResult.attemptedAt,
      transition,
      source,
      labelAdded: labelResult.added,
      labelAddError: labelResult.error,
      cleanupComplete: Boolean(labelResult.added),
      retryable: !labelResult.added,
    };
    updateMergeAgentLifecycleCleanup(rootDir, {
      repo,
      prNumber,
      result: cleanupResult,
      attemptedAt: cleanupResult.attemptedAt,
    });
    if (cleanupResult.cleanupComplete) {
      clearMergeAgentLifecycleCleanup(rootDir, { repo, prNumber });
    }
    console.log(
      `[watcher] add-${MERGE_AGENT_DISPATCHED_LABEL} (${source}) for ${repo}#${prNumber}: `
      + `added=${cleanupResult.labelAdded} retryable=${cleanupResult.retryable}`
      + (cleanupResult.labelAddError ? ` labelAddError=${cleanupResult.labelAddError}` : '')
    );
    return cleanupResult;
  } catch (err) {
    console.warn(
      `[watcher] add-${MERGE_AGENT_DISPATCHED_LABEL} (${source}) for ${repo}#${prNumber} raised:`,
      err?.message || err
    );
    updateMergeAgentLifecycleCleanup(rootDir, {
      repo,
      prNumber,
      result: {
        attempted: true,
        repo,
        prNumber,
        attemptedAt: new Date().toISOString(),
        transition,
        source,
        labelAdded: false,
        labelAddError: err?.message || String(err),
        cleanupComplete: false,
        retryable: true,
      },
    });
    return null;
  }
}

async function queueAndAttemptMergeAgentLifecycleCleanup({
  rootDir = ROOT,
  pr,
  repo,
  prNumber,
  transition,
} = {}) {
  const labelNames = Array.isArray(pr?.labels)
    ? pr.labels
      .map((l) => (typeof l === 'string' ? l : l?.name || ''))
      .filter(Boolean)
    : [];
  const hasDispatchedLabel = labelNames.includes(MERGE_AGENT_DISPATCHED_LABEL);
  const hasRecordedDispatch = listMergeAgentDispatches(rootDir, { repo, prNumber }).length > 0;
  if (!hasDispatchedLabel && !hasRecordedDispatch) return null;

  upsertMergeAgentLifecycleCleanup(rootDir, {
    repo,
    prNumber,
    transition,
    headSha: pr?.head?.sha || null,
  });
  return attemptMergeAgentLifecycleCleanup({
    rootDir,
    repo,
    prNumber,
    transition,
    source: 'lifecycle-sync',
  });
}

function resolveMergeAgentLifecycleCleanupRetryMs(env = process.env) {
  const raw = Number.parseInt(
    env.ADVERSARIAL_MERGE_AGENT_LIFECYCLE_CLEANUP_RETRY_MS || `${DEFAULT_MERGE_AGENT_LIFECYCLE_CLEANUP_RETRY_MS}`,
    10
  );
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_MERGE_AGENT_LIFECYCLE_CLEANUP_RETRY_MS;
}

function resolveMergeAgentLifecycleCleanupPerPoll(env = process.env) {
  const raw = Number.parseInt(
    env.ADVERSARIAL_MERGE_AGENT_LIFECYCLE_CLEANUP_PER_POLL || `${DEFAULT_MERGE_AGENT_LIFECYCLE_CLEANUP_PER_POLL}`,
    10
  );
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_MERGE_AGENT_LIFECYCLE_CLEANUP_PER_POLL;
}

function shouldRetryMergeAgentLifecycleCleanup(cleanup, {
  nowMs = Date.now(),
  retryMs = resolveMergeAgentLifecycleCleanupRetryMs(),
} = {}) {
  if (!cleanup?.lastAttemptAt) return true;
  const lastAttemptMs = Date.parse(cleanup.lastAttemptAt);
  if (!Number.isFinite(lastAttemptMs)) return true;
  return nowMs - lastAttemptMs >= retryMs;
}

async function retryPendingMergeAgentLifecycleCleanups({
  rootDir = ROOT,
  cancelImpl = cancelMergeAgentDispatchOnMerge,
  labelAddImpl = addMergeAgentDispatchedLabel,
  nowMs = Date.now(),
  retryMs = resolveMergeAgentLifecycleCleanupRetryMs(),
  maxPerPoll = resolveMergeAgentLifecycleCleanupPerPoll(),
} = {}) {
  if (maxPerPoll <= 0) return { attempted: 0, skipped: 0, pending: 0 };
  const pending = listMergeAgentLifecycleCleanups(rootDir);
  let attempted = 0;
  let skipped = 0;
  for (const cleanup of pending) {
    if (attempted >= maxPerPoll || !shouldRetryMergeAgentLifecycleCleanup(cleanup, { nowMs, retryMs })) {
      skipped += 1;
      continue;
    }
    attempted += 1;
    if (cleanup.transition === MERGE_AGENT_DISPATCHED_LABEL_ADD_TRANSITION) {
      await attemptMergeAgentDispatchedLabelAddCleanup({
        rootDir,
        repo: cleanup.repo,
        prNumber: cleanup.prNumber,
        transition: cleanup.transition,
        source: 'retry-loop',
        labelAddImpl,
      });
    } else {
      await attemptMergeAgentLifecycleCleanup({
        rootDir,
        repo: cleanup.repo,
        prNumber: cleanup.prNumber,
        transition: cleanup.transition || 'unknown',
        source: 'retry-loop',
        cancelImpl,
      });
    }
  }
  return { attempted, skipped, pending: pending.length };
}

async function runFastMergeClosePathIsolated({
  pollImpl = pollFastMergeQueue,
  db: reviewDb = db,
  ghClient = execFileAsync,
  rootDir = ROOT,
  perPollCap = resolveFastMergePerPollCap(),
  repos = activeRepos,
  logger = console,
} = {}) {
  try {
    const fastMergeSummary = await pollImpl({
      db: reviewDb,
      ghClient,
      rootDir,
      perPollCap,
      repos,
      logger,
    });
    if (fastMergeSummary.processed > 0) {
      logger.log?.(
        `[watcher] fast-merge close path: processed=${fastMergeSummary.processed} ` +
        `merged=${fastMergeSummary.merged} blocked=${fastMergeSummary.blocked} ` +
        `requeued_head_change=${fastMergeSummary.requeued_head_change} ` +
        `requeued_veto=${fastMergeSummary.requeued_veto} ` +
        `pending=${fastMergeSummary.skipped_still_pending}`
      );
    }
    return { ok: true, summary: fastMergeSummary };
  } catch (err) {
    logger.error?.('[watcher] fast-merge close path failed; continuing normal merge-agent/review work:', err?.message || err);
    return { ok: false, error: err };
  }
}

/**
 * For every PR we previously marked as "open", check if it has since been
 * merged or closed and update Linear accordingly.
 */
async function syncPRLifecycle(octokit, operatorSurface) {
  const openRows = stmtGetOpenPRs.all();
  if (openRows.length === 0) return;

  for (const row of openRows) {
    const { repo, pr_number: prNumber, linear_ticket: linearTicketId } = row;
    const labels = parseStoredLabels(row.labels_json);
    const [owner, repoName] = repo.split('/');

    let pr;
    try {
      const { data } = await octokit.rest.pulls.get({ owner, repo: repoName, pull_number: prNumber });
      pr = data;
    } catch (err) {
      console.error(`[watcher] Failed to fetch PR ${repo}#${prNumber}:`, err.message);
      continue;
    }

    if (pr.merged_at) {
      console.log(`[watcher] PR ${repo}#${prNumber} was merged — syncing Linear`);
      await queueAndAttemptMergeAgentLifecycleCleanup({
        pr, repo, prNumber, transition: 'merged',
      });
      stmtMarkMerged.run(pr.merged_at, repo, prNumber);
      deleteGateRecordsForPR(ROOT, { repo, prNumber });
      await operatorSurface.syncTriageStatus(
        subjectRefWithLinearTicket({
          domainId: 'code-pr',
          subjectExternalId: `${repo}#${prNumber}`,
          revisionRef: pr.head?.sha || null,
        }, linearTicketId, labels),
        'finalized'
      );
    } else if (pr.state === 'closed') {
      console.log(`[watcher] PR ${repo}#${prNumber} was closed (unmerged) — syncing Linear`);
      await queueAndAttemptMergeAgentLifecycleCleanup({
        pr, repo, prNumber, transition: 'closed',
      });
      stmtMarkClosed.run(pr.closed_at ?? new Date().toISOString(), repo, prNumber);
      deleteGateRecordsForPR(ROOT, { repo, prNumber });
      await operatorSurface.syncTriageStatus(
        subjectRefWithLinearTicket({
          domainId: 'code-pr',
          subjectExternalId: `${repo}#${prNumber}`,
          revisionRef: pr.head?.sha || null,
        }, linearTicketId, labels),
        'halted'
      );
    }
    // Still open → nothing to do
  }
}

// ── Poll loop (new PRs) ──────────────────────────────────────────────────────

async function handlePostedReviewRow({
  rootDir = ROOT,
  repoPath,
  prNumber,
  existing,
  subjectRef,
  currentRevisionRef,
  labelNames = [],
  projectGateStatusSafe,
  execFileImpl = execFileAsync,
  fetchMergeAgentCandidateImpl = fetchMergeAgentCandidate,
  buildMergeAgentDispatchJobImpl = buildMergeAgentDispatchJob,
  dispatchMergeAgentForPRImpl = dispatchMergeAgentForPR,
  operatorSurface = null,
  logger = console,
} = {}) {
  await projectGateStatusSafe(existing);

  try {
    let operatorApprovalEvent;
    let mergeAgentRequestEvent;
    if (operatorSurface) {
      const controlSubjectRef = subjectRef || {
        domainId: 'code-pr',
        subjectExternalId: `${repoPath}#${prNumber}`,
        revisionRef: currentRevisionRef || null,
      };
      const revisionRef = currentRevisionRef || controlSubjectRef.revisionRef || null;
      const [operatorApproval, mergeAgentRequest] = await Promise.all([
        labelNames.includes(OPERATOR_APPROVED_LABEL)
          ? operatorSurface.observeOperatorApproved(controlSubjectRef, revisionRef)
          : null,
        labelNames.includes(MERGE_AGENT_REQUESTED_LABEL)
          ? operatorSurface.observeMergeAgentOverride(controlSubjectRef, revisionRef)
          : null,
      ]);
      operatorApprovalEvent = legacyLabelEventFromControlResult(operatorApproval, OPERATOR_APPROVED_LABEL);
      mergeAgentRequestEvent = legacyLabelEventFromControlResult(mergeAgentRequest, MERGE_AGENT_REQUESTED_LABEL);
    }
    const candidate = await fetchMergeAgentCandidateImpl(repoPath, prNumber, {
      execFileImpl,
      operatorApprovalEvent,
      mergeAgentRequestEvent,
    });
    const dispatchJob = buildMergeAgentDispatchJobImpl(rootDir, candidate);
    const dispatched = await dispatchMergeAgentForPRImpl({
      rootDir,
      ...dispatchJob,
    });
    // Enrich the decision log line when the dispatch is stuck pre-spawn
    // (recorded, daemon refusing admission). Surfaces what
    // `skip-already-dispatched` alone hides — see PR #649 for the on-
    // demand diagnostic of the same gap. Fails closed: when the helper
    // returns null (OSS standalone, hqRoot missing, audit dir empty,
    // dispatch still booting) the message is unchanged.
    const stuck = dispatched?.stuckDetail || null;
    const stuckSuffix = stuck
      ? ` BLOCKED stuck=${stuck.stuckForMinutes}min refusals=${stuck.refusalCount} primary=${stuck.primaryReason || 'unknown'}`
      : '';
    logger.log(
      `[watcher] merge-agent decision for ${repoPath}#${prNumber}: ${dispatched.decision}${stuckSuffix}`
    );
    // Escalate to a Sentinel alert at the operator-confirmed 30-min
    // threshold. Debounced: don't refire the same alert within an hour.
    // Wrapped in try/catch so missing ALERT_TO / unreachable hooks
    // endpoint never crashes the watcher loop (matches the OSS-friendly
    // shape of health-probe.mjs::sendTransitionAlert).
    if (stuck && stuck.stuckForMinutes >= 30) {
      try {
        await maybeFireMergeAgentStuckAlert({
          rootDir,
          repoPath,
          prNumber,
          dispatched,
          deliverAlertFn: defaultDeliverAlert,
          logger,
        });
      } catch (alertErr) {
        logger?.error?.(
          `[watcher] stuck-dispatch alert delivery failed: ${alertErr?.message || alertErr}`
        );
      }
    }
    // Fleet-wide false-deferral alert — defense-in-depth against the
    // 2026-05-18 session-ledger DB-path bug class. See helper above.
    try {
      await maybeFireFleetWideFalseDeferralAlert({
        dispatched,
        repoPath,
        prNumber,
        deliverAlertFn: defaultDeliverAlert,
        logger,
      });
    } catch (alertErr) {
      logger?.error?.(
        `[watcher] fleet-wide false-deferral detector failed: ${alertErr?.message || alertErr}`
      );
    }
  } catch (err) {
    // The augmented error from `dispatchMergeAgentForPR` already
    // inlines stderr+stdout into `err.message`, so just dumping
    // `err.message` here surfaces the full diagnostic chain (rather
    // than the bare "Command failed: hq dispatch …" the watcher used
    // to log). For non-augmented errors (anything throwing from the
    // outer try block that doesn't pass through the augment shim),
    // also try `.stderr` / `.stdout` as a defense-in-depth fallback.
    const errMessage = err?.message || String(err);
    const errStderr = err?.stderr ? String(err.stderr).trim() : '';
    const errStdout = err?.stdout ? String(err.stdout).trim() : '';
    let detail = errMessage;
    if (errStderr && !errMessage.includes('stderr:')) {
      detail += `\n  stderr:\n${errStderr.split('\n').map(l => `    ${l}`).join('\n')}`;
    }
    if (errStdout && !errMessage.includes('stdout:')) {
      detail += `\n  stdout:\n${errStdout.split('\n').map(l => `    ${l}`).join('\n')}`;
    }
    logger.error(
      `[watcher] merge-agent dispatch check failed for ${repoPath}#${prNumber}:\n${detail}`
    );
  }
}

function recordFastMergeAuditPending({ repo, prNumber, entry }) {
  stmtMarkFastMergeAuditPending.run(JSON.stringify(entry), repo, prNumber);
}

function markFastMergeAuditWritten({ repo, prNumber }) {
  stmtMarkFastMergeAuditWritten.run(repo, prNumber);
}

function markFastMergeAuditError({ repo, prNumber, err }) {
  stmtMarkFastMergeAuditError.run(String(err?.message || err || 'unknown audit write failure'), repo, prNumber);
}

function retryPendingFastMergeAudits({ logger = console } = {}) {
  const rows = stmtGetPendingFastMergeAudits.all(FAST_MERGE_RECOVERY_PER_TICK);
  for (const row of rows) {
    let entry;
    try {
      entry = JSON.parse(row.fast_merge_audit_payload_json || '{}');
    } catch (err) {
      markFastMergeAuditError({ repo: row.repo, prNumber: row.pr_number, err });
      logger.error?.(
        `[watcher] fast-merge pending audit payload is invalid for ${row.repo}#${row.pr_number}: ${err?.message || err}`
      );
      continue;
    }
    try {
      writeFastMergeAuditPayload(ROOT, entry);
      markFastMergeAuditWritten({ repo: row.repo, prNumber: row.pr_number });
    } catch (err) {
      markFastMergeAuditError({ repo: row.repo, prNumber: row.pr_number, err });
      logger.error?.(
        `[watcher] fast-merge pending audit retry failed for ${row.repo}#${row.pr_number}: ${err?.message || err}`
      );
    }
  }
}

async function recoverFastMergeVetoes(octokit, { logger = console } = {}) {
  const skippedRows = stmtGetFastMergeSkippedPRs.all(FAST_MERGE_RECOVERY_PER_TICK);
  for (const row of skippedRows) {
    const [owner, repo] = String(row.repo || '').split('/');
    if (!owner || !repo) continue;
    const liveLabels = await fetchLivePRLabels(octokit, {
      owner,
      repo,
      prNumber: row.pr_number,
      logger,
    });
    if (!liveLabels) continue;
    const decision = fastMergeDecisionFromLabels(liveLabels);
    stmtUpdateReviewLabels.run(JSON.stringify(liveLabels), row.repo, row.pr_number);
    const lostFastMergeAuthorization = !decision.hasFastMergeLabel || decision.hasVeto;
    if (!lostFastMergeAuthorization) continue;

    const requeuedAt = new Date().toISOString();
    const action = decision.hasVeto ? 'veto-requeued' : 'label-removed-requeued';
    const reason = decision.hasVeto
      ? `fast-merge veto label observed at ${requeuedAt}; requeueing normal first-pass review`
      : `fast-merge authorization labels absent at ${requeuedAt}; requeueing normal first-pass review`;
    let priorCategories = [];
    try {
      priorCategories = fastMergeDecisionFromLabels(JSON.parse(row.labels_json || '[]')).categories;
    } catch {
      priorCategories = [];
    }
    const auditEntry = buildFastMergeAuditEntry({
      action,
      repo: row.repo,
      prNumber: row.pr_number,
      categories: decision.categories.length ? decision.categories : priorCategories,
      labels: liveLabels,
      authorizedHeadSha: row.fast_merge_authorized_head_sha || null,
      authorizedAt: row.reviewed_at || requeuedAt,
      skippedAt: row.reviewed_at || null,
      vetoedAt: decision.hasVeto ? requeuedAt : null,
      requeueResult: {
        triggered: false,
        status: 'attempting',
        reason,
      },
    });
    recordFastMergeAuditPending({ repo: row.repo, prNumber: row.pr_number, entry: auditEntry });

    let requeueResult;
    try {
      requeueResult = requestReviewRereview({
        rootDir: ROOT,
        repo: row.repo,
        prNumber: row.pr_number,
        requestedAt: requeuedAt,
        reason,
        allowFastMergeSkipped: true,
        db,
      });
    } catch (err) {
      logger.error?.(
        `[watcher] fast-merge requeue failed for ${row.repo}#${row.pr_number}: ${err?.message || err}`
      );
      continue;
    }

    auditEntry.requeue_result = {
      triggered: Boolean(requeueResult?.triggered),
      status: requeueResult?.status || null,
      reason: requeueResult?.reason || null,
    };
    recordFastMergeAuditPending({ repo: row.repo, prNumber: row.pr_number, entry: auditEntry });
    try {
      writeFastMergeAuditPayload(ROOT, auditEntry);
      markFastMergeAuditWritten({ repo: row.repo, prNumber: row.pr_number });
    } catch (err) {
      markFastMergeAuditError({ repo: row.repo, prNumber: row.pr_number, err });
      logger.error?.(
        `[watcher] fast-merge ${action} audit write failed for ${row.repo}#${row.pr_number}: ${err?.message || err}`
      );
    }
    logger.log?.(
      `[watcher] fast-merge ${action} for ${row.repo}#${row.pr_number}: requeue ${requeueResult?.status || 'unknown'}`
    );
  }
}

/**
 * Poll for reviewable subjects once.
 *
 * `afterClaim` is a test-only observer used by the watcher claim-loop
 * regression test to inspect the durable row immediately after a successful
 * compare-and-swap claim. Production callers should leave it unset; observer
 * failures are logged and ignored so a mistaken callback cannot suppress
 * operator sync or reviewer spawn.
 */
async function pollOnce(
  octokit,
  {
    healthProbe = watcherHealthProbe,
    afterClaim = null,
  } = {}
) {
  const healthTick = healthProbe?.beginTick?.();
  try {
  const operatorSurface = createWatcherOperatorSurface();
  await refreshOrgRepos(octokit);
  const reattach = await reconcileReviewerSessions({
    db,
    octokit,
    maxRows: resolveStaleReviewerReconcilePerPoll(),
    shouldReconcileRow: (row, now) => shouldReconcileStaleReviewerSession(row, now),
    onTerminalDeadSession: ({ row, state, settledAt }) => settleDurableReviewerRunState({
      sessionUuid: row?.reviewer_session_uuid,
      state,
      settledAt,
    }),
  });
  if (reattach.skipped > 0) {
    console.log(
      `[watcher] stale reviewer reattach capped: reconciled=${reattach.reconciled} skipped=${reattach.skipped}`
    );
  }

  await warnForMissingAdversarialGateBranchProtection(activeRepos, {
    checker: adversarialGateBranchProtectionChecker,
    baseBranches: config.adversarialGateBaseBranches || {},
    defaultBaseBranch: config.adversarialGateBaseBranch || 'main',
    logger: console,
  });

  await retryPendingMergeAgentLifecycleCleanups();

  // Check lifecycle of previously-seen PRs first
  await syncPRLifecycle(octokit, operatorSurface);
  retryPendingFastMergeAudits();
  await recoverFastMergeVetoes(octokit);
  await runFastMergeClosePathIsolated();

  try {
    const ackRetry = await retryPendingRetriggerAckComments({
      rootDir: ROOT,
      execFileImpl: execFileAsync,
    });
    if (ackRetry.attempted > 0) {
      console.log(
        `[watcher] retrigger-remediation ack retry: attempted=${ackRetry.attempted} posted=${ackRetry.posted}`
      );
    }
  } catch (err) {
    console.error('[watcher] retrigger-remediation ack retry failed:', err?.message || err);
  }

  try {
    const reviewAckRetry = await retryPendingRetriggerReviewAckComments({
      rootDir: ROOT,
      execFileImpl: execFileAsync,
    });
    if (reviewAckRetry.attempted > 0) {
      console.log(
        `[watcher] retrigger-review ack retry: attempted=${reviewAckRetry.attempted} posted=${reviewAckRetry.posted}`
      );
    }
  } catch (err) {
    console.error('[watcher] retrigger-review ack retry failed:', err?.message || err);
  }

  const watcherDrain = readWatcherDrainState();
  if (watcherDrain.active) {
    console.log(
      `[watcher] Review drain active — skipping new review spawns` +
        (watcherDrain.requestedBy ? ` requested_by=${watcherDrain.requestedBy}` : '') +
        (watcherDrain.expiresAt ? ` expires_at=${watcherDrain.expiresAt}` : '') +
        ` reason="${watcherDrain.reason}"`
    );
  }

  for (const repoPath of activeRepos) {
    const [owner, repo] = repoPath.split('/');
    const subjectAdapter = createGitHubPRSubjectAdapter({
      octokit,
      repos: [repoPath],
      rootDir: ROOT,
      execFileImpl: execFileAsync,
    });

    let subjectRefs;
    const activeMergeAgentPRs = [];
    try {
      subjectRefs = await subjectAdapter.discoverSubjects();
    } catch (err) {
      console.error(`[watcher] Failed to fetch PRs for ${repoPath}:`, err.message);
      continue;
    }

    for (const subjectRef of subjectRefs) {
      let subject;
      try {
        subject = await subjectAdapter.fetchState(subjectRef);
      } catch (err) {
        console.error(`[watcher] Failed to fetch subject state for ${subjectRef.subjectExternalId}:`, err.message);
        continue;
      }
      const { prNumber } = parseSubjectExternalId(subject.ref.subjectExternalId);
      const prTitle = subject.title || '';
      const staleDriftSkip = shouldSkipReviewerForStaleDrift({
        number: prNumber,
        labels: subject.labels,
      });
      const prLabelNames = (Array.isArray(subject.labels) ? subject.labels : [])
        .map((l) => (typeof l === 'string' ? l : l?.name || ''))
        .filter(Boolean);
      if (prLabelNames.includes(MERGE_AGENT_DISPATCHED_LABEL)) {
        activeMergeAgentPRs.push({ repo: repoPath, prNumber, headSha: subject.headSha || null });
      }
      if (staleDriftSkip) {
        console.log(staleDriftSkip.message);
        continue;
      }
      let existing = stmtGetReviewRow.get(repoPath, prNumber);
      if (!subject.terminal && existing?.review_status === 'pending') {
        healthProbe?.recordOpenPending?.(healthTick, {
          repo: repoPath,
          prNumber,
        });
      }

      async function projectGateStatusSafe(reviewRow) {
        if (!subject.headSha) return;
        try {
          const operatorApproval = prLabelNames.includes(OPERATOR_APPROVED_LABEL)
            ? await operatorSurface.observeOperatorApproved(
              subject.ref,
              subject.ref.revisionRef
            )
            : null;
          const operatorApprovalEvent = legacyLabelEventFromControlResult(
            operatorApproval,
            OPERATOR_APPROVED_LABEL
          );
          const projected = await projectAdversarialGateStatus(ROOT, {
            repo: repoPath,
            prNumber,
            headSha: subject.headSha,
            labels: subject.labels,
            prUpdatedAt: subject.updatedAt || null,
            prAuthor: subject.authorRef || null,
            reviewRow,
            execFileImpl: execFileAsync,
            operatorApprovalEvent,
          });
          console.log(
            `[watcher] adversarial gate for ${repoPath}#${prNumber}: ${projected.decision.state}` +
              ` (${projected.decision.reason})`
          );
        } catch (err) {
          console.error(
            `[watcher] adversarial gate projection failed for ${repoPath}#${prNumber}:`,
            err?.message || err
          );
        }
      }

      // 'failed-orphan' is a sticky state reserved for legacy rows
      // without a reviewer handle and true anomalies where GitHub shows
      // a posted review but the reviewer process group is still alive.
      // Auto-retrying that row would risk a duplicate review post; the
      // operator must explicitly clear it via `npm run retrigger-review`.
      if (
        existing?.review_status === 'malformed' ||
        existing?.review_status === 'failed-orphan'
      ) {
        await projectGateStatusSafe(existing);
        continue;
      }

      if (subject.terminal) {
        continue;
      }

      // PR-side `retrigger-remediation` label (post-2026-05-06):
      // mobile-friendly operator surface that mirrors
      // `npm run retrigger-remediation`. Operator applies the label
      // on a halted PR; watcher detects it here, bumps maxRounds,
      // requeues the latest follow-up job, and removes the label.
      // Active jobs leave the label in place for the next tick.
      if (prLabelNames.includes(RETRIGGER_REMEDIATION_LABEL)) {
        try {
          const labelControl = await operatorSurface.observeLabelControl(
            subject.ref,
            subject.ref.revisionRef,
            RETRIGGER_REMEDIATION_LABEL
          );
          const labelEvent = legacyLabelEventFromControlResult(
            labelControl,
            RETRIGGER_REMEDIATION_LABEL
          );
          const result = await tryRetriggerRemediationFromLabel({
            rootDir: ROOT,
            repo: repoPath,
            prNumber,
            labelActor: labelEvent?.actor || 'unknown',
            labelEvent,
            revisionRef: subject.ref.revisionRef,
            execFileImpl: execFileAsync,
          });
          console.log(
            `[watcher] retrigger-remediation label on ${repoPath}#${prNumber}: ${result.outcome}` +
              (result.detail ? ` (${result.detail})` : '')
          );
        } catch (err) {
          console.error(
            `[watcher] retrigger-remediation label processing failed for ${repoPath}#${prNumber}:`,
            err?.message || err
          );
        }
      }

      // PR-side `retrigger-review` label (post-2026-05-16 refactor):
      // any actor with PR-label permission (operator, merge-agent,
      // codex/claude-code worker) can request a one-shot fresh
      // adversarial review on the current HEAD by applying the label.
      // The watcher resets the review row to 'pending' (so the next
      // tick re-reviews), removes the label, and posts an ack comment.
      // No remediation budget bump; no follow-up-job requeue. The
      // fresh review verdict drives the downstream merge-agent vs
      // remediation decision normally.
      //
      // Before this refactor, `retrigger-review` was a write-only marker
      // applied by merge-agent.sh with no consumer — the label add was
      // a noop and the merge-agent's `apply_retrigger_review_label`
      // failing silently caused the 10-min poll_checks_green hang
      // bug observed 2026-05-16T18Z.
      if (prLabelNames.includes(RETRIGGER_REVIEW_LABEL)) {
        try {
          const labelControl = await operatorSurface.observeLabelControl(
            subject.ref,
            subject.ref.revisionRef,
            RETRIGGER_REVIEW_LABEL
          );
          const labelEvent = legacyLabelEventFromControlResult(
            labelControl,
            RETRIGGER_REVIEW_LABEL
          );
          const result = await tryRetriggerReviewFromLabel({
            rootDir: ROOT,
            repo: repoPath,
            prNumber,
            labelActor: labelEvent?.actor || 'unknown',
            labelEvent,
            revisionRef: subject.ref.revisionRef,
            execFileImpl: execFileAsync,
          });
          console.log(
            `[watcher] retrigger-review label on ${repoPath}#${prNumber}: ${result.outcome}` +
              (result.detail ? ` (${result.detail})` : '')
          );
        } catch (err) {
          console.error(
            `[watcher] retrigger-review label processing failed for ${repoPath}#${prNumber}:`,
            err?.message || err
          );
        }
      }

      // Auto-refresh stale posted reviews when the PR HEAD has moved.
      //
      // Without this, a `posted` review row sits forever even when the
      // PR has been updated — D3 (downstream gate) sees the posted
      // review is on an older head SHA and reports `stale review`,
      // which blocks D4 from reaching `ready_to_merge`. Before this
      // change the only recovery was operator-applied `retrigger-review`
      // label, which doesn't scale to a backlog of PRs after a deploy.
      //
      // Confirmed root cause of the 20/23 D4 pending records observed
      // at 2026-05-16T22:37Z that cited "stale review(s) on prior
      // commits": 4 of 9 sampled PRs had `posted` rows with
      // `reviewer_head_sha` != current PR head. The CAS in
      // `stmtMarkAttemptStarted` reclaims only
      // `pending | failed | pending-upstream`, never `posted` — so
      // those rows stay stale until manual `retrigger-review`.
      //
      // This auto-refresh calls `requestReviewRereview`, whose own CAS
      // refuses to flip `reviewing` (the watcher already has an active
      // reviewer) — so a head change mid-tick can't race a duplicate
      // spawn. The retrigger only fires when `reviewer_head_sha` is
      // strictly different from the current `subject.headSha` and the
      // PR is non-terminal, so we don't thrash a PR whose head matches.
      if (
        existing?.review_status === 'posted' &&
        existing.reviewer_head_sha &&
        subject.headSha &&
        existing.reviewer_head_sha !== subject.headSha &&
        !subject.terminal
      ) {
        try {
          const refreshResult = requestReviewRereview({
            rootDir: ROOT,
            repo: repoPath,
            prNumber,
            reason: `auto-refresh: posted review on stale head ${existing.reviewer_head_sha.slice(0, 12)}; current head is ${subject.headSha.slice(0, 12)}`,
          });
          if (refreshResult.triggered) {
            console.log(
              `[watcher] auto-refresh stale posted review for ${repoPath}#${prNumber}: ` +
                `${existing.reviewer_head_sha.slice(0, 12)} → ${subject.headSha.slice(0, 12)}`
            );
            // Re-read the row so the rest of the iteration sees the
            // reset state; fall through to the spawn path below
            // (status is now 'pending' and the CAS will claim it).
            existing = stmtGetReviewRow.get(repoPath, prNumber);
          }
        } catch (err) {
          console.error(
            `[watcher] auto-refresh for ${repoPath}#${prNumber} failed:`,
            err?.message || err
          );
        }
      }

      if (existing?.review_status === 'posted') {
        await handlePostedReviewRow({
          rootDir: ROOT,
          repoPath,
          prNumber,
          existing,
          subjectRef: subject.ref,
          currentRevisionRef: subject.ref.revisionRef,
          labelNames: prLabelNames,
          projectGateStatusSafe,
          execFileImpl: execFileAsync,
          operatorSurface,
        });
        continue;
      }

      if (watcherDrain.active) {
        if (existing) {
          await projectGateStatusSafe(existing);
        }
        continue;
      }

      const route = routeSubject(subject);
      if (!route) {
        if (!existing) {
          stmtCreateReviewRow.run(
            repoPath,
            prNumber,
            new Date().toISOString(),
            'malformed-title',
            'open',
            null,
            'pending',
            JSON.stringify(Array.isArray(subject.labels) ? subject.labels : [])
          );
        }

        await signalMalformedTitleFailure(octokit, {
          repoPath,
          owner,
          repo,
          prNumber,
          prTitle,
          revisionRef: subject.ref.revisionRef,
          rootDir: ROOT,
        });

        // Malformed titles are terminal in watcher state to avoid ambiguous retitle retries.
        const failureAt = new Date().toISOString();
        stmtMarkMalformed.run(
          `Malformed PR title: ${prTitle}`,
          failureAt,
          failureAt,
          repoPath,
          prNumber
        );
        // Store normalized label names in reviewed_prs.labels_json. Readers
        // still accept the older GitHub label-object shape for historical rows.
        stmtUpdateReviewLabels.run(JSON.stringify(Array.isArray(subject.labels) ? subject.labels : []), repoPath, prNumber);
        await projectGateStatusSafe(stmtGetReviewRow.get(repoPath, prNumber));
        continue;
      }

      const crossModelWaiverReason = describeCrossModelReviewWaiver(
        route.builderClass,
        route.reviewerModel,
        process.env
      );
      if (crossModelWaiverReason) {
        console.warn(
          `[watcher] cross-model-review-waived repo=${repoPath} pr=${prNumber} ${crossModelWaiverReason}`
        );
      }

      // (stale-drift check already ran at the top of the per-PR loop;
      // duplicate block removed — caused SyntaxError on import per LAC-439.)

      const linearTicketId = operatorSurface.extractLinearTicketId(prTitle);
      let liveLabels = null;
      if (!existing) {
        liveLabels = await fetchLivePRLabels(octokit, {
          owner,
          repo,
          prNumber,
        });
        if (liveLabels) {
          const fastMergeDecision = fastMergeDecisionFromLabels(liveLabels);
          if (fastMergeDecision.hasFastMergeLabel && !fastMergeDecision.hasVeto) {
            const authorizedHeadSha = await fetchLivePRHeadSha(octokit, {
              owner,
              repo,
              prNumber,
              fallbackHeadSha: subject.headSha || null,
            });
            const timelineAuthorization = authorizedHeadSha
              ? await fetchFastMergeAuthorizationFromTimeline(octokit, {
                owner,
                repo,
                prNumber,
                liveHeadSha: authorizedHeadSha,
                allowedLabelNames: fastMergeDecision.labelNames.filter(
                  (name) => Object.prototype.hasOwnProperty.call(FAST_MERGE_CATEGORY_BY_LABEL, name)
                ),
              })
              : null;
            const changedFiles = authorizedHeadSha && timelineAuthorization
              && timelineAuthorization.authorizedHeadSha === authorizedHeadSha
              ? await fetchFastMergeChangedFiles(octokit, {
                owner,
                repo,
                prNumber,
              })
              : null;
            const shapeCheck = changedFiles
              ? evaluateFastMergeDiffShape(changedFiles, fastMergeDecision.categories)
              : null;
            if (
              authorizedHeadSha
              && timelineAuthorization
              && timelineAuthorization.authorizedHeadSha === authorizedHeadSha
              && shapeCheck
              && !shapeCheck.ok
            ) {
              const authorizedAt = timelineAuthorization.authorizedAt;
              writeFastMergeAuditEntry(ROOT, {
                action: 'would-have-skipped-shape-mismatch',
                repo: repoPath,
                prNumber,
                categories: fastMergeDecision.categories,
                labels: liveLabels,
                changedFiles: shapeCheck.files,
                shapeCheck,
                authorizedHeadSha,
                authorizedAt,
                skippedAt: null,
              });
              console.log(
                `[watcher] Fast-merge labels present for ${repoPath}#${prNumber} but diff shape failed (${shapeCheck.reason}); using normal review path`
              );
            } else if (
              authorizedHeadSha
              && timelineAuthorization
              && timelineAuthorization.authorizedHeadSha === authorizedHeadSha
              && shapeCheck?.ok
              && isFastMergeSkipEnabled()
            ) {
              const authorizedAt = timelineAuthorization.authorizedAt;
              const skippedAt = new Date().toISOString();
              const auditEntry = buildFastMergeAuditEntry({
                action: 'skipped',
                repo: repoPath,
                prNumber,
                categories: fastMergeDecision.categories,
                labels: liveLabels,
                changedFiles: shapeCheck.files,
                shapeCheck,
                authorizedHeadSha,
                authorizedAt,
                skippedAt,
              });
              stmtCreateFastMergeSkippedReviewRow.run(
                repoPath,
                prNumber,
                skippedAt,
                route.reviewerModel,
                linearTicketId,
                JSON.stringify(liveLabels),
                authorizedHeadSha,
                'pending',
                JSON.stringify(auditEntry),
                null
              );
              try {
                writeFastMergeAuditPayload(ROOT, auditEntry);
                markFastMergeAuditWritten({ repo: repoPath, prNumber });
              } catch (err) {
                markFastMergeAuditError({ repo: repoPath, prNumber, err });
                console.error(
                  `[watcher] fast-merge skip audit write failed for ${repoPath}#${prNumber}: ${err?.message || err}`
                );
              }
              console.log(
                `[watcher] Fast-merge skip for ${repoPath}#${prNumber}: ` +
                  `${fastMergeDecision.categories.join(',')} @ ${authorizedHeadSha.slice(0, 12)}`
              );
              await projectGateStatusSafe(stmtGetReviewRow.get(repoPath, prNumber));
              continue;
            } else if (
              authorizedHeadSha
              && timelineAuthorization
              && timelineAuthorization.authorizedHeadSha === authorizedHeadSha
              && shapeCheck?.ok
              && !isFastMergeSkipEnabled()
            ) {
              const authorizedAt = timelineAuthorization.authorizedAt;
              writeFastMergeAuditEntry(ROOT, {
                action: 'would-have-skipped',
                repo: repoPath,
                prNumber,
                categories: fastMergeDecision.categories,
                labels: liveLabels,
                changedFiles: shapeCheck.files,
                shapeCheck,
                authorizedHeadSha,
                authorizedAt,
                skippedAt: null,
              });
              console.log(
                `[watcher] Fast-merge audit-only for ${repoPath}#${prNumber}: ` +
                  `would have skipped ${fastMergeDecision.categories.join(',')} @ ${authorizedHeadSha.slice(0, 12)}`
              );
            } else if (authorizedHeadSha) {
              console.log(
                `[watcher] Fast-merge labels present for ${repoPath}#${prNumber} but authorization or diff shape cannot corroborate the current head; using normal review path`
              );
            }
          }
        }
      }
      if (!existing) {
        stmtCreateReviewRow.run(
          repoPath,
          prNumber,
          new Date().toISOString(),
          route.reviewerModel,
          'open',
          linearTicketId,
          'pending',
          JSON.stringify(Array.isArray(liveLabels) ? liveLabels : (Array.isArray(subject.labels) ? subject.labels : []))
        );
      } else {
        stmtUpdateReviewRouting.run(route.reviewerModel, linearTicketId, repoPath, prNumber);
      }

      const current = stmtGetReviewRow.get(repoPath, prNumber);
      if (current?.review_status === 'pending') {
        healthProbe?.recordOpenPending?.(healthTick, {
          repo: repoPath,
          prNumber,
        });
      }
      await projectGateStatusSafe(current);
      const activeFollowUp = shouldDeferReviewForActiveFollowUp({
        rootDir: ROOT,
        repo: repoPath,
        prNumber,
      });
      if (activeFollowUp.defer) {
        console.log(
          `[watcher] Deferring reviewer for ${repoPath}#${prNumber}: active follow-up job` +
            (activeFollowUp.jobId ? ` ${activeFollowUp.jobId}` : '') +
            ` is ${activeFollowUp.latestJobStatus}`
        );
        continue;
      }
      const cascadeGate = shouldBackoffReviewerSpawn(ROOT, {
        repo: repoPath,
        prNumber,
      });
      if (cascadeGate.shouldBackoff) {
        continue;
      }

      if (!existing) {
        console.log(
          `[watcher] New PR ${repoPath}#${prNumber}: "${prTitle}" → ${route.reviewerModel}` +
            (linearTicketId ? ` (${linearTicketId})` : '')
        );
      } else {
        console.log(
          `[watcher] Retrying PR ${repoPath}#${prNumber}: "${prTitle}" → ${route.reviewerModel}` +
            (linearTicketId ? ` (${linearTicketId})` : '') +
            ` | previous status=${current?.review_status || existing.review_status}`
        );
      }
      // Store normalized label names in reviewed_prs.labels_json. Readers
      // still accept the older GitHub label-object shape for historical rows.
      stmtUpdateReviewLabels.run(JSON.stringify(Array.isArray(subject.labels) ? subject.labels : []), repoPath, prNumber);

      const roundBudgetDecision = evaluateRoundBudgetForReview({
        rootDir: ROOT,
        repo: repoPath,
        prNumber,
        linearTicketId,
        reviewStatus: existing?.review_status || 'pending',
        reviewAttempts: existing?.review_attempts || 0,
      });
      if (roundBudgetDecision.skip) {
        continue;
      }

      const attemptAt = new Date().toISOString();
      const reviewerSessionUuid = randomUUID();
      // After ARA-06's operator-surface carve, the per-PR loop iterates
      // typed `subject` (SubjectState) values from the subject adapter
      // — there is no `pr` GitHub-PR object in scope here. The handle
      // we need to persist is the head SHA we observed at claim time,
      // which is `subject.headSha`. (Was: `pr?.head?.sha`, which raised
      // `ReferenceError: pr is not defined` on every poll cycle for any
      // PR that reached the claim site, silently blocking review spawns.)
      const reviewerHeadSha = subject?.headSha || null;
      const reviewerTimeoutMs = resolveReviewerTimeoutMs();
      const claim = stmtMarkAttemptStarted.run(
        attemptAt,
        reviewerSessionUuid,
        reviewerHeadSha,
        reviewerTimeoutMs,
        repoPath,
        prNumber
      );
      if (claim.changes === 0) {
        // Lost the cross-process compare-and-swap. Either another
        // watcher just claimed this row, or the row's status moved to
        // a non-claimable state (`reviewing`, `failed-orphan`, terminal)
        // between the readback above and the UPDATE here. Either way,
        // do NOT spawn a reviewer; the next poll will see fresh state.
        console.log(
          `[watcher] Lost claim race on ${repoPath}#${prNumber} — another watcher is handling this PR (or its row is now in a non-claimable state). Skipping.`
        );
        continue;
      }
      if (afterClaim) {
        try {
          await afterClaim({
            repoPath,
            prNumber,
            reviewerHeadSha,
            reviewerSessionUuid,
          });
        } catch (err) {
          console.warn(
            `[watcher] afterClaim observer failed for ${repoPath}#${prNumber}; continuing reviewer spawn:`,
            err?.message || err
          );
        }
      }
      await operatorSurface.syncTriageStatus(
        subjectRefWithLinearTicket(subject.ref, linearTicketId, subject.labels),
        'in-review'
      );

      // Freshness re-check (2026-05-18): `subject` was populated from the
      // per-adapter snapshot cache that `discoverSubjects` warmed at the
      // START of the tick. Long ticks (5-min reviewer timeouts × multiple
      // PRs) can take 30+ min, by which time a PR may have been closed,
      // merged, or admin-resolved by the operator. Spawning a reviewer
      // for a PR that's no longer open is wasted work that also delays
      // the next PR's spawn in the serial loop. Re-fetch state directly
      // from GitHub right before the spawn and skip if no longer open.
      try {
        const { data: freshPR } = await octokit.rest.pulls.get({
          owner,
          repo,
          pull_number: prNumber,
        });
        if (freshPR.merged_at) {
          console.log(
            `[watcher] PR ${repoPath}#${prNumber} was merged since tick-start snapshot — marking row + skipping reviewer spawn`
          );
          stmtMarkMerged.run(freshPR.merged_at, repoPath, prNumber);
          continue;
        }
        if (freshPR.state !== 'open') {
          console.log(
            `[watcher] PR ${repoPath}#${prNumber} was closed since tick-start snapshot (state=${freshPR.state}) — marking row + skipping reviewer spawn`
          );
          stmtMarkClosed.run(new Date().toISOString(), repoPath, prNumber);
          continue;
        }
      } catch (err) {
        // Non-fatal — proceed with spawn rather than block. A failed
        // freshness check is no worse than not having one at all.
        console.warn(
          `[watcher] freshness re-check failed for ${repoPath}#${prNumber}; proceeding with spawn:`,
          err?.message || err
        );
      }

      // Final-round inputs come from the durable per-PR follow-up ledger,
      // not from `reviewed_prs.review_attempts`. Two reasons (reviewer
      // blocking issues #1 and #2):
      //
      //   1. `review_attempts` is incremented for failed posts / OAuth
      //      crashes / reviewer timeouts as well as successful posts. A
      //      transient post failure should not count as a remediation
      //      cycle and must not silently trip the lenient threshold.
      //
      //   2. An elevated legacy/operator cap must continue to describe
      //      the active PR cycle when it is higher than the current
      //      risk-class tier. Otherwise a PR that already consumed more
      //      rounds than the new tier allows would be silently cut off.
      //
      // `summarizePRRemediationLedger` reads currentRound from terminal
      // follow-up jobs (the only place a remediation cycle is actually
      // recorded as completed) and the latest job's persisted maxRounds.
      const ledger = summarizePRRemediationLedger(ROOT, {
        repo: repoPath,
        prNumber,
      });
      const roundBudget = resolveRoundBudgetForJob({
        linearTicketId,
        riskClass: ledger.latestRiskClass,
      }, { rootDir: ROOT });
      const latestMaxRounds = Number(ledger.latestMaxRounds);
      const reviewAttemptNumber = ledger.completedRoundsForPR + 1;
      const reviewDbAttemptNumber = Number(current?.review_attempts || 0) + 1;
      const maxRemediationRounds = Number.isInteger(latestMaxRounds) && latestMaxRounds > roundBudget.roundBudget
        ? latestMaxRounds
        : roundBudget.roundBudget;
      const passKind = reviewAttemptNumber > 1 || current?.rereview_requested_at
        ? 'rereview'
        : 'first-pass';

      const result = await spawnReviewer({
        repo: repoPath,
        prNumber,
        reviewerModel: route.reviewerModel,
        botTokenEnv: route.botTokenEnv,
        linearTicketId,
        labels: Array.isArray(subject.labels) ? subject.labels : [],
        builderTag: route.tag,
        crossModelReviewWaived: Boolean(crossModelWaiverReason),
        crossModelReviewWaiverReason,
        reviewerHeadSha,
        reviewAttemptNumber,
        reviewDbAttemptNumber,
        passKind,
        maxRemediationRounds,
        reviewerSessionUuid,
        reviewerTimeoutMs,
        workspacePath: null,
        onReviewerPgid: ({ pgid, spawnedAt }) => {
          persistReviewerPgid({
            pgid,
            reviewerSessionUuid,
            repoPath,
            prNumber,
            startedAt: spawnedAt,
          });
        },
      });
      if (result.ok) {
        healthProbe?.recordSpawn?.(healthTick, { at: attemptAt });
      }

      settleReviewerAttempt({
        rootDir: ROOT,
        repoPath,
        prNumber,
        result,
        maxRemediationRounds,
      });
    }

    // Proactive stuck-merge-agent scan — independent of PR revisit timing.
    // Scope only to PRs whose lifecycle is still active in this tick:
    // current snapshots with `merge-agent-dispatched` plus unresolved
    // durable cleanup records. Historical dispatches outside that set are
    // intentionally ignored.
    try {
      const stuckReports = scanStuckMergeAgentDispatches({
        rootDir: ROOT,
        repo: repoPath,
        activePRs: activeMergeAgentPRs,
        hqPath: null,
      });
      for (const report of stuckReports) {
        const dispatched = {
          decision: 'skip-already-dispatched',
          stuckDetail: report.stuckDetail,
          launchRequestId: report.launchRequestId,
        };
        console.log(
          `[watcher] proactive-stuck-scan ${report.repo}#${report.prNumber}: `
          + `lrq=${report.launchRequestId} `
          + `stuck=${report.stuckDetail.stuckForMinutes}min `
          + `refusals=${report.stuckDetail.refusalCount} `
          + `primary=${report.stuckDetail.primaryReason || 'unknown'}`
        );
        if (report.stuckDetail.stuckForMinutes >= 30) {
          try {
            await maybeFireMergeAgentStuckAlert({
              rootDir: ROOT,
              repoPath: report.repo,
              prNumber: report.prNumber,
              dispatched,
              deliverAlertFn: defaultDeliverAlert,
              logger: console,
            });
          } catch (alertErr) {
            console.error(
              `[watcher] proactive-stuck-scan alert delivery failed for `
              + `${report.repo}#${report.prNumber}: ${alertErr?.message || alertErr}`
            );
          }
        }
      }
    } catch (scanErr) {
      console.error(
        `[watcher] proactive-stuck-scan raised for ${repoPath}: ${scanErr?.message || scanErr}`
      );
    }
  }
  } finally {
    try {
      await healthProbe?.finishTick?.(healthTick);
    } catch (err) {
      console.error('[watcher] health probe finalize failed:', err?.message || err);
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

function requireEnv(name) {
  if (!process.env[name]) {
    console.error(`[watcher] Missing required env var: ${name}`);
    process.exit(1);
  }
}

async function main() {
  requireEnv('GITHUB_TOKEN');
  defaultReviewerRouteFromEnv(process.env);

  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
  const intervalMs = config.pollIntervalMs ?? 300_000;
  const configuredDeadlineMs = config.pollDeadlineMs;

  if (Object.prototype.hasOwnProperty.call(config, 'fallbackReviewer')) {
    console.error(
      '[watcher] config.fallbackReviewer is no longer supported. Remove it from config.json; malformed titles now fail loud and are never auto-routed.'
    );
    process.exit(1);
  }

  // Reconcile any rows stuck in 'reviewing' from a previous watcher
  // run against GitHub first. Only after that should daemon-bounce
  // recovery mark any still-reviewing rows as failed.
  await reconcileOrphanedReviewing(octokit);
  await recoverReviewerRunRecords({
    rootDir: ROOT,
    adapter: reviewerRuntimeAdapter,
    db,
    log: console,
  });

  // Workload-aware deadline: the previous fixed 10m watchdog tripped
  // on legitimate org-wide work (a single reviewer can consume most of
  // the reviewer subprocess deadline, and pollOnce processes repos/PRs
  // serially). Resolve
  // the deadline per-call from the current activeRepos count so the
  // budget grows with the workload. Operators can still pin a fixed
  // value via `config.pollDeadlineMs`; an explicit number always
  // wins over the dynamic default.
  function resolveDeadlineMsForCall() {
    if (Number.isFinite(configuredDeadlineMs) && configuredDeadlineMs > 0) {
      return configuredDeadlineMs;
    }
    return computeWorkloadAwarePollDeadlineMs({
      activeRepoCount: activeRepos.length,
      reviewerTimeoutMs: resolveReviewerTimeoutMs(),
    });
  }

  const watchMode = config.org
    ? `org: ${config.org} (dynamic discovery, refresh every ${(config.repoRefreshIntervalMs ?? 3_600_000) / 60_000}m)`
    : `repos: ${activeRepos.join(', ')}`;
  const deadlineLabel = Number.isFinite(configuredDeadlineMs) && configuredDeadlineMs > 0
    ? `${configuredDeadlineMs / 1000}s (configured)`
    : `workload-aware (default floor ${DEFAULT_POLL_DEADLINE_FLOOR_MS / 1000}s)`;
  console.log(
    `[watcher] Starting — ${watchMode} | poll interval: ${intervalMs / 1000}s | poll deadline: ${deadlineLabel}`
  );

  // Self-scheduling loop. Awaiting safePollOnce before sleeping
  // guarantees no two polls overlap, so the previous overlap-skip
  // scheme is no longer needed. Cadence is fixed-rate: the next
  // start is `lastStart + intervalMs`, and the loop sleeps only the
  // remaining delay (clamped at zero). This preserves the operator-
  // expected meaning of `pollIntervalMs` — a 4m poll on a 5m
  // interval is still ~5m start-to-start, not 9m. The watchdog
  // deadline inside safePollOnce protects against a single hung
  // poll wedging the loop forever — on timeout, exitForPollDeadline
  // aborts in-flight reviewer subprocesses and calls process.exit
  // so launchd KeepAlive respawns a clean process.
  const safePollOnce = buildSafePollOnce({
    pollOnceImpl: pollOnce,
    octokit,
    errorHandler: handlePollError,
    onTimeout: exitForPollDeadline,
    deadlineMs: resolveDeadlineMsForCall,
  });

  (async function pollLoop() {
    let nextStart = Date.now();
    await safePollOnce('startup pollOnce');
    nextStart += intervalMs;
    while (true) {
      // Fixed-rate cadence: subtract elapsed work from the next
      // sleep so cadence is start-to-start, not finish-to-start.
      // Math.max(0, ...) means a poll that ran longer than the
      // interval starts the next pass immediately rather than
      // sleeping for a negative delay.
      const sleepMs = Math.max(0, nextStart - Date.now());
      // The interval-sleep timer is the only handle keeping the
      // event loop alive between polls, so it MUST NOT be unref'd.
      await new Promise((resolve) => setTimeout(resolve, sleepMs));
      await safePollOnce('scheduled pollOnce');
      nextStart += intervalMs;
    }
  })().catch((err) => {
    // Should be unreachable — safePollOnce never rejects, it returns
    // a typed result. This is a backstop for an unexpected throw in
    // the loop scaffolding itself.
    console.error('[watcher] poll loop crashed unexpectedly:', err);
    process.exit(1);
  });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((err) => {
    console.error('[watcher] startup failed:', err);
    process.exit(1);
  });
}

export {
  classifyReviewerFailure,
  evaluateRoundBudgetForReview,
  fastMergeDecisionFromLabels,
  fetchLivePRHeadSha,
  fetchLivePRLabels,
  handlePostedReviewRow,
  maybeFireFleetWideFalseDeferralAlert,
  maybeFireMergeAgentStuckAlert,
  pollOnce,
  persistReviewerPgid,
  readWatcherDrainState,
  reconcileOrphanedReviewing,
  recoverFastMergeVetoes,
  runFastMergeClosePathIsolated,
  resolveMergeAgentLifecycleCleanupPerPoll,
  resolveMergeAgentLifecycleCleanupRetryMs,
  resolveStaleReviewerReconcilePerPoll,
  retryPendingMergeAgentLifecycleCleanups,
  shouldDeferReviewForActiveFollowUp,
  shouldRetryMergeAgentLifecycleCleanup,
  shouldPreserveReviewersOnSigterm,
  shouldReconcileStaleReviewerSession,
  STUCK_DISPATCH_ALERT_DEBOUNCE_MS,
  STUCK_DISPATCH_ALERT_STATE_DIR,
  FLEET_WIDE_FALSE_DEFERRAL_REASON,
  FLEET_WIDE_FALSE_DEFERRAL_WINDOW_MS,
  FLEET_WIDE_FALSE_DEFERRAL_DISTINCT_LRQ_THRESHOLD,
  FLEET_WIDE_FALSE_DEFERRAL_ALERT_DEBOUNCE_MS,
  FLEET_WIDE_FALSE_DEFERRAL_STATE_DIR,
  WATCHER_DRAIN_FILE,
  WATCHER_DRAIN_MAX_MS,
  settleReviewerAttempt,
  writeFastMergeAuditEntry,
};
