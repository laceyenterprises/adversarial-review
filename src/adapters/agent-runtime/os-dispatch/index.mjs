// The `os-dispatch` AgentRuntime (v2 app architecture §6.1) — the PRIMARY
// runtime. Reviews and remediations route through the Agent OS app contract
// (`/v1/dispatch`) instead of the repo's private per-model spawn harness, so
// the app inherits admission, entitlements, model allowlists, sandboxing,
// token budgets, and ledger telemetry from the worker pool.
//
// This routes through the published Agent OS app-contract SDK
// (`@agent-os/app-sdk`, consumed as a `file:` tarball per the ARC-23 packaging
// ADR) behind the AgentRuntime port defined in ARC-05. ARC-24 deleted this
// repo's vendored dispatch client and swapped its connect helper for the SDK's
// `connect(...)`; the session surface (`dispatch`, `dispatchStatus`) is
// identical, so nothing else in this adapter changed.
//
// Wire mapping per the role registry (§5) and completion shapes (§4.3, §9):
//   - reviewer   → task_kind 'review'      completion_shape 'decision-only'
//                  → verdict returns as a structured ReviewArtifact (v2).
//   - remediator → task_kind 'coding'      completion_shape 'branch-push'
//                  → opaque app artifact (domain adapter decodes it).
//
// The AgentRunRequest.idempotencyKey is deterministically mapped to an
// app-contract-safe `request_id`; the endpoint's (app_id, request_id)
// idempotency is the server-side backstop that makes re-dispatch and reattach
// safe (§6.3).

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadAppSdkConnect } from '../../../app-sdk-loader.mjs';
import {
  isExpiredAppContractSessionError,
  isTransientAppContractError,
  withAppContractTransientRetry,
} from '../../../app-contract-retry.mjs';
import {
  REVIEW_ARTIFACT_KIND,
  REVIEW_ARTIFACT_SCHEMA_VERSION,
  validateReviewArtifact,
  ReviewArtifactSchemaError,
} from './review-artifact.mjs';
import {
  extractReviewVerdict,
  normalizeReviewVerdict,
  sanitizeReviewPayloadBestEffort,
} from '../../../kernel/verdict.mjs';
import {
  parseBlockingFindingsSection,
  parseNonBlockingFindingsSection,
} from '../../../kernel/remediation-reply.mjs';

const RUNTIME_ID = 'os-dispatch';
const RUNTIME_MODE = 'os';
const DEFAULT_APP_CONTRACT_APP_ID = 'adversarial-review';
const DEFAULT_APP_CONTRACT_REQUEST_TIMEOUT_MS = 75_000;
const APP_CONTRACT_REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const APP_CONTRACT_REQUEST_ID_DIGEST_LENGTH = 16;

const DEFAULT_POLL_BASE_MS = 5_000;
const DEFAULT_POLL_JITTER_MS = 1_000;

// dispatch_status terminal-state mapping → AgentRunStatus. Non-terminal states
// (queued/accepted/dispatching/running/heartbeating/…) keep the poll loop
// alive; anything not listed here is treated as non-terminal so a novel
// in-progress state never resolves the run prematurely.
const SUCCESS_STATUSES = new Set(['succeeded', 'success', 'completed', 'complete', 'done']);
const FAILED_STATUSES = new Set(['failed', 'failure', 'error', 'errored', 'rejected']);
const CANCELLED_STATUSES = new Set(['canceled', 'cancelled', 'superseded', 'aborted']);
const TIMEOUT_STATUSES = new Set(['timeout', 'timed_out', 'timedout', 'expired', 'deadline_exceeded']);
const EXECUTION_ACTIVE_STATUSES = new Set(['running', 'heartbeating']);
const EXECUTION_START_FIELDS = [
  'running_at',
  'runningAt',
  'started_at',
  'startedAt',
  'worker_started_at',
  'workerStartedAt',
  'spawned_at',
  'spawnedAt',
];

// Role → dispatch task_kind / completion_shape. A role may override either
// explicitly; otherwise the kind decides (reviewer=decision-only,
// remediator=branch-push).
function toHqTaskKind(taskKind) {
  const normalized = String(taskKind || '').trim();
  if (normalized === 'remediation') return 'coding';
  return normalized;
}

