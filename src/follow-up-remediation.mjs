import { execFile } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { loadAppSdkConnect } from './app-sdk-loader.mjs';
import { withAppContractTransientRetry } from './app-contract-retry.mjs';
import {
  GEMINI_REMEDIATION_WORKER_TRAILER_CLASS,
  REMEDIATION_WORKER_IDENTITY_DEFAULTS,
  REMEDIATION_WORKER_TRAILER_CLASS,
  WORKER_PROVENANCE_HOOK_SRC,
  installWorkerProvenanceHook,
  remediationWorkerGitIdentity,
  remediationWorkerPushProvider,
  remediationWorkerTrailerClass,
} from './remediation-worker-provenance.mjs';
import {
  claimNextFollowUpJob,
  MAX_QUOTA_HOLD_WINDOW_MS,
  getFollowUpJobDir,
  listInProgressFollowUpJobs,
  markFollowUpJobCompleted,
  markFollowUpJobFailed,
  markFollowUpJobStopped,
  markFollowUpJobSpawned,
  readFollowUpJob,
  readRemediationReplyArtifact,
  requeueInProgressFollowUpJobForRetry,
  remediationAttemptNumber,
  salvagePartialRemediationReply,
  resolveRoundBudgetForJob,
  writeFollowUpJob,
} from './follow-up-jobs.mjs';
import {
  cleanupReconcileClaimArtifacts,
  releaseFollowUpReconcileClaim,
  tryAcquireFollowUpReconcileClaim,
} from './remediation-reconcile-claim.mjs';
import {
  buildBackpressureLogLine,
  buildFollowUpClaimReservations,
  buildDrainSummaryLogLine,
  countPendingFollowUpJobsByRetryWindow,
  createQuotaHoldRevalidator,
  defaultQuotaHoldRevalidator,
  isDrainQueueIdle,
  readWorkerStderrLogSafe,
  resolveMaxTransientRemediationRetries,
} from './remediation-admission.mjs';
import {
  attachFollowUpTelemetryListeners,
  resolveFollowUpTelemetryTopics,
} from './remediation-telemetry.mjs';
import {
  collectWorkspaceDocContext,
} from './prompt-context.mjs';
import {
  WORKER_CLASS_TO_BOT_TOKEN_ENV,
  buildRemediationOutcomeCommentBody,
  postRemediationOutcomeComment,
} from './adapters/comms/github-pr-comments/pr-comments.mjs';
import { buildOwedDelivery, recordInitialCommentDelivery } from './adapters/comms/github-pr-comments/comment-delivery.mjs';
import { deliverAlert } from './alert-delivery.mjs';
import { captureRemediationBodyAfterPost } from './review-body-capture.mjs';
import { resolvePRLifecycle, requestReviewRereview } from './review-state.mjs';
import { requestWatcherWake } from './watcher-wake.mjs';
import { lifecycleStopDecision, resolveJobPRLifecycleSafe } from './follow-up-lifecycle.mjs';
import { buildRemediationPrompt } from './remediation-prompt-builder.mjs';
import {
  applyMergeAgentBrokerEnv,
  assertHarnessIdentityMatch,
  HarnessIdentityMismatchError,
  prepareClaudeCodeRemediationStartupEnv,
  prepareCodexRemediationStartupEnv,
  prepareGeminiRemediationStartupEnv,
  resolveClaudeCodeCliPath,
  resolveCodexAuthPath,
  resolveCodexCliPath,
  resolveCodexRemediationModel,
  resolveGeminiCliPath,
  resolveGeminiRemediationModel,
  spawnClaudeCodeRemediationWorker,
  spawnCodexRemediationWorker,
  spawnGeminiRemediationWorker,
  createLocalRemediationHandle,
} from './adapters/agent-runtime/local/remediation.mjs';
import {
  OAuthError,
  assertClaudeCodeOAuth,
  assertCodexOAuth,
  assertGeminiOAuth,
  assertRemediationWorkerOAuth,
  resetOAuthPreflightCache,
} from './remediation-oauth-preflight.mjs';
import {
  FOLLOW_UP_PROMPT_PATH,
  REMEDIATOR_PROMPT_SET,
  followUpJobRepoPrKey,
  loadFollowUpPromptTemplate,
} from './remediation-prompt.mjs';
import { OAUTH_ENV_STRIP_LIST } from './secret-source/env.mjs';
import { loadDomainConfig } from './domain-config.mjs';
import { resolveRemediatorWorkerClassFromDomain } from './domain-policy.mjs';
import {
  loadRoleConfig,
  resetRoleConfigCache,
  resolveDefaultRemediator,
  validateStartupRoleConfig,
} from './role-config.mjs';
import { validateStartupRoleRegistry } from './role-registry.mjs';
import { validateStartupDeliveryIdentity } from './adapters/comms/github-pr-comments/delivery-identity.mjs';
import { applyPreSpawnLifecycleGate } from './follow-up-stuck-claim-sweep.mjs';
import { detectQuotaExhaustion, parseQuotaResetAt } from './quota-exhaustion.mjs';
import { remediationWorkerClassFallback } from './remediation-worker-class-fallback.mjs';
import {
  DEFAULT_REPLIES_ROOT,
  HQ_REMEDIATION_DISPATCH_TRIGGER,
  digestWorkerFinalMessage,
  prepareHqReplyLandingPad,
  readWorkerFinalMessage,
  resolveHqReplyArtifactPath,
  resolveHqReplyPath,
  resolveHqRoot,
  resolveJobRelativePath,
  resolveLocalRepliesRoot,
  resolveRealPath,
  resolveRemediationReplyTarget,
  resolveReplyStorageKey,
  shouldUseHqIntegration,
  summarizeWorkerFinalMessage,
} from './remediation-reply-paths.mjs';
import {
  OSS_READINESS_APPLY_SCRIPT_ENV,
  OSS_READINESS_AUDIT_CHECK_NAME,
  applyOssReadinessRemediation,
  jobHasOssReadinessAuditFailure,
  resolveOssReadinessApplyScript,
  rollbackOssReadinessLocalCommit,
} from './remediation-oss-readiness.mjs';
import {
  assertWorkflowPushCapabilityForJob,
  extractChangedPathsFromJob,
  hasWorkflowGitHubAppPermission,
  hasWorkflowOAuthScope,
  inspectRemediationPushTokenCapability,
  isWorkflowPath,
  parseGitHubAppPermissions,
  parseOAuthScopesFromGhAuthStatus,
  parseOAuthScopesFromGhApiHeaders,
  remediationTouchesWorkflowFiles,
  resolveRemediationPushTokenIdentity,
  withGhGitCredentialEnv,
} from './remediation-workflow-push-capability.mjs';
import {
  auditWorkspaceForContamination,
  ensureJobBaseBranch,
  ensureJobBranchMetadata,
  fetchPRBranchMetadata,
  inspectWorkspaceState,
  resetWorkspaceDir,
  runWorkspaceGitWithTransientRetry,
  runWorkspaceNetworkCommandWithTransientRetry,
} from './remediation-git-pr-io.mjs';
import {
  cancelHqDispatch,
  classifyHqDispatchFailure,
  normalizeHqWorkspaceDir,
  normalizeWorkerTerminalEvent,
  parseHqJsonObject,
  parseHqWorkerWorkspaceFromPayload,
  resolveHqBin,
  resolveHqWorkerWorkspace,
  workerTerminalEventMatches,
} from './remediation-hq-dispatch.mjs';
import {
  assessWorkerLiveness,
  assessWorkerLivenessDetailed,
  isWorkerProcessRunning,
  killDetachedWorkerProcessGroup,
} from './remediation-worker-liveness.mjs';
import {
  DEFAULT_REMEDIATOR_ENV,
  markRemediationConfigError,
  _isAgentOsRemediationMode,
  resolveAdversarialReviewAppMode,
  buildLegacyHqRemediationDispatchArgs,
  normalizeHqDispatchRepo,
  resolveRemediationDispatchPathForJob,
  resolveRemediationRuntimeMode,
  persistRemediationDispatchPath,
} from './remediation-dispatch-mode.mjs';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const REMEDIATION_LEGACY_UNSTAGE_COMMANDS = [
  'git rm --cached -- .adversarial-follow-up/remediation-reply.json 2>/dev/null || true',
  'git rm --cached -r -- .adversarial-follow-up/ 2>/dev/null || true',
];
const WORKSPACE_ARTIFACT_EXCLUDE_ENTRY = '.adversarial-follow-up/';

function parseBooleanEnvFlag(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === '1' || normalized === 'true') return true;
  if (normalized === '' || normalized === '0' || normalized === 'false') return false;
  return null;
}

function isRemediationToRereviewHandoffEnabled(env = process.env, options = {}) {
  const envValue = env.ADVERSARIAL_HANDOFF_REMEDIATION_TO_REREVIEW
    ?? env.AGENT_OS_HANDOFF_REMEDIATION_TO_REREVIEW;
  const parsedEnv = envValue === undefined ? null : parseBooleanEnvFlag(envValue);
  if (parsedEnv !== null) return parsedEnv;
  try {
    return loadRoleConfig({
      env,
      topPath: options.topPath,
      modulePaths: options.modulePaths,
      loaderImpl: options.loaderImpl,
      contextKey: 'handoff.remediation_to_rereview',
    }).get('handoff.remediation_to_rereview', false) === true;
  } catch {
    return false;
  }
}

// Kill-switch for the fail-closed harness-identity assert at the remediation
// spawn boundary. DEFAULT true: a remediation worker's git identity + push
// provider must match its physical harness, and a mismatch fails closed. Set the
// env override or roles.adversarial.remediation.enforce_harness_identity=false to
// downgrade to warn+audit+continue (the assert still records the mismatch, it
// just does not block the spawn). Empty/unset falls through to the config default.
function isHarnessIdentityEnforcementEnabled(env = process.env, options = {}) {
  const envValue = env.ADVERSARIAL_REMEDIATION_ENFORCE_HARNESS_IDENTITY;
  const parsedEnv = envValue === undefined || envValue === '' ? null : parseBooleanEnvFlag(envValue);
  if (parsedEnv !== null) return parsedEnv;
  try {
    return loadRoleConfig({
      env,
      topPath: options.topPath,
      modulePaths: options.modulePaths,
      loaderImpl: options.loaderImpl,
      contextKey: 'roles.adversarial.remediation.enforce_harness_identity',
    }).get('roles.adversarial.remediation.enforce_harness_identity', true) === true;
  } catch {
    // Fail SAFE toward enforcement: if config can't be read, keep the assert on
    // so a misconfigured host still rejects a mismatched harness identity.
    return true;
  }
}
const DEFAULT_PATH_PREFIX = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
const VALID_GITHUB_REPO_SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const HQ_SUCCESS_STATUSES = new Set(['succeeded']);

// The remediation-worker class the consume path spawns by default when
// nothing else applies. With cross-model symmetry restored (see
// `pickRemediationWorkerClass` below), this constant is the fallback for
// jobs missing a usable `builderTag`. The operator env override below can
// still pin the worker class globally without changing durable job records
// or PR-title routing.
const DEFAULT_REMEDIATION_WORKER_CLASS = 'codex';

// Cross-model (adversarial) remediator routing. The remediator runs as
// the OPPOSITE model from the writer, so a second model both reviews AND
// fixes — the writer's blind spots don't get reinforced by a same-model
// fix that pattern-matches on the same wrong intuitions:
//
//   [codex]       → claude-code remediates (writer is codex)
//   [claude-code] → codex remediates       (writer is claude)
//   [clio-agent]  → claude-code remediates (Clio dispatches codex writers)
//
// Pairs with cross-model REVIEW (adapters/subject/github-pr/routing.mjs):
// reviewer and remediator are both adversarial-by-default.
//
// Operators pin globally via `ADVERSARIAL_REVIEW_DEFAULT_REMEDIATOR=codex`
// or `=claude-code` — the env override wins over per-tag routing for
// budget-squeeze or model-availability scenarios.
const REMEDIATION_WORKER_BY_BUILDER_TAG = Object.freeze({
  codex: 'claude-code',
  'claude-code': 'codex',
  'clio-agent': 'claude-code',
});
const REMEDIATION_MAX_CONCURRENT_JOBS_ENV = 'ADVERSARIAL_REMEDIATION_MAX_CONCURRENT_JOBS';
const REMEDIATION_WORKSPACE_ROOT_ENV = 'ADVERSARIAL_REMEDIATION_WORKSPACE_ROOT';
const DEFAULT_REMEDIATION_MAX_CONCURRENT_JOBS = 1;
const MAX_REMEDIATION_MAX_CONCURRENT_JOBS = 8;
const DEFAULT_DEPLOY_CHECKOUT = '/Users/airlock/agent-os';  // cfg-allowlist(account-airlock): oss-readiness-apply-reviewed
const HQ_REMEDIATION_WORKSPACE_SEGMENTS = ['adversarial-review', 'follow-up-workspaces'];

function logRoundBudgetDecision(log, {
  riskClass,
  runsCompleted,
  cap,
  decision,
  repo = null,
  prNumber = null,
}) {
  const payload = {
    event: 'remediation-round-budget',
    repo,
    prNumber,
    riskClass,
    runsCompleted,
    cap,
    decision,
  };
  log?.log?.(`[follow-up] ${JSON.stringify(payload)}`);
}

class StartupContractError extends Error {
  constructor(reason, { violationType, requestedValue = null, resolvedValue = null, startupEvidence = null } = {}) {
    super(reason);
    this.name = 'StartupContractError';
    this.isPolicyViolation = true;
    this.violationType = violationType || 'conflicting-env-contract-breach';
    this.requestedValue = requestedValue;
    this.resolvedValue = resolvedValue;
    this.startupEvidence = startupEvidence;
  }
}

function currentUsername(env = process.env) {
  return env.USER || env.LOGNAME || userInfo().username;
}

function requireHqDispatchEnvValue(env, key, message) {
  const value = String(env?.[key] || '').trim();
  if (!value) {
    throw new Error(message);
  }
  return value;
}

function readHqConfigOwnerUser(hqRoot) {
  const configPath = join(hqRoot, '.hq', 'config.json');
  const parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  const ownerUser = String(parsed?.ownerUser || parsed?.owner_user || '').trim();
  if (!ownerUser) {
    throw new Error(`HQ config at ${configPath} is missing ownerUser`);
  }
  return ownerUser;
}

function assertHqDispatchOwnerMatches(env = process.env) {
  const hqRoot = resolveHqRoot(env, { requireExists: true });
  const ownerUser = readHqConfigOwnerUser(hqRoot);
  const actualUser = currentUsername(env);
  if (ownerUser !== actualUser) {
    throw new Error(
      `HQ owner mismatch: follow-up remediation is running as '${actualUser}' but HQ ownerUser is '${ownerUser}'.`
    );
  }
  return ownerUser;
}

// Fallback hold window for a quota-exhausted remediation worker when the
// provider did not hand back a parseable reset time. Mirrors the reviewer
// path's QUOTA_EXHAUSTED_BACKOFF_MS (15 min) so both worker classes degrade
// the same way under a hard usage cap.
const QUOTA_REMEDIATION_BACKOFF_MS = 15 * 60 * 1000;

// ── Worker-class dispatcher ────────────────────────────────────────────────

function normalizeRemediationWorkerClass(workerClassInput) {
  const workerClass = String(workerClassInput || '').trim().toLowerCase();
  if (!workerClass) return null;
  switch (workerClass) {
    case 'codex':
    case 'codex-remediation':
      return 'codex';
    case 'claude':
    case 'claude-code':
    case 'claude-code-remediation':
      return 'claude-code';
    case 'gemini':
    case 'gemini-remediation':
      return 'gemini';
    default:
      return null;
  }
}

// Cascade-aware default remediator resolver. Consults config.yaml FIRST
// (module → top-level → *.local) and env LAST per SPEC §3 resolution
// order. Returns null when no pin is in effect (the per-builder-tag
// cross-model routing in `pickRemediationWorkerClass` then applies).
//
// `defaultRemediatorWorkerClassFromEnv` is kept as a back-compat alias so
// external callers/tests that import the old name keep working; the body
// delegates to the file-cascade resolver. The `_workerClass` flag on the
// error is preserved for the existing
// `consumeNextFollowUpJob` requeue path.
// CFG-02 round-1 review B6 fix (2026-05-30): do not blindly copy
// `err.got` to `requestedValue`. For env-alias conflicts the loader
// puts a multi-value diagnostic string (e.g.
// `'AGENT_OS_X="a", LEGACY_Y="b"'`) into `err.got` — templating that
// into operator-visible messages produces nonsense. Default to null
// and let downstream code use the loader's structured `err.got`
// directly if it wants the raw diagnostic.
//
// CFG-02 round-1 review B1 (mislabel) is deferred to a follow-up
// CFG ticket: gating on `err.key === 'roles.remediator'` /
// `err.envName ∈ ALIASES` breaks back-compat with downstream
// consumeNextFollowUpJob requeue tests. The gate needs paired
// loader changes (consistent err.key/envName population across all
// throw sites) to be safe; track separately.
function defaultRemediatorWorkerClassFromEnv(env = process.env, opts = {}) {
  try {
    return resolveDefaultRemediator({ env, ...opts });
  } catch (err) {
    throw markRemediationConfigError(err, {
      configKey: DEFAULT_REMEDIATOR_ENV,
      requestedValue: null,
    });
  }
}

function validateStartupRemediationConfig(env = process.env, opts = {}) {
  // Single fail-loud entry point: the loader walks the entire schema, so
  // schema errors in any section (not just the role keys) fail loud at
  // boot, including the promoted remediation concurrency knobs.
  validateStartupRoleConfig({ env, ...opts });
  // ARC-12: fail loud at boot on a malformed role registry or a workerClass
  // outside the hq-published roster (no-op while roles.registry is empty).
  validateStartupRoleRegistry({
    env,
    ...opts,
    workerClassOptions: { ...opts.workerClassOptions, readOnly: true },
  });
  // ARC-12 (review #631): comms delivery identity binding for every role.
  validateStartupDeliveryIdentity({
    env,
    ...opts,
    workerClassOptions: { ...opts.workerClassOptions, readOnly: true },
  });
  defaultRemediatorWorkerClassFromEnv(env, opts);
  resolveRemediationMaxConcurrentJobs(env);
  if (_isAgentOsRemediationMode(env)) {
    resolveHqRoot(env, { requireExists: true });
    requireHqDispatchEnvValue(
      env,
      'HQ_PARENT_SESSION',
      `HQ_PARENT_SESSION must be set when ${HQ_REMEDIATION_DISPATCH_TRIGGER}`
    );
    requireHqDispatchEnvValue(
      env,
      'HQ_PROJECT',
      `HQ_PROJECT must be set when ${HQ_REMEDIATION_DISPATCH_TRIGGER}`
    );
    assertHqDispatchOwnerMatches(env);
  }
}

