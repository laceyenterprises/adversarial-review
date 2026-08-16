import { execFile } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { spawnDetachedCli } from '../../reviewer-runtime/cli-direct/process.mjs';
import { isPgidAlive, verifyPgidIdentity } from '../../../process-group-identity.mjs';
import { materializePerWorkerCodexAuth } from '../../../codex-per-worker-auth.mjs';
import {
  GEMINI_REMEDIATION_WORKER_TRAILER_CLASS,
  REMEDIATION_WORKER_TRAILER_CLASS,
  remediationWorkerGitIdentity,
  remediationWorkerPushProvider,
} from '../../../remediation-worker-provenance.mjs';
import { requireWorkerReplyContext } from '../../../remediation-reply-paths.mjs';
import { scrubOAuthFallbackEnv, OAUTH_ENV_STRIP_LIST } from '../../../secret-source/env.mjs';

const execFileAsync = promisify(execFile);
const DEFAULT_PATH_PREFIX = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
const DEFAULT_GEMINI_REMEDIATION_MODEL = 'gemini-2.5-pro';
const DEFAULT_CODEX_REMEDIATION_MODEL = 'gpt-5.5';
const DEFAULT_POLL_MS = 250;
const IDENTITY_PROBE_RETRY_DELAYS_MS = Object.freeze([50, 100, 200]);
const TRANSIENT_IDENTITY_PROBE_RE = /ps probe failed.*(?:EIO|EAGAIN|ETIMEDOUT|timeout|timed out|resource temporarily unavailable|input\/output error)/i;
const GEMINI_OAUTH_FALLBACK_ENV_STRIP_LIST = Object.freeze([
  ...OAUTH_ENV_STRIP_LIST,
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_GENAI_USE_VERTEXAI',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
  'GOOGLE_CLOUD_QUOTA_PROJECT',
  'CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE',
]);

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

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function buildInheritedPath(currentPath = process.env.PATH || '') {
  const segments = [...DEFAULT_PATH_PREFIX, ...String(currentPath).split(':').filter(Boolean)];
  return [...new Set(segments)].join(':');
}

function resolveCodexCliPath(env = process.env) {
  return env.CODEX_CLI_PATH || env.CODEX_CLI || 'codex';
}

function resolveClaudeCodeCliPath(env = process.env) {
  return env.CLAUDE_CODE_CLI_PATH || env.CLAUDE_CLI || 'claude';
}

function resolveGeminiCliPath(env = process.env) {
  return env.GEMINI_CLI_PATH || env.GEMINI_CLI || 'gemini';
}

function resolveCodexAuthPath(env = process.env) {
  if (env.CODEX_AUTH_PATH) return env.CODEX_AUTH_PATH;
  const codexHome = env.CODEX_HOME || join(env.HOME || homedir(), '.codex');
  return join(codexHome, 'auth.json');
}

function resolveCodexAuthHome(authPath) {
  const normalizedAuthPath = resolve(authPath);
  const segments = normalizedAuthPath.split('/').filter(Boolean);
  if (segments[0] === 'Users' && segments[1]) return `/${segments[0]}/${segments[1]}`;
  return dirname(dirname(normalizedAuthPath));
}

function resolveCodexAuthOwner(authPath) {
  const homePath = resolveCodexAuthHome(authPath);
  const segments = homePath.split('/').filter(Boolean);
  return segments.at(-1) || null;
}

function buildCodexStartupPolicyViolation({ reason, requestedValue = null, resolvedValue = null }) {
  return {
    kind: 'startup-policy-violation',
    reason,
    requested_value: requestedValue,
    resolved_value: resolvedValue,
  };
}

const MERGE_AGENT_BROKER_TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const MERGE_AGENT_BROKER_FALSEY = new Set(['0', 'false', 'no', 'off']);
const DEFAULT_OAUTH_BROKER_URL = 'http://127.0.0.1:4099';
const DEFAULT_OAUTH_BROKER_STANDBY_URL = 'http://127.0.0.1:4097';
function parseMergeAgentBrokerFlag(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return { enabled: false, recognized: true, raw };
  const normalized = raw.toLowerCase();
  if (MERGE_AGENT_BROKER_TRUTHY.has(normalized)) return { enabled: true, recognized: true, raw };
  if (MERGE_AGENT_BROKER_FALSEY.has(normalized)) return { enabled: false, recognized: true, raw };
  return { enabled: false, recognized: false, raw };
}