function resolveTaskKind(role) {
  const explicit = String(role?.taskKind || '').trim();
  if (explicit) return toHqTaskKind(explicit);
  return role?.kind === 'remediator' ? 'coding' : 'review';
}

function resolveCompletionShape(role) {
  const explicit = String(role?.completionShape || '').trim();
  if (explicit) return explicit;
  return role?.kind === 'remediator' ? 'branch-push' : 'decision-only';
}

function resolveWorkerClass(role) {
  const explicit = String(role?.workerClass || '').trim();
  if (explicit) return explicit;

  const rawModel = String(role?.model || '').trim();
  if (!rawModel) return undefined;
  if (role?.kind === 'remediator') return rawModel;
  const model = rawModel.toLowerCase();

  if (model.startsWith('codex')) return 'codex-reviewer';
  if (model.startsWith('gemini')) return 'gemini-reviewer';
  if (model.startsWith('claude')) return 'claude-reviewer';
  return rawModel;
}

function normalizeStatus(status) {
  return String(status || '').trim().toLowerCase();
}

function mapTerminalStatus(status) {
  if (SUCCESS_STATUSES.has(status)) return 'completed';
  if (TIMEOUT_STATUSES.has(status)) return 'timeout';
  if (CANCELLED_STATUSES.has(status)) return 'cancelled';
  if (FAILED_STATUSES.has(status)) return 'failed';
  return null;
}

function validateRequest(request) {
  if (!request || typeof request !== 'object') {
    throw new TypeError('AgentRuntime.run requires a request object');
  }
  const role = request.role;
  if (!role || typeof role !== 'object' || typeof role.kind !== 'string') {
    throw new TypeError('AgentRunRequest.role.kind is required');
  }
  if (typeof role.model !== 'string' || role.model.trim() === '') {
    throw new TypeError('AgentRunRequest.role.model is required');
  }
  if (typeof request.idempotencyKey !== 'string' || request.idempotencyKey.trim() === '') {
    throw new TypeError('AgentRunRequest.idempotencyKey is required');
  }
}

function defaultBuildPrompt(request) {
  return String(request?.subjectContent?.representation ?? '');
}

function toTokenBudget(budget) {
  const value = budget?.maxTokens;
  if (value == null) return undefined;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : undefined;
}

