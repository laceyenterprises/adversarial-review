import { createHealthRouter } from '../../agent-runtime/router/index.mjs';
import { createLocalAgentRuntime, deriveSessionUuid } from '../../agent-runtime/local/index.mjs';
import { createOsDispatchAgentRuntime } from '../../agent-runtime/os-dispatch/index.mjs';
import { wrapRuntimeWithRunLedger } from '../../agent-runtime/run-ledger.mjs';
import {
  claimReviewerRunRecord,
  settleReviewerRunRecord,
  updateReviewerRunRecord,
} from '../run-state.mjs';
import {
  loadStagePrompt,
  pickRemediatorStage,
  pickReviewerStage,
  resolvePromptSet,
} from '../../../kernel/prompt-stage.mjs';
import { loadDomainConfig } from '../../../domain-config.mjs';

const RUNTIME_ID = 'agent-runtime';
const DEFAULT_REVIEW_BUDGET = Object.freeze({
  maxTokens: 500_000,
  maxWallMs: 30 * 60 * 1000,
});

function subjectExternalId({ repo, prNumber, subjectExternalId }) {
  const explicit = String(subjectExternalId || '').trim();
  if (explicit) return explicit;
  return `${repo}#${prNumber}`;
}

function roleIdFor(kind, req) {
  const explicit = String(req.roleId || req.reviewerRoleId || '').trim();
  if (explicit) return explicit;
  const model = String(req.model || '').trim() || 'unknown';
  return `${kind}:${model}`;
}

function reviewIdempotencyKey(req, { roleId }) {
  const ctx = req.subjectContext || req;
  const domainId = String(ctx.domainId || 'code-pr').trim();
  const externalId = subjectExternalId(ctx);
  const revisionRef = String(ctx.reviewerHeadSha || ctx.revisionRef || '').trim();
  const stageId = String(ctx.stageId || 'review').trim();
  const round = Number(ctx.reviewAttemptNumber ?? ctx.reviewDbAttemptNumber ?? 1);
  return [
    domainId,
    externalId,
    revisionRef || 'unknown-revision',
    stageId,
    roleId,
    Number.isFinite(round) && round > 0 ? Math.floor(round) : 1,
  ].join(':');
}

function remediationRoundFromContext(ctx = {}) {
  const explicit = Number(ctx.remediationRound);
  if (Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit);
  const completed = Number(ctx.completedRemediationRounds);
  if (Number.isFinite(completed) && completed >= 0) return Math.floor(completed) + 1;
  return 1;
}

function remediatorIdempotencyKey(req, { roleId }) {
  const ctx = req.subjectContext || req;
  const domainId = String(ctx.domainId || 'code-pr').trim();
  const externalId = subjectExternalId(ctx);
  const revisionRef = String(ctx.reviewerHeadSha || ctx.revisionRef || '').trim();
  const round = remediationRoundFromContext(ctx);
  return [
    domainId,
    externalId,
    revisionRef || 'unknown-revision',
    'remediation',
    roleId,
    Number.isFinite(round) && round > 0 ? Math.floor(round) : 1,
  ].join(':');
}

function explicitPromptFrom(req, ctx) {
  const prompt = req.prompt ?? ctx.prompt;
  const text = String(prompt ?? '');
  return text.trim() ? text : '';
}

function fallbackPromptFromContext({ kind, domainId, promptSet, promptStage, ctx }) {
  const role = kind === 'remediator' ? 'remediator' : 'reviewer';
  const externalId = subjectExternalId(ctx);
  const revisionRef = String(ctx.reviewerHeadSha || ctx.revisionRef || '').trim();
  const action = kind === 'remediator'
    ? 'Produce the branch-push remediation artifact for the referenced subject.'
    : 'Produce the decision-only adversarial-review artifact for the referenced subject.';
  return [
    `Agent OS ${role} dispatch`,
    '',
    action,
    `Domain: ${domainId}`,
    `Subject: ${externalId}`,
    `Revision: ${revisionRef || 'unknown-revision'}`,
    `Prompt set: ${promptSet}`,
    `Prompt stage: ${promptStage}`,
  ].join('\n');
}

function domainConfigForRequest({ rootDir, domainConfig, domainId }) {
  if (domainConfig?.promptSet) return domainConfig;
  if (!rootDir) return domainConfig || null;
  return loadDomainConfig(rootDir, domainId);
}

