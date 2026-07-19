import { loadRoleConfig } from './role-config.mjs';
import { writeFollowUpJob } from './follow-up-jobs.mjs';

// ARC-19 wave5: remediation orchestration-mode & dispatch-path resolution.
// Extracted verbatim from follow-up-remediation.mjs. This leaf owns the
// "which runtime does this remediation take" decision — agent-os/hq vs
// standalone/bare — plus the sticky per-job dispatch-path bookkeeping and the
// legacy hq dispatch-arg builder. It depends only on the role-config loader
// and the follow-up-job writer; it calls nothing in the orchestration core.

const DEFAULT_REMEDIATOR_ENV = 'ADVERSARIAL_REVIEW_DEFAULT_REMEDIATOR';

function markRemediationConfigError(err, { configKey, requestedValue = null } = {}) {
  if (err && err.name === 'AgentOSConfigError') {
    err.isRemediationConfigError = true;
    err.configKey = err.envName || configKey || DEFAULT_REMEDIATOR_ENV;
    err.requestedValue = requestedValue;
  }
  return err;
}

function resolveRemediationOrchestrationMode(env = process.env) {
  let cfg;
  try {
    cfg = loadRoleConfig({
      env,
      contextKey: 'roles.adversarial.orchestration_mode',
    });
  } catch (err) {
    throw markRemediationConfigError(err, {
      configKey: 'roles.adversarial.orchestration_mode',
      requestedValue: env.AGENT_OS_ROLES_ADVERSARIAL_ORCHESTRATION_MODE || null,
    });
  }
  if (typeof cfg?.getOrchestrationMode === 'function') {
    return cfg.getOrchestrationMode() || 'native';
  }
  return cfg?.get?.('roles.adversarial.orchestration_mode', 'native') || 'native';
}

// ARC-08: whether this host is configured for agent-os/hq remediation dispatch.
// This is NO LONGER the runtime fork — the health router owns os-vs-local
// selection at dispatch time (see `resolveRemediationRuntimeMode`). The
// predicate survives only as (a) the boot-time env-completeness check in
// `validateStartupRemediationConfig` and (b) the router-absent fallback the
// mode resolver defers to, preserving pre-router behavior.
function _isAgentOsRemediationMode(env = process.env) {
  if (env.ADV_WITH_HQ_INTEGRATION === '1') return true;
  return resolveRemediationOrchestrationMode(env) === 'agentos';
}

function resolveAdversarialReviewAppMode(env = process.env) {
  return resolveRemediationOrchestrationMode(env) === 'agentos' ? 'agent-os' : 'standalone';
}

function buildLegacyHqRemediationDispatchArgs({
  ticketRef,
  workerClass,
  repo,
  prNumber,
  branch,
  promptPath,
  parentSession,
  project,
  hqRoot,
}) {
  const args = [
    'dispatch',
    '--ticket', ticketRef,
    '--worker-class', workerClass,
    '--prompt', promptPath,
    '--completion-shape', 'branch-push',
    '--parent-session', parentSession,
    '--project', project,
    '--task-kind', 'coding',
    '--repo', normalizeHqDispatchRepo(repo),
    '--pr', String(prNumber),
  ];
  if (branch) args.push('--branch', branch);
  args.push('--root', hqRoot);
  return args;
}

function normalizeHqDispatchRepo(repo) {
  const text = String(repo || '').trim();
  if (!text) return text;
  return text.split('/').filter(Boolean).pop() || text;
}

// The per-job "sticky" dispatch path: a job already dispatched (this round or a
// prior one) must reconcile on the same path it was spawned on. Returns
// 'hq' | 'bare', or null when the job carries no dispatch decision yet.
function stickyRemediationDispatchPath(job) {
  const persisted = String(job?.remediationPlan?.dispatchPath || '').trim();
  if (persisted === 'hq' || persisted === 'bare') {
    return persisted;
  }
  const legacyWorker = job?.remediationWorker || {};
  const legacyMode = String(legacyWorker.dispatchMode || '').trim();
  if (legacyMode === 'hq' || legacyWorker.dispatchId || legacyWorker.launchRequestId) {
    return 'hq';
  }
  if (
    legacyMode === 'bare'
    || legacyWorker.pid
    || legacyWorker.workspaceDir
    || legacyWorker.promptPath
    || legacyWorker.logPath
    || legacyWorker.outputPath
  ) {
    return 'bare';
  }
  return null;
}

// The config-only dispatch-path view: sticky decision, else the env-configured
// default. Production dispatch now routes through `resolveRemediationRuntimeMode`
// (which layers the health router over exactly this fallback); this remains the
// stable query for "what path would config alone pick for this job".
function resolveRemediationDispatchPathForJob(job, env = process.env) {
  return stickyRemediationDispatchPath(job)
    ?? (_isAgentOsRemediationMode(env) ? 'hq' : 'bare');
}

// ARC-08: the health-router-driven remediation runtime selector that replaces
// the old env-only fork. A job with a sticky dispatch path finishes in the mode
// it started (SPEC §6.3 — no mid-flight migration); a fresh job takes the live
// health-router mode ('os' healthy, 'local' after failover) so new remediations
// spawn locally during an app-contract outage. With no router injected the
// selection falls back to the config-derived path, preserving pre-router
// dispatch-path (and thus round/budget) parity with v1.
function resolveRemediationRuntimeMode(job, { healthRouter = null, env = process.env } = {}) {
  const sticky = stickyRemediationDispatchPath(job);
  if (sticky) return sticky === 'hq' ? 'os' : 'local';
  if (healthRouter && typeof healthRouter.getMode === 'function') {
    return healthRouter.getMode() === 'local' ? 'local' : 'os';
  }
  return _isAgentOsRemediationMode(env) ? 'os' : 'local';
}

function persistRemediationDispatchPath({ job, jobPath, dispatchPath } = {}) {
  const normalized = String(dispatchPath || '').trim();
  if (normalized !== 'hq' && normalized !== 'bare') {
    throw new Error(`unknown remediation dispatch path: ${JSON.stringify(dispatchPath)}`);
  }
  if (job?.remediationPlan?.dispatchPath === normalized) {
    return job;
  }
  const updated = {
    ...job,
    remediationPlan: {
      ...(job?.remediationPlan || {}),
      dispatchPath: normalized,
    },
  };
  writeFollowUpJob(jobPath, updated);
  return updated;
}

export {
  DEFAULT_REMEDIATOR_ENV,
  markRemediationConfigError,
  resolveRemediationOrchestrationMode,
  _isAgentOsRemediationMode,
  resolveAdversarialReviewAppMode,
  buildLegacyHqRemediationDispatchArgs,
  normalizeHqDispatchRepo,
  stickyRemediationDispatchPath,
  resolveRemediationDispatchPathForJob,
  resolveRemediationRuntimeMode,
  persistRemediationDispatchPath,
};
