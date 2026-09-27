import { execFile } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { resolveRosterPath as resolveWorkerClassRosterPath } from '../../../hq-worker-classes.mjs';

const execFileAsync = promisify(execFile);
const DEFAULT_PATH_PREFIX = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const DEFAULT_GEMINI_REMEDIATION_MODEL = 'gemini-2.5-pro';
const DEFAULT_CODEX_REMEDIATION_MODEL = 'gpt-5.5';
const DEFAULT_CLAUDE_REMEDIATION_MODEL = 'claude-opus-5-5';
const REGISTRY_TTL_MS = 60_000;
const CODEX_REASONING_LEVELS = Object.freeze(new Set(['low', 'medium', 'high', 'xhigh']));
const CLAUDE_REASONING_LEVELS = Object.freeze(new Set(['low', 'medium', 'high', 'xhigh', 'max']));
const registryCache = new Map();
const fallbackWarnings = new Map();
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

function installWorkerAdapterEnv(env, sourceEnv, physicalClass, trailerClass, repo, log = console, brokerEvidence = null) {
  // An explicit HQ_REPO_ROOT is authoritative. Only without it do we infer the
  // agent-os superproject from this submodule's own location.
  const candidate = String(sourceEnv.HQ_REPO_ROOT || '').trim() || join(ROOT, '../..');
  const agentOsRoot = existsSync(join(candidate, 'modules/worker-pool/lib/shims/gh'))
    && existsSync(join(candidate, 'modules/worker-pool/lib/shims/git-safe'))
    ? candidate
    : null;
  if (!agentOsRoot) {
    log?.warn?.('[follow-up-remediation] agent-os worker shims unavailable; using inherited PATH');
    return;
  }
  const shimDir = join(agentOsRoot, 'modules/worker-pool/lib/shims');
  env.PATH = [shimDir, join(agentOsRoot, 'modules/worker-pool/bin'), env.PATH].join(':');
  env.HQ_REPO_ROOT = agentOsRoot;
  if (repo) env.GITHUB_REPOSITORY = repo;
  if (!env.GH_TOKEN && env.GITHUB_TOKEN) env.GH_TOKEN = env.GITHUB_TOKEN;
  env.WORKER_CLASS = brokerEvidence?.requiresWorkflowPush ? 'merge-agent' : physicalClass;
  env.HQ_ENTITLEMENT_GH_TOKEN_VAR = brokerEvidence?.requiresWorkflowPush
    ? 'MERGE_AGENT_GH_TOKEN'
    : ({ codex: 'CODEX_WORKER_GH_TOKEN', 'claude-code': 'CLAUDE_WORKER_GH_TOKEN', gemini: 'GEMINI_WORKER_GH_TOKEN' })[physicalClass];
  env.WORKER_TRAILER_CLASS = trailerClass;
  // The adapter mints nothing, so an inherited mint time describes some other
  // credential. A known expiry (GH_TOKEN_EXPIRES_AT or
  // <HQ_ENTITLEMENT_GH_TOKEN_VAR>_EXPIRES_AT) still passes through from the
  // daemon env. Without one, the push preflight re-resolves the token through
  // WORKER_CLASS on this host.
  delete env.HQ_WORKER_TOKEN_MINTED_AT;
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
// fails"). The pin follows the provider the worker was actually given:
// a merge-agent provider (workflow-push escalation or the merge-agent fallback)
// always takes OAUTH_BROKER_MERGE_AGENT_EXPECTED_<KIND>, even when a per-harness
// pin exists. Only a harness-keyed provider (physical-harness, or a
// harness-override, which is configured together with its per-harness pin)
// takes OAUTH_BROKER_REMEDIATION_<CLASS>_EXPECTED_<KIND>. Pairing a per-harness
// pin with the merge-agent token failed every workflow-file push closed (SEV0
// GHPIN-01, 2026-09-27: app_id 3978009 validated against codex's 3977955).
const MERGE_AGENT_PROVIDER_SOURCES = new Set(['merge-agent-fallback', 'workflow-push-merge-agent']);

function resolveHarnessExpectedPin(sourceEnv, workerClass, resolvedProvider, kind) {
  if (MERGE_AGENT_PROVIDER_SOURCES.has(resolvedProvider.source)) {
    return String(sourceEnv[`OAUTH_BROKER_MERGE_AGENT_EXPECTED_${kind}`] || '').trim() || '';
  }
  const suffix = String(workerClass || '').toUpperCase().replace(/-/g, '_');
  return suffix
    ? String(sourceEnv[`OAUTH_BROKER_REMEDIATION_${suffix}_EXPECTED_${kind}`] || '').trim()
    : '';
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
  const resolvedProvider = remediationWorkerPushProvider(workerClass, sourceEnv, { requiresWorkflowPush });
  const brokerEnabled = parsedFlag.enabled || resolvedProvider.requiresWorkflowPush;
  const evidence = {
    enabled: brokerEnabled,
    flagValue: parsedFlag.raw || null,
    warning: parsedFlag.recognized
      ? null
      : (resolvedProvider.requiresWorkflowPush
          ? 'MERGE_AGENT_AUTH_VIA_BROKER value not recognized; workflow-push broker env forced by workflow escalation'
          : 'MERGE_AGENT_AUTH_VIA_BROKER value not recognized; broker env not propagated'),
  };
  if (!brokerEnabled) return evidence;

  const brokerUrl = sourceEnv.OAUTH_BROKER_URL || DEFAULT_OAUTH_BROKER_URL;
  const standbyUrl = sourceEnv.OAUTH_BROKER_STANDBY_URL || DEFAULT_OAUTH_BROKER_STANDBY_URL;
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

function nonEmptyModelString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith('-')) return null;
  return trimmed;
}