// Resolve the expected App-id / installation-id pin (kind is 'APP_ID' or
// 'INSTALLATION_ID') that the downstream push path validates the minted token
// against. The pin MUST match the RESOLVED provider, never a stale merge-agent
// pin — validating a per-harness token against merge-agent's app id would fail
// closed and break the push (the #5058 fix must never make the default "push
// fails"). Precedence: an explicit per-harness pin
// (OAUTH_BROKER_REMEDIATION_<CLASS>_EXPECTED_<KIND>) wins; the legacy
// OAUTH_BROKER_MERGE_AGENT_EXPECTED_<KIND> pin is honored ONLY when the provider
// actually resolved to the merge-agent fallback.
function resolveHarnessExpectedPin(sourceEnv, workerClass, resolvedProvider, kind) {
  const suffix = String(workerClass || '').toUpperCase().replace(/-/g, '_');
  const perHarness = suffix
    ? String(sourceEnv[`OAUTH_BROKER_REMEDIATION_${suffix}_EXPECTED_${kind}`] || '').trim()
    : '';
  if (perHarness) return perHarness;
  if (resolvedProvider.source === 'merge-agent-fallback' || resolvedProvider.source === 'workflow-push-merge-agent') {
    return String(sourceEnv[`OAUTH_BROKER_MERGE_AGENT_EXPECTED_${kind}`] || '').trim() || '';
  }
  return '';
}

// Inject the broker env a remediation worker's git push / gh calls authenticate
// through, keyed off the PHYSICAL harness class. Gated on MERGE_AGENT_AUTH_VIA_BROKER
// (unchanged). The provider is resolved per-harness (remediationWorkerPushProvider);
// the transport var name OAUTH_BROKER_MERGE_AGENT_PROVIDER is preserved (that is
// what the downstream push path reads) but its VALUE is now the harness's own App,
// never a hardcoded merge-agent provider. A harness with no known push-capable App
// falls back to merge-agent LOUDLY (warn + evidence.fellBack) so the push never
// silently fails.
function applyMergeAgentBrokerEnv(
  env,
  sourceEnv = process.env,
  { workerClass = null, log = console, requiresWorkflowPush = false } = {},
) {
  const parsedFlag = parseMergeAgentBrokerFlag(sourceEnv.MERGE_AGENT_AUTH_VIA_BROKER);
  const workflowPushEscalationEnabled = requiresWorkflowPush
    && String(sourceEnv.ADVERSARIAL_REMEDIATION_WORKFLOW_PUSH_ESCALATE_TO_MERGE_AGENT || '').trim().toLowerCase() !== 'false';
  const brokerEnabled = parsedFlag.enabled || workflowPushEscalationEnabled;
  const evidence = {
    enabled: brokerEnabled,
    flagValue: parsedFlag.raw || null,
    warning: parsedFlag.recognized
      ? null
      : (workflowPushEscalationEnabled
          ? 'MERGE_AGENT_AUTH_VIA_BROKER value not recognized; workflow-push broker env forced by workflow escalation'
          : 'MERGE_AGENT_AUTH_VIA_BROKER value not recognized; broker env not propagated'),
  };
  if (!brokerEnabled) return evidence;

  const brokerUrl = sourceEnv.OAUTH_BROKER_URL || DEFAULT_OAUTH_BROKER_URL;
  const standbyUrl = sourceEnv.OAUTH_BROKER_STANDBY_URL || DEFAULT_OAUTH_BROKER_STANDBY_URL;
  const resolvedProvider = remediationWorkerPushProvider(workerClass, sourceEnv, { requiresWorkflowPush });
  const provider = resolvedProvider.provider;
  env.MERGE_AGENT_AUTH_VIA_BROKER = 'true';
  env.OAUTH_BROKER_URL = brokerUrl;
  env.OAUTH_BROKER_STANDBY_URL = standbyUrl;
  env.OAUTH_BROKER_MERGE_AGENT_PROVIDER = provider;
  if (sourceEnv.OAUTH_BROKER_SHARED_SECRET_FILE) {
    env.OAUTH_BROKER_SHARED_SECRET_FILE = sourceEnv.OAUTH_BROKER_SHARED_SECRET_FILE;
  }
  // Be authoritative over the expected-pin transport vars: SET them from the
  // resolved pin, or DELETE any value inherited from the daemon env. A stale
  // merge-agent pin surviving next to a per-harness provider would fail the
  // downstream token/app validation closed and break the push.
  const expectedAppId = resolveHarnessExpectedPin(sourceEnv, workerClass, resolvedProvider, 'APP_ID');
  const expectedInstallationId = resolveHarnessExpectedPin(sourceEnv, workerClass, resolvedProvider, 'INSTALLATION_ID');
  if (expectedAppId) env.OAUTH_BROKER_MERGE_AGENT_EXPECTED_APP_ID = expectedAppId;
  else delete env.OAUTH_BROKER_MERGE_AGENT_EXPECTED_APP_ID;
  if (expectedInstallationId) env.OAUTH_BROKER_MERGE_AGENT_EXPECTED_INSTALLATION_ID = expectedInstallationId;
  else delete env.OAUTH_BROKER_MERGE_AGENT_EXPECTED_INSTALLATION_ID;

  if (resolvedProvider.fellBack && resolvedProvider.warning) {
    log?.warn?.(`[follow-up-remediation] harness-push-fallback: ${resolvedProvider.warning}`);
  }

  return {
    ...evidence,
    brokerUrl,
    standbyUrl,
    provider,
    providerSource: resolvedProvider.source,
    harnessClass: resolvedProvider.harnessClass,
    harnessIdentityHonored: resolvedProvider.honored,
    fellBack: resolvedProvider.fellBack,
    requiresWorkflowPush: Boolean(resolvedProvider.requiresWorkflowPush),
    fallbackWarning: resolvedProvider.warning,
    requiresWorkflowPush: Boolean(requiresWorkflowPush),
    expectedAppId: expectedAppId || null,
    expectedInstallationId: expectedInstallationId || null,
    sharedSecretFile: sourceEnv.OAUTH_BROKER_SHARED_SECRET_FILE || null,
  };
}