function promptRepresentationFrom(req, {
  kind,
  rootDir,
  domainConfig,
  domainId,
  promptSet,
  promptStage,
}) {
  const ctx = req.subjectContext || req;
  const explicitPrompt = explicitPromptFrom(req, ctx);
  if (explicitPrompt) return explicitPrompt;

  if (rootDir) {
    const resolvedDomainConfig = domainConfigForRequest({ rootDir, domainConfig, domainId });
    const resolvedPromptSet = resolvedDomainConfig
      ? resolvePromptSet({ rootDir, domainConfig: resolvedDomainConfig, domainId })
      : promptSet;
    if (resolvedPromptSet) {
      return loadStagePrompt({
        rootDir,
        promptSet: resolvedPromptSet,
        actor: kind === 'remediator' ? 'remediator' : 'reviewer',
        stage: promptStage,
      });
    }
  }

  return fallbackPromptFromContext({ kind, domainId, promptSet, promptStage, ctx });
}

function subjectContentFrom(req, {
  kind,
  rootDir,
  domainConfig,
  domainId,
  promptSet,
  promptStage,
}) {
  const ctx = req.subjectContext || req;
  const externalId = subjectExternalId(ctx);
  const revisionRef = String(ctx.reviewerHeadSha || ctx.revisionRef || '').trim();
  return {
    ref: {
      domainId,
      subjectExternalId: externalId,
      revisionRef,
      linearTicketId: ctx.linearTicketId,
    },
    representation: promptRepresentationFrom(req, {
      kind,
      rootDir,
      domainConfig,
      domainId,
      promptSet,
      promptStage,
    }),
    observedAt: new Date().toISOString(),
  };
}

function reviewPromptStage(ctx = {}) {
  return pickReviewerStage({
    reviewAttemptNumber: ctx.reviewAttemptNumber,
    completedRemediationRounds: ctx.completedRemediationRounds,
    maxRemediationRounds: ctx.maxRemediationRounds,
  });
}

function remediatorPromptStage(ctx = {}) {
  return pickRemediatorStage({
    remediationRound: remediationRoundFromContext(ctx),
    maxRemediationRounds: ctx.maxRemediationRounds,
  });
}

function toAgentRequest(req, { kind, rootDir = null, domainConfig = null }) {
  const ctx = req.subjectContext || req;
  const domainId = String(ctx.domainId || 'code-pr').trim();
  const roleId = roleIdFor(kind, req);
  const idempotencyKey = kind === 'remediator'
    ? remediatorIdempotencyKey(req, { roleId })
    : reviewIdempotencyKey(req, { roleId });
  const promptSet = String(req.promptSet || ctx.promptSet || domainId);
  const promptStage = kind === 'remediator' ? remediatorPromptStage(ctx) : reviewPromptStage(ctx);
  return {
    role: {
      id: roleId,
      kind,
      model: String(req.model || '').trim(),
      forbiddenFallbacks: req.forbiddenFallbacks || [],
    },
    promptSet,
    promptStage,
    subjectContent: subjectContentFrom(req, {
      kind,
      rootDir,
      domainConfig,
      domainId,
      promptSet,
      promptStage,
    }),
    ...(req.workspacePath ? { workspaceRef: { workspacePath: req.workspacePath } } : {}),
    idempotencyKey,
    budget: {
      maxTokens: req.tokenBudget ?? DEFAULT_REVIEW_BUDGET.maxTokens,
      maxWallMs: req.timeoutMs ?? DEFAULT_REVIEW_BUDGET.maxWallMs,
    },
    timeoutMs: req.timeoutMs ?? DEFAULT_REVIEW_BUDGET.maxWallMs,
  };
}

function mapFailureClass(result) {
  if (result?.status === 'timeout' || result?.failureClass === 'timeout') return 'reviewer-timeout';
  if (result?.status === 'cancelled') return 'cancelled';
  return result?.failureClass || 'unknown';
}

function baseResult(result) {
  const detail = result?.detail || null;
  return {
    failureClass: result?.status === 'completed' ? null : mapFailureClass(result),
    stderrTail: detail,
    stdoutTail: null,
    stderr: detail,
    stdout: null,
    exitCode: result?.status === 'completed' ? 0 : null,
    signal: null,
    pgid: Number.isInteger(result?.artifact?.pgid) ? result.artifact.pgid : null,
    spawnedAt: new Date().toISOString(),
    reattachToken: result?.artifact?.reattachToken || null,
    tokenUsage: result?.usage || null,
    runtimeMode: result?.runtimeMode || null,
  };
}