function firstNonEmptyEnv(env, names) {
  for (const name of names) {
    const value = String(env?.[name] ?? '').trim();
    if (value) return value;
  }
  return '';
}

function codexModelPin(env = process.env) {
  return firstNonEmptyEnv(env, [
    'ADVERSARIAL_REMEDIATION_CODEX_MODEL',
    'CODEX_REMEDIATION_MODEL',
    'CODEX_MODEL_ID',
  ]);
}

function claudeModelPin(env = process.env) {
  return firstNonEmptyEnv(env, [
    'ADVERSARIAL_REMEDIATION_CLAUDE_MODEL',
    'CLAUDE_REMEDIATION_MODEL',
  ]);
}

function geminiModelPin(env = process.env) {
  return firstNonEmptyEnv(env, ['GEMINI_REMEDIATION_MODEL', 'GEMINI_MODEL']);
}

function codexReasoningPin(env = process.env) {
  return firstNonEmptyEnv(env, [
    'ADVERSARIAL_REMEDIATION_CODEX_REASONING_LEVEL',
    'CODEX_REMEDIATION_REASONING_LEVEL',
  ]);
}

function claudeReasoningPin(env = process.env) {
  return firstNonEmptyEnv(env, [
    'ADVERSARIAL_REMEDIATION_CLAUDE_REASONING_LEVEL',
    'CLAUDE_REMEDIATION_REASONING_LEVEL',
    'CLAUDE_CODE_REMEDIATION_REASONING_LEVEL',
  ]);
}

function allowedReasoningLevelsForClass(className) {
  if (className === 'remediator-codex') return CODEX_REASONING_LEVELS;
  if (className === 'remediator-claude') return CLAUDE_REASONING_LEVELS;
  return null;
}

function warnRateLimited(key, nowMs, message) {
  if (nowMs - (fallbackWarnings.get(key) ?? -Infinity) < REGISTRY_TTL_MS) return;
  for (const [existingKey, warnedAt] of fallbackWarnings) {
    if (nowMs - warnedAt >= REGISTRY_TTL_MS) fallbackWarnings.delete(existingKey);
  }
  console.warn(message);
  fallbackWarnings.set(key, nowMs);
}

function normalizeReasoningLevel(className, value, source, nowMs) {
  const level = String(value ?? '').trim();
  if (!level) return { resolvedReasoningLevel: null, reasoningSource: 'none' };
  const allowed = allowedReasoningLevelsForClass(className);
  if (!allowed) return { resolvedReasoningLevel: null, reasoningSource: 'unsupported' };
  if (allowed && !allowed.has(level)) {
    warnRateLimited(
      `invalid-reasoning:${className}:${source}:${level}`,
      nowMs,
      `[follow-up-remediation] ${className}: ignoring invalid reasoning level ${JSON.stringify(level)} from ${source}`,
    );
    return { resolvedReasoningLevel: null, reasoningSource: `invalid-${source}` };
  }
  return { resolvedReasoningLevel: level, reasoningSource: source };
}

function registrySeedCandidates(env = process.env) {
  const explicitSeedRoot = String(env?.AGENT_OS_DEPLOY_CHECKOUT ?? '').trim();
  if (explicitSeedRoot) {
    return [[join(resolve(explicitSeedRoot), 'modules', 'worker-pool', 'worker-classes.json'), 'registry-seed']];
  }
  const rosterPath = resolveWorkerClassRosterPath({ env });
  return rosterPath ? [[rosterPath, 'registry-seed']] : [];
}