class HarnessIdentityMismatchError extends Error {
  constructor(message, { workerClass = null, mismatches = [], enforced = true } = {}) {
    super(message);
    this.name = 'HarnessIdentityMismatchError';
    this.isHarnessIdentityMismatch = true;
    this.isPolicyViolation = true;
    this.violationType = 'harness-identity-mismatch';
    this.workerClass = workerClass;
    this.mismatches = mismatches;
    this.enforced = enforced;
  }
}

// Fail-closed assert at the spawn boundary: the git identity AND (when broker
// mode is on) the push provider a remediation worker is about to run under MUST
// match its PHYSICAL harness class. Because every prepare fn now sets the
// per-harness identity, this never fires for a real codex/claude-code/gemini
// harness — it only catches a spawn-site regression that reroutes identity to a
// different class (the #5058 shape). Enforcement is a kill-switch: when enforcing,
// a mismatch throws (loud audit); when not, it warns + audits + continues. The
// merge-agent fallback is an already-audited, intentional degraded state, not a
// mismatch, so it does not trip the assert.
function assertHarnessIdentityMatch({
  workerClass,
  gitIdentity,
  brokerEvidence = null,
  enforce = true,
  requiresWorkflowPush = false,
  log = console,
  auditSink = null,
  now = () => new Date().toISOString(),
  env = process.env,
} = {}) {
  const mismatches = [];
  let expectedIdentity = null;
  try {
    expectedIdentity = remediationWorkerGitIdentity(workerClass);
  } catch (error) {
    if (!/unknown remediation worker class/u.test(String(error?.message || error))) {
      throw error;
    }
  }
  if (
    !gitIdentity
    || !expectedIdentity
    || gitIdentity.name !== expectedIdentity.name
    || gitIdentity.email !== expectedIdentity.email
  ) {
    mismatches.push({
      kind: 'git-identity',
      expected: expectedIdentity,
      resolved: gitIdentity ? { name: gitIdentity.name, email: gitIdentity.email } : null,
    });
  }
  if (brokerEvidence && brokerEvidence.enabled) {
    const expectedProvider = remediationWorkerPushProvider(workerClass, env, { requiresWorkflowPush });
    if (!brokerEvidence.fellBack && brokerEvidence.provider !== expectedProvider.provider) {
      mismatches.push({
        kind: 'push-provider',
        expected: expectedProvider.provider,
        resolved: brokerEvidence.provider || null,
      });
    }
  }
  const result = {
    workerClass,
    match: mismatches.length === 0,
    mismatches,
    enforced: enforce,
    // Only stamped on the mismatch path: the happy path must not consume a
    // `now()` tick, so injected clocks in the spawn path keep their call order.
    checkedAt: null,
  };
  if (mismatches.length > 0) {
    result.checkedAt = now();
    const summary = mismatches
      .map((m) => `${m.kind}: expected ${JSON.stringify(m.expected)} got ${JSON.stringify(m.resolved)}`)
      .join('; ');
    const message = `remediation harness identity mismatch for physical harness ${JSON.stringify(workerClass)}: ${summary}`;
    log?.error?.(`[follow-up-remediation] HARNESS-IDENTITY ${enforce ? 'FAIL-CLOSED' : 'WARN'}: ${message}`);
    if (auditSink) {
      try {
        auditSink({ event: 'remediation-harness-identity-mismatch', message, ...result });
      } catch {
        // Audit sink must never mask the underlying enforcement decision.
      }
    }
    if (enforce) {
      throw new HarnessIdentityMismatchError(message, { workerClass, mismatches, enforced: true });
    }
  }
  return result;
}

function resolveGeminiRemediationModel(env = process.env) {
  const pinned = String(env.GEMINI_REMEDIATION_MODEL || env.GEMINI_MODEL || '').trim();
  return pinned || DEFAULT_GEMINI_REMEDIATION_MODEL;
}

function resolveCodexRemediationModel(env = process.env) {
  const pinned = String(
    env.ADVERSARIAL_REMEDIATION_CODEX_MODEL
      || env.CODEX_REMEDIATION_MODEL
      || env.CODEX_MODEL_ID
      || ''
  ).trim();
  return pinned || DEFAULT_CODEX_REMEDIATION_MODEL;
}

