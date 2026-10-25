import { loadAwareTimeoutMs, MAX_TIMER_DELAY_MS } from './load-aware-timeout.mjs';
import { readAdapterReceipt } from './producer-contracts/publication-receipt.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { awaitThrottleIfNeeded, githubCredential, isGitHubRateLimitError, recordRateLimitedCall, extractRateLimitObservation, currentGitHubBudgetScope, markGitHubRateLimited } from './rate-limit-throttle.mjs';
import { filterGitHubBody } from './github-outbound-body.mjs';
import { recordMergeActionBestEffort } from './ama/merge-action-receipt.mjs';
import { execGhWithRetry, isTransientGhError } from './gh-cli.mjs';
import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isUnsupportedOperationPayload,
  isUnsupportedOperationText,
} from './github-adapter-unsupported.mjs';

const adapterReadTick = new AsyncLocalStorage();

// Logical client kinds and the adapter's documented CLI subcommands. Kinds
// without an entry are probed by name and may be refused by older adapters.
export const ADAPTER_READ_COMMANDS = Object.freeze({
  'pull-request': 'pr-state',
  'pull-request-head-state': 'pr-state',
  'pull-request-rollup': 'pr-state',
  'pull-request-review-context': 'pr-state',
  'pull-request-review-bodies-for-head': 'pr-reviews',
  'latest-label-event': 'label-events',
  'pr-state': 'pr-state',
  'pr-reviews': 'pr-reviews',
  'issue-comments': 'issue-comments',
  labels: 'labels',
  'check-rollup': 'check-rollup',
  'label-events': 'label-events',
  'prs-by-head': 'prs-by-head',
  'search-merged-prs': 'search-merged-prs',
  'rate-limit': 'rate-limit',
});

// Capability skew is stable within a tick. Authentication/network failures are
// request-specific and must never disable an otherwise supported transport.
export async function withGitHubAdapterReadTick(run, { logger = console } = {}) {
  if (adapterReadTick.getStore()?.open) return run();
  const state = { unsupported: new Map(), open: true, logger };
  try { return await adapterReadTick.run(state, run); }
  finally { state.open = false; state.unsupported.clear(); }
}

function unsupportedReadCapability(error, kind) {
  for (const output of [error?.stdout, error?.stderr]) {
    let payload;
    try { payload = JSON.parse(String(output)); } catch { continue; }
    if (payload?.failureClass !== 'unsupported') continue;
    const command = ADAPTER_READ_COMMANDS[kind] ?? kind;
    if (payload.code === 'unsupported_command' && payload.requested === command) return command;
    if (payload.code === 'unsupported_kind' && payload.requested === kind) return command;
  }
  return null;
}

const ADAPTER_MAX_BUFFER = 25 * 1024 * 1024;
const ADAPTER_TIMEOUT_MS = 30_000;

const REVIEWER_ADAPTER_AUTH_BY_ROLE = Object.freeze({
  'claude-reviewer': {
    selector: 'claude-reviewer',
    tokenEnv: 'GH_CLAUDE_REVIEWER_TOKEN',
  },
  'codex-reviewer': {
    selector: 'codex-reviewer',
    tokenEnv: 'GH_CODEX_REVIEWER_TOKEN',
  },
  'gemini-reviewer': {
    selector: 'gemini-reviewer',
    tokenEnv: 'GH_GEMINI_REVIEWER_TOKEN',
  },
});

function reviewerRoleFromLogin(login) {
  const normalized = String(login || '').trim().toLowerCase().replace(/\[bot\]$/, '');
  if (!normalized) return null;
  for (const role of Object.keys(REVIEWER_ADAPTER_AUTH_BY_ROLE)) {
    if (
      normalized === role ||
      normalized === `${role}-lacey` ||
      normalized.endsWith(`-${role}`)
    ) {
      return role;
    }
  }
  return null;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return null;
}

function isFalseLike(value) {
  return ['0', 'false', 'no', 'off'].includes(String(value ?? '').trim().toLowerCase());
}

function repoRootFromHere() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

function candidateSuperprojectAdapterPaths(rootDir = repoRootFromHere()) {
  return [
    join(rootDir, 'modules', 'github-adapter', 'bin', 'github-adapter'),
    join(rootDir, '..', 'modules', 'github-adapter', 'bin', 'github-adapter'),
    join(rootDir, '..', '..', 'modules', 'github-adapter', 'bin', 'github-adapter'),
  ];
}

function trustedAutoDiscoveryRoots(rootDir = repoRootFromHere()) {
  return [
    resolve(rootDir, 'modules', 'github-adapter'),
    resolve(rootDir, '..', 'modules', 'github-adapter'),
    resolve(rootDir, '..', '..', 'modules', 'github-adapter'),
  ];
}