// Per-PR remediator routing: pair the writer model with the OPPOSITE model
// so a second model both reviews AND fixes (adversarial-by-default). See
// `REMEDIATION_WORKER_BY_BUILDER_TAG` above for the mapping. The reviewer
// also stays cross-model (see `adapters/subject/github-pr/routing.mjs`).
//
// Operators can override the per-PR derivation via
// `ADVERSARIAL_REVIEW_DEFAULT_REMEDIATOR` when cost or availability requires
// pinning remediation to a specific worker class — e.g. during a codex
// weekly-budget squeeze, set `=claude-code` to force all remediation through
// claude regardless of the original PR's builderTag.
//
// Historical note: LAC-358 previously hard-routed all remediation to codex
// regardless of builderTag. PR #172 (2026-05-29 AM) attempted to restore
// per-tag derivation but landed at same-model (writer remediates itself).
// This PR (#175, 2026-05-29 PM) flipped it back to cross-model
// (adversarial-by-default) — the writer's blind spots don't get reinforced
// by a same-model fix that pattern-matches on the same wrong intuitions.
// The env override provides the same operator escape hatch in either
// direction.
//
// Fallback semantics: when `builderTag` is missing or unknown, derivation falls
// through to `DEFAULT_REMEDIATION_WORKER_CLASS = 'codex'`. This preserves
// "something runs"; operators can pin via `ADVERSARIAL_REVIEW_DEFAULT_REMEDIATOR`.
// ARC-08: the role-registry default remediator worker class (SPEC §5,
// `roles.registry.remediator.workerClass`). ARC-12 lands the registry and its
// config schema; until then the strict `roles` schema omits `roles.registry`,
// so `.get` returns the documented fallback and no operator config trips schema
// validation. This is the DEFAULT — domain routing (builder-tag) overrides it,
// and an operator env pin overrides everything.
function resolveRoleRegistryRemediator({ env = process.env, topPath, loaderImpl, domainId = 'code-pr' } = {}) {
  try {
    const cfg = loadRoleConfig({ env, topPath, loaderImpl, contextKey: 'roles.remediator' });
    const value = normalizeRemediationWorkerClass(
      cfg.get('roles.registry.remediator.workerClass', ''),
    );
    if (value) return value;
  } catch {
    // Registry key/schema not present yet (pre-ARC-12): fall through to the
    // documented default rather than failing the dispatch.
  }
  const domainValue = normalizeRemediationWorkerClass(
    resolveRemediatorWorkerClassFromDomain(loadDomainConfig(ROOT, domainId || 'code-pr')),
  );
  if (domainValue) return domainValue;
  return DEFAULT_REMEDIATION_WORKER_CLASS;
}

// Remediator worker-class selection (ARC-08): role-registry default with the
// domain able to override. Precedence, highest first:
//   1. operator env pin (`ADVERSARIAL_REVIEW_DEFAULT_REMEDIATOR` / role-config)
//   2. domain override — per-builder-tag cross-model routing
//   3. role-registry default (`roles.registry.remediator.workerClass`)
//   4. documented fallback `DEFAULT_REMEDIATION_WORKER_CLASS` (codex)
// A missing/unknown builderTag falls through to the registry default, matching
// the pre-ARC-08 degraded same-model-to-codex behavior (operator can pin).
function pickRemediationWorkerClass(job, { env = process.env, topPath, loaderImpl } = {}) {
  const envOverride = defaultRemediatorWorkerClassFromEnv(env, { topPath, loaderImpl });
  if (envOverride) return envOverride;
  const builderTag = String(job?.builderTag || '').trim().toLowerCase();
  if (builderTag && Object.prototype.hasOwnProperty.call(REMEDIATION_WORKER_BY_BUILDER_TAG, builderTag)) {
    return REMEDIATION_WORKER_BY_BUILDER_TAG[builderTag];
  }
  return resolveRoleRegistryRemediator({ env, topPath, loaderImpl, domainId: job?.domainId || 'code-pr' });
}

function requeueClaimedFollowUpJobAfterConfigFailure({
  rootDir,
  jobPath,
  error,
  requeuedAt = new Date().toISOString(),
}) {
  const currentJob = JSON.parse(readFileSync(jobPath, 'utf8'));
  const currentPlan = currentJob.remediationPlan || {};
  const currentRound = Number(currentPlan.currentRound || 0);
  const rounds = Array.isArray(currentPlan.rounds) ? [...currentPlan.rounds] : [];
  const lastRound = rounds.at(-1);
  let nextCurrentRound = currentRound;

  if (
    lastRound
    && Number(lastRound.round) === currentRound
    && lastRound.state === 'claimed'
  ) {
    rounds.pop();
    nextCurrentRound = Math.max(0, currentRound - 1);
  }

  const nextJob = {
    ...currentJob,
    status: 'pending',
    pendingAt: requeuedAt,
    claimedAt: null,
    claimedBy: null,
    remediationWorker: null,
    failure: null,
    lastConfigValidationFailure: {
      code: 'config-validation-failure',
      key: error.configKey || DEFAULT_REMEDIATOR_ENV,
      message: error.message,
      recoverable: true,
      recordedAt: requeuedAt,
    },
    remediationPlan: {
      ...currentPlan,
      currentRound: nextCurrentRound,
      rounds,
      nextAction: null,
    },
  };
  writeFollowUpJob(jobPath, nextJob);
  const pendingPath = join(getFollowUpJobDir(rootDir, 'pending'), basename(jobPath));
  renameSync(jobPath, pendingPath);
  return { job: nextJob, jobPath: pendingPath };
}

// ARC-08: the remediation AgentRuntime facade. Collapses the former
// self-spawn-vs-hq fork into one port-shaped `run(request)` whose mode the
// health router selects (see `resolveRemediationRuntimeMode`). This is a
// DISPATCH-only port surface: `run()` performs the spawn/dispatch and returns a
// handle carrying the worker descriptor the rest of the pipeline persists via
// `markFollowUpJobSpawned`. Terminal observation (polling the local process
// group or the hq `dispatch_status`) stays with `reconcileFollowUpJob`, the
// subject-adapter reconcile pass — so `await`/`reattach` here fail loud rather
// than pretend to observe completion. `local` mode owns the model-specific CLI
// spawns (the former `spawnRemediationWorker` switch); `os` mode owns the
// app-contract / hq dispatch.
function createRemediationRuntime({
  // Bind the default in the factory scope: both the OS dispatch branch and the
  // local handle below receive this concrete value without caller injection.
  execFileImpl = execFileAsync,
  spawnImpl,
  env = process.env,
  now = () => new Date().toISOString(),
  processKillImpl = process.kill,
  waitForExitImpl,
  sleepImpl,
  pollMs,
} = {}) {
  async function run(request = {}) {
    const mode = request.mode;
    const workerClass = request.role?.workerClass;
    if (mode === 'os') {
      const worker = await dispatchRemediationViaHq({
        hqRoot: resolveHqRoot(env, { requireExists: true }),
        workerClass,
        repo: request.repo,
        prNumber: request.prNumber,
        branch: request.branch || null,
        promptPath: request.promptPath,
        replyPath: request.replyPath,
        launchRequestId: request.launchRequestId,
        jobId: request.jobId,
        requiresWorkflowPush: Boolean(request.requiresWorkflowPush),
        execFileImpl,
        env,
        now,
      });
      const runRef = String(
        request.idempotencyKey || worker.launchRequestId || worker.processId || '',
      );
      const terminalOwnedByReconcile = () => {
        throw new Error(
          'remediation AgentRuntime is dispatch-only; reconcileFollowUpJob owns terminal observation',
        );
      };
      return {
        runRef,
        mode,
        worker,
        await: terminalOwnedByReconcile,
        reattach: terminalOwnedByReconcile,
        async cancel() {},
      };
    }
    if (mode === 'local') {
      const worker = (workerClass === 'codex'
        ? spawnCodexRemediationWorker
        : workerClass === 'claude-code'
          ? spawnClaudeCodeRemediationWorker
          : workerClass === 'gemini'
            ? spawnGeminiRemediationWorker
            : null);
      if (!worker) {
        throw new Error(`unknown remediation worker class: ${workerClass}`);
      }
      // Enforce (or, under the kill-switch, just audit) that the worker about to
      // be spawned commits + pushes under its PHYSICAL harness identity. On a
      // mismatch while enforcing, the spawn fn throws and this run() call fails
      // closed — the loud, correct outcome vs. a codex/claude/gemini remediation
      // authenticating as some other identity (the #5058 class of defect).
      const enforceHarnessIdentity = isHarnessIdentityEnforcementEnabled(env);
      const harnessIdentityAuditSink = (record) => {
        try {
          const alert = deliverAlert(
            `[follow-up-remediation] harness identity ${record?.enforced ? 'FAIL-CLOSED' : 'WARNING'}: ${record?.message || 'mismatch'}`,
            {
              event: 'remediation-harness-identity-mismatch',
              payload: {
                workerClass: record?.workerClass || null,
                enforced: Boolean(record?.enforced),
                mismatches: record?.mismatches || [],
                checkedAt: record?.checkedAt || null,
              },
            }
          );
          if (alert && typeof alert.catch === 'function') alert.catch(() => {});
        } catch {
          // Audit delivery must never mask the enforcement decision.
        }
      };
      const spawnedWorker = worker({
        workspaceDir: request.workspaceDir,
        promptPath: request.promptPath,
        outputPath: request.outputPath,
        logPath: request.logPath,
        replyPath: request.replyPath,
        hqRoot: request.hqRoot,
        launchRequestId: request.launchRequestId,
        jobId: request.jobId,
        requiresWorkflowPush: Boolean(request.requiresWorkflowPush),
        enforceHarnessIdentity,
        auditSink: harnessIdentityAuditSink,
        spawnImpl,
        sourceEnv: env,
        now,
      });
      return createLocalRemediationHandle({
        runRef: String(
          request.idempotencyKey || spawnedWorker.launchRequestId || spawnedWorker.processId || '',
        ),
        worker: spawnedWorker,
        processKillImpl,
        execFileImpl,
        waitForExitImpl,
        sleepImpl,
        pollMs,
      });
    }
    throw new Error(`unknown remediation runtime mode: ${JSON.stringify(mode)}`);
  }

  return { run };
}

function resolveAdversarialReviewAppSubscribes(env = process.env, options = {}) {
  const cfg = loadRoleConfig({
    env,
    topPath: options.topPath,
    modulePaths: options.modulePaths,
    loaderImpl: options.loaderImpl,
    contextKey: 'apps.adversarial-review.subscribes',
  });
  const subscribes = cfg.get('apps.adversarial-review.subscribes', []);
  return Array.isArray(subscribes)
    ? subscribes.map((topic) => String(topic).trim()).filter(Boolean)
    : [];
}

async function dispatchRemediationViaHq({
  hqRoot,
  workerClass,
  repo,
  prNumber,
  branch = null,
  promptPath,
  replyPath,
  launchRequestId,
  jobId,
  requiresWorkflowPush = false,
  execFileImpl = execFileAsync,
  env = process.env,
  now = () => new Date().toISOString(),
} = {}) {
  const parentSession = requireHqDispatchEnvValue(
    env,
    'HQ_PARENT_SESSION',
    'HQ_PARENT_SESSION must be set when HQ remediation dispatch is enabled'
  );
  const project = requireHqDispatchEnvValue(
    env,
    'HQ_PROJECT',
    'HQ_PROJECT must be set when HQ remediation dispatch is enabled'
  );
  const ticketRef = String(jobId || launchRequestId || `PR-${prNumber}`).trim();
  const requestId = String(jobId || launchRequestId || ticketRef).trim();
  const appMode = resolveAdversarialReviewAppMode(env);
  const hqBin = resolveHqBin(env);
  const dispatchEnv = { ...env };
  const workflowPushBrokerEvidence = requiresWorkflowPush
    ? applyMergeAgentBrokerEnv(dispatchEnv, env, { workerClass, requiresWorkflowPush })
    : null;
  const legacyHqArgs = buildLegacyHqRemediationDispatchArgs({
    ticketRef,
    workerClass,
    repo,
    prNumber,
    branch,
    promptPath,
    parentSession,
    project,
    hqRoot,
  });
  const ticket = appMode === 'agent-os'
    ? await (async () => {
        const connect = await loadAppSdkConnect();
        const os = await withAppContractTransientRetry(() => connect({
          app_id: 'adversarial-review',
          mode: appMode,
          hqRoot,
          subscribes: resolveAdversarialReviewAppSubscribes(env),
        }));
        return withAppContractTransientRetry(() => os.dispatch({
          request_id: requestId,
          ticket_ref: ticketRef,
          prompt: promptPath,
          worker_class: workerClass,
          task_kind: 'coding',
          completion_shape: 'branch-push',
          ...(workflowPushBrokerEvidence?.enabled
            ? {
                credential_requirements: {
                  branch_push: {
                    provider: 'github-app-merge-agent',
                    reason: 'workflow-file-remediation',
                    permissions: { contents: 'write', workflows: 'write' },
                    broker_env: {
                      MERGE_AGENT_AUTH_VIA_BROKER: dispatchEnv.MERGE_AGENT_AUTH_VIA_BROKER || null,
                      OAUTH_BROKER_URL: dispatchEnv.OAUTH_BROKER_URL || null,
                      OAUTH_BROKER_STANDBY_URL: dispatchEnv.OAUTH_BROKER_STANDBY_URL || null,
                      OAUTH_BROKER_SHARED_SECRET_FILE: dispatchEnv.OAUTH_BROKER_SHARED_SECRET_FILE || null,
                      OAUTH_BROKER_MERGE_AGENT_PROVIDER: dispatchEnv.OAUTH_BROKER_MERGE_AGENT_PROVIDER || null,
                      OAUTH_BROKER_MERGE_AGENT_EXPECTED_APP_ID: dispatchEnv.OAUTH_BROKER_MERGE_AGENT_EXPECTED_APP_ID || null,
                      OAUTH_BROKER_MERGE_AGENT_EXPECTED_INSTALLATION_ID: dispatchEnv.OAUTH_BROKER_MERGE_AGENT_EXPECTED_INSTALLATION_ID || null,
                    },
                  },
                },
              }
            : {}),
          repo: normalizeHqDispatchRepo(repo),
          pr_number: prNumber,
          ...(requiresWorkflowPush ? {
            push_provider: 'github-app-merge-agent',
            requires_workflow_push: true,
          } : {}),
          // Omit `branch` when falsy so the agent-os wire payload matches the
          // native lane, which only appends `--branch` when truthy. `stripUndefined`
          // in the SDK client drops `undefined` but not `null`, so passing a falsy
          // branch through would serialize `branch: null` and diverge the two lanes.
          ...(branch ? { branch } : {}),
          hq_root: hqRoot,
          parent_session: parentSession,
          project,
        }));
      })()
    : parseHqJsonObject(
        (await execFileImpl(hqBin, legacyHqArgs, { env: dispatchEnv, maxBuffer: 5 * 1024 * 1024 })).stdout,
        'hq dispatch'
      );
  const launchRequestIdValue = String(ticket?.launch_request_id || ticket?.launchRequestId || ticket?.lrq || '').trim();
  const dispatchId = String(ticket?.dispatch_id || ticket?.dispatchId || '').trim();
  if (!launchRequestIdValue) {
    throw new Error('app-sdk dispatch ticket missing launch_request_id');
  }
  if (!dispatchId) {
    throw new Error('app-sdk dispatch ticket missing dispatch_id');
  }
  const ticketWorkspaceDir = normalizeHqWorkspaceDir(ticket?.workspace_dir || ticket?.workspaceDir);
  // In agent-os mode the workspace is intentionally left unresolved at dispatch
  // (the App Contract ticket carries no workspace_dir) and is re-resolved later
  // at reconcile via `hq dispatch status <dispatchId>`. This non-obvious
  // dependency is load-bearing for branch-contamination audits.
  const workspaceDir = appMode === 'agent-os'
    ? ticketWorkspaceDir
    : await resolveHqWorkerWorkspace({
        worker: {
          dispatchId,
          hqRoot,
        },
        execFileImpl,
        env,
      });
  return {
    model: workerClass,
    workerClass,
    state: 'spawned',
    spawnedAt: now(),
    promptPath,
    outputPath: null,
    logPath: null,
    replyPath,
    dispatchMode: 'hq',
    completionShape: 'branch-push',
    requiresWorkflowPush: Boolean(requiresWorkflowPush),
    workflowPushBroker: workflowPushBrokerEvidence,
    launchRequestId: launchRequestIdValue,
    dispatchId,
    requestId,
    workspaceDir,
    hqRoot,
    hqParentSession: parentSession,
    hqProject: project,
    ticketRef,
    watchUrl: typeof ticket?.watch_url === 'string' ? ticket.watch_url : ticket?.watchUrl,
    auditRef: typeof ticket?.audit_ref === 'string' ? ticket.audit_ref : ticket?.auditRef,
    ...(appMode === 'agent-os' ? {} : { command: [hqBin, ...legacyHqArgs] }),
  };
}

function _resolveRemediationCfgCeiling(env = process.env, options = {}) {
  // CFG-01 anchor: `remediation.max_concurrent_jobs_ceiling` promoted
  // 2026-06-09. Default 8 — unchanged from MAX_REMEDIATION_MAX_CONCURRENT_JOBS.
  const cfgValue = loadRoleConfig({
    env,
    topPath: options.topPath,
    modulePaths: options.modulePaths,
    loaderImpl: options.loaderImpl,
    contextKey: 'remediation.max_concurrent_jobs_ceiling',
  }).get(
    'remediation.max_concurrent_jobs_ceiling',
    MAX_REMEDIATION_MAX_CONCURRENT_JOBS
  );
  const parsed = Number(cfgValue);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return MAX_REMEDIATION_MAX_CONCURRENT_JOBS;
  }
  return parsed;
}

function normalizeMaxConcurrentFollowUpJobs(value, {
  fallback = DEFAULT_REMEDIATION_MAX_CONCURRENT_JOBS,
  max = null,
  env = process.env,
  onClamp = null,
  topPath,
  modulePaths,
  loaderImpl,
} = {}) {
  // `max` resolved at call time so the CFG ceiling is consulted lazily and
  // tests can override via options.max without standing up a config loader.
  const effectiveMax = max ?? _resolveRemediationCfgCeiling(env, { topPath, modulePaths, loaderImpl });
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  if (parsed > effectiveMax) {
    onClamp?.({
      requested: parsed,
      clamped: effectiveMax,
    });
    return effectiveMax;
  }
  return parsed;
}

function resolveRemediationMaxConcurrentJobs(env = process.env, options = {}) {
  // CFG-01 anchor for the floor: `remediation.max_concurrent_jobs`.
  // Legacy env names are resolved by ENV_ALIASES in the loader so
  // canonical-vs-legacy conflicts fail loud before runtime clamping.
  const cfgValue = loadRoleConfig({
    env,
    topPath: options.topPath,
    modulePaths: options.modulePaths,
    loaderImpl: options.loaderImpl,
    contextKey: 'remediation.max_concurrent_jobs',
  }).get('remediation.max_concurrent_jobs', null);
  return normalizeMaxConcurrentFollowUpJobs(
    cfgValue,
    { ...options, env: options.env ?? env }
  );
}

function buildInheritedPath(currentPath = process.env.PATH || '') {
  const segments = [...DEFAULT_PATH_PREFIX, ...String(currentPath).split(':').filter(Boolean)];
  return [...new Set(segments)].join(':');
}