function resolveGeminiAuthPath(env = process.env) {
  if (env.GEMINI_AUTH_PATH) return env.GEMINI_AUTH_PATH;
  const geminiHome = env.GEMINI_HOME || join(env.HOME || homedir(), '.gemini');
  return join(geminiHome, 'oauth_creds.json');
}

function resolveGeminiAuthHome(authPath) {
  const normalizedAuthPath = resolve(authPath);
  const segments = normalizedAuthPath.split('/').filter(Boolean);
  if (segments[0] === 'Users' && segments[1]) return `/${segments[0]}/${segments[1]}`;
  return dirname(dirname(normalizedAuthPath));
}

function scrubGeminiOAuthFallbackEnv(sourceEnv = process.env) {
  const env = { ...sourceEnv };
  const stripped = [];
  for (const key of GEMINI_OAUTH_FALLBACK_ENV_STRIP_LIST) {
    if (env[key] !== undefined) {
      delete env[key];
      stripped.push(key);
    }
  }
  return { env, stripped };
}

function prepareClaudeCodeRemediationStartupEnv({
  gitIdentity = null,
  workerClass = 'claude-code',
  requiresWorkflowPush = false,
  sourceEnv = process.env,
} = {}) {
  const { env, stripped } = scrubOAuthFallbackEnv(sourceEnv);
  env.PATH = buildInheritedPath(env.PATH || '');

  // Stamp the physical-harness git identity so a claude-code remediation commits
  // (and, with the broker on, pushes) as the claude harness — not under whatever
  // ambient GIT_AUTHOR_*/GIT_COMMITTER_* the daemon happens to hold. Before this,
  // the claude prepare fn set NO identity at all (#5058 sibling defect), so a
  // claude remediation authored commits under the operator's inherited git env.
  const overriddenGitEnv = [];
  if (gitIdentity) {
    for (const [key, value] of [
      ['GIT_AUTHOR_NAME', gitIdentity.name],
      ['GIT_AUTHOR_EMAIL', gitIdentity.email],
      ['GIT_COMMITTER_NAME', gitIdentity.name],
      ['GIT_COMMITTER_EMAIL', gitIdentity.email],
    ]) {
      if (sourceEnv[key] !== undefined && sourceEnv[key] !== value) overriddenGitEnv.push(key);
      env[key] = value;
    }
  }

  const mergeAgentBroker = applyMergeAgentBrokerEnv(env, sourceEnv, { workerClass, requiresWorkflowPush });

  return {
    env,
    startupEvidence: {
      stage: 'pre-side-effect-gate',
      requestedContract: {
        authMode: 'local-oauth',
        forbiddenFallbacks: ['api-key', 'anthropic-api-key', 'bedrock', 'vertex'],
      },
      resolvedStartup: {
        resolvedAuthMode: 'local-oauth',
        strippedEnv: stripped,
        preservedForOAuth: env.ANTHROPIC_AUTH_TOKEN ? ['ANTHROPIC_AUTH_TOKEN'] : [],
      },
      sanitizedEnv: {
        stripped,
        gitIdentityOverrides: overriddenGitEnv,
      },
      gitIdentity: gitIdentity ? { name: gitIdentity.name, email: gitIdentity.email } : null,
      mergeAgentBroker,
      policy_violations: [],
      policyViolations: [],
    },
  };
}

function prepareGeminiRemediationStartupEnv({
  gitIdentity = null,
  workerClass = 'gemini',
  requiresWorkflowPush = false,
  sourceEnv = process.env,
} = {}) {
  const { env, stripped } = scrubGeminiOAuthFallbackEnv(sourceEnv);
  env.PATH = buildInheritedPath(env.PATH || '');
  const authPath = resolveGeminiAuthPath(sourceEnv);
  const authHome = resolveGeminiAuthHome(authPath);
  env.HOME = authHome;
  env.GEMINI_HOME = dirname(authPath);

  const overriddenGitEnv = [];
  if (gitIdentity) {
    for (const [key, value] of [
      ['GIT_AUTHOR_NAME', gitIdentity.name],
      ['GIT_AUTHOR_EMAIL', gitIdentity.email],
      ['GIT_COMMITTER_NAME', gitIdentity.name],
      ['GIT_COMMITTER_EMAIL', gitIdentity.email],
    ]) {
      if (sourceEnv[key] !== undefined && sourceEnv[key] !== value) overriddenGitEnv.push(key);
      env[key] = value;
    }
  }

  const mergeAgentBroker = applyMergeAgentBrokerEnv(env, sourceEnv, { workerClass, requiresWorkflowPush });

  return {
    env,
    startupEvidence: {
      stage: 'pre-side-effect-gate',
      requestedContract: {
        authMode: 'local-oauth',
        authHome,
        authPath,
        forbiddenFallbacks: ['api-key', 'gemini-api-key', 'google-api-key', 'adc', 'vertex'],
      },
      resolvedStartup: {
        resolvedAuthMode: 'local-oauth',
        authHome,
        authPath,
        strippedEnv: stripped,
      },
      sanitizedEnv: {
        stripped,
        gitIdentityOverrides: overriddenGitEnv,
      },
      gitIdentity: gitIdentity ? { name: gitIdentity.name, email: gitIdentity.email } : null,
      mergeAgentBroker,
      policy_violations: [],
      policyViolations: [],
    },
  };
}

