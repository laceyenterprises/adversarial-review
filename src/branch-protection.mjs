import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { resolveGateStatusContext } from './adversarial-gate-context.mjs';

const execFileAsync = promisify(execFile);
const DEFAULT_BASE_BRANCH = 'main';
const DEFAULT_BRANCH_PROTECTION_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

function parseRepoSlug(repoPath) {
  const [owner, repo] = String(repoPath ?? '').split('/');
  if (!owner || !repo) {
    throw new Error(`Invalid repo slug: ${repoPath}`);
  }
  return { owner, repo };
}

function allowlistedGhEnv(env = process.env) {
  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  if (!token) {
    throw new Error('GITHUB_TOKEN is required to check branch protection');
  }
  return {
    PATH: env.PATH ?? '/usr/bin:/bin',
    HOME: env.HOME ?? '',
    GH_TOKEN: token,
  };
}

function normalizeRequiredContexts(protection) {
  const checks = protection?.required_status_checks || {};
  const contexts = Array.isArray(checks.contexts) ? checks.contexts : [];
  const appChecks = Array.isArray(checks.checks)
    ? checks.checks.map((check) => check?.context).filter(Boolean)
    : [];
  return [...new Set([...contexts, ...appChecks].map((context) => String(context)))].sort();
}

function classifyGhProtectionError(err) {
  const stderr = String(err?.stderr || err?.message || '');
  if (/\b404\b|not found/i.test(stderr)) return 'branch-protection-missing';
  if (/\b403\b|forbidden|resource not accessible/i.test(stderr)) return 'branch-protection-forbidden';
  return 'branch-protection-check-failed';
}

async function fetchAdversarialGateBranchProtection({
  repoPath,
  baseBranch = DEFAULT_BASE_BRANCH,
  execFileImpl = execFileAsync,
  env = process.env,
} = {}) {
  const { owner, repo } = parseRepoSlug(repoPath);
  const branch = String(baseBranch || DEFAULT_BASE_BRANCH);
  let context;
  try {
    context = resolveGateStatusContext(env);
  } catch (err) {
    return {
      repo: repoPath,
      baseBranch: branch,
      context: 'invalid-status-context-config',
      ok: false,
      reason: 'invalid-status-context-config',
      requiredContexts: [],
      error: String(err?.message || err),
    };
  }
  let stdout;
  try {
    ({ stdout } = await execFileImpl(
      'gh',
      ['api', `repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}/protection`],
      {
        env: allowlistedGhEnv(env),
        maxBuffer: 2 * 1024 * 1024,
      }
    ));
  } catch (err) {
    return {
      repo: repoPath,
      baseBranch: branch,
      context,
      ok: false,
      reason: classifyGhProtectionError(err),
      requiredContexts: [],
    };
  }

  let protection;
  try {
    protection = JSON.parse(String(stdout || '{}'));
  } catch {
    return {
      repo: repoPath,
      baseBranch: branch,
      context,
      ok: false,
      reason: 'branch-protection-json-invalid',
      requiredContexts: [],
    };
  }

  const requiredContexts = normalizeRequiredContexts(protection);
  const ok = requiredContexts.includes(context);
  return {
    repo: repoPath,
    baseBranch: branch,
    context,
    ok,
    reason: ok ? 'required-context-present' : 'required-context-missing',
    requiredContexts,
  };
}

function createBranchProtectionChecker({
  ttlMs = DEFAULT_BRANCH_PROTECTION_CACHE_TTL_MS,
  nowMs = () => Date.now(),
  fetchImpl = fetchAdversarialGateBranchProtection,
  ...defaults
} = {}) {
  const cache = new Map();
  return async function checkAdversarialGateBranchProtection(options = {}) {
    const repoPath = options.repoPath;
    const baseBranch = options.baseBranch || defaults.baseBranch || DEFAULT_BASE_BRANCH;
    const key = `${repoPath}#${baseBranch}`;
    const now = nowMs();
    const cached = cache.get(key);
    if (cached && now - cached.checkedAtMs < ttlMs) {
      return { ...cached.result, cached: true };
    }
    const result = await fetchImpl({
      ...defaults,
      ...options,
      baseBranch,
    });
    cache.set(key, { checkedAtMs: now, result });
    return { ...result, cached: false };
  };
}

function formatBranchProtectionWarning(result) {
  const contexts = result.requiredContexts?.length
    ? result.requiredContexts.join(',')
    : 'none';
  return (
    `[watcher] branch-protection-warning repo=${result.repo} base=${result.baseBranch} ` +
    `context=${result.context} present=false reason=${result.reason} required_contexts=${contexts}`
  );
}

function resolveBaseBranchForRepo(repoPath, {
  baseBranches = {},
  defaultBaseBranch = DEFAULT_BASE_BRANCH,
} = {}) {
  const repoName = String(repoPath || '').split('/')[1];
  return baseBranches[repoPath] || baseBranches[repoName] || defaultBaseBranch;
}

async function warnForMissingAdversarialGateBranchProtection(repoPaths, {
  checker = createBranchProtectionChecker(),
  logger = console,
  baseBranches = {},
  defaultBaseBranch = DEFAULT_BASE_BRANCH,
} = {}) {
  const results = [];
  for (const repoPath of repoPaths) {
    const result = await checker({
      repoPath,
      baseBranch: resolveBaseBranchForRepo(repoPath, {
        baseBranches,
        defaultBaseBranch,
      }),
    });
    results.push(result);
    if (!result.ok) {
      logger.warn(formatBranchProtectionWarning(result));
    }
  }
  return results;
}

export {
  DEFAULT_BASE_BRANCH,
  DEFAULT_BRANCH_PROTECTION_CACHE_TTL_MS,
  createBranchProtectionChecker,
  fetchAdversarialGateBranchProtection,
  formatBranchProtectionWarning,
  normalizeRequiredContexts,
  resolveBaseBranchForRepo,
  warnForMissingAdversarialGateBranchProtection,
};
