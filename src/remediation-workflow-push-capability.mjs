// Workflow-file push-capability preflight for remediation.
//
// Extracted from follow-up-remediation.mjs (ARC-19 wave3). Self-contained leaf:
// the "before spawning a remediator whose diff touches .github/workflows, prove
// the push credential actually has workflow scope/permission" preflight, plus
// the gh-credential-env, push-token identity/capability inspection, and the
// OAuth-scope / GitHub-App-permission parsing helpers it depends on. It imports
// only node: builtins and ./alert-delivery.mjs and MUST NOT import
// ./follow-up-remediation.mjs (that would create a cycle — the monolith imports
// this module back, not the other way around).

import { execFile } from 'node:child_process';
import { userInfo } from 'node:os';
import { promisify } from 'node:util';
import { deliverAlert } from './alert-delivery.mjs';

const execFileAsync = promisify(execFile);

// Retry backoff for the workflow-push preflight gh probes. Local to this leaf;
// the cluster below is its sole consumer.
const WORKFLOW_PUSH_PREFLIGHT_RETRY_DELAYS_MS = [250, 1000];

// Behavior-preserving local copy of the monolith's sleep helper. The canonical
// sleep lives in follow-up-remediation.mjs (used by other retry paths there);
// this leaf keeps a private copy so it does not import back from the monolith.
function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

// Behavior-preserving local copy of the monolith's repo-slug validator, used by
// remediationTouchesWorkflowFiles before it shells out to `gh pr view`. The
// canonical assertValidRepoSlug / VALID_GITHUB_REPO_SLUG stay in
// follow-up-remediation.mjs (used across the monolith and re-exported for
// tests); duplicating this small pure validator avoids a src->monolith cycle.
const VALID_GITHUB_REPO_SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

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

// Authenticate git's smart-HTTP calls (clone/fetch) through gh's credential
// helper, scoped INLINE rather than relying on a global `gh auth setup-git`
// having been run on the host. The daemon only guarantees an exported
// GITHUB_TOKEN (from `gh auth token`); a fresh host can satisfy that yet have no
// global git credential helper installed, so a plain `git clone
// https://github.com/...` of a private repo would fail authentication even
// though `gh` itself is authenticated.
//
// We inject the config through git's GIT_CONFIG_COUNT/KEY/VALUE env mechanism
// (equivalent to `-c credential.helper=...`) instead of argv, so the git
// invocation's positional arguments are unchanged. Entry 0 resets
// credential.helper to empty first, so a broken or absent global helper can't
// be chained ahead of ours; entry 1 sets `!gh auth git-credential`, which reads
// gh's auth state (honoring GITHUB_TOKEN) and so works from the daemon's
// exported token with no host-global git config. Merged onto the caller's env,
// so GITHUB_TOKEN reaches the credential-helper subprocess.
const GH_GIT_CREDENTIAL_ENV = Object.freeze({
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'credential.helper',
  GIT_CONFIG_VALUE_0: '',
  GIT_CONFIG_KEY_1: 'credential.helper',
  GIT_CONFIG_VALUE_1: '!gh auth git-credential',
});

const REMEDIATION_PUSH_TOKEN_ENV_KEYS = Object.freeze([
  'ADVERSARIAL_REMEDIATION_PUSH_GITHUB_TOKEN',
  'ADVERSARIAL_REMEDIATION_PUSH_TOKEN',
  'REMEDIATION_PUSH_GITHUB_TOKEN',
  'REMEDIATION_PUSH_TOKEN',
]);

const REMEDIATION_PUSH_TOKEN_PERMISSION_ENV_KEYS = Object.freeze([
  'ADVERSARIAL_REMEDIATION_PUSH_TOKEN_PERMISSIONS',
  'REMEDIATION_PUSH_TOKEN_PERMISSIONS',
  'GITHUB_APP_INSTALLATION_PERMISSIONS',
]);

class WorkflowPushCapabilityError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'WorkflowPushCapabilityError';
    this.isWorkflowPushCapabilityError = true;
    Object.assign(this, details);
  }
}

class WorkflowPushPreflightTransientError extends Error {
  constructor(message, { code = 'workflow-push-preflight-transient', cause } = {}) {
    super(message);
    this.name = 'WorkflowPushPreflightTransientError';
    this.isWorkflowPushPreflightTransientError = true;
    this.configKey = code;
    this.code = code;
    this.cause = cause;
  }
}

