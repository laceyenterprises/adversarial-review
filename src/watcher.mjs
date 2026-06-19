/**
 * LAC-11: PR Watcher
 * Polls GitHub every N minutes for new agent-built PRs and spawns reviewer agents.
 * Also tracks PR lifecycle (merged/closed) and syncs status to Linear automatically.
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join } from 'node:path';
import { signalMalformedTitleFailure } from './watcher-fail-loud.mjs';
import { createGitHubPRSubjectAdapter, parseSubjectExternalId } from './adapters/subject/github-pr/index.mjs';
import {
  defaultReviewerRouteFromEnv,
  applyEffectiveReviewerRoute,
  describeCrossModelReviewWaiver,
  isCrossModelReviewWaived,
  routeSubject,
} from './adapters/subject/github-pr/routing.mjs';
import {
  loadRoleConfig,
  resetRoleConfigCache,
  resolveGeminiReviewerMode,
} from './role-config.mjs';
import { createCompositeOperatorSurface } from './adapters/operator/index.mjs';
import {
  MERGE_AGENT_DISPATCHED_LABEL,
  MERGE_AGENT_REQUESTED_LABEL,
  OPERATOR_APPROVED_LABEL,
  legacyLabelEventFromControlResult,
} from './adapters/operator/github-pr-label-controls/index.mjs';
import { ADVERSARIAL_MERGE_REQUESTED_LABEL } from './ama/labels.mjs';
import {
  buildSafePollOnce,
  computeWorkloadAwarePollDeadlineMs,
  DEFAULT_POLL_DEADLINE_FLOOR_MS,
} from './watcher-poll-guard.mjs';
import {
  ensureReviewStateSchema,
  listPendingMergeCloseouts,
  openReviewStateDb,
  requestReviewRereview,
} from './review-state.mjs';
import { scrapeMergeCloseout } from './closeout-scraper.mjs';
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
  readCascadeState,
  recordCascadeFailure,
  shouldBackoffReviewerSpawn,
} from './reviewer-cascade.mjs';
import { infraRecoverableFailureClass, reviewerFailureClassFromStoredRow } from './reviewer-failure-classification.mjs';
import { QUOTA_EXHAUSTED_FAILURE_CLASS, quotaHoldDecision } from './quota-exhaustion.mjs';
import {
  createReviewerRuntimeAdapterByName,
  createReviewerRuntimeAdapterForDomain,
  loadDomainConfig,
  recoverReviewerRunRecords,
} from './adapters/reviewer-runtime/index.mjs';
import {
  readReviewerRunRecord,
  settleReviewerRunRecord,
} from './adapters/reviewer-runtime/run-state.mjs';
import {
  classifyReviewerFailure,
  isReviewerSubprocessTimeout,
} from './adapters/reviewer-runtime/cli-direct/classification.mjs';
import {
  isActiveFollowUpJobStatus,
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
  isMergeAgentDispatchActiveForHead,
  listMergeAgentDispatches,
  listMergeAgentLifecycleCleanups,
  MERGE_AGENT_DISPATCHED_LABEL_ADD_TRANSITION,
  pollFastMergeQueue,
  reconcileProactivePhantomHandoffs,
  resolveFastMergePerPollCap,
  scanStuckMergeAgentDispatches,
  shouldUseReviewerTimeoutExhaustedMergeGate,
  updateMergeAgentLifecycleCleanup,
  upsertMergeAgentLifecycleCleanup,
  validateStartupMergeAgentConfig,
} from './follow-up-merge-agent.mjs';
import { deliverAlert as defaultDeliverAlert } from './alert-delivery.mjs';
import {
  deleteGateRecordsForPR,
  projectAdversarialGateStatus,
  resolveSettledReviewVerdict,
} from './adversarial-gate-status.mjs';
import { fastMergeAuditDir, fastMergeAuditPath } from './fast-merge-audit-storage.mjs';
import { resolveGateStatusContext } from './adversarial-gate-context.mjs';
import { normalizeGithubMergeability } from './github-mergeability.mjs';
// AMA-03 — the closer dispatch path. Default-off behind cfg.enabled
// (AMA-01 defaults to false). When the operator opts in AND the
// canonical eligibility predicate from SPEC §4.2 returns
// `eligible: true`, this fires INSTEAD of the merge-agent dispatch for
// the current tick. Otherwise it's a no-op and the merge-agent path
// runs unchanged. AMA-06A/06N flip the broader coexistence semantics
// once the closer has soaked.
import { maybeDispatchAmaCloser } from './ama/dispatch-closer.mjs';
import { SETTLED_SUCCESS_VERDICTS } from './ama/eligibility.mjs';
import { amaAuthoritativeReviewerLoginsForModel } from './ama/reviewer-authority.mjs';
import {
  COEXISTENCE_ACTION,
  decideMergeAgentCoexistence,
  isMergeAgentRequestedScoped,
  mergeAgentDispatchEnvForAction,
} from './ama/coexistence.mjs';
import { loadConfigCached } from './config-loader.mjs';
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
import { apiStatusFromError, recordApiCall } from './api-telemetry.mjs';
import {
  awaitThrottleIfNeeded,
  extractRateLimitObservation,
  recordResponseRateLimit,
  resolveRateLimitSharedStatePath,
} from './rate-limit-throttle.mjs';
import {
  createWatcherOctokit,
  fetchConditionalRestPage,
} from './conditional-request.mjs';
import { sweepEtagCache } from './etag-cache.mjs';
import { refreshReviewerBrokerTokens, refreshWatcherGithubToken } from './reviewer-broker-refresh.mjs';
import {
  fetchPullRequestHeadAndState,
  fetchPullRequestRollup,
  fetchReviewBodiesForHead,
} from './github-api.mjs';
import { clearPendingReviewsForSelf, reconcilePendingReviewsForSelf } from './reviewer-pre-write.mjs';
import {
  appendFenceAuditEvent,
  classifyFenceOrphan,
  deleteCleanupJob,
  deleteSpawnRecord,
  inspectWatcherExitTimeout,
  isFenceStale,
  listCleanupJobs,
  listFenceJsonPaths,
  listFenceLockPaths,
  loadSpawnRecords,
  moveFenceArtifactToQuarantine,
  probeFenceLock,
  queueFenceCleanupJob,
  readFenceRecord,
  resolveAdversarialReviewStateDir,
  resolveFencePaths,
  resolveSigtermFenceGraceSeconds,
  syncSpawnRecords,
  upsertSpawnRecord,
  validateFenceConfig,
} from './reviewer-fence.mjs';
import {
  compareReviewerDispatchCandidates,
  createReviewerMemoryAdmissionSampler,
  reserveReviewerMemoryAdmission,
  resolveFirstPassReviewerPoolConfig,
  runBoundedReviewerDispatchQueue,
  sortReviewerDispatchCandidates,
} from './watcher-reviewer-pool.mjs';
import {
  computeReviewerLeaseExpiryAt,
  isReviewerLeaseExpired,
  resolveReviewerLeaseRecoveryEnabled,
} from './reviewer-lease.mjs';
import {
  createRoutingTierReadinessProbeCache,
  probeRoutingTierReadiness,
} from './routing-tier-readiness.mjs';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const config = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'));
// Fail fast during watcher bootstrap; a bad gate-context override should not
// leave reviews running while commit-status publication silently stops later.
resolveGateStatusContext(process.env);
let reviewerRuntimeAdapter = createReviewerRuntimeAdapterForDomain({
  rootDir: ROOT,
  domainId: 'code-pr',
  logger: console,
});
let reviewerRuntimeAdapterCache = null;
let lastKnownReviewerOrchestrationMode = 'native';
let activeReviewerRuntimeOrchestrationMode = 'native';
let reviewerRuntimeConfigFailureSignal = { key: null, count: 0 };
let reviewerRuntimeAdapterFailureSignal = { key: null, count: 0 };
const reviewerRuntimeAdapterByNameCache = new Map();

function reviewerRuntimeDomainMtimeMs(rootDir = ROOT, domainId = 'code-pr') {
  return statSync(join(rootDir, 'domains', `${domainId}.json`)).mtimeMs;
}

function shouldEmitReviewerRuntimeFailureSignal(count) {
  return count <= 2 || count === 5 || count % 10 === 0;
}

function recordReviewerRuntimeFailureSignal({ kind, key, message, logger }) {
  const state = kind === 'config'
    ? reviewerRuntimeConfigFailureSignal
    : reviewerRuntimeAdapterFailureSignal;
  if (state.key === key) {
    state.count += 1;
  } else {
    state.key = key;
    state.count = 1;
  }
  if (shouldEmitReviewerRuntimeFailureSignal(state.count)) {
    logger?.error?.(
      `[watcher] ALERT reviewer runtime ${kind} degraded consecutive=${state.count}: ${message}`
    );
  }
}

function clearReviewerRuntimeFailureSignal(kind) {
  if (kind === 'config') {
    reviewerRuntimeConfigFailureSignal = { key: null, count: 0 };
  } else {
    reviewerRuntimeAdapterFailureSignal = { key: null, count: 0 };
  }
}

function reviewerRuntimeAdapterId(adapter = reviewerRuntimeAdapter) {
  try {
    return adapter?.describe?.()?.id || null;
  } catch {
    return null;
  }
}

function signalReviewerRuntimeDomainConfigFailure({
  rootDir = ROOT,
  domainId = 'code-pr',
  err,
  phase,
  logger = console,
} = {}) {
  const errorMessage = String(err?.message || err);
  recordReviewerRuntimeFailureSignal({
    kind: 'adapter',
    key: `domain-config:${rootDir}:${domainId}:${phase}:${errorMessage}`,
    logger,
    message:
      `domain=${domainId} reviewer runtime config unavailable during ${phase}; ` +
      `per-record recovery/cancel will isolate affected records until the shared config is readable: ` +
      errorMessage
  });
}

function reviewerRuntimeAdapterForRunRecord(record = null, {
  rootDir = ROOT,
  logger = console,
} = {}) {
  const runtime = String(record?.runtime || '').trim();
  if (!runtime) return reviewerRuntimeAdapter;
  if (runtime === reviewerRuntimeAdapterId(reviewerRuntimeAdapter)) {
    return reviewerRuntimeAdapter;
  }
  const domainId = record?.domain || 'code-pr';
  let domainMtimeMs = null;
  try {
    domainMtimeMs = reviewerRuntimeDomainMtimeMs(rootDir, domainId);
  } catch (err) {
    signalReviewerRuntimeDomainConfigFailure({ rootDir, domainId, err, phase: 'mtime', logger });
    throw err;
  }

  const domainCacheKey = `${rootDir}\0${domainId}`;
  let domainCache = reviewerRuntimeAdapterByNameCache.get(domainCacheKey);
  if (!domainCache || domainCache.domainMtimeMs !== domainMtimeMs) {
    domainCache = { domainMtimeMs, adaptersByRuntime: new Map() };
    reviewerRuntimeAdapterByNameCache.set(domainCacheKey, domainCache);
  }
  if (!domainCache.adaptersByRuntime.has(runtime)) {
    let domainConfig = null;
    try {
      domainConfig = loadDomainConfig(rootDir, domainId);
    } catch (err) {
      signalReviewerRuntimeDomainConfigFailure({ rootDir, domainId, err, phase: 'load', logger });
      throw err;
    }
    domainCache.adaptersByRuntime.set(runtime, createReviewerRuntimeAdapterByName(runtime, {
      rootDir,
      domainConfig,
      logger,
    }));
  }
  return domainCache.adaptersByRuntime.get(runtime);
}

function refreshReviewerRuntimeAdapter({
  rootDir = ROOT,
  logger = console,
  loadConfigImpl = loadConfigCached,
  createAdapterImpl = createReviewerRuntimeAdapterForDomain,
  domainMtimeImpl = reviewerRuntimeDomainMtimeMs,
} = {}) {
  let orchestrationMode = lastKnownReviewerOrchestrationMode || 'native';
  try {
    orchestrationMode = loadConfigImpl().getOrchestrationMode();
    clearReviewerRuntimeFailureSignal('config');
  } catch (err) {
    const errorMessage = String(err?.message || err);
    recordReviewerRuntimeFailureSignal({
      kind: 'config',
      key: errorMessage,
      logger,
      message:
        `config key=roles.adversarial.orchestration_mode failed (${errorMessage}); ` +
        `keeping reviewer runtime orchestration_mode=${orchestrationMode}; ` +
        `broker token refresh still runs, but later strict config reads may stall review work`
    });
  }

  let domainMtimeMs = null;
  try {
    domainMtimeMs = domainMtimeImpl(rootDir, 'code-pr');
    if (
      reviewerRuntimeAdapterCache?.adapter &&
      reviewerRuntimeAdapterCache.orchestrationMode === orchestrationMode &&
      reviewerRuntimeAdapterCache.domainMtimeMs === domainMtimeMs
    ) {
      lastKnownReviewerOrchestrationMode = orchestrationMode;
      activeReviewerRuntimeOrchestrationMode = orchestrationMode;
      reviewerRuntimeAdapter = reviewerRuntimeAdapterCache.adapter;
      clearReviewerRuntimeFailureSignal('adapter');
      return reviewerRuntimeAdapter;
    }

    reviewerRuntimeAdapter = createAdapterImpl({
      rootDir,
      domainId: 'code-pr',
      logger,
      orchestrationMode,
    });
    reviewerRuntimeAdapterCache = {
      adapter: reviewerRuntimeAdapter,
      domainMtimeMs,
      orchestrationMode,
    };
    lastKnownReviewerOrchestrationMode = orchestrationMode;
    activeReviewerRuntimeOrchestrationMode = orchestrationMode;
    clearReviewerRuntimeFailureSignal('adapter');
  } catch (err) {
    const errorMessage = String(err?.message || err);
    if (orchestrationMode !== activeReviewerRuntimeOrchestrationMode) {
      recordReviewerRuntimeFailureSignal({
        kind: 'adapter',
        key: `${orchestrationMode}->${activeReviewerRuntimeOrchestrationMode}:${errorMessage}`,
        logger,
        message:
          `requested orchestration_mode=${orchestrationMode} but active adapter remains ` +
          `${activeReviewerRuntimeOrchestrationMode}; first-pass reviews continue through the ` +
          `active adapter until refresh succeeds: ${errorMessage}`
      });
    } else {
      recordReviewerRuntimeFailureSignal({
        kind: 'adapter',
        key: `${orchestrationMode}->${activeReviewerRuntimeOrchestrationMode}:${errorMessage}`,
        logger,
        message:
          `orchestration_mode=${orchestrationMode} adapter refresh failed; keeping existing adapter: ` +
          errorMessage
      });
    }
  }
  return reviewerRuntimeAdapter;
}

// ── DB setup ────────────────────────────────────────────────────────────────

const db = openReviewStateDb(ROOT);
ensureReviewStateSchema(db);
const watcherHealthProbe = createWatcherHealthProbe();
const WATCHER_DRAIN_FILE = join(ROOT, 'data', 'watcher-drain.json');
const ADVERSARIAL_REVIEW_STATE_DIR = resolveAdversarialReviewStateDir(ROOT, process.env);
const WATCHER_DRAIN_MAX_MS = 60 * 60 * 1000;
const DEFAULT_DAG_AUTOWALK_ON_MERGE_RETRY_MS = 5 * 60 * 1000;
const DEFAULT_DAG_AUTOWALK_ON_MERGE_PER_POLL = 2;
const DEFAULT_DAG_AUTOWALK_ON_MERGE_MAX_ATTEMPTS = 5;
const DEFAULT_DAG_AUTOWALK_ON_MERGE_TIMEOUT_MS = 2 * 60 * 1000;
const AMA_LIVE_REVIEW_LOOKUP_RETRY_DELAYS_MS = [250, 1_000];
const DEFAULT_MERGE_AGENT_LIFECYCLE_CLEANUP_RETRY_MS = 60 * 1000;
const DEFAULT_MERGE_AGENT_LIFECYCLE_CLEANUP_PER_POLL = 5;
const REVIEWER_LEASE_RECOVERY_ENABLED = resolveReviewerLeaseRecoveryEnabled({ watcherConfig: config });
const DEFAULT_PENDING_DRAFT_RESPAWN_AGE_SECONDS = 900;
const PENDING_DRAFT_RESPAWN_AGE_MIN_SECONDS_FENCE_ON = 60;
const PENDING_DRAFT_RESPAWN_AGE_MIN_SECONDS_FENCE_OFF = 300;
const PENDING_DRAFT_RESPAWN_AGE_MAX_SECONDS = 1800;
const ETAG_CACHE_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const REVIEWER_TIMEOUT_FALLBACK_ROUTE_BY_MODEL = {
  claude: {
    reviewerModel: 'claude',
    botTokenEnv: 'GH_CLAUDE_REVIEWER_TOKEN',
  },
  codex: {
    reviewerModel: 'codex',
    botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN',
  },
  gemini: {
    reviewerModel: 'gemini',
    botTokenEnv: 'GH_GEMINI_REVIEWER_TOKEN',
  },
};
const REVIEWER_IDENTITY_BY_BOT_TOKEN_ENV = Object.freeze({
  GH_CLAUDE_REVIEWER_TOKEN: 'claude-reviewer-lacey',
  GH_CODEX_REVIEWER_TOKEN: 'codex-reviewer-lacey',
  GH_GEMINI_REVIEWER_TOKEN: 'gemini-reviewer-lacey',
});
let lastEtagCacheSweepAtMs = 0;

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

function resolveWatcherDrainMaxMs(env = process.env, options = {}) {
  const cfgValue = loadRoleConfig({
    env,
    topPath: options.topPath,
    modulePaths: options.modulePaths,
    loaderImpl: options.loaderImpl,
    contextKey: 'watcher.max_drain_wait_ms',
  }).get('watcher.max_drain_wait_ms', WATCHER_DRAIN_MAX_MS);
  const parsed = Number(cfgValue);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : WATCHER_DRAIN_MAX_MS;
}

function resolveStuckDispatchAlertDebounceMs(env = process.env, options = {}) {
  const cfgValue = loadRoleConfig({
    env,
    topPath: options.topPath,
    modulePaths: options.modulePaths,
    loaderImpl: options.loaderImpl,
    contextKey: 'watcher.stuck_dispatch_alert_debounce_ms',
  }).get('watcher.stuck_dispatch_alert_debounce_ms', STUCK_DISPATCH_ALERT_DEBOUNCE_MS);
  const parsed = Number(cfgValue);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : STUCK_DISPATCH_ALERT_DEBOUNCE_MS;
}

function apiStatusFromResult(result, fallback = 200) {
  if (Number.isFinite(Number(result?.status))) return Math.trunc(Number(result.status));
  return fallback;
}

async function withApiTelemetry(category, { repo = null, prNumber = null, successStatus = 200 } = {}, action) {
  const startedAt = Date.now();
  try {
    await awaitThrottleIfNeeded();
    const result = await action();
    await recordResponseRateLimit(extractRateLimitObservation(result?.headers));
    recordApiCall({
      category,
      repo,
      prNumber,
      status: apiStatusFromResult(result, successStatus),
      durationMs: Date.now() - startedAt,
    });
    return result;
  } catch (err) {
    await recordResponseRateLimit(extractRateLimitObservation(err?.response?.headers));
    recordApiCall({
      category,
      repo,
      prNumber,
      status: apiStatusFromError(err),
      durationMs: Date.now() - startedAt,
    });
    throw err;
  }
}


function isFastMergeSkipEnabled() {
  return process.env.FML_WATCHER_SKIP_ENABLED === 'true';
}

function resolveSigtermFenceMode(env = process.env) {
  return String(env.ADVERSARIAL_REVIEW_SIGTERM_FENCE || 'on').trim().toLowerCase() === 'off'
    ? 'off'
    : 'on';
}

function resolveReviewerIdentity({ reviewerModel, botTokenEnv } = {}) {
  if (REVIEWER_IDENTITY_BY_BOT_TOKEN_ENV[botTokenEnv]) {
    return REVIEWER_IDENTITY_BY_BOT_TOKEN_ENV[botTokenEnv];
  }
  const normalizedModel = String(reviewerModel || '').trim().toLowerCase();
  if (normalizedModel === 'codex') return 'codex-reviewer-lacey';
  if (normalizedModel === 'gemini') return 'gemini-reviewer-lacey';
  return 'claude-reviewer-lacey';
}

function resolveBotTokenEnvForIdentity(identity) {
  const normalized = String(identity || '').trim().toLowerCase();
  if (normalized.startsWith('codex-reviewer-')) return 'GH_CODEX_REVIEWER_TOKEN';
  if (normalized.startsWith('claude-reviewer-')) return 'GH_CLAUDE_REVIEWER_TOKEN';
  if (normalized.startsWith('gemini-reviewer-')) return 'GH_GEMINI_REVIEWER_TOKEN';
  return null;
}

function resolvePendingDraftRespawnAgeSeconds(env = process.env, options = {}) {
  const raw = loadRoleConfig({
    env,
    topPath: options.topPath,
    modulePaths: options.modulePaths,
    loaderImpl: options.loaderImpl,
    contextKey: 'watcher.pending_draft_review_respawn_age_seconds',
  }).get(
    'watcher.pending_draft_review_respawn_age_seconds',
    DEFAULT_PENDING_DRAFT_RESPAWN_AGE_SECONDS
  );
  const rawText = raw === undefined ? null : String(raw).trim();
  const parsed = raw === undefined
    ? DEFAULT_PENDING_DRAFT_RESPAWN_AGE_SECONDS
    : Number(rawText);
  const fenceMode = resolveSigtermFenceMode(env);
  const min = fenceMode === 'off'
    ? PENDING_DRAFT_RESPAWN_AGE_MIN_SECONDS_FENCE_OFF
    : PENDING_DRAFT_RESPAWN_AGE_MIN_SECONDS_FENCE_ON;

  if (
    !Number.isInteger(parsed) ||
    (rawText !== null && String(parsed) !== rawText)
  ) {
    const err = new Error(
      `ADVERSARIAL_REVIEW_PENDING_DRAFT_RESPAWN_AGE_SECONDS must be an integer seconds value; got ${JSON.stringify(raw)}`
    );
    err.logKey = 'respawn_age_out_of_range';
    throw err;
  }
  if (fenceMode === 'off' && parsed < PENDING_DRAFT_RESPAWN_AGE_MIN_SECONDS_FENCE_OFF) {
    const err = new Error(
      `ADVERSARIAL_REVIEW_PENDING_DRAFT_RESPAWN_AGE_SECONDS=${parsed} is below the fence-off floor ` +
      `${PENDING_DRAFT_RESPAWN_AGE_MIN_SECONDS_FENCE_OFF}s while ADVERSARIAL_REVIEW_SIGTERM_FENCE=off`
    );
    err.logKey = 'respawn_age_below_fence_off_floor';
    throw err;
  }
  if (parsed < min || parsed > PENDING_DRAFT_RESPAWN_AGE_MAX_SECONDS) {
    const err = new Error(
      `ADVERSARIAL_REVIEW_PENDING_DRAFT_RESPAWN_AGE_SECONDS=${parsed} is outside the safe range ` +
      `[${min}, ${PENDING_DRAFT_RESPAWN_AGE_MAX_SECONDS}] for ADVERSARIAL_REVIEW_SIGTERM_FENCE=${fenceMode}`
    );
    err.logKey = 'respawn_age_out_of_range';
    throw err;
  }
  return parsed;
}

function emitWatcherTickReconciliationEvent({
  log = console,
  repoPath,
  prNumber,
  identity,
  listed,
  pendingMine,
  cleared,
  retained,
  retainedReason,
  respawnAgeSeconds,
  respawnDeadlineUtc,
  skippedReason,
} = {}) {
  log.log?.(JSON.stringify({
    schemaVersion: 1,
    event: 'watcher_tick_reconciliation',
    repo: repoPath,
    pr: prNumber,
    identity: identity || null,
    listed,
    pendingMine,
    cleared,
    retained,
    retainedReason: retainedReason || null,
    respawnAgeSeconds,
    respawnDeadlineUtc: respawnDeadlineUtc || null,
    skippedReason: skippedReason || null,
  }));
}

async function reconcilePendingDraftsBeforeSpawn({
  repoPath,
  prNumber,
  botTokenEnv,
  currentHeadSha,
  respawnAgeSeconds = resolvePendingDraftRespawnAgeSeconds(),
  now = new Date(),
  fetchImpl = globalThis.fetch,
  reconcileImpl = reconcilePendingReviewsForSelf,
  log = console,
} = {}) {
  const token = process.env[botTokenEnv];
  const reconciliation = await reconcileImpl({
    repo: repoPath,
    prNumber,
    token,
    currentHeadSha,
    respawnAgeSeconds,
    now,
    fetchImpl,
    log,
  });
  emitWatcherTickReconciliationEvent({
    log,
    repoPath,
    prNumber,
    identity: reconciliation?.selfLogin ?? null,
    listed: reconciliation?.listed ?? 0,
    pendingMine: reconciliation?.pendingMine ?? 0,
    cleared: reconciliation?.cleared ?? 0,
    retained: reconciliation?.retained ?? 0,
    retainedReason: reconciliation?.retainedReason ?? null,
    respawnAgeSeconds,
    respawnDeadlineUtc: reconciliation?.respawnDeadlineUtc ?? null,
    skippedReason: reconciliation?.skippedReason ?? null,
  });
  return {
    ...reconciliation,
    skipSpawn: reconciliation?.shouldSpawn === false,
  };
}

function normalizeLabelName(label) {
  return String(typeof label === 'string' ? label : label?.name || '').trim();
}

function normalizeVocabularyFatigueStem(subject) {
  const withoutPrefix = String(subject || '').replace(/^\[[^\]]*\]\s+/, '').trim();
  const firstWord = withoutPrefix.split(/\s+/)[0] || '';
  const lower = firstWord.toLowerCase();
  if (lower.endsWith('ing') && lower.length > 3) return lower.slice(0, -3);
  if (lower.endsWith('ed') && lower.length > 2) return lower.slice(0, -2);
  return lower;
}

function buildVocabularyFatigueFinding(commitSubjects, {
  window = 5,
  minRepeats = 3,
} = {}) {
  const resolvedWindow = Number.isInteger(window) && window > 0 ? window : 5;
  const resolvedMinRepeats = Number.isInteger(minRepeats) && minRepeats > 0 ? minRepeats : 3;
  const subjects = Array.isArray(commitSubjects) ? commitSubjects : [];
  if (subjects.length < resolvedWindow) return null;

  const stems = subjects
    .slice(-resolvedWindow)
    .map(normalizeVocabularyFatigueStem)
    .filter(Boolean);
  if (stems.length < resolvedWindow) return null;

  const counts = new Map();
  for (const stem of stems) counts.set(stem, (counts.get(stem) || 0) + 1);

  let matchedStem = null;
  let matchedCount = 0;
  for (const [stem, count] of counts.entries()) {
    if (count >= resolvedMinRepeats && count > matchedCount) {
      matchedStem = stem;
      matchedCount = count;
    }
  }
  if (!matchedStem) return null;
  return {
    kind: 'remediation-vocabulary-fatigue',
    severity: 'info',
    blocking: false,
    stem: matchedStem,
    count: matchedCount,
    window: resolvedWindow,
    detail:
      `The verb '${matchedStem}' appears in ${matchedCount} of the last ${resolvedWindow} commit messages. ` +
      'This often signals that the agent has reached the bottom of its vocabulary for change descriptors ' +
      '— a soft churn indicator. See docs/POSTMORTEM-codex-tui-remediation-runaway-2026-06-03.md §6 and §7.',
  };
}

function resolveVocabularyFatigueConfig({
  loadConfigImpl = loadConfigCached,
  logger = console,
} = {}) {
  try {
    const cfg = loadConfigImpl();
    return {
      window: cfg.get('agent_control.codex_runaway_guardrails.vocabulary_fatigue_window_commits', 5),
      minRepeats: cfg.get('agent_control.codex_runaway_guardrails.vocabulary_fatigue_min_repeats', 3),
    };
  } catch (err) {
    logger?.warn?.(
      `[watcher] vocabulary-fatigue cfg load failed; using defaults: ${err?.message || err}`
    );
    return { window: 5, minRepeats: 3 };
  }
}

async function fetchPullRequestCommitSubjects(octokit, {
  owner,
  repo,
  prNumber,
  logger = console,
} = {}) {
  if (typeof octokit?.rest?.pulls?.listCommits !== 'function') {
    throw new Error('octokit.rest.pulls.listCommits unavailable');
  }
  const subjects = [];
  const params = {
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  };
  for (let page = 1; ; page += 1) {
    const response = await fetchConditionalRestPage({
      category: 'other',
      endpoint: 'pulls.commits',
      repo: `${owner}/${repo}`,
      prNumber,
      rootDir: ROOT,
      logger,
      params: { page, per_page: params.per_page },
      request: (requestParams) => octokit.rest.pulls.listCommits({
        ...params,
        ...requestParams,
        page,
      }),
    });
    const commits = Array.isArray(response?.data) ? response.data : [];
    for (const item of commits) {
      const message = String(item?.commit?.message || '');
      const subject = message.split(/\r?\n/)[0].trim();
      if (subject) subjects.push(subject);
    }
    if (commits.length < params.per_page) break;
  }
  return subjects;
}

async function emitVocabularyFatigueFindingForPR({
  octokit,
  repoPath,
  prNumber,
  logger = console,
  loadConfigImpl = loadConfigCached,
  fetchCommitSubjectsImpl = null,
} = {}) {
  const [owner, repo] = String(repoPath || '').split('/');
  if (!owner || !repo || !prNumber) return null;
  const { window, minRepeats } = resolveVocabularyFatigueConfig({ loadConfigImpl, logger });
  let subjects;
  try {
    subjects = fetchCommitSubjectsImpl
      ? await fetchCommitSubjectsImpl({ repoPath, prNumber, owner, repo, window, minRepeats })
      : await fetchPullRequestCommitSubjects(octokit, { owner, repo, prNumber, logger });
  } catch (err) {
    logger?.warn?.(
      `[watcher] vocabulary-fatigue commit fetch failed for ${repoPath}#${prNumber}; ` +
      `continuing without informational finding: ${err?.message || err}`
    );
    return null;
  }
  const finding = buildVocabularyFatigueFinding(subjects, { window, minRepeats });
  if (!finding) return null;
  logger?.info?.(JSON.stringify(finding));
  return finding;
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

function maybeSweepConditionalRequestCache({
  rootDir = ROOT,
  logger = console,
  nowMs = Date.now(),
} = {}) {
  if ((nowMs - lastEtagCacheSweepAtMs) < ETAG_CACHE_SWEEP_INTERVAL_MS) return [];
  lastEtagCacheSweepAtMs = nowMs;
  try {
    const deleted = sweepEtagCache(rootDir, { nowMs });
    if (deleted.length > 0) {
      logger.log?.(`[watcher] pruned ${deleted.length} expired conditional-request cache entries`);
    }
    return deleted;
  } catch (err) {
    logger.warn?.(
      `[watcher] conditional-request cache sweep failed; continuing poll tick: ${err?.message || err}`
    );
    return [];
  }
}

async function fetchLivePRLabels(octokit, { owner, repo, prNumber, logger = console } = {}) {
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

async function fetchLivePRHeadSha({ owner, repo, prNumber, fallbackHeadSha = null, logger = console } = {}) {
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
  debounceMs = resolveStuckDispatchAlertDebounceMs(),
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
  drainMaxMs = resolveWatcherDrainMaxMs(),
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
  const maxExpiresAt = markerMtimeMs + drainMaxMs;
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

// Track durable reviewer runtime session UUIDs for observability on exit.
// Routine daemon bounces must not cancel these children: reviewer
// subprocesses are launched as bounce survivors and startup reconciliation
// re-adopts them via the durable review row plus PGID identity checks.
const inFlightReviewerSessions = new Set();
const activeReviewerSpawns = new Map();
let exitInProgress = false;

async function cancelInFlightReviewerRuntimeSessions(reason) {
  const sessions = Array.from(inFlightReviewerSessions);
  inFlightReviewerSessions.clear();
  await Promise.all(sessions.map(async (sessionUuid) => {
    await cancelReviewerRuntimeSession({ sessionUuid, reason });
  }));
}

async function cancelReviewerRuntimeSession({
  sessionUuid,
  reason,
  rootDir = ROOT,
  logger = console,
  readRunRecord = readReviewerRunRecord,
  adapterForRecord = reviewerRuntimeAdapterForRunRecord,
  defaultAdapter = reviewerRuntimeAdapter,
} = {}) {
  let record = null;
  try {
    record = readRunRecord(rootDir, sessionUuid);
  } catch (err) {
    logger.error?.(
      `[watcher] reviewer_runtime_cancel_record_read_failed session=${sessionUuid} reason=${reason}; using default runtime: ${err?.message || err}`
    );
  }

  let cancelAdapter = defaultAdapter;
  if (record) {
    try {
      cancelAdapter = adapterForRecord(record, { rootDir, logger });
    } catch (err) {
      logger.error?.(
        `[watcher] reviewer_runtime_cancel_adapter_resolve_failed session=${sessionUuid} runtime=${record.runtime} reason=${reason}; using default runtime: ${err?.message || err}`
      );
      cancelAdapter = defaultAdapter;
    }
  }

  try {
    await cancelAdapter.cancel(sessionUuid);
  } catch (err) {
    logger.error?.(
      `[watcher] reviewer_runtime_cancel_failed session=${sessionUuid} reason=${reason}: ${err?.message || err}`
    );
  }
}

function emitFenceAuditEvent(stateDir = ADVERSARIAL_REVIEW_STATE_DIR, event) {
  const payload = {
    schemaVersion: 1,
    ...event,
  };
  console.log(JSON.stringify(payload));
  appendFenceAuditEvent(stateDir, payload);
}

function quarantineCorruptFenceFile(stateDir, filePath, {
  fileKind,
  err,
} = {}) {
  const quarantinedPath = moveFenceArtifactToQuarantine(stateDir, filePath, {
    prefix: `${fileKind || 'file'}-corrupt`,
  });
  emitFenceAuditEvent(stateDir, {
    event: 'fence_corrupted_skipped',
    fileKind: fileKind || null,
    filePath,
    quarantinedPath,
    error: err?.message || String(err),
  });
  return quarantinedPath;
}

async function processQueuedFenceCleanupJobs({
  stateDir = ADVERSARIAL_REVIEW_STATE_DIR,
  clearPendingReviewsImpl = clearPendingReviewsForSelf,
  log = console,
} = {}) {
  let processed = 0;
  for (const jobPath of listCleanupJobs(stateDir)) {
    let job;
    try {
      job = JSON.parse(readFileSync(jobPath, 'utf8'));
    } catch (err) {
      quarantineCorruptFenceFile(stateDir, jobPath, {
        fileKind: 'cleanup-job',
        err,
      });
      continue;
    }
    const tokenEnv = job.botTokenEnv || resolveBotTokenEnvForIdentity(job.identity);
    try {
      if (!tokenEnv) {
        throw new Error(`Unknown reviewer identity ${JSON.stringify(job.identity)}; cannot resolve bot token env`);
      }
      if (!process.env[tokenEnv]) {
        throw new Error(`Missing ${tokenEnv}; cleanup job retained for retry`);
      }
      await clearPendingReviewsImpl({
        repo: job.repo,
        prNumber: job.pr,
        token: process.env[tokenEnv],
        log,
      });
      deleteCleanupJob(jobPath);
      processed += 1;
      emitFenceAuditEvent(stateDir, {
        event: 'fence_cleanup_processed',
        spawnToken: job.spawnToken || null,
        repo: job.repo,
        pr: job.pr,
        identity: job.identity || null,
      });
    } catch (err) {
      emitFenceAuditEvent(stateDir, {
        event: 'fence_cleanup_failed',
        spawnToken: job.spawnToken || null,
        repo: job.repo,
        pr: job.pr,
        identity: job.identity || null,
        error: err?.message || String(err),
      });
    }
  }
  return processed;
}

function queueFenceCleanupFromRecord(record, {
  stateDir = ADVERSARIAL_REVIEW_STATE_DIR,
  botTokenEnv = null,
  reason,
} = {}) {
  queueFenceCleanupJob(stateDir, {
    spawnToken: record.spawnToken,
    repo: record.repo || null,
    pr: record.pr,
    identity: record.identity,
    botTokenEnv: botTokenEnv || null,
    reason,
  });
}

async function sweepReviewerFencesOnStartup({
  stateDir = ADVERSARIAL_REVIEW_STATE_DIR,
  staleTtlSeconds = validateFenceConfig(process.env).staleTtlSeconds,
  activeSpawnMap = activeReviewerSpawns,
} = {}) {
  const persistedSpawnRecords = loadSpawnRecords(stateDir);
  const persistedSpawnTokens = new Set(Object.keys(persistedSpawnRecords));
  const activeSpawnTokens = new Set(activeSpawnMap.keys());
  let orphaned = 0;

  for (const jsonPath of listFenceJsonPaths(stateDir)) {
    let record;
    try {
      record = readFenceRecord(jsonPath);
    } catch (err) {
      quarantineCorruptFenceFile(stateDir, jsonPath, {
        fileKind: 'fence-json',
        err,
      });
      continue;
    }
    const { lockPath } = resolveFencePaths(stateDir, record.spawnToken);
    const lockProbe = probeFenceLock(lockPath);
    const orphanDecision = classifyFenceOrphan({
      record,
      lockProbe,
      activeSpawnTokens,
      persistedSpawnTokens,
      staleTtlSeconds,
    });
    if (!orphanDecision.orphan) {
      continue;
    }

    if (lockProbe.reason === 'lock-missing') {
      emitFenceAuditEvent(stateDir, {
        event: 'fence_lock_missing_with_json',
        spawnToken: record.spawnToken,
        pr: record.pr,
        identity: record.identity,
      });
    }
    const persisted = persistedSpawnRecords[record.spawnToken] || null;
    queueFenceCleanupFromRecord(
      { ...persisted, ...record },
      {
        stateDir,
        botTokenEnv: persisted?.botTokenEnv || null,
        reason: orphanDecision.reason,
      }
    );
    rmSync(jsonPath, { force: true });
    rmSync(lockPath, { force: true });
    delete persistedSpawnRecords[record.spawnToken];
    orphaned += 1;
    emitFenceAuditEvent(stateDir, {
      event: 'fence_orphan_reaped',
      spawnToken: record.spawnToken,
      pr: record.pr,
      identity: record.identity,
      orphanReason: orphanDecision.reason,
    });
  }

  const now = Date.now();
  for (const lockPath of listFenceLockPaths(stateDir)) {
    const spawnToken = basename(lockPath, '.lock');
    const { jsonPath } = resolveFencePaths(stateDir, spawnToken);
    if (existsSync(jsonPath)) continue;
    let ageSeconds = Number.POSITIVE_INFINITY;
    try {
      ageSeconds = (now - statSync(lockPath).mtimeMs) / 1000;
    } catch (err) {
      emitFenceAuditEvent(stateDir, {
        event: 'fence_orphan_lock_probe_failed',
        spawnToken,
        error: err?.message || String(err),
      });
      continue;
    }
    if (ageSeconds <= staleTtlSeconds) continue;
    rmSync(lockPath, { force: true });
    orphaned += 1;
    emitFenceAuditEvent(stateDir, {
      event: 'fence_orphan_lock_reaped',
      spawnToken,
      ageSeconds,
    });
  }

  for (const activeToken of activeSpawnMap.keys()) {
    persistedSpawnRecords[activeToken] = persistedSpawnRecords[activeToken] || activeSpawnMap.get(activeToken);
  }
  syncSpawnRecords(stateDir, persistedSpawnRecords);
  return orphaned;
}

async function waitForActiveReviewerFencesOnSigterm({
  stateDir = ADVERSARIAL_REVIEW_STATE_DIR,
  graceSeconds = resolveSigtermFenceGraceSeconds(process.env),
  staleTtlSeconds = validateFenceConfig(process.env).staleTtlSeconds,
  activeSpawnMap = activeReviewerSpawns,
  queueCleanupOnGraceExpiry = true,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const deadlineMs = Date.now() + (graceSeconds * 1000);
  const remaining = new Map();
  let sawStaleFence = false;
  for (const jsonPath of listFenceJsonPaths(stateDir)) {
    const record = readFenceRecord(jsonPath);
    if (!activeSpawnMap.has(record.spawnToken)) continue;
    const spawnMeta = activeSpawnMap.get(record.spawnToken);
    remaining.set(record.spawnToken, {
      ...record,
      repo: spawnMeta?.repo || null,
      botTokenEnv: spawnMeta?.botTokenEnv || null,
      jsonPath,
      lockPath: resolveFencePaths(stateDir, record.spawnToken).lockPath,
    });
  }
  if (remaining.size === 0) {
    return { status: 'no-active-fence', outstanding: [] };
  }

  while (remaining.size > 0) {
    for (const [spawnToken, record] of remaining.entries()) {
      if (!existsSync(record.jsonPath)) {
        remaining.delete(spawnToken);
        continue;
      }
      if (isFenceStale(record, staleTtlSeconds)) {
        queueFenceCleanupFromRecord(record, {
          stateDir,
          botTokenEnv: record.botTokenEnv,
          reason: 'fence_stuck_open',
        });
        emitFenceAuditEvent(stateDir, {
          event: 'fence_stuck_open',
          spawnToken,
          repo: record.repo,
          pr: record.pr,
          identity: record.identity,
          openedAt: record.openedAt,
        });
        sawStaleFence = true;
        remaining.delete(spawnToken);
        continue;
      }
    }
    if (remaining.size === 0) break;
    if (Date.now() >= deadlineMs) {
      for (const record of remaining.values()) {
        if (queueCleanupOnGraceExpiry) {
          queueFenceCleanupFromRecord(record, {
            stateDir,
            botTokenEnv: record.botTokenEnv,
            reason: 'fence_grace_exceeded',
          });
        }
        emitFenceAuditEvent(stateDir, {
          event: 'fence_grace_exceeded',
          spawnToken: record.spawnToken,
          repo: record.repo,
          pr: record.pr,
          identity: record.identity,
          openedAt: record.openedAt,
          cleanupQueued: queueCleanupOnGraceExpiry,
        });
      }
      return {
        status: 'grace-exceeded',
        outstanding: Array.from(remaining.values()),
      };
    }
    await sleepImpl(250);
  }
  return { status: sawStaleFence ? 'stale' : 'cleared', outstanding: [] };
}

function exitAfterReviewerCleanup({
  code,
  reason,
  source,
  message,
  err = null,
  preserveInFlightReviewers = true,
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
      'FATAL: poll deadline exceeded. Preserving in-flight reviewer runtime sessions so launchd can respawn and reattach',
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
    message: 'uncaughtException; preserving in-flight reviewer runtime sessions before exit',
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
    message: 'unhandledRejection; preserving in-flight reviewer runtime sessions before exit',
  });
});

// Decision: does a SIGTERM preserve in-flight reviewers?
// Pulled out as a pure function so tests can exercise the rule without
// having to fork the watcher process and capture process.exit. The rule is
// now intentionally simple: every routine daemon SIGTERM preserves children.
// Operators use `npm run hard-shutdown` for the distinct cancel-first path.
//
// See `projects/daemon-bounce-safety/SPEC.md` §6a for the contract.
function shouldPreserveReviewersOnSigterm(_drainState) {
  return true;
}

process.on('SIGTERM', () => {
  const drainState = readWatcherDrainState();
  const preserveInFlightReviewers = shouldPreserveReviewersOnSigterm(drainState);
  if (resolveSigtermFenceMode(process.env) === 'off') {
    const message = preserveInFlightReviewers
      ? `SIGTERM received${drainState?.active ? ` during active drain (reason=${drainState?.reason || 'unknown'})` : ''}; preserving in-flight reviewer subprocesses for the next watcher to reattach`
      : 'SIGTERM received; cancelling active reviewer runtime sessions before exit';
    exitAfterReviewerCleanup({
      code: 143,
      reason: preserveInFlightReviewers ? 'SIGTERM-preserve-reviewers' : 'SIGTERM',
      source: 'SIGTERM',
      message,
      preserveInFlightReviewers,
    });
    return;
  }
  const message = preserveInFlightReviewers
    ? `SIGTERM received${drainState?.active ? ` during active drain (reason=${drainState?.reason || 'unknown'})` : ''}; preserving in-flight reviewer subprocesses for the next watcher to reattach`
    : 'SIGTERM received; cancelling active reviewer runtime sessions before exit';
  // Preserve-mode means the reviewer is expected to survive the watcher exit.
  // A grace timeout therefore emits audit only; cleanup is reserved for truly
  // stale fences or non-preserve shutdown paths.
  void waitForActiveReviewerFencesOnSigterm({
    queueCleanupOnGraceExpiry: !preserveInFlightReviewers,
  })
    .catch((err) => {
      console.error('[watcher] fence wait failed during SIGTERM:', err?.message || err);
      return { status: 'fence-wait-error', outstanding: [] };
    })
    .finally(() => {
      exitAfterReviewerCleanup({
        code: 143,
        reason: preserveInFlightReviewers ? 'SIGTERM-preserve-reviewers' : 'SIGTERM',
        source: 'SIGTERM',
        message,
        preserveInFlightReviewers,
      });
    });
});

process.on('SIGINT', () => {
  exitAfterReviewerCleanup({
    code: 130,
    reason: 'SIGINT',
    source: 'SIGINT',
    message: 'SIGINT received; preserving active reviewer runtime sessions before exit',
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
// Bounded auto-recovery of infrastructure-class reviewer failures (2026-06-13
// codex-fleet-spawn incident): failed rows stay operator-visible until the
// normal dispatch path rediscovers the PR and wins the atomic reviewing claim.
// The counter below bounds those claim-path recoveries so a persistent infra
// failure eventually remains terminal instead of retrying forever.
const INFRA_AUTO_RECOVER_CAP = 3;
// Quota-exhaustion (hard provider usage cap) graceful-degradation backoff.
// When a reviewer CLI hits a hard usage cap, HRR's domain is "suspend until the
// cap clears, then resume" — NOT "burn the infra auto-recover budget retrying a
// cap that physically cannot lift yet". The reviewer runs the codex/claude CLI
// directly (outside the dispatch daemon that owns HRR suspend/resume), so this
// gate re-creates the same hold-until-reset behavior in the watcher: while the
// provider-reported reset time (or, if unparseable, a fixed fallback window
// since the last failure) has not elapsed, the row is skipped WITHOUT consuming
// an infra_auto_recover attempt. Once the window clears, normal bounded
// auto-recovery resumes and the cap (INFRA_AUTO_RECOVER_CAP) still applies.
const QUOTA_EXHAUSTED_BACKOFF_MS = 15 * 60 * 1000;
const stmtMarkInfraAutoRecoveryAttemptStarted = db.prepare(
  `UPDATE reviewed_prs
     SET review_status = 'reviewing',
         last_attempted_at = ?,
         reviewer_session_uuid = ?,
         reviewer_started_at = NULL,
         reviewer_head_sha = ?,
         reviewer_timeout_ms = ?,
         reviewer_lease_expires_at = ?,
         reviewer_pgid = NULL,
         failed_at = NULL,
         failure_message = NULL,
         infra_auto_recover_attempts = infra_auto_recover_attempts + 1
   WHERE repo = ?
     AND pr_number = ?
     AND review_status = 'failed'
     AND infra_auto_recover_attempts < ?
     AND (
       (? = 'cascade' AND (
         lower(COALESCE(failure_message, '')) LIKE '[cascade]%' OR
         lower(COALESCE(failure_message, '')) LIKE '%litellm/upstream cascade%' OR
         lower(COALESCE(failure_message, '')) LIKE '%watcher backoff engaged%'
       )) OR
       (? = 'reviewer-timeout' AND lower(COALESCE(failure_message, '')) LIKE '[reviewer-timeout]%') OR
       (? = 'launchctl-bootstrap' AND (
         lower(COALESCE(failure_message, '')) LIKE '[launchctl-bootstrap]%' OR
         lower(COALESCE(failure_message, '')) LIKE '%claude launchctl session bootstrap failed%' OR
         lower(COALESCE(failure_message, '')) LIKE '%launchctlsessionerror%'
       )) OR
       (? = 'oauth-broken' AND lower(COALESCE(failure_message, '')) LIKE '%[oauth-broken]%') OR
       (? = 'quota-exhausted' AND lower(COALESCE(failure_message, '')) LIKE '[quota-exhausted]%')
     )`
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
// Compare-and-swap claim: only flip `pending` rows and expired
// `pending-upstream` backoff rows to
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
//   - `review_status = 'pending-upstream'` — upstream-cascade backoff
//     path. pollOnce gates this state on file-backed nextRetryAfter,
//     and once that window expires the row may be reclaimed for
//     another attempt without burning review_attempts.
// Infrastructure-class `failed` rows use the dedicated
// stmtMarkInfraAutoRecoveryAttemptStarted claim above, which rechecks the
// stored failure class and recovery cap atomically. Non-infrastructure
// `failed` rows must remain failed for operator inspection; the generic claim
// must never erase their failure evidence.
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
         reviewer_lease_expires_at = ?,
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
     AND review_status IN ('pending', 'pending-upstream')`
);
const stmtMarkReviewerPgid = db.prepare(
  `UPDATE reviewed_prs
      SET reviewer_pgid = ?,
          reviewer_started_at = ?,
          reviewer_lease_expires_at = ?
    WHERE reviewer_session_uuid = ?
      AND repo = ?
      AND pr_number = ?
      AND review_status = 'reviewing'`
);
const stmtReleaseReviewerClaim = db.prepare(
  `UPDATE reviewed_prs
      SET review_status = 'pending',
          reviewer_session_uuid = NULL,
          reviewer_started_at = NULL,
          reviewer_head_sha = NULL,
          reviewer_timeout_ms = NULL,
          reviewer_lease_expires_at = NULL,
          reviewer_pgid = NULL
    WHERE reviewer_session_uuid = ?
      AND repo = ?
      AND pr_number = ?
      AND review_status = 'reviewing'`
);
const stmtMarkPosted = db.prepare(
  "UPDATE reviewed_prs SET review_status = 'posted', posted_at = ?, failed_at = NULL, failure_message = NULL, review_attempts = review_attempts + 1, reviewer_lease_expires_at = NULL, infra_auto_recover_attempts = 0 WHERE repo = ? AND pr_number = ?"
);
const stmtMarkFailed = db.prepare(
  "UPDATE reviewed_prs SET review_status = 'failed', failed_at = ?, failure_message = ?, review_attempts = review_attempts + 1, reviewer_lease_expires_at = NULL WHERE repo = ? AND pr_number = ?"
);
const stmtReleaseReviewLease = db.prepare(
  "UPDATE reviewed_prs SET review_status = 'pending', failed_at = ?, failure_message = ?, review_attempts = review_attempts + 1, reviewer_lease_expires_at = NULL WHERE repo = ? AND pr_number = ? AND review_status = 'reviewing'"
);
const stmtMarkCascadeFailed = db.prepare(
  "UPDATE reviewed_prs SET review_status = 'failed', failed_at = ?, failure_message = ?, reviewer_lease_expires_at = NULL WHERE repo = ? AND pr_number = ?"
);
const stmtMarkPendingUpstream = db.prepare(
  "UPDATE reviewed_prs SET review_status = 'pending-upstream', failed_at = ?, failure_message = ?, reviewer_lease_expires_at = NULL WHERE repo = ? AND pr_number = ?"
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
    leaseRecoveryEnabled: REVIEWER_LEASE_RECOVERY_ENABLED,
    onTerminalDeadSession: ({ row, state, settledAt }) => settleDurableReviewerRunState({
      sessionUuid: row?.reviewer_session_uuid,
      state,
      settledAt,
    }),
  });
}

function shouldReconcileStaleReviewerSession(row, now, {
  reviewerTimeoutMs = resolveReviewerTimeoutMs(),
  leaseRecoveryEnabled = REVIEWER_LEASE_RECOVERY_ENABLED,
} = {}) {
  if (leaseRecoveryEnabled && isReviewerLeaseExpired(row, now, { reviewerTimeoutMs })) {
    return true;
  }
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

function shouldReconcileAdoptedReviewerSession(row, {
  rootDir = ROOT,
  log = console,
} = {}) {
  if (!row?.reviewer_session_uuid) return false;
  try {
    const record = readReviewerRunRecord(rootDir, row.reviewer_session_uuid);
    return record?.adoptedAfterBounce === true;
  } catch (err) {
    log.warn?.(
      `[watcher] reviewer_run_state_read_failed session=${row.reviewer_session_uuid} ` +
      `error=${err?.message || err}`
    );
    return false;
  }
}

function shouldReconcileReviewerSession(row, now, options = {}) {
  return shouldReconcileStaleReviewerSession(row, now, options) ||
    shouldReconcileAdoptedReviewerSession(row, options);
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
  reviewerTimeoutMs = resolveReviewerTimeoutMs(),
  log = console,
}) {
  try {
    const leaseExpiresAt = computeReviewerLeaseExpiryAt(startedAt, reviewerTimeoutMs);
    const result = stmtMarkReviewerPgid.run(
      pgid,
      startedAt,
      leaseExpiresAt,
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

  const reviewerSpawnToken = randomUUID();
  const reviewerIdentity = resolveReviewerIdentity({ reviewerModel, botTokenEnv });
  const spawnRecord = {
    spawnToken: reviewerSpawnToken,
    repo,
    pr: prNumber,
    identity: reviewerIdentity,
    botTokenEnv,
    reviewerSessionUuid,
    spawnedAt: new Date().toISOString(),
  };
  try {
    activeReviewerSpawns.set(reviewerSpawnToken, spawnRecord);
    upsertSpawnRecord(ADVERSARIAL_REVIEW_STATE_DIR, spawnRecord);
    inFlightReviewerSessions.add(reviewerSessionUuid);
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
        reviewDbAttemptNumber,
        maxRemediationRounds,
        reviewerSessionUuid,
        reviewerSpawnToken,
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
    activeReviewerSpawns.delete(reviewerSpawnToken);
    deleteSpawnRecord(ADVERSARIAL_REVIEW_STATE_DIR, reviewerSpawnToken);
  }
}

function settleReviewerAttempt({
  rootDir = ROOT,
  repoPath,
  prNumber,
  result,
  failureAt = new Date().toISOString(),
  maxRemediationRounds,
  leaseRecoveryEnabled = REVIEWER_LEASE_RECOVERY_ENABLED,
  statements = {
    markPosted: stmtMarkPosted,
    markFailed: stmtMarkFailed,
    releaseReviewLease: stmtReleaseReviewLease,
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
    'quota-exhausted': 'Reviewer hit a hard provider usage cap; holding until the cap window clears (HRR graceful degradation).',
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
      const transientSettleStatement = leaseRecoveryEnabled
        ? statements.releaseReviewLease
        : statements.markCascadeFailed;
      transientSettleStatement.run(failureAt, classifiedMessage, repoPath, prNumber);
    }
    log.warn(
      `[watcher] Reviewer ${failureClass} failure on #${prNumber} (consecutiveTransient=${cascadeState.consecutiveTransientFailures}); backing off ${cascadeState.backoffMinutes}m`
    );
    return;
  }

  clearCascadeState(rootDir, { repo: repoPath, prNumber });
  const terminalFailureStatement = leaseRecoveryEnabled
    ? statements.releaseReviewLease
    : statements.markFailed;
  terminalFailureStatement.run(failureAt, classifiedMessage, repoPath, prNumber);
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

// "Active follow-up exists for this PR; do not spawn a new first-pass
// reviewer." Delegates to the shared status predicate exported from
// follow-up-jobs.mjs so the watcher, operator-retrigger paths, and
// internal requeue helper all agree on what "active" means. Forgetting
// even one spelling here caused the 2026-05-31 same-SHA duplicate
// reviews on PRs #1151 / #1164 / #1165 (the watcher's inline list
// missed `'in_progress'` — the underscore form that
// markFollowUpJobClaimed / markFollowUpJobSpawned actually persist).
function isActiveFollowUpJob(job) {
  return isActiveFollowUpJobStatus(job?.status);
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

function subjectRefWithLinearTicket(subjectRef, linearTicketId, labels = []) {
  return {
    ...subjectRef,
    linearTicketId,
    labels: Array.isArray(labels) ? labels : [],
  };
}

function normalizeLabelNames(labels = []) {
  return (Array.isArray(labels) ? labels : [])
    .map((label) => (typeof label === 'string' ? label : label?.name))
    .map((label) => String(label || '').trim())
    .filter(Boolean);
}

// ── Org repo discovery ───────────────────────────────────────────────────────

let activeRepos = config.repos ?? [];
let lastRepoRefresh = 0;
const adversarialGateBranchProtectionChecker = createBranchProtectionChecker({
  execFileImpl: execFileAsync,
});
const DEFAULT_STALE_REVIEWER_RECONCILE_PER_POLL = 3;
const DEFAULT_REVIEWER_TIMEOUT_FALLBACK_THRESHOLD = 2;

function resolveReviewerTimeoutFallbackThreshold(env = process.env) {
  const raw = env.ADVERSARIAL_REVIEW_TIMEOUT_FALLBACK_THRESHOLD;
  if (raw === undefined || raw === null || raw === '') return DEFAULT_REVIEWER_TIMEOUT_FALLBACK_THRESHOLD;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) return DEFAULT_REVIEWER_TIMEOUT_FALLBACK_THRESHOLD;
  return parsed;
}

function resolveReviewerTimeoutFallbackModel(env = process.env) {
  const raw = String(env.ADVERSARIAL_REVIEW_TIMEOUT_FALLBACK_MODEL || 'off').trim().toLowerCase();
  if (raw === '0' || raw === 'false' || raw === 'off' || raw === 'none') return null;
  if (raw === 'claude' || raw === 'codex') return raw;
  return null;
}

function normalizeReviewerAttribution(value) {
  return String(value || '').trim().toLowerCase();
}

function rowReviewerMatches(row, expectedReviewerModel) {
  const expected = normalizeReviewerAttribution(expectedReviewerModel);
  if (!expected) return true;
  const candidates = [
    row?.reviewer,
    row?.reviewer_model,
    row?.reviewerModel,
    row?.reviewer_class,
  ].map(normalizeReviewerAttribution).filter(Boolean);
  return candidates.some((candidate) => candidate === expected);
}

// GMW-02 fallback signal. `reviewer.gemini.mode=fallback` selects gemini only
// when the assigned primary reviewer is quota-capped. We reuse the HRR
// quota-exhaustion signal, but only when the failed row is attributed to the
// primary reviewer Gemini would replace. If Gemini already handled a retry and
// then hit quota, the row must remain on the normal quota hold instead of
// recursively selecting Gemini again.
function primaryReviewerQuotaCappedForRow(row, { nowMs = null, expectedReviewerModel = null } = {}) {
  if (!row || row.review_status !== 'failed') return false;
  if (!rowReviewerMatches(row, expectedReviewerModel)) return false;
  if (infraRecoverableFailureClass(row) !== QUOTA_EXHAUSTED_FAILURE_CLASS) return false;
  return quotaHoldDecision(row, {
    nowMs,
    fallbackBackoffMs: QUOTA_EXHAUSTED_BACKOFF_MS,
  }).hold;
}

function shouldBypassPrimaryReviewerQuotaHold(route, row = null) {
  if (row && !rowReviewerMatches(row, route?.geminiReviewerSelection?.replacedReviewerModel)) {
    return false;
  }
  const reason = route?.geminiReviewerSelection?.reason;
  return (
    route?.reviewerModel === 'gemini'
    && route?.botTokenEnv === 'GH_GEMINI_REVIEWER_TOKEN'
    && (
      (
        route?.geminiReviewerSelection?.mode === 'fallback'
        && reason === 'primary-reviewer-quota-capped'
      )
      || (
        route?.geminiReviewerSelection?.mode === 'always-on'
        && reason === 'always-on-third-reviewer'
      )
    )
  );
}

function resolveGeminiReviewerModeForWatcher({
  env = process.env,
  resolver = resolveGeminiReviewerMode,
} = {}) {
  try {
    return { mode: resolver({ env }), error: null };
  } catch (err) {
    return { mode: 'off', error: err };
  }
}

function selectReviewerRouteForAttempt({
  subject,
  baseRoute,
  rootDir,
  repoPath,
  prNumber,
  env = process.env,
}) {
  const threshold = resolveReviewerTimeoutFallbackThreshold(env);
  if (threshold <= 0) return baseRoute;
  const cascadeState = readCascadeState(rootDir, { repo: repoPath, prNumber });
  const timeoutFailures = Number(cascadeState?.transientFailureBreakdown?.['reviewer-timeout'] || 0);
  if (cascadeState?.lastFailureClass !== 'reviewer-timeout' || timeoutFailures < threshold) {
    return baseRoute;
  }
  const fallbackModel = resolveReviewerTimeoutFallbackModel(env);
  if (!fallbackModel || fallbackModel === baseRoute?.reviewerModel) return baseRoute;
  const fallbackRoute = REVIEWER_TIMEOUT_FALLBACK_ROUTE_BY_MODEL[fallbackModel];
  if (!fallbackRoute) return baseRoute;
  const builderClass = subject?.builderClass || baseRoute.builderClass || null;
  return {
    ...baseRoute,
    reviewerModel: fallbackRoute.reviewerModel,
    botTokenEnv: fallbackRoute.botTokenEnv,
    timeoutFallback: {
      fromReviewerModel: baseRoute.reviewerModel,
      toReviewerModel: fallbackRoute.reviewerModel,
      timeoutFailures,
      threshold,
      builderClass,
      sameModelAsBuilder: isCrossModelReviewWaived(builderClass, fallbackRoute.reviewerModel),
    },
  };
}

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

  const repoLabel = config.org ? `${config.org}/*` : null;
  const params = {
    org: config.org,
    type: 'all',
    per_page: 100,
  };

  try {
    const all = [];
    if (typeof octokit.paginate?.iterator === 'function') {
      for await (const response of octokit.paginate.iterator(octokit.rest.repos.listForOrg, params)) {
        recordApiCall({
          category: 'other',
          repo: repoLabel,
          status: apiStatusFromResult(response),
          durationMs: null,
        });
        all.push(...(response?.data || []));
      }
    } else {
      const startedAt = Date.now();
      const repos = await octokit.paginate(octokit.rest.repos.listForOrg, params);
      recordApiCall({
        category: 'other',
        repo: repoLabel,
        status: 200,
        durationMs: Date.now() - startedAt,
      });
      all.push(...repos);
    }

    const excluded = new Set(config.excludeRepos ?? []);
    activeRepos = all
      .filter((r) => !r.archived && !excluded.has(r.name) && !excluded.has(`${config.org}/${r.name}`))
      .map((r) => `${config.org}/${r.name}`);

    lastRepoRefresh = now;
    console.log(`[watcher] Org repos refreshed — watching ${activeRepos.length} repos: ${activeRepos.join(', ')}`);
  } catch (err) {
    recordApiCall({
      category: 'other',
      repo: repoLabel,
      status: apiStatusFromError(err),
      durationMs: null,
    });
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
    headSha: pr?.headRefOid || pr?.head?.sha || null,
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

function sanitizeDagAutowalkPathSegment(value) {
  return String(value || 'unknown').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 180) || 'unknown';
}

function dagAutowalkOnMergeDir(rootDir = ROOT) {
  return join(rootDir, 'data', 'follow-up-jobs', 'dag-autowalk-on-merge');
}

function dagAutowalkOnMergePath(rootDir, { repo, prNumber }) {
  const repoKey = sanitizeDagAutowalkPathSegment(repo);
  const prKey = sanitizeDagAutowalkPathSegment(prNumber);
  return join(dagAutowalkOnMergeDir(rootDir), `${repoKey}-pr-${prKey}.json`);
}

function readDagAutowalkOnMergeRecord(recordPath) {
  try {
    return JSON.parse(readFileSync(recordPath, 'utf8'));
  } catch {
    return null;
  }
}

function writeDagAutowalkOnMergeRecord(rootDir, record) {
  writeFileAtomic(
    dagAutowalkOnMergePath(rootDir, record),
    `${JSON.stringify(record, null, 2)}\n`
  );
}

function writeDagAutowalkOnMergeRecordPath(recordPath, record) {
  writeFileAtomic(recordPath, `${JSON.stringify(record, null, 2)}\n`);
}

function listDagAutowalkOnMergeRecords(rootDir = ROOT) {
  const dir = dagAutowalkOnMergeDir(rootDir);
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        const path = join(dir, name);
        const record = readDagAutowalkOnMergeRecord(path);
        return record ? { path, record } : null;
      })
      .filter(Boolean)
      .sort((a, b) => String(a.record.createdAt || '').localeCompare(String(b.record.createdAt || '')));
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
}

function resolveDagAutowalkOnMergeRetryMs(env = process.env) {
  const raw = Number.parseInt(
    env.ADVERSARIAL_DAG_AUTOWALK_ON_MERGE_RETRY_MS || `${DEFAULT_DAG_AUTOWALK_ON_MERGE_RETRY_MS}`,
    10
  );
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_DAG_AUTOWALK_ON_MERGE_RETRY_MS;
}

function resolveDagAutowalkOnMergePerPoll(env = process.env) {
  const raw = Number.parseInt(
    env.ADVERSARIAL_DAG_AUTOWALK_ON_MERGE_PER_POLL || `${DEFAULT_DAG_AUTOWALK_ON_MERGE_PER_POLL}`,
    10
  );
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_DAG_AUTOWALK_ON_MERGE_PER_POLL;
}

function resolveDagAutowalkOnMergeMaxAttempts(env = process.env) {
  const raw = Number.parseInt(
    env.ADVERSARIAL_DAG_AUTOWALK_ON_MERGE_MAX_ATTEMPTS || `${DEFAULT_DAG_AUTOWALK_ON_MERGE_MAX_ATTEMPTS}`,
    10
  );
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DAG_AUTOWALK_ON_MERGE_MAX_ATTEMPTS;
}

function resolveDagAutowalkOnMergeTimeoutMs(env = process.env) {
  const raw = Number.parseInt(
    env.ADVERSARIAL_DAG_AUTOWALK_ON_MERGE_TIMEOUT_MS || `${DEFAULT_DAG_AUTOWALK_ON_MERGE_TIMEOUT_MS}`,
    10
  );
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DAG_AUTOWALK_ON_MERGE_TIMEOUT_MS;
}

function isMalformedDagAutowalkOnMergeRecord(record) {
  return !record?.repo || !record?.prNumber;
}

function failMalformedDagAutowalkOnMergeRecord(recordPath, record, {
  logger = console,
  now = new Date(),
  maxAttempts = resolveDagAutowalkOnMergeMaxAttempts(),
} = {}) {
  const updatedAt = now.toISOString();
  const failed = {
    ...record,
    status: 'failed',
    attempts: Math.max(Number(record?.attempts || 0), maxAttempts),
    updatedAt,
    lastError: {
      message: 'Malformed dag autowalk-on-merge record: missing repo or prNumber',
      code: 'malformed-record',
      signal: null,
      exitCode: null,
      stdout: '',
      stderr: '',
    },
  };
  writeDagAutowalkOnMergeRecordPath(recordPath, failed);
  logger.error?.(
    `[watcher] dag autowalk-on-merge malformed owed record marked failed at ${recordPath}: ` +
    'missing repo or prNumber'
  );
  return failed;
}

function shouldRetryDagAutowalkOnMerge(record, {
  nowMs = Date.now(),
  retryMs = resolveDagAutowalkOnMergeRetryMs(),
  maxAttempts = resolveDagAutowalkOnMergeMaxAttempts(),
} = {}) {
  if (!record || record.status === 'succeeded') return false;
  if (record.status === 'failed' && Number(record.attempts || 0) >= maxAttempts) return false;
  if (!record.lastAttemptAt) return true;
  const lastAttemptMs = Date.parse(record.lastAttemptAt);
  if (!Number.isFinite(lastAttemptMs)) return true;
  return nowMs - lastAttemptMs >= retryMs;
}

/**
 * Persist owed `hq dag autowalk-on-merge` work for a just-merged PR.
 *
 * On AMA-enabled hosts PRs merge via this pipeline (AMA closer / merge-agent)
 * using `gh pr merge`, not `hq adjudicate merge`, so the legacy D5 dag_on_merge
 * step-advance is dead and the periodic `hq dag autowalk --all` sweep can window
 * out a specific failed-but-merged step for many ticks. The watcher records a
 * durable owed-work file before marking the PR merged, then attempts the
 * targeted autowalk through the bounded retry path below. The record is removed
 * only after the command exits successfully; failures retain stdout/stderr and
 * exit details for operator diagnosis and retry on later watcher ticks.
 */