function isPathWithin(childPath, parentPath) {
  const child = resolve(childPath);
  const parent = resolve(parentPath);
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function realpathOrNull(candidate, realpathImpl) {
  try {
    return resolve(realpathImpl(candidate));
  } catch {
    return null;
  }
}

function isTrustedOwner(uid) {
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
  return currentUid === null || [currentUid, 0].includes(uid);
}

function isTrustedDirectoryChain(startDir, trustedRoot, { statImpl }) {
  const root = resolve(trustedRoot);
  let current = resolve(startDir);
  for (;;) {
    if (!isPathWithin(current, root)) return false;
    let stats;
    try {
      stats = statImpl(current);
    } catch {
      return false;
    }
    if (!stats?.isDirectory?.()) return false;
    if ((stats.mode & 0o022) !== 0) return false;
    if (!isTrustedOwner(stats.uid)) return false;
    if (current === root) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function isTrustedAutoDiscoveredAdapterBin(candidate, {
  rootDir = repoRootFromHere(),
  statImpl = statSync,
  lstatImpl = lstatSync,
  realpathImpl = realpathSync,
} = {}) {
  const resolved = resolve(candidate);
  let linkStats;
  try {
    linkStats = lstatImpl(resolved);
  } catch {
    return false;
  }
  if (linkStats?.isSymbolicLink?.()) return false;
  if (!linkStats?.isFile?.()) return false;
  const realCandidate = realpathOrNull(resolved, realpathImpl);
  if (!realCandidate) return false;
  const trustedRoot = trustedAutoDiscoveryRoots(rootDir)
    .map((root) => realpathOrNull(root, realpathImpl))
    .filter(Boolean)
    .find((root) => isPathWithin(realCandidate, root));
  if (!trustedRoot) return false;
  if (!isTrustedDirectoryChain(dirname(realCandidate), trustedRoot, { statImpl })) return false;

  let stats;
  try {
    stats = statImpl(realCandidate);
  } catch {
    return false;
  }
  if (!stats?.isFile?.()) return false;
  if ((stats.mode & 0o111) === 0) return false;
  if ((stats.mode & 0o022) !== 0) return false;
  if (!isTrustedOwner(stats.uid)) return false;
  return true;
}

function resolveGitHubAdapterBin({
  env = process.env,
  rootDir = repoRootFromHere(),
  existsImpl = existsSync,
  statImpl = statSync,
  lstatImpl = lstatSync,
  realpathImpl = realpathSync,
} = {}) {
  const explicit = firstNonEmpty(env.GHA_ADAPTER_BIN, env.AGENT_OS_GITHUB_ADAPTER_BIN);
  if (explicit) return explicit;
  const autoDiscovery = firstNonEmpty(env.AGENT_OS_GITHUB_ADAPTER_AUTO_DISCOVERY);
  if (isFalseLike(autoDiscovery)) return null;
  for (const candidate of candidateSuperprojectAdapterPaths(rootDir)) {
    if (existsImpl(candidate) && isTrustedAutoDiscoveredAdapterBin(candidate, {
      rootDir,
      statImpl,
      lstatImpl,
      realpathImpl,
    })) {
      return candidate;
    }
  }
  return null;
}

function normalizePrNumber(prNumber) {
  const normalized = Number(String(prNumber ?? '').trim());
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new TypeError(`Invalid GitHub PR number: ${prNumber}`);
  }
  return normalized;
}

function parseAdapterJson(stdout, kind) {
  const text = String(stdout || '').trim();
  if (!text) {
    throw new Error(`agent_os_github_adapter.ResultEnvelope: $stdout empty ${kind} payload`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    const wrapped = new Error(`agent_os_github_adapter.ResultEnvelope: $stdout malformed ${kind} JSON: ${err?.message || err}`);
    wrapped.cause = err;
    throw wrapped;
  }
}

function buildAdapterEnv(env = process.env) {
  const adapterEnv = {};
  for (const key of [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'TMPDIR',
    'GHO_RATE_LIMIT_SHARED_STATE_PATH',
    'GHO_RATE_LIMIT_THROTTLE_FLOOR',
    'AGENT_OS_GITHUB_ADAPTER_AUTH',
    'AGENT_OS_GITHUB_ADAPTER_AUTH_MODE',
    'AGENT_OS_GITHUB_ADAPTER_TRANSPORT',
    'AGENT_OS_GITHUB_ADAPTER_ENV_TOKEN_FROM_AMBIENT_GH',
    'AGENT_OS_GITHUB_ADAPTER_ALLOW_FIXTURE_READS',
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'GH_CLAUDE_REVIEWER_TOKEN',
    'GH_CODEX_REVIEWER_TOKEN',
    'GH_GEMINI_REVIEWER_TOKEN',
    'GH_CLAUDE_REVIEWER_TOKEN_SOURCE',
    'GH_CODEX_REVIEWER_TOKEN_SOURCE',
    'GH_GEMINI_REVIEWER_TOKEN_SOURCE',
    'GH_CLAUDE_REVIEWER_TOKEN_BROKER_PROVIDER',
    'GH_CODEX_REVIEWER_TOKEN_BROKER_PROVIDER',
    'GH_GEMINI_REVIEWER_TOKEN_BROKER_PROVIDER',
    // Broker mint inputs: allow --auth-mode broker to resolve a fresh
    // per-role App installation token when a reviewer env-token is absent
    // (a remediation reply from a non-active-reviewer worker class).
    'OAUTH_BROKER_URL',
    'OAUTH_BROKER_SHARED_SECRET_FILE',
    'CLAUDE_REVIEWER_AUTH_VIA_BROKER',
    'CODEX_REVIEWER_AUTH_VIA_BROKER',
    'GEMINI_REVIEWER_AUTH_VIA_BROKER',
    'OAUTH_BROKER_CLAUDE_REVIEWER_PROVIDER',
    'OAUTH_BROKER_CODEX_REVIEWER_PROVIDER',
    'OAUTH_BROKER_GEMINI_REVIEWER_PROVIDER',
    'OAUTH_BROKER_CLAUDE_REVIEWER_EXPECTED_APP_ID',
    'OAUTH_BROKER_CODEX_REVIEWER_EXPECTED_APP_ID',
    'OAUTH_BROKER_GEMINI_REVIEWER_EXPECTED_APP_ID',
    'OAUTH_BROKER_CLAUDE_REVIEWER_EXPECTED_INSTALLATION_ID',
    'OAUTH_BROKER_CODEX_REVIEWER_EXPECTED_INSTALLATION_ID',
    'OAUTH_BROKER_GEMINI_REVIEWER_EXPECTED_INSTALLATION_ID',
    'GH_CONFIG_DIR',
    'GH_HOST',
    'GITHUB_HOST',
    'LANG',
    'LC_ALL',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
    'NODE_EXTRA_CA_CERTS',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'SSL_CERT_FILE_BUNDLE',
  ]) {
    if (env[key] !== undefined) adapterEnv[key] = env[key];
  }
  if (!adapterEnv.GH_TOKEN && adapterEnv.GITHUB_TOKEN) {
    adapterEnv.GH_TOKEN = adapterEnv.GITHUB_TOKEN;
  }
  return adapterEnv;
}

function appendCommonAdapterArgs(args, params = {}) {
  if (params.repo) args.push('--repo', String(params.repo));
  if (params.prNumber !== undefined) args.push('--pr-number', String(normalizePrNumber(params.prNumber)));
  if (params.headSha) args.push('--head-sha', String(params.headSha));
  if (Array.isArray(params.reviewerLogins)) {
    for (const login of params.reviewerLogins) {
      const normalized = String(login || '').trim();
      if (normalized) args.push('--reviewer-login', normalized);
    }
  }
  if (params.labelName) args.push('--label', String(params.labelName));
  if (params.currentHeadSha) args.push('--current-head-sha', String(params.currentHeadSha));
  if (params.withLabels === false) args.push('--no-labels');
  if (params.limit !== undefined) args.push('--limit', String(params.limit));
  return args;
}

function makeAdapterArgs(kind, params = {}, env = {}) {
  const command = ADAPTER_READ_COMMANDS[kind] ?? kind;
  const args = [command, '--json'];
  if (command !== 'rate-limit') {
    if (params.repo) args.push('--repo', String(params.repo));
    if (!['prs-by-head', 'search-merged-prs'].includes(command) && params.prNumber !== undefined) {
      args.push('--number', String(normalizePrNumber(params.prNumber)));
    }
  }
  if (command === 'label-events' && params.labelName) args.push('--label', String(params.labelName));
  if (command === 'prs-by-head' && params.head) args.push('--head', String(params.head));
  if (command === 'search-merged-prs') {
    if (params.ticket) args.push('--ticket', String(params.ticket));
    if (params.graphql === false) args.push('--no-graphql');
  }
  // Head/reviewer filters, label inclusion and limits are caller-side options;
  // these subcommands do not accept the unified write seam's flags.
  appendMergeAgentServiceAuthAdapterArgs(args, kind, params, env);
  return args;
}

// 'codex-reviewer' -> 'CODEX_REVIEWER' (broker env-var prefix).
function reviewerRoleEnvPrefix(role) {
  return String(role || '').toUpperCase().replace(/-/g, '_');
}

// Build --auth-mode broker adapter args for a reviewer role when the broker
// is configured (flag on + expected App/installation ids present). Returns
// null when the broker is not configured for the role so the caller can keep
// the env-token path. The adapter mints a fresh App installation token from
// the OAuth broker, so this does NOT depend on a reviewer env-token being
// pre-resolved into the process env.
function reviewerBrokerAuthArgs(role, profile, login, env = {}) {
  const prefix = reviewerRoleEnvPrefix(role);
  if (String(env?.[`${prefix}_AUTH_VIA_BROKER`] || '').trim().toLowerCase() !== 'true') {
    return null;
  }
  const appId = String(env?.[`OAUTH_BROKER_${prefix}_EXPECTED_APP_ID`] || '').trim();
  const installationId = String(
    env?.[`OAUTH_BROKER_${prefix}_EXPECTED_INSTALLATION_ID`] || ''
  ).trim();
  if (!appId || !installationId) return null;
  const provider =
    String(env?.[`OAUTH_BROKER_${prefix}_PROVIDER`] || '').trim() || `github-app-${role}`;
  return [
    '--auth',
    profile.selector,
    '--auth-mode',
    'broker',
    '--broker-provider',
    provider,
    '--expected-app-id',
    appId,
    '--expected-installation-id',
    installationId,
    '--expected-login',
    login,
  ];
}

function appendReviewerAuthAdapterArgs(args, reviewerLogin, env = {}) {
  const normalized = String(reviewerLogin || '').trim().toLowerCase();
  const role = reviewerRoleFromLogin(normalized);
  const profile = REVIEWER_ADAPTER_AUTH_BY_ROLE[role];
  if (!profile) return args;
  // Prefer the already-resolved reviewer env-token (the ACTIVE reviewer
  // class' token, refreshed into env by reviewer-token-refresh). But a
  // remediation reply worker may be a class that is NOT the active reviewer
  // (e.g. a codex remediation worker in a gemini-reviewed pipeline), so its
  // reviewer token is never resolved into env and env-token auth hard-fails
  // -> the comment is never posted (0 deliveries; task #23). When the
  // env-token is absent but the reviewer broker is configured, mint a fresh
  // per-role App installation token via the broker instead. Either way this
  // binds an explicit --auth selector, so the write never falls through to
  // ambient gh auth (the clio-airlock operator identity).
  const envTokenPresent = Boolean(String(env?.[profile.tokenEnv] || '').trim());
  if (!envTokenPresent) {
    const brokerArgs = reviewerBrokerAuthArgs(role, profile, normalized, env);
    if (brokerArgs) {
      args.push(...brokerArgs);
      return args;
    }
  }
  args.push(
    '--auth',
    profile.selector,
    '--auth-mode',
    'env-token',
    '--pat-env',
    profile.tokenEnv,
    '--expected-login',
    normalized
  );
  return args;
}

// Watcher/merge-agent-owned reads and writes (labels, commit-status, PR state)
// carry no reviewer identity, so appendReviewerAuthAdapterArgs never binds a
// token for them.
// Without an explicit --auth selector the adapter defaults to the fixture
// selector, whose gh-cli transport strips ambient GH_TOKEN/GITHUB_TOKEN and only
// re-injects an explicitly-resolved auth token. The call therefore falls
// through to `gh`'s ambient keychain, which is invalid in the headless launchd
// watcher session -> HTTP 401 on api.github.com/graphql (observed ~1k/tick on
// stuck `merge-agent-dispatched` label cleanups; auth:{mode:ambient-gh,
// selector:default}, source:gh-cli).
//
// The watcher start script resolves a broker-backed App installation token into
// GITHUB_TOKEN/GH_TOKEN (WATCHER_GH_AUTH_VIA_BROKER=true, role
// WATCHER_GH_BROKER_ROLE, default merge-agent) and refreshes it per tick. When
// that explicit signal is present, bind these service-owned calls to env-token
// auth so the adapter uses the already-resolved broker token instead of
// discarding it. Gated on the watcher signal (never on ambient process.env) so
// tests and tokenless callers are unaffected, skipped when reviewer identity is
// already bound, and deliberately NOT applied to `pull-request-merge` so the
// load-bearing merge write keeps its existing ambient-attempt + fast-merge
// `gh --admin` fallback path untouched.
function appendMergeAgentServiceAuthAdapterArgs(args, kind, params = {}, env = {}) {
  if (params.reviewerLogin) return args;
  if (kind === 'pull-request-merge') return args;
  if (String(env?.WATCHER_GH_AUTH_VIA_BROKER || '').trim().toLowerCase() !== 'true') return args;
  const hasServiceToken = Boolean(
    String(env?.GITHUB_TOKEN || '').trim() || String(env?.GH_TOKEN || '').trim()
  );
  if (!hasServiceToken) return args;
  const selector = String(env?.WATCHER_GH_BROKER_ROLE || '').trim() || 'merge-agent';
  args.push('--auth', selector, '--auth-mode', 'env-token', '--pat-env', 'GITHUB_TOKEN', '--pat-env', 'GH_TOKEN');
  return args;
}

function makeAdapterWriteArgs(kind, params = {}, env = {}) {
  const args = ['write', '--kind', kind, '--json'];
  appendCommonAdapterArgs(args, params);
  if (params.body !== undefined) args.push('--body', filterGitHubBody(params.body, { repo: params.repo, reviewerHeadSha: params.headSha }));
  if (params.state !== undefined) args.push('--state', String(params.state));
  if (params.context !== undefined) args.push('--context', String(params.context));
  if (params.description !== undefined) args.push('--description', String(params.description));
  if (params.action !== undefined) args.push('--action', String(params.action));
  if (params.reviewerLogin) args.push('--reviewer-login', String(params.reviewerLogin));
  appendReviewerAuthAdapterArgs(args, params.reviewerLogin, env);
  if (params.matchHeadCommit !== undefined) args.push('--match-head-commit', String(params.matchHeadCommit));
  if (params.mergeMethod !== undefined) args.push('--merge-method', String(params.mergeMethod));
  if (params.deleteBranch !== undefined) args.push(params.deleteBranch ? '--delete-branch' : '--no-delete-branch');
  if (params.admin === true) args.push('--admin');
  appendMergeAgentServiceAuthAdapterArgs(args, kind, params, env);
  return args;
}

async function runGitHubAdapter(kind, params = {}, {
  execFileImpl,
  env = process.env,
  rootDir,
} = {}) {
  if (typeof execFileImpl !== 'function') {
    throw new TypeError('runGitHubAdapter requires execFileImpl');
  }
  const adapterBin = resolveGitHubAdapterBin({ env, rootDir });
  if (!adapterBin) return null;
  const tick = adapterReadTick.getStore();
  const unsupported = tick?.open ? tick.unsupported.get(adapterBin) : null;
  if (unsupported?.has(ADAPTER_READ_COMMANDS[kind] ?? kind)) return null;
  try {
    const { stdout } = await execFileImpl(adapterBin, makeAdapterArgs(kind, params, env), {
      maxBuffer: ADAPTER_MAX_BUFFER,
      timeout: loadAwareTimeoutMs(ADAPTER_TIMEOUT_MS),
      env: buildAdapterEnv(env),
    });
    const payload = parseAdapterJson(stdout, kind);
    if (payload?.ok === false) throw Object.assign(new Error(`${payload.message || 'GitHub adapter read failed'}; ${readAdapterReceipt(payload).diagnostics.join('; ')}`), { stdout });
    if (payload?.complete === false) throw new Error('GitHub adapter read is incomplete; agent_os_github_adapter.ResultEnvelope: $.complete=false');
    return payload;
  } catch (error) {
    const capability = unsupportedReadCapability(error, kind);
    if (tick?.open && capability) {
      let unavailable = tick.unsupported.get(adapterBin);
      if (!unavailable) { unavailable = new Set(); tick.unsupported.set(adapterBin, unavailable); }
      if (!unavailable.has(capability)) {
        unavailable.add(capability);
        tick.logger?.warn?.(`[github-adapter] unsupported ${capability}; skipping this read transport for the rest of the tick; using existing fallback`);
      }
    }
    throw error;
  }
}

function adapterUnsupportedError(err) {
  if (!err) return false;
  if ([err.code, err.exitCode, err.status].some((code) => Number(code) === 78)) return true;

  // Prefer the adapter contract: failureClass:"unsupported" plus a stable code
  // such as unsupported_command/unsupported_kind/unsupported_argument. The
  // helper intentionally keeps legacy argparse input-prose detection below that
  // structured branch so older adapter binaries can still fall back cleanly.
  const candidates = [
    err?.message,
    err?.stderr,
    err?.stdout,
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (isUnsupportedOperationText(candidate)) return true;
  }

  return isUnsupportedOperationPayload(err);
}

// The label adapter queries GraphQL before mutation. Its subprocess does not
// share AsyncLocalStorage with the watcher, so account failures at this seam.
async function executeLabelAdapter(execFileImpl, adapterBin, args, options) {
  const index = args.indexOf('--auth');
  const selector = index >= 0 ? args[index + 1] : 'default';
  const tokenNames = args.flatMap((arg, i) => arg === '--pat-env' ? [args[i + 1]] : []);
  const token = tokenNames.map(name => options.env[name]).find(Boolean);
  const credential = token ? githubCredential({ token }) : `adapter:${selector}`;
  // Outside a watcher scope the adapter owns its own transport admission.
  // Parent accounting is needed to carry its failure into the enclosing poll.
  const scope = currentGitHubBudgetScope();
  if (scope) await awaitThrottleIfNeeded('graphql', credential);
  try {
    const result = await execFileImpl(adapterBin, args, options);
    const payload = parseAdapterJson(result.stdout, 'pull-request-label');
    if (payload.ok === false) throw Object.assign(new Error(`${payload.message || 'GitHub label mutation failed'}; ${readAdapterReceipt(payload).diagnostics.join('; ')}`), { stdout: result.stdout });
    return result;
  } catch (err) {
    if (isGitHubRateLimitError(err) && !err.budgetDeferred) {
      const observation = extractRateLimitObservation(err.response?.headers, { resource: 'graphql', rateLimited: true });
      err.rateLimited = true;
      err.observation = scope
        ? await recordRateLimitedCall('graphql', credential, { ...observation, credentialSelector: selector })
        : markGitHubRateLimited('graphql', credential, observation || {});
    }
    throw err;
  }
}

async function writeGitHubAdapter(kind, params = {}, {
  execFileImpl,
  env = process.env,
  rootDir,
  timeoutMs,
} = {}) {
  if (typeof execFileImpl !== 'function') {
    throw new TypeError('writeGitHubAdapter requires execFileImpl');
  }
  const adapterBin = resolveGitHubAdapterBin({ env, rootDir });
  if (!adapterBin) return null;
  const execute = kind === 'pull-request-label' ? executeLabelAdapter : (impl, bin, args, options) => impl(bin, args, options);
  const { stdout } = await execute(execFileImpl, adapterBin, makeAdapterWriteArgs(kind, params, env), {
    maxBuffer: ADAPTER_MAX_BUFFER,
    // Callers with a persisted deadline pass an already-scaled, clipped budget.
    timeout: Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, MAX_TIMER_DELAY_MS) : loadAwareTimeoutMs(ADAPTER_TIMEOUT_MS),
    env: buildAdapterEnv(env),
  });
  const receipt = readAdapterReceipt(parseAdapterJson(stdout, kind));
  return {
    ran: true,
    payload: receipt.payload,
    ...(receipt.diagnostics.length ? { diagnostic: receipt.diagnostics.join('; ') } : {}),
  };
}

function asPayloadObject(payload, kind) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`agent_os_github_adapter.ResultEnvelope: $ invalid; GitHub adapter ${kind} payload must be an object`);
  }
  return payload;
}