function assertValidRepoSlug(repo) {
  const value = String(repo ?? '').trim();
  if (!VALID_GITHUB_REPO_SLUG.test(value)) {
    throw new Error(`Invalid GitHub repo slug: ${repo}`);
  }
  if (value.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new Error(`Invalid GitHub repo slug: ${repo}`);
  }
  return value;
}

function isPathInsideOrEqual(rootPath, candidatePath) {
  if (!rootPath || !candidatePath) return false;
  const root = resolveRealPath(resolve(rootPath));
  const candidate = resolveRealPath(resolve(candidatePath));
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function resolveDeployCheckout(env = process.env) {
  return resolve(env.AGENT_OS_DEPLOY_CHECKOUT || DEFAULT_DEPLOY_CHECKOUT);
}

function resolveRemediationWorkspaceRoot({
  rootDir = ROOT,
  env = process.env,
} = {}) {
  const configuredRoot = String(env[REMEDIATION_WORKSPACE_ROOT_ENV] || '').trim();
  const hqRoot = String(env.HQ_ROOT || '').trim();
  const workspaceRoot = configuredRoot
    ? resolve(configuredRoot)
    : hqRoot
      ? resolve(hqRoot, ...HQ_REMEDIATION_WORKSPACE_SEGMENTS)
      : getFollowUpJobDir(rootDir, 'workspaces');

  const deployCheckout = resolveDeployCheckout(env);
  const sourceRoot = resolve(rootDir);
  const externalRootConfigured = Boolean(configuredRoot || hqRoot);
  if (!externalRootConfigured && isPathInsideOrEqual(deployCheckout, sourceRoot)) {
    throw new Error(
      `${REMEDIATION_WORKSPACE_ROOT_ENV} or HQ_ROOT must be set before spawning remediation workers ` +
      `from the deploy checkout (${deployCheckout}); refusing to create mutable worker clones under live source`
    );
  }

  if (externalRootConfigured && isPathInsideOrEqual(deployCheckout, workspaceRoot)) {
    throw new Error(
      `Invalid remediation workspace root: ${workspaceRoot} is inside deploy checkout ${deployCheckout}`
    );
  }

  return workspaceRoot;
}

function hasPathSuffixSegments(candidatePath, segments) {
  const parts = resolve(candidatePath).split('/').filter(Boolean);
  if (parts.length < segments.length) {
    return false;
  }
  return segments.every((segment, index) => parts[parts.length - segments.length + index] === segment);
}

function remediationWorkspaceRootCandidates(rootDir, env = process.env) {
  const candidates = new Set([
    resolve(getFollowUpJobDir(rootDir, 'workspaces')),
  ]);

  const configuredRoot = String(env[REMEDIATION_WORKSPACE_ROOT_ENV] || '').trim();
  if (configuredRoot) {
    candidates.add(resolve(configuredRoot));
  }

  const hqRoot = String(env.HQ_ROOT || '').trim();
  if (hqRoot) {
    candidates.add(resolve(hqRoot, ...HQ_REMEDIATION_WORKSPACE_SEGMENTS));
  }

  return [...candidates];
}

function isLegitimateStoredWorkspaceRoot(rootDir, absolutePath, env = process.env) {
  const allowedRoots = remediationWorkspaceRootCandidates(rootDir, env);
  if (allowedRoots.some((candidate) => isPathInsideOrEqual(candidate, absolutePath))) {
    return true;
  }
  return hasPathSuffixSegments(absolutePath, HQ_REMEDIATION_WORKSPACE_SEGMENTS);
}

function runtimeUsername(env = process.env) {
  const envUser = String(env.LOGNAME || env.USER || '').trim();
  if (envUser) return envUser;
  try {
    return userInfo().username;
  } catch {
    return 'unknown';
  }
}

function ensureWorkspaceRootDir(workspaceRootDir, env = process.env) {
  try {
    mkdirSync(workspaceRootDir, { recursive: true });
  } catch (err) {
    if (err?.code === 'EACCES' || err?.code === 'EPERM') {
      const hqRoot = String(env.HQ_ROOT || '').trim() || '(unset)';
      const runtimeUser = runtimeUsername(env);
      throw new Error(
        `Could not create remediation workspace root ${workspaceRootDir}: ` +
        `${err.code} while running as ${runtimeUser} with HQ_ROOT=${hqRoot}. ` +
        `Provision the HQ remediation directories with a writable ownership/mode for the runtime user before retrying.`
      );
    }
    throw err;
  }
}

function serializeWorkerPath(rootDir, absolutePath) {
  const resolvedPath = resolve(absolutePath);
  const rel = relative(rootDir, resolvedPath);
  if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
    return rel;
  }
  return resolvedPath;
}

async function resolveOssReadinessRemediationPushTarget({
  workspaceDir,
  branch,
  execFileImpl = execFileAsync,
} = {}) {
  const fallbackBranch = String(branch || '').trim();
  const { stdout: localBranchOut } = await execFileImpl(
    'git',
    ['-C', workspaceDir, 'symbolic-ref', '--quiet', '--short', 'HEAD'],
    { maxBuffer: 1 * 1024 * 1024 }
  );
  const localBranch = String(localBranchOut || '').trim();
  if (!localBranch) {
    throw new Error('Cannot push oss-readiness remediation from a detached HEAD');
  }

  const { stdout: remoteOut } = await execFileImpl(
    'git',
    ['-C', workspaceDir, 'config', '--get', `branch.${localBranch}.remote`],
    { maxBuffer: 1 * 1024 * 1024 }
  );
  const remote = String(remoteOut || '').trim();
  if (!remote) {
    throw new Error(`Cannot resolve tracking remote for ${localBranch}; refusing to push oss-readiness remediation`);
  }

  let mergeRef = '';
  try {
    const { stdout } = await execFileImpl(
      'git',
      ['-C', workspaceDir, 'config', '--get', `branch.${localBranch}.merge`],
      { maxBuffer: 1 * 1024 * 1024 }
    );
    mergeRef = String(stdout || '').trim();
  } catch {
    mergeRef = '';
  }

  const remoteBranch = mergeRef.startsWith('refs/heads/')
    ? mergeRef.slice('refs/heads/'.length)
    : fallbackBranch;
  if (!remoteBranch) {
    throw new Error(`Cannot resolve tracking branch for ${localBranch}; refusing to push oss-readiness remediation`);
  }
  return {
    remote,
    refspec: `HEAD:refs/heads/${remoteBranch}`,
  };
}

async function pushOssReadinessRemediationCommit({
  workspaceDir,
  branch,
  env = process.env,
  execFileImpl = execFileAsync,
} = {}) {
  const targetBranch = String(branch || '').trim();
  if (!targetBranch) {
    throw new Error('PR head branch is required to push oss-readiness remediation before HQ dispatch');
  }
  const pushTarget = await resolveOssReadinessRemediationPushTarget({
    workspaceDir,
    branch: targetBranch,
    execFileImpl,
  });
  await runWorkspaceGitWithTransientRetry(
    ['-C', workspaceDir, 'push', pushTarget.remote, pushTarget.refspec],
    {
      execFileImpl,
      options: {
        maxBuffer: 10 * 1024 * 1024,
        env: withGhGitCredentialEnv(env),
      },
    }
  );
  return {
    ok: true,
    remote: pushTarget.remote,
    refspec: pushTarget.refspec,
  };
}

async function prepareWorkspaceForJob({
  rootDir = ROOT,
  job,
  workerClass = DEFAULT_REMEDIATION_WORKER_CLASS,
  env = process.env,
  execFileImpl = execFileAsync,
}) {
  const repo = assertValidRepoSlug(job.repo);
  const workspaceRootDir = resolveRemediationWorkspaceRoot({ rootDir, env });
  const workspaceDir = join(workspaceRootDir, job.jobId);
  ensureWorkspaceRootDir(workspaceRootDir, env);
  const workspaceState = await inspectWorkspaceState({
    workspaceDir,
    expectedRepo: repo,
    execFileImpl,
  });

  if (workspaceState.reset) {
    resetWorkspaceDir(workspaceDir);
  }

  if (!existsSync(join(workspaceDir, '.git'))) {
    // Clone with plain `git` over HTTPS rather than `gh repo clone`. `gh repo
    // clone` resolves the repo through GraphQL, which shares a token's
    // GraphQL rate-limit pool that gets exhausted first under a heavy push —
    // wedging every remediation spawn with "API rate limit already exceeded".
    // `git clone` uses the git smart-HTTP protocol (a separate, far larger
    // limit). Authentication goes through `gh auth git-credential`, scoped
    // inline via GH_GIT_CREDENTIAL_ENV, so it works from the daemon's exported
    // GITHUB_TOKEN even on a host where `gh auth setup-git` was never run; no
    // token is passed on argv or written into .git/config. Verified to succeed
    // even when the token's GraphQL budget is fully exhausted.
    await runWorkspaceGitWithTransientRetry(
      ['clone', `https://github.com/${repo}.git`, workspaceDir],
      {
        execFileImpl,
        options: {
          maxBuffer: 10 * 1024 * 1024,
          env: withGhGitCredentialEnv(env),
        },
      }
    );
  }

  // Set local git identity *before* the PR checkout so the very first
  // commits the remediation worker makes (including any in-process author
  // hooks that read `git config user.*` at startup) see the correct values.
  // Local config (no --global) is scoped to .git/config in this workspace
  // alone — it cannot leak into the operator's other repos. Idempotent: a
  // re-run against an existing workspace just overwrites the same values.
  // The identity is keyed on workerClass so the soon-to-land claude-code
  // remediation path doesn't need a separate code change here.
  const gitIdentity = remediationWorkerGitIdentity(workerClass);
  await execFileImpl('git', ['-C', workspaceDir, 'config', 'user.name', gitIdentity.name], {
    maxBuffer: 1 * 1024 * 1024,
  });
  await execFileImpl('git', ['-C', workspaceDir, 'config', 'user.email', gitIdentity.email], {
    maxBuffer: 1 * 1024 * 1024,
  });

  // Install the worker-provenance commit-msg hook in this workspace's
  // .git/hooks. The hook reads worker-context env vars at commit time
  // and appends Worker-Class / Worker-Job-Id / Worker-Run-At trailers
  // so each commit carries durable audit metadata in the immutable
  // commit object (no separate ledger lookup required to know what
  // pipeline produced the commit). Per-job clone = per-job hooks dir;
  // cannot leak into other repos. Idempotent: if a previous consume of
  // this job already installed the hook, we just overwrite it with the
  // current source — guaranteeing the deployed hook never drifts from
  // the version checked into this branch.
  installWorkerProvenanceHook(workspaceDir);

  // Check out the PR head branch without `gh pr checkout` (which goes through
  // GraphQL and so fails under the same rate-limit exhaustion as the clone).
  // For a same-repo PR the head branch lives on origin, so a plain
  // `git fetch` + `checkout -B` reproduces what `gh pr checkout` sets up —
  // including the local branch name the remediation worker later
  // force-with-lease pushes back to (HEAD:refs/heads/<branch>). Fork PRs (head
  // branch not on origin) fall back to `gh pr checkout`, which handles the
  // fork remote wiring; forks are not part of this fleet's hot path, so the
  // rare GraphQL call there is acceptable.
  const { branch: headRef, headRepo } = await fetchPRBranchMetadata({
    repo,
    prNumber: job.prNumber,
    execFileImpl,
  });
  const isSameRepo = !headRepo || headRepo === repo;
  if (isSameRepo && headRef) {
    await runWorkspaceGitWithTransientRetry(
      ['-C', workspaceDir, 'fetch', 'origin', `+refs/heads/${headRef}:refs/remotes/origin/${headRef}`],
      {
        execFileImpl,
        options: {
          maxBuffer: 10 * 1024 * 1024,
          env: withGhGitCredentialEnv(env),
        },
      }
    );
    await runWorkspaceGitWithTransientRetry(
      ['-C', workspaceDir, 'checkout', '-B', headRef, `origin/${headRef}`],
      {
        execFileImpl,
        options: {
          maxBuffer: 10 * 1024 * 1024,
        },
      }
    );
  } else {
    await runWorkspaceNetworkCommandWithTransientRetry({
      execFileImpl,
      command: 'gh',
      args: ['pr', 'checkout', String(job.prNumber)],
      options: {
        cwd: workspaceDir,
        maxBuffer: 10 * 1024 * 1024,
      },
    });
  }

  return {
    workspaceDir,
    workspaceState: workspaceState.reset
      ? { action: 'recloned', reason: workspaceState.reason }
      : { action: 'reused', reason: workspaceState.reason },
  };
}

function resolveWorkerStoredPath(rootDir, storedPath, {
  label,
  allowMissing = true,
  workspaceRootDir = null,
} = {}) {
  if (!storedPath) {
    return null;
  }

  const value = String(storedPath);
  if (!isAbsolute(value)) {
    return resolveJobRelativePath(rootDir, value, { label, allowMissing });
  }

  const absolutePath = resolve(value);
  const allowedWorkspaceRoot = workspaceRootDir
    ? resolve(workspaceRootDir)
    : resolveRemediationWorkspaceRoot({ rootDir });
  if (!isPathInsideOrEqual(allowedWorkspaceRoot, absolutePath)) {
    throw new Error(`Invalid ${label}: absolute path escapes remediation workspace root`);
  }
  if (!allowMissing && !existsSync(absolutePath)) {
    throw new Error(`Invalid ${label}: path does not exist`);
  }
  return absolutePath;
}

function resolveStoredWorkspaceRoot(rootDir, storedPath, {
  allowMissing = true,
  env = process.env,
  log = console,
} = {}) {
  if (!storedPath) {
    return null;
  }

  const value = String(storedPath);
  const absolutePath = isAbsolute(value)
    ? resolve(value)
    : resolveJobRelativePath(rootDir, value, { label: 'workspaceRoot', allowMissing });
  if (!isLegitimateStoredWorkspaceRoot(rootDir, absolutePath, env)) {
    log.warn?.(
      `[follow-up-remediation] Ignoring persisted workspaceRoot outside allowed remediation roots: ${absolutePath}`
    );
    return null;
  }
  if (!allowMissing && !existsSync(absolutePath)) {
    throw new Error('Invalid workspaceRoot: path does not exist');
  }
  return absolutePath;
}

async function ensureWorkspaceArtifactExclude(workspaceDir, {
  execFileImpl = execFileAsync,
  entry = WORKSPACE_ARTIFACT_EXCLUDE_ENTRY,
} = {}) {
  const { stdout } = await execFileImpl('git', ['rev-parse', '--git-path', 'info/exclude'], {
    cwd: workspaceDir,
  });
  const gitPath = String(stdout ?? '').trim() || '.git/info/exclude';
  const excludePath = resolve(workspaceDir, gitPath);
  const existing = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : '';
  const lines = existing.split(/\r?\n/);
  if (lines.includes(entry)) {
    return excludePath;
  }
  const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
  mkdirSync(dirname(excludePath), { recursive: true });
  writeFileSync(excludePath, `${existing}${prefix}${entry}\n`, 'utf8');
  return excludePath;
}

// Workspace containment guard for worker-written artifacts. Performs both
// a lexical check (catches `../escape` paths from a forged or stale job
// record) and a realpath check (catches in-workspace symlinks pointing
// outside the workspace). Without the realpath leg, a symlink planted
// inside `.adversarial-follow-up/` could redirect reconcile to read a
// forged remediation-reply.json from anywhere on disk and drive
// `completed`/`stopped` plus a watcher-row reset off it.
function assertContainedInWorkspace(label, workspaceDir, candidate) {
  if (!workspaceDir || !candidate) return;

  const lexicalRel = relative(workspaceDir, candidate);
  if (lexicalRel.startsWith('..') || lexicalRel === '' || isAbsolute(lexicalRel)) {
    throw new Error(`Invalid ${label}: path escapes workspaceDir`);
  }

  if (existsSync(candidate)) {
    const stat = lstatSync(candidate);
    if (stat.isSymbolicLink()) {
      throw new Error(`Invalid ${label}: symbolic links are not allowed`);
    }
  }

  const realCandidate = resolveRealPath(candidate);
  const realWorkspace = resolveRealPath(workspaceDir);
  const realRel = relative(realWorkspace, realCandidate);
  if (realRel.startsWith('..') || realRel === '' || isAbsolute(realRel)) {
    throw new Error(`Invalid ${label}: resolved path escapes workspaceDir`);
  }
}

function buildReconciliationPaths(rootDir, job) {
  const worker = job?.remediationWorker || {};
  const replyTarget = resolveRemediationReplyTarget(process.env, { requireExists: false });
  const replyStorageKey = resolveReplyStorageKey(job);
  const { replyPath: expectedReplyPath } = replyTarget.resolvePath({
    launchRequestId: replyStorageKey,
  });
  const storedWorkspaceRoot = worker.workspaceRoot || job.workspaceRoot || null;
  const workspaceRootDir = resolveStoredWorkspaceRoot(rootDir, storedWorkspaceRoot)
    || resolveRemediationWorkspaceRoot({ rootDir });
  const workspaceDir = resolveWorkerStoredPath(rootDir, job.workspaceDir || worker.workspaceDir || null, {
    label: 'workspaceDir',
    workspaceRootDir,
  });
  const resolvedWorkspaceDir = workspaceDir || join(workspaceRootDir, job.jobId);
  const outputPath = resolveWorkerStoredPath(rootDir, worker.outputPath || null, {
    label: 'outputPath',
    workspaceRootDir,
  });
  const logPath = resolveWorkerStoredPath(rootDir, worker.logPath || null, {
    label: 'logPath',
    workspaceRootDir,
  });
  const storedReplyPath = worker.replyPath || job?.remediationReply?.path || null;
  let replyPath = expectedReplyPath;
  let legacyReplyPath = join(resolvedWorkspaceDir, '.adversarial-follow-up', 'remediation-reply.json');
  if (storedReplyPath && isAbsolute(storedReplyPath)) {
    if (replyTarget.mode === 'hq') {
      replyPath = resolveHqReplyArtifactPath(storedReplyPath, { hqRoot: replyTarget.root });
    } else {
      replyPath = resolve(storedReplyPath);
      const rel = relative(replyTarget.root, replyPath);
      if (rel.startsWith('..') || isAbsolute(rel)) {
        throw new Error(`Invalid local remediation reply path outside replies root: ${replyPath}`);
      }
    }
  } else if (storedReplyPath) {
    legacyReplyPath = resolveJobRelativePath(rootDir, storedReplyPath, {
      label: 'replyPath',
    });
  }

  assertContainedInWorkspace('outputPath', resolvedWorkspaceDir, outputPath);
  assertContainedInWorkspace('logPath', resolvedWorkspaceDir, logPath);
  if (legacyReplyPath) {
    assertContainedInWorkspace('legacyReplyPath', resolvedWorkspaceDir, legacyReplyPath);
  }

  return {
    workspaceDir: resolvedWorkspaceDir,
    workspaceRootDir,
    outputPath,
    logPath,
    replyPath,
    legacyReplyPath,
  };
}

