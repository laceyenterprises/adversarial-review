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
} from '../../../remediation-worker-provenance.mjs';
import { requireWorkerReplyContext } from '../../../remediation-reply-paths.mjs';
import { scrubOAuthFallbackEnv, OAUTH_ENV_STRIP_LIST } from '../../../secret-source/env.mjs';

const execFileAsync = promisify(execFile);
const DEFAULT_PATH_PREFIX = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
const DEFAULT_GEMINI_REMEDIATION_MODEL = 'gemini-2.5-pro';
const DEFAULT_CODEX_REMEDIATION_MODEL = 'gpt-5.5';
const DEFAULT_POLL_MS = 250;
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

function resolveCodexCliPath() {
  return process.env.CODEX_CLI_PATH || process.env.CODEX_CLI || 'codex';
}

function resolveClaudeCodeCliPath() {
  return process.env.CLAUDE_CODE_CLI_PATH || process.env.CLAUDE_CLI || 'claude';
}

function resolveGeminiCliPath() {
  return process.env.GEMINI_CLI_PATH || process.env.GEMINI_CLI || 'gemini';
}

function resolveCodexAuthPath() {
  if (process.env.CODEX_AUTH_PATH) return process.env.CODEX_AUTH_PATH;
  const codexHome = process.env.CODEX_HOME || join(process.env.HOME || homedir(), '.codex');
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
  return segments[0] === 'Users' && segments[1] ? segments[1] : null;
}

function buildCodexStartupPolicyViolation({ reason, requestedValue = null, resolvedValue = null }) {
  return {
    kind: 'startup-policy-violation',
    reason,
    requested_value: requestedValue,
    resolved_value: resolvedValue,
  };
}

function applyMergeAgentBrokerEnv(env, sourceEnv = process.env) {
  const mapping = [
    'OAUTH_BROKER_SHARED_SECRET_FILE',
    'OAUTH_BROKER_MERGE_AGENT_PROVIDER',
    'OAUTH_BROKER_MERGE_AGENT_EXPECTED_APP_ID',
    'OAUTH_BROKER_MERGE_AGENT_EXPECTED_INSTALLATION_ID',
  ];
  for (const key of mapping) {
    if (sourceEnv[key]) env[key] = sourceEnv[key];
    else delete env[key];
  }
  return {
    enabled: Boolean(env.OAUTH_BROKER_SHARED_SECRET_FILE),
    providerOverridden: Boolean(sourceEnv.OAUTH_BROKER_MERGE_AGENT_PROVIDER),
    expectedAppId: sourceEnv.OAUTH_BROKER_MERGE_AGENT_EXPECTED_APP_ID || null,
    expectedInstallationId: sourceEnv.OAUTH_BROKER_MERGE_AGENT_EXPECTED_INSTALLATION_ID || null,
    sharedSecretFile: sourceEnv.OAUTH_BROKER_SHARED_SECRET_FILE || null,
  };
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

function resolveGeminiAuthPath() {
  if (process.env.GEMINI_AUTH_PATH) return process.env.GEMINI_AUTH_PATH;
  const geminiHome = process.env.GEMINI_HOME || join(process.env.HOME || homedir(), '.gemini');
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

function prepareClaudeCodeRemediationStartupEnv() {
  const { env, stripped } = scrubOAuthFallbackEnv(process.env);
  env.PATH = buildInheritedPath(env.PATH || '');
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
      policyViolations: [],
    },
  };
}

function prepareGeminiRemediationStartupEnv({ gitIdentity = null } = {}) {
  const { env, stripped } = scrubGeminiOAuthFallbackEnv(process.env);
  env.PATH = buildInheritedPath(env.PATH || '');
  const authPath = resolveGeminiAuthPath();
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
      if (process.env[key] !== undefined && process.env[key] !== value) overriddenGitEnv.push(key);
      env[key] = value;
    }
  }

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
      policyViolations: [],
    },
  };
}