function unwrapPayload(payload, key, kind) {
  const object = asPayloadObject(payload, kind);
  return object[key] ?? object.data ?? object;
}

async function readAdapterPrRollup(repo, prNumber, options) {
  const payload = await runGitHubAdapter('pull-request-rollup', { repo, prNumber }, options);
  if (!payload) return null;
  // pr-state currently omits mergeability. The caller's existing rollup
  // validator must refuse that partial shape and use its established fallback.
  return normalizeAdapterPr(payload, 'rollup', 'pull-request-rollup');
}

function normalizeAdapterPr(payload, key, kind) {
  const object = asPayloadObject(payload, kind);
  // Preserve explicit absence instead of normalizing the envelope as a PR.
  const pr = Object.hasOwn(object, key) ? object[key]
    : Object.hasOwn(object, 'data') ? object.data : object;
  if (!pr || typeof pr !== 'object' || Array.isArray(pr)) return null;
  return {
    ...pr,
    number: pr.number ?? pr.pr?.number,
    mergedAt: pr.mergedAt ?? pr.merged_at,
    closedAt: pr.closedAt ?? pr.closed_at,
  };
}

async function readAdapterReviewContext(repo, prNumber, options) {
  const tick = adapterReadTick.getStore();
  if (tick?.open) {
    const adapterBin = resolveGitHubAdapterBin({ env: options?.env ?? process.env, rootDir: options?.rootDir });
    if (tick.unsupported.get(adapterBin)?.has('issue-comments')) return null;
  }
  const payload = await runGitHubAdapter('pull-request-review-context', { repo, prNumber }, options);
  if (!payload) return null;
  const pr = normalizeAdapterPr(payload, 'rollup', 'pull-request-review-context');
  if (!pr) return null;
  const comments = pr.comments ?? await readAdapterIssueComments(repo, prNumber, options);
  if (!Array.isArray(comments)) return null;
  return { ...pr, comments: comments.map(comment => ({
    ...comment,
    author: comment.author ?? comment.user,
    createdAt: comment.createdAt ?? comment.created_at,
    authorAssociation: comment.authorAssociation ?? comment.author_association,
    authorType: comment.authorType ?? comment.user?.type,
  })) };
}