function workflowPushErrorText(err) {
  return [
    err?.message,
    err?.stdout,
    err?.stderr,
    err?.code,
    err?.signal,
  ].map((value) => String(value || '')).filter(Boolean).join('\n');
}

function isTransientWorkflowPushPreflightError(err) {
  const detail = workflowPushErrorText(err).toLowerCase();
  if (!detail) return true;
  return /timed?\s*out|timeout|socket hang up|eio\b|etimedout|econnreset|econnrefused|econnaborted|enotfound|eai_again|temporary failure|temporarily unavailable|network is unreachable|try again|tls handshake|rate limit|secondary rate limit|too many requests|bad gateway|service unavailable|gateway timeout|server error|http[ /]5\d\d|(^|[^0-9])5(?:00|02|03|04)([^0-9]|$)/i.test(detail);
}

async function execWorkflowPushPreflightGh({
  args,
  options,
  execFileImpl = execFileAsync,
  label,
  log = console,
  retryDelaysMs = WORKFLOW_PUSH_PREFLIGHT_RETRY_DELAYS_MS,
}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      return await execFileImpl('gh', args, options);
    } catch (err) {
      lastErr = err;
      const transient = isTransientWorkflowPushPreflightError(err);
      if (!transient || attempt >= retryDelaysMs.length) {
        throw err;
      }
      const delayMs = Number(retryDelaysMs[attempt] || 0);
      log.warn?.(
        `[follow-up-remediation] workflow-push preflight ${label} transient failure ` +
        `(attempt ${attempt + 1}/${retryDelaysMs.length + 1}); retrying in ${delayMs}ms: ${err?.message || err}`
      );
      if (delayMs > 0) await sleep(delayMs);
    }
  }
  throw lastErr;
}

function firstNonEmptyEnv(env, keys) {
  for (const key of keys) {
    const value = String(env?.[key] || '').trim();
    if (value) return { key, value };
  }
  return null;
}

function resolveConfiguredRemediationPushToken(env = process.env) {
  const resolved = firstNonEmptyEnv(env, REMEDIATION_PUSH_TOKEN_ENV_KEYS);
  if (!resolved) return null;
  return {
    source: 'configured-token',
    envName: resolved.key,
    token: resolved.value,
    identity: env.ADVERSARIAL_REMEDIATION_PUSH_TOKEN_IDENTITY
      || env.REMEDIATION_PUSH_TOKEN_IDENTITY
      || resolved.key,
  };
}

function resolveRemediationPushTokenIdentity(env = process.env) {
  const configured = resolveConfiguredRemediationPushToken(env);
  if (configured) {
    return {
      source: configured.source,
      envName: configured.envName,
      identity: configured.identity,
      configured: true,
    };
  }
  return {
    source: 'ambient-gh',
    envName: env.GITHUB_TOKEN ? 'GITHUB_TOKEN' : (env.GH_TOKEN ? 'GH_TOKEN' : 'gh-auth-state'),
    identity: env.GH_USER || env.GITHUB_ACTOR || 'ambient gh auth',
    configured: false,
  };
}

function withGhGitCredentialEnv(baseEnv) {
  const env = { ...(baseEnv || {}) };
  const configured = resolveConfiguredRemediationPushToken(env);
  if (configured) {
    env.GITHUB_TOKEN = configured.token;
    env.GH_TOKEN = configured.token;
  }
  return { ...env, ...GH_GIT_CREDENTIAL_ENV };
}

function parseOAuthScopesFromGhApiHeaders(output = '') {
  const scopes = new Set();
  for (const line of String(output || '').split(/\r?\n/)) {
    const match = /^x-oauth-scopes:\s*(.*)$/i.exec(line.trim());
    if (!match) continue;
    for (const scope of match[1].split(',')) {
      const normalized = scope.trim().toLowerCase();
      if (normalized) scopes.add(normalized);
    }
  }
  return scopes;
}