function buildRereviewResult({ requested, reason, outcome = null }) {
  return {
    requested,
    requestedAt: outcome?.requestedAt || null,
    reason: reason || null,
    triggered: Boolean(outcome?.triggered),
    status: outcome?.status || (requested ? 'blocked' : 'not-requested'),
    outcomeReason: outcome?.reason || null,
    reviewRow: outcome?.reviewRow
      ? {
          repo: outcome.reviewRow.repo,
          prNumber: outcome.reviewRow.pr_number,
          reviewer: outcome.reviewRow.reviewer,
          prState: outcome.reviewRow.pr_state,
          reviewStatus: outcome.reviewRow.review_status,
          reviewAttempts: outcome.reviewRow.review_attempts,
          lastAttemptedAt: outcome.reviewRow.last_attempted_at,
          postedAt: outcome.reviewRow.posted_at,
          failedAt: outcome.reviewRow.failed_at,
        }
      : null,
  };
}

// Resolve the worker class (codex / claude-code) for a reconcile-time
// comment. Must reuse the same canonical mapping consume uses
// (`pickRemediationWorkerClass`), because the bot-token map only
// covers worker classes that actually have dedicated PATs:
//
//   WORKER_CLASS_TO_BOT_TOKEN_ENV = { codex, 'claude-code' }
//
// The previous implementation returned `worker.model || job.builderTag
// || 'codex'`. For `[clio-agent]` PRs that produced
// `workerClass='clio-agent'`, which has no token mapping → the comment
// poster returned `no-token-mapping`, which the retry path treats as
// non-retryable → permanent silent loss of the terminal PR comment.
// (PR #18 R7 blocking #3.)
//
// Strategy:
//   1. If the spawned worker recorded a `.model` AND that model has a
//      bot-token mapping, trust it (most authoritative for THIS
//      worker's actual session — claude-code-spawned workers should
//      post under the claude-code bot regardless of the PR's tag).
//   2. Otherwise, fall through to `pickRemediationWorkerClass(job)`
//      which canonically maps `clio-agent → codex` (since clio-agent
//      has no dedicated worker class today; consume already does this
//      at spawn time).
function resolveReconcileWorkerClass(job, worker) {
  const recordedModel = worker?.model;
  if (recordedModel && WORKER_CLASS_TO_BOT_TOKEN_ENV[recordedModel]) {
    return recordedModel;
  }
  return pickRemediationWorkerClass(job);
}

// Build the comment body + an owed-delivery stub from the same inputs
// that `postReconcileOutcomeCommentSafe` will eventually use. The
// caller threads the owed delivery into `markFollowUpJob*`'s
// `commentDelivery` parameter so the terminal record lands in
// completed/stopped/failed with `commentDelivery` already present —
// closing the crash window between the atomic terminal move and the
// pre-stamp inside `recordInitialCommentDelivery`. (Reviewer R5
// blocking #1 — recoverable delivery marker BEFORE the crash window.)
function buildReconcileCommentDelivery({
  job,
  worker,
  action,
  reply = null,
  reReview = null,
  failure = null,
  now = () => new Date().toISOString(),
}) {
  const workerClass = resolveReconcileWorkerClass(job, worker);
  const body = buildRemediationOutcomeCommentBody({
    workerClass,
    action,
    job,
    reply,
    reReview,
    failure,
  });
  const commentDelivery = buildOwedDelivery({
    body,
    repo: job?.repo,
    prNumber: job?.prNumber,
    workerClass,
    owedAt: now(),
    revisionRef: job?.revisionRef || null,
    round: job?.remediationPlan?.currentRound || null,
    kind: 'remediation-reply',
  });
  return { body, workerClass, commentDelivery };
}

async function postReconcileOutcomeCommentSafe({
  rootDir,
  jobPath,
  job,
  worker,
  action,
  reply = null,
  reReview = null,
  failure = null,
  postCommentImpl,
  alreadyTerminal = false,
  now = () => new Date().toISOString(),
  log = console,
}) {
  // Idempotency — when `moveTerminalJobRecord` reports the job was
  // already moved by another process (concurrent reconcile race),
  // that other process is already responsible for the comment. We
  // MUST NOT also post; doing so would produce duplicate public PR
  // comments. This is the alreadyTerminal short-circuit demanded by
  // PR #18 round 3 review (blocking #1, race A).
  if (alreadyTerminal) {
    log.error?.(`[follow-up-remediation] skipping comment post — terminal move already owned by another process (jobPath=${jobPath || 'unknown'})`);
    return;
  }

  // Best-effort: never let a post failure throw out of reconcile.
  // recordInitialCommentDelivery handles the durability-first stamp
  // (write attempting=true → call gh → write final result), the
  // claim lock (concurrent-retry idempotency, race B), and the
  // poster-throws-synthesizes-failure path. We just hand it the
  // ingredients and let it own the lifecycle.
  try {
    const workerClass = resolveReconcileWorkerClass(job, worker);
    const body = buildRemediationOutcomeCommentBody({
      workerClass,
      action,
      job,
      reply,
      reReview,
      failure,
    });
    if (jobPath) {
      await recordInitialCommentDelivery({
        rootDir,
        jobPath,
        body,
        repo: job?.repo,
        prNumber: job?.prNumber,
        workerClass,
        revisionRef: job?.revisionRef || null,
        round: job?.remediationPlan?.currentRound || null,
        kind: 'remediation-reply',
        postCommentImpl: (args) => postRemediationCommentWithCapture({
          rootDir,
          ...args,
          attemptNumber: remediationAttemptNumber(job),
          postCommentImpl,
          log,
        }),
        postCommentArgs: {
          repo: job?.repo,
          prNumber: job?.prNumber,
          workerClass,
          body,
          log,
        },
        now,
        log,
      });
    } else {
      // No jobPath (defensive — shouldn't happen on reconcile path)
      // means we can't stamp delivery state durably. Still attempt
      // the post for operator visibility, but log the gap.
      log.error?.('[follow-up-remediation] posting comment without a jobPath — no durable delivery record');
      await postRemediationCommentWithCapture({
        rootDir,
        repo: job?.repo,
        prNumber: job?.prNumber,
        attemptNumber: remediationAttemptNumber(job),
        workerClass,
        body,
        postCommentImpl,
        log,
      });
    }
  } catch (err) {
    log.error?.(`[follow-up-remediation] PR comment post threw (non-fatal): ${err.message}`);
  }
}

async function postRemediationCommentWithCapture({
  rootDir = ROOT,
  repo,
  prNumber,
  attemptNumber,
  workerClass,
  body,
  postCommentImpl = postRemediationOutcomeComment,
  captureImpl = captureRemediationBodyAfterPost,
  postedAt = null,
  log = console,
} = {}) {
  const result = await postCommentImpl({
    repo,
    prNumber,
    workerClass,
    body,
    log,
  });
  if (result?.posted) {
    // Capture postedAt AFTER the post returns so the lookup window
    // brackets the GitHub-assigned `created_at` (set by GH during post
    // handling), not the pre-post call time.
    const effectivePostedAt = postedAt || new Date().toISOString();
    await captureImpl(rootDir, {
      repo,
      prNumber,
      attemptNumber: Number(attemptNumber),
      workerClass,
      body,
      postedAt: effectivePostedAt,
      log,
    });
  }
  return result;
}

// Resolve the live PR lifecycle for a job, swallowing any errors so the
// merge gate degrades to "proceed with existing behavior" instead of
// halting the whole pipeline when GitHub or the SQLite mirror is down.
// Logs at error level so the visibility regression isn't silent — ops
// can still tell the difference between "merge gate didn't fire" and
// "merge gate couldn't fire because the lookup failed".
async function failFollowUpJobForHqCancel({
  rootDir,
  job,
  jobPath,
  worker,
  workerState,
  failedAt,
  cancellation,
  action,
  postCommentImpl,
  now,
  log,
}) {
  const failure = {
    code: 'hq-dispatch-cancel-failed',
    message: [
      `Failed to cancel HQ remediation dispatch ${worker?.dispatchId || '(missing dispatchId)'} before moving the job to ${action}.`,
      cancellation?.error || 'hq dispatch cancel failed',
    ].join('\n'),
  };
  const { commentDelivery } = buildReconcileCommentDelivery({
    job,
    worker,
    action: 'failed',
    failure,
    now,
  });
  const failed = markFollowUpJobFailed({
    rootDir,
    jobPath,
    failedAt,
    failureCode: 'hq-dispatch-cancel-failed',
    error: new Error(failure.message),
    remediationWorker: {
      ...workerState,
      state: 'failed',
      cancellation,
    },
    failure: {
      hqDispatchCancel: cancellation,
    },
    commentDelivery,
  });

  await postReconcileOutcomeCommentSafe({
    rootDir,
    jobPath: failed.jobPath,
    job: failed.job,
    worker,
    action: 'failed',
    failure,
    postCommentImpl,
    alreadyTerminal: failed.alreadyTerminal,
    now,
    log,
  });

  return {
    action: 'failed',
    reason: 'hq-dispatch-cancel-failed',
    job: failed.job,
    jobPath: failed.jobPath,
  };
}