function prepareCodexRemediationStartupEnv({
  gitIdentity = null,
  perWorkerKey = null,
  workerClass = 'codex',
  requiresWorkflowPush = false,
  sourceEnv = process.env,
} = {}) {
  const sharedAuthPath = resolveCodexAuthPath(sourceEnv);
  const perWorkerAuth = sourceEnv.CODEX_AUTH_PATH
    ? null
    : materializePerWorkerCodexAuth({
        sharedAuthPath,
        key: perWorkerKey ? `remediation-${perWorkerKey}` : `remediation-${process.pid}-${Date.now()}`,
      });
  const authPath = perWorkerAuth?.authPath || sharedAuthPath;
  const authHome = resolveCodexAuthHome(authPath);
  const authOwner = resolveCodexAuthOwner(authPath);
  const codexHome = dirname(authPath);
  const strippedEnv = [];
  const overriddenGitEnv = [];
  const policyViolations = [];
  const scrubbed = scrubOAuthFallbackEnv(sourceEnv);
  strippedEnv.push(...scrubbed.stripped);

  if (sourceEnv.CODEX_AUTH_PATH && resolve(sourceEnv.CODEX_AUTH_PATH) !== resolve(authPath)) {
    policyViolations.push(buildCodexStartupPolicyViolation({
      reason: 'inherited CODEX_AUTH_PATH does not satisfy the requested local OAuth contract',
      requestedValue: authPath,
      resolvedValue: sourceEnv.CODEX_AUTH_PATH,
    }));
  }
  if ((sourceEnv.HOME || homedir()) && resolve(sourceEnv.HOME || homedir()) !== resolve(authHome)) {
    policyViolations.push(buildCodexStartupPolicyViolation({
      reason: 'inherited HOME does not satisfy the requested local OAuth owner contract',
      requestedValue: authHome,
      resolvedValue: sourceEnv.HOME || homedir(),
    }));
  }
  if (sourceEnv.CODEX_HOME && resolve(sourceEnv.CODEX_HOME) !== resolve(codexHome)) {
    policyViolations.push(buildCodexStartupPolicyViolation({
      reason: 'inherited CODEX_HOME does not satisfy the requested local OAuth contract',
      requestedValue: codexHome,
      resolvedValue: sourceEnv.CODEX_HOME,
    }));
  }

  const startupEvidence = {
    stage: 'pre-side-effect-gate',
    requestedContract: {
      authMode: 'local-oauth',
      authOwnerUser: authOwner,
      authHome,
      authPath,
      forbiddenFallbacks: ['api-key', 'openai-api-key'],
      forbiddenCalls: ['authenticate'],
    },
    resolvedStartup: {
      resolvedAuthMode: 'local-oauth',
      resolvedAuthOwner: authOwner,
      authHome,
      authPath,
      codexHome,
    },
    sanitizedEnv: {
      stripped: strippedEnv,
      gitIdentityOverrides: overriddenGitEnv,
    },
    gitIdentity: gitIdentity ? { name: gitIdentity.name, email: gitIdentity.email } : null,
    policy_violations: policyViolations,
    policyViolations,
  };

  if (policyViolations.length) {
    throw new StartupContractError(
      policyViolations.map((item) => item.reason).join('; '),
      {
        requestedValue: policyViolations[0].requested_value,
        resolvedValue: policyViolations[0].resolved_value,
        startupEvidence,
      },
    );
  }

  const env = {
    ...scrubbed.env,
    PATH: buildInheritedPath(sourceEnv.PATH),
    CODEX_AUTH_PATH: authPath,
    CODEX_HOME: codexHome,
    HOME: authHome,
  };
  delete env.WORKER_CLASS;
  delete env.WORKER_JOB_ID;
  delete env.WORKER_RUN_AT;

  if (gitIdentity) {
    for (const [key, value] of [
      ['GIT_AUTHOR_NAME', gitIdentity.name],
      ['GIT_AUTHOR_EMAIL', gitIdentity.email],
      ['GIT_COMMITTER_NAME', gitIdentity.name],
      ['GIT_COMMITTER_EMAIL', gitIdentity.email],
    ]) {
      if (sourceEnv[key] !== undefined && sourceEnv[key] !== value) overriddenGitEnv.push(key);
      env[key] = value;
    }
  }

  startupEvidence.mergeAgentBroker = applyMergeAgentBrokerEnv(env, sourceEnv, { workerClass, requiresWorkflowPush });
  return { authPath, env, startupEvidence };
}