function toReviewerResult(result, { idempotencyKey }) {
  const body = result?.artifact?.body ?? null;
  const ok = result?.status === 'completed' && typeof body === 'string' && body.length > 0;
  return {
    ok,
    reviewBody: ok ? body : null,
    ...baseResult(result),
    failureClass: ok ? null : (result?.status === 'completed' ? 'reviewer-output' : mapFailureClass(result)),
    reattachToken: result?.artifact?.reattachToken || idempotencyKey,
  };
}

function toRemediatorResult(result, { idempotencyKey }) {
  const body = result?.artifact?.body ?? null;
  const ok = result?.status === 'completed' && typeof body === 'string' && body.length > 0;
  return {
    ok,
    remediationBody: ok ? body : null,
    ...baseResult(result),
    failureClass: ok ? null : (result?.status === 'completed' ? 'reviewer-output' : mapFailureClass(result)),
    reattachToken: result?.artifact?.reattachToken || idempotencyKey,
  };
}

function createDefaultAgentRuntime({
  rootDir,
  domainConfig,
  logger,
  routerOptions = {},
  localRuntimeOptions = {},
  osRuntimeOptions = {},
} = {}) {
  const localRuntime = createLocalAgentRuntime({
    rootDir,
    domainConfig,
    logger,
    ...localRuntimeOptions,
  });
  const osRuntime = createOsDispatchAgentRuntime({
    logger,
    ...osRuntimeOptions,
  });
  return createHealthRouter({
    rootDir,
    localRuntime,
    osRuntime,
    logger,
    ...routerOptions,
  });
}