async function readAdapterHeadAndState(repo, prNumber, { withLabels = true, ...options } = {}) {
  const payload = await runGitHubAdapter('pull-request-head-state', { repo, prNumber, withLabels }, options);
  if (!payload) return null;
  return unwrapPayload(payload, 'headState', 'pull-request-head-state');
}

async function readAdapterReviewBodiesForHead(repo, prNumber, headSha, { reviewerLogins = null, ...options } = {}) {
  const payload = await runGitHubAdapter('pull-request-review-bodies-for-head', {
    repo,
    prNumber,
    headSha,
    reviewerLogins,
  }, options);
  if (!payload) return null;
  const bodies = payload.reviews ?? unwrapPayload(payload, 'bodies', 'pull-request-review-bodies-for-head');
  if (!Array.isArray(bodies)) {
    throw new Error('GitHub adapter review bodies payload must be an array');
  }
  return bodies.map((body) => {
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      return {
        author: body.author ?? body.user ?? null,
        body: String(body.body || ''),
        state: body.state ?? null,
        submittedAt: body.submittedAt ?? body.submitted_at ?? null,
        commitId: body.commitId ?? body.commit_id ?? body.commit?.oid ?? null,
      };
    }
    return String(body || '');
  });
}

async function readAdapterLatestLabelEvent(repo, prNumber, labelName, { currentHeadSha = null, ...options } = {}) {
  const payload = await runGitHubAdapter('latest-label-event', { repo, prNumber, labelName, currentHeadSha }, options);
  if (!payload) return null;
  const events = payload.events ?? [unwrapPayload(payload, 'event', 'latest-label-event')];
  if (!Array.isArray(events)) throw new Error('GitHub adapter label events must be an array');
  const event = events.filter(event => (
    String(event?.label?.name ?? event?.label ?? '').toLowerCase() === String(labelName).toLowerCase()
    && String(event?.event ?? 'labeled').toLowerCase() === 'labeled'
  )).sort((a, b) => String(a.createdAt ?? a.created_at ?? '').localeCompare(String(b.createdAt ?? b.created_at ?? ''))).at(-1);
  // A label timeline without a code anchor cannot authorize the current head.
  if (!event || (currentHeadSha && (event.headSha !== currentHeadSha || !event.codeScopedAt))) return null;
  return { ...event, actor: typeof event.actor === 'string' ? { login: event.actor } : event.actor };
}