function fireDagAutowalkOnMerge({
  repo,
  prNumber,
  rootDir = ROOT,
  now = new Date(),
  logger = console,
} = {}) {
  const recordPath = dagAutowalkOnMergePath(rootDir, { repo, prNumber });
  const existing = readDagAutowalkOnMergeRecord(recordPath);
  if (existing?.status && existing.status !== 'succeeded') {
    logger.log?.(`[watcher] dag autowalk-on-merge already owed for ${repo}#${prNumber}`);
    return existing;
  }
  const record = {
    schemaVersion: 1,
    repo,
    prNumber: Number(prNumber),
    status: 'pending',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    attempts: 0,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: null,
  };
  writeDagAutowalkOnMergeRecord(rootDir, record);
  logger.log?.(`[watcher] dag autowalk-on-merge owed for ${repo}#${prNumber}`);
  return record;
}

async function attemptDagAutowalkOnMerge({
  rootDir = ROOT,
  record,
  execFileImpl = execFileAsync,
  hqPath = process.env.HQ_BIN || 'hq',
  logger = console,
  now = new Date(),
  timeoutMs = resolveDagAutowalkOnMergeTimeoutMs(),
  maxAttempts = resolveDagAutowalkOnMergeMaxAttempts(),
} = {}) {
  const repo = record?.repo;
  const prNumber = record?.prNumber;
  if (!repo || !prNumber) return { ok: false, skipped: true, reason: 'malformed-record' };

  const attempts = Number(record.attempts || 0) + 1;
  const startedAt = now.toISOString();
  const base = {
    ...record,
    status: 'running',
    attempts,
    lastAttemptAt: startedAt,
    updatedAt: startedAt,
  };
  writeDagAutowalkOnMergeRecord(rootDir, base);

  const args = ['dag', 'autowalk-on-merge', '--repo', String(repo), '--pr', String(prNumber)];
  try {
    const result = await execFileImpl(hqPath, args, {
      timeout: timeoutMs,
      maxBuffer: 5 * 1024 * 1024,
    });
    rmSync(dagAutowalkOnMergePath(rootDir, record), { force: true });
    logger.log?.(`[watcher] dag autowalk-on-merge succeeded for ${repo}#${prNumber}`);
    return { ok: true, stdout: result?.stdout || '', stderr: result?.stderr || '' };
  } catch (err) {
    const failedAt = new Date().toISOString();
    const terminal = attempts >= maxAttempts;
    const failed = {
      ...base,
      status: terminal ? 'failed' : 'pending',
      updatedAt: failedAt,
      lastError: {
        message: err?.message || String(err),
        code: err?.code ?? null,
        signal: err?.signal ?? null,
        exitCode: err?.exitCode ?? err?.code ?? null,
        stdout: err?.stdout || '',
        stderr: err?.stderr || '',
      },
    };
    writeDagAutowalkOnMergeRecord(rootDir, failed);
    logger.error?.(
      `[watcher] dag autowalk-on-merge failed for ${repo}#${prNumber} ` +
      `(attempt ${attempts}/${maxAttempts}): ${err?.message || err}`
    );
    return { ok: false, terminal, error: err };
  }
}