function withReplyContext(env, { replyPath = null, hqRoot, launchRequestId, now, workerClass, jobId }) {
  const replyContext = requireWorkerReplyContext({ replyPath, hqRoot, launchRequestId });
  const next = {
    ...env,
    WORKER_CLASS: workerClass,
    WORKER_RUN_AT: now(),
    ADV_REPLY_DIR: replyContext.replyDir,
    REMEDIATION_REPLY_PATH: replyContext.replyPath,
  };
  if (replyContext.hqRoot) next.HQ_ROOT = replyContext.hqRoot;
  else delete next.HQ_ROOT;
  if (replyContext.launchRequestId) next.LRQ_ID = replyContext.launchRequestId;
  else delete next.LRQ_ID;
  if (jobId) next.WORKER_JOB_ID = jobId;
  else delete next.WORKER_JOB_ID;
  return { env: next, replyContext };
}

function spawnClaudeCodeRemediationWorker({
  workspaceDir,
  promptPath,
  outputPath,
  logPath,
  replyPath = null,
  hqRoot,
  launchRequestId,
  jobId = null,
  workerClass = 'claude-code-remediation',
  requiresWorkflowPush = false,
  enforceHarnessIdentity = true,
  auditSink = null,
  log = console,
  spawnImpl,
  sourceEnv = process.env,
  now = () => new Date().toISOString(),
  openSyncImpl = openSync,
  closeSyncImpl = closeSync,
}) {
  const claudeCli = resolveClaudeCodeCliPath(sourceEnv);
  // Physical harness is claude-code; `workerClass` above is the provenance
  // TRAILER class (claude-code-remediation), not the harness — never key identity
  // off it.
  const gitIdentity = remediationWorkerGitIdentity('claude-code');
  const { env: baseEnv, startupEvidence } = prepareClaudeCodeRemediationStartupEnv({
    gitIdentity,
    workerClass: 'claude-code',
    requiresWorkflowPush,
    sourceEnv,
  });
  assertHarnessIdentityMatch({
    workerClass: 'claude-code',
    gitIdentity,
    brokerEvidence: startupEvidence.mergeAgentBroker,
    enforce: enforceHarnessIdentity,
    requiresWorkflowPush,
    log,
    auditSink,
    now,
  });
  const { env, replyContext } = withReplyContext(baseEnv, {
    replyPath,
    hqRoot,
    launchRequestId,
    now,
    workerClass,
    jobId,
  });
  let promptFd;
  let stdoutFd;
  let stderrFd;
  try {
    promptFd = openSyncImpl(promptPath, 'r');
    stdoutFd = openSyncImpl(outputPath, 'w');
    stderrFd = openSyncImpl(logPath, 'a');
    const child = spawnDetachedCli(
      claudeCli,
      ['--print', '--permission-mode', 'acceptEdits', '--dangerously-skip-permissions'],
      {
        cwd: workspaceDir,
        env,
        stdio: [promptFd, stdoutFd, stderrFd],
        spawnImpl,
        now,
      },
    );
    return {
      model: 'claude-code',
      processId: child.pid,
      processGroupId: child.pid,
      spawnedAt: child.spawnedAt || now(),
      workspaceDir,
      promptPath,
      outputPath,
      logPath,
      replyPath: replyContext.replyPath,
      launchRequestId: replyContext.launchRequestId,
      gitIdentity,
      startupEvidence,
      command: [claudeCli, '--print', '--permission-mode', 'acceptEdits', '--dangerously-skip-permissions'],
      child,
    };
  } finally {
    if (promptFd !== undefined) closeSyncImpl(promptFd);
    if (stdoutFd !== undefined) closeSyncImpl(stdoutFd);
    if (stderrFd !== undefined) closeSyncImpl(stderrFd);
  }
}