async function readAdapterIssueComments(repo, prNumber, options) {
  const payload = await runGitHubAdapter('issue-comments', { repo, prNumber }, options);
  if (!payload) return null;
  const comments = unwrapPayload(payload, 'comments', 'issue-comments');
  if (!Array.isArray(comments)) {
    throw new Error('GitHub adapter issue-comments payload must be an array');
  }
  return comments;
}

async function readAdapterOpenPullRequests(repo, options) {
  const payload = await runGitHubAdapter('open-pull-requests', { repo }, options);
  if (!payload) return null;
  const pullRequests = unwrapPayload(payload, 'pullRequests', 'open-pull-requests');
  if (!Array.isArray(pullRequests)) {
    throw new Error('GitHub adapter open-pull-requests payload must be an array');
  }
  return pullRequests;
}

async function readAdapterPullRequest(repo, prNumber, options) {
  const payload = await runGitHubAdapter('pull-request', { repo, prNumber }, options);
  if (!payload) return null;
  return normalizeAdapterPr(payload, 'pullRequest', 'pull-request');
}

async function readAdapterPullRequestDiff(repo, prNumber, options) {
  const payload = await runGitHubAdapter('pull-request-diff', { repo, prNumber }, options);
  if (!payload) return null;
  if (typeof payload === 'string') return payload.trim() ? payload : null;
  const diff = payload.diff ?? payload.representation ?? payload.data;
  if (typeof diff !== 'string') {
    throw new Error('GitHub adapter pull-request-diff payload must contain a string diff');
  }
  return diff.trim() ? diff : null;
}