async function retryPendingDagAutowalkOnMerge({
  rootDir = ROOT,
  execFileImpl = execFileAsync,
  logger = console,
  nowMs = Date.now(),
  retryMs = resolveDagAutowalkOnMergeRetryMs(),
  maxPerPoll = resolveDagAutowalkOnMergePerPoll(),
  maxAttempts = resolveDagAutowalkOnMergeMaxAttempts(),
} = {}) {
  if (maxPerPoll <= 0) return { attempted: 0, skipped: 0, pending: 0 };
  const pending = listDagAutowalkOnMergeRecords(rootDir);
  let attempted = 0;
  let skipped = 0;
  for (const item of pending) {
    if (isMalformedDagAutowalkOnMergeRecord(item.record)) {
      skipped += 1;
      failMalformedDagAutowalkOnMergeRecord(item.path, item.record, { logger, maxAttempts });
      continue;
    }
    if (
      attempted >= maxPerPoll
      || !shouldRetryDagAutowalkOnMerge(item.record, { nowMs, retryMs, maxAttempts })
    ) {
      skipped += 1;
      continue;
    }
    attempted += 1;
    await attemptDagAutowalkOnMerge({
      rootDir,
      record: item.record,
      execFileImpl,
      logger,
      maxAttempts,
    });
  }
  return { attempted, skipped, pending: pending.length };
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

    let pr;
    let labelNames = [];
    try {
      const freshState = await fetchPullRequestHeadAndState(repo, prNumber, {
        execFileImpl: execFileAsync,
      });
      labelNames = normalizeLabelNames(freshState.labels);
      pr = {
        ...freshState,
        labels: freshState.labels,
      };
    } catch (err) {
      console.error(`[watcher] Failed to fetch PR ${repo}#${prNumber}:`, err.message);
      continue;
    }

    if (pr.mergedAt) {
      console.log(`[watcher] PR ${repo}#${prNumber} was merged — syncing Linear`);
      await queueAndAttemptMergeAgentLifecycleCleanup({
        pr, repo, prNumber, transition: 'merged',
      });
      // Advance the merged PR's dag-run (AMA D5 gate). Persist the owed work
      // before marking the lifecycle transition merged so a local state-write
      // failure leaves this row eligible for the next watcher tick.
      try {
        fireDagAutowalkOnMerge({ repo, prNumber });
      } catch (err) {
        console.error(
          `[watcher] dag autowalk-on-merge owed-record write failed for ${repo}#${prNumber}; ` +
          `leaving lifecycle row open for retry: ${err?.message || err}`
        );
        continue;
      }
      stmtMarkMerged.run(pr.mergedAt, repo, prNumber);
      // Closeout capture is intentionally NOT awaited inline here. The
      // gh retry budget for a single scrape (~30–45s worst case) would
      // otherwise stall the gates-deletion and Linear triage sync for
      // every later PR on the open-list when two or more merge between
      // polls. retryPendingMergeCloseouts runs later in the same
      // pollOnce tick and picks up this freshly-merged row from the
      // pending list.
      deleteGateRecordsForPR(ROOT, { repo, prNumber });
      await operatorSurface.syncTriageStatus(
        subjectRefWithLinearTicket({
          domainId: 'code-pr',
          subjectExternalId: `${repo}#${prNumber}`,
          revisionRef: pr.headRefOid || null,
        }, linearTicketId, labelNames),
        'finalized'
      );
    } else if (pr.state === 'closed') {
      console.log(`[watcher] PR ${repo}#${prNumber} was closed (unmerged) — syncing Linear`);
      await queueAndAttemptMergeAgentLifecycleCleanup({
        pr, repo, prNumber, transition: 'closed',
      });
      stmtMarkClosed.run(pr.closedAt ?? new Date().toISOString(), repo, prNumber);
      deleteGateRecordsForPR(ROOT, { repo, prNumber });
      await operatorSurface.syncTriageStatus(
        subjectRefWithLinearTicket({
          domainId: 'code-pr',
          subjectExternalId: `${repo}#${prNumber}`,
          revisionRef: pr.headRefOid || null,
        }, linearTicketId, labelNames),
        'halted'
      );
    }
    // Still open → nothing to do
  }
}