function spawnGeminiRemediationWorker({
  workspaceDir,
  promptPath,
  outputPath,
  logPath,
  replyPath = null,
  hqRoot,
  launchRequestId,
  jobId = null,
  requiresWorkflowPush = false,
  enforceHarnessIdentity = true,
  auditSink = null,
  log = console,
  spawnImpl,
  sourceEnv = process.env,
  now = () => new Date().toISOString(),
  openSyncImpl = openSync,
  closeSyncImpl = closeSync,
}) {
  const geminiCli = resolveGeminiCliPath(sourceEnv);
  const gitIdentity = remediationWorkerGitIdentity('gemini');
  const { env: baseEnv, startupEvidence } = prepareGeminiRemediationStartupEnv({
    gitIdentity,
    workerClass: 'gemini',
    requiresWorkflowPush,
    sourceEnv,
  });
  assertHarnessIdentityMatch({
    workerClass: 'gemini',
    gitIdentity,
    brokerEvidence: startupEvidence.mergeAgentBroker,
    enforce: enforceHarnessIdentity,
    requiresWorkflowPush,
    log,
    auditSink,
    now,
  });
  const { env, replyContext } = withReplyContext(baseEnv, {
    replyPath,
    hqRoot,
    launchRequestId,
    now,
    workerClass: GEMINI_REMEDIATION_WORKER_TRAILER_CLASS,
    jobId,
  });
  // Resolve from the exact sanitized environment handed to the child. This
  // keeps model selection aligned with future per-worker env overrides rather
  // than reaching back into ambient daemon state.
  const model = resolveGeminiRemediationModel(env);
  let promptFd;
  let stdoutFd;
  let stderrFd;
  try {
    promptFd = openSyncImpl(promptPath, 'r');
    stdoutFd = openSyncImpl(outputPath, 'w');
    stderrFd = openSyncImpl(logPath, 'a');
    const child = spawnDetachedCli(
      geminiCli,
      ['--approval-mode', 'yolo', '--skip-trust', '-m', model],
      {
        cwd: workspaceDir,
        env,
        stdio: [promptFd, stdoutFd, stderrFd],
        spawnImpl,
        now,
      },
    );
    return {
      model: 'gemini',
      workerClass: 'gemini',
      processId: child.pid,
      processGroupId: child.pid,
      spawnedAt: child.spawnedAt || now(),
      workspaceDir,
      promptPath,
      outputPath,
      logPath,
      replyPath: replyContext.replyPath,
      launchRequestId: replyContext.launchRequestId,
      gitIdentity,
      startupEvidence,
      command: [geminiCli, '--approval-mode', 'yolo', '--skip-trust', '-m', model],
      child,
    };
  } finally {
    if (promptFd !== undefined) closeSyncImpl(promptFd);
    if (stdoutFd !== undefined) closeSyncImpl(stdoutFd);
    if (stderrFd !== undefined) closeSyncImpl(stderrFd);
  }
}

function spawnCodexRemediationWorker({
  workspaceDir,
  promptPath,
  outputPath,
  logPath,
  replyPath = null,
  hqRoot,
  launchRequestId,
  workerClass = 'codex',
  requiresWorkflowPush = false,
  enforceHarnessIdentity = true,
  auditSink = null,
  log = console,
  jobId = null,
  spawnImpl,
  sourceEnv = process.env,
  now = () => new Date().toISOString(),
  openSyncImpl = openSync,
  closeSyncImpl = closeSync,
}) {
  const codexCli = resolveCodexCliPath(sourceEnv);
  // For codex, `workerClass` IS the physical harness class ('codex').
  const gitIdentity = remediationWorkerGitIdentity(workerClass);
  const { env: baseEnv, startupEvidence } = prepareCodexRemediationStartupEnv({
    gitIdentity,
    perWorkerKey: jobId || launchRequestId || null,
    workerClass,
    requiresWorkflowPush,
    sourceEnv,
  });
  assertHarnessIdentityMatch({
    workerClass,
    gitIdentity,
    brokerEvidence: startupEvidence.mergeAgentBroker,
    enforce: enforceHarnessIdentity,
    requiresWorkflowPush,
    log,
    auditSink,
    now,
  });
  const { env, replyContext } = withReplyContext(baseEnv, {
    replyPath,
    hqRoot,
    launchRequestId,
    now,
    workerClass: REMEDIATION_WORKER_TRAILER_CLASS,
    jobId,
  });
  const codexModel = resolveCodexRemediationModel(env);
  let promptFd;
  let stdoutFd;
  let stderrFd;
  try {
    promptFd = openSyncImpl(promptPath, 'r');
    stdoutFd = openSyncImpl(logPath, 'a');
    stderrFd = openSyncImpl(logPath, 'a');
    const child = spawnDetachedCli(
      codexCli,
      [
        'exec',
        '--model',
        codexModel,
        '--dangerously-bypass-approvals-and-sandbox',
        '--ephemeral',
        '--json',
        '--output-last-message',
        outputPath,
        '-',
      ],
      {
        cwd: workspaceDir,
        env,
        stdio: [promptFd, stdoutFd, stderrFd],
        spawnImpl,
        now,
      },
    );
    return {
      model: 'codex',
      workerClass,
      processId: child.pid,
      processGroupId: child.pid,
      spawnedAt: child.spawnedAt || now(),
      workspaceDir,
      promptPath,
      outputPath,
      logPath,
      replyPath: replyContext.replyPath,
      launchRequestId: replyContext.launchRequestId,
      gitIdentity,
      startupEvidence,
      command: [
        codexCli,
        'exec',
        '--model',
        codexModel,
        '--dangerously-bypass-approvals-and-sandbox',
        '--ephemeral',
        '--json',
        '--output-last-message',
        outputPath,
        '-',
      ],
      child,
    };
  } finally {
    if (promptFd !== undefined) closeSyncImpl(promptFd);
    if (stdoutFd !== undefined) closeSyncImpl(stdoutFd);
    if (stderrFd !== undefined) closeSyncImpl(stderrFd);
  }
}

function spawnLocalRemediationWorker(workerClass, opts) {
  switch (workerClass) {
    case 'codex': return spawnCodexRemediationWorker(opts);
    case 'claude-code': return spawnClaudeCodeRemediationWorker(opts);
    case 'gemini': return spawnGeminiRemediationWorker(opts);
    default: throw new Error(`unknown remediation worker class: ${workerClass}`);
  }
}