async function reconcileFollowUpJob({
  rootDir = ROOT,
  job,
  jobPath,
  now = () => new Date().toISOString(),
  isWorkerRunning = isWorkerProcessRunning,
  postCommentImpl = postRemediationOutcomeComment,
  requestReviewRereviewImpl = requestReviewRereview,
  requestWatcherWakeImpl = requestWatcherWake,
  resolvePRLifecycleImpl = resolvePRLifecycle,
  auditWorkspaceForContaminationImpl = auditWorkspaceForContamination,
  execFileImpl = execFileAsync,
  workerTerminalEvent = null,
  log = console,
} = {}) {
  const worker = job?.remediationWorker;
  const isHqWorker = worker?.dispatchMode === 'hq' && typeof worker?.dispatchId === 'string' && worker.dispatchId.trim();
  if ((!isHqWorker && !worker?.processId) || worker.state !== 'spawned') {
    return {
      action: 'skipped',
      reason: 'missing-worker-metadata',
      job,
      jobPath,
    };
  }

  let paths = null;
  let pathsError = null;
  if (workerTerminalEvent?.status === 'succeeded' && workerTerminalEventMatches(worker, workerTerminalEvent)) {
    try {
      paths = buildReconciliationPaths(rootDir, job);
    } catch (err) {
      pathsError = err;
    }
  }

  const liveness = await assessWorkerLivenessDetailed(job, {
    now,
    isWorkerRunning,
    execFileImpl,
    workerTerminalEvent,
    workerTerminalReplyPath: paths?.replyPath || null,
  });
  const lifecycle = await resolveJobPRLifecycleSafe({
    rootDir,
    job,
    resolvePRLifecycleImpl,
    execFileImpl,
    log,
  });
  const lifecycleStop = lifecycleStopDecision(lifecycle, {
    repo: job.repo,
    prNumber: job.prNumber,
    site: 'reconcile',
    job,
  });
  if (liveness.state === 'active' && !lifecycleStop) {
    return {
      action: 'active',
      reason: liveness.reason,
      job,
      jobPath,
    };
  }
  if (liveness.state === 'active') {
    const lifecycleStoppedAt = now();
    const workerState = {
      ...worker,
      state: lifecycleStop.workerState,
      reconciledAt: lifecycleStoppedAt,
    };
    if (isHqWorker) {
      const cancellation = await cancelHqDispatch({
        worker,
        execFileImpl,
      });
      if (!cancellation.cancelled) {
        return failFollowUpJobForHqCancel({
          rootDir,
          job,
          jobPath,
          worker,
          workerState,
          failedAt: lifecycleStoppedAt,
          cancellation,
          action: lifecycleStop.stopCode,
          postCommentImpl,
          now,
          log,
        });
      }
      workerState.cancellation = cancellation;
    }
    const stopped = markFollowUpJobStopped({
      rootDir,
      jobPath,
      stoppedAt: lifecycleStoppedAt,
      stopCode: lifecycleStop.stopCode,
      stopReason: lifecycleStop.stopReason,
      sourceStatus: 'in_progress',
      remediationWorker: workerState,
    });
    return {
      action: 'stopped',
      reason: lifecycleStop.actionReason,
      job: stopped.job,
      jobPath: stopped.jobPath,
    };
  }

  // Lifecycle gate: stop the bounded loop on any non-open PR state. If
  // the operator merged or closed the PR while the worker was running,
  // none of the downstream reconcile steps will help — the rereview
  // reset is refused because pr_state != 'open', and any PR comment
  // lands at the bottom of an already-terminal thread. The worker's
  // pushed commits stay on the remote branch; if they're already in
  // main via the merge, that's the operator's intent and we don't
  // want to undo it. resolvePRLifecycleImpl prefers a live `gh pr
  // view` lookup over the SQLite mirror so this gate closes the race
  // where the watcher's syncPRLifecycle poll lags GitHub.
  if (lifecycleStop) {
    const lifecycleStoppedAt = now();
    const stopped = markFollowUpJobStopped({
      rootDir,
      jobPath,
      stoppedAt: lifecycleStoppedAt,
      stopCode: lifecycleStop.stopCode,
      stopReason: lifecycleStop.stopReason,
      sourceStatus: 'in_progress',
      remediationWorker: {
        ...worker,
        state: lifecycleStop.workerState,
        reconciledAt: lifecycleStoppedAt,
      },
    });
    return {
      action: 'stopped',
      reason: lifecycleStop.actionReason,
      job: stopped.job,
      jobPath: stopped.jobPath,
    };
  }

  const completedAt = now();
  if (liveness.state === 'manual-inspection') {
    const manualInspectionFailure = { code: 'manual-inspection-required', message: liveness.reason };
    const { commentDelivery: manualInspectionDelivery } = buildReconcileCommentDelivery({
      job, worker, action: 'failed', failure: manualInspectionFailure, now,
    });
    const failed = markFollowUpJobFailed({
      rootDir,
      jobPath,
      failedAt: completedAt,
      failureCode: 'manual-inspection-required',
      error: new Error(
        `Remediation worker PID ${worker.processId} still appears active beyond the reconciliation runtime cap. Manual inspection required before trusting the PID association.`
      ),
      remediationWorker: {
        ...worker,
        state: 'manual_inspection_required',
        reconciledAt: completedAt,
      },
      failure: {
        manualInspectionRequired: true,
        inspectionReason: liveness.reason,
        workerRuntimeMs: liveness.ageMs,
        finalMessagePath: worker.outputPath || null,
        logPath: worker.logPath || null,
      },
      commentDelivery: manualInspectionDelivery,
    });

    await postReconcileOutcomeCommentSafe({
      rootDir,
      jobPath: failed.jobPath,
      job: failed.job,
      worker,
      action: 'failed',
      failure: manualInspectionFailure,
      postCommentImpl,
      alreadyTerminal: failed.alreadyTerminal,
      now,
      log,
    });

    return {
      action: 'failed',
      reason: liveness.reason,
      job: failed.job,
      jobPath: failed.jobPath,
    };
  }

  try {
    if (!paths && !pathsError) {
      paths = buildReconciliationPaths(rootDir, job);
    }
    if (pathsError) {
      throw pathsError;
    }
  } catch (err) {
    const invalidPathFailure = { code: 'invalid-output-path', message: err.message };
    const { commentDelivery: invalidPathDelivery } = buildReconcileCommentDelivery({
      job, worker, action: 'failed', failure: invalidPathFailure, now,
    });
    const failed = markFollowUpJobFailed({
      rootDir,
      jobPath,
      failedAt: completedAt,
      failureCode: 'invalid-output-path',
      error: err,
      remediationWorker: {
        ...worker,
        state: 'failed',
        reconciledAt: completedAt,
      },
      failure: {
        invalidArtifactPaths: true,
      },
      commentDelivery: invalidPathDelivery,
    });

    await postReconcileOutcomeCommentSafe({
      rootDir,
      jobPath: failed.jobPath,
      job: failed.job,
      worker,
      action: 'failed',
      failure: invalidPathFailure,
      postCommentImpl,
      alreadyTerminal: failed.alreadyTerminal,
      now,
      log,
    });

    return {
      action: 'failed',
      reason: 'invalid-worker-paths',
      job: failed.job,
      jobPath: failed.jobPath,
    };
  }

  const finalMessage = readWorkerFinalMessage(paths.outputPath);
  const workerState = {
    ...worker,
    reconciledAt: completedAt,
  };

  // The narrative artifact (final message stdout capture) is one of two
  // independent success signals; the durable one is the validated
  // remediation-reply.json. A claude-code worker's `--print` mode can
  // legitimately produce zero stdout when its response was tool-only
  // (edits + commit + push + reply.json written via the Write tool, no
  // textual narrative back). Probe the reply up front in tri-state form
  // so we can:
  //   - route empty-stdout-but-valid-reply workers through the success
  //     branch (where reply.reReview.requested decides completed vs
  //     stopped — that is the durable signal per SPEC.md §5.1.2, NOT
  //     reply.outcome)
  //   - surface invalid replies as `invalid-remediation-reply`
  //     regardless of stdout (hiding invalid replies behind a generic
  //     empty-stdout failure loses the real failure cause and makes
  //     operator recovery harder)
  //
  // Concrete incident this guards against: PR #20's first remediation
  // round (job 2026-05-02T13-40-18-832Z). Worker pushed a real fix
  // (commit 839ed9c, 9 files / 557 lines / 4 blockers addressed),
  // wrote a valid reply.json with reReview.requested=true, but
  // produced empty stdout. Reconciler false-failed the job and posted
  // "Human intervention required" on the PR.
  let replyProbe = { state: 'missing' };
  if (paths.replyPath && existsSync(paths.replyPath)) {
    try {
      replyProbe = {
        state: 'valid',
        reply: readRemediationReplyArtifact(paths.replyPath, { expectedJob: job }),
      };
    } catch (err) {
      replyProbe = { state: 'invalid', error: err };
    }
  } else if (
    paths.legacyReplyPath
    && paths.legacyReplyPath !== paths.replyPath
    && existsSync(paths.legacyReplyPath)
  ) {
    replyProbe = {
      state: 'invalid',
      error: new Error(
        `Legacy remediation reply path is forbidden for new remediation rounds: ${paths.legacyReplyPath}`
      ),
      fallbackPath: paths.legacyReplyPath,
    };
  }
  const hasNonEmptyNarrative = finalMessage.exists && Boolean(String(finalMessage.text).trim());

  // Invalid reply is a distinct artifact failure regardless of whether
  // stdout is empty or non-empty. Route it directly to
  // `invalid-remediation-reply` so the operator gets the real cause
  // instead of a misleading `artifact-empty-completion`.
  //
  // Salvage path: even though strict validation rejected the reply,
  // the file may still contain a renderable summary / addressed[] /
  // pushback[] / blockers[]. Pull those out and pass them into the
  // failure comment so the worker's point-by-point response is not
  // dropped just because (e.g.) `reReview.reason` was null. State
  // machine stays strict — round still routes to `failed/`, watcher
  // does NOT rearm — but the operator-facing comment shows what the
  // worker actually did instead of just "did not produce a usable
  // remediation reply". The salvaged reply is best-effort and not
  // persisted to the job record.
  if (replyProbe.state === 'invalid') {
    const err = replyProbe.error;
    const invalidReplyFailure = { code: 'invalid-remediation-reply', message: err.message };
    const salvagePath = replyProbe.fallbackPath || paths.replyPath;
    const salvagedReply = salvagePath ? salvagePartialRemediationReply(salvagePath) : null;
    const { commentDelivery: invalidReplyDelivery } = buildReconcileCommentDelivery({
      job, worker, action: 'failed', reply: salvagedReply, failure: invalidReplyFailure, now,
    });
    const failed = markFollowUpJobFailed({
      rootDir,
      jobPath,
      failedAt: completedAt,
      failureCode: 'invalid-remediation-reply',
      error: err,
      remediationWorker: {
        ...workerState,
        state: 'failed',
      },
      failure: {
        remediationReplyPath: worker.replyPath || job?.remediationReply?.path || null,
      },
      commentDelivery: invalidReplyDelivery,
    });

    await postReconcileOutcomeCommentSafe({
      rootDir,
      jobPath: failed.jobPath,
      job: failed.job,
      worker,
      action: 'failed',
      reply: salvagedReply,
      failure: invalidReplyFailure,
      postCommentImpl,
      alreadyTerminal: failed.alreadyTerminal,
      now,
      log,
    });

    return {
      action: 'failed',
      reason: 'invalid-remediation-reply',
      job: failed.job,
      jobPath: failed.jobPath,
    };
  }

  if (hasNonEmptyNarrative || replyProbe.state === 'valid') {
    let remediationReply = {
      ...job?.remediationReply,
      state: job?.remediationReply?.path ? 'awaiting-worker-write' : 'not-configured',
    };
    let rereview = buildRereviewResult({ requested: false });
    // Hoisted so the terminal `stopped` / `completed` branches below
    // can pass the worker's parsed reply (summary, validation,
    // blockers) into the public PR comment. When the reply path
    // is not configured for this job, this stays null and the
    // comment body falls back to the action / reReview signal alone.
    let parsedReply = null;

    if (replyProbe.state === 'valid') {
      const reply = replyProbe.reply;
      remediationReply = {
        ...remediationReply,
        state: 'worker-wrote-reply',
        path: worker.replyPath || job?.remediationReply?.path || null,
      };
      parsedReply = reply;

      if (reply.reReview.requested) {
        // Pre-rereview branch-contamination gate. Even though the
        // remediator prompt forbids pushing patch-id duplicates of
        // upstream commits, workers can ignore the contract or run a
        // git command that bypasses the worker-side audit. If the
        // remediation workspace has commits on HEAD that are
        // patch-equivalent to commits already on `origin/<baseBranch>`,
        // the next reviewer pass will treat them as PR scope and
        // generate spurious findings. Refuse to request the rereview
        // and emit a `failed:branch-contamination` outcome instead.
        let baseBranch;
        try {
          const hydrated = await ensureJobBaseBranch({ job, jobPath, execFileImpl });
          job = hydrated.job;
          baseBranch = hydrated.baseBranch;
        } catch (err) {
          rereview = buildRereviewResult({
            requested: false,
            reason: null,
            outcome: {
              status: 'refused',
              reason: 'base-branch-resolution-failed',
              error: err.message,
            },
          });
          const baseBranchFailure = {
            code: 'base-branch-resolution-failed',
            message: [
              `Could not prove the PR base branch for ${job?.repo}#${job?.prNumber}; refused to request rereview.`,
              err.message,
              'Resolve the PR base branch and retry remediation before any rebase or branch-contamination audit.',
            ].join('\n'),
          };
          const { commentDelivery: baseBranchFailureDelivery } = buildReconcileCommentDelivery({
            job,
            worker,
            action: 'failed',
            reply: parsedReply,
            failure: baseBranchFailure,
            now,
          });
          const failed = markFollowUpJobFailed({
            rootDir,
            jobPath,
            failedAt: completedAt,
            failureCode: 'base-branch-resolution-failed',
            error: new Error(baseBranchFailure.message),
            remediationWorker: {
              ...workerState,
              state: 'failed',
            },
            failure: {
              remediationReplyPath: worker.replyPath || job?.remediationReply?.path || null,
              error: err.message,
            },
            commentDelivery: baseBranchFailureDelivery,
            jobUpdates: {
              completedAt,
              remediationReply,
              completionMetadata: {
                source: 'reconcile:base-branch-resolution-failed',
                note: 'PR base branch could not be proven; refused rereview rather than defaulting to main.',
                error: err.message,
              },
              parsedReply,
              rereview,
            },
          });

          await postReconcileOutcomeCommentSafe({
            rootDir,
            jobPath: failed.jobPath,
            job: failed.job,
            worker,
            action: 'failed',
            reply: parsedReply,
            failure: baseBranchFailure,
            postCommentImpl,
            alreadyTerminal: failed.alreadyTerminal,
            now,
            log,
          });

          return {
            action: 'failed',
            reason: 'base-branch-resolution-failed',
            job: failed.job,
            jobPath: failed.jobPath,
          };
        }
        let auditWorkspaceDir = paths.workspaceDir;
        if (worker?.dispatchMode === 'hq') {
          const topicWorkspaceDir = parseHqWorkerWorkspaceFromPayload(liveness?.dispatchStatus || {});
          try {
            auditWorkspaceDir = topicWorkspaceDir || await resolveHqWorkerWorkspace({
              worker,
              execFileImpl,
            }) || paths.workspaceDir;
          } catch (err) {
            const contaminationAudit = { suspect: [], error: `hq dispatch status failed: ${err.message}` };
            rereview = buildRereviewResult({
              requested: false,
              reason: null,
              outcome: {
                status: 'refused',
                reason: 'branch-contamination-audit-error',
                auditError: contaminationAudit.error,
              },
            });
            const auditFailure = {
              code: 'branch-contamination-audit-error',
              message: [
                `Branch cleanliness audit failed before rereview could be requested for origin/${baseBranch}.`,
                contaminationAudit.error,
                'Fix the workspace git state or upstream ref lookup, then retry remediation.',
              ].join('\n'),
            };
            const { commentDelivery: auditFailureDelivery } = buildReconcileCommentDelivery({
              job,
              worker,
              action: 'failed',
              reply: parsedReply,
              failure: auditFailure,
              now,
            });
            const failed = markFollowUpJobFailed({
              rootDir,
              jobPath,
              failedAt: completedAt,
              failureCode: 'branch-contamination-audit-error',
              error: new Error(auditFailure.message),
              remediationWorker: {
                ...workerState,
                state: 'failed',
              },
              failure: {
                remediationReplyPath: worker.replyPath || job?.remediationReply?.path || null,
                auditError: contaminationAudit.error,
              },
              commentDelivery: auditFailureDelivery,
              jobUpdates: {
                completedAt,
                remediationReply,
                completionMetadata: {
                  source: 'reconcile:branch-contamination-audit-error',
                  note: 'PR branch cleanliness could not be proven because the HQ worker workspace could not be resolved.',
                  auditError: contaminationAudit.error,
                },
                parsedReply,
                rereview,
              },
            });

            await postReconcileOutcomeCommentSafe({
              rootDir,
              jobPath: failed.jobPath,
              job: failed.job,
              worker,
              action: 'failed',
              reply: parsedReply,
              failure: auditFailure,
              postCommentImpl,
              alreadyTerminal: failed.alreadyTerminal,
              now,
              log,
            });

            return {
              action: 'failed',
              reason: 'branch-contamination-audit-error',
              job: failed.job,
              jobPath: failed.jobPath,
            };
          }
        }
        const contaminationAudit = await auditWorkspaceForContaminationImpl({
          workspaceDir: auditWorkspaceDir,
          baseBranch,
          execFileImpl,
        });
          if (contaminationAudit.error) {
            rereview = buildRereviewResult({
              requested: false,
              reason: null,
              outcome: {
                status: 'refused',
                reason: 'branch-contamination-audit-error',
                auditError: contaminationAudit.error,
              },
            });
            const auditFailure = {
              code: 'branch-contamination-audit-error',
              message: [
                `Branch cleanliness audit failed before rereview could be requested for origin/${baseBranch}.`,
                contaminationAudit.error,
                'Fix the workspace git state or upstream ref lookup, then retry remediation.',
              ].join('\n'),
            };
            const { commentDelivery: auditFailureDelivery } = buildReconcileCommentDelivery({
              job,
              worker,
              action: 'failed',
              reply: parsedReply,
              failure: auditFailure,
              now,
            });
            const failed = markFollowUpJobFailed({
              rootDir,
              jobPath,
              failedAt: completedAt,
              failureCode: 'branch-contamination-audit-error',
              error: new Error(auditFailure.message),
              remediationWorker: {
                ...workerState,
                state: 'failed',
              },
              failure: {
                remediationReplyPath: worker.replyPath || job?.remediationReply?.path || null,
                auditError: contaminationAudit.error,
              },
              commentDelivery: auditFailureDelivery,
              jobUpdates: {
                completedAt,
                remediationReply,
                completionMetadata: {
                  source: 'reconcile:branch-contamination-audit-error',
                  note: 'PR branch cleanliness could not be proven because the server-side git fetch/cherry audit failed; refused to request rereview.',
                  auditError: contaminationAudit.error,
                },
                parsedReply,
                rereview,
              },
            });

            await postReconcileOutcomeCommentSafe({
              rootDir,
              jobPath: failed.jobPath,
              job: failed.job,
              worker,
              action: 'failed',
              reply: parsedReply,
              failure: auditFailure,
              postCommentImpl,
              alreadyTerminal: failed.alreadyTerminal,
              now,
              log,
            });

            return {
              action: 'failed',
              reason: 'branch-contamination-audit-error',
              job: failed.job,
              jobPath: failed.jobPath,
            };
          }
          if (contaminationAudit.suspect && contaminationAudit.suspect.length > 0) {
            rereview = buildRereviewResult({
              requested: false,
              reason: null,
              outcome: {
                status: 'refused',
                reason: 'branch-contamination',
                suspectCommits: contaminationAudit.suspect,
              },
            });
            const contaminationFailure = {
              code: 'branch-contamination',
              message: [
                `Branch contamination detected: HEAD contains commits that are patch-equivalent to commits already on origin/${baseBranch}.`,
                ...contaminationAudit.suspect.map((entry) => `- ${((entry.sha || '').slice(0, 12) + ' ' + (entry.subject || '')).trim()}`),
                'Clean the PR branch before requesting another adversarial pass.',
              ].join('\n'),
            };
            const { commentDelivery: contaminationDelivery } = buildReconcileCommentDelivery({
              job,
              worker,
              action: 'failed',
              reply: parsedReply,
              failure: contaminationFailure,
              now,
            });
            const failed = markFollowUpJobFailed({
              rootDir,
              jobPath,
              failedAt: completedAt,
              failureCode: 'branch-contamination',
              error: new Error(contaminationFailure.message),
              remediationWorker: {
                ...workerState,
                state: 'failed',
              },
              failure: {
                remediationReplyPath: worker.replyPath || job?.remediationReply?.path || null,
                suspectCommits: contaminationAudit.suspect,
                auditError: contaminationAudit.error || null,
              },
              commentDelivery: contaminationDelivery,
              jobUpdates: {
                completedAt,
                remediationReply,
                completionMetadata: {
                  source: 'reconcile:branch-contamination',
                  note: 'PR branch contains patch-equivalent copies of commits already on the base branch; refused to request rereview to avoid confusing the next reviewer pass.',
                  suspectCommits: contaminationAudit.suspect,
                  auditError: contaminationAudit.error || null,
                },
                parsedReply,
                rereview,
              },
            });

            await postReconcileOutcomeCommentSafe({
              rootDir,
              jobPath: failed.jobPath,
              job: failed.job,
              worker,
              action: 'failed',
              reply: parsedReply,
              failure: contaminationFailure,
              postCommentImpl,
              alreadyTerminal: failed.alreadyTerminal,
              now,
              log,
            });

            return {
              action: 'failed',
              reason: 'branch-contamination',
              job: failed.job,
              jobPath: failed.jobPath,
            };
        }

        const requestedAt = completedAt;
        const rereviewOutcome = requestReviewRereviewImpl({
          rootDir,
          repo: job.repo,
          prNumber: job.prNumber,
          requestedAt,
          reason: reply.reReview.reason,
        });
        rereview = buildRereviewResult({
          requested: true,
          reason: reply.reReview.reason,
          outcome: {
            ...rereviewOutcome,
            requestedAt,
          },
        });
      } else {
        rereview = buildRereviewResult({
          requested: false,
          reason: null,
          outcome: { status: 'not-requested', reason: 'reply-did-not-request-rereview' },
        });
      }
    }

    // Worker-class aware completion metadata. The legacy default is
    // 'codex' so old jobs (model unrecorded) still produce the historical
    // `codex-output-last-message` source string. New claude-code workers
    // produce `claude-code-output-last-message`, so worker-class metrics
    // and operator-visible completion records reflect what actually ran.
    const workerModel = worker?.model || 'codex';
    const completionMetadata = {
      source: hasNonEmptyNarrative
        ? `${workerModel}-output-last-message`
        : `${workerModel}-remediation-reply-only`,
      workerModel,
      note: hasNonEmptyNarrative
        ? 'Reconciled from detached worker exit plus non-empty final message artifact.'
        : 'Reconciled from detached worker exit plus validated remediation-reply.json (final message artifact was empty; success signaled via the durable reply contract).',
      finalMessagePath: worker.outputPath || null,
      finalMessageBytes: finalMessage.bytes,
      finalMessageDigest: digestWorkerFinalMessage(finalMessage.text),
      preview: summarizeWorkerFinalMessage(finalMessage.text, 240),
      finalMessageSummary: summarizeWorkerFinalMessage(finalMessage.text, 120),
      logPath: worker.logPath || null,
      ...(worker?.dispatchMode === 'hq' ? { dispatchStatus: liveness?.dispatchStatus || null } : {}),
    };

    // Gate the terminal transition on whether the rereview was actually
    // accepted by the watcher's review-state machine, not just on whether
    // the worker asked for one. `requestReviewRereview` can refuse the
    // reset for several reasons (review row missing, malformed-title
    // terminal, PR closed, already pending). Without this gate, a job
    // moves to `completed` with a "re-review queued" PR comment even
    // though the watcher row was never reset — operators are misled and
    // the loop is silently dead in the review-row-missing / pr-not-open
    // cases. Already-pending is benign: a fresh review pass is already
    // armed, so we still treat it as a successful terminal.
    const rereviewAccepted = rereview.requested && (
      rereview.triggered || rereview.status === 'already-pending'
    );
    const rereviewBlocked = rereview.requested && !rereviewAccepted;

    if (
      rereviewAccepted &&
      rereview.triggered &&
      isRemediationToRereviewHandoffEnabled(process.env, { topPath: join(rootDir, 'config.yaml') })
    ) {
      try {
        const wake = requestWatcherWakeImpl({
          rootDir,
          reason: 'remediation-to-rereview',
          repo: job.repo,
          prNumber: job.prNumber,
          ...(job.revisionRef || job.headSha ? { headSha: job.revisionRef || job.headSha } : {}),
          requestedAt: completedAt,
        });
        rereview.wake = {
          requested: wake?.requested !== false,
          reason: wake?.payload?.reason || 'remediation-to-rereview',
          requestedAt: wake?.payload?.requested_at || completedAt,
        };
      } catch (err) {
        rereview.wake = {
          requested: false,
          reason: 'wake-failed',
          error: err?.message || String(err),
        };
        log.warn?.(
          `[follow-up-remediation] watcher wake failed after re-review reset for ` +
          `${job.repo}#${job.prNumber}: ${err?.message || err}`
        );
      }
    }

    if (!rereview.requested) {
      const currentRound = Number(job?.remediationPlan?.currentRound || 0);
      const maxRounds = Number(job?.remediationPlan?.maxRounds || 0);
      const stopCode = maxRounds > 0 && currentRound >= maxRounds
        ? 'max-rounds-reached'
        : 'no-progress';
      const stopReason = stopCode === 'max-rounds-reached'
        ? `Remediation round ${currentRound || 1} finished without a durable re-review request and reached the max remediation rounds cap (${currentRound}/${maxRounds}); stopping the bounded loop.`
        : `No durable re-review request was recorded after remediation round ${currentRound || 1}; stopping to avoid a silent no-progress loop.`;
      // Pre-build commentDelivery from the projected stopped-job shape
      // (the actual stop metadata we'll record) so the body the
      // walker may later reconstruct from this owed stamp matches
      // what we'd post live.
      const projectedStopJob = {
        ...job,
        status: 'stopped',
        remediationPlan: {
          ...(job.remediationPlan || {}),
          stop: { code: stopCode, reason: stopReason },
        },
      };
      const { commentDelivery: noProgressDelivery } = buildReconcileCommentDelivery({
        job: projectedStopJob, worker, action: 'stopped',
        reply: parsedReply, reReview: rereview, now,
      });
      const stopped = markFollowUpJobStopped({
        rootDir,
        jobPath,
        stoppedAt: completedAt,
        stopCode,
        sourceStatus: 'completed',
        remediationWorker: {
          ...workerState,
          state: 'completed',
        },
        completion: completionMetadata,
        remediationReply,
        reReview: rereview,
        stopReason,
        commentDelivery: noProgressDelivery,
      });

      await postReconcileOutcomeCommentSafe({
        rootDir,
        jobPath: stopped.jobPath,
        job: stopped.job,
        worker,
        action: 'stopped',
        reply: parsedReply,
        reReview: rereview,
        postCommentImpl,
        alreadyTerminal: stopped.alreadyTerminal,
        now,
        log,
      });

      return {
        action: 'stopped',
        reason: 'no-progress-stop',
        job: stopped.job,
        jobPath: stopped.jobPath,
      };
    }

    if (rereviewBlocked) {
      const blockedReason = rereview.outcomeReason || rereview.status || 'rereview-blocked';
      const stopReasonText = `Worker requested re-review but the watcher refused the reset: ${blockedReason}. The PR's existing adversarial review verdict will not be replaced; human intervention required.`;
      const projectedStopJob = {
        ...job,
        status: 'stopped',
        remediationPlan: {
          ...(job.remediationPlan || {}),
          stop: { code: 'rereview-blocked', reason: stopReasonText },
        },
      };
      const { commentDelivery: blockedDelivery } = buildReconcileCommentDelivery({
        job: projectedStopJob, worker, action: 'stopped',
        reply: parsedReply, reReview: rereview, now,
      });
      const stopped = markFollowUpJobStopped({
        rootDir,
        jobPath,
        stoppedAt: completedAt,
        stopCode: 'rereview-blocked',
        sourceStatus: 'completed',
        remediationWorker: {
          ...workerState,
          state: 'completed',
        },
        completion: completionMetadata,
        remediationReply,
        reReview: rereview,
        stopReason: stopReasonText,
        commentDelivery: blockedDelivery,
      });

      await postReconcileOutcomeCommentSafe({
        rootDir,
        jobPath: stopped.jobPath,
        job: stopped.job,
        worker,
        action: 'stopped',
        reply: parsedReply,
        reReview: rereview,
        postCommentImpl,
        alreadyTerminal: stopped.alreadyTerminal,
        now,
        log,
      });

      return {
        action: 'stopped',
        reason: 'rereview-blocked',
        job: stopped.job,
        jobPath: stopped.jobPath,
      };
    }

    const { commentDelivery: completedDelivery } = buildReconcileCommentDelivery({
      job, worker, action: 'completed',
      reply: parsedReply, reReview: rereview, now,
    });
    const completed = markFollowUpJobCompleted({
      rootDir,
      jobPath,
      completedAt,
      remediationWorker: {
        ...workerState,
        state: 'completed',
      },
      completion: completionMetadata,
      remediationReply,
      reReview: rereview,
      commentDelivery: completedDelivery,
    });

    await postReconcileOutcomeCommentSafe({
      rootDir,
      jobPath: completed.jobPath,
      job: completed.job,
      worker,
      action: 'completed',
      reply: parsedReply,
      reReview: rereview,
      postCommentImpl,
      alreadyTerminal: completed.alreadyTerminal,
      now,
      log,
    });

    return {
      action: 'completed',
      reason: 'final-message-artifact-present',
      job: completed.job,
      jobPath: completed.jobPath,
    };
  }

  const dispatchFailureDetail = liveness?.dispatchStatus?.failureDetail || null;
  if (worker?.dispatchMode === 'hq' && classifyHqDispatchFailure(liveness?.dispatchStatus) === 'transient') {
    const nextTransientRetry = Number(job?.remediationPlan?.transientRetries || 0) + 1;
    const maxTransientRetries = resolveMaxTransientRemediationRetries();
    const currentRound = Number(job?.remediationPlan?.currentRound || 0);
    const retryHistory = Array.isArray(job?.remediationPlan?.retryHistory)
      ? job.remediationPlan.retryHistory
      : [];
    const retryRounds = new Set(
      retryHistory
        .map((entry) => Number(entry?.round || 0))
        .filter((round) => Number.isFinite(round) && round > 0)
    );
    if (currentRound > 0) retryRounds.add(currentRound);
    const retryReason = dispatchFailureDetail
      ? `Transient HQ remediation dispatch failure: ${dispatchFailureDetail}`
      : `Transient HQ remediation dispatch failure: ${liveness?.dispatchStatus?.status || 'unknown'}`;
    if (nextTransientRetry > maxTransientRetries) {
      const failureCode = 'hq-dispatch-transient-budget-exhausted';
      const roundContext = currentRound > 0
        ? ` Current round=${currentRound}; budget is job-scoped across ${retryRounds.size || 1} round(s).`
        : ` Budget is job-scoped across ${retryRounds.size || 1} round(s).`;
      const failureMessage = `${retryReason}. Exhausted transient HQ retry budget (${nextTransientRetry - 1}/${maxTransientRetries}).${roundContext}`;
      const { commentDelivery: retryBudgetDelivery } = buildReconcileCommentDelivery({
        job,
        worker,
        action: 'failed',
        failure: { code: failureCode, message: failureMessage },
        now,
      });
      const failed = markFollowUpJobFailed({
        rootDir,
        jobPath,
        failedAt: completedAt,
        failureCode,
        error: new Error(failureMessage),
        remediationWorker: {
          ...workerState,
          state: 'failed',
        },
        failure: {
          code: failureCode,
          message: failureMessage,
          transientRetryBudget: {
            attempted: nextTransientRetry - 1,
            max: maxTransientRetries,
            currentRound,
            roundsObserved: retryRounds.size || 1,
          },
          dispatchStatus: liveness?.dispatchStatus || null,
        },
        commentDelivery: retryBudgetDelivery,
      });
      return {
        action: 'failed',
        reason: failureCode,
        job: failed.job,
        jobPath: failed.jobPath,
      };
    }
    const requeued = requeueInProgressFollowUpJobForRetry({
      rootDir,
      jobPath,
      requeuedAt: completedAt,
      retryReason,
      retryMetadata: {
        code: 'hq-dispatch-transient',
        dispatchStatus: liveness?.dispatchStatus || null,
      },
    });
    log?.log?.(
      `[follow-up-remediation] Requeued ${job.repo}#${job.prNumber} -> hq-dispatch-transient (${retryReason})`
    );
    return {
      action: 'requeued',
      reason: 'hq-dispatch-transient',
      job: requeued.job,
      jobPath: requeued.jobPath,
    };
  }

  // HRR graceful degradation for a quota-exhausted remediation worker. The
  // direct-CLI remediation worker (default path when ADV_WITH_HQ_INTEGRATION is
  // unset) spawns the codex/claude CLI outside the dispatch daemon, so a hard
  // provider usage cap bypasses HRR exactly like the reviewer and surfaces here
  // as an empty/missing artifact — which without this block would post a
  // misleading "remediation worker exited without an artifact / needs human"
  // terminal failure. Instead: detect the cap in the worker's stderr log and
  // requeue the job to pending with retryAfter pinned to the provider reset (or
  // a fixed fallback), so the consume gate holds it until quota returns and a
  // future tick re-spawns the remediation worker. Bounded by the shared
  // transient-retry budget so a persistent cap eventually becomes terminal.
  // Applies to both harnesses we know the shape for (codex / claude).
  const quotaLogText = readWorkerStderrLogSafe(paths.logPath);
  const quotaSignal = detectQuotaExhaustion(quotaLogText);
  if (quotaSignal.isQuotaExhausted) {
    const parsedCompletedAtMs = Date.parse(String(completedAt || ''));
    const completedAtMs = Number.isNaN(parsedCompletedAtMs) ? Date.now() : parsedCompletedAtMs;
    const nextQuotaRetry = Number(job?.remediationPlan?.transientRetries || 0) + 1;
    const maxQuotaRetries = resolveMaxTransientRemediationRetries();
    if (nextQuotaRetry <= maxQuotaRetries) {
      const resetIso = parseQuotaResetAt(quotaLogText, { nowMs: completedAtMs });
      const providerRetryAfterMs = resetIso ? Date.parse(resetIso) : NaN;
      const fallbackRetryAfterMs = completedAtMs + QUOTA_REMEDIATION_BACKOFF_MS;
      const retryAfterMs = Number.isFinite(providerRetryAfterMs)
        ? Math.min(providerRetryAfterMs, completedAtMs + MAX_QUOTA_HOLD_WINDOW_MS)
        : fallbackRetryAfterMs;
      const retryAfter = new Date(retryAfterMs).toISOString();
      const retryReason = `Provider usage cap hit (${quotaSignal.harness} harness); holding remediation until ${retryAfter} (HRR graceful degradation, retry ${nextQuotaRetry}/${maxQuotaRetries}).`;
      const requeued = requeueInProgressFollowUpJobForRetry({
        rootDir,
        jobPath,
        requeuedAt: completedAt,
        retryReason,
        retryAfterOverride: retryAfter,
        allowDirectWorkerRetry: true,
        retryMetadata: {
          code: 'quota-exhausted',
          harness: quotaSignal.harness,
          resetAt: resetIso || null,
          providerResetAt: resetIso || null,
          source: resetIso ? 'provider-reported' : 'fallback-window',
          maxUnvalidatedHoldMs: MAX_QUOTA_HOLD_WINDOW_MS,
        },
      });
      log?.log?.(
        `[follow-up-remediation] Held ${job.repo}#${job.prNumber} -> quota-exhausted ` +
          `(${quotaSignal.harness}) until ${retryAfter} [${resetIso ? 'provider-reported' : 'fallback-window'}]`
      );
      return {
        action: 'requeued',
        reason: 'quota-exhausted',
        job: requeued.job,
        jobPath: requeued.jobPath,
      };
    }
    // Quota retry budget exhausted: fall through to a distinct terminal code so
    // the operator comment names the real cause (a sustained provider cap) and
    // does not read as a worker bug.
    const quotaBudgetFailure = {
      code: 'quota-exhausted-budget-exhausted',
      message: `Remediation worker repeatedly hit a hard provider usage cap (${quotaSignal.harness} harness); exhausted the retry budget (${nextQuotaRetry - 1}/${maxQuotaRetries}). The PR's remediation is paused for operator action (wait for the cap to clear or add credits).`,
    };
    const { commentDelivery: quotaBudgetDelivery } = buildReconcileCommentDelivery({
      job, worker, action: 'failed', failure: quotaBudgetFailure, now,
    });
    const failed = markFollowUpJobFailed({
      rootDir,
      jobPath,
      failedAt: completedAt,
      failureCode: quotaBudgetFailure.code,
      error: new Error(quotaBudgetFailure.message),
      remediationWorker: {
        ...workerState,
        state: 'failed',
      },
      failure: {
        code: quotaBudgetFailure.code,
        message: quotaBudgetFailure.message,
        harness: quotaSignal.harness,
        quotaRetryBudget: { attempted: nextQuotaRetry - 1, max: maxQuotaRetries },
        logPath: worker.logPath || null,
      },
      commentDelivery: quotaBudgetDelivery,
    });
    await postReconcileOutcomeCommentSafe({
      rootDir,
      jobPath: failed.jobPath,
      job: failed.job,
      worker,
      action: 'failed',
      failure: quotaBudgetFailure,
      postCommentImpl,
      alreadyTerminal: failed.alreadyTerminal,
      now,
      log,
    });
    return {
      action: 'failed',
      reason: quotaBudgetFailure.code,
      job: failed.job,
      jobPath: failed.jobPath,
    };
  }

  const failureCode = worker?.dispatchMode === 'hq' && !HQ_SUCCESS_STATUSES.has(String(liveness?.dispatchStatus?.status || ''))
    ? 'hq-dispatch-failed'
    : (finalMessage.exists ? 'artifact-empty-completion' : 'artifact-missing-completion');
  const failureMessage = failureCode === 'hq-dispatch-failed'
    ? dispatchFailureDetail || `HQ remediation dispatch ended with status ${liveness?.dispatchStatus?.status || 'unknown'} before writing a usable remediation reply.`
    : (finalMessage.exists
      ? 'Remediation worker exited without a non-empty final message artifact.'
      : 'Remediation worker exited before writing the final message artifact.');
  const artifactFailure = { code: failureCode, message: failureMessage };
  const { commentDelivery: artifactFailureDelivery } = buildReconcileCommentDelivery({
    job, worker, action: 'failed', failure: artifactFailure, now,
  });
  const failed = markFollowUpJobFailed({
    rootDir,
    jobPath,
    failedAt: completedAt,
    failureCode,
    error: new Error(failureMessage),
    remediationWorker: {
      ...workerState,
      state: 'failed',
    },
    failure: {
      finalMessagePath: worker.outputPath || null,
      finalMessageBytes: finalMessage.bytes,
      logPath: worker.logPath || null,
      dispatchStatus: liveness?.dispatchStatus || null,
    },
    commentDelivery: artifactFailureDelivery,
  });

  await postReconcileOutcomeCommentSafe({
    rootDir,
    jobPath: failed.jobPath,
    job: failed.job,
    worker,
    action: 'failed',
    failure: artifactFailure,
    postCommentImpl,
    alreadyTerminal: failed.alreadyTerminal,
    now,
    log,
  });

  return {
    action: 'failed',
    reason: finalMessage.exists ? 'empty-final-message-artifact' : 'missing-final-message-artifact',
    job: failed.job,
    jobPath: failed.jobPath,
  };
}