function createAgentRuntimeReviewerRuntimeAdapter({
  rootDir,
  domainConfig = {},
  agentRuntime = null,
  createAgentRuntimeImpl = createDefaultAgentRuntime,
  logger = console,
  now = () => new Date(),
  ...runtimeOptions
} = {}) {
  const rawRuntime = agentRuntime || createAgentRuntimeImpl({
    rootDir,
    domainConfig,
    logger,
    ...runtimeOptions,
  });
  const runtime = wrapRuntimeWithRunLedger(rawRuntime, {
    rootDir,
    domainId: domainConfig?.id || 'code-pr',
    logger,
  });
  const activeHandles = new Map();

  async function runWithRecord(agentRequest, req, { kind }) {
    const sessionUuid = String(req.sessionUuid || '').trim();
    if (!sessionUuid) throw new TypeError(`${RUNTIME_ID} ${kind} run requires sessionUuid`);
    const agentRuntimeSessionUuid = deriveSessionUuid(agentRequest.idempotencyKey);
    const record = {
      sessionUuid,
      domain: agentRequest.subjectContent.ref.domainId,
      runtime: RUNTIME_ID,
      state: 'spawned',
      pgid: null,
      spawnedAt: now().toISOString(),
      lastHeartbeatAt: null,
      reattachToken: agentRequest.idempotencyKey,
      subjectContext: {
        ...req.subjectContext,
        agentRoleKind: kind,
        reviewerModel: agentRequest.role.model,
        idempotencyKey: agentRequest.idempotencyKey,
        agentRuntimeMode: null,
        agentRuntimeSessionUuid,
        promptSet: agentRequest.promptSet,
        promptStage: agentRequest.promptStage,
        timeoutMs: agentRequest.timeoutMs,
        budget: agentRequest.budget,
      },
    };
    const claimed = claimReviewerRunRecord(rootDir, record);
    if (!claimed.claimed && activeHandles.has(sessionUuid)) {
      const result = await activeHandles.get(sessionUuid).reattach();
      return { result, idempotencyKey: agentRequest.idempotencyKey };
    }
    if (!claimed.claimed) {
      if (typeof runtime.reattach !== 'function') {
        throw new Error(`${RUNTIME_ID} ${kind} run lease is already held and runtime cannot reattach`);
      }
      const result = await runtime.reattach?.(claimed.record, { role: agentRequest.role });
      return { result, idempotencyKey: agentRequest.idempotencyKey };
    }

    function settleFailed(err) {
      try {
        settleReviewerRunRecord(rootDir, sessionUuid, {
          state: 'failed',
          settledAt: now().toISOString(),
        });
      } catch (settleErr) {
        logger.warn?.(`${RUNTIME_ID} ${kind} run failed-state settle failed`, {
          sessionUuid,
          error: settleErr?.message || String(settleErr),
        });
      }
      throw err;
    }

    let handle;
    try {
      handle = await runtime.run(agentRequest);
    } catch (err) {
      settleFailed(err);
    }
    try {
      activeHandles.set(sessionUuid, handle);
      updateReviewerRunRecord(rootDir, claimed.record || record, {
        reattachToken: handle.runRef,
        subjectContext: {
          ...record.subjectContext,
          agentRuntimeMode: handle.mode,
        },
      });
    } catch (err) {
      activeHandles.delete(sessionUuid);
      try {
        await handle.cancel();
      } catch (cancelErr) {
        logger.warn?.(`${RUNTIME_ID} ${kind} run rollback cancel failed`, {
          sessionUuid,
          error: cancelErr?.message || String(cancelErr),
        });
      }
      throw err;
    }
    try {
      const result = await handle.await();
      const artifactBody = result?.artifact?.body;
      const completedWithBody = result.status === 'completed'
        && typeof artifactBody === 'string'
        && artifactBody.length > 0;
      settleReviewerRunRecord(rootDir, sessionUuid, {
        state: completedWithBody ? 'completed' : (result.status === 'cancelled' ? 'cancelled' : 'failed'),
        settledAt: now().toISOString(),
      });
      return { result, idempotencyKey: handle.runRef };
    } catch (err) {
      settleFailed(err);
    } finally {
      activeHandles.delete(sessionUuid);
    }
  }

  async function spawnReviewer(req = {}) {
    const agentRequest = toAgentRequest(req, { kind: 'reviewer', rootDir, domainConfig });
    const { result, idempotencyKey } = await runWithRecord(agentRequest, req, { kind: 'reviewer' });
    return toReviewerResult(result, { idempotencyKey });
  }

  async function spawnRemediator(req = {}) {
    const agentRequest = toAgentRequest(req, { kind: 'remediator', rootDir, domainConfig });
    const { result, idempotencyKey } = await runWithRecord(agentRequest, req, { kind: 'remediator' });
    return toRemediatorResult(result, { idempotencyKey });
  }

  async function cancel(sessionUuid) {
    const handle = activeHandles.get(sessionUuid);
    try {
      if (handle) await handle.cancel();
    } catch (err) {
      logger.warn?.(`${RUNTIME_ID} cancel failed`, {
        sessionUuid,
        error: err?.message || String(err),
      });
    } finally {
      activeHandles.delete(sessionUuid);
      settleReviewerRunRecord(rootDir, sessionUuid, {
        state: 'cancelled',
        settledAt: now().toISOString(),
      });
    }
  }

  async function reattach(record) {
    const roleKind = record?.subjectContext?.agentRoleKind === 'remediator' ? 'remediator' : 'reviewer';
    const role = {
      id: roleIdFor(roleKind, { model: record?.subjectContext?.reviewerModel || 'unknown' }),
      kind: roleKind,
      model: record?.subjectContext?.reviewerModel || 'unknown',
    };
    const result = activeHandles.has(record.sessionUuid)
      ? await activeHandles.get(record.sessionUuid).reattach()
      : await runtime.reattach(record, { role });
    return roleKind === 'remediator'
      ? toRemediatorResult(result, { idempotencyKey: record.reattachToken })
      : toReviewerResult(result, { idempotencyKey: record.reattachToken });
  }

  function describe() {
    const described = typeof runtime.describe === 'function' ? runtime.describe() : {};
    return {
      id: RUNTIME_ID,
      modelFamily: 'agent-runtime',
      capabilities: described.capabilities || {
        processGroupIsolation: true,
        daemonBounceSafe: true,
        heartbeatPersisted: true,
        leaseManaged: true,
        oauthStripEnforced: true,
      },
    };
  }

  return {
    spawnReviewer,
    spawnRemediator,
    cancel,
    reattach,
    describe,
    __runtime: runtime,
  };
}

export {
  RUNTIME_ID,
  createAgentRuntimeReviewerRuntimeAdapter,
  createDefaultAgentRuntime,
  reviewIdempotencyKey,
  toAgentRequest,
  toReviewerResult,
};