async function attemptMergeCloseoutCapture({
  octokit,
  repo,
  prNumber,
  mergedAt,
  now = new Date(),
  logger = console,
} = {}) {
  const [owner, repoName] = String(repo || '').split('/');
  const result = await scrapeMergeCloseout({
    db,
    repo,
    prNumber,
    mergedAt,
    now,
    execFileImpl: execFileAsync,
    logger,
    fetchIssueCommentsImpl: async () => {
      if (typeof octokit?.rest?.issues?.listComments !== 'function') {
        throw new Error('octokit.rest.issues.listComments unavailable');
      }
      const comments = [];
      const params = {
        owner,
        repo: repoName,
        issue_number: prNumber,
        per_page: 100,
      };
      for (let page = 1; ; page += 1) {
        const response = await fetchConditionalRestPage({
          category: 'other',
          endpoint: 'issues.comments',
          repo,
          prNumber,
          rootDir: ROOT,
          logger,
          params: { page, per_page: params.per_page },
          request: (requestParams) => octokit.rest.issues.listComments({
            ...params,
            ...requestParams,
            page,
          }),
        });
        const pageComments = Array.isArray(response?.data) ? response.data : [];
        comments.push(...pageComments.map((comment) => ({
          id: comment?.node_id ?? null,
          login: comment?.user?.login ?? null,
          created_at: comment?.created_at ?? null,
          body: comment?.body ?? '',
        })));
        if (pageComments.length < params.per_page) break;
      }
      return comments;
    },
  });
  if (!result.ok) {
    logger.warn?.(
      `[watcher] merge closeout capture still owed for ${repo}#${prNumber}`
    );
    return result;
  }
  logger.log?.(
    `[watcher] merge closeout scrape ${repo}#${prNumber}: comments=${result.commentCount} settled_empty=${result.settledEmpty}`
  );
  return result;
}

