/**
 * LAC-11: PR Watcher
 * Polls GitHub every N minutes for new agent-built PRs and spawns reviewer agents.
 * Also tracks PR lifecycle (merged/closed) and syncs status to Linear automatically.
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir, hostname } from 'node:os';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join } from 'node:path';
import { signalMalformedTitleFailure } from './watcher-fail-loud.mjs';
import { normalizeGithubMergeability, resolveMergeabilityWithSampling } from './github-mergeability.mjs';
import { createGitHubPRSubjectAdapter, parseSubjectExternalId } from './adapters/subject/github-pr/index.mjs';
import {
  FAST_MERGE_CATEGORY_BY_LABEL,
  buildFastMergeAuditEntry,
  evaluateFastMergeDiffShape,
  fastMergeDecisionFromLabels,
  fetchFastMergeAuthorizationFromTimeline,
  fetchFastMergeChangedFiles,
  fetchLivePRHeadSha,
  fetchLivePRLabels,
  writeFastMergeAuditEntry,
  writeFastMergeAuditPayload,
} from './adapters/subject/github-pr/fast-merge.mjs';
import {
  FLEET_WIDE_FALSE_DEFERRAL_ALERT_DEBOUNCE_MS,
  FLEET_WIDE_FALSE_DEFERRAL_DISTINCT_LRQ_THRESHOLD,
  FLEET_WIDE_FALSE_DEFERRAL_REASON,
  FLEET_WIDE_FALSE_DEFERRAL_STATE_DIR,
  FLEET_WIDE_FALSE_DEFERRAL_WINDOW_MS,
  maybeFireFleetWideFalseDeferralAlert,
} from './fleet-wide-false-deferral-detector.mjs';
import {
  STUCK_DISPATCH_ALERT_DEBOUNCE_MS,
  STUCK_DISPATCH_ALERT_STATE_DIR,
  maybeFireMergeAgentStuckAlert,
  resolveStuckDispatchAlertDebounceMs,
} from './merge-agent-stuck-alert.mjs';
import {
  readReviewerBrokerSharedSecretBestEffort,
  resolveGeminiCredentialConcurrencyForDispatchCandidates,
  writeReviewerTokenUsageArtifactBestEffort,
} from './reviewer-runtime-support.mjs';
import {
  initReviewerRuntime,
  refreshReviewerRuntimeAdapter,
  resolveReviewerRuntimeAdapterForDomainId,
  reviewerRuntimeAdapterForRunRecord,
  reviewerRuntimeState,
} from './reviewer-runtime-adapter.mjs';
import {
  inFlightReviewerSessions,
  activeReviewerSpawns,
} from './reviewer-session-registry.mjs';
import {
  spawnReviewer,
  runWatcherGatedReviewPipeline,
  parsePipelineStageStates,
  settleReviewerAttempt,
  evaluateRoundBudgetForReview,
} from './reviewer-spawn-settle.mjs';
import {
  defaultReviewerRouteFromEnv,
  applyEffectiveReviewerRoute,
  describeCrossModelReviewWaiver,
  routeSubject,
  validateDefaultReviewerRouteConfig,
} from './adapters/subject/github-pr/routing.mjs';
import {
  loadRoleConfig,
  resetRoleConfigCache,
  resolveGeminiRuntime,
  resolveReviewPopulationRetryConfig,
} from './role-config.mjs';
import { validateStartupRoleRegistry } from './role-registry.mjs';
import { validateStartupDeliveryIdentity } from './adapters/comms/github-pr-comments/delivery-identity.mjs';
import { isPipelineEnabled } from './domain-pipeline.mjs';
import { checkAgyReviewerAuth } from './agy-reviewer-auth.mjs';
import { scrubOAuthFallbackEnv } from './secret-source/env.mjs';
import { createCompositeOperatorSurface } from './adapters/operator/index.mjs';
import {
  MERGE_AGENT_DISPATCHED_LABEL,
  OPERATOR_APPROVED_LABEL,
  legacyLabelEventFromControlResult,
} from './adapters/operator/github-pr-label-controls/index.mjs';
import {
  buildSafePollOnce,
  computeWorkloadAwarePollDeadlineMs,
  DEFAULT_POLL_DEADLINE_FLOOR_MS,
} from './watcher-poll-guard.mjs';
import { createWatcherWakeSource } from './watcher-wake.mjs';
import {
  ensureReviewStateSchema,
  listPendingMergeCloseouts,
  openReviewStateDb,
  requestReviewRereview,
} from './review-state.mjs';
// ARC-18: the review-state db handle and prepared statements were extracted to
// ./review-state-db.mjs; import them back so pollOnce and the reviewer/merge
// helpers keep referencing the same shared handles.
import {
  db,
  stmtGetReviewRow,
  stmtGetLatestPostedReviewBody,
  stmtCreateReviewRow,
  stmtCreateFastMergeSkippedReviewRow,
  stmtUpdateReviewRouting,
  stmtUpdateReviewLabels,
  stmtMarkInfraAutoRecoveryAttemptStarted,
  stmtMarkReviewPopulationRetryAttemptStarted,
  stmtMarkUnknownFailureRetryAttemptStarted,
  stmtMarkMalformed,
  stmtMarkAttemptStarted,
  stmtMarkReviewerPgid,
  stmtReleaseReviewerClaim,
  stmtRestoreSameHeadSuppressedReviewPosted,
  stmtMarkReviewerCommandFailedRecoveredPosted,
  stmtMarkReviewCycleCapPaused,
  stmtListFailedOrphanAutoReclaimCandidates,
  stmtAutoReclaimFailedOrphan,
  stmtMarkMerged,
  stmtMarkClosed,
} from './review-state-db.mjs';
import {
  retryPendingMergeCloseouts,
  runFastMergeClosePathIsolated,
} from './pr-lifecycle-sync.mjs';
import {
  maybeDispatchAmaClosureFor,
  resolveMergeAgentCoexistenceForWatcher,
  writeAutonomousMergeDisabledAudit,
} from './ama-closure-orchestration.mjs';
import {
  handlePostedReviewRow,
  runQueuedReviewAdoptionPhase,
} from './posted-review-row.mjs';
import {
  maybeDispatchReviewerTimeoutExhaustedMergeAgent,
} from './reviewer-timeout-exhausted-dispatch.mjs';
import {
  countCompletedReviewerRereviewRounds,
  countDistinctReviewedHeadShas,
  countReviewCeilingUnits,
  reviewCycleExhaustedFromRounds,
} from './review-ceiling-metrics.mjs';
import { scrapeMergeCloseout } from './closeout-scraper.mjs';
import { runStartupStaleStateReaper } from './recovery-reaper.mjs';
import {
  assertReviewDbWritesRoundTrip,
  isSqliteOrphanError,
  isSqliteWriteCanaryError,
} from './sqlite-orphan.mjs';
import {
  shouldBackoffReviewerSpawn,
} from './reviewer-cascade.mjs';
import {
  infraRecoverableFailureClass,
  unknownReviewerCommandFailureClass,
} from './reviewer-failure-classification.mjs';
import { QUOTA_EXHAUSTED_FAILURE_CLASS, quotaHoldDecision } from './quota-exhaustion.mjs';
import { isTransientGhError } from './gh-cli.mjs';
import {
  recoverReviewerRunRecords,
} from './adapters/reviewer-runtime/index.mjs';
import { loadDomainRegistry } from './domain-registry.mjs';
import {
  readReviewerRunRecord,
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
  pollFastMergeQueue,
  reconcileProactivePhantomHandoffs,
  resolveFastMergePerPollCap,
  scanStuckMergeAgentDispatches,
  validateStartupMergeAgentConfig,
} from './follow-up-merge-agent.mjs';
import {
  resolveMergeAgentLifecycleCleanupPerPoll,
  resolveMergeAgentLifecycleCleanupRetryMs,
  retryPendingMergeAgentLifecycleCleanups,
  shouldRetryMergeAgentLifecycleCleanup,
} from './merge-agent-lifecycle-cleanup.mjs';
import {
  attemptDagAutowalkOnMerge,
  fireDagAutowalkOnMerge,
  retryPendingDagAutowalkOnMerge,
} from './dag-autowalk-on-merge.mjs';
import {
  createHeadCloserCommitSuppressionResolver,
  getHeadCloserCommitSuppression,
  getHeadCloserCommitSuppressionWithBoundedRetry,
  isTerminalCloserCommitIdentity,
} from './head-closer-commit-suppression.mjs';
import { deliverAlert as defaultDeliverAlert } from './alert-delivery.mjs';
import {
  buildAdversarialGateSnapshot,
  projectAdversarialGateStatus,
} from './adversarial-gate-status.mjs';
import { fastMergeAuditDir, fastMergeAuditPath } from './fast-merge-audit-storage.mjs';
import { resolveGateStatusContext } from './adversarial-gate-context.mjs';
// MSM-04 — the only agent dispatch left on the AMA surface is the hammer.
// Fully clean PRs merge through the daemon path; dirty/conflicted/red-CI PRs
// route here under the existing launch lease/idempotency machinery.
import {
  maybeDispatchAmaCloser,
  namedAmaNoDispatchReason,
} from './ama/dispatch-closer.mjs';
import { SETTLED_SUCCESS_VERDICTS } from './ama/eligibility.mjs';
// MSM-03 — daemon clean-path merge ("Path B"). A fully-clean (zero blocking AND
// zero non-blocking findings), green, mergeable settled PR is merged INLINE by
// the daemon — a deterministic `gh pr merge` API call, no agent/hammer. Anything
// with a finding falls through to the hammer route (MSM-04) below.
import {
  DAEMON_MERGE_DISPOSITION,
  isDaemonMergeReviewAllowed,
} from './ama/daemon-merge.mjs';
import { evaluateMergeEligibility } from './ama/merge-eligibility.mjs';
import { writeAmaAuditEntry } from './ama/audit.mjs';
import { amaAuthoritativeReviewerLoginsForModel } from './ama/reviewer-authority.mjs';
import {
  decideMergeAgentCoexistence,
  isMergeAgentRequestedScoped,
  mergeAgentDispatchEnvForAction,
} from './ama/coexistence.mjs';
import { loadConfigCached } from './config-loader.mjs';
import { resolveGitHubAppBotLogin } from './github-app-identity.mjs';
import {
  RETRIGGER_REMEDIATION_LABEL,
  tryRetriggerRemediationFromLabel,
} from './follow-up-retrigger-label.mjs';
import {
  RETRIGGER_REVIEW_LABEL,
  tryRetriggerReviewFromLabel,
} from './follow-up-retrigger-review-label.mjs';
import {
  PAUSED_FOR_REDESIGN_LABEL,
  REVIEWER_CYCLE_CAP_REACHED_LABEL,
  buildReviewCycleCapEscalationComment,
  markReviewCycleEscalated,
  recentReviewCycleVerdicts,
  resolveReviewCycleCapConfig,
  shouldEscalateReviewCycle,
} from './review-cycle-cap.mjs';
import {
  subjectRefWithLinearTicket,
  addLabelToPRBestEffort,
  isReviewCycleCapFailedRow,
  isAutomaticReviewCycleCapPause,
  shouldClearReviewCycleCapForOverride,
  postReviewCycleCapEscalation,
  clearReviewCycleCapForOverride,
  reviewBodyHasStandingBlockingFindings,
  recordSuccessfulReviewCycleVerdict,
} from './review-cycle-cap-actions.mjs';
import {
  maybeInlineFinalHammerAfterReview,
  shouldInlineFinalHammerAfterReview,
  resolveFinalToHammerHandoffEnabled,
} from './final-to-hammer-handoff.mjs';
import {
  fetchReviewsForHeadForDedup,
  resolveFirstPassReviewBudgetSuppression,
  getStalePostedReviewBudgetSuppression,
  isExplicitOperatorReviewRetrigger,
} from './first-pass-review-suppression.mjs';
import { getStalePostedReviewAutoRereviewSuppression } from './stale-posted-review-rereview.mjs';
import {
  reconcileOrphanedReviewing,
  shouldReconcileStaleReviewerSession,
  shouldReconcileAdoptedReviewerSession,
  shouldReconcileReviewerSession,
  settleDurableReviewerRunState,
  probeReviewerProcessSession,
  failedOrphanAutoReclaimDecision,
  autoReclaimFailedOrphans,
  persistReviewerPgid,
} from './reviewer-orphan-reconcile.mjs';
import {
  markFastMergeAuditWritten,
  markFastMergeAuditError,
  retryPendingFastMergeAudits,
  recoverFastMergeVetoes,
} from './fast-merge-audit-recovery.mjs';
import {
  resolveDaemonWorkerIdentityForPr,
  readHeadAttestationChainForPr,
  resolveDaemonWorkerIdentityFromHeadAttestation,
} from './daemon-worker-identity.mjs';
import {
  runDaemonCleanMergeAttempt,
  fetchLatestHeadReviewBodiesWithRetry,
  AMA_LIVE_REVIEW_LOOKUP_RETRY_DELAYS_MS,
} from './daemon-clean-merge.mjs';
import { resolveReviewerTimeoutMs } from './reviewer-timeout.mjs';
import { makeReviewPostedProbe, reconcileReviewerSessions, reviewerBotLogin } from './reviewer-reattach.mjs';
import { reconcileReviewerCommandFailedBeforeRetry } from './reviewer-command-failed-recovery.mjs';
import { shouldSkipReviewerForStaleDrift } from './stale-drift.mjs';
import { findLatestFollowUpJob } from './operator-retrigger-helpers.mjs';
import { createWatcherHealthProbe } from './health-probe.mjs';
import {
  createWatcherHeartbeat,
  createWatcherStallWatchdog,
  DEFAULT_WATCHER_STALL_CHECK_INTERVAL_MS,
  DEFAULT_WATCHER_STALL_EXIT_CODE,
  DEFAULT_WATCHER_STALL_WATCHDOG_MS,
} from './watcher-heartbeat.mjs';
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
import { reviewBodyHasScopeViolationFinding } from './additive-only-scope.mjs';
import { sweepEtagCache } from './etag-cache.mjs';
import { refreshReviewerBrokerTokens, refreshWatcherGithubToken } from './reviewer-broker-refresh.mjs';
import {
  fetchPullRequestHeadAndState,
  fetchPullRequestMergeability,
  fetchReviewBodiesForHead,
} from './github-api.mjs';
import {
  computeVocabularyFatigueFindingForPR,
  detectCommitVocabularyFatigue,
  resolveVocabularyFatigueConfig,
} from './vocabulary-fatigue.mjs';
import {
  primaryReviewerQuotaCappedForRow,
  resolveGeminiReviewerModeForWatcher,
  resolveReviewerTimeoutFallbackThreshold,
  resolveStaleReviewerReconcilePerPoll,
  reviewPopulationRetryDecision,
  selectReviewerRouteForAttempt,
  shouldBypassPrimaryReviewerQuotaHold,
} from './reviewer-route-selection.mjs';
import {
  buildDuplicateReviewSkipAudit,
  createHeadDispatchLease,
  headDispatchLeaseKey,
  resolveAlreadyReviewedHeadDedup,
} from './reviewed-head-dispatch-gate.mjs';
import { clearPendingReviewsForSelf, reconcilePendingReviewsForSelf } from './reviewer-pre-write.mjs';
import {
  appendFenceAuditEvent,
  classifyFenceOrphan,
  deleteCleanupJob,
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
  validateFenceConfig,
} from './reviewer-fence.mjs';
import {
  compareReviewerDispatchCandidates,
  createReviewerMemoryAdmissionSampler,
  reserveReviewerMemoryAdmission,
  resolveFirstPassReviewerPoolConfig,
  resolveReviewerMemoryPressureConfig,
  runBoundedReviewerDispatchQueue,
  sortReviewerDispatchCandidates,
} from './watcher-reviewer-pool.mjs';
import {
  DEFAULT_REVIEWER_LEASE_RECOVERY_MAX_ATTEMPTS,
  computeReviewerLeaseExpiryAt,
  resolveReviewerLeaseRecoveryEnabled,
} from './reviewer-lease.mjs';
import {
  createRoutingTierReadinessProbeCache,
  probeRoutingTierReadiness,
} from './routing-tier-readiness.mjs';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// writeReviewerTokenUsageArtifactBestEffort moved to
// ./reviewer-runtime-support.mjs (ARC-18); imported back above.

const config = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'));
// Fail fast during watcher bootstrap; a bad gate-context override should not
// leave reviews running while commit-status publication silently stops later.
resolveGateStatusContext(process.env);

// ARC-03: enumerate the domain registry instead of assuming a single hardcoded
// `code-pr` domain. loadDomainRegistry is fail-loud, so a malformed domain
// config aborts startup rather than silently stranding a subject type. code-pr
// is the only `enabled` domain in production config; the poll loop pumps every
// enabled domain through its own adapter set.
const domainRegistry = loadDomainRegistry(ROOT);
// ARC-03 review finding: the registry is re-read at each poll tick (see
// refreshEnabledDomains) so enabling/adding a domain does not require a
// daemon restart. Startup stays fail-loud; per-tick refresh fails soft and
// keeps the last-known-good list.
let ENABLED_DOMAINS = domainRegistry.enabledDomains;
function refreshEnabledDomains({ logger = console } = {}) {
  try {
    const fresh = loadDomainRegistry(ROOT).enabledDomains;
    if (fresh.length > 0) ENABLED_DOMAINS = fresh;
    else logger.warn('[watcher] domain registry refresh yielded zero enabled domains; keeping previous list');
  } catch (err) {
    logger.warn(`[watcher] domain registry refresh failed; keeping previous list: ${err?.message || err}`);
  }
  return ENABLED_DOMAINS;
}
if (ENABLED_DOMAINS.length === 0) {
  throw new Error(
    '[watcher] domain registry has no enabled domains; refusing to start with nothing to review'
  );
}
// The watcher's GitHub-PR poll path serves the `github-pr` subject channel.
// Resolve that domain from the registry rather than hardcoding 'code-pr'; it is
// also the reviewer-runtime singleton's domain and the default for identity
// construction on the GitHub-PR paths.
const WATCHER_PRIMARY_DOMAIN_ID = (
  ENABLED_DOMAINS.find((domain) => domain.config.subjectChannel === 'github-pr') || ENABLED_DOMAINS[0]
).id;

// Reviewer-runtime adapter lifecycle (state + resolve/refresh/per-record
// functions) moved to ./reviewer-runtime-adapter.mjs (ARC-18); the three
// externally-called functions and the reviewerRuntimeState object are imported
// back above. Initialize the process-wide adapter now that the primary domain
// id is derived, before the poll loop or any reviewer lookup runs.
initReviewerRuntime({ rootDir: ROOT, primaryDomainId: WATCHER_PRIMARY_DOMAIN_ID });

// ── DB setup ────────────────────────────────────────────────────────────────

// The review-state SQLite handle (`db`) and all prepared statements moved to
// ./review-state-db.mjs (ARC-18); `db` + the stmt* handles are imported back
// near the top of this file. openReviewStateDb / ensureReviewStateSchema are
// still imported and used directly below for the per-call localDb path.
const watcherHealthProbe = createWatcherHealthProbe();
const WATCHER_DRAIN_FILE = join(ROOT, 'data', 'watcher-drain.json');
const ADVERSARIAL_REVIEW_STATE_DIR = resolveAdversarialReviewStateDir(ROOT, process.env);
const WATCHER_DRAIN_MAX_MS = 60 * 60 * 1000;
const REVIEWER_DISPATCH_DRAIN_WARN_MS = 30_000;

const REVIEWER_LEASE_RECOVERY_ENABLED = resolveReviewerLeaseRecoveryEnabled({ watcherConfig: config });
const DEFAULT_PENDING_DRAFT_RESPAWN_AGE_SECONDS = 900;
const PENDING_DRAFT_RESPAWN_AGE_MIN_SECONDS_FENCE_ON = 60;
const PENDING_DRAFT_RESPAWN_AGE_MIN_SECONDS_FENCE_OFF = 300;
const PENDING_DRAFT_RESPAWN_AGE_MAX_SECONDS = 1800;
const ETAG_CACHE_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
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
// STUCK_DISPATCH_ALERT_* constants, resolveStuckDispatchAlertDebounceMs, and
// maybeFireMergeAgentStuckAlert moved to ./merge-agent-stuck-alert.mjs (ARC-18);
// all four are imported back above.
// FAST_MERGE_* label/category/default-actor/submodule constants moved to
// ./adapters/subject/github-pr/fast-merge.mjs (ARC-18); FAST_MERGE_CATEGORY_BY_LABEL
// is imported back above for the inline pollOnce label-name membership check.
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
  selfLogin = null,
  currentHeadSha,
  respawnAgeSeconds = resolvePendingDraftRespawnAgeSeconds(),
  now = new Date(),
  fetchImpl = globalThis.fetch,
  reconcileImpl = reconcilePendingReviewsForSelf,
  log = console,
} = {}) {
  const token = process.env[botTokenEnv];
  const resolvedSelfLogin = selfLogin || resolveGitHubAppBotLogin({
    identity: resolveReviewerIdentity({ botTokenEnv }),
    botTokenEnv,
    log,
  });
  const reconciliation = await reconcileImpl({
    repo: repoPath,
    prNumber,
    token,
    selfLogin: resolvedSelfLogin,
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

// normalizeLabelName + fastMergeDecisionFromLabels moved to
// ./adapters/subject/github-pr/fast-merge.mjs (ARC-18).

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

// fetchLivePRLabels, fetchLivePRHeadSha, and fetchFastMergeAuthorizationFromTimeline
// (plus the timeline/label/actor pure helpers and FAST_MERGE_TIMELINE_MAX_PAGES)
// moved to ./adapters/subject/github-pr/fast-merge.mjs (ARC-18); all three are
// imported back above. fetchFastMergeChangedFiles (below) stays for now because it
// threads watcher-owned API throttle/telemetry state (withApiTelemetry).

// fetchFastMergeChangedFiles (and FAST_MERGE_CHANGED_FILES_MAX_PAGES) moved to
// ./adapters/subject/github-pr/fast-merge.mjs (ARC-18); imported back above. It
// takes the watcher's withApiTelemetry as a parameter (passed at the pollOnce
// call site) so the API throttle/telemetry seam stays watcher-owned for now.

// normalizeChangedFile, isMarkdownOrDocsPath, isTestFixturePath,
// isKnownSubmodulePath, fastMergeFileMatchesCategory, evaluateFastMergeDiffShape,
// buildFastMergeAuditEntry, writeFastMergeAuditPayload, and writeFastMergeAuditEntry
// moved to ./adapters/subject/github-pr/fast-merge.mjs (ARC-18); the ones the
// watcher still calls (evaluateFastMergeDiffShape, buildFastMergeAuditEntry,
// writeFastMergeAuditPayload, writeFastMergeAuditEntry) are imported back above.


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
// FLEET_WIDE_FALSE_DEFERRAL_* constants moved to
// ./fleet-wide-false-deferral-detector.mjs (ARC-18); the five that form the
// module's public surface are imported back above.

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveHardReviewCeiling(maxRemediationRounds) {
  if (maxRemediationRounds == null || maxRemediationRounds === '') return 4;
  const numericRounds = Number(maxRemediationRounds);
  return Number.isFinite(numericRounds)
    ? Math.max(0, Math.floor(numericRounds)) + 1
    : 4;
}

// The fleet-wide false-deferral detector (lock helpers, degraded-alert
// reporting, fail-closed, and maybeFireFleetWideFalseDeferralAlert) moved to
// ./fleet-wide-false-deferral-detector.mjs (ARC-18);
// maybeFireFleetWideFalseDeferralAlert is imported back above.


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

let watcherHeartbeat = null;

function markWatcherReviewHeartbeat(details = {}) {
  watcherHeartbeat?.markReview?.(details);
}

function exitForSqliteOrphan(err, contextLabel) {
  const reason = isSqliteWriteCanaryError(err)
    ? 'SQLite DB write canary failed'
    : 'SQLite database file was replaced on disk while we held it open';
  console.error(
    `[watcher] FATAL: ${reason} ` +
    `(${err?.code || 'sqlite-health-failure'} in ${contextLabel}); exiting so launchd KeepAlive can respawn ` +
    `us with a fresh handle. Original error: ${err?.message || err}`
  );
  // Allow the log line to flush before exit.
  process.exitCode = SQLITE_ORPHAN_EXIT_CODE;
  // setImmediate → next tick gives stdout/stderr a chance to flush
  // before the process disappears. process.exit immediately would
  // sometimes truncate the message.
  setImmediate(() => process.exit(SQLITE_ORPHAN_EXIT_CODE));
}

function handlePollError(err, source = 'pollOnce') {
  if (isSqliteOrphanError(err)) {
    exitForSqliteOrphan(err, source);
    return;
  }
  console.error(`[watcher] Poll error (source=${source}):`, err);
}

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
  defaultAdapter = reviewerRuntimeState.adapter,
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

// Bounded auto-recovery of infrastructure-class reviewer failures (2026-06-13
// codex-fleet-spawn incident): failed rows stay operator-visible until the
// normal dispatch path rediscovers the PR and wins the atomic reviewing claim.
// The counter below bounds those claim-path recoveries so a persistent infra
// failure eventually remains terminal instead of retrying forever.
const INFRA_AUTO_RECOVER_CAP = DEFAULT_REVIEWER_LEASE_RECOVERY_MAX_ATTEMPTS;
const DEFAULT_REVIEW_UNKNOWN_FAILURE_MAX_RETRIES = 3;
function resolveReviewUnknownFailureMaxRetries(env = process.env) {
  const raw = env.REVIEW_UNKNOWN_FAILURE_MAX_RETRIES;
  if (raw == null || raw === '') return DEFAULT_REVIEW_UNKNOWN_FAILURE_MAX_RETRIES;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) return DEFAULT_REVIEW_UNKNOWN_FAILURE_MAX_RETRIES;
  return parsed;
}
const REVIEW_UNKNOWN_FAILURE_MAX_RETRIES = resolveReviewUnknownFailureMaxRetries();
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
const DEFAULT_QUOTA_EXHAUSTED_BACKOFF_MS = 15 * 60 * 1000;
function resolveQuotaExhaustedBackoffMs(env = process.env) {
  const raw = env.ADVERSARIAL_QUOTA_EXHAUSTED_FALLBACK_BACKOFF_MS;
  if (raw == null || String(raw).trim() === '') return DEFAULT_QUOTA_EXHAUSTED_BACKOFF_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_QUOTA_EXHAUSTED_BACKOFF_MS;
  return Math.floor(parsed);
}
const QUOTA_EXHAUSTED_BACKOFF_MS = resolveQuotaExhaustedBackoffMs();

const DEFAULT_REVIEW_POPULATION_RETRY_CONFIG = Object.freeze({
  maxAttempts: 1,
  backoffSeconds: 45,
});
function normalizeReviewPopulationRetryConfig(config = {}) {
  const maxAttempts = Number(config.maxAttempts);
  const backoffSeconds = Number(config.backoffSeconds);
  return {
    maxAttempts: Number.isInteger(maxAttempts) && maxAttempts >= 0
      ? maxAttempts
      : DEFAULT_REVIEW_POPULATION_RETRY_CONFIG.maxAttempts,
    backoffSeconds: Number.isFinite(backoffSeconds) && backoffSeconds >= 0
      ? Math.floor(backoffSeconds)
      : DEFAULT_REVIEW_POPULATION_RETRY_CONFIG.backoffSeconds,
  };
}

// REVIEW-DEDUP: in-process (pr, head_sha) lease shared across the tick's
// reviewer-pool workers so two concurrent workers can't both dispatch a review
// for the same head in one window. Cross-process double-dispatch is already
// blocked by the durable `reviewing` claim CAS; this closes the intra-process
// pool race that the CAS alone cannot (both workers read `pending`, both fetch,
// both claim in sequence).
const reviewerHeadDispatchLease = createHeadDispatchLease();

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


// ── Org repo discovery ───────────────────────────────────────────────────────

let activeRepos = config.repos ?? [];
let lastRepoRefresh = 0;
const adversarialGateBranchProtectionChecker = createBranchProtectionChecker({
  execFileImpl: execFileAsync,
});

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

// ── Lifecycle sync, post-review adoption phase, reviewer-timeout handoff ──────
//
// ARC-18: `syncPRLifecycle` moved to ./pr-lifecycle-sync.mjs;
// `runQueuedReviewAdoptionPhase` moved to ./posted-review-row.mjs;
// `maybeDispatchReviewerTimeoutExhaustedMergeAgent` + `isReviewerTimeoutExhaustedRow`
// moved to ./reviewer-timeout-exhausted-dispatch.mjs. pollOnce imports the two it
// calls (runQueuedReviewAdoptionPhase, maybeDispatchReviewerTimeoutExhaustedMergeAgent)
// back (see imports above) and re-exports them.

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
  assertReviewDbWritesRoundTrip(db);
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
      leaseRecoveryMaxAttempts: INFRA_AUTO_RECOVER_CAP,
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
  const orphanReclaim = await autoReclaimFailedOrphans({
    maxRows: resolveStaleReviewerReconcilePerPoll(),
    findPostedReview: makeReviewPostedProbe(octokit),
    log: console,
  });
  if (orphanReclaim.skipped > 0) {
    console.log(
      `[watcher] failed-orphan auto-reclaim skipped=${orphanReclaim.skipped} reclaimed=${orphanReclaim.reclaimed}`
    );
  }

  await warnForMissingAdversarialGateBranchProtection(activeRepos, {
    checker: adversarialGateBranchProtectionChecker,
    baseBranches: config.adversarialGateBaseBranches || {},
    defaultBaseBranch: config.adversarialGateBaseBranch || 'main',
    logger: console,
  });

  // Fast-merge recovery is review-adoption work: vetoes or removed fast-merge
  // labels requeue previously skipped rows into the normal reviewer CAS, and
  // the established contract expects those rows to be claimed in the same tick.
  retryPendingFastMergeAudits();
  await recoverFastMergeVetoes(octokit);
  await runFastMergeClosePathIsolated({ repos: activeRepos });

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
  const reviewerMemoryPressureConfig = resolveReviewerMemoryPressureConfig();
  const reviewerDispatchCandidates = [];
  const postedReviewHandlers = [];
  const postReviewMaintenanceHandlers = [];
  const reviewerMemoryReservationState = { reservedMb: 0 };
  const reviewerMemoryAdmissionSampleForTick = createReviewerMemoryAdmissionSampler({
    logger: console,
    memoryPressureConfig: reviewerMemoryPressureConfig,
  });
  const getRoutingTierReadinessForTick = createRoutingTierReadinessProbeCache();
  const reviewerCommandFailedReviewProbe = makeReviewPostedProbe(octokit);
  async function drainReviewerDispatchCandidates(reason) {
    if (!reviewerPoolConfig.enabled || reviewerDispatchCandidates.length === 0) {
      return { dispatched: 0, maxObservedConcurrency: 0 };
    }
    const candidates = reviewerDispatchCandidates.splice(0, reviewerDispatchCandidates.length);
    const startedAt = process.hrtime.bigint();
    console.log(
      `[watcher] Draining ${candidates.length} reviewer dispatch candidate(s) before ${reason}`
    );
    try {
      // The reviewer runtime contract is fire-and-return: this drain may wait
      // for admission, token refresh, and child spawn bookkeeping, but reviewer
      // subprocess execution is detached and bounded by its own timeout. The
      // outer safePollOnce deadline still bounds pathological drain wedges.
      // Cap concurrent GEMINI reviewers at the live broker credential count so
      // they don't over-dispatch against a single-account pool and lose the
      // checkout-lease race (the "no credential with remaining quota"
      // misdiagnosis). Fail-open: a missing broker URL / secret / endpoint
      // yields null => no gemini cap, so review dispatch never wedges on this.
      const geminiCredentialConcurrency =
        await resolveGeminiCredentialConcurrencyForDispatchCandidates(candidates);
      return await runBoundedReviewerDispatchQueue(candidates, {
        maxConcurrent: reviewerPoolConfig.maxConcurrent,
        geminiCredentialConcurrency,
        logger: console,
      });
    } finally {
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      if (elapsedMs >= REVIEWER_DISPATCH_DRAIN_WARN_MS) {
        console.warn(
          `[watcher] reviewer dispatch drain exceeded SLA: ` +
          `elapsed_ms=${Math.round(elapsedMs)} candidates=${candidates.length} reason="${reason}"`
        );
      }
    }
  }

  // ARC-03: pump every enabled domain through its own adapter set instead of
  // assuming a single hardcoded `code-pr` domain. Each enabled domain resolves
  // its own reviewer-runtime adapter (isolated from other domains); the primary
  // github-pr domain owns the polled repos. Flattening domains × repos into one
  // work-list keeps the existing per-repo body intact while threading the
  // domain identity through it. code-pr is the only enabled domain in
  // production, so this iterates exactly the repos it did before.
  refreshEnabledDomains({ logger: console });
  const domainAdapterSets = ENABLED_DOMAINS.map((domain) => ({
    domainId: domain.id,
    domainConfig: domain.config,
    reviewerRuntimeAdapter: resolveReviewerRuntimeAdapterForDomainId(domain.id),
  }));
  const domainRepoWork = [];
  for (const domainAdapterSet of domainAdapterSets) {
    if (!domainAdapterSet.reviewerRuntimeAdapter) {
      console.warn(
        `[watcher] domain ${domainAdapterSet.domainId} has no usable reviewer-runtime adapter this tick; skipping`
      );
      continue;
    }
    const domainRepos = domainAdapterSet.domainConfig.subjectChannel === 'github-pr'
      ? activeRepos
      : [];
    for (const repoPath of domainRepos) {
      domainRepoWork.push({ domainAdapterSet, repoPath });
    }
  }

  for (const { domainAdapterSet, repoPath } of domainRepoWork) {
    const domainId = domainAdapterSet.domainId;
    const domainReviewerRuntimeAdapter = domainAdapterSet.reviewerRuntimeAdapter;
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
      const linearTicketId = operatorSurface.extractLinearTicketId(prTitle);
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
      // ARC-03 review finding: review rows are keyed (repo, pr) but carry a
      // domain identity. Only the owning domain may process a row — without
      // this guard, a second github-pr domain would drive another domain's
      // record through its own handlers (gate/identity corruption, duplicate
      // downstream actions). A non-owning domain skips the PR this tick.
      if (
        existing &&
        String(existing.domain_id || WATCHER_PRIMARY_DOMAIN_ID) !== String(domainId)
      ) {
        continue;
      }
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

      // 'failed-orphan' is only eligible through the guarded auto-reclaim pass
      // at the top of the tick (expired lease + no live reviewer process) or
      // the explicit operator reset path. The generic PR dispatch loop must
      // still skip any failed-orphan row that reaches this point.
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

      if (
        isAutomaticReviewCycleCapPause(existing) &&
        !prLabelNames.includes(REVIEWER_CYCLE_CAP_REACHED_LABEL)
      ) {
        const labelAdd = await addLabelToPRBestEffort(octokit, {
          repoPath,
          prNumber,
          label: REVIEWER_CYCLE_CAP_REACHED_LABEL,
          logger: console,
        });
        if (labelAdd.added) {
          prLabelNames.push(REVIEWER_CYCLE_CAP_REACHED_LABEL);
        }
      }

      if (shouldClearReviewCycleCapForOverride({ reviewRow: existing, labelNames: prLabelNames })) {
        try {
          await clearReviewCycleCapForOverride({
            db,
            octokit,
            repoPath,
            prNumber,
            headSha: subject.headSha || subject.ref?.revisionRef || null,
            labelNames: prLabelNames,
            logger: console,
          });
          prLabelNames.splice(0, prLabelNames.length, ...prLabelNames.filter(
            (label) => label !== REVIEWER_CYCLE_CAP_REACHED_LABEL
          ));
          existing = stmtGetReviewRow.get(repoPath, prNumber);
        } catch (err) {
          console.error(
            `[watcher] review-cycle-cap override cleanup failed for ${repoPath}#${prNumber}:`,
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
      const resolveHeadCloserCommitSuppression = createHeadCloserCommitSuppressionResolver({
        repoPath,
        prNumber,
        headSha: subject.headSha,
        execFileImpl: execFileAsync,
        logger: console,
      });
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
          domainId,
          execFileImpl: execFileAsync,
          logger: console,
        })
        : { suppressed: false, reason: null };
      const stalePostedReviewCloserSuppression =
        postedReviewHeadMoved && !stalePostedReviewSuppression.suppressed
          ? await resolveHeadCloserCommitSuppression()
          : { suppressed: false, reason: null };
      const stalePostedReviewBudgetSuppression =
        postedReviewHeadMoved &&
          !stalePostedReviewSuppression.suppressed &&
          !stalePostedReviewCloserSuppression.suppressed
          ? getStalePostedReviewBudgetSuppression({
            rootDir: ROOT,
            domainId,
            repoPath,
            prNumber,
            linearTicketId,
            reviewRow: existing,
            currentHeadSha: subject.headSha,
            labelNames: prLabelNames,
            logger: console,
            db,
          })
          : { suppressed: false, reason: null };
      if (postedReviewHeadMoved && stalePostedReviewSuppression.suppressed) {
        console.log(
          `[watcher] auto-refresh SUPPRESSED for ${repoPath}#${prNumber}: ` +
            `head moved ${existing.reviewer_head_sha.slice(0, 12)} → ${subject.headSha.slice(0, 12)} ` +
            `because ${stalePostedReviewSuppression.reason}; leaving posted review to the merge-agent`
        );
      } else if (postedReviewHeadMoved && stalePostedReviewCloserSuppression.suppressed) {
        console.log(
          `[watcher] auto-refresh SUPPRESSED for ${repoPath}#${prNumber}: ` +
            `head moved ${existing.reviewer_head_sha.slice(0, 12)} → ${subject.headSha.slice(0, 12)} ` +
            `because ${stalePostedReviewCloserSuppression.reason}; leaving posted review intact`
        );
      } else if (postedReviewHeadMoved && stalePostedReviewBudgetSuppression.suppressed) {
        const budgetDetail =
          stalePostedReviewBudgetSuppression.reason === 'remediation-round-budget-exhausted'
            ? ` (${stalePostedReviewBudgetSuppression.completedRoundsForPR}/${stalePostedReviewBudgetSuppression.roundBudget} rounds, ` +
              `risk=${stalePostedReviewBudgetSuppression.riskClass || 'unknown'})`
            : '';
        console.log(
          `[watcher] auto-refresh SUPPRESSED for ${repoPath}#${prNumber}: ` +
            `head moved ${existing.reviewer_head_sha.slice(0, 12)} → ${subject.headSha.slice(0, 12)} ` +
            `because ${stalePostedReviewBudgetSuppression.reason}${budgetDetail}; ` +
            `leaving posted review intact and routing exhausted close through AMA/HAM`
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
        const runPostedReviewHandler = () => handlePostedReviewRow({
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
          domainId,
        });
        postedReviewHandlers.push({
          repoPath,
          prNumber,
          run: runPostedReviewHandler,
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
            domainId,
            subject.ref.subjectExternalId,
            subject.ref.revisionRef || subject.headSha || null,
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
      console.log(
        `[watcher] gemini-mode resolved=${geminiReviewerMode} ` +
          `source=${geminiModeResolution.source || 'unknown'} ` +
          `topPath=${geminiModeResolution.topPath || '<unknown>'}`
      );
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
            `mode-source=${geminiModeResolution.source || 'unknown'}; ` +
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
                withApiTelemetry,
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
                domainId,
                subject.ref.subjectExternalId,
                authorizedHeadSha || subject.ref.revisionRef || subject.headSha || null,
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
          domainId,
          subject.ref.subjectExternalId,
          subject.ref.revisionRef || subject.headSha || null,
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
        domainId,
      });
      if (timeoutExhaustionHandoff.handled) {
        continue;
      }

      const infraRecoveryClass = current?.review_status === 'failed'
        ? infraRecoverableFailureClass(current)
        : null;
      const unknownFailureClass = current?.review_status === 'failed' && !infraRecoveryClass
        ? unknownReviewerCommandFailureClass(current)
        : null;
      const reviewPopulationRetryConfig = normalizeReviewPopulationRetryConfig(resolveReviewPopulationRetryConfig());
      const populationRetry = current?.review_status === 'failed' && !infraRecoveryClass && !unknownFailureClass
        ? reviewPopulationRetryDecision(current, {
          config: reviewPopulationRetryConfig,
          headSha: subject?.headSha || null,
        })
        : { matched: false, retryable: false };
      const unknownFailureAttempts = Number(current?.review_attempts || 0);
      const unknownFailureRetryable = Boolean(
        unknownFailureClass && unknownFailureAttempts < REVIEW_UNKNOWN_FAILURE_MAX_RETRIES
      );
      if (populationRetry.matched && populationRetry.action === 'wait') {
        console.log(
          `[watcher] Holding review-population retry for ${repoPath}#${prNumber}: ` +
            `class=${populationRetry.failureClass} attempts=${populationRetry.attempts}/${populationRetry.maxAttempts}; ` +
            `waiting until ${new Date(populationRetry.waitUntilMs).toISOString()}`
        );
        continue;
      }
      const reviewPopulationRetryable = Boolean(
        populationRetry.matched && populationRetry.action === 'retry'
      );
      if (current?.review_status === 'failed' && !infraRecoveryClass && !unknownFailureRetryable && !reviewPopulationRetryable) {
        if (unknownFailureClass) {
          console.log(
            `[watcher] Unknown reviewer failure retry cap exhausted for ${repoPath}#${prNumber}: ` +
              `attempts=${unknownFailureAttempts}/${REVIEW_UNKNOWN_FAILURE_MAX_RETRIES}; ` +
              `leaving evidence intact`
          );
          continue;
        }
        if (populationRetry.matched && populationRetry.action === 'exhausted') {
          console.log(
            `[watcher] Review-population retry cap exhausted for ${repoPath}#${prNumber}: ` +
              `class=${populationRetry.failureClass} attempts=${populationRetry.attempts}/${populationRetry.maxAttempts}; ` +
              `leaving evidence intact`
          );
          continue;
        }
        console.log(
          `[watcher] Skipping failed review ${repoPath}#${prNumber}: ` +
            `failure is not infrastructure-recoverable; leaving evidence intact`
        );
        continue;
      }
      if (infraRecoveryClass === 'reviewer-command-failed') {
        const reconciliation = await reconcileReviewerCommandFailedBeforeRetry({
          row: current,
          findPostedReview: reviewerCommandFailedReviewProbe,
          markPosted: ({ postedAt, row }) => {
            const changes = stmtMarkReviewerCommandFailedRecoveredPosted.run(
              postedAt,
              row.repo,
              row.pr_number,
              row.reviewer_session_uuid,
              row.reviewer_started_at,
            ).changes;
            if (changes === 1) {
              markWatcherReviewHeartbeat({ repo: row.repo, pr_number: row.pr_number, posted_at: postedAt });
            }
            return changes;
          },
          settleRunRecord: ({ sessionUuid, state, settledAt, reason }) => settleDurableReviewerRunState({
            sessionUuid,
            state,
            settledAt,
            reason,
          }),
          resolveReviewerLogin: reviewerBotLogin,
          log: console,
        });
        if (reconciliation.handled) {
          continue;
        }
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

      if (!isExplicitOperatorReviewRetrigger(existing)) {
        const closerSpawnSuppression = await resolveHeadCloserCommitSuppression();
        if (closerSpawnSuppression.suppressed) {
          console.log(
            `[watcher] reviewer spawn SUPPRESSED for ${repoPath}#${prNumber}: ` +
              `${closerSpawnSuppression.reason} on head ${String(subject.headSha || '').slice(0, 12) || 'unknown'}`
          );
          continue;
        }

        const firstPassBudgetSuppression = resolveFirstPassReviewBudgetSuppression({
          rootDir: ROOT,
          domainId,
          repoPath,
          prNumber,
          linearTicketId,
          reviewRow: existing,
          currentHeadSha: subject.headSha,
          labelNames: prLabelNames,
          logger: console,
          db,
        });
        if (firstPassBudgetSuppression.suppressed) {
          const budgetDetail =
            firstPassBudgetSuppression.reason === 'remediation-round-budget-exhausted'
              ? ` (${firstPassBudgetSuppression.completedRoundsForPR}/${firstPassBudgetSuppression.roundBudget} rounds, ` +
                `risk=${firstPassBudgetSuppression.riskClass || 'unknown'})`
              : '';
          let rowActionDetail = 'leaving existing review row intact';
          if (firstPassBudgetSuppression.reason === 'same-head-already-reviewed') {
            const restored = stmtRestoreSameHeadSuppressedReviewPosted.run(
              new Date().toISOString(),
              repoPath,
              prNumber,
              subject.headSha
            );
            rowActionDetail = restored.changes === 1
              ? "restored review_status='posted'"
              : "same-head restore skipped by CAS";
          }
          console.log(
            `[watcher] reviewer spawn SUPPRESSED for ${repoPath}#${prNumber}: ` +
              `${firstPassBudgetSuppression.reason}${budgetDetail}; ${rowActionDetail}`
          );
          continue;
        }
      }

      const cycleCapConfig = resolveReviewCycleCapConfig({
        loadConfigImpl: loadConfigCached,
        logger: console,
      });
      const cycleCapDecision = shouldEscalateReviewCycle(db, {
        repo: repoPath,
        prNumber,
        headSha: subject.headSha || null,
        cap: cycleCapConfig.cap,
        windowHours: cycleCapConfig.windowHours,
        now: new Date().toISOString(),
      });
      if (cycleCapDecision.escalate) {
        const escalatedAt = new Date().toISOString();
        const recentVerdicts = recentReviewCycleVerdicts(db, {
          repo: repoPath,
          prNumber,
          limit: cycleCapConfig.cap,
        });
        const body = buildReviewCycleCapEscalationComment({
          cap: cycleCapConfig.cap,
          recentVerdicts,
        });
        if (!cycleCapDecision.alreadyEscalated) {
          try {
            await postReviewCycleCapEscalation(octokit, {
              repoPath,
              prNumber,
              body,
            });
            // Persist the dedupe marker the instant the comment posts,
            // before the label add, so a transient label-add failure cannot
            // re-post the escalation comment on the next tick.
            const escalationMark = markReviewCycleEscalated(db, {
              repo: repoPath,
              prNumber,
              headSha: subject.headSha || null,
              escalatedAt,
            });
            if (!escalationMark?.marked && escalationMark?.reason === 'missing-head-sha') {
              // Loud so the silent no-op is observable: with no head SHA the
              // escalation dedupe never engages, so the comment can re-post
              // every tick.
              console.warn(
                `[watcher] review-cycle-cap escalation marker NOT persisted for ${repoPath}#${prNumber}: ` +
                  'missing head SHA (escalation dedupe disabled; comment may re-post)'
              );
            }
            await addLabelToPRBestEffort(octokit, {
              repoPath,
              prNumber,
              label: REVIEWER_CYCLE_CAP_REACHED_LABEL,
              logger: console,
            });
            console.warn(
              `[watcher] review-cycle-cap reached for ${repoPath}#${prNumber}: ` +
                `next_count=${cycleCapDecision.count} cap=${cycleCapConfig.cap}; ` +
                `posted escalation and added ${REVIEWER_CYCLE_CAP_REACHED_LABEL}`
            );
          } catch (err) {
            console.error(
              `[watcher] review-cycle-cap escalation failed for ${repoPath}#${prNumber}:`,
              err?.message || err
            );
            continue;
          }
        } else {
          console.log(
            `[watcher] review-cycle-cap already escalated for ${repoPath}#${prNumber}; ` +
              `automatic review remains paused`
          );
        }
        const alreadyCapPaused = isReviewCycleCapFailedRow(current);
        if (!alreadyCapPaused) {
          stmtMarkReviewCycleCapPaused.run(
            escalatedAt,
            `[review-cycle-cap] automatic remediation budget exhausted after ${cycleCapConfig.cap} successive review/remediation cycles; dispatching final hammer close unless blocked by structural gates, explicit operator labels, or ${PAUSED_FOR_REDESIGN_LABEL}`,
            repoPath,
            prNumber,
          );
        }
        continue;
      }

      const dispatchCandidate = {
        repoPath,
        prNumber,
        subject,
        current,
        enqueuedAtMs: Date.now(),
        async run() {
          // REVIEW-DEDUP (idempotency lease): one (pr, head) dispatch per
          // window. A second pool worker racing the same head is turned away
          // here before it can fetch, claim, or spawn.
          const dispatchLeaseKey = headDispatchLeaseKey({
            repoPath,
            prNumber,
            headSha: subject?.headSha,
          });
          if (!reviewerHeadDispatchLease.tryAcquire(dispatchLeaseKey)) {
            console.log(
              `[watcher] reviewer dispatch SKIPPED for ${repoPath}#${prNumber}: ` +
                `(pr, head) dispatch lease already held this window (${dispatchLeaseKey}); ` +
                `another pool worker owns this head`
            );
            return;
          }

          let reservation = null;
          try {
            // REVIEW-DEDUP (authoritative reviewed-head gate): never dispatch a
            // review for a head that already has a completed review (GitHub
            // per-review commit_id === head). This composes WITH — never replaces
            // — attestation consumption, and runs before any claim/spawn so a
            // duplicate consumes no attempt budget and no re-review ceiling.
            const reviewedHeadDedup = await resolveAlreadyReviewedHeadDedup({
              repoPath,
              prNumber,
              headSha: subject?.headSha || null,
              reviewerLogins: amaAuthoritativeReviewerLoginsForModel(route.reviewerModel),
              fetchReviewsForHeadImpl: fetchReviewsForHeadForDedup,
              logger: console,
            });
            if (reviewedHeadDedup.alreadyReviewed) {
              console.log(buildDuplicateReviewSkipAudit({
                repoPath,
                prNumber,
                headSha: subject?.headSha || null,
                reviewId: reviewedHeadDedup.reviewId,
              }));
              return;
            }

            reservation = await reserveReviewerMemoryAdmission({
              reviewerModel: route.reviewerModel,
              reservationState: reviewerMemoryReservationState,
              getMemoryPressureSample: reviewerMemoryAdmissionSampleForTick,
              memoryPressureConfig: reviewerMemoryPressureConfig,
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
                infraRecoveryClass,
                infraRecoveryClass,
                infraRecoveryClass
              )
              : reviewPopulationRetryable
                ? stmtMarkReviewPopulationRetryAttemptStarted.run(
                  attemptAt,
                  reviewerSessionUuid,
                  reviewerHeadSha,
                  reviewerTimeoutMs,
                  reviewerLeaseExpiresAt,
                  reviewerHeadSha,
                  attemptAt,
                  reviewerHeadSha,
                  repoPath,
                  prNumber,
                  reviewerHeadSha,
                  reviewPopulationRetryConfig.maxAttempts
                )
              : unknownFailureRetryable
                ? stmtMarkUnknownFailureRetryAttemptStarted.run(
                  attemptAt,
                  reviewerSessionUuid,
                  reviewerHeadSha,
                  reviewerTimeoutMs,
                  reviewerLeaseExpiresAt,
                  repoPath,
                  prNumber,
                  REVIEW_UNKNOWN_FAILURE_MAX_RETRIES
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
            if (unknownFailureRetryable) {
              console.log(
                `[watcher] Claimed unknown-failed review ${repoPath}#${prNumber} ` +
                  `(attempt ${unknownFailureAttempts + 1}/${REVIEW_UNKNOWN_FAILURE_MAX_RETRIES})`
              );
            }
            if (reviewPopulationRetryable) {
              console.log(
                `[watcher] Claimed review-population retry ${repoPath}#${prNumber} ` +
                  `(class=${populationRetry.failureClass}, attempt ${populationRetry.attempts + 1}/${reviewPopulationRetryConfig.maxAttempts})`
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
            const completedRemediationRounds = Number.isFinite(Number(ledger.completedRoundsForPR))
              ? Math.max(0, Math.floor(Number(ledger.completedRoundsForPR)))
              : 0;
            const passKind = reviewAttemptNumber > 1 || current?.rereview_requested_at
              ? 'rereview'
              : 'first-pass';
            const vocabularyFatigueFinding = passKind === 'rereview'
              ? await computeVocabularyFatigueFindingForPR({
                repoPath,
                prNumber,
              })
              : null;
            if (vocabularyFatigueFinding) {
              console.log(
                `[watcher] vocabulary fatigue ${repoPath}#${prNumber}: ` +
                  `stem=${vocabularyFatigueFinding.stem} ` +
                  `count=${vocabularyFatigueFinding.count}/${vocabularyFatigueFinding.window}`
              );
            }

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

            // Standing policy: the hammer ALWAYS closes on exhaustion and must
            // NEVER trigger a re-review. Two gates before spawning a reviewer on
            // a re-review pass:
            //
            // (1) Terminal closer head — when the current PR head is a terminal
            //     closer commit (Closed-By: hammer / closer identity), the
            //     hammer's remediation IS terminal; do NOT re-review it.
            //     Re-reviewing resets the remediation round counter, so
            //     reviewState.reviewCycleExhausted never trips and the terminal
            //     close (ham_terminal_remediation_validated, dispatch-closer.mjs)
            //     never fires — the runaway remediate->review->remediate loop.
            //     Skip the spawn (no attempt budget consumed); the tick falls
            //     through to the merge/close path.
            //
            // (2) Hard review ceiling — independently, never review one PR more
            //     than (round budget + 1) times regardless of head churn, so the
            //     adversarial-review count is bounded even if (1) is bypassed.
            let skipReviewerSpawnReason = null;
            if (passKind === 'rereview') {
              const closerHead = await getHeadCloserCommitSuppressionWithBoundedRetry({
                repoPath,
                prNumber,
                headSha: reviewerHeadSha,
                logger: console,
              });
              if (closerHead?.suppressed) {
                console.log(
                  `[watcher] Skipping re-review for ${repoPath}#${prNumber}: head ` +
                  `${String(reviewerHeadSha || '').slice(0, 12)} is a terminal closer commit ` +
                  `(${closerHead.reason}); hammer remediation is terminal — deferring to the ` +
                  `close path. No attempt budget consumed.`,
                );
                skipReviewerSpawnReason = 'terminal-closer-head';
              }

              const hardReviewCeiling = resolveHardReviewCeiling(maxRemediationRounds);
              // REVIEW-DEDUP: completed reviews are capped by distinct head,
              // while failed attempts on this head still consume units so a
              // broken reviewer path cannot retry forever. Legacy null-head
              // rows count individually because their head cannot be de-duped.
              const priorReviewCount = countReviewCeilingUnits({
                db,
                rootDir: ROOT,
                repoPath,
                prNumber,
                currentHeadSha: reviewerHeadSha,
                fallbackReviewAttempts: Number(current?.review_attempts || 0),
              });
              if (!skipReviewerSpawnReason && priorReviewCount >= hardReviewCeiling) {
                console.log(
                  `[watcher] Skipping re-review for ${repoPath}#${prNumber}: hard review ` +
                  `ceiling reached (${priorReviewCount} review ceiling units >= ${hardReviewCeiling}); ` +
                  `adversarial reviews are capped per PR — deferring to the close path. ` +
                  `No attempt budget consumed.`,
                );
                skipReviewerSpawnReason = 'hard-review-ceiling';
              }
            }

            if (skipReviewerSpawnReason) {
              stmtReleaseReviewerClaim.run(reviewerSessionUuid, repoPath, prNumber);
              console.log(
                `[watcher] Released reviewer claim for ${repoPath}#${prNumber} after ` +
                `${skipReviewerSpawnReason}; continuing to watcher close/maintenance path.`
              );
            } else {
              const spawnReviewerArgs = {
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
                completedRemediationRounds,
                passKind,
                maxRemediationRounds,
                advisoryFindings: vocabularyFatigueFinding ? [vocabularyFatigueFinding] : [],
                reviewerSessionUuid,
                reviewerTimeoutMs,
                workspacePath: null,
                domainId,
                reviewerRuntimeAdapterOverride: domainReviewerRuntimeAdapter,
                onReviewerPgid: ({ pgid, spawnedAt }) => {
                  persistReviewerPgid({
                    pgid,
                    reviewerSessionUuid,
                    repoPath,
                    prNumber,
                    startedAt: spawnedAt,
                    reviewerTimeoutMs,
                    handlePollErrorImpl: handlePollError,
                  });
                },
              };
              // ARC-13: when the domain enables the sequential review pipeline
              // (default OFF), drive the two-stage pipeline instead of a single
              // review and post the Win 2 rollup. Gate-off is byte-identical:
              // the else-branch is the unchanged v1 single `spawnReviewer` call.
              const result = isPipelineEnabled(domainAdapterSet.domainConfig)
                ? await runWatcherGatedReviewPipeline({
                  domainConfig: domainAdapterSet.domainConfig,
                  domainId,
                  repoPath,
                  prNumber,
                  reviewerHeadSha,
                  riskClass: ledger.latestRiskClass,
                  reviewAttemptNumber,
                  spawnReviewerArgs,
                  stageStates: parsePipelineStageStates(ledger.pipeline_stage_states_json),
                })
                : await spawnReviewer(spawnReviewerArgs);
              if (result.ok) {
                healthProbe?.recordSpawn?.(healthTick, { at: attemptAt });
              }

              settleReviewerAttempt({
                rootDir: ROOT,
                repoPath,
                prNumber,
                result,
                maxRemediationRounds,
                // ARC-18: watcher owns the heartbeat singleton; thread it in.
                markReviewHeartbeat: markWatcherReviewHeartbeat,
              });
              await maybeInlineFinalHammerAfterReview({
                rootDir: ROOT,
                repoPath,
                prNumber,
                result,
                passKind,
                completedRemediationRounds,
                maxRemediationRounds,
                subjectRef: subject.ref,
                currentRevisionRef: subject.ref.revisionRef,
                labelNames: prLabelNames,
                projectGateStatusSafe,
                execFileImpl: execFileAsync,
                operatorSurface,
                logger: console,
                handlePostedReviewRowImpl: handlePostedReviewRow,
              });
            }
          } finally {
            if (reservation) reservation.release();
            reviewerHeadDispatchLease.release(dispatchLeaseKey);
          }
        },
      };
      if (reviewerPoolConfig.enabled) {
        reviewerDispatchCandidates.push(dispatchCandidate);
      } else {
        await dispatchCandidate.run();
      }
    }

    postReviewMaintenanceHandlers.push({
      repoPath,
      async run() {
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
      },
    });
  }

  await runQueuedReviewAdoptionPhase({
    drainReviewerDispatchCandidates,
    postedReviewHandlers,
    postReviewMaintenanceHandlers,
    octokit,
    operatorSurface,
    primaryDomainId: WATCHER_PRIMARY_DOMAIN_ID,
  });
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

async function warnIfAntigravityReviewerAuthUnavailable({
  env = process.env,
  log = console,
  resolveGeminiRuntimeImpl = resolveGeminiRuntime,
  checkAgyReviewerAuthImpl = checkAgyReviewerAuth,
  scrubOAuthFallbackEnvImpl = scrubOAuthFallbackEnv,
} = {}) {
  const runtime = resolveGeminiRuntimeImpl({ env });
  if (runtime !== 'antigravity') {
    return { checked: false, runtime };
  }

  const { env: scrubbedEnv } = scrubOAuthFallbackEnvImpl({
    ...env,
    HOME: env.HOME || homedir(),
  });
  let result;
  try {
    result = await checkAgyReviewerAuthImpl({ env: scrubbedEnv });
  } catch (err) {
    const detail = err?.message ? `: ${err.message}` : '';
    log.warn?.(
      `[watcher] WARN config key=reviewer.gemini.runtime: ` +
      `antigravity agy auth startup preflight threw (agy-probe-threw)${detail}. ` +
      'Startup will continue; the per-review AGY auth probe remains fail-closed.'
    );
    return { checked: true, ok: false, reason: 'agy-probe-threw' };
  }
  if (result?.ok) {
    return { checked: true, ok: true, reason: null, cached: Boolean(result.cached) };
  }

  const reason = result?.reason || 'agy-probe-failed';
  const detail = result?.detail ? `: ${result.detail}` : '';
  const remediation = result?.remediation ? ` ${result.remediation}` : '';
  log.warn?.(
    `[watcher] WARN config key=reviewer.gemini.runtime: ` +
    `antigravity agy auth startup preflight failed (${reason})${detail}.${remediation}`
  );
  return { checked: true, ok: false, reason };
}

function isProcessAlive(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return false;
  try {
    process.kill(numericPid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function resolveWatcherHandoffEnabled({ loadConfigImpl = loadConfigCached, env = process.env } = {}) {
  try {
    return loadConfigImpl({ env }).getHandoffConfig().enabled === true;
  } catch (err) {
    console.error(`[watcher] WARN handoff config disabled for this poll sleep: ${err?.message || err}`);
    return false;
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
    validateDefaultReviewerRouteConfig(process.env);
    validateStartupMergeAgentConfig(process.env);
    // ARC-12: the role registry (roles.registry) is validated at boot so a
    // malformed role or a workerClass outside the hq-published roster fails
    // loud here, not at first pipeline dispatch. Empty by default (no roles),
    // so this is a no-op until a domain opts into the registry.
    validateStartupRoleRegistry({ env: process.env });
    // ARC-12 (review #631): every registered role must have a bound comms
    // delivery identity at boot — fail loud here, not after a review runs.
    validateStartupDeliveryIdentity({ env: process.env });
    resolveWatcherDrainMaxMs(process.env);
    resolvePendingDraftRespawnAgeSeconds(process.env);
    resolveStuckDispatchAlertDebounceMs(process.env);
    validateFenceConfig(process.env);
    await warnIfAntigravityReviewerAuthUnavailable({ env: process.env });
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
  const heartbeatPath = process.env.ADVERSARIAL_WATCHER_HEARTBEAT_PATH || undefined;
  const configuredStallMs = Number(process.env.ADVERSARIAL_WATCHER_STALL_WATCHDOG_MS);
  const stallWatchdogMs = Number.isFinite(configuredStallMs) && configuredStallMs > 0
    ? configuredStallMs
    : Math.max(DEFAULT_WATCHER_STALL_WATCHDOG_MS, intervalMs * 3);
  const configuredStallCheckMs = Number(process.env.ADVERSARIAL_WATCHER_STALL_CHECK_INTERVAL_MS);
  const stallWatchdogCheckMs = Number.isFinite(configuredStallCheckMs) && configuredStallCheckMs > 0
    ? configuredStallCheckMs
    : Math.min(DEFAULT_WATCHER_STALL_CHECK_INTERVAL_MS, Math.max(1_000, Math.floor(stallWatchdogMs / 4)));

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
    adapter: reviewerRuntimeState.adapter,
    adapterForRecord: (record) => reviewerRuntimeAdapterForRunRecord(record, { rootDir: ROOT, logger: console }),
    db,
    log: console,
    leaseRecoveryEnabled: REVIEWER_LEASE_RECOVERY_ENABLED,
  });

  // Offline-period resilience: after a host outage (macOS upgrade + os-restart,
  // a GitHub rate-limit storm, or any long watcher-down window) reviewer passes
  // can be stranded `status='running'` and AMA closer leases stranded
  // `pending|dispatched`/`terminalOutcome=null`. Age-gated reaping releases
  // both so PRs re-review and closers re-dispatch instead of wedging until a
  // manual rescue. Never throws — a reaper failure must not block polling.
  await runStartupStaleStateReaper({
    rootDir: ROOT,
    db,
    env: process.env,
    logger: console,
    isProcessAlive,
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
    `[watcher] Starting — ${watchMode} | poll interval: ${intervalMs / 1000}s | ` +
    `poll deadline: ${deadlineLabel} | stall watchdog: ${stallWatchdogMs / 1000}s`
  );

  watcherHeartbeat = createWatcherHeartbeat({
    rootDir: ROOT,
    filePath: heartbeatPath,
    logger: console,
  });
  watcherHeartbeat.persist('startup');
  const stallWatchdog = createWatcherStallWatchdog({
    heartbeat: watcherHeartbeat,
    stallMs: stallWatchdogMs,
    checkIntervalMs: stallWatchdogCheckMs,
    exitCode: DEFAULT_WATCHER_STALL_EXIT_CODE,
    logger: console,
    onStall: ({ exitCode, stalledForMs, heartbeat }) => {
      exitAfterReviewerCleanup({
        code: exitCode,
        reason: 'watcher stall watchdog',
        source: 'watcher stall watchdog',
        err: new Error(
          `watcher poll counter stalled for ${stalledForMs}ms ` +
          `(poll_counter=${heartbeat.poll_counter}, last_poll_at=${heartbeat.last_poll_at || 'null'})`
        ),
        message:
          'FATAL: watcher made no poll-counter progress while idle; preserving in-flight reviewer runtime sessions so launchd can respawn',
      });
    },
  });
  stallWatchdog.start();

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
  const watcherWakeSource = createWatcherWakeSource({
    rootDir: ROOT,
    logger: console,
  });
  async function runHeartbeatPoll(source) {
    watcherHeartbeat.markPoll({ source });
    stallWatchdog.beginPoll();
    try {
      return await safePollOnce(source);
    } finally {
      stallWatchdog.endPoll();
    }
  }

  (async function pollLoop() {
    let nextStart = Date.now();
    await runHeartbeatPoll('startup pollOnce');
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
      if (resolveWatcherHandoffEnabled()) {
        const wake = await watcherWakeSource.wait(sleepMs);
        const source = wake.woken
          ? `wake pollOnce (${wake.payload?.reason || 'watcher-wake'})`
          : 'scheduled pollOnce';
        await runHeartbeatPoll(source);
        if (wake.woken) {
          nextStart = Date.now();
        }
      } else {
        await new Promise((resolve) => setTimeout(resolve, sleepMs));
        await runHeartbeatPoll('scheduled pollOnce');
      }
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
  resolveDaemonWorkerIdentityForPr,
  resolveDaemonWorkerIdentityFromHeadAttestation,
  readHeadAttestationChainForPr,
  classifyReviewerFailure,
  createWatcherOctokit,
  createWatcherHeartbeat,
  createWatcherStallWatchdog,
  resolveWatcherHandoffEnabled,
  attemptDagAutowalkOnMerge,
  cancelReviewerRuntimeSession,
  clearReviewCycleCapForOverride,
  fireDagAutowalkOnMerge,
  DEFAULT_PENDING_DRAFT_RESPAWN_AGE_SECONDS,
  probeRoutingTierReadiness,
  evaluateRoundBudgetForReview,
  fetchConditionalRestPage,
  fastMergeDecisionFromLabels,
  fetchLivePRHeadSha,
  fetchLivePRLabels,
  computeVocabularyFatigueFindingForPR,
  detectCommitVocabularyFatigue,
  countCompletedReviewerRereviewRounds,
  countDistinctReviewedHeadShas,
  countReviewCeilingUnits,
  reviewCycleExhaustedFromRounds,
  createHeadCloserCommitSuppressionResolver,
  getStalePostedReviewAutoRereviewSuppression,
  getStalePostedReviewBudgetSuppression,
  getHeadCloserCommitSuppression,
  getHeadCloserCommitSuppressionWithBoundedRetry,
  handlePostedReviewRow,
  isExplicitOperatorReviewRetrigger,
  isTerminalCloserCommitIdentity,
  maybeDispatchReviewerTimeoutExhaustedMergeAgent,
  maybeDispatchAmaClosureFor,
  maybeInlineFinalHammerAfterReview,
  runDaemonCleanMergeAttempt,
  writeAutonomousMergeDisabledAudit,
  resolveFirstPassReviewBudgetSuppression,
  refreshReviewerRuntimeAdapter,
  resolveReviewerRuntimeAdapterForDomainId,
  reviewerRuntimeAdapterForRunRecord,
  resolveMergeAgentCoexistenceForWatcher,
  maybeFireFleetWideFalseDeferralAlert,
  maybeFireMergeAgentStuckAlert,
  pollOnce,
  persistReviewerPgid,
  resolveGeminiCredentialConcurrencyForDispatchCandidates,
  readReviewerBrokerSharedSecretBestEffort,
  resolveReviewUnknownFailureMaxRetries,
  readWatcherDrainState,
  reconcilePendingDraftsBeforeSpawn,
  reconcileOrphanedReviewing,
  autoReclaimFailedOrphans,
  failedOrphanAutoReclaimDecision,
  probeReviewerProcessSession,
  recoverFastMergeVetoes,
  runQueuedReviewAdoptionPhase,
  resolvePendingDraftRespawnAgeSeconds,
  resolveVocabularyFatigueConfig,
  resolveReviewerIdentity,
  isAutomaticReviewCycleCapPause,
  postReviewCycleCapEscalation,
  addLabelToPRBestEffort,
  shouldClearReviewCycleCapForOverride,
  reviewBodyHasStandingBlockingFindings,
  recordSuccessfulReviewCycleVerdict,
  resolveFinalToHammerHandoffEnabled,
  resolveStuckDispatchAlertDebounceMs,
  resolveWatcherDrainMaxMs,
  resolveFirstPassReviewerPoolConfig,
  resolveHardReviewCeiling,
  shouldInlineFinalHammerAfterReview,
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
  handlePollError,
  primaryReviewerQuotaCappedForRow,
  reviewPopulationRetryDecision,
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
  warnIfAntigravityReviewerAuthUnavailable,
  writeFastMergeAuditEntry,
  writeReviewerTokenUsageArtifactBestEffort,
};
