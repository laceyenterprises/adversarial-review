import { readCanaryStatus } from './adapters/agent-runtime/canary.mjs';
import { readRuntimeStatusSnapshot } from './runtime-status-snapshot.mjs';

const DEFAULT_RUNTIME = 'cli-direct';
const AGENTOS_FALLBACK_RUNTIME = 'agent-os-hq';
const CUTOVER_RUNTIME = 'agent-runtime';
const KNOWN_REVIEWER_RUNTIME_NAMES = new Set([
  'agent-runtime',
  'acpx',
  'cli-direct',
  'fixture-stub',
  'agent-os-hq',
]);

function trimEnvOverride(env = process.env) {
  return String(env?.ADVERSARIAL_REVIEWER_RUNTIME || '').trim();
}

function detail(code, message) {
  return { code, message };
}

function requestedReviewerRuntime(domainConfig = {}) {
  return String(domainConfig?.reviewerRuntime || DEFAULT_RUNTIME).trim() || DEFAULT_RUNTIME;
}

function isAgentOsOrchestrationMode(orchestrationMode) {
  return String(orchestrationMode || '').trim().toLowerCase() === 'agentos';
}

function fallbackRuntimeForOrchestrationMode(orchestrationMode = 'native') {
  return isAgentOsOrchestrationMode(orchestrationMode) ? AGENTOS_FALLBACK_RUNTIME : DEFAULT_RUNTIME;
}

function selectedRuntimeForNonCutover(requestedRuntime, orchestrationMode = 'native') {
  return isAgentOsOrchestrationMode(orchestrationMode)
    ? AGENTOS_FALLBACK_RUNTIME
    : requestedRuntime;
}

function evaluateAgentRuntimeCutoverReadiness({
  rootDir,
  domainConfig = {},
  orchestrationMode = 'native',
  now = () => new Date(),
  readSnapshotImpl = readRuntimeStatusSnapshot,
  readCanaryImpl = readCanaryStatus,
} = {}) {
  const requestedRuntime = requestedReviewerRuntime(domainConfig);
  const domainId = String(domainConfig?.id || 'unknown').trim() || 'unknown';
  const reasons = [];
  let snapshot = null;
  let canary = null;

  if (requestedRuntime !== CUTOVER_RUNTIME) {
    return {
      domainId,
      requestedRuntime,
      selectedRuntime: selectedRuntimeForNonCutover(requestedRuntime, orchestrationMode),
      ready: false,
      state: 'not-requested',
      reasons: [],
      snapshot: null,
      canary: null,
      evaluatedAt: now().toISOString(),
    };
  }

  if (domainConfig?.agentRuntimeSettleSmokeVerified !== true) {
    reasons.push(detail(
      'settle-smoke-unverified',
      'domain config has not attested a passing agent-runtime settle smoke',
    ));
  }
  if (orchestrationMode !== 'agentos') {
    reasons.push(detail(
      'orchestration-mode-mismatch',
      `roles.adversarial.orchestration_mode must be 'agentos' (got ${JSON.stringify(orchestrationMode)})`,
    ));
  }

  if (rootDir) {
    snapshot = readSnapshotImpl(rootDir);
    canary = readCanaryImpl(rootDir);
  }
  const status = snapshot?.status || null;
  if (!status) {
    reasons.push(detail('runtime-status-missing', 'runtime status snapshot is absent or unreadable'));
  } else {
    if (status?.config?.enabled !== true) {
      reasons.push(detail('hybrid-router-disabled', 'hybrid health router is not enabled'));
    }
    if (status?.mode !== 'os') {
      reasons.push(detail(
        'runtime-not-os-healthy',
        `runtime status mode must be 'os' for cutover (got ${JSON.stringify(status?.mode || 'unknown')})`,
      ));
    }
    if (status?.probe?.healthy !== true) {
      reasons.push(detail('runtime-probe-degraded', 'runtime status probe is degraded or unknown'));
    }
  }

  if (!canary) {
    reasons.push(detail('fallback-canary-missing', 'fallback canary has never completed successfully'));
  } else if (String(canary.status || '').toLowerCase() !== 'pass') {
    reasons.push(detail(
      'fallback-canary-failed',
      `fallback canary status must be PASS (got ${JSON.stringify(canary.status || 'unknown')})`,
    ));
  }

  const ready = reasons.length === 0;
  return {
    domainId,
    requestedRuntime,
    selectedRuntime: ready ? CUTOVER_RUNTIME : fallbackRuntimeForOrchestrationMode(orchestrationMode),
    ready,
    state: ready ? 'ready' : 'refused',
    reasons,
    snapshot,
    canary,
    evaluatedAt: now().toISOString(),
  };
}

function resolveReviewerRuntimeCutover({
  rootDir,
  domainConfig = {},
  orchestrationMode = 'native',
  env = process.env,
  now = () => new Date(),
  readSnapshotImpl = readRuntimeStatusSnapshot,
  readCanaryImpl = readCanaryStatus,
} = {}) {
  const forced = trimEnvOverride(env);
  const readiness = evaluateAgentRuntimeCutoverReadiness({
    rootDir,
    domainConfig,
    orchestrationMode,
    now,
    readSnapshotImpl,
    readCanaryImpl,
  });
  if (forced && KNOWN_REVIEWER_RUNTIME_NAMES.has(forced)) {
    return {
      ...readiness,
      state: 'forced',
      forcedRuntime: forced,
      selectedRuntime: forced,
      reasons: [
        detail(
          'env-kill-switch',
          `ADVERSARIAL_REVIEWER_RUNTIME forced ${JSON.stringify(forced)}`,
        ),
      ],
    };
  }
  return readiness;
}

export {
  AGENTOS_FALLBACK_RUNTIME,
  CUTOVER_RUNTIME,
  DEFAULT_RUNTIME,
  evaluateAgentRuntimeCutoverReadiness,
  fallbackRuntimeForOrchestrationMode,
  KNOWN_REVIEWER_RUNTIME_NAMES,
  requestedReviewerRuntime,
  resolveReviewerRuntimeCutover,
  trimEnvOverride,
};
