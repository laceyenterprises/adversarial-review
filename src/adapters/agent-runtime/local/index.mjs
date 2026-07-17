// The `local` AgentRuntime (v2 app architecture §6.1) — the first-class
// outage-lifeline runtime, descended from today's `cli-direct` reviewer path.
//
// This is a REFACTOR of cli-direct behind the AgentRuntime port, not a rewrite:
// the process-group isolation, forbidden-fallback env stripping, failure
// classification, and atomic run records under `data/reviewer-runs/` all still
// live in `cli-direct/index.mjs`, which this module composes. ARC-05 ships the
// port + this local impl + its admission layer; the watcher is wired to the
// port (and the old `ReviewerRuntimeAdapter` surface retired) in later tickets.
//
// What this module ADDS on top of cli-direct:
//   - the AgentRuntime `run(request) -> handle{ runRef, mode, await, cancel,
//     reattach }` shape, translating the port request into a cli-direct spawn
//     and the cli-direct result into a structured `RunResult`;
//   - the local admission layer (memory-pressure + quota + per-run cap) that
//     local mode needs because it bypasses OS admission and budget enforcement.

import { createCliDirectReviewerRuntimeAdapter } from '../../reviewer-runtime/cli-direct/index.mjs';
import { readReviewerRunRecord } from '../../reviewer-runtime/run-state.mjs';
import { DEFAULT_LOCAL_RUN_CAP, evaluateLocalAdmission } from './admission.mjs';
import { createHash } from 'node:crypto';

const RUNTIME_ID = 'local';
const RUNTIME_MODE = 'local';

// The reviewer run-state file path forbids `/` and `\`. An idempotency key is a
// composite (`domainId:subjectExternalId:revisionRef:stageId:role:round`) whose
// revisionRef may be a branch name containing slashes, so normalize to a
// filesystem-safe, still-deterministic session id.
function deriveSessionUuid(idempotencyKey) {
  const normalized = String(idempotencyKey || '').trim();
  if (!normalized) {
    throw new TypeError('AgentRunRequest.idempotencyKey is required');
  }
  const filesystemSafe = normalized.replace(/[^A-Za-z0-9._-]+/g, '-');
  const digest = createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  return `${filesystemSafe}-${digest}`;
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
}

// cli-direct itself resolves the reviewer prompt inside the spawned
// `reviewer.mjs` process (from subjectContext), so `prompt` is only load-bearing
// for the OS-dispatch/acpx runtimes. We still forward the subject representation
// so the request round-trips faithfully and so a future non-cli-direct local
// spawn has the material to build from.
function defaultBuildPrompt(request) {
  return String(request?.subjectContent?.representation ?? '');
}

function subjectContextFromRequest(request) {
  const content = request.subjectContent || {};
  const ref = content.ref || {};
  return {
    domainId: ref.domainId || content.domainId || 'code-pr',
    subjectExternalId: ref.subjectExternalId,
    revisionRef: ref.revisionRef,
    agentRoleKind: request.role?.kind,
    reviewerModel: request.role?.model,
    promptSet: request.promptSet,
    promptStage: request.promptStage,
  };
}

function buildReviewerReq(request, sessionUuid, buildPrompt) {
  return {
    model: request.role.model,
    prompt: buildPrompt(request),
    subjectContext: subjectContextFromRequest(request),
    timeoutMs: request.timeoutMs,
    sessionUuid,
    forbiddenFallbacks: request.role.forbiddenFallbacks || [],
    tokenBudget: request.budget?.maxTokens ?? null,
  };
}

function buildRemediatorReq(request, sessionUuid, buildPrompt) {
  return {
    model: request.role.model,
    prompt: buildPrompt(request),
    subjectContext: subjectContextFromRequest(request),
    timeoutMs: request.timeoutMs,
    sessionUuid,
    forbiddenFallbacks: request.role.forbiddenFallbacks || [],
    tokenBudget: request.budget?.maxTokens ?? null,
    workspacePath: request.workspaceRef?.workspacePath,
  };
}