function parseOAuthScopesFromGhAuthStatus(output = '') {
  const scopes = new Set();
  for (const line of String(output || '').split(/\r?\n/)) {
    if (!/Token scopes?:/i.test(line)) continue;
    const afterColon = line.split(':').slice(1).join(':');
    for (const rawScope of afterColon.split(',')) {
      const scope = rawScope.replace(/['"`]/g, '').trim().toLowerCase();
      if (scope) scopes.add(scope);
    }
  }
  return scopes;
}

function hasWorkflowOAuthScope(output = '') {
  const headerScopes = parseOAuthScopesFromGhApiHeaders(output);
  if (headerScopes.has('workflow')) return true;
  return parseOAuthScopesFromGhAuthStatus(output).has('workflow');
}

function parseGitHubAppPermissions(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }
  const text = String(value || '').trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed?.permissions && typeof parsed.permissions === 'object') {
      return parsed.permissions;
    }
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    const permissions = {};
    for (const entry of text.split(/[,\s]+/)) {
      const match = /^([A-Za-z0-9_-]+)[:=]([A-Za-z0-9_-]+)$/.exec(entry.trim());
      if (match) permissions[match[1]] = match[2];
    }
    return permissions;
  }
}

function hasWorkflowGitHubAppPermission(value) {
  const permissions = parseGitHubAppPermissions(value);
  const workflowPermission = String(permissions.workflows || permissions.workflow || '').toLowerCase();
  return workflowPermission === 'write';
}

function isWorkflowPath(filePath) {
  return /^\.github\/workflows\/[^/]+\.ya?ml$/i.test(String(filePath || '').trim());
}

function extractChangedPathsFromJob(job) {
  const candidates = [
    job?.changedPaths,
    job?.changedFiles,
    job?.files,
    job?.pullRequest?.changedFiles,
    job?.pullRequest?.files,
    job?.review?.changedFiles,
    job?.review?.files,
    job?.remediationPlan?.changedPaths,
    job?.remediationPlan?.changedFiles,
  ];
  const paths = [];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    for (const entry of candidate) {
      if (typeof entry === 'string') paths.push(entry);
      else if (entry && typeof entry === 'object') {
        const filePath = entry.path || entry.filename || entry.name;
        if (filePath) paths.push(filePath);
      }
    }
  }
  return [...new Set(paths.map((p) => String(p).trim()).filter(Boolean))];
}

async function listPRChangedPaths({
  repo,
  prNumber,
  env = process.env,
  execFileImpl = execFileAsync,
  log = console,
  retryDelaysMs = WORKFLOW_PUSH_PREFLIGHT_RETRY_DELAYS_MS,
}) {
  const authEnv = withGhGitCredentialEnv(env);
  const { stdout } = await execWorkflowPushPreflightGh({
    args: [
      'pr',
      'view',
      String(prNumber),
      '--repo',
      repo,
      '--json',
      'files',
    ],
    options: {
      env: authEnv,
      maxBuffer: 5 * 1024 * 1024,
    },
    execFileImpl,
    label: 'changed-file lookup',
    log,
    retryDelaysMs,
  });
  const parsed = JSON.parse(stdout || '{}');
  const files = Array.isArray(parsed?.files) ? parsed.files : [];
  return files
    .map((file) => (typeof file === 'string' ? file : file?.path || file?.filename || file?.name))
    .map((file) => String(file || '').trim())
    .filter(Boolean);
}

async function remediationTouchesWorkflowFiles({
  job,
  env = process.env,
  execFileImpl = execFileAsync,
  log = console,
  retryDelaysMs = WORKFLOW_PUSH_PREFLIGHT_RETRY_DELAYS_MS,
}) {
  const embeddedPaths = extractChangedPathsFromJob(job);
  if (embeddedPaths.length > 0) {
    return {
      touches: embeddedPaths.some(isWorkflowPath),
      paths: embeddedPaths,
      source: 'job',
    };
  }
  try {
    const livePaths = await listPRChangedPaths({
      repo: assertValidRepoSlug(job.repo),
      prNumber: job.prNumber,
      env,
      execFileImpl,
      log,
      retryDelaysMs,
    });
    return {
      touches: livePaths.some(isWorkflowPath),
      paths: livePaths,
      source: 'gh-pr-view',
    };
  } catch (err) {
    if (!isTransientWorkflowPushPreflightError(err)) {
      throw err;
    }
    log.warn?.(
      `[follow-up-remediation] workflow-push preflight could not list changed paths for ${job?.repo}#${job?.prNumber}: ${err?.message || err}`
    );
    throw new WorkflowPushPreflightTransientError(
      `Workflow-file preflight could not verify changed files for ${job?.repo}#${job?.prNumber}; requeueing instead of bypassing the workflow push capability guard.`,
      { code: 'workflow-push-changed-files-unavailable', cause: err }
    );
  }
}