function readTextIfPresent(filePath) {
  if (!filePath || !existsSync(filePath)) return null;
  return readFileSync(filePath, 'utf8');
}

function toLocalRemediationResult(worker, { cancelled = false } = {}) {
  const body = readTextIfPresent(worker.outputPath);
  const replyExists = worker.replyPath ? existsSync(worker.replyPath) : false;
  if (cancelled) {
    return {
      status: 'cancelled',
      runtimeMode: 'local',
      failureClass: null,
      usage: null,
      detail: `local remediation run ${worker.processGroupId || worker.processId || 'unknown'} cancelled by caller`,
    };
  }
  if (typeof body === 'string' && body.length > 0) {
    return {
      status: 'completed',
      runtimeMode: 'local',
      failureClass: null,
      usage: null,
      detail: null,
      artifact: {
        kind: 'remediation',
        body,
        pgid: Number.isInteger(worker.processGroupId) ? worker.processGroupId : null,
        stdoutTail: null,
        stderrTail: readTextIfPresent(worker.logPath),
        reattachToken: worker.launchRequestId || null,
      },
    };
  }
  if (replyExists) {
    return {
      status: 'completed',
      runtimeMode: 'local',
      failureClass: null,
      usage: null,
      detail: null,
      artifact: {
        kind: 'remediation',
        body: null,
        pgid: Number.isInteger(worker.processGroupId) ? worker.processGroupId : null,
        stdoutTail: null,
        stderrTail: readTextIfPresent(worker.logPath),
        reattachToken: worker.launchRequestId || null,
      },
    };
  }
  return {
    status: 'failed',
    runtimeMode: 'local',
    failureClass: 'missing-remediation-artifact',
    usage: null,
    detail: `local remediation run ${worker.processGroupId || worker.processId || 'unknown'} exited without output or reply artifact`,
  };
}

async function cancelLocalRemediationWorker(worker, {
  processKillImpl = process.kill,
  execFileImpl = execFileAsync,
  sleepImpl = sleep,
} = {}) {
  const pgid = Number(worker?.processGroupId || worker?.processId || 0);
  if (!Number.isInteger(pgid) || pgid <= 0) return;
  if (!isPgidAlive(pgid, processKillImpl)) return;
  let identity;
  for (let attempt = 0; attempt <= IDENTITY_PROBE_RETRY_DELAYS_MS.length; attempt += 1) {
    identity = await verifyPgidIdentity(pgid, worker?.spawnedAt, {
      execFileImpl,
      allowForbiddenProbeFallback: true,
    });
    if (identity.match || !TRANSIENT_IDENTITY_PROBE_RE.test(identity.reason || '')) break;
    if (attempt >= IDENTITY_PROBE_RETRY_DELAYS_MS.length) break;
    await sleepImpl(IDENTITY_PROBE_RETRY_DELAYS_MS[attempt]);
  }
  if (!identity.match) {
    if (identity.gone) return;
    throw new Error(`refusing to cancel remediation worker with unconfirmed identity (${identity.reason || 'unknown'})`);
  }
  try {
    processKillImpl(-pgid, 'SIGTERM');
  } catch (err) {
    if (err?.code === 'ESRCH' || err?.code === 'EPERM') return;
    throw err;
  }
}

async function waitForLocalRemediationExit(worker, {
  processKillImpl = process.kill,
  pollMs = DEFAULT_POLL_MS,
  sleepImpl = sleep,
  cancelledRef = { value: false },
} = {}) {
  const pgid = Number(worker?.processGroupId || worker?.processId || 0);
  while (Number.isInteger(pgid) && pgid > 0 && isPgidAlive(pgid, processKillImpl)) {
    await sleepImpl(pollMs);
  }
  return toLocalRemediationResult(worker, { cancelled: cancelledRef.value });
}

function createLocalRemediationHandle({
  runRef,
  worker,
  processKillImpl = process.kill,
  execFileImpl = execFileAsync,
  waitForExitImpl = waitForLocalRemediationExit,
  sleepImpl = sleep,
  pollMs = DEFAULT_POLL_MS,
} = {}) {
  const cancelled = { value: false };
  const wait = () => waitForExitImpl(worker, {
    processKillImpl,
    execFileImpl,
    sleepImpl,
    pollMs,
    cancelledRef: cancelled,
  });
  return {
    runRef,
    mode: 'local',
    worker,
    async await() {
      return wait();
    },
    async cancel() {
      cancelled.value = true;
      await cancelLocalRemediationWorker(worker, { processKillImpl, execFileImpl, sleepImpl });
    },
    async reattach() {
      return wait();
    },
  };
}

export {
  StartupContractError,
  HarnessIdentityMismatchError,
  applyMergeAgentBrokerEnv,
  assertHarnessIdentityMatch,
  buildInheritedPath,
  cancelLocalRemediationWorker,
  createLocalRemediationHandle,
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
  spawnLocalRemediationWorker,
  waitForLocalRemediationExit,
};