async function reconcileInProgressFollowUpJobs({
  rootDir = ROOT,
  now = () => new Date().toISOString(),
  isWorkerRunning = isWorkerProcessRunning,
  postCommentImpl = postRemediationOutcomeComment,
  requestReviewRereviewImpl = requestReviewRereview,
  requestWatcherWakeImpl = requestWatcherWake,
  resolvePRLifecycleImpl = resolvePRLifecycle,
  execFileImpl = execFileAsync,
  log = console,
} = {}) {
  // CFG-09: per-reconcile-pass boundary for the role-config cascade
  // cache. Symmetric with `consumeNextFollowUpJob`'s reset above —
  // `resolveReconcileWorkerClass` calls `pickRemediationWorkerClass`,
  // which goes through `loadRoleConfig`. Today's callers are one-shot
  // CLI entrypoints (cache is empty per process), so the contract held
  // by accident; this reset makes it robust against a future long-
  // running tick loop that folds reconciliation in.
  resetRoleConfigCache();
  const cleanup = cleanupReconcileClaimArtifacts({ rootDir, log });
  if (cleanup.removedTmp || cleanup.removedLocks || cleanup.errors) {
    log.log?.(
      `[follow-up-remediation] reconcile claim cleanup scanned=${cleanup.scanned} ` +
      `removedTmp=${cleanup.removedTmp} removedLocks=${cleanup.removedLocks} errors=${cleanup.errors}`
    );
  }
  const jobs = listInProgressFollowUpJobs(rootDir);
  // Sequential, not Promise.all: each comment post is a network call to
  // GitHub, and if many jobs land on the same PR we'd rather queue a
  // tidy serialized comment stream than risk concurrent posts arriving
  // out-of-order. The volume here is tiny (one tick = a handful of
  // jobs at most), so serial is the right tradeoff.
  const results = [];
  for (const { job, jobPath } of jobs) {
    const claim = tryAcquireFollowUpReconcileClaim({ jobPath, now });
    if (!claim.acquired) {
      results.push({
        action: 'skipped',
        reason: 'reconcile-claim-held',
        job,
        jobPath,
      });
      continue;
    }
    try {
      if (!existsSync(jobPath)) {
        results.push({
          action: 'skipped',
          reason: 'follow-up-job-moved',
          job,
          jobPath,
        });
        continue;
      }
      let currentJob;
      try {
        currentJob = readFollowUpJob(jobPath);
      } catch (err) {
        const missing = err?.code === 'ENOENT';
        log.warn?.(
          `[follow-up-remediation] skipped unreadable in-progress job ${jobPath}: ${err?.message || err}`
        );
        results.push({
          action: 'skipped',
          reason: missing ? 'follow-up-job-moved' : 'follow-up-job-read-failed',
          job,
          jobPath,
        });
        continue;
      }
      const result = await reconcileFollowUpJob({
        rootDir,
        job: currentJob,
        jobPath,
        now,
        isWorkerRunning,
        postCommentImpl,
        requestReviewRereviewImpl,
        requestWatcherWakeImpl,
        resolvePRLifecycleImpl,
        execFileImpl,
        log,
      });
      results.push(result);
    } finally {
      releaseFollowUpReconcileClaim(claim);
    }
  }

  return {
    scanned: jobs.length,
    active: results.filter((result) => result.action === 'active').length,
    completed: results.filter((result) => result.action === 'completed').length,
    failed: results.filter((result) => result.action === 'failed').length,
    requeued: results.filter((result) => result.action === 'requeued').length,
    stopped: results.filter((result) => result.action === 'stopped').length,
    skipped: results.filter((result) => result.action === 'skipped').length,
    results,
  };
}

function findInProgressFollowUpJobByLaunchRequestId(rootDir, launchRequestId) {
  const lrq = String(launchRequestId || '').trim();
  if (!lrq) return null;
  for (const entry of listInProgressFollowUpJobs(rootDir)) {
    const workerLrq = String(entry.job?.remediationWorker?.launchRequestId || '').trim();
    if (workerLrq === lrq) return entry;
  }
  return null;
}

async function handleRemediationTelemetryEvent({
  rootDir = ROOT,
  topic,
  event,
  now = () => new Date().toISOString(),
  isWorkerRunning = isWorkerProcessRunning,
  postCommentImpl = postRemediationOutcomeComment,
  requestReviewRereviewImpl = requestReviewRereview,
  requestWatcherWakeImpl = requestWatcherWake,
  resolvePRLifecycleImpl = resolvePRLifecycle,
  auditWorkspaceForContaminationImpl = auditWorkspaceForContamination,
  execFileImpl = execFileAsync,
  log = console,
} = {}) {
  const terminalEvent = normalizeWorkerTerminalEvent(topic, event);
  if (!terminalEvent) {
    return { action: 'ignored', reason: 'unsupported-topic-event' };
  }
  const found = findInProgressFollowUpJobByLaunchRequestId(rootDir, terminalEvent.lrq);
  if (!found) {
    return { action: 'ignored', reason: 'launch-request-not-in-progress', lrq: terminalEvent.lrq };
  }
  const claim = tryAcquireFollowUpReconcileClaim({ jobPath: found.jobPath, now });
  if (!claim.acquired) {
    return {
      action: 'skipped',
      reason: 'reconcile-claim-held',
      lrq: terminalEvent.lrq,
      job: found.job,
      jobPath: found.jobPath,
    };
  }
  try {
    if (!existsSync(found.jobPath)) {
      return { action: 'ignored', reason: 'launch-request-not-in-progress', lrq: terminalEvent.lrq };
    }
    let currentJob;
    try {
      currentJob = readFollowUpJob(found.jobPath);
    } catch (err) {
      const missing = err?.code === 'ENOENT';
      log.warn?.(
        `[follow-up-remediation] skipped telemetry reconcile for unreadable job ${found.jobPath}: ${err?.message || err}`
      );
      return {
        action: 'ignored',
        reason: missing ? 'launch-request-not-in-progress' : 'follow-up-job-read-failed',
        lrq: terminalEvent.lrq,
        jobPath: found.jobPath,
      };
    }
    if (!workerTerminalEventMatches(currentJob?.remediationWorker, terminalEvent)) {
      return { action: 'ignored', reason: 'launch-request-not-current-worker', lrq: terminalEvent.lrq };
    }
    // Topic-driven reconcile uses the same per-job claim as the periodic
    // scanner, so side effects inside reconcileFollowUpJob remain single-writer.
    return reconcileFollowUpJob({
      rootDir,
      job: currentJob,
      jobPath: found.jobPath,
      now,
      isWorkerRunning,
      postCommentImpl,
      requestReviewRereviewImpl,
      requestWatcherWakeImpl,
      resolvePRLifecycleImpl,
      auditWorkspaceForContaminationImpl,
      execFileImpl,
      workerTerminalEvent: terminalEvent,
      log,
    });
  } finally {
    releaseFollowUpReconcileClaim(claim);
  }
}

async function connectFollowUpTelemetryListener({
  rootDir = ROOT,
  env = process.env,
  hqRoot = env.HQ_ROOT,
  connectAppContractImpl = null,
  log = console,
  ...listenerOptions
} = {}) {
  const subscribes = resolveAdversarialReviewAppSubscribes(env);
  const topics = resolveFollowUpTelemetryTopics(subscribes);
  if (topics.length === 0) {
    return { session: null, subscriptions: [], dispose: () => {} };
  }
  const mode = resolveAdversarialReviewAppMode(env);
  const connectImpl = connectAppContractImpl || await loadAppSdkConnect();
  const session = await withAppContractTransientRetry(() => connectImpl({
    app_id: 'adversarial-review',
    mode,
    hqRoot,
    subscribes,
  }));
  const listener = attachFollowUpTelemetryListeners({
    session,
    rootDir,
    subscribes: topics,
    // ARC-19: attachFollowUpTelemetryListeners is a leaf module and cannot
    // reference the monolith's handler; inject it here from the composition root.
    handleTelemetryEventImpl: handleRemediationTelemetryEvent,
    log,
    ...listenerOptions,
  });
  const topicList = listener.subscriptions.join(',');
  if (mode === 'agent-os') {
    log.log?.(
      `[follow-up-remediation] App Contract telemetry listener registered for ${topicList}; ` +
      'inbound topic delivery transport is pending, so periodic reconcile remains authoritative'
    );
  } else {
    log.log?.(`[follow-up-remediation] App Contract telemetry listener subscribed to ${topicList}`);
  }
  return listener;
}