function prepareCodexRemediationStartupEnv({ gitIdentity = null, perWorkerKey = null } = {}) {
  const sharedAuthPath = resolveCodexAuthPath();
  const perWorkerAuth = process.env.CODEX_AUTH_PATH
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
  const scrubbed = scrubOAuthFallbackEnv(process.env);
  strippedEnv.push(...scrubbed.stripped);

  if (process.env.CODEX_AUTH_PATH && resolve(process.env.CODEX_AUTH_PATH) !== resolve(authPath)) {
    policyViolations.push(buildCodexStartupPolicyViolation({
      reason: 'inherited CODEX_AUTH_PATH does not satisfy the requested local OAuth contract',
      requestedValue: authPath,
      resolvedValue: process.env.CODEX_AUTH_PATH,
    }));
  }
  if ((process.env.HOME || homedir()) && resolve(process.env.HOME || homedir()) !== resolve(authHome)) {
    policyViolations.push(buildCodexStartupPolicyViolation({
      reason: 'inherited HOME does not satisfy the requested local OAuth owner contract',
      requestedValue: authHome,
      resolvedValue: process.env.HOME || homedir(),
    }));
  }
  if (process.env.CODEX_HOME && resolve(process.env.CODEX_HOME) !== resolve(codexHome)) {
    policyViolations.push(buildCodexStartupPolicyViolation({
      reason: 'inherited CODEX_HOME does not satisfy the requested local OAuth contract',
      requestedValue: codexHome,
      resolvedValue: process.env.CODEX_HOME,
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
    PATH: buildInheritedPath(process.env.PATH),
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
      if (process.env[key] !== undefined && process.env[key] !== value) overriddenGitEnv.push(key);
      env[key] = value;
    }
  }

  startupEvidence.mergeAgentBroker = applyMergeAgentBrokerEnv(env);
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
  spawnImpl,
  now = () => new Date().toISOString(),
  openSyncImpl = openSync,
  closeSyncImpl = closeSync,
}) {
  const claudeCli = resolveClaudeCodeCliPath();
  const { env: baseEnv, startupEvidence } = prepareClaudeCodeRemediationStartupEnv();
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
  spawnImpl,
  now = () => new Date().toISOString(),
  openSyncImpl = openSync,
  closeSyncImpl = closeSync,
}) {
  const geminiCli = resolveGeminiCliPath();
  const gitIdentity = remediationWorkerGitIdentity('gemini');
  const { env: baseEnv, startupEvidence } = prepareGeminiRemediationStartupEnv({ gitIdentity });
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
  jobId = null,
  spawnImpl,
  now = () => new Date().toISOString(),
  openSyncImpl = openSync,
  closeSyncImpl = closeSync,
}) {
  const codexCli = resolveCodexCliPath();
  const gitIdentity = remediationWorkerGitIdentity(workerClass);
  const { env: baseEnv, startupEvidence } = prepareCodexRemediationStartupEnv({
    gitIdentity,
    perWorkerKey: jobId || launchRequestId || null,
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
} = {}) {
  const pgid = Number(worker?.processGroupId || worker?.processId || 0);
  if (!Number.isInteger(pgid) || pgid <= 0) return;
  if (!isPgidAlive(pgid, processKillImpl)) return;
  const identity = await verifyPgidIdentity(pgid, worker?.spawnedAt, {
    execFileImpl,
    allowForbiddenProbeFallback: true,
  });
  if (!identity.match) {
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
      await cancelLocalRemediationWorker(worker, { processKillImpl, execFileImpl });
    },
    async reattach() {
      return wait();
    },
  };
}

export {
  StartupContractError,
  applyMergeAgentBrokerEnv,
  buildInheritedPath,
  cancelLocalRemediationWorker,
  createLocalRemediationHandle,
  prepareClaudeCodeRemediationStartupEnv,
  prepareCodexRemediationStartupEnv,
  prepareGeminiRemediationStartupEnv,
  resolveClaudeCodeCliPath,
  resolveCodexAuthPath,
  resolveCodexCliPath,
  resolveGeminiCliPath,
  spawnClaudeCodeRemediationWorker,
  spawnCodexRemediationWorker,
  spawnGeminiRemediationWorker,
  spawnLocalRemediationWorker,
  waitForLocalRemediationExit,
};