function toAppContractRequestId(idempotencyKey) {
  const normalized = String(idempotencyKey ?? '').trim();
  if (!normalized) {
    throw new TypeError('AgentRunRequest.idempotencyKey is required');
  }
  if (APP_CONTRACT_REQUEST_ID_RE.test(normalized)) return normalized;

  const digest = createHash('sha256')
    .update(normalized)
    .digest('hex')
    .slice(0, APP_CONTRACT_REQUEST_ID_DIGEST_LENGTH);
  const safeStem = normalized
    .replace(/[^A-Za-z0-9._:/-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, 'r-') || 'request';
  const maxStemLength = 255 - digest.length - 1;
  const stem = safeStem.slice(0, maxStemLength) || 'request';
  return `${stem}-${digest}`;
}

// Build the app-contract /v1/dispatch payload. `request_id` is the
// app-contract-safe derivative of the idempotency key — the server-side
// (app_id, request_id) idempotency is the backstop that dedupes retries and
// reattach.
function buildDispatchPayload(request, buildPrompt) {
  const role = request.role;
  const ref = request.subjectContent?.ref || {};
  return {
    request_id: toAppContractRequestId(request.idempotencyKey),
    task_kind: resolveTaskKind(role),
    completion_shape: resolveCompletionShape(role),
    worker_class: resolveWorkerClass(role),
    role_id: role.id,
    domain_id: ref.domainId,
    subject_external_id: ref.subjectExternalId,
    revision_ref: ref.revisionRef,
    ticket_ref: ref.linearTicketId ?? undefined,
    prompt_set: request.promptSet,
    prompt_stage: request.promptStage,
    prompt: buildPrompt(request),
    token_budget: toTokenBudget(request.budget),
    workspace_ref: request.workspaceRef?.workspacePath,
  };
}

function extractArtifact(statusPayload) {
  if (statusPayload && typeof statusPayload === 'object') {
    if (statusPayload.artifact !== undefined) return statusPayload.artifact;
    if (statusPayload.result && typeof statusPayload.result === 'object') {
      return statusPayload.result.artifact;
    }
  }
  return undefined;
}

function parseRequestArtifactContext(requestId) {
  const parts = String(requestId || '').split(':');
  if (parts.length < 4) {
    return {
      domainId: 'unknown',
      subjectExternalId: 'unknown',
      revisionRef: 'unknown',
    };
  }
  return {
    domainId: parts[0] || 'unknown',
    subjectExternalId: parts[1] || 'unknown',
    revisionRef: parts[2] || 'unknown',
    stageId: parts[3] || undefined,
    reviewerRole: parts.length > 5 ? parts.slice(4, -1).join(':') : parts[4],
  };
}

function artifactContextFromRequest(request, statusPayload) {
  const parsed = parseRequestArtifactContext(
    request?.idempotencyKey
      ?? statusPayload?.request_id
      ?? statusPayload?.requestId,
  );
  const ref = request?.subjectContent?.ref || {};
  return {
    domainId: ref.domainId ?? parsed.domainId,
    subjectExternalId: ref.subjectExternalId ?? parsed.subjectExternalId,
    revisionRef: ref.revisionRef ?? parsed.revisionRef,
    stageId: parsed.stageId,
    reviewerRole: request?.role?.id ?? parsed.reviewerRole,
  };
}

function extractVerdictPhrase(body) {
  const text = String(body || '');
  const extracted = extractReviewVerdict(text);
  if (extracted) return extracted;
  const inline = text.match(/\bVerdict\s*:?\s*(Request changes|Comment-only|Comment only|Approved|Unknown)\b/imu);
  return inline?.[1]?.trim() || null;
}

function normalizeFindingForArtifact(finding) {
  if (typeof finding === 'string') return { problem: finding };
  if (!finding || typeof finding !== 'object' || Array.isArray(finding)) return null;
  const normalized = {};
  for (const key of ['title', 'file', 'lines', 'problem']) {
    const value = finding[key];
    if (typeof value === 'string' && value.trim() !== '') normalized[key] = value;
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
}

function parsedFindingsForArtifact(body, parser) {
  const parsed = parser(body);
  if (!Array.isArray(parsed)) return null;
  return parsed.map(normalizeFindingForArtifact).filter(Boolean);
}

function fallbackRequestChangesFinding() {
  return {
    problem: 'Request changes review body did not expose parseable blocking findings.',
  };
}

function extractSummaryArtifact(statusPayload, role, artifactContext = null, options = {}) {
  if (role?.kind !== 'reviewer') return undefined;
  const rawBodyCandidates = [
    readDurableDispatchStdout(statusPayload, options),
    statusPayload?.lastProgressSummary,
    liveStatusOf(statusPayload)?.lastProgressSummary,
  ];
  let body = null;
  let verdict = null;
  for (const rawBody of rawBodyCandidates) {
    if (typeof rawBody !== 'string' || rawBody.trim() === '') continue;
    const candidateBody = sanitizeReviewPayloadBestEffort(rawBody);
    const candidateVerdict = extractVerdictPhrase(candidateBody);
    if (!candidateVerdict) continue;
    body = candidateBody;
    verdict = candidateVerdict;
    break;
  }
  if (!body || !verdict) return undefined;
  const verdictKind = normalizeReviewVerdict(verdict);
  const blockingFindings = parsedFindingsForArtifact(body, parseBlockingFindingsSection);
  const nonBlockingFindings = parsedFindingsForArtifact(body, parseNonBlockingFindingsSection);
  const context = artifactContext
    ?? artifactContextFromRequest(null, statusPayload);
  return {
    kind: REVIEW_ARTIFACT_KIND,
    schemaVersion: REVIEW_ARTIFACT_SCHEMA_VERSION,
    ...context,
    // Strict provenance only: a dispatchId-only payload must NOT seed
    // reviewerRunRef, or the app-contract request handle contaminates durable
    // launchRequestId attribution (see launchRequestRefStrict).
    reviewerRunRef: launchRequestRefStrict(statusPayload),
    verdict: {
      kind: verdict,
      summary: '',
      blockingFindings: verdictKind === 'request-changes' && (!blockingFindings || blockingFindings.length === 0)
        ? [fallbackRequestChangesFinding()]
        : (blockingFindings ?? []),
      nonBlockingFindings: nonBlockingFindings ?? [],
    },
    body,
  };
}

function extractUsage(statusPayload) {
  const usage = statusPayload?.usage;
  return usage && typeof usage === 'object' ? usage : null;
}

function liveStatusOf(statusPayload) {
  const liveStatus = statusPayload?.live_status ?? statusPayload?.liveStatus;
  return liveStatus && typeof liveStatus === 'object' ? liveStatus : statusPayload;
}

function parseIsoMs(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function startTimeFromObject(value) {
  if (!value || typeof value !== 'object') return null;
  for (const field of EXECUTION_START_FIELDS) {
    const parsed = parseIsoMs(value[field]);
    if (parsed !== null) return parsed;
  }
  return null;
}

function executionStartedAtMs(statusPayload, observedAtMs) {
  const liveStatus = liveStatusOf(statusPayload);
  const explicit = startTimeFromObject(statusPayload) ?? startTimeFromObject(liveStatus);
  if (explicit !== null) return explicit;
  const status = normalizeStatus(statusPayload?.status ?? liveStatus?.status);
  return EXECUTION_ACTIVE_STATUSES.has(status) ? observedAtMs : null;
}

function launchRequestIdOf(statusPayload) {
  const liveStatus = liveStatusOf(statusPayload);
  return statusPayload?.launch_request_id
    ?? statusPayload?.launchRequestId
    ?? statusPayload?.dispatchId
    ?? liveStatus?.launch_request_id
    ?? liveStatus?.launchRequestId
    ?? liveStatus?.dispatchId
    ?? null;
}

// Strict launch-request provenance for durable attribution. Unlike
// launchRequestIdOf — which falls back to dispatchId for best-effort
// dispatch-directory lookups (e.g. reading stdout) — this NEVER accepts a
// dispatchId. In the os-dispatch runtime a dispatchId is the app-contract
// request/idempotency handle, not the worker-pool launch_request_id; promoting
// it into the reviewer artifact's reviewerRunRef (and downstream into
// metadata_json.launchRequestId) would contaminate reviewer-pass attribution and
// make rows eligible for a backfill repair that resolves the WRONG worker run.
// Returns null when only a dispatchId is present, so attribution stays
// not-applicable rather than pointing at a request handle.
function launchRequestRefStrict(statusPayload) {
  const liveStatus = liveStatusOf(statusPayload);
  return statusPayload?.launch_request_id
    ?? statusPayload?.launchRequestId
    ?? liveStatus?.launch_request_id
    ?? liveStatus?.launchRequestId
    ?? null;
}

function resolveHqRoot(env = process.env) {
  const explicit = String(env.HQ_ROOT || env.AGENT_OS_HQ_ROOT || '').trim();
  return explicit || null;
}

function readDurableDispatchStdout(statusPayload, {
  env = process.env,
  existsSyncImpl = existsSync,
  readFileSyncImpl = readFileSync,
} = {}) {
  const hqRoot = resolveHqRoot(env);
  const launchRequestId = String(launchRequestIdOf(statusPayload) || '').trim();
  if (!hqRoot || !launchRequestId) return null;
  const stdoutPath = join(hqRoot, 'dispatch', launchRequestId, 'stdout.log');
  try {
    if (!existsSyncImpl(stdoutPath)) return null;
    const stdout = readFileSyncImpl(stdoutPath, 'utf8');
    return typeof stdout === 'string' && stdout.trim() ? stdout : null;
  } catch {
    return null;
  }
}

function failureDetail(statusPayload) {
  return (
    statusPayload?.failure_detail
    ?? statusPayload?.failureDetail
    ?? statusPayload?.error?.message
    ?? statusPayload?.detail
    ?? null
  );
}

function failureClassOf(statusPayload, fallback) {
  return statusPayload?.failure_class ?? statusPayload?.failureClass ?? fallback;
}

function diagnosticFailure(statusPayload) {
  const diagnostics = Array.isArray(statusPayload?.diagnostics) ? statusPayload.diagnostics : [];
  return diagnostics.find((diagnostic) => {
    const severity = normalizeStatus(diagnostic?.severity);
    return severity === 'error' || severity === 'fatal';
  }) ?? null;
}

function nonZeroExitCode(statusPayload) {
  const raw = statusPayload?.effectiveExitCode ?? statusPayload?.exitCode;
  if (raw == null) return null;
  const code = Number(raw);
  return Number.isFinite(code) && code !== 0 ? code : null;
}

function dispatchFailureEvidence(statusPayload) {
  const liveStatus = liveStatusOf(statusPayload);
  const diagnostic = diagnosticFailure(statusPayload) ?? diagnosticFailure(liveStatus);
  const exitCode = nonZeroExitCode(statusPayload) ?? nonZeroExitCode(liveStatus);
  const health = normalizeStatus(statusPayload?.health ?? liveStatus?.health);
  const failureClass = failureClassOf(statusPayload, null)
    ?? failureClassOf(liveStatus, null)
    ?? diagnostic?.violationType
    ?? diagnostic?.gate
    ?? (exitCode == null ? null : 'dispatch-failed')
    ?? (health && health !== 'healthy' ? 'dispatch-failed' : null);
  const detail = failureDetail(statusPayload)
    ?? failureDetail(liveStatus)
    ?? statusPayload?.lastProgressSummary
    ?? liveStatus?.lastProgressSummary
    ?? diagnostic?.reason
    ?? (exitCode == null ? null : `dispatch exited with code ${exitCode}`)
    ?? (health && health !== 'healthy' ? `dispatch health is ${health}` : null);
  if (!failureClass && !detail) return null;
  return {
    failureClass: failureClass || 'dispatch-failed',
    detail,
  };
}

// Map a terminal dispatch_status payload into a RunResult. On `completed`, a
// reviewer run's artifact is validated against the ReviewArtifact v2 schema; a
// malformed handoff downgrades the run to `failed` (failureClass
// 'reviewer-output') rather than reporting a junk verdict. A remediator's
// branch-push artifact is opaque here — the domain adapter decodes it.
function buildTerminalResult(mappedStatus, statusPayload, role, artifactContext = null, options = {}) {
  const usage = extractUsage(statusPayload);
  if (mappedStatus === 'completed') {
    const artifact = extractArtifact(statusPayload) ?? extractSummaryArtifact(statusPayload, role, artifactContext, options);
    const dispatchFailure = artifact === undefined
      ? dispatchFailureEvidence(statusPayload)
      : null;
    if (dispatchFailure) {
      return {
        status: 'failed',
        failureClass: dispatchFailure.failureClass,
        usage,
        runtimeMode: RUNTIME_MODE,
        detail: dispatchFailure.detail,
      };
    }
    if (role.kind === 'remediator') {
      return {
        status: 'completed',
        artifact,
        failureClass: null,
        usage,
        runtimeMode: RUNTIME_MODE,
        detail: null,
      };
    }
    try {
      return {
        status: 'completed',
        artifact: validateReviewArtifact(artifact),
        failureClass: null,
        usage,
        runtimeMode: RUNTIME_MODE,
        detail: null,
      };
    } catch (err) {
      if (!(err instanceof ReviewArtifactSchemaError)) throw err;
      return {
        status: 'failed',
        failureClass: 'reviewer-output',
        usage,
        runtimeMode: RUNTIME_MODE,
        detail: err.message,
      };
    }
  }
  if (mappedStatus === 'timeout') {
    return {
      status: 'timeout',
      failureClass: 'timeout',
      usage,
      runtimeMode: RUNTIME_MODE,
      detail: failureDetail(statusPayload) || 'dispatch reported a timeout terminal state',
    };
  }
  if (mappedStatus === 'cancelled') {
    return {
      status: 'cancelled',
      failureClass: failureClassOf(statusPayload, null),
      usage,
      runtimeMode: RUNTIME_MODE,
      detail: failureDetail(statusPayload),
    };
  }
  return {
    status: 'failed',
    failureClass: failureClassOf(statusPayload, 'unknown'),
    usage,
    runtimeMode: RUNTIME_MODE,
    detail: failureDetail(statusPayload),
  };
}

function dispatchFailureResult(err) {
  return {
    status: 'failed',
    failureClass: err?.configurationError ? 'bug' : 'unknown',
    usage: null,
    runtimeMode: RUNTIME_MODE,
    detail: err?.message || String(err),
  };
}

function settledHandle(runRef, result) {
  return {
    runRef,
    mode: RUNTIME_MODE,
    async await() { return result; },
    async cancel() {},
    async reattach() { return result; },
  };
}

function defaultJitter(maxMs) {
  return Math.floor(Math.random() * Math.max(0, maxMs + 1));
}

function withDefaultConnectOptions(connectOptions = {}) {
  const options = { ...connectOptions };
  if (!options.app_id && !options.appId) {
    options.app_id = DEFAULT_APP_CONTRACT_APP_ID;
  }
  if (options.request_timeout_ms == null && options.requestTimeoutMs == null) {
    options.request_timeout_ms = DEFAULT_APP_CONTRACT_REQUEST_TIMEOUT_MS;
  }
  return options;
}

function createOsDispatchAgentRuntime({
  session = null,
  connectImpl = null,
  connectOptions = {},
  buildPrompt = defaultBuildPrompt,
  pollBaseMs = DEFAULT_POLL_BASE_MS,
  pollJitterMs = DEFAULT_POLL_JITTER_MS,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  jitterImpl = defaultJitter,
  nowMs = () => Date.now(),
  logger = console,
  env = process.env,
  existsSyncImpl = existsSync,
  readFileSyncImpl = readFileSync,
} = {}) {
  let sessionPromise = session ? Promise.resolve(session) : null;

  async function resolveSession() {
    if (!sessionPromise) {
      const doConnect = connectImpl ?? (await loadAppSdkConnect());
      const resolvedConnectOptions = withDefaultConnectOptions(connectOptions);
      sessionPromise = withAppContractTransientRetry(() => doConnect(resolvedConnectOptions), { sleepImpl }).catch((err) => {
        sessionPromise = null; // allow a later run to retry the connect
        throw err;
      });
    }
    return sessionPromise;
  }

  function clearCachedSession() {
    sessionPromise = null;
  }

  async function withFreshSessionOnExpiry(operation) {
    let activeSession = await resolveSession();
    try {
      const value = await withAppContractTransientRetry(
        () => operation(activeSession),
        { sleepImpl },
      );
      return { activeSession, value };
    } catch (err) {
      if (!isExpiredAppContractSessionError(err)) throw err;
      clearCachedSession();
      activeSession = await resolveSession();
      const value = await withAppContractTransientRetry(
        () => operation(activeSession),
        { sleepImpl },
      );
      return { activeSession, value };
    }
  }

  async function bestEffortCancel(activeSession, requestId) {
    if (typeof activeSession?.dispatchCancel !== 'function') return;
    try {
      await activeSession.dispatchCancel(requestId);
    } catch (err) {
      logger?.warn?.('[os-dispatch] best-effort dispatch cancel failed', {
        requestId,
        error: err?.message || String(err),
      });
    }
  }

  // Poll dispatch_status until a terminal state, mapping it to a RunResult.
  // Reviewer timeout is an execution budget, not an admission budget: an LRQ can
  // wait behind older work without spending the model's wall-clock allowance.
  // Once dispatch_status proves the worker is actually running, the client
  // deadline is anchored to that start time. A cancel request (flag flipped by
  // the handle) short-circuits with a best-effort server-side cancel.
  // `request_id` idempotency makes this loop safe to (re)enter on reattach.
  async function pollUntilTerminal({
    activeSession,
    requestId,
    role,
    cancelled,
    timeoutDurationMs,
    initialExecutionStartedAtMs = null,
    artifactContext = null,
  }) {
    const boundedDurationMs = Number(timeoutDurationMs);
    let deadlineMs = Number.isFinite(boundedDurationMs) && boundedDurationMs > 0
      && Number.isFinite(initialExecutionStartedAtMs)
      ? initialExecutionStartedAtMs + boundedDurationMs
      : null;
    while (true) {
      if (cancelled.value) {
        // handle.cancel() already issued the best-effort server-side cancel
        // when it flipped the flag; don't re-issue it here.
        return {
          status: 'cancelled',
          failureClass: null,
          usage: null,
          runtimeMode: RUNTIME_MODE,
          detail: `os-dispatch run ${requestId} cancelled by caller`,
        };
      }
      if (deadlineMs != null && nowMs() >= deadlineMs) {
        await bestEffortCancel(activeSession, requestId);
        return {
          status: 'timeout',
          failureClass: 'timeout',
          usage: null,
          runtimeMode: RUNTIME_MODE,
          detail: `os-dispatch run ${requestId} exceeded its timeout and was cancelled`,
        };
      }
      let statusPayload;
      try {
        const refreshed = await withFreshSessionOnExpiry(
          (sessionForCall) => sessionForCall.dispatchStatus(requestId),
        );
        activeSession = refreshed.activeSession;
        statusPayload = refreshed.value;
      } catch (err) {
        if (isTransientAppContractError(err)) {
          logger?.warn?.('[os-dispatch] transient dispatch status failure; polling will continue', {
            requestId,
            error: err?.message || String(err),
          });
          await sleepImpl(pollBaseMs + jitterImpl(pollJitterMs));
          continue;
        }
        return dispatchFailureResult(err);
      }
      const mapped = mapTerminalStatus(normalizeStatus(statusPayload?.status));
      if (mapped) {
        return buildTerminalResult(mapped, statusPayload, role, artifactContext, {
          env,
          existsSyncImpl,
          readFileSyncImpl,
        });
      }
      if (deadlineMs === null && Number.isFinite(boundedDurationMs) && boundedDurationMs > 0) {
        const startedAtMs = executionStartedAtMs(statusPayload, nowMs());
        if (Number.isFinite(startedAtMs)) {
          deadlineMs = startedAtMs + boundedDurationMs;
        }
      }
      if (deadlineMs != null && nowMs() >= deadlineMs) {
        await bestEffortCancel(activeSession, requestId);
        return {
          status: 'timeout',
          failureClass: 'timeout',
          usage: null,
          runtimeMode: RUNTIME_MODE,
          detail: `os-dispatch run ${requestId} exceeded its execution timeout and was cancelled`,
        };
      }
      await sleepImpl(pollBaseMs + jitterImpl(pollJitterMs));
    }
  }

  function resolveTimeoutDurationMs(request) {
    const timeoutMs = Number(request.timeoutMs);
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) return Math.floor(timeoutMs);
    const wallMs = Number(request.budget?.maxWallMs);
    if (Number.isFinite(wallMs) && wallMs > 0) return Math.floor(wallMs);
    return null;
  }

  function resolveReattachTimeoutDurationMs(record) {
    const timeoutMs = Number(record.timeoutMs ?? record.subjectContext?.timeoutMs);
    const wallMs = Number(record.budget?.maxWallMs ?? record.subjectContext?.budget?.maxWallMs);
    const durationMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : wallMs;
    return Number.isFinite(durationMs) && durationMs > 0 ? Math.floor(durationMs) : null;
  }

  function resolveReattachExecutionStartedAtMs(record) {
    return startTimeFromObject({
      running_at: record?.running_at,
      runningAt: record?.runningAt,
      worker_started_at: record?.worker_started_at,
      workerStartedAt: record?.workerStartedAt,
      started_at: record?.execution_started_at,
      startedAt: record?.executionStartedAt,
    });
  }

  async function run(request) {
    validateRequest(request);
    const role = request.role;
    const payload = buildDispatchPayload(request, buildPrompt);
    const requestId = payload.request_id;
    const artifactContext = artifactContextFromRequest(request, null);

    let activeSession;
    try {
      const dispatched = await withFreshSessionOnExpiry(
        (sessionForCall) => sessionForCall.dispatch(payload),
      );
      activeSession = dispatched.activeSession;
    } catch (err) {
      return settledHandle(requestId, dispatchFailureResult(err));
    }

    const cancelled = { value: false };
    const timeoutDurationMs = resolveTimeoutDurationMs(request);
    let pollingPromise = null;

    function awaitTerminal() {
      pollingPromise ??= pollUntilTerminal({
        activeSession,
        requestId,
        role,
        cancelled,
        timeoutDurationMs,
        artifactContext,
      });
      return pollingPromise;
    }

    return {
      runRef: requestId,
      mode: RUNTIME_MODE,
      async await() {
        return awaitTerminal();
      },
      async cancel() {
        cancelled.value = true;
        await bestEffortCancel(activeSession, requestId);
      },
      // Re-adopt the in-flight dispatch after a kernel restart by re-polling
      // dispatch_status. Server-side (app_id, request_id) idempotency means no
      // duplicate work is issued — the accepted dispatch is observed, not
      // reissued (§6.3).
      async reattach() {
        return awaitTerminal();
      },
    };
  }

  // Record-scoped reattach superset (parity with the local runtime): after a
  // restart the caller holds a durable run record rather than a live handle.
  // The record's `reattachToken`/`idempotencyKey`/`request_id` should be the
  // app-contract request_id. Normalize as a compatibility backstop for older
  // records that still carried the raw idempotency key.
  async function reattach(record, { role } = {}) {
    if (!record || typeof record !== 'object') {
      throw new TypeError('createOsDispatchAgentRuntime.reattach requires a run record');
    }
    const rawRequestId = String(
      record.idempotencyKey
      ?? record.request_id
      ?? record.requestId
      ?? record.reattachToken
      ?? '',
    ).trim();
    if (!rawRequestId) {
      return {
        status: 'failed',
        failureClass: 'daemon-bounce',
        usage: null,
        runtimeMode: RUNTIME_MODE,
        detail: 'os-dispatch run record has no request_id to reattach',
      };
    }
    const requestId = toAppContractRequestId(rawRequestId);
    const effectiveRole = role
      || record.role
      || { kind: record.subjectContext?.agentRoleKind === 'remediator' ? 'remediator' : 'reviewer' };
    const artifactContext = {
      ...parseRequestArtifactContext(rawRequestId),
      ...(record.subjectContext?.domainId ? { domainId: record.subjectContext.domainId } : {}),
      ...(record.subjectContext?.subjectExternalId ? { subjectExternalId: record.subjectContext.subjectExternalId } : {}),
      ...(record.subjectContext?.revisionRef ? { revisionRef: record.subjectContext.revisionRef } : {}),
      ...(effectiveRole?.id ? { reviewerRole: effectiveRole.id } : {}),
    };
    let activeSession;
    try {
      activeSession = await resolveSession();
    } catch (err) {
      return dispatchFailureResult(err);
    }
    return pollUntilTerminal({
      activeSession,
      requestId,
      role: effectiveRole,
      cancelled: { value: false },
      timeoutDurationMs: resolveReattachTimeoutDurationMs(record),
      initialExecutionStartedAtMs: resolveReattachExecutionStartedAtMs(record),
      artifactContext,
    });
  }

  function describe() {
    return {
      id: RUNTIME_ID,
      mode: RUNTIME_MODE,
      capabilities: {
        processGroupIsolation: true,
        daemonBounceSafe: true,
        heartbeatPersisted: true,
        leaseManaged: true,
        oauthStripEnforced: true,
      },
    };
  }

  return {
    run,
    reattach,
    describe,
  };
}

export {
  DEFAULT_APP_CONTRACT_APP_ID,
  DEFAULT_APP_CONTRACT_REQUEST_TIMEOUT_MS,
  RUNTIME_ID,
  RUNTIME_MODE,
  buildDispatchPayload,
  createOsDispatchAgentRuntime,
  defaultBuildPrompt,
  mapTerminalStatus,
  resolveCompletionShape,
  resolveWorkerClass,
  resolveTaskKind,
  toHqTaskKind,
  toAppContractRequestId,
};