// Cap per-tick batch so a backlog of dozens-to-hundreds of merged-but-
// uncaptured PRs (steady state after a watcher outage, SQLite restore,
// or upstream gh blip) does not stall the poll loop for hours behind a
// serial `gh api --paginate` × retry budget per row. Freshly-merged
// rows have the highest pending-query priority; chronic failures sort
// to the bottom via scrape_attempt_count.
const PENDING_MERGE_CLOSEOUTS_PER_TICK = 20;
// Hard wall-clock budget per tick. The serial `await` shape means a row
// stuck on the gh retry path costs ~45s; without a budget the per-tick
// cap of 20 can theoretically burn ~15 minutes of poll-loop time while
// fast-merge / open-PR sweep work is starved. The budget is checked
// between rows: we never abort a row mid-flight (so its DB writes stay
// consistent), but once the budget is spent the remaining rows are
// left for the next tick. Freshly-merged rows always come first via
// the listPendingMergeCloseouts ordering, so what gets deferred is the
// chronic-failure tail — exactly the rows it is safe to defer.
const PENDING_MERGE_CLOSEOUTS_BUDGET_MS = 60_000;

function resolveOrchestrationMode({
  loadedConfig = null,
  loadConfigImpl = loadConfigCached,
  logger = console,
  context = 'merge-agent dispatch',
} = {}) {
  let orchestrationMode = 'native';
  try {
    const cfg = loadedConfig || loadConfigImpl();
    if (typeof cfg?.getOrchestrationMode === 'function') {
      orchestrationMode = cfg.getOrchestrationMode() || 'native';
    }
  } catch (cfgErr) {
    logger?.warn?.(
      `[watcher] orchestration_mode load failed for ${context}; defaulting to native: ${cfgErr?.message || cfgErr}`,
    );
  }
  return orchestrationMode;
}

async function retryPendingMergeCloseouts({
  octokit,
  limit = PENDING_MERGE_CLOSEOUTS_PER_TICK,
  budgetMs = PENDING_MERGE_CLOSEOUTS_BUDGET_MS,
  logger = console,
} = {}) {
  // Pass `now` per-iteration: a serial loop across the batch can take
  // several minutes under backlog, and a stale `now` would flip
  // settle-empty decisions for the last few PRs by minutes.
  const rows = listPendingMergeCloseouts(db, { limit, now: new Date() });
  const startedAt = Date.now();
  let processed = 0;
  for (const row of rows) {
    if (!row?.merged_at) continue;
    if (Number.isFinite(budgetMs) && budgetMs > 0 && Date.now() - startedAt >= budgetMs) {
      const remaining = rows.length - processed;
      logger.warn?.(
        `[watcher] merge closeout capture budget (${budgetMs}ms) spent after ${processed} rows; deferring ${remaining} to next tick`
      );
      break;
    }
    await attemptMergeCloseoutCapture({
      octokit,
      repo: row.repo,
      prNumber: row.pr_number,
      mergedAt: row.merged_at,
      now: new Date(),
      logger,
    });
    processed += 1;
  }
}

// ── AMA-03: closer dispatch pre-empt ─────────────────────────────────────────

function isTransientAmaLiveReviewLookupError(err) {
  const haystack = [
    err?.code,
    err?.name,
    err?.message,
    err?.stderr,
    err?.stdout,
    err?.status,
    err?.statusCode,
    err?.response?.status,
    err?.response?.statusCode,
  ]
    .filter((part) => part !== undefined && part !== null)
    .map((part) => String(part))
    .join('\n')
    .toLowerCase();

  if (!haystack) return false;
  if (/\b(401|403|404|422)\b/.test(haystack)) return false;
  if (/\b(econnreset|etimedout|eai_again|enotfound|econnrefused|socket hang up)\b/.test(haystack)) {
    return true;
  }
  return (
    /\b(429|502|503|504)\b/.test(haystack) ||
    /timed?\s*out|timeout|tls handshake|temporary failure|temporarily unavailable/.test(haystack) ||
    /rate limit|rate-limit|secondary rate limit|abuse detection/.test(haystack)
  );
}

async function fetchLatestHeadReviewBodiesWithRetry({
  repoPath,
  prNumber,
  headSha,
  authoritativeReviewerLogins,
  fetchLatestHeadReviewBodiesImpl,
  retryDelaysMs = AMA_LIVE_REVIEW_LOOKUP_RETRY_DELAYS_MS,
  logger,
}) {
  const delays = Array.isArray(retryDelaysMs) ? retryDelaysMs : [];
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      return await fetchLatestHeadReviewBodiesImpl(repoPath, prNumber, headSha, {
        authoritativeReviewerLogins,
      });
    } catch (err) {
      const canRetry = attempt < delays.length && isTransientAmaLiveReviewLookupError(err);
      if (!canRetry) throw err;
      const delayMs = Math.max(0, Number(delays[attempt]) || 0);
      logger?.warn?.(
        `[watcher] AMA live-review reconcile transient lookup failure for ` +
          `${repoPath}#${prNumber}@${headSha}; retrying in ${delayMs}ms: ${err?.message || err}`,
      );
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  return [];
}

/**
 * Resolve the AMA cfg subtree, build (reviewState, prMetadata)
 * snapshots from the watcher's existing row + candidate data, and
 * call `maybeDispatchAmaCloser`. Returns the dispatch result; the
 * caller checks `.dispatched` and skips merge-agent on `true`.
 *
 * Cheap path: when `cfg.enabled === false` (the default), this
 * function short-circuits in `maybeDispatchAmaCloser` before doing
 * any I/O or fetches. The watcher's hot path pays only the cost of
 * `loadConfigCached().getMergeAuthorityConfig()`, which is cached
 * across ticks.
 *
 * Snapshot mapping is best-effort against the watcher's existing
 * shapes. Fields the watcher doesn't already have (e.g. branch
 * protection's resolved required contexts) are left empty, and the
 * eligibility predicate fails-closed on them — meaning AMA dispatch
 * won't fire in the watcher path until the operator wires those
 * fetches in. That's intentional: AMA-03 lands the dispatch *path*;
 * AMA-06A/06N wire in the full snapshot in the cutover ticket.
 */
async function maybeDispatchAmaClosureFor({
  rootDir = ROOT,
  reviewStateRow,
  dispatchJob,
  candidate,
  labelNames,
  operatorApprovalEvent,
  adversarialMergeRequestedEvent,
  repoPath,
  prNumber,
  currentRevisionRef,
  logger,
  loadConfigImpl = loadConfigCached,
  maybeDispatchAmaCloserImpl = maybeDispatchAmaCloser,
  fetchLatestHeadReviewBodiesImpl = (repo, pr, head, options = {}) =>
    fetchReviewBodiesForHead(execFileAsync, repo, pr, head, options),
  liveReviewRetryDelaysMs = AMA_LIVE_REVIEW_LOOKUP_RETRY_DELAYS_MS,
}) {
  let cfg;
  let orchestrationMode;
  try {
    const loadedConfig = loadConfigImpl();
    cfg = loadedConfig.getMergeAuthorityConfig();
    orchestrationMode = resolveOrchestrationMode({
      loadedConfig,
      logger,
      context: 'AMA closure dispatch',
    });
  } catch (err) {
    // CFG load failure isn't an AMA problem; let the existing
    // merge-agent path handle the tick.
    logger?.warn?.(`[watcher] AMA cfg load failed: ${err?.message || err}`);
    return { dispatched: false, reason: 'cfg-load-failed', amaEnabled: false };
  }
  if (!cfg?.enabled) {
    // AMA-06N — surface `amaEnabled` so the watcher's coexistence
    // decision (the call site of this helper) can branch on it. With
    // AMA off, the default `merge-agent-default` action falls through
    // to the existing merge-agent dispatch without any override env.
    return { dispatched: false, reason: 'ama-disabled', amaEnabled: false };
  }

  // AMA "final hammer" signal: the review cycle is EXHAUSTED once the PR has
  // consumed its full remediation round budget. At that point the adversarial
  // verdict can loop on `Request changes` forever, so AMA must land the PR
  // (eligibility.mjs waives the soft convergence gates, keeps the hard ones).
  // Mirrors evaluateRoundBudgetForReview's budget resolution. Fail-safe: any
  // error leaves the signal false (AMA keeps its normal strict gates).
  let reviewCycleExhausted = false;
  // Resolve the PR's risk class from the remediation ledger (which defaults to
  // DEFAULT_RISK_CLASS) so AMA eligibility uses the SAME risk class the
  // round-budget path below already computes. Without this, the eligibility
  // riskClass fell back to 'unknown' for EVERY PR — fetchMergeAgentCandidate
  // does not populate candidate.riskClass and reviewed_prs has no risk_class
  // column — and 'unknown' is always-two-key, so AMA could never auto-close any
  // PR (closed 0 ever). Hoisted out of the try so it survives a round-budget
  // probe failure.
  let ledgerRiskClass = null;
  try {
    const remLedger = summarizePRRemediationLedger(rootDir, { repo: repoPath, prNumber });
    ledgerRiskClass = remLedger?.latestRiskClass || null;
    const rbResolution = resolveRoundBudgetForJob(
      { riskClass: remLedger.latestRiskClass },
      { rootDir },
    );
    const latestMaxRounds = Number(remLedger.latestMaxRounds);
    const effectiveRoundBudget =
      Number.isInteger(latestMaxRounds) && latestMaxRounds > rbResolution.roundBudget
        ? latestMaxRounds
        : rbResolution.roundBudget;
    reviewCycleExhausted =
      Number.isFinite(effectiveRoundBudget) &&
      effectiveRoundBudget > 0 &&
      Number(remLedger.completedRoundsForPR) >= effectiveRoundBudget;
  } catch (err) {
    console.warn(
      `[watcher] AMA final-hammer round-budget probe failed for ${repoPath}#${prNumber}; ` +
        `treating cycle as NOT exhausted: ${err?.message || err}`,
    );
  }

  // Resolve verdict + remediation-pending from the SAME canonical source the
  // adversarial gate uses (the posted review body via the latest follow-up
  // job, else the stored review row). reviewed_prs has NO `last_verdict` /
  // `remediation_pending` columns, so the previous reads were always
  // `undefined` -> verdict '' -> never settled-success -> AMA closed 0 PRs
  // ever. This is the verdict/remediation twin of the `risk_class` phantom-
  // column fix above (the riskClass path was repaired; this one was missed).
  const settledReviewHeadSha = candidate?.headSha || currentRevisionRef || null;
  let settledReview = resolveSettledReviewVerdict(rootDir, {
    repo: repoPath,
    prNumber,
    reviewRow: reviewStateRow,
    currentHeadSha: settledReviewHeadSha,
  });
  // FAIL-OPEN GUARD (#1824 / #1816): the stored follow-up-job / review-row body
  // resolved above can be STALE relative to a fresh review on the SAME head — a
  // completed remediation job's comment-only body is not updated when a later
  // adversarial pass posts `Request changes`, so the closer fail-open merged
  // PRs whose live verdict was `Request changes`. ONLY when the stored body
  // already reads settled-success (the sole case a stale body could cause a
  // fail-open merge) do we reconcile against the LIVE latest review on the head;
  // this bounds the extra GitHub call to apparently-mergeable PRs. A fresh
  // `Request changes` then wins, and a lookup failure fails closed.
  if (
    settledReviewHeadSha &&
    settledReview.remediationPending === false &&
    SETTLED_SUCCESS_VERDICTS.has(settledReview.verdict)
  ) {
    let liveHeadReview;
    // Resolve the authoritative reviewer login(s) from the REAL `reviewer` model
    // field (e.g. 'codex'/'claude'), NOT a `reviewer_login` column — that column
    // does NOT exist on reviewed_prs, so the prior `reviewStateRow?.reviewer_login`
    // was ALWAYS empty and the reconcile fail-CLOSED on every legit settled-success
    // PR (#1834 stuck despite `Comment only`). We accept BOTH observed reviewer-bot
    // login forms (the live `lacey-<model>-reviewer` account AND the legacy
    // `<model>-reviewer-lacey` config form) so the anti-spoof filter is robust to
    // the known naming discrepancy without mutating the globally-used
    // REVIEWER_BOT_LOGINS map (which review-body-capture / closeout-scraper rely on).
    const authoritativeReviewerLogins = amaAuthoritativeReviewerLoginsForModel(reviewStateRow?.reviewer);
    try {
      const bodies = authoritativeReviewerLogins.length
        ? await fetchLatestHeadReviewBodiesWithRetry({
            repoPath,
            prNumber,
            headSha: settledReviewHeadSha,
            authoritativeReviewerLogins,
            fetchLatestHeadReviewBodiesImpl,
            retryDelaysMs: liveReviewRetryDelaysMs,
            logger,
          })
        : [];
      if (!authoritativeReviewerLogins.length) {
        logger?.warn?.(
          `[watcher] AMA live-review reconcile could not resolve an authoritative reviewer ` +
            `login from reviewer='${reviewStateRow?.reviewer ?? ''}' for ` +
            `${repoPath}#${prNumber}@${settledReviewHeadSha}; failing closed`,
        );
      }
      liveHeadReview = { resolved: true, bodies: Array.isArray(bodies) ? bodies : [] };
    } catch (err) {
      logger?.warn?.(
        `[watcher] AMA live-review reconcile failed for ${repoPath}#${prNumber}@${settledReviewHeadSha}; ` +
          `failing closed: ${err?.message || err}`,
      );
      liveHeadReview = { resolved: false };
    }
    settledReview = resolveSettledReviewVerdict(rootDir, {
      repo: repoPath,
      prNumber,
      reviewRow: reviewStateRow,
      currentHeadSha: settledReviewHeadSha,
      liveHeadReview,
    });
  }
  // Proven reviewed head ONLY — do NOT fall back to the current PR head. AMA's
  // eligibility compares reviewState.headSha (reviewed head) against
  // prMetadata.headSha (current head); synthesizing the reviewed head from the
  // current head would always match and silently defeat the stale-review-head
  // guard, letting AMA close a commit never proven to be the reviewed one. Null
  // when unprovable -> AMA fails `stale-review-head` unless a current-head
  // operator override is present.
  const reviewAuthorityHead = settledReview.reviewedHeadSha || null;
  const reviewState = {
    verdict: settledReview.verdict,
    headSha: reviewAuthorityHead,
    riskClass: String(candidate?.riskClass || reviewStateRow?.risk_class || ledgerRiskClass || 'unknown').toLowerCase(),
    remediationPending: settledReview.remediationPending,
    reviewCycleExhausted,
    // Blocking-findings classification MUST come from the same authoritative
    // current-head body `settledReview` resolved the verdict from (live head
    // body when reconciled, else the stored job/row body). The `dispatchJob`
    // here is `buildMergeAgentDispatchJob`'s output, whose `classifyBlockingFindings`
    // reads the latest *follow-up-job* body — which is stale/missing for a clean
    // `comment-only` review with no remediation job, so it defaulted to
    // 'unknown' and made the closer fail `blocking-findings-unknown` and never
    // merge (live on agent-os#1856). `settledReview` always carries these keys;
    // fall back to 'unknown' only if absent (fail-closed).
    blockingFindingCount: Number(settledReview.blockingFindingCount ?? 0),
    blockingFindingState: String(settledReview.blockingFindingState || 'unknown').trim().toLowerCase(),
    operatorApprovedEvidence: operatorApprovalEvent
      ? {
          applied: true,
          observedRevisionRef: operatorApprovalEvent.headSha || operatorApprovalEvent.head_sha || null,
          actor: operatorApprovalEvent.actor || null,
          eventId: operatorApprovalEvent.id || operatorApprovalEvent.nodeId || null,
          observedAt: operatorApprovalEvent.createdAt || operatorApprovalEvent.created_at || null,
        }
      : null,
    prAuthor: candidate?.prAuthor || null,
  };
  // AMA's eligibility gate (SPEC §4.2 #7) compares `mergeableState` against
  // 'MERGEABLE' — the vocabulary of GitHub's `mergeable` field. Use
  // mergeStateStatus=CLEAN only as the UNKNOWN/empty fallback GitHub exposes
  // while recomputing mergeability; never let it override CONFLICTING.
  const prMetadata = {
    prNumber,
    headSha: candidate?.headSha || currentRevisionRef || null,
    isOpen: String(candidate?.prState || 'open').toLowerCase() === 'open',
    isDraft: Boolean(candidate?.isDraft),
    mergeableState: normalizeGithubMergeability(candidate),
    labels: Array.isArray(labelNames) ? labelNames : [],
    statusCheckRollup: Array.isArray(candidate?.statusCheckRollup) ? candidate.statusCheckRollup : [],
    branchProtection: { requiredContexts: candidate?.branchProtection?.requiredContexts || [] },
    author: candidate?.prAuthor || null,
  };

  const [owner, name] = repoPath.split('/');
  const dispatchContext = {
    rootDir,
    repo: repoPath,
    prUrl: `https://github.com/${owner}/${name}/pull/${prNumber}`,
    reviewedSha: reviewState.headSha,
    riskClass: reviewState.riskClass,
    requiredGateContext: resolveGateStatusContext(),
    reviewedBy: reviewStateRow?.reviewer_login || '',
    reviewer: reviewStateRow?.reviewer || '',
    parentSession: process.env.HQ_PARENT_SESSION || 'session:unknown:airlock+watcher',
    dispatchedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    orchestrationMode,
  };

  let result;
  try {
    result = await maybeDispatchAmaCloserImpl({
      reviewState,
      prMetadata,
      cfg,
      options: {
        env: process.env,
        adversarialMergeRequested: adversarialMergeRequestedEvent
          ? {
              applied: true,
              observedRevisionRef:
                adversarialMergeRequestedEvent.headSha ||
                adversarialMergeRequestedEvent.head_sha ||
                null,
              actor: adversarialMergeRequestedEvent.actor || null,
              eventId:
                adversarialMergeRequestedEvent.id ||
                adversarialMergeRequestedEvent.nodeId ||
                null,
              observedAt:
                adversarialMergeRequestedEvent.createdAt ||
                adversarialMergeRequestedEvent.created_at ||
                null,
            }
          : null,
      },
      dispatchContext,
      logger,
    });
  } catch (err) {
    logger?.warn?.(`[watcher] AMA dispatch failed: ${err?.message || err}`);
    return { dispatched: false, reason: 'ama-dispatch-failed', amaEnabled: Boolean(cfg?.enabled) };
  }
  // AMA-06N — expose `amaEnabled` so the watcher's coexistence
  // decision (downstream of this helper) can branch on it. The
  // upstream code paths (`cfg-load-failed`, `ama-disabled`) already
  // include the flag; this wraps the maybeDispatchAmaCloser return.
  if (result && typeof result === 'object' && result.amaEnabled === undefined) {
    return { ...result, amaEnabled: true };
  }
  return result;
}