async function consumeNextFollowUpJob({
  rootDir = ROOT,
  execFileImpl = execFileAsync,
  spawnImpl,
  now = () => new Date().toISOString(),
  promptTemplate = loadFollowUpPromptTemplate(rootDir),
  resolvePRLifecycleImpl = resolvePRLifecycle,
  postCommentImpl = postRemediationOutcomeComment,
  excludedRepoPrKeys = new Set(),
  onExcludedRepoPrKey = null,
  delayedPendingPaths = null,
  onDelayedPendingJob = null,
  quotaHoldRevalidator = null,
  resolveRemediationWorkerClassImpl = null,
  deliverAlertImpl = deliverAlert,
  healthRouter = null,
  log = console,
} = {}) {
  // CFG-09: per-job boundary for the role-config cascade cache. Match
  // the watcher's per-tick reset so an env rotation between claims
  // propagates to `pickRemediationWorkerClass`; without this, a stale
  // cached config from a prior `loadRoleConfig` call (in this process
  // or via the role resolvers below) would mask the new env.
  resetRoleConfigCache();
  // Claim first so we know which worker class we're running. This lets
  // an `[claude-code]` PR (reviewerModel=codex) get its OAuth pre-flight
  // pointed at Claude Code's CLI rather than incorrectly blocking on
  // codex auth state — and vice versa.
  const claimed = claimNextFollowUpJob({
    rootDir,
    claimedAt: now(),
    returnStopped: true,
    excludedRepoPrKeys,
    onExcludedRepoPrKey,
    delayedPendingPaths,
    onDelayedPendingJob,
    quotaHoldRevalidator,
  });

  if (!claimed) {
    return { consumed: false, reason: 'no-pending-jobs' };
  }
  if (claimed.stopped) {
    if (claimed.reason === 'max-rounds-reached') {
      const persistedCap = Number(claimed.job?.remediationPlan?.maxRounds);
      logRoundBudgetDecision(log, {
        repo: claimed.job?.repo || null,
        prNumber: Number.isFinite(Number(claimed.job?.prNumber)) ? Number(claimed.job.prNumber) : null,
        riskClass: claimed.job?.riskClass || null,
        runsCompleted: Number(claimed.job?.remediationPlan?.currentRound || 0),
        cap: Number.isFinite(persistedCap) ? persistedCap : null,
        decision: 'deny',
      });
    }
    return {
      consumed: false,
      reason: claimed.reason || 'max-rounds-reached',
      job: claimed.job,
      jobPath: claimed.jobPath,
    };
  }

  // Lifecycle gate: stop the bounded loop on any non-open PR state. If
  // the operator already merged or closed the PR there's nothing for
  // the remediation worker to do — the branch may be gone, the review
  // verdict no longer matters, and the watcher row will never accept a
  // rereview reset (`requestReviewRereview` refuses pr_state != 'open').
  // Spawning a worker would cost an OAuth pre-flight, a 1-2 minute
  // worker run, and a misleading PR comment on the closed PR. Stop the
  // job cleanly with an explicit code so operators reading stopped/
  // can see what happened. resolvePRLifecycleImpl prefers a live `gh
  // pr view` lookup over the SQLite mirror so this gate closes the
  // race where the watcher's syncPRLifecycle poll lags GitHub.
  //
  // Errors / missing data from both live + mirror fall through to the
  // existing path — the gate is a positive opt-in, not default-deny;
  // we'd rather spawn a worker that quickly notices the dead branch
  // than silently halt the queue when the lifecycle source is down.
  const lifecycle = await resolveJobPRLifecycleSafe({
    rootDir,
    job: claimed.job,
    resolvePRLifecycleImpl,
    execFileImpl,
    log,
  });
  const lifecycleStop = lifecycleStopDecision(lifecycle, {
    repo: claimed.job.repo,
    prNumber: claimed.job.prNumber,
    site: 'consume',
    job: claimed.job,
  });
  if (lifecycleStop) {
    if (lifecycleStop.logMessage) {
      log.log?.(lifecycleStop.logMessage);
    }
    const stoppedAt = now();
    let stopped;
    if (lifecycleStop.stopCode === 'stale-drift' || lifecycleStop.stopCode === 'stale-review-head') {
      stopped = await markFollowUpJobStopped({
        rootDir,
        jobPath: claimed.jobPath,
        stoppedAt,
        stopCode: lifecycleStop.stopCode,
        stopReason: lifecycleStop.stopReason,
        sourceStatus: 'in_progress',
        remediationWorker: {
          state: 'never-spawned',
          reconciledAt: stoppedAt,
        },
      });
    } else {
      stopped = await stopConsumedJobWithComment({
        rootDir,
        job: claimed.job,
        jobPath: claimed.jobPath,
        stoppedAt,
        stopCode: lifecycleStop.stopCode,
        stopReason: lifecycleStop.stopReason,
        sourceStatus: 'in_progress',
        remediationWorker: {
          state: 'never-spawned',
          reconciledAt: stoppedAt,
        },
        postCommentImpl,
        now,
        log,
      });
    }
    return {
      consumed: false,
      reason: lifecycleStop.actionReason,
      job: stopped.job,
      jobPath: stopped.jobPath,
    };
  }

  // Track whether spawn was actually attempted. If the catch below
  // fires before this flips to true, we mark the failed record as
  // never-spawned so the PR-wide ledger does not count this round —
  // an OAuth/workspace-prep failure burned no remediation budget.
  let workerClass = null;
  let spawnAttempted = false;
  let spawnedWorker = null;
  let workflowPushPreflight = null;
  const jobEnv = { ...process.env };

  try {
    const routedWorkerClass = pickRemediationWorkerClass(claimed.job);
    workerClass = routedWorkerClass;
    // Cap-aware fallback -- wired only from the production daemon (null in unit
    // tests, so the heavily-spied consume hot path stays subprocess-free there).
    // When the routed remediator harness provider is authoritatively quota-
    // grounded (e.g. a [claude-code] PR routes to codex but codex is exhausted),
    // fall back to claude-code instead of quota-holding the PR un-remediated.
    // Auto-reverts to the routed harness the moment its provider recovers.
    if (resolveRemediationWorkerClassImpl) {
      const workerClassFallback = await resolveRemediationWorkerClassImpl({
        primary: routedWorkerClass,
        fallbackWorkerClasses: remediationWorkerClassFallback(jobEnv),
        env: jobEnv,
      });
      workerClass = workerClassFallback.workerClass;
      if (workerClassFallback.fellBack) {
        log.warn?.(
          `[follow-up-remediation] remediation-worker-class cap-fallback: ` +
            `routed=${routedWorkerClass} -> ${workerClass} ` +
            `(primary provider grounded: ${workerClassFallback.primaryState}); ` +
            `auto-reverts when the routed harness recovers`
        );
      }
    }
    const remediationMode = resolveRemediationRuntimeMode(claimed.job, {
      healthRouter,
      env: jobEnv,
      // Pin os-mode for a claude-code remediator (may have been resolved by the
      // cap-fallback above): the claude CLI only authenticates on the hq-dispatch
      // broker path.
      workerClass,
    });
    const remediationDispatchPath = remediationMode === 'os' ? 'hq' : 'bare';
    claimed.job = persistRemediationDispatchPath({
      job: claimed.job,
      jobPath: claimed.jobPath,
      dispatchPath: remediationDispatchPath,
    });
    const hqDispatchEnabled = remediationMode === 'os';
    const branchReadyJob = await ensureJobBranchMetadata({
      job: claimed.job,
      jobPath: claimed.jobPath,
      requireBranch: hqDispatchEnabled,
      execFileImpl,
    });
    claimed.job = branchReadyJob.job;

    // Round-budget check first (cheap, short-circuits before any
    // OAuth/work). The pr-merge-orchestration spec's risk-tiered
    // budget enforces "stop the remediation loop when the PR has
    // exhausted its riskClass-derived rounds" at the substrate, not
    // in worker prompts. Resolves the budget from the job's linked
    // spec/plan; persists the riskClass back onto the job so the
    // next round agrees on the same tier.
    const roundBudgetResolution = resolveRoundBudgetForJob(claimed.job, { rootDir });
    if (claimed.job?.riskClass !== roundBudgetResolution.riskClass) {
      claimed.job = {
        ...claimed.job,
        riskClass: roundBudgetResolution.riskClass,
      };
      writeFollowUpJob(claimed.jobPath, claimed.job);
    }

    const currentRound = Number(claimed.job?.remediationPlan?.currentRound || 0);
    if (currentRound > roundBudgetResolution.roundBudget) {
      logRoundBudgetDecision(log, {
        repo: claimed.job?.repo || null,
        prNumber: Number.isFinite(Number(claimed.job?.prNumber)) ? Number(claimed.job.prNumber) : null,
        riskClass: roundBudgetResolution.riskClass,
        runsCompleted: currentRound,
        cap: roundBudgetResolution.roundBudget,
        decision: 'deny',
      });
      const stoppedAt = now();
      const stopped = await stopConsumedJobWithComment({
        rootDir,
        job: claimed.job,
        jobPath: claimed.jobPath,
        stoppedAt,
        stopCode: 'round-budget-exhausted',
        sourceStatus: claimed.job.status,
        stopReason: `Remediation round ${currentRound} exceeds the ${roundBudgetResolution.riskClass} risk-class budget (${roundBudgetResolution.roundBudget}); refusing to spawn another remediation worker.`,
        remediationWorker: {
          state: 'never-spawned',
          reconciledAt: stoppedAt,
        },
        postCommentImpl,
        now,
        log,
      });

      return {
        consumed: false,
        reason: 'round-budget-exhausted',
        job: stopped.job,
        jobPath: stopped.jobPath,
      };
    }

    workflowPushPreflight = await assertWorkflowPushCapabilityForJob({
      job: claimed.job,
      execFileImpl,
      env: jobEnv,
      deliverAlertImpl,
      log,
    });

    // OAuth pre-flight runs inside the try so an expired/missing OAuth
    // session moves the already-claimed job to `failed/` via the catch
    // below, rather than exiting with a still-`in_progress` ledger row.
    // Gemini HQ dispatch is broker-backed: the worker-pool adapter seeds
    // OAuth at dispatch time, so the local ~/.gemini gate applies only to
    // the direct CLI path.
    if (!(hqDispatchEnabled && workerClass === 'gemini')) {
      await assertRemediationWorkerOAuth(workerClass, { execFileImpl });
    }
    const shouldApplyOssReadinessBeforeSpawn = jobHasOssReadinessAuditFailure(claimed.job);
    const workspaceRootDir = resolveRemediationWorkspaceRoot({ rootDir, env: jobEnv });
    const artifactWorkspaceDir = join(workspaceRootDir, claimed.job.jobId);
    let workspaceDir = artifactWorkspaceDir;
    let workspaceState = {
      action: hqDispatchEnabled ? 'hq-dispatch' : 'reused',
      reason: hqDispatchEnabled ? 'worker-pool-managed' : 'missing',
    };
    if (!hqDispatchEnabled || shouldApplyOssReadinessBeforeSpawn) {
      const prepared = await prepareWorkspaceForJob({
        rootDir,
        job: claimed.job,
        execFileImpl,
      });
      workspaceDir = prepared.workspaceDir;
      workspaceState = hqDispatchEnabled
        ? { action: 'hq-dispatch-prepared', reason: 'oss-readiness-preflight', prepared: prepared.workspaceState }
        : prepared.workspaceState;
      await ensureWorkspaceArtifactExclude(workspaceDir, { execFileImpl });
    }

    const artifactDir = join(workspaceDir, '.adversarial-follow-up');
    resetWorkspaceDir(artifactDir);
    mkdirSync(artifactDir, { recursive: true });
    let ossReadinessApply = { attempted: false, reason: 'no-oss-readiness-audit-failure' };
    const ossReadinessApplyEvidencePath = join(artifactDir, 'oss-readiness-apply.json');
    const writeOssReadinessApplyEvidence = () => {
      if (!ossReadinessApply.attempted) return;
      writeFileSync(
        ossReadinessApplyEvidencePath,
        `${JSON.stringify(ossReadinessApply, null, 2)}\n`,
        'utf8'
      );
    };
    if (!hqDispatchEnabled || shouldApplyOssReadinessBeforeSpawn) {
      ossReadinessApply = await applyOssReadinessRemediation({
        rootDir,
        job: claimed.job,
        workspaceDir,
        workerTrailerClass: remediationWorkerTrailerClass(workerClass),
        env: jobEnv,
        execFileImpl,
        now,
      });
      writeOssReadinessApplyEvidence();
      if (hqDispatchEnabled && ossReadinessApply.commitSha) {
        try {
          const push = await pushOssReadinessRemediationCommit({
            workspaceDir,
            branch: claimed.job.branch,
            env: jobEnv,
            execFileImpl,
          });
          ossReadinessApply.push = push;
          writeOssReadinessApplyEvidence();
        } catch (err) {
          const rollback = await rollbackOssReadinessLocalCommit({
            workspaceDir,
            commitSha: ossReadinessApply.commitSha,
            execFileImpl,
          });
          ossReadinessApply = {
            ...ossReadinessApply,
            ok: false,
            push: {
              ok: false,
              error: err?.message || String(err),
            },
            pushRollback: rollback,
            needsOperatorApproval: false,
          };
          writeOssReadinessApplyEvidence();
          err.code = 'oss-readiness-push-failed';
          err.isOssReadinessApplyError = true;
          err.ossReadinessApply = ossReadinessApply;
          throw err;
        }
      }
    }
    const replyTarget = resolveRemediationReplyTarget(jobEnv, { requireExists: true });
    const hqRoot = replyTarget.mode === 'hq' ? replyTarget.root : null;
    const replyStorageKey = resolveReplyStorageKey(claimed.job);
    if (claimed.job.replyStorageKey !== replyStorageKey) {
      claimed.job = {
        ...claimed.job,
        replyStorageKey,
      };
      writeFollowUpJob(claimed.jobPath, claimed.job);
    }
    const { replyDir, replyPath } = replyTarget.resolvePath({
      launchRequestId: replyStorageKey,
    });
    mkdirSync(replyDir, { recursive: true });

    const promptPath = join(artifactDir, 'prompt.md');
    // Output / log filenames are kept generic across worker classes so
    // operator runbooks and the reconcile path don't need per-class
    // branches. The "codex-" prefix is historical; what matters is
    // these are the per-job artifact filenames the prompt and the
    // reconciler agree on.
    const outputPath = join(artifactDir, 'codex-last-message.md');
    const logPath = join(artifactDir, 'codex-worker.log');
    const governingDocContext = collectWorkspaceDocContext(workspaceDir);
    const prompt = buildRemediationPrompt(claimed.job, {
      template: promptTemplate,
      remediationReplyPath: replyPath,
      hqRoot,
      launchRequestId: replyStorageKey,
      governingDocContext,
      // In hq-dispatch mode the worker-pool spawns the worker, so the prompt
      // (not our spawn env) carries the provenance trailer the commit-msg hook
      // stamps. Thread the resolved class through so a gemini / claude-code
      // remediation is attributed correctly instead of defaulting to codex.
      workerTrailerClass: remediationWorkerTrailerClass(workerClass),
    });
    writeFileSync(promptPath, `${prompt}\n`, 'utf8');

    // LAC-957: rerun the canonical consume-time lifecycle gate just
    // before spawn. The first gate ran before OAuth pre-flight +
    // workspace prep (~10-20s), which leaves a race for merged/closed
    // PRs, stale-drift labels, or stale-review-head changes to appear
    // after claim but before spawn.
    const prTerminalCheck = await applyPreSpawnLifecycleGate({
      rootDir,
      job: claimed.job,
      jobPath: claimed.jobPath,
      workspaceDir,
      promptPath,
      baseBranch: claimed.job.baseBranch,
      resolvePRLifecycleImpl,
      execFileImpl,
      stopConsumedJobWithCommentImpl: stopConsumedJobWithComment,
      postCommentImpl,
      now,
      log,
    });
    if (prTerminalCheck.action !== 'continue') {
      return {
        consumed: false,
        reason: prTerminalCheck.reason,
        job: prTerminalCheck.job,
        jobPath: prTerminalCheck.jobPath,
      };
    }
    if (prTerminalCheck.job) {
      claimed.job = prTerminalCheck.job;
    }

    // ARC-08: one AgentRuntime port call, routed by the health router. The
    // runtime's `os` mode performs the app-contract / hq dispatch and `local`
    // mode the model-specific CLI self-spawn; both return the same worker
    // descriptor shape the reconcile pass reads. Workspace prep stayed with the
    // subject adapter above (`prepareWorkspaceForJob`) — the runtime never
    // touches git mechanics.
    const remediationRuntime = createRemediationRuntime({
      execFileImpl,
      spawnImpl,
      env: jobEnv,
      now,
    });
    const runHandle = await remediationRuntime.run({
      mode: remediationMode,
      role: { kind: 'remediator', workerClass },
      idempotencyKey: replyStorageKey,
      repo: claimed.job.repo,
      prNumber: claimed.job.prNumber,
      branch: claimed.job.branch || null,
      workspaceDir,
      promptPath,
      outputPath,
      logPath,
      replyPath,
      hqRoot,
      launchRequestId: replyStorageKey,
      jobId: claimed.job.jobId,
      requiresWorkflowPush: Boolean(workflowPushPreflight?.workflowTouch?.touches),
    });
    const worker = runHandle.worker;
    spawnedWorker = worker;

    const updated = markFollowUpJobSpawned({
      rootDir,
      jobPath: claimed.jobPath,
      spawnedAt: now(),
      worker: {
        ...worker,
        dirtyMergeResolution: claimed.job?.remediationWorker?.dirtyMergeResolution || null,
        pushTokenCapability: workflowPushPreflight?.capability
          ? {
              source: workflowPushPreflight.capability.source,
              envName: workflowPushPreflight.capability.envName,
              identity: workflowPushPreflight.capability.identity,
              tokenType: workflowPushPreflight.capability.tokenType,
              detection: workflowPushPreflight.capability.detection,
              hasWorkflowCapability: workflowPushPreflight.capability.hasWorkflowCapability,
              workflowTouch: workflowPushPreflight.workflowTouch
                ? {
                    touches: workflowPushPreflight.workflowTouch.touches,
                    source: workflowPushPreflight.workflowTouch.source,
                    paths: workflowPushPreflight.workflowTouch.paths || [],
                  }
                : null,
            }
          : null,
        workspaceState,
        workspaceRoot: worker.workspaceDir ? serializeWorkerPath(rootDir, dirname(worker.workspaceDir)) : (hqDispatchEnabled ? null : serializeWorkerPath(rootDir, workspaceRootDir)),
        workspaceDir: worker.workspaceDir ? serializeWorkerPath(rootDir, worker.workspaceDir) : (hqDispatchEnabled ? null : serializeWorkerPath(rootDir, workspaceDir)),
        promptPath: serializeWorkerPath(rootDir, worker.promptPath),
        outputPath: worker.outputPath ? serializeWorkerPath(rootDir, worker.outputPath) : null,
        logPath: worker.logPath ? serializeWorkerPath(rootDir, worker.logPath) : null,
        replyPath,
        ossReadinessApply: ossReadinessApply.attempted
          ? {
              ok: ossReadinessApply.ok,
              scriptPath: ossReadinessApply.scriptPath,
              startedAt: ossReadinessApply.startedAt,
              finishedAt: ossReadinessApply.finishedAt,
              changedFiles: ossReadinessApply.changedFiles || [],
              commitSha: ossReadinessApply.commitSha || null,
              evidencePath: serializeWorkerPath(rootDir, join(artifactDir, 'oss-readiness-apply.json')),
            }
          : null,
      },
    });
    spawnAttempted = true;

    return {
      consumed: true,
      job: updated.job,
      jobPath: updated.jobPath,
    };
  } catch (err) {
    if (err.isWorkflowPushPreflightTransientError) {
      const requeuedAt = now();
      const requeuedAtMs = Date.parse(requeuedAt);
      const retryAfter = new Date((Number.isFinite(requeuedAtMs) ? requeuedAtMs : Date.now()) + 60_000).toISOString();
      const requeued = requeueInProgressFollowUpJobForRetry({
        rootDir,
        jobPath: claimed.jobPath,
        requeuedAt,
        retryReason: err.message,
        retryMetadata: {
          code: err.code || 'workflow-push-preflight-transient',
          recoverable: true,
        },
        allowDirectWorkerRetry: true,
        retryAfterOverride: retryAfter,
      });
      requeued.job.lastWorkflowPushPreflightFailure = {
        code: err.code || 'workflow-push-preflight-transient',
        message: err.message,
        recoverable: true,
        recordedAt: requeuedAt,
      };
      writeFollowUpJob(requeued.jobPath, requeued.job);
      log.warn?.(
        `[follow-up-remediation] workflow-push preflight transient for ${claimed.job?.repo}#${claimed.job?.prNumber}; ` +
        `requeued pending job: ${err.message}`
      );
      return {
        consumed: false,
        reason: err.code || 'workflow-push-preflight-transient',
        job: requeued.job,
        jobPath: requeued.jobPath,
      };
    }

    if (err.isRemediationConfigError) {
      const requeued = requeueClaimedFollowUpJobAfterConfigFailure({
        rootDir,
        jobPath: claimed.jobPath,
        error: err,
        requeuedAt: now(),
      });
      err.followUpJobId = claimed.job?.jobId || null;
      err.followUpJobPath = requeued.jobPath;
      err.followUpJobRequeued = true;
      throw err;
    }

    let failure = {};
    let failureCode = 'worker-failure';

    if (err.isOAuthError) {
      failureCode = 'oauth-preflight-failure';
      failure = {
        oauthError: {
          model: err.model || workerClass,
          reason: err.message,
        },
      };
    } else if (err.isWorkflowPushCapabilityError) {
      failureCode = 'workflow-push-capability-missing';
      failure = {
        needsOperator: true,
        workflowPushCapability: {
          reason: err.message,
          operatorAction: err.operatorAction,
          workflowTouch: err.workflowTouch || null,
          pushToken: err.capability
            ? {
                source: err.capability.source,
                envName: err.capability.envName,
                identity: err.capability.identity,
                tokenType: err.capability.tokenType,
                detection: err.capability.detection,
                hasWorkflowCapability: err.capability.hasWorkflowCapability,
                scopes: err.capability.scopes || [],
                permissions: err.capability.permissions || null,
              }
            : null,
        },
      };
    } else if (err.isBaseBranchResolutionError) {
      failureCode = 'base-branch-resolution-failed';
      failure = {
        baseBranchResolution: {
          repo: claimed.job?.repo || null,
          prNumber: claimed.job?.prNumber || null,
          reason: err.message,
        },
      };
    } else if (err.isOssReadinessApplyError) {
      failureCode = err.code || 'oss-readiness-apply-failed';
      failure = {
        needsOperator: Boolean(err.ossReadinessApply?.needsOperatorApproval),
        ossReadinessApply: err.ossReadinessApply || {
          attempted: true,
          ok: false,
          error: err.message,
        },
      };
    } else if (err.isPolicyViolation) {
      failureCode = 'startup-contract-violation';
      failure = {
        policyViolation: {
          type: err.violationType,
          requestedValue: err.requestedValue,
          resolvedValue: err.resolvedValue,
        },
        startupEvidence: err.startupEvidence || null,
      };
    }

    let remediationWorker;
    if (spawnAttempted) {
      remediationWorker = undefined;
    } else if (spawnedWorker) {
      const cleanupAt = now();
      remediationWorker = {
        ...spawnedWorker,
        // The worker was killed before we durably recorded a spawned
        // round, so this path must stay budget-neutral in the PR-wide
        // remediation ledger.
        state: 'never-spawned',
        cleanupAttemptedAt: cleanupAt,
        cleanupSignal: 'SIGKILL',
        cleanupResult: killDetachedWorkerProcessGroup(spawnedWorker.processId) ? 'killed' : 'not-found',
      };
    } else {
      // If we never made it to the spawn call, this round burned no
      // remediation budget — tag the failed record with `never-spawned`
      // so summarizePRRemediationLedger excludes it from the PR-wide
      // count.
      remediationWorker = { state: 'never-spawned', reconciledAt: now() };
    }

    const failed = markFollowUpJobFailed({
      rootDir,
      jobPath: claimed.jobPath,
      error: err,
      failedAt: now(),
      failureCode,
      failure,
      remediationWorker,
    });
    err.followUpJobId = claimed.job?.jobId || null;
    err.followUpJobPath = failed.jobPath;
    throw err;
  }
}