function buildArtifact(role, raw, body) {
  return {
    kind: role?.kind === 'remediator' ? 'remediation' : 'review',
    body: body ?? null,
    stdoutTail: raw?.stdoutTail ?? null,
    stderrTail: raw?.stderrTail ?? null,
    pgid: Number.isInteger(raw?.pgid) ? raw.pgid : null,
    reattachToken: raw?.reattachToken ?? null,
  };
}

function inferRoleFromSubjectContext(subjectContext) {
  const kind = subjectContext?.agentRoleKind;
  if (kind !== 'reviewer' && kind !== 'remediator') return null;
  return {
    kind,
    model: subjectContext?.reviewerModel || subjectContext?.model || 'unknown',
  };
}

function inferEffectiveRole(raw, { role, record } = {}) {
  if (role?.kind) return role;
  return (
    inferRoleFromSubjectContext(raw?.subjectContext)
    || inferRoleFromSubjectContext(record?.subjectContext)
    || { kind: raw?.remediationBody !== undefined ? 'remediator' : 'reviewer' }
  );
}

function normalizeRunFailureClass(failureClass) {
  return failureClass === 'reviewer-timeout'
    ? 'timeout'
    : (failureClass ?? 'unknown');
}

// Map a cli-direct ReviewerRunResult/RemediatorRunResult into a RunResult.
// `cancelled` is tracked on the handle (cli-direct reports an abort as a plain
// failure), so the port can report a truthful `cancelled` status.
function toRunResult(raw, { role, record, cancelled } = {}) {
  const effectiveRole = inferEffectiveRole(raw, { role, record });
  const body = effectiveRole.kind === 'remediator' ? raw?.remediationBody : raw?.reviewBody;
  const usage = raw?.tokenUsage ?? null;
  if (raw?.ok) {
    return {
      status: 'completed',
      artifact: buildArtifact(effectiveRole, raw, body),
      failureClass: null,
      usage,
      runtimeMode: RUNTIME_MODE,
      detail: null,
    };
  }
  let status = 'failed';
  const failureClass = normalizeRunFailureClass(raw?.failureClass);
  if (cancelled) status = 'cancelled';
  else if (failureClass === 'timeout') status = 'timeout';
  return {
    status,
    failureClass,
    usage,
    runtimeMode: RUNTIME_MODE,
    detail: raw?.error || raw?.stderrTail || null,
  };
}

function describeAdmissionRefusal(admission) {
  const layer = admission?.layer ? `${admission.layer}` : 'admission';
  const reason = admission?.reason || 'refused';
  return `local admission refused (${layer}): ${reason}`;
}

function admissionRefusedResult(admission) {
  return {
    status: 'failed',
    failureClass: 'local-admission-refused',
    usage: null,
    runtimeMode: RUNTIME_MODE,
    detail: describeAdmissionRefusal(admission),
  };
}

function settledHandle(runRef, result) {
  return {
    runRef,
    mode: RUNTIME_MODE,
    async await() {
      return result;
    },
    async cancel() {},
    async reattach() {
      return result;
    },
  };
}