function parseConfiguredAppPermissionsFromEnv(env = process.env) {
  const configured = firstNonEmptyEnv(env, REMEDIATION_PUSH_TOKEN_PERMISSION_ENV_KEYS);
  if (!configured) return null;
  return {
    source: configured.key,
    permissions: parseGitHubAppPermissions(configured.value),
    hasWorkflowCapability: hasWorkflowGitHubAppPermission(configured.value),
  };
}

async function inspectRemediationPushTokenCapability({
  env = process.env,
  execFileImpl = execFileAsync,
  log = console,
  retryDelaysMs = WORKFLOW_PUSH_PREFLIGHT_RETRY_DELAYS_MS,
} = {}) {
  const identity = resolveRemediationPushTokenIdentity(env);
  const authEnv = withGhGitCredentialEnv(env);
  const configuredPermissions = parseConfiguredAppPermissionsFromEnv(env);
  if (configuredPermissions && identity.configured) {
    return {
      ...identity,
      tokenType: 'github-app',
      hasWorkflowCapability: configuredPermissions.hasWorkflowCapability,
      detection: configuredPermissions.source,
      scopes: [],
      permissions: configuredPermissions.permissions,
    };
  }

  let oauthHeaderOutput = '';
  try {
    const { stdout = '', stderr = '' } = await execWorkflowPushPreflightGh({
      args: ['api', '/', '--include'],
      options: {
        env: authEnv,
        maxBuffer: 1024 * 1024,
      },
      execFileImpl,
      label: 'oauth-scope header probe',
      log,
      retryDelaysMs,
    });
    oauthHeaderOutput = `${stdout}\n${stderr}`;
  } catch (err) {
    oauthHeaderOutput = `${err?.stdout || ''}\n${err?.stderr || ''}`;
    if (!oauthHeaderOutput.trim()) {
      throw new WorkflowPushPreflightTransientError(
        'Workflow-file preflight could not inspect OAuth scopes; requeueing instead of terminalizing a transient token-inspection failure.',
        { code: 'workflow-push-token-inspection-unavailable', cause: err }
      );
    }
  }
  const scopes = [...parseOAuthScopesFromGhApiHeaders(oauthHeaderOutput)];
  if (scopes.length > 0) {
    return {
      ...identity,
      tokenType: 'oauth',
      hasWorkflowCapability: scopes.includes('workflow'),
      detection: 'x-oauth-scopes',
      scopes,
      permissions: null,
    };
  }

  try {
    const { stdout = '', stderr = '' } = await execWorkflowPushPreflightGh({
      args: ['auth', 'status', '-h', 'github.com'],
      options: {
        env: authEnv,
        maxBuffer: 1024 * 1024,
      },
      execFileImpl,
      label: 'gh auth status scope probe',
      log,
      retryDelaysMs,
    });
    const statusScopes = [...parseOAuthScopesFromGhAuthStatus(`${stdout}\n${stderr}`)];
    if (statusScopes.length > 0) {
      return {
        ...identity,
        tokenType: 'oauth',
        hasWorkflowCapability: statusScopes.includes('workflow'),
        detection: 'gh-auth-status',
        scopes: statusScopes,
        permissions: null,
      };
    }
  } catch (err) {
    if (isTransientWorkflowPushPreflightError(err)) {
      throw new WorkflowPushPreflightTransientError(
        'Workflow-file preflight could not inspect gh auth status; requeueing instead of terminalizing a transient token-inspection failure.',
        { code: 'workflow-push-token-inspection-unavailable', cause: err }
      );
    }
    // Fall through to the GitHub App permission probe.
  }

  try {
    const { stdout = '' } = await execWorkflowPushPreflightGh({
      args: ['api', '/installation'],
      options: {
        env: authEnv,
        maxBuffer: 1024 * 1024,
      },
      execFileImpl,
      label: 'installation permission probe',
      log,
      retryDelaysMs,
    });
    const permissions = parseGitHubAppPermissions(stdout);
    return {
      ...identity,
      tokenType: 'github-app',
      hasWorkflowCapability: hasWorkflowGitHubAppPermission(permissions),
      detection: 'installation-permissions',
      scopes: [],
      permissions,
    };
  } catch (err) {
    if (isTransientWorkflowPushPreflightError(err)) {
      throw new WorkflowPushPreflightTransientError(
        'Workflow-file preflight could not inspect installation permissions; requeueing instead of terminalizing a transient token-inspection failure.',
        { code: 'workflow-push-token-inspection-unavailable', cause: err }
      );
    }
    return {
      ...identity,
      tokenType: 'unknown',
      hasWorkflowCapability: false,
      detection: 'unavailable',
      scopes,
      permissions: null,
      error: err?.message || String(err),
    };
  }
}