async function consumeFollowUpJobsUntilCapacity({
  rootDir = ROOT,
  maxConcurrent = resolveRemediationMaxConcurrentJobs(),
  execFileImpl = execFileAsync,
  spawnImpl,
  now = () => new Date().toISOString(),
  promptTemplate = loadFollowUpPromptTemplate(rootDir),
  resolvePRLifecycleImpl = resolvePRLifecycle,
  postCommentImpl = postRemediationOutcomeComment,
  shouldStop = () => false,
  quotaHoldRevalidator = defaultQuotaHoldRevalidator,
  resolveRemediationWorkerClassImpl = null,
  deliverAlertImpl = deliverAlert,
  healthRouter = null,
  log = console,
} = {}) {
  const concurrencyCap = normalizeMaxConcurrentFollowUpJobs(maxConcurrent);
  const { activeJobs, blockedRepoPrKeys } = buildFollowUpClaimReservations({ rootDir, now: now(), log });
  const results = [];
  let spawned = 0;
  let stopped = 0;
  const deferredSamePRPaths = new Set();
  const delayedPendingPaths = new Set();
  const pendingCountsAtStart = countPendingFollowUpJobsByRetryWindow(rootDir, now());
  if (typeof quotaHoldRevalidator?.prefetch === 'function') {
    const prefetchNow = now();
    await quotaHoldRevalidator.prefetch({
      rootDir,
      now: prefetchNow,
      nowMs: Date.parse(prefetchNow),
    });
  }

  while (!shouldStop() && (activeJobs.length + spawned) < concurrencyCap) {
    let result;
    try {
      result = await consumeNextFollowUpJob({
        rootDir,
        execFileImpl,
        spawnImpl,
        now,
        promptTemplate,
        resolvePRLifecycleImpl,
        postCommentImpl,
        healthRouter,
        excludedRepoPrKeys: blockedRepoPrKeys,
        onExcludedRepoPrKey: (pendingPath) => {
          deferredSamePRPaths.add(String(pendingPath));
        },
        delayedPendingPaths,
        onDelayedPendingJob: () => {
        },
        quotaHoldRevalidator,
        resolveRemediationWorkerClassImpl,
        deliverAlertImpl,
        log,
      });
    } catch (err) {
      if (!err?.followUpJobPath) {
        throw err;
      }
      try {
        const failedJob = JSON.parse(readFileSync(err.followUpJobPath, 'utf8'));
        blockedRepoPrKeys.add(followUpJobRepoPrKey(failedJob));
      } catch {
        // Best-effort: keep draining even if the failed record can't be re-read.
      }
      const jobIdTag = err.followUpJobId ? ` jobId=${err.followUpJobId}` : '';
      const jobPathTag = err.followUpJobPath ? ` jobPath=${err.followUpJobPath}` : '';
      const detail = err?.message || String(err);
      log.warn?.(
        `[follow-up-remediation] continuing drain after failed spawn preparation${jobIdTag}${jobPathTag}: ${detail}`
      );
      continue;
    }
    results.push(result);

    if (result.consumed) {
      spawned += 1;
      blockedRepoPrKeys.add(followUpJobRepoPrKey(result.job));
      continue;
    }

    if (result.reason === 'no-pending-jobs') {
      break;
    }

    if (result.job) {
      stopped += 1;
      continue;
    }

    break;
  }

  return {
    maxConcurrent: concurrencyCap,
    activeAtStart: activeJobs.length,
    availableAtStart: Math.max(0, concurrencyCap - activeJobs.length),
    spawned,
    stopped,
    deferredSamePR: deferredSamePRPaths.size,
    capacityRemaining: Math.max(0, concurrencyCap - activeJobs.length - spawned),
    pendingRetryDelayed: pendingCountsAtStart.delayed,
    pendingClaimable: pendingCountsAtStart.claimable,
    results,
  };
}

// Stamp a comment-delivery record onto a consume-time terminal job
// before publishing the public PR comment. Mirrors the reconcile-side
// flow (`buildReconcileCommentDelivery` → `markFollowUpJob*` →
// `recordInitialCommentDelivery`) so consume-time stops land in
// stopped/ with a `commentDelivery` field and a retry-index pointer.
// Without this stamp, the retry-index sentinel (`.initialized`) makes
// the post-init retry walker scan only the index — consume-side
// stopped records that bypass the initial post would be invisible to
// the retry path forever, breaking the contract that every terminal
// transition is operator-visible on the PR.
async function stopConsumedJobWithComment({
  rootDir,
  job,
  jobPath,
  stoppedAt,
  stopCode,
  stopReason,
  sourceStatus,
  remediationWorker,
  postCommentImpl,
  now,
  log,
}) {
  // Build the comment body and an owed-delivery stub from the same
  // shape reconcile uses, so the terminal record lands with
  // commentDelivery already present (closes the crash window between
  // the atomic terminal move and any post-move stamping).
  const { commentDelivery: owedDelivery } = buildReconcileCommentDelivery({
    job,
    worker: remediationWorker,
    action: 'stopped',
    now,
  });

  const stopped = markFollowUpJobStopped({
    rootDir,
    jobPath,
    stoppedAt,
    stopCode,
    stopReason,
    sourceStatus,
    remediationWorker,
    commentDelivery: owedDelivery,
  });

  // Hand off to recordInitialCommentDelivery so the post + retry-index
  // pointer + claim lock all run through the same path the reconcile
  // site uses. Failures inside the post path stay non-fatal — the
  // owed-delivery stamp + retry pointer already make the comment
  // recoverable on the next retry tick.
  await postReconcileOutcomeCommentSafe({
    rootDir,
    jobPath: stopped.jobPath,
    job: stopped.job,
    worker: remediationWorker,
    action: 'stopped',
    postCommentImpl,
    now,
    log,
  });

  return stopped;
}

async function main() {
  if (process.argv.includes('--with-hq-integration')) {
    process.env.ADV_WITH_HQ_INTEGRATION = '1';
  }
  validateStartupRemediationConfig(process.env);
  const mode = process.argv.includes('reconcile') ? 'reconcile' : 'consume';

  try {
    if (mode === 'reconcile') {
      const result = await reconcileInProgressFollowUpJobs();
      console.log(
        `[follow-up-remediation] Reconciliation scanned=${result.scanned} active=${result.active} completed=${result.completed} failed=${result.failed} requeued=${result.requeued} stopped=${result.stopped} skipped=${result.skipped}`
      );
      result.results
        .filter((entry) => ['completed', 'failed', 'requeued', 'stopped'].includes(entry.action))
        .forEach((entry) => {
          const reasonTag = entry.reason ? ` reason=${entry.reason}` : '';
          console.log(`[follow-up-remediation] ${entry.action}${reasonTag}: ${entry.job.repo}#${entry.job.prNumber} -> ${entry.jobPath}`);
        });
      return;
    }

    const drain = await consumeFollowUpJobsUntilCapacity();
    if (isDrainQueueIdle(drain)) {
      console.log('[follow-up-remediation] No pending follow-up jobs to consume.');
      console.log(buildDrainSummaryLogLine(drain));
      return;
    }

    if (drain.availableAtStart === 0 && drain.activeAtStart > 0) {
      if (drain.pendingClaimable > 0) {
        console.log(buildBackpressureLogLine({ activeAtStart: drain.activeAtStart, pendingCount: drain.pendingClaimable }));
      }
    }

    console.log(buildDrainSummaryLogLine(drain));

    if (drain.results.length === 0 && drain.spawned === 0 && drain.stopped === 0 && drain.deferredSamePR === 0) {
      return;
    }

    for (const result of drain.results) {
      if (result.reason === 'no-pending-jobs') {
        continue;
      }
      if (result.consumed) {
        const workerModel = result.job.remediationWorker?.model || 'codex';
        const dispatchTag = result.job.remediationWorker?.dispatchMode === 'hq'
          ? ` lrq=${result.job.remediationWorker.launchRequestId}`
          : ` pid=${result.job.remediationWorker.processId}`;
        console.log(
          `[follow-up-remediation] Spawned ${workerModel} remediation worker${dispatchTag} for ${result.job.repo}#${result.job.prNumber}`
        );
        console.log(`[follow-up-remediation] Queue record: ${result.jobPath}`);
        continue;
      }

      if (!result.job) {
        const reasonTag = result.reason ? ` reason=${result.reason}` : '';
        console.log(`[follow-up-remediation] Unhandled drain result${reasonTag} consumed=${Boolean(result.consumed)}`);
        continue;
      }

      const stopRepoTag = result.job.repo && result.job.prNumber
        ? `${result.job.repo}#${result.job.prNumber} `
        : '';
      const stopCode = result.job?.remediationPlan?.stop?.code || result.reason || 'stopped';
      console.log(
        `[follow-up-remediation] Stopped pending ${stopRepoTag}-> ${stopCode} (${result.reason || 'stopped'})`
      );
      if (result.jobPath) {
        console.log(`[follow-up-remediation] Queue record: ${result.jobPath}`);
      }
    }
  } catch (err) {
    if (err.isOAuthError) {
      console.error(`[follow-up-remediation] Stopped: ${err.message}`);
      process.exit(2);
    }

    console.error('[follow-up-remediation] Failed to consume follow-up job:', err.message);
    if (err.followUpJobPath) {
      console.error(`[follow-up-remediation] Failed job record moved to ${err.followUpJobPath}`);
    }
    process.exit(1);
  }
}

export {
  REMEDIATOR_PROMPT_SET,
  FOLLOW_UP_PROMPT_PATH,
  DEFAULT_REMEDIATOR_ENV,
  REMEDIATION_WORKER_TRAILER_CLASS,
  DEFAULT_REPLIES_ROOT,
  DEFAULT_REMEDIATION_MAX_CONCURRENT_JOBS,
  OAUTH_ENV_STRIP_LIST,
  REMEDIATION_MAX_CONCURRENT_JOBS_ENV,
  WORKER_PROVENANCE_HOOK_SRC,
  OSS_READINESS_APPLY_SCRIPT_ENV,
  OSS_READINESS_AUDIT_CHECK_NAME,
  installWorkerProvenanceHook,
  auditWorkspaceForContamination,
  applyOssReadinessRemediation,
  jobHasOssReadinessAuditFailure,
  resolveOssReadinessApplyScript,
  OAuthError,
  StartupContractError,
  assertCodexOAuth,
  resetOAuthPreflightCache,
  assertValidRepoSlug,
  buildRemediationPrompt,
  buildInheritedPath,
  buildFollowUpClaimReservations,
  consumeFollowUpJobsUntilCapacity,
  consumeNextFollowUpJob,
  attachFollowUpTelemetryListeners,
  cleanupReconcileClaimArtifacts,
  connectFollowUpTelemetryListener,
  handleRemediationTelemetryEvent,
  inspectWorkspaceState,
  digestWorkerFinalMessage,
  isWorkerProcessRunning,
  killDetachedWorkerProcessGroup,
  loadFollowUpPromptTemplate,
  prepareCodexRemediationStartupEnv,
  prepareWorkspaceForJob,
  remediationWorkerGitIdentity,
  REMEDIATION_WORKER_IDENTITY_DEFAULTS,
  reconcileFollowUpJob,
  reconcileInProgressFollowUpJobs,
  releaseFollowUpReconcileClaim,
  tryAcquireFollowUpReconcileClaim,
  lifecycleStopDecision,
  dispatchRemediationViaHq,
  resolveCodexCliPath,
  resolveCodexAuthPath,
  resolveHqReplyPath,
  prepareHqReplyLandingPad,
  resolveHqRoot,
  resolveAdversarialReviewAppSubscribes,
  resolveLocalRepliesRoot,
  resolveRemediationReplyTarget,
  resolveRemediationWorkspaceRoot,
  resolveRemediationDispatchPathForJob,
  resolveRemediationRuntimeMode,
  createRemediationRuntime,
  resolveAdversarialReviewAppMode,
  shouldUseHqIntegration,
  resolveJobRelativePath,
  resolveStoredWorkspaceRoot,
  resolveWorkerStoredPath,
  resolveReplyStorageKey,
  resolveRemediationMaxConcurrentJobs,
  summarizeWorkerFinalMessage,
  assessWorkerLiveness,
  applyMergeAgentBrokerEnv,
  assertHarnessIdentityMatch,
  HarnessIdentityMismatchError,
  isHarnessIdentityEnforcementEnabled,
  remediationWorkerPushProvider,
  spawnCodexRemediationWorker,
  spawnClaudeCodeRemediationWorker,
  spawnGeminiRemediationWorker,
  assertClaudeCodeOAuth,
  assertGeminiOAuth,
  assertRemediationWorkerOAuth,
  prepareGeminiRemediationStartupEnv,
  resolveGeminiCliPath,
  resolveGeminiRemediationModel,
  resolveCodexRemediationModel,
  remediationWorkerTrailerClass,
  GEMINI_REMEDIATION_WORKER_TRAILER_CLASS,
  defaultRemediatorWorkerClassFromEnv,
  resolveDefaultRemediator,
  validateStartupRemediationConfig,
  normalizeMaxConcurrentFollowUpJobs,
  normalizeRemediationWorkerClass,
  pickRemediationWorkerClass,
  resolveRoleRegistryRemediator,
  assertWorkflowPushCapabilityForJob,
  extractChangedPathsFromJob,
  hasWorkflowGitHubAppPermission,
  hasWorkflowOAuthScope,
  inspectRemediationPushTokenCapability,
  isWorkflowPath,
  parseGitHubAppPermissions,
  parseOAuthScopesFromGhAuthStatus,
  parseOAuthScopesFromGhApiHeaders,
  remediationTouchesWorkflowFiles,
  resolveRemediationPushTokenIdentity,
  prepareClaudeCodeRemediationStartupEnv,
  resolveClaudeCodeCliPath,
  buildBackpressureLogLine,
  buildDrainSummaryLogLine,
  isDrainQueueIdle,
  classifyHqDispatchFailure,
  createQuotaHoldRevalidator,
  countPendingFollowUpJobsByRetryWindow,
  REMEDIATION_LEGACY_UNSTAGE_COMMANDS,
  WORKSPACE_ARTIFACT_EXCLUDE_ENTRY,
  postRemediationCommentWithCapture,
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