function createLocalAgentRuntime({
  rootDir = process.cwd(),
  domainConfig = {},
  cliDirect = null,
  createCliDirectImpl = createCliDirectReviewerRuntimeAdapter,
  cliDirectOptions = {},
  admissionImpl = evaluateLocalAdmission,
  admissionContext = {},
  localRunCap = DEFAULT_LOCAL_RUN_CAP,
  buildPrompt = defaultBuildPrompt,
  readRunRecordImpl = readReviewerRunRecord,
  logger = console,
} = {}) {
  const inner = cliDirect || createCliDirectImpl({
    rootDir,
    domainConfig,
    logger,
    ...cliDirectOptions,
  });

  async function run(request) {
    validateRequest(request);
    const role = request.role;
    const runRef = String(request.idempotencyKey);
    const sessionUuid = deriveSessionUuid(runRef);

    const admission = await admissionImpl({
      reviewerModel: role.model,
      budget: request.budget || {},
      cap: localRunCap,
      logger,
      ...admissionContext,
    });
    if (!admission || admission.admit === false) {
      return settledHandle(runRef, admissionRefusedResult(admission || {}));
    }

    const effectiveBudget = admission.budget || {};
    const capWallMs = effectiveBudget.requestedWallMs;
    const requestedTimeoutMs = Number(request.timeoutMs);
    const timeoutMs = Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0
      ? Math.min(requestedTimeoutMs, capWallMs ?? requestedTimeoutMs)
      : capWallMs;
    const admittedRequest = {
      ...request,
      timeoutMs,
      budget: {
        ...request.budget,
        maxTokens: effectiveBudget.requestedTokens,
        maxWallMs: capWallMs,
      },
    };

    const cancelled = { value: false };
    // cli-direct spawn impls resolve (never reject) with a structured result;
    // guard defensively so a programmer error in an injected impl still yields
    // a RunResult rather than an unhandled rejection.
    const guarded = Promise.resolve().then(() => (
      role.kind === 'remediator'
        ? inner.spawnRemediator(buildRemediatorReq(admittedRequest, sessionUuid, buildPrompt))
        : inner.spawnReviewer(buildReviewerReq(admittedRequest, sessionUuid, buildPrompt))
    )).catch((err) => ({
      ok: false,
      failureClass: 'bug',
      error: err?.message || String(err),
      stderrTail: err?.message || String(err),
    }));

    return {
      runRef,
      mode: RUNTIME_MODE,
      async await() {
        const raw = await guarded;
        return toRunResult(raw, { role, cancelled: cancelled.value });
      },
      async cancel() {
        cancelled.value = true;
        if (typeof inner.cancel === 'function') {
          await inner.cancel(sessionUuid);
        }
      },
      async reattach() {
        const record = readRunRecordImpl(rootDir, sessionUuid);
        if (!record) {
          return {
            status: 'failed',
            failureClass: 'daemon-bounce',
            usage: null,
            runtimeMode: RUNTIME_MODE,
            detail: `no local run record for ${sessionUuid}`,
          };
        }
        const raw = await inner.reattach(record);
        return toRunResult(raw, { role, record, cancelled: cancelled.value });
      },
    };
  }

  // Re-adopt an in-flight run from its durable record after a kernel restart.
  // The strict AgentRuntime port only exposes `reattach()` on a live handle;
  // this record-scoped entrypoint is the superset the crash-recovery path
  // (ARC-06/07) needs, since after a restart the caller holds a run record —
  // read from `data/reviewer-runs/` — rather than a handle. When the durable
  // record lacks a role, result payload shape preserves reviewer/remediator
  // classification without discarding remediation output.
  async function reattach(record, { role } = {}) {
    if (!record || typeof record !== 'object') {
      throw new TypeError('createLocalAgentRuntime.reattach requires a run record');
    }
    const raw = await inner.reattach(record);
    return toRunResult(raw, { role, record });
  }

  function describe() {
    const innerDescribe = typeof inner.describe === 'function' ? inner.describe() : {};
    return {
      id: RUNTIME_ID,
      mode: RUNTIME_MODE,
      capabilities: innerDescribe.capabilities || {
        processGroupIsolation: true,
        daemonBounceSafe: false,
        heartbeatPersisted: false,
        leaseManaged: false,
        oauthStripEnforced: true,
      },
    };
  }

  return {
    run,
    reattach,
    describe,
    __inner: inner,
  };
}

export {
  DEFAULT_LOCAL_RUN_CAP,
  createLocalAgentRuntime,
  defaultBuildPrompt,
  deriveSessionUuid,
  evaluateLocalAdmission,
  subjectContextFromRequest,
  toRunResult,
};
