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
//   - remediator → task_kind 'remediation' completion_shape 'branch-push'
//                  → opaque app artifact (domain adapter decodes it).
//
// The AgentRunRequest.idempotencyKey is propagated verbatim as the app-contract
// `request_id`; the endpoint's (app_id, request_id) idempotency is the
// server-side backstop that makes re-dispatch and reattach safe (§6.3).

import { connect } from '@agent-os/app-sdk';
import {
  isTransientAppContractError,
  withAppContractTransientRetry,
} from '../../../app-contract-retry.mjs';
import { validateReviewArtifact, ReviewArtifactSchemaError } from './review-artifact.mjs';

const RUNTIME_ID = 'os-dispatch';
const RUNTIME_MODE = 'os';

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

// Role → dispatch task_kind / completion_shape. A role may override either
// explicitly; otherwise the kind decides (reviewer=decision-only,
// remediator=branch-push).
function resolveTaskKind(role) {
  const explicit = String(role?.taskKind || '').trim();
  if (explicit) return explicit;
  return role?.kind === 'remediator' ? 'remediation' : 'review';
}

function resolveCompletionShape(role) {
  const explicit = String(role?.completionShape || '').trim();
  if (explicit) return explicit;
  return role?.kind === 'remediator' ? 'branch-push' : 'decision-only';
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

// Build the app-contract /v1/dispatch payload. `request_id` IS the
// idempotency key — the server-side (app_id, request_id) idempotency is the
// backstop that dedupes retries and reattach.
function buildDispatchPayload(request, buildPrompt) {
  const role = request.role;
  const ref = request.subjectContent?.ref || {};
  return {
    request_id: request.idempotencyKey,
    task_kind: resolveTaskKind(role),
    completion_shape: resolveCompletionShape(role),
    worker_class: role.model,
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

function extractUsage(statusPayload) {
  const usage = statusPayload?.usage;
  return usage && typeof usage === 'object' ? usage : null;
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

// Map a terminal dispatch_status payload into a RunResult. On `completed`, a
// reviewer run's artifact is validated against the ReviewArtifact v2 schema; a
// malformed handoff downgrades the run to `failed` (failureClass
// 'reviewer-output') rather than reporting a junk verdict. A remediator's
// branch-push artifact is opaque here — the domain adapter decodes it.
function buildTerminalResult(mappedStatus, statusPayload, role) {
  const usage = extractUsage(statusPayload);
  if (mappedStatus === 'completed') {
    const artifact = extractArtifact(statusPayload);
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

function createOsDispatchAgentRuntime({
  session = null,
  connectImpl = connect,
  connectOptions = {},
  buildPrompt = defaultBuildPrompt,
  pollBaseMs = DEFAULT_POLL_BASE_MS,
  pollJitterMs = DEFAULT_POLL_JITTER_MS,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  jitterImpl = defaultJitter,
  nowMs = () => Date.now(),
  logger = console,
} = {}) {
  let sessionPromise = session ? Promise.resolve(session) : null;

  async function resolveSession() {
    if (!sessionPromise) {
      sessionPromise = withAppContractTransientRetry(() => connectImpl(connectOptions), { sleepImpl }).catch((err) => {
        sessionPromise = null; // allow a later run to retry the connect
        throw err;
      });
    }
    return sessionPromise;
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
  // `deadlineMs` bounds the loop with the request's timeout; a cancel request
  // (flag flipped by the handle) short-circuits with a best-effort server-side
  // cancel. `request_id` idempotency makes this loop safe to (re)enter on
  // reattach.
  async function pollUntilTerminal({ activeSession, requestId, role, cancelled, deadlineMs }) {
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
        statusPayload = await withAppContractTransientRetry(
          () => activeSession.dispatchStatus(requestId),
          { sleepImpl },
        );
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
        return buildTerminalResult(mapped, statusPayload, role);
      }
      await sleepImpl(pollBaseMs + jitterImpl(pollJitterMs));
    }
  }

  function resolveDeadlineMs(request) {
    const timeoutMs = Number(request.timeoutMs);
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) return nowMs() + timeoutMs;
    const wallMs = Number(request.budget?.maxWallMs);
    if (Number.isFinite(wallMs) && wallMs > 0) return nowMs() + wallMs;
    return null;
  }

  function resolveReattachDeadlineMs(record) {
    const timeoutMs = Number(record.timeoutMs ?? record.subjectContext?.timeoutMs);
    const wallMs = Number(record.budget?.maxWallMs ?? record.subjectContext?.budget?.maxWallMs);
    const durationMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : wallMs;
    if (!Number.isFinite(durationMs) || durationMs <= 0) return null;
    const startedAtMs = Date.parse(record.spawnedAt ?? record.startedAt ?? record.createdAt ?? '');
    return Number.isFinite(startedAtMs) ? startedAtMs + durationMs : nowMs() + durationMs;
  }

  async function run(request) {
    validateRequest(request);
    const role = request.role;
    const requestId = request.idempotencyKey;

    let activeSession;
    try {
      activeSession = await resolveSession();
      await withAppContractTransientRetry(
        () => activeSession.dispatch(buildDispatchPayload(request, buildPrompt)),
        { sleepImpl },
      );
    } catch (err) {
      return settledHandle(requestId, dispatchFailureResult(err));
    }

    const cancelled = { value: false };
    const deadlineMs = resolveDeadlineMs(request);
    let pollingPromise = null;

    function awaitTerminal() {
      pollingPromise ??= pollUntilTerminal({ activeSession, requestId, role, cancelled, deadlineMs });
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
  // The record's `reattachToken`/`idempotencyKey`/`request_id` is the
  // app-contract request_id, so reattach is a plain re-poll.
  async function reattach(record, { role } = {}) {
    if (!record || typeof record !== 'object') {
      throw new TypeError('createOsDispatchAgentRuntime.reattach requires a run record');
    }
    const requestId = String(
      record.idempotencyKey
      ?? record.request_id
      ?? record.requestId
      ?? record.reattachToken
      ?? '',
    ).trim();
    if (!requestId) {
      return {
        status: 'failed',
        failureClass: 'daemon-bounce',
        usage: null,
        runtimeMode: RUNTIME_MODE,
        detail: 'os-dispatch run record has no request_id to reattach',
      };
    }
    const effectiveRole = role
      || record.role
      || { kind: record.subjectContext?.agentRoleKind === 'remediator' ? 'remediator' : 'reviewer' };
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
      deadlineMs: resolveReattachDeadlineMs(record),
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
  RUNTIME_ID,
  RUNTIME_MODE,
  buildDispatchPayload,
  createOsDispatchAgentRuntime,
  defaultBuildPrompt,
  mapTerminalStatus,
  resolveCompletionShape,
  resolveTaskKind,
};