function readWorkerClasses(path, nowMs) {
  const cached = registryCache.get(path);
  if (cached && nowMs - cached.readAt < REGISTRY_TTL_MS) return cached;
  let entry;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const classes = parsed?.classes || parsed;
    if (!classes || typeof classes !== 'object' || Array.isArray(classes)) {
      throw new SyntaxError('registry root is not an object');
    }
    entry = { classes, readAt: nowMs, reason: null };
  } catch (error) {
    entry = {
      classes: null,
      readAt: nowMs,
      reason: error.code === 'ENOENT' ? 'missing file' : 'unparsable JSON',
    };
  }
  registryCache.set(path, entry);
  return entry;
}

function resolveRemediationModel(className, {
  env = process.env,
  hqRoot = env.HQ_ROOT,
  pin = '',
  reasoningPin = '',
  fallbackModel,
  nowMs = Date.now(),
} = {}) {
  const rawModelPin = String(pin ?? '').trim();
  const modelPin = rawModelPin ? nonEmptyModelString(rawModelPin) : '';
  const pinnedReasoning = normalizeReasoningLevel(className, reasoningPin, 'env', nowMs);
  const hasReasoningPin = pinnedReasoning.resolvedReasoningLevel !== null;
  if (rawModelPin && !modelPin) {
    warnRateLimited(
      `invalid-model:${className}:env:${rawModelPin}`,
      nowMs,
      `[follow-up-remediation] ${className}: ignoring invalid model pin ${JSON.stringify(rawModelPin)} from env`,
    );
  }
  if (modelPin) {
    return {
      resolvedModel: modelPin,
      resolvedReasoningLevel: pinnedReasoning.resolvedReasoningLevel,
      modelSource: 'env',
      reasoningSource: pinnedReasoning.reasoningSource,
    };
  }
  const mirrorPath = hqRoot && join(resolve(hqRoot), 'registry', 'worker-classes.json');
  const candidates = [
    mirrorPath && [mirrorPath, 'registry-mirror'],
    ...registrySeedCandidates(env),
  ].filter(Boolean);
  const names = [className];
  let reason = 'missing file';
  for (const [path, source] of candidates) {
    const registry = readWorkerClasses(path, nowMs);
    if (!registry.classes) {
      reason = registry.reason;
      continue;
    }
    const selected = names.find((name) => registry.classes[name]?.defaultModel);
    if (!selected) {
      reason = 'class absent';
      continue;
    }
    const spec = registry.classes[selected];
    const registryModel = nonEmptyModelString(spec.defaultModel);
    if (!registryModel) {
      reason = 'invalid defaultModel';
      continue;
    }
    const reasoning = hasReasoningPin
      ? pinnedReasoning
      : normalizeReasoningLevel(className, spec.defaultReasoningLevel, source, nowMs);
    return {
      resolvedModel: registryModel,
      resolvedReasoningLevel: reasoning.resolvedReasoningLevel,
      modelSource: source,
      reasoningSource: reasoning.reasoningSource,
    };
  }
  const warningKey = `${className}:${candidates.map(([path]) => path).join(':')}`;
  warnRateLimited(
    warningKey,
    nowMs,
    `[follow-up-remediation] ${className}: using fallback model constant (${reason})`,
  );
  return {
    resolvedModel: fallbackModel,
    resolvedReasoningLevel: pinnedReasoning.resolvedReasoningLevel,
    modelSource: 'fallback-constant',
    reasoningSource: pinnedReasoning.reasoningSource,
  };
}

function resolveNonBlockingCodexModel({ model, reasoningEffort, env = process.env, hqRoot = env.HQ_ROOT } = {}) {
  const fallback = { resolvedModel: 'gpt-6-sol', resolvedReasoningLevel: 'low', modelSource: 'non-blocking-default', reasoningSource: 'non-blocking-default' };
  const requestedModel = nonEmptyModelString(model);
  const candidates = [
    hqRoot && [join(resolve(hqRoot), 'registry', 'worker-classes.json'), 'registry-mirror'],
    ...registrySeedCandidates(env),
  ].filter(Boolean);
  for (const [path] of candidates) {
    const registry = readWorkerClasses(path, Date.now());
    const allowed = registry.classes?.['remediator-codex']?.allowedModels;
    if (!Array.isArray(allowed)) continue;
    return {
      resolvedModel: requestedModel && allowed.includes(requestedModel) ? requestedModel : fallback.resolvedModel,
      resolvedReasoningLevel: CODEX_REASONING_LEVELS.has(reasoningEffort) ? reasoningEffort : fallback.resolvedReasoningLevel,
      modelSource: requestedModel && allowed.includes(requestedModel) ? 'non-blocking-config' : fallback.modelSource,
      reasoningSource: CODEX_REASONING_LEVELS.has(reasoningEffort) ? 'non-blocking-config' : fallback.reasoningSource,
    };
  }
  return fallback;
}