function workflowPushOperatorAlertText({ job, capability }) {
  const operatorAction = workflowPushOperatorAction(capability);
  return [
    '[follow-up-remediation] Workflow-file remediation blocked before spawn: push credential lacks workflow capability.',
    `PR: ${job.repo}#${job.prNumber}`,
    `Job: ${job.jobId}`,
    `Push identity: ${capability.identity} (${capability.source}; ${capability.envName})`,
    'Required remediation:',
    operatorAction,
    'Context: PR #3110 / clio-airlock root cause was an OAuth token with repo but missing workflow scope, which GitHub rejects for .github/workflows pushes.',
  ].join('\n');
}

function workflowPushOperatorAction(capability) {
  if (capability?.source === 'configured-token') {
    const envName = capability.envName || 'the configured remediation push-token environment variable';
    if (capability.tokenType === 'github-app') {
      return `Update ${envName} or its GitHub App installation permissions so the token has workflows:write before restarting the remediation daemon.`;
    }
    return `Update ${envName} to a PAT/OAuth token with workflow scope, or rotate the configured token source, before restarting the remediation daemon.`;
  }
  const runtimeUser = userInfo().username || '<runtime-user>';
  return `sudo -A -H -u ${runtimeUser} gh auth refresh -h github.com -s workflow`;
}

async function assertWorkflowPushCapabilityForJob({
  job,
  execFileImpl = execFileAsync,
  env = process.env,
  deliverAlertImpl = deliverAlert,
  log = console,
  retryDelaysMs = WORKFLOW_PUSH_PREFLIGHT_RETRY_DELAYS_MS,
} = {}) {
  const workflowTouch = await remediationTouchesWorkflowFiles({ job, env, execFileImpl, log, retryDelaysMs });
  if (!workflowTouch.touches) {
    const identity = resolveRemediationPushTokenIdentity(env);
    log.log?.(
      `[follow-up-remediation] push-token workflow capability repo=${job.repo} pr=${job.prNumber} ` +
      `source=${identity.source} identity=${identity.identity} workflow=not-required detection=${workflowTouch.source}`
    );
    return {
      gated: false,
      workflowTouch,
      capability: {
        ...identity,
        tokenType: 'not-checked',
        hasWorkflowCapability: null,
        detection: workflowTouch.source,
        scopes: [],
        permissions: null,
      },
    };
  }

  const capability = await inspectRemediationPushTokenCapability({ env, execFileImpl, log, retryDelaysMs });
  log.log?.(
    `[follow-up-remediation] push-token workflow capability repo=${job.repo} pr=${job.prNumber} ` +
    `source=${capability.source} identity=${capability.identity} workflow=${capability.hasWorkflowCapability ? 'yes' : 'no'} ` +
    `detection=${capability.detection}`
  );
  if (capability.hasWorkflowCapability) {
    return {
      gated: false,
      workflowTouch,
      capability,
    };
  }

  const alertText = workflowPushOperatorAlertText({ job, capability });
  const operatorAction = workflowPushOperatorAction(capability);
  try {
    await deliverAlertImpl(alertText, {
      event: 'remediation-workflow-push-capability-missing',
      severity: 'critical',
      repo: job.repo,
      prNumber: job.prNumber,
      jobId: job.jobId,
      pushToken: {
        source: capability.source,
        envName: capability.envName,
        identity: capability.identity,
        tokenType: capability.tokenType,
        detection: capability.detection,
        hasWorkflowCapability: false,
      },
      operatorAction,
    });
  } catch (alertErr) {
    log.error?.(`[follow-up-remediation] workflow-push capability alert delivery failed: ${alertErr?.message || alertErr}`);
  }
  throw new WorkflowPushCapabilityError(
    `Workflow-file remediation for ${job.repo}#${job.prNumber} requires push token workflow capability; operator must refresh the runtime gh auth with workflow scope.`,
    {
      workflowTouch,
      capability,
      operatorAction,
    }
  );
}

export {
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
};