async function resolveMergeAgentCoexistenceForWatcher({
  rootDir = ROOT,
  reviewStateRow,
  dispatchJob,
  candidate,
  labelNames,
  operatorApprovalEvent,
  mergeAgentRequestEvent,
  adversarialMergeRequestedEvent,
  repoPath,
  prNumber,
  currentRevisionRef,
  logger,
  maybeDispatchAmaClosureForImpl = maybeDispatchAmaClosureFor,
}) {
  const amaClosureResult = await maybeDispatchAmaClosureForImpl({
    rootDir,
    reviewStateRow,
    dispatchJob,
    candidate,
    labelNames,
    operatorApprovalEvent,
    adversarialMergeRequestedEvent,
    repoPath,
    prNumber,
    currentRevisionRef,
    logger,
  });
  if (amaClosureResult?.dispatched) {
    return { outcome: 'ama-dispatched', amaClosureResult };
  }
  if (amaClosureResult?.skipMergeAgent) {
    return { outcome: 'ama-pending', amaClosureResult };
  }

  const amaEnabled = Boolean(amaClosureResult?.amaEnabled);
  const amaClosureEligibilityMiss = amaClosureResult?.reason === 'not-eligible';
  const amaClosureRecoverableFailure = amaEnabled
    && !amaClosureResult?.dispatched
    && !amaClosureResult?.skipMergeAgent
    && !amaClosureEligibilityMiss;
  const mergeAgentRequestedScoped = isMergeAgentRequestedScoped(
    mergeAgentRequestEvent,
    {
      headSha: currentRevisionRef || candidate?.headSha || dispatchJob?.headSha || null,
      prUpdatedAt: candidate?.prUpdatedAt || dispatchJob?.prUpdatedAt || null,
    },
  );
  const coexistence = decideMergeAgentCoexistence({
    amaEnabled,
    amaClosureDispatched: Boolean(amaClosureResult?.dispatched),
    amaClosurePending: Boolean(amaClosureResult?.skipMergeAgent),
    amaClosureEligibilityMiss,
    amaClosureRecoverableFailure,
    mergeAgentRequestedScoped,
  });

  if (coexistence.action === COEXISTENCE_ACTION.AWAIT_OPERATOR_ACTION) {
    return { outcome: 'await-operator', amaClosureResult, coexistence };
  }
  return {
    outcome: 'dispatch-merge-agent',
    amaClosureResult,
    coexistence,
    dispatchEnv: mergeAgentDispatchEnvForAction(coexistence.action),
  };
}

// ── Poll loop (new PRs) ──────────────────────────────────────────────────────