async function writeAdapterPullRequestReview(repo, prNumber, { body, reviewerLogin = null } = {}, options = {}) {
  const headSha = options.reviewerHeadSha || options.headSha;
  body = filterGitHubBody(body, { ...options, repo, reviewerHeadSha: headSha });
  return writeGitHubAdapter('pull-request-review', { repo, prNumber, body, reviewerLogin, headSha }, options);
}

async function writeAdapterIssueComment(repo, prNumber, { body, reviewerLogin = null } = {}, options) {
  body = filterGitHubBody(body, { repo, ...options });
  return writeGitHubAdapter('issue-comment', { repo, prNumber, body, reviewerLogin }, options);
}

async function writeAdapterCommitStatus(repo, headSha, {
  state,
  context,
  description,
} = {}, options) {
  return writeGitHubAdapter('commit-status', { repo, headSha, state, context, description }, options);
}

async function writeAdapterPullRequestLabel(repo, prNumber, { action, labelName } = {}, options) {
  return writeGitHubAdapter('pull-request-label', { repo, prNumber, action, labelName }, options);
}

function adapterMergeRefused(payload) {
  return payload?.ok === false && !payload.merged && payload.state !== 'MERGED'
    && !payload.idempotent && !payload.data?.idempotent
    && !isUnsupportedOperationPayload(payload)
    && payload.failureClass === 'permanent'
    && !/head[ -]?(mismatch|changed)|head sha did not match|stale[ -]?(head|revision)|match.head.commit|404|not found/i.test(JSON.stringify(payload))
    && !/already merged/i.test(JSON.stringify(payload))
    && !isTransientGhError({ code: payload.code, stderr: JSON.stringify(payload) });
}