function resolveGeminiRemediationModel(env = process.env, { hqRoot = env.HQ_ROOT } = {}) {
  return resolveRemediationModel('remediator-gemini', {
    env,
    hqRoot,
    pin: geminiModelPin(env),
    fallbackModel: DEFAULT_GEMINI_REMEDIATION_MODEL,
  }).resolvedModel;
}

function resolveCodexRemediationModel(env = process.env, { hqRoot = env.HQ_ROOT } = {}) {
  return resolveRemediationModel('remediator-codex', {
    env,
    hqRoot,
    pin: codexModelPin(env),
    reasoningPin: codexReasoningPin(env),
    fallbackModel: DEFAULT_CODEX_REMEDIATION_MODEL,
  }).resolvedModel;
}

function resolveClaudeRemediationModel(env = process.env, { hqRoot = env.HQ_ROOT } = {}) {
  return resolveRemediationModel('remediator-claude', {
    env,
    hqRoot,
    pin: claudeModelPin(env),
    reasoningPin: claudeReasoningPin(env),
    fallbackModel: DEFAULT_CLAUDE_REMEDIATION_MODEL,
  });
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

// The broker shared secret mints OAuth tokens for EVERY provider the loopback
// broker serves, so it is the highest-value credential in the daemon env. The
// remediation worker executes LLM-generated payloads, so it must receive that
// secret only when it genuinely needs one -- i.e. when
// `applyMergeAgentBrokerEnv` deliberately grants the `_FILE` reference for a
// broker-backed push. Before this scrub the secret reached the worker AMBIENTLY
// via the `{ ...sourceEnv }` inheritance in `scrubOAuthFallbackEnv`, which
// bypassed that gate entirely: it arrived even with the merge-agent broker off,
// and the INLINE form arrived even though the grant only ever propagates the
// `_FILE` form. Strip both here and let the gate re-add what it means to.
const BROKER_SHARED_SECRET_ENV_STRIP_LIST = Object.freeze([
  'OAUTH_BROKER_SHARED_SECRET',
  'OAUTH_BROKER_SHARED_SECRET_FILE',
]);

function stripBrokerSharedSecretEnv(env) {
  const stripped = [];
  for (const key of BROKER_SHARED_SECRET_ENV_STRIP_LIST) {
    if (env[key] !== undefined) {
      delete env[key];
      stripped.push(key);
    }
  }
  return stripped;
}

function prepareClaudeCodeRemediationStartupEnv({
  gitIdentity = null,
  workerClass = 'claude-code',
  requiresWorkflowPush = false,
  sourceEnv = process.env,
} = {}) {
  const { env, stripped } = scrubOAuthFallbackEnv(sourceEnv);
  env.PATH = buildInheritedPath(env.PATH);
  // Ordering is load-bearing: strip BEFORE `applyMergeAgentBrokerEnv` below, so
  // the only broker secret the worker can see is the one that gate explicitly
  // re-grants for a push it is authorized to make.
  const strippedBrokerSecrets = stripBrokerSharedSecretEnv(env);

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

  // Report only the broker secrets that STAYED stripped. `applyMergeAgentBrokerEnv`
  // re-grants `OAUTH_BROKER_SHARED_SECRET_FILE` when a broker-backed push is
  // enabled, and listing a key as stripped while it sits in the spawn env would
  // make the audit trail lie about what the worker can actually read.
  const brokerSecretsWithheld = strippedBrokerSecrets.filter((key) => env[key] === undefined);
  stripped.push(...brokerSecretsWithheld);

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
        brokerSharedSecretWithheld: brokerSecretsWithheld,
        brokerSharedSecretGranted: strippedBrokerSecrets.filter((key) => env[key] !== undefined),
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
  env.PATH = buildInheritedPath(env.PATH);
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
    // Detached workers have no terminal for git rebase --continue's editor.
    GIT_EDITOR: 'true',
    GIT_SEQUENCE_EDITOR: 'true',
    GIT_TERMINAL_PROMPT: '0',
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
  repo = null,
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
  modelResolution: requestedModelResolution = null,
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
    env: sourceEnv,
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
  installWorkerAdapterEnv(env, sourceEnv, 'claude-code', workerClass, repo, log, startupEvidence.mergeAgentBroker);
  const modelResolution = requestedModelResolution || resolveClaudeRemediationModel(env, {
    hqRoot: hqRoot || sourceEnv.HQ_ROOT,
  });
  const claudeArgs = [
    '--print', '--permission-mode', 'acceptEdits', '--dangerously-skip-permissions',
    '--model', modelResolution.resolvedModel,
    ...(modelResolution.resolvedReasoningLevel ? ['--effort', modelResolution.resolvedReasoningLevel] : []),
  ];
  let promptFd;
  let stdoutFd;
  let stderrFd;
  try {
    promptFd = openSyncImpl(promptPath, 'r');
    stdoutFd = openSyncImpl(outputPath, 'w');
    stderrFd = openSyncImpl(logPath, 'a');
    const child = spawnDetachedCli(
      claudeCli,
      claudeArgs,
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
      ...modelResolution,
      command: [claudeCli, ...claudeArgs],
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
  repo = null,
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
    env: sourceEnv,
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
  installWorkerAdapterEnv(env, sourceEnv, 'gemini', GEMINI_REMEDIATION_WORKER_TRAILER_CLASS, repo, log, startupEvidence.mergeAgentBroker);
  // Resolve from the exact sanitized environment handed to the child. This
  // keeps model selection aligned with future per-worker env overrides rather
  // than reaching back into ambient daemon state.
  const modelResolution = resolveRemediationModel('remediator-gemini', {
    env,
    hqRoot: hqRoot || sourceEnv.HQ_ROOT,
    pin: geminiModelPin(env),
    fallbackModel: DEFAULT_GEMINI_REMEDIATION_MODEL,
  });
  const geminiArgs = ['--approval-mode', 'yolo', '--skip-trust', '-m', modelResolution.resolvedModel];
  let promptFd;
  let stdoutFd;
  let stderrFd;
  try {
    promptFd = openSyncImpl(promptPath, 'r');
    stdoutFd = openSyncImpl(outputPath, 'w');
    stderrFd = openSyncImpl(logPath, 'a');
    const child = spawnDetachedCli(
      geminiCli,
      geminiArgs,
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
      ...modelResolution,
      command: [geminiCli, ...geminiArgs],
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
  repo = null,
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
  modelResolution: requestedModelResolution = null,
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
    env: sourceEnv,
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
  installWorkerAdapterEnv(env, sourceEnv, workerClass, REMEDIATION_WORKER_TRAILER_CLASS, repo, log, startupEvidence.mergeAgentBroker);
  const modelResolution = requestedModelResolution || resolveRemediationModel('remediator-codex', {
    env,
    hqRoot: hqRoot || sourceEnv.HQ_ROOT,
    pin: codexModelPin(env),
    reasoningPin: codexReasoningPin(env),
    fallbackModel: DEFAULT_CODEX_REMEDIATION_MODEL,
  });
  const codexArgs = [
    'exec',
    '--model', modelResolution.resolvedModel,
    ...(CODEX_REASONING_LEVELS.has(modelResolution.resolvedReasoningLevel)
      ? ['-c', `model_reasoning_effort=${modelResolution.resolvedReasoningLevel}`]
      : []),
    '--dangerously-bypass-approvals-and-sandbox',
    '--ephemeral',
    '--json',
    '--output-last-message',
    outputPath,
    '-',
  ];
  let promptFd;
  let stdoutFd;
  let stderrFd;
  try {
    promptFd = openSyncImpl(promptPath, 'r');
    stdoutFd = openSyncImpl(logPath, 'a');
    stderrFd = openSyncImpl(logPath, 'a');
    const child = spawnDetachedCli(
      codexCli,
      codexArgs,
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
      ...modelResolution,
      command: [codexCli, ...codexArgs],
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
  installWorkerAdapterEnv,
  cancelLocalRemediationWorker,
  createLocalRemediationHandle,
  prepareClaudeCodeRemediationStartupEnv,
  prepareCodexRemediationStartupEnv,
  prepareGeminiRemediationStartupEnv,
  resolveClaudeCodeCliPath,
  resolveClaudeRemediationModel,
  resolveCodexAuthPath,
  resolveCodexCliPath,
  resolveCodexRemediationModel,
  resolveGeminiCliPath,
  resolveGeminiRemediationModel,
  resolveRemediationModel,
  resolveNonBlockingCodexModel,
  spawnClaudeCodeRemediationWorker,
  spawnCodexRemediationWorker,
  spawnGeminiRemediationWorker,
  spawnLocalRemediationWorker,
  waitForLocalRemediationExit,
};