async function handlePostedReviewRow({
  rootDir = ROOT,
  octokit = null,
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
  resolveMergeAgentCoexistenceForWatcherImpl = resolveMergeAgentCoexistenceForWatcher,
  emitVocabularyFatigueFindingForPRImpl = emitVocabularyFatigueFindingForPR,
  operatorSurface = null,
  logger = console,
} = {}) {
  await projectGateStatusSafe(existing);

  try {
    await emitVocabularyFatigueFindingForPRImpl({
      octokit,
      repoPath,
      prNumber,
      logger,
    });

    let operatorApprovalEvent;
    let mergeAgentRequestEvent;
    let adversarialMergeRequestedEvent;
    if (operatorSurface) {
      const controlSubjectRef = subjectRef || {
        domainId: 'code-pr',
        subjectExternalId: `${repoPath}#${prNumber}`,
        revisionRef: currentRevisionRef || null,
      };
      const revisionRef = currentRevisionRef || controlSubjectRef.revisionRef || null;
      const [operatorApproval, mergeAgentRequest, adversarialMergeRequest] = await Promise.all([
        labelNames.includes(OPERATOR_APPROVED_LABEL)
          ? operatorSurface.observeOperatorApproved(controlSubjectRef, revisionRef)
          : null,
        labelNames.includes(MERGE_AGENT_REQUESTED_LABEL)
          ? operatorSurface.observeMergeAgentOverride(controlSubjectRef, revisionRef)
          : null,
        labelNames.includes(ADVERSARIAL_MERGE_REQUESTED_LABEL) &&
          typeof operatorSurface.observeLabelControl === 'function'
          ? operatorSurface.observeLabelControl(
              controlSubjectRef,
              revisionRef,
              ADVERSARIAL_MERGE_REQUESTED_LABEL,
            )
          : null,
      ]);
      operatorApprovalEvent = legacyLabelEventFromControlResult(operatorApproval, OPERATOR_APPROVED_LABEL);
      mergeAgentRequestEvent = legacyLabelEventFromControlResult(mergeAgentRequest, MERGE_AGENT_REQUESTED_LABEL);
      adversarialMergeRequestedEvent = legacyLabelEventFromControlResult(
        adversarialMergeRequest,
        ADVERSARIAL_MERGE_REQUESTED_LABEL,
      );
    }
    const candidate = await fetchMergeAgentCandidateImpl(repoPath, prNumber, {
      execFileImpl,
      operatorApprovalEvent,
      mergeAgentRequestEvent,
    });
    const dispatchJob = buildMergeAgentDispatchJobImpl(rootDir, candidate, { reviewStateDb: db });

    // AMA-03: pre-empt the merge-agent dispatch with an AMA closer
    // when AMA is enabled AND the canonical SPEC §4.2 predicate
    // returns eligible. Default-off: cfg.enabled is `false` per the
    // AMA-01 schema; the whole pre-empt branch is a no-op until the
    // operator opts in.
    //
    // When AMA fires:
    //   - the closer worker is spawned with --task-kind=merge,
    //     --completion-shape=decision-only, --project=adversarial-merge-authority;
    //   - we skip merge-agent on this tick (the dispatched.decision
    //     surfaces as `ama-closer-dispatched`);
    //   - the closer re-runs the predicate at merge time and writes
    //     the §4.4 audit JSON either way.
    //
    // When AMA does NOT fire (disabled OR not eligible OR dispatch
    // failed), we fall through to the existing merge-agent dispatch
    // path verbatim — no behavior change for hosts that haven't
    // opted in.
    const coexistenceDecision = await resolveMergeAgentCoexistenceForWatcherImpl({
      rootDir,
      reviewStateRow: existing,
      dispatchJob,
      candidate,
      labelNames,
      operatorApprovalEvent,
      mergeAgentRequestEvent,
      adversarialMergeRequestedEvent,
      repoPath,
      prNumber,
      currentRevisionRef,
      logger,
    });
    if (coexistenceDecision.outcome === 'ama-dispatched') {
      const { amaClosureResult } = coexistenceDecision;
      logger.log(
        `[watcher] AMA closer dispatched for ${repoPath}#${prNumber}: ` +
        `lrq=${amaClosureResult.dispatchId || 'unknown'} workerClass=${amaClosureResult.workerClass}`
      );
      return;
    }
    if (coexistenceDecision.outcome === 'ama-pending') {
      const { amaClosureResult } = coexistenceDecision;
      logger.log(
        `[watcher] AMA closer retained ownership for ${repoPath}#${prNumber}: ` +
        `${amaClosureResult.reason || 'ama-dispatch-pending'} ` +
        `lrq=${amaClosureResult.launchRequestId || amaClosureResult.dispatchId || 'unknown'} ` +
        `workerClass=${amaClosureResult.workerClass || 'unknown'}`
      );
      return;
    }

    // AMA-06N — coexistence decision per SPEC §4.8. When AMA is
    // enabled and the AMA closer didn't fire (not eligible, dispatch
    // failed, etc.), the watcher must NOT auto-fall-through to merge-
    // agent. The operator either fixes eligibility (apply
    // operator-approved / adversarial-merge-requested) OR explicitly
    // applies `merge-agent-requested` on the current head to invoke
    // the operator-fallback lane.
    //
    // Operator-fallback dispatches merge-agent WITH the
    // `AMA_OPERATOR_MERGE_AGENT_OVERRIDE=true` env so the AMA-06A
    // admit gate (agent-os side) lets it through.
    //
    // When AMA is disabled, the action is `merge-agent-default` and
    // the existing dispatch runs unchanged (no override env, no
    // logging change).
    if (coexistenceDecision.outcome === 'await-operator') {
      const { amaClosureResult } = coexistenceDecision;
      const reasonsHint = Array.isArray(amaClosureResult?.reasons)
        ? amaClosureResult.reasons.slice(0, 8).join(',')
        : amaClosureResult?.reason || 'unknown';
      logger.log(
        `[watcher] AMA enabled but not eligible for ${repoPath}#${prNumber} ` +
        `(reasons: ${reasonsHint}); awaiting operator action ` +
        `(apply 'operator-approved'/'adversarial-merge-requested' to make AMA-eligible ` +
        `OR 'merge-agent-requested' for the operator-fallback lane)`
      );
      return;
    }

    const orchestrationMode = resolveOrchestrationMode({
      logger,
      context: 'merge-agent dispatch',
    });
    const { coexistence, dispatchEnv } = coexistenceDecision;
    // AMA-06N: when the operator-fallback lane is selected, override
    // the dispatch trigger to 'merge-agent-requested' so the critical-
    // lane priority + consumed-label cleanup at
    // follow-up-merge-agent.mjs:3768-3783 + :3060-3069 fire correctly.
    // An env overlay alone leaves the trigger on the normal lane,
    // recreating the memory-pressure outage class this label exists
    // to bypass.
    const operatorFallbackTriggerOverride =
      coexistence?.action === COEXISTENCE_ACTION.MERGE_AGENT_OPERATOR_FALLBACK
        ? 'merge-agent-requested'
        : null;
    if (coexistence?.action === COEXISTENCE_ACTION.MERGE_AGENT_OPERATOR_FALLBACK) {
      logger.log(
        `[watcher] merge-agent operator-fallback lane for ${repoPath}#${prNumber}: ` +
        `setting AMA_OPERATOR_MERGE_AGENT_OVERRIDE=true + trigger=merge-agent-requested (AMA-06N → AMA-06A admit-gate bypass)`
      );
    } else if (coexistence?.action === COEXISTENCE_ACTION.MERGE_AGENT_RECOVERY_FALLBACK) {
      logger.log(
        `[watcher] AMA closer recovery fallback for ${repoPath}#${prNumber}: ` +
        `${coexistenceDecision?.amaClosureResult?.reason || 'ama-dispatch-failure'}; ` +
        `dispatching merge-agent with AMA_OPERATOR_MERGE_AGENT_OVERRIDE=true`
      );
    }
    const dispatched = await dispatchMergeAgentForPRImpl({
      rootDir,
      ...dispatchJob,
      orchestrationMode,
      ...(dispatchEnv ? { env: { ...process.env, ...dispatchEnv } } : {}),
      ...(operatorFallbackTriggerOverride ? { triggerOverride: operatorFallbackTriggerOverride } : {}),
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

async function maybeDispatchReviewerTimeoutExhaustedMergeAgent({
  rootDir = ROOT,
  repoPath,
  prNumber,
  existing,
  subjectRef,
  currentRevisionRef,
  labelNames = [],
  execFileImpl = execFileAsync,
  fetchMergeAgentCandidateImpl = fetchMergeAgentCandidate,
  buildMergeAgentDispatchJobImpl = buildMergeAgentDispatchJob,
  dispatchMergeAgentForPRImpl = dispatchMergeAgentForPR,
  operatorSurface = null,
  logger = console,
} = {}) {
  if (!isReviewerTimeoutExhaustedRow(rootDir, existing, {
    repo: repoPath,
    prNumber,
    headSha: currentRevisionRef,
  })) {
    return { handled: false, reason: 'not-reviewer-timeout-exhausted' };
  }

  try {
    let operatorApprovalEvent;
    let mergeAgentRequestEvent;
    let adversarialMergeRequestedEvent;
    if (operatorSurface) {
      const controlSubjectRef = subjectRef || {
        domainId: 'code-pr',
        subjectExternalId: `${repoPath}#${prNumber}`,
        revisionRef: currentRevisionRef || null,
      };
      const revisionRef = currentRevisionRef || controlSubjectRef.revisionRef || null;
      const [operatorApproval, mergeAgentRequest, adversarialMergeRequest] = await Promise.all([
        labelNames.includes(OPERATOR_APPROVED_LABEL)
          ? operatorSurface.observeOperatorApproved(controlSubjectRef, revisionRef)
          : null,
        labelNames.includes(MERGE_AGENT_REQUESTED_LABEL)
          ? operatorSurface.observeMergeAgentOverride(controlSubjectRef, revisionRef)
          : null,
        labelNames.includes(ADVERSARIAL_MERGE_REQUESTED_LABEL) &&
          typeof operatorSurface.observeLabelControl === 'function'
          ? operatorSurface.observeLabelControl(
              controlSubjectRef,
              revisionRef,
              ADVERSARIAL_MERGE_REQUESTED_LABEL,
            )
          : null,
      ]);
      operatorApprovalEvent = legacyLabelEventFromControlResult(operatorApproval, OPERATOR_APPROVED_LABEL);
      mergeAgentRequestEvent = legacyLabelEventFromControlResult(mergeAgentRequest, MERGE_AGENT_REQUESTED_LABEL);
      adversarialMergeRequestedEvent = legacyLabelEventFromControlResult(
        adversarialMergeRequest,
        ADVERSARIAL_MERGE_REQUESTED_LABEL,
      );
    }
    const candidate = await fetchMergeAgentCandidateImpl(repoPath, prNumber, {
      execFileImpl,
      operatorApprovalEvent,
      mergeAgentRequestEvent,
    });
    const dispatchJob = buildMergeAgentDispatchJobImpl(rootDir, candidate, { reviewStateDb: db });
    if (!shouldUseReviewerTimeoutExhaustedMergeGate(dispatchJob)) {
      return { handled: false, dispatchJob };
    }
    const coexistenceDecision = await resolveMergeAgentCoexistenceForWatcher({
      rootDir,
      reviewStateRow: existing,
      dispatchJob,
      candidate,
      labelNames,
      operatorApprovalEvent,
      mergeAgentRequestEvent,
      adversarialMergeRequestedEvent,
      repoPath,
      prNumber,
      currentRevisionRef,
      logger,
    });
    if (coexistenceDecision.outcome === 'ama-dispatched') {
      const { amaClosureResult } = coexistenceDecision;
      logger.log(
        `[watcher] reviewer-timeout exhaustion handed off to AMA closer for ${repoPath}#${prNumber}: ` +
        `lrq=${amaClosureResult.dispatchId || 'unknown'} workerClass=${amaClosureResult.workerClass || 'unknown'}`
      );
      return { handled: true, dispatchJob, amaClosureResult };
    }
    if (coexistenceDecision.outcome === 'ama-pending') {
      const { amaClosureResult } = coexistenceDecision;
      logger.log(
        `[watcher] reviewer-timeout exhaustion awaiting AMA closer for ${repoPath}#${prNumber}: ` +
        `${amaClosureResult.reason || 'ama-dispatch-pending'} ` +
        `lrq=${amaClosureResult.launchRequestId || amaClosureResult.dispatchId || 'unknown'} ` +
        `workerClass=${amaClosureResult.workerClass || 'unknown'}`
      );
      return { handled: true, dispatchJob, amaClosureResult };
    }
    if (coexistenceDecision.outcome === 'await-operator') {
      const { amaClosureResult } = coexistenceDecision;
      const reasonsHint = Array.isArray(amaClosureResult?.reasons)
        ? amaClosureResult.reasons.slice(0, 8).join(',')
        : amaClosureResult?.reason || 'unknown';
      logger.log(
        `[watcher] reviewer-timeout exhaustion parked for ${repoPath}#${prNumber}: ` +
        `AMA enabled but not eligible (reasons: ${reasonsHint}); awaiting operator action ` +
        `(apply 'operator-approved'/'adversarial-merge-requested' to make AMA-eligible ` +
        `OR 'merge-agent-requested' for the operator-fallback lane)`
      );
      return { handled: true, dispatchJob, amaClosureResult };
    }
    const orchestrationMode = resolveOrchestrationMode({
      logger,
      context: 'reviewer-timeout merge-agent handoff',
    });
    const { coexistence, dispatchEnv } = coexistenceDecision;
    // AMA-06N: timeout-exhaustion path also honors triggerOverride on
    // the operator-fallback lane, same rationale as the green-path
    // dispatch above — env overlay alone is insufficient.
    const operatorFallbackTriggerOverride =
      coexistence?.action === COEXISTENCE_ACTION.MERGE_AGENT_OPERATOR_FALLBACK
        ? 'merge-agent-requested'
        : null;
    if (coexistence?.action === COEXISTENCE_ACTION.MERGE_AGENT_OPERATOR_FALLBACK) {
      logger.log(
        `[watcher] reviewer-timeout exhaustion using merge-agent operator-fallback lane for ${repoPath}#${prNumber}: ` +
        `setting AMA_OPERATOR_MERGE_AGENT_OVERRIDE=true + trigger=merge-agent-requested (AMA-06N → AMA-06A admit-gate bypass)`
      );
    } else if (coexistence?.action === COEXISTENCE_ACTION.MERGE_AGENT_RECOVERY_FALLBACK) {
      logger.log(
        `[watcher] reviewer-timeout exhaustion recovering via merge-agent for ${repoPath}#${prNumber}: ` +
        `${coexistenceDecision?.amaClosureResult?.reason || 'ama-dispatch-failure'}; ` +
        `setting AMA_OPERATOR_MERGE_AGENT_OVERRIDE=true`
      );
    }
    const dispatched = await dispatchMergeAgentForPRImpl({
      rootDir,
      ...dispatchJob,
      orchestrationMode,
      ...(dispatchEnv ? { env: { ...process.env, ...dispatchEnv } } : {}),
      ...(operatorFallbackTriggerOverride ? { triggerOverride: operatorFallbackTriggerOverride } : {}),
    });
    logger.log(
      `[watcher] reviewer-timeout exhaustion handoff for ${repoPath}#${prNumber}: ${dispatched.decision}`
    );
    return { handled: true, dispatchJob, dispatched };
  } catch (err) {
    const detail = err?.message || String(err);
    logger.error(
      `[watcher] reviewer-timeout exhaustion handoff failed for ${repoPath}#${prNumber}: ${detail}`
    );
    return { handled: false, error: err };
  }
}

function isReviewerTimeoutExhaustedRow(rootDir, reviewRow, { repo, prNumber, headSha = null } = {}) {
  const status = String(reviewRow?.review_status || '').trim().toLowerCase();
  if (status !== 'failed' && status !== 'pending-upstream') return false;
  if (reviewerFailureClassFromStoredRow(reviewRow) !== 'reviewer-timeout') return false;
  const reviewedHeadSha = String(reviewRow?.reviewer_head_sha || '').trim();
  const currentHeadSha = String(headSha || '').trim();
  if (reviewedHeadSha && currentHeadSha && reviewedHeadSha !== currentHeadSha) return false;
  try {
    const cascadeState = readCascadeState(rootDir, { repo, prNumber });
    const timeoutFailures = Number(cascadeState?.transientFailureBreakdown?.['reviewer-timeout'] || 0);
    return timeoutFailures >= CASCADE_FAILURE_CAP;
  } catch {
    return false;
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

async function getStalePostedReviewAutoRereviewSuppression({
  rootDir = ROOT,
  repoPath,
  prNumber,
  subjectRef,
  currentRevisionRef,
  currentHeadSha,
  labelNames = [],
  operatorSurface = null,
  execFileImpl = execFileAsync,
  env = process.env,
  logger = console,
  isMergeAgentDispatchActiveForHeadImpl = isMergeAgentDispatchActiveForHead,
} = {}) {
  const normalizedLabelNames = new Set(
    (Array.isArray(labelNames) ? labelNames : [])
      .map((label) => String(label || '').trim())
      .filter(Boolean)
  );
  const controlSubjectRef = subjectRef || {
    domainId: 'code-pr',
    subjectExternalId: `${repoPath}#${prNumber}`,
    revisionRef: currentRevisionRef || currentHeadSha || null,
  };
  const revisionRef = currentRevisionRef || controlSubjectRef.revisionRef || currentHeadSha || null;

  if (normalizedLabelNames.has(MERGE_AGENT_REQUESTED_LABEL) && operatorSurface) {
    const mergeAgentRequest = await operatorSurface.observeMergeAgentOverride(
      controlSubjectRef,
      revisionRef,
    );
    if (mergeAgentRequest?.applied) {
      return {
        suppressed: true,
        reason: 'scoped-current-head-merge-agent-requested',
      };
    }
  }

  if (normalizedLabelNames.has(MERGE_AGENT_DISPATCHED_LABEL)) {
    const dispatch = await isMergeAgentDispatchActiveForHeadImpl(
      rootDir,
      { repo: repoPath, prNumber, headSha: currentHeadSha },
      { execFileImpl, env, logger },
    );
    if (dispatch?.active) {
      return {
        suppressed: true,
        reason: dispatch.reason || 'active-current-head-merge-agent-dispatch',
      };
    }
  }

  return { suppressed: false, reason: null };
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
  // CFG-09: per-tick boundary for the role-config cascade cache. Drop
  // the cached AgentOSConfig so this tick re-resolves env + config.yaml
  // before `routeSubject` / `pickRemediationWorkerClass` consult it.
  // Cache-hit reuse happens within the tick (multiple PRs in this loop
  // see the same cached config); operator env rotations between ticks
  // propagate after this reset, not at next file-mtime change.
  resetRoleConfigCache();
  refreshReviewerRuntimeAdapter();
  // Keep the reviewer-bot GitHub App installation tokens fresh. The watcher is
  // a single long-lived process that resolved these once at startup; App
  // installation tokens expire ~1h, so without a periodic refresh the GitHub
  // review-POST starts failing with HTTP 401 about an hour after each restart
  // (the 2026-06-13 pipeline-wide outage). This is TTL-gated + fail-safe: it
  // only re-fetches a token older than the TTL and never clears a still-valid
  // token if the broker is briefly unreachable. Never throws.
  await refreshReviewerBrokerTokens({ log: console });
  // Same TTL-gated, fail-safe refresh for the watcher's OWN GitHub token
  // (GITHUB_TOKEN/GH_TOKEN) so the poll-loop octokit + AMA-eligibility `gh` calls
  // stay on a rate-limit-isolated App token instead of exhausting the operator
  // PAT's shared 5000/hr budget under PR surge. No-op unless WATCHER_GH_AUTH_VIA_BROKER=true.
  await refreshWatcherGithubToken({ log: console });
  const healthTick = healthProbe?.beginTick?.();
  try {
    maybeSweepConditionalRequestCache({ rootDir: ROOT, logger: console });
    const operatorSurface = createWatcherOperatorSurface();
    await refreshOrgRepos(octokit);
    const reattach = await reconcileReviewerSessions({
      db,
      octokit,
      maxRows: resolveStaleReviewerReconcilePerPoll(),
      shouldReconcileRow: (row, now) => shouldReconcileReviewerSession(row, now),
      leaseRecoveryEnabled: REVIEWER_LEASE_RECOVERY_ENABLED,
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
  await retryPendingDagAutowalkOnMerge();
  await retryPendingMergeCloseouts({ octokit });
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

  const reviewerPoolConfig = resolveFirstPassReviewerPoolConfig({ watcherConfig: config });
  const reviewerDispatchCandidates = [];
  const reviewerMemoryReservationState = { reservedMb: 0 };
  const reviewerMemoryAdmissionSampleForTick = createReviewerMemoryAdmissionSampler({ logger: console });
  const getRoutingTierReadinessForTick = createRoutingTierReadinessProbeCache();

  for (const repoPath of activeRepos) {
    const [owner, repo] = repoPath.split('/');
    const subjectAdapter = createGitHubPRSubjectAdapter({
      octokit,
      repos: [repoPath],
      rootDir: ROOT,
      execFileImpl: execFileAsync,
      recordApiCall,
    });

    let subjectRefs;
    const activeMergeAgentPRs = [];
    const currentRepoPRs = [];
    try {
      subjectRefs = await subjectAdapter.discoverSubjects();
    } catch (err) {
      console.error(`[watcher] Failed to fetch PRs for ${repoPath}:`, err.message);
      continue;
    }

    let subjectEntries = (await Promise.all(subjectRefs.map(async (subjectRef) => {
      try {
        const subject = await subjectAdapter.fetchState(subjectRef);
        const { prNumber } = parseSubjectExternalId(subject.ref.subjectExternalId);
        return { subjectRef, subject, prNumber };
      } catch (err) {
        console.error(`[watcher] Failed to fetch subject state for ${subjectRef.subjectExternalId}:`, err.message);
        return null;
      }
    }))).filter(Boolean);
    if (!reviewerPoolConfig.enabled) {
      subjectEntries = subjectEntries
        .map((entry) => ({
          ...entry,
          current: stmtGetReviewRow.get(repoPath, entry.prNumber),
        }))
        .sort((a, b) => compareReviewerDispatchCandidates({
          repoPath,
          prNumber: a.prNumber,
          subject: a.subject,
          current: a.current,
        }, {
          repoPath,
          prNumber: b.prNumber,
          subject: b.subject,
          current: b.current,
        }));
    }

    for (const { subject, prNumber, current: cachedCurrent } of subjectEntries) {
      const prTitle = subject.title || '';
      const staleDriftSkip = shouldSkipReviewerForStaleDrift({
        number: prNumber,
        labels: subject.labels,
      });
      const prLabelNames = (Array.isArray(subject.labels) ? subject.labels : [])
        .map((l) => (typeof l === 'string' ? l : l?.name || ''))
        .filter(Boolean);
      if (subject.headSha) {
        currentRepoPRs.push({
          repo: repoPath,
          prNumber,
          headSha: subject.headSha,
          labels: subject.labels,
        });
      }
      if (prLabelNames.includes(MERGE_AGENT_DISPATCHED_LABEL)) {
        activeMergeAgentPRs.push({ repo: repoPath, prNumber, headSha: subject.headSha || null });
      }
      if (staleDriftSkip) {
        console.log(staleDriftSkip.message);
        continue;
      }
      let existing = cachedCurrent ?? stmtGetReviewRow.get(repoPath, prNumber);
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
      // `stmtMarkAttemptStarted` reclaims only `pending` and
      // `pending-upstream`, never `posted` or generic `failed` — so
      // those rows stay stale until manual `retrigger-review`.
      //
      // This auto-refresh calls `requestReviewRereview`, whose own CAS
      // refuses to flip `reviewing` (the watcher already has an active
      // reviewer) — so a head change mid-tick can't race a duplicate
      // spawn. The retrigger only fires when `reviewer_head_sha` is
      // strictly different from the current `subject.headSha` and the
      // PR is non-terminal, so we don't thrash a PR whose head matches.
      // ...UNLESS the merge-agent is provably still converging for THIS head.
      // That suppression is state-aware rather than raw-label-based so stale
      // labels and `awaiting-rereview` handoffs still re-arm review.
      const postedReviewHeadMoved =
        existing?.review_status === 'posted' &&
        existing.reviewer_head_sha &&
        subject.headSha &&
        existing.reviewer_head_sha !== subject.headSha &&
        !subject.terminal;
      const stalePostedReviewSuppression = postedReviewHeadMoved
        ? await getStalePostedReviewAutoRereviewSuppression({
          rootDir: ROOT,
          repoPath,
          prNumber,
          subjectRef: subject.ref,
          currentRevisionRef: subject.ref.revisionRef,
          currentHeadSha: subject.headSha,
          labelNames: prLabelNames,
          operatorSurface,
          execFileImpl: execFileAsync,
          logger: console,
        })
        : { suppressed: false, reason: null };
      if (postedReviewHeadMoved && stalePostedReviewSuppression.suppressed) {
        console.log(
          `[watcher] auto-refresh SUPPRESSED for ${repoPath}#${prNumber}: ` +
            `head moved ${existing.reviewer_head_sha.slice(0, 12)} → ${subject.headSha.slice(0, 12)} ` +
            `because ${stalePostedReviewSuppression.reason}; leaving posted review to the merge-agent`
        );
      } else if (postedReviewHeadMoved) {
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
          octokit,
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

      let crossModelWaiverReason = null;
      const baseRoute = routeSubject(subject, { geminiReviewerMode: 'off' });
      // CFG-02 round-1 review B3 fix (2026-05-30): routeSubject can now
      // return a tagged `configBroken: true` sentinel when a runtime
      // edit to config.yaml violates the strict schema (instead of
      // throwing and aborting the whole tick). Skip this PR with a
      // loud log so the operator sees the bad config and fixes it;
      // the boot-time validator (validateDefaultReviewerRouteConfig)
      // would have caught the same edit at daemon restart, so this
      // path is the runtime-edit-during-tick fallback.
      if (baseRoute && baseRoute.configBroken) {
        console.warn(
          `[watcher] routeSubject returned config-broken for ${repoPath}#${prNumber}: ` +
          `${baseRoute.error?.message || baseRoute.error || 'unknown config error'} — ` +
          `skipping this PR for the tick; fix the config and restart the watcher to recover`
        );
        continue;
      }
      if (!baseRoute) {
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
      // GMW-02 — layer the gemini always-on / fallback third-reviewer selection
      // on top of the resolved cross-model baseRoute using the same effective
      // route helper exported to operator surfaces, then let the existing
      // reviewer-timeout fallback apply on the (possibly gemini-pinned) result.
      // The integrity hard guard inside the effective helper also strips any
      // gemini-on-gemini route that an operator `roles.reviewer=gemini` pin
      // could otherwise produce.
      const geminiModeResolution = resolveGeminiReviewerModeForWatcher({ env: process.env });
      const geminiReviewerMode = geminiModeResolution.mode;
      if (geminiModeResolution.error) {
        console.error(
          `[watcher] gemini reviewer-mode resolve failed for ${repoPath}#${prNumber}: ` +
            `${geminiModeResolution.error?.message || geminiModeResolution.error}; ` +
            `fail-closed to reviewer.gemini.mode=off`
        );
      }
      const geminiBaseRoute = applyEffectiveReviewerRoute({
        builderClass: baseRoute.builderClass,
        baseRoute,
        mode: geminiReviewerMode,
        primaryReviewerQuotaCapped:
          geminiReviewerMode === 'fallback'
            ? primaryReviewerQuotaCappedForRow(existing, {
                expectedReviewerModel: baseRoute.reviewerModel,
              })
            : false,
      });
      if (geminiBaseRoute.geminiReviewerSelection) {
        console.log(
          `[watcher] reviewer-selection ${repoPath}#${prNumber} → gemini ` +
            `(${geminiBaseRoute.geminiReviewerSelection.reason}; mode=${geminiReviewerMode}; ` +
            `replaced reviewer=${geminiBaseRoute.geminiReviewerSelection.replacedReviewerModel})`
        );
      } else if (geminiBaseRoute.geminiIntegrityGuard) {
        console.warn(
          `[watcher] reviewer-integrity-guard ${repoPath}#${prNumber}: blocked gemini from ` +
            `reviewing a ${geminiBaseRoute.geminiIntegrityGuard.builderClass}-built PR; ` +
            `fell back to reviewer=${geminiBaseRoute.geminiIntegrityGuard.fellBackTo}`
        );
      }
      const route = selectReviewerRouteForAttempt({
        subject,
        baseRoute: geminiBaseRoute,
        rootDir: ROOT,
        repoPath,
        prNumber,
      });

      crossModelWaiverReason = route.timeoutFallback
        ? (
            `reviewer-timeout fallback switched reviewer=${route.timeoutFallback.fromReviewerModel} ` +
            `to reviewer=${route.timeoutFallback.toReviewerModel} after ` +
            `${route.timeoutFallback.timeoutFailures} timeout failures; ` +
            (route.timeoutFallback.sameModelAsBuilder
              ? `reviewer=${route.timeoutFallback.toReviewerModel} matches builder=${route.timeoutFallback.builderClass}, so cross-model guarantee is waived for this recovery pass.`
              : 'cross-model guarantee remains intact for this recovery pass.')
          )
        : describeCrossModelReviewWaiver(
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
      const preRoutingUpdateRow = existing;
      if (!existing) {
        liveLabels = await fetchLivePRLabels(octokit, {
          owner,
          repo,
          prNumber,
        });
        if (liveLabels) {
          const fastMergeDecision = fastMergeDecisionFromLabels(liveLabels);
          if (fastMergeDecision.hasFastMergeLabel && !fastMergeDecision.hasVeto) {
            const authorizedHeadSha = await fetchLivePRHeadSha({
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
      const timeoutExhaustionHandoff = await maybeDispatchReviewerTimeoutExhaustedMergeAgent({
        rootDir: ROOT,
        repoPath,
        prNumber,
        existing: current,
        subjectRef: subject.ref,
        currentRevisionRef: subject.ref.revisionRef,
        labelNames: prLabelNames,
        execFileImpl: execFileAsync,
        operatorSurface,
      });
      if (timeoutExhaustionHandoff.handled) {
        continue;
      }

      const infraRecoveryClass = current?.review_status === 'failed'
        ? infraRecoverableFailureClass(current)
        : null;
      if (current?.review_status === 'failed' && !infraRecoveryClass) {
        console.log(
          `[watcher] Skipping failed review ${repoPath}#${prNumber}: ` +
            `failure is not infrastructure-recoverable; leaving evidence intact`
        );
        continue;
      }
      // HRR graceful-degradation for hard provider usage caps. A quota-exhausted
      // reviewer cannot succeed until the provider's cap window lifts, so retrying
      // before then would only burn the bounded infra auto-recover budget against a
      // wall. Hold the row until the provider-reported reset (or a fixed fallback
      // window since the last failure) elapses — WITHOUT consuming an attempt — then
      // let normal bounded recovery resume. Applies to both harnesses we know the
      // shape for (codex / claude), since the failure_message tag carries the cap.
      if (infraRecoveryClass === QUOTA_EXHAUSTED_FAILURE_CLASS) {
        const quotaHold = quotaHoldDecision(current, {
          fallbackBackoffMs: QUOTA_EXHAUSTED_BACKOFF_MS,
        });
        if (quotaHold.hold) {
          if (shouldBypassPrimaryReviewerQuotaHold(route, preRoutingUpdateRow)) {
            console.log(
              `[watcher] Bypassing quota hold for ${repoPath}#${prNumber}: ` +
                `reviewer.gemini.mode=${route.geminiReviewerSelection?.mode || geminiReviewerMode} ` +
                `selected gemini while replaced reviewer is capped`
            );
          } else {
            console.log(
              `[watcher] Holding quota-exhausted review ${repoPath}#${prNumber}: ` +
                `provider usage cap not yet cleared (waiting until ` +
                `${new Date(quotaHold.waitUntilMs).toISOString()} [${quotaHold.source}]); ` +
                `not consuming infra auto-recover attempt`
            );
            continue;
          }
        }
      }
      const infraRecoveryAttempts = Number(current?.infra_auto_recover_attempts || 0);
      if (infraRecoveryClass && infraRecoveryAttempts >= INFRA_AUTO_RECOVER_CAP) {
        console.log(
          `[watcher] Infra auto-recovery cap exhausted for ${repoPath}#${prNumber}: ` +
            `class=${infraRecoveryClass} attempts=${infraRecoveryAttempts}/${INFRA_AUTO_RECOVER_CAP}; ` +
            `leaving review_status='failed' for operator inspection`
        );
        continue;
      }
      if (infraRecoveryClass) {
        const infraRecoveryReadiness = await getRoutingTierReadinessForTick();
        if (!infraRecoveryReadiness.ready) {
          console.log(
            `[watcher] Skipping infra auto-recovery for ${repoPath}#${prNumber}: ` +
              `routing tier not ready (${infraRecoveryReadiness.reason}); ` +
              `leaving review_status='failed' evidence intact`
          );
          continue;
        }
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

      const dispatchCandidate = {
        repoPath,
        prNumber,
        subject,
        current,
        async run() {
          const reservation = await reserveReviewerMemoryAdmission({
            reviewerModel: route.reviewerModel,
            reservationState: reviewerMemoryReservationState,
            getMemoryPressureSample: reviewerMemoryAdmissionSampleForTick,
            logger: console,
          });
          const { estimatedReviewerRssMb, memoryDecision, reservedMbBeforeAdmission } = reservation;
          if (!memoryDecision.admit) {
            console.log(
              `[watcher] Deferring reviewer for ${repoPath}#${prNumber}: ${memoryDecision.reason} ` +
                `available=${memoryDecision.availableMb ?? 'unknown'}MB ` +
                `reserved=${memoryDecision.reservedMb ?? reservedMbBeforeAdmission}MB ` +
                `estimated=${memoryDecision.estimatedReviewerRssMb ?? estimatedReviewerRssMb}MB ` +
                `projected=${memoryDecision.projectedHeadroomMb ?? 'unknown'}MB`
            );
            return;
          }

          try {
            const respawnAgeSeconds = resolvePendingDraftRespawnAgeSeconds();
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
            const reviewerLeaseExpiresAt = computeReviewerLeaseExpiryAt(attemptAt, reviewerTimeoutMs);
            const claim = infraRecoveryClass
              ? stmtMarkInfraAutoRecoveryAttemptStarted.run(
                attemptAt,
                reviewerSessionUuid,
                reviewerHeadSha,
                reviewerTimeoutMs,
                reviewerLeaseExpiresAt,
                repoPath,
                prNumber,
                INFRA_AUTO_RECOVER_CAP,
                infraRecoveryClass,
                infraRecoveryClass,
                infraRecoveryClass,
                infraRecoveryClass,
                infraRecoveryClass
              )
              : stmtMarkAttemptStarted.run(
                attemptAt,
                reviewerSessionUuid,
                reviewerHeadSha,
                reviewerTimeoutMs,
                reviewerLeaseExpiresAt,
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
              return;
            }
            if (existing) {
              stmtUpdateReviewRouting.run(route.reviewerModel, linearTicketId, repoPath, prNumber);
            }
            if (infraRecoveryClass) {
              console.log(
                `[watcher] Claimed infra-failed review ${repoPath}#${prNumber} ` +
                  `(class=${infraRecoveryClass}, infra attempt ${infraRecoveryAttempts + 1}/${INFRA_AUTO_RECOVER_CAP})`
              );
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
              const freshPR = await fetchPullRequestHeadAndState(repoPath, prNumber, {
                execFileImpl: execFileAsync,
              });
              if (freshPR.mergedAt) {
                console.log(
                  `[watcher] PR ${repoPath}#${prNumber} was merged since tick-start snapshot — marking row + skipping reviewer spawn`
                );
                stmtMarkMerged.run(freshPR.mergedAt, repoPath, prNumber);
                return;
              }
              if (freshPR.state !== 'open') {
                console.log(
                  `[watcher] PR ${repoPath}#${prNumber} was closed since tick-start snapshot (state=${freshPR.state}) — marking row + skipping reviewer spawn`
                );
                stmtMarkClosed.run(new Date().toISOString(), repoPath, prNumber);
                return;
              }
            } catch (err) {
              // Non-fatal — proceed with spawn rather than block. A failed
              // freshness check is no worse than not having one at all.
              console.warn(
                `[watcher] freshness re-check failed for ${repoPath}#${prNumber}; proceeding with spawn:`,
                err?.message || err
              );
            }
            const preSpawnReconciliation = await reconcilePendingDraftsBeforeSpawn({
              repoPath,
              prNumber,
              botTokenEnv: route.botTokenEnv,
              currentHeadSha: reviewerHeadSha,
              respawnAgeSeconds,
              now: new Date(attemptAt),
            });
            if (preSpawnReconciliation.skipSpawn) {
              console.log(
                `[watcher] Skipping reviewer spawn for ${repoPath}#${prNumber}: ` +
                `fresh pending draft retained for ${preSpawnReconciliation.selfLogin} ` +
                `until ${preSpawnReconciliation.respawnDeadlineUtc || 'unknown deadline'}`
              );
              stmtReleaseReviewerClaim.run(reviewerSessionUuid, repoPath, prNumber);
              return;
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

            // Pre-spawn routing-tier readiness probe. Successful probes are
            // cached for the rest of the tick; failed probes get bounded
            // retries plus a very short cache so later PRs can re-check after
            // a brief proxy bounce instead of inheriting a whole-tick outage.
            const routingTierReadiness = await getRoutingTierReadinessForTick();
            if (!routingTierReadiness.ready) {
              console.log(
                `[watcher] Skipping reviewer spawn for ${repoPath}#${prNumber}: ` +
                `routing tier (LiteLLM proxy) not ready (${routingTierReadiness.reason}). ` +
                `Deferring via transient-failure backoff; no attempt budget consumed.`
              );
              settleReviewerAttempt({
                rootDir: ROOT,
                repoPath,
                prNumber,
                result: {
                  ok: false,
                  failureClass: routingTierReadiness.failureClass || 'cascade',
                  error: routingTierReadiness.failureMessage
                    || `Routing-tier readiness probe reported ${routingTierReadiness.reason}.`,
                },
                failureAt: attemptAt,
                maxRemediationRounds,
              });
              return;
            }

            const result = await spawnReviewer({
              repo: repoPath,
              prNumber,
              reviewerModel: route.reviewerModel,
              botTokenEnv: route.botTokenEnv,
              linearTicketId,
              labels: Array.isArray(subject.labels) ? subject.labels : [],
              builderTag: route.tag,
              crossModelReviewWaived: Boolean(crossModelWaiverReason),
              crossModelReviewWaiverReason: crossModelWaiverReason,
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
                  reviewerTimeoutMs,
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
          } finally {
            reservation.release();
          }
        },
      };
      if (reviewerPoolConfig.enabled) {
        reviewerDispatchCandidates.push(dispatchCandidate);
      } else {
        await dispatchCandidate.run();
      }
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
    try {
      const phantomResult = await reconcileProactivePhantomHandoffs({
        rootDir: ROOT,
        repo: repoPath,
        currentPRs: currentRepoPRs,
        runtimeEnv: process.env,
        ghExecFileImpl: execFileAsync,
        execFileImpl: execFileAsync,
      });
      if (phantomResult.inspected > 0) {
        console.log(
          `[watcher] proactive-phantom-handoff ${repoPath}: `
          + `inspected=${phantomResult.inspected} `
          + `grace_started=${phantomResult.graceStarted} `
          + `escalated=${phantomResult.escalated}`
        );
      }
    } catch (scanErr) {
      console.error(
        `[watcher] proactive-phantom-handoff raised for ${repoPath}: ${scanErr?.message || scanErr}`
      );
    }
  }
  if (reviewerPoolConfig.enabled && reviewerDispatchCandidates.length > 0) {
    await runBoundedReviewerDispatchQueue(reviewerDispatchCandidates, {
      maxConcurrent: reviewerPoolConfig.maxConcurrent,
      logger: console,
    });
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
  process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH = resolveRateLimitSharedStatePath(process.env, ROOT);
  try {
    // CFG-02: defaultReviewerRouteFromEnv now consults the loader, which
    // validates the full config.yaml schema. Validate merge-agent here too
    // so a typo in ADVERSARIAL_REVIEW_MERGE_AGENT_WORKER_CLASS or in
    // tools/adversarial-review/config.yaml fails loud at boot instead of
    // hours later at first merge-agent dispatch.
    defaultReviewerRouteFromEnv(process.env);
    validateStartupMergeAgentConfig(process.env);
    resolveWatcherDrainMaxMs(process.env);
    resolvePendingDraftRespawnAgeSeconds(process.env);
    resolveStuckDispatchAlertDebounceMs(process.env);
    validateFenceConfig(process.env);
    if (resolveSigtermFenceMode(process.env) !== 'off') {
      const exitTimeoutCheck = inspectWatcherExitTimeout(process.env);
      if (!exitTimeoutCheck.ok) {
        console.error(`[watcher] WARN config key=plist_exit_timeout_below_grace: ${exitTimeoutCheck.warning}`);
      }
    }
  } catch (err) {
    console.error(
      `[watcher] FATAL config${err?.logKey ? ` key=${err.logKey}` : ''}: ${err?.message || err}`
    );
    throw err;
  }

  const octokit = createWatcherOctokit({
    auth: process.env.GITHUB_TOKEN,
    // Read the live token per request so the long-lived poll octokit picks up
    // each broker refresh (App installation tokens expire ~1h) instead of
    // 401-ing on a stale snapshot. See refreshWatcherGithubToken.
    authProvider: () => process.env.GITHUB_TOKEN,
  });
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
  await processQueuedFenceCleanupJobs();
  await sweepReviewerFencesOnStartup();
  await processQueuedFenceCleanupJobs();
  await reconcileOrphanedReviewing(octokit);
  refreshReviewerRuntimeAdapter();
  await recoverReviewerRunRecords({
    rootDir: ROOT,
    adapter: reviewerRuntimeAdapter,
    adapterForRecord: (record) => reviewerRuntimeAdapterForRunRecord(record, { rootDir: ROOT, logger: console }),
    db,
    log: console,
    leaseRecoveryEnabled: REVIEWER_LEASE_RECOVERY_ENABLED,
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
  amaAuthoritativeReviewerLoginsForModel,
  classifyReviewerFailure,
  createWatcherOctokit,
  attemptDagAutowalkOnMerge,
  cancelReviewerRuntimeSession,
  fireDagAutowalkOnMerge,
  DEFAULT_PENDING_DRAFT_RESPAWN_AGE_SECONDS,
  probeRoutingTierReadiness,
  evaluateRoundBudgetForReview,
  fetchConditionalRestPage,
  fastMergeDecisionFromLabels,
  buildVocabularyFatigueFinding,
  emitVocabularyFatigueFindingForPR,
  fetchLivePRHeadSha,
  fetchLivePRLabels,
  fetchPullRequestCommitSubjects,
  getStalePostedReviewAutoRereviewSuppression,
  handlePostedReviewRow,
  maybeDispatchReviewerTimeoutExhaustedMergeAgent,
  maybeDispatchAmaClosureFor,
  refreshReviewerRuntimeAdapter,
  reviewerRuntimeAdapterForRunRecord,
  resolveMergeAgentCoexistenceForWatcher,
  maybeFireFleetWideFalseDeferralAlert,
  maybeFireMergeAgentStuckAlert,
  pollOnce,
  persistReviewerPgid,
  readWatcherDrainState,
  reconcilePendingDraftsBeforeSpawn,
  reconcileOrphanedReviewing,
  recoverFastMergeVetoes,
  resolvePendingDraftRespawnAgeSeconds,
  resolveVocabularyFatigueConfig,
  resolveReviewerIdentity,
  resolveStuckDispatchAlertDebounceMs,
  resolveWatcherDrainMaxMs,
  resolveFirstPassReviewerPoolConfig,
  runFastMergeClosePathIsolated,
  runBoundedReviewerDispatchQueue,
  reserveReviewerMemoryAdmission,
  resolveMergeAgentLifecycleCleanupPerPoll,
  resolveMergeAgentLifecycleCleanupRetryMs,
  resolveSigtermFenceMode,
  resolveStaleReviewerReconcilePerPoll,
  resolveReviewerTimeoutFallbackThreshold,
  sortReviewerDispatchCandidates,
  retryPendingMergeAgentLifecycleCleanups,
  retryPendingDagAutowalkOnMerge,
  retryPendingMergeCloseouts,
  primaryReviewerQuotaCappedForRow,
  shouldBypassPrimaryReviewerQuotaHold,
  resolveGeminiReviewerModeForWatcher,
  selectReviewerRouteForAttempt,
  shouldDeferReviewForActiveFollowUp,
  shouldRetryMergeAgentLifecycleCleanup,
  shouldPreserveReviewersOnSigterm,
  shouldReconcileAdoptedReviewerSession,
  shouldReconcileReviewerSession,
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
  sweepReviewerFencesOnStartup,
  processQueuedFenceCleanupJobs,
  validateFenceConfig,
  waitForActiveReviewerFencesOnSigterm,
  writeFastMergeAuditEntry,
};