async function writeAdapterPullRequestMerge(repo, prNumber, {
  body,
  matchHeadCommit,
  mergeMethod = 'squash',
  deleteBranch = true,
  admin = false,
} = {}, options) {
  // The deployed adapter merge contract cannot forward an explicit commit body.
  // Decline this seam so callers use gh with the sanitized body.
  const env = options?.env || process.env;
  const logger = options?.logger || console;
  if (body !== undefined) {
    logger?.warn?.(`[github-adapter] explicit merge message unsupported for ${repo}#${prNumber}; declining adapter, caller must use gh with explicit subject/body`);
    return { ran: false };
  }
  const args = { hqRoot: options?.hqRoot ?? env.HQ_ROOT, repo, prNumber, headSha: matchHeadCommit,
    producerClass: options?.producerClass || 'ama-daemon', action: 'gh pr merge', executedAt: new Date().toISOString() };
  let result;
  try {
    result = await writeGitHubAdapter('pull-request-merge', {
      repo, prNumber, matchHeadCommit, mergeMethod, deleteBranch, admin,
    }, options);
  } catch (error) {
    if (options?.recordReceipt !== false && !adapterUnsupportedError(error) && !isTransientGhError(error)) {
      // A failed subprocess is not a refusal. Require a permanent structured
      // adapter decision; timeouts and already-merged replies prove no refusal.
      for (const output of [error.stdout, error.stderr]) {
        let payload;
        try { payload = JSON.parse(String(output)); } catch { continue; }
        if (payload?.failureClass === 'permanent' && adapterMergeRefused(payload)) {
          recordMergeActionBestEffort({ ...args, executedAt: new Date().toISOString(), merged: false, reason: 'permanent-merge-rejection' }, logger);
          break;
        }
      }
    }
    throw error;
  }
  // Callers with fallback/retry paths own the final receipt for the operation.
  if (options?.recordReceipt === false) return result;
  if (result?.ran && (result.payload?.ok === true || result.payload?.merged === true || result.payload?.state === 'MERGED') && !result.payload?.idempotent
    && !result.payload?.data?.idempotent && !/already merged/i.test(JSON.stringify(result.payload))) {
    try {
      // Read GitHub directly: the adapter's cached read is not terminal authority.
      const live = await execGhWithRetry({
        execFileImpl: options?.execFileImpl,
        args: ['pr', 'view', String(prNumber), '--repo', repo, '--json', 'state,headRefOid,mergedAt'],
        env,
        timeoutMs: loadAwareTimeoutMs(15_000),
      });
      const pr = JSON.parse(live.stdout);
      if (pr.state === 'MERGED' && pr.headRefOid === matchHeadCommit && pr.mergedAt) {
        recordMergeActionBestEffort({ ...args, executedAt: new Date().toISOString(), merged: true }, logger);
      }
    } catch (error) { logger?.warn?.(`[merge-action] API post-merge verification unavailable: ${error.message}`); }
  }
  if (result?.ran && adapterMergeRefused(result.payload)) {
    recordMergeActionBestEffort({ ...args, executedAt: new Date().toISOString(), merged: false, reason: 'permanent-merge-rejection' }, logger);
  }
  return result;
}

const __test__ = {
  adapterUnsupportedError,
  buildAdapterEnv,
  candidateSuperprojectAdapterPaths,
  appendReviewerAuthAdapterArgs,
  appendMergeAgentServiceAuthAdapterArgs,
  isTrustedAutoDiscoveredAdapterBin,
  makeAdapterArgs,
  makeAdapterWriteArgs,
  parseAdapterJson,
  runGitHubAdapter,
  resolveGitHubAdapterBin,
  trustedAutoDiscoveryRoots,
};

export {
  buildAdapterEnv,
  adapterUnsupportedError,
  __test__,
  readAdapterHeadAndState,
  readAdapterIssueComments,
  readAdapterLatestLabelEvent,
  readAdapterOpenPullRequests,
  readAdapterPullRequestDiff,
  readAdapterPrRollup,
  readAdapterPullRequest,
  readAdapterReviewBodiesForHead,
  readAdapterReviewContext,
  resolveGitHubAdapterBin,
  writeAdapterCommitStatus,
  writeAdapterIssueComment,
  writeAdapterPullRequestLabel,
  writeAdapterPullRequestMerge,
  writeAdapterPullRequestReview,
};
