import { execFile } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { writeFileAtomic } from './atomic-write.mjs';
import { resolveGateStatusContext } from './adversarial-gate-context.mjs';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT_DIR = resolve(__dirname, '..');
const DEFAULT_BASE_BRANCH = 'main';
const DEFAULT_BRANCH_PROTECTION_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const BRANCH_PROTECTION_AUDIT_SCHEMA_VERSION = 1;
const BRANCH_PROTECTION_AUDIT_RELATIVE_DIR = join('data', 'branch-protection-audits');

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

function isTransientGhProtectionError(err) {
  const text = [
    err?.code,
    err?.signal,
    err?.stderr,
    err?.stdout,
    err?.message,
  ].map((value) => String(value || '')).join('\n');
  return /(?:TLS handshake|timed? out|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ECONNABORTED|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EIO|temporary failure|network is unreachable|socket hang up|rate limit|secondary rate limit|HTTP(?:\/[0-9.]+)?[ /]+50[0234]|bad gateway|service unavailable|gateway timeout|server error)/i.test(text);
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function execGhApiWithTransientRetry(command, args, options, {
  maxAttempts = 3,
  retryDelayMs = 250,
  sleepImpl = sleep,
} = {}) {
  const attempts = Math.max(1, Number(maxAttempts) || 1);
  let delayMs = Math.max(0, Number(retryDelayMs) || 0);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await command('gh', args, options);
    } catch (err) {
      if (attempt >= attempts || !isTransientGhProtectionError(err)) {
        throw err;
      }
      if (delayMs > 0) {
        await sleepImpl(delayMs);
        delayMs *= 2;
      }
    }
  }
  throw new Error('unreachable branch-protection gh retry state');
}

function sanitizePathFragment(value) {
  return String(value || '').replaceAll('/', '__').replace(/[^A-Za-z0-9._-]/g, '_');
}

function branchProtectionAuditDirPath(rootDir) {
  return join(rootDir || DEFAULT_ROOT_DIR, BRANCH_PROTECTION_AUDIT_RELATIVE_DIR);
}

function branchProtectionAuditFilePath(rootDir, repoPath, baseBranch) {
  return join(
    branchProtectionAuditDirPath(rootDir),
    `${sanitizePathFragment(repoPath)}--${sanitizePathFragment(baseBranch || DEFAULT_BASE_BRANCH)}.json`,
  );
}

function classifyBranchProtectionAction(result) {
  if (result?.applied === true && result?.ok === true) return 'applied-required-context';
  if (result?.ok === true) return 'none';
  if (result?.reason === 'required-context-missing') return 'apply-required-context';
  if (result?.reason === 'branch-protection-missing') return 'bootstrap-branch-protection';
  if (result?.reason === 'branch-protection-forbidden') return 'manual-admin-required';
  return 'manual-investigation-required';
}

function buildAddContextCommand(repoPath, baseBranch, context) {
  return [
    `base=${JSON.stringify(String(baseBranch || DEFAULT_BASE_BRANCH))}`,
    'base_enc=$(printf \'%s\' "$base" | jq -sRr @uri)',
    `gh api -X POST "repos/${repoPath}/branches/$base_enc/protection/required_status_checks/contexts" -f ${JSON.stringify(`contexts[]=${context}`)}`,
  ].join('\n');
}

function buildBootstrapProtectionCommand(repoPath, baseBranch, context) {
  return [
    `base=${JSON.stringify(String(baseBranch || DEFAULT_BASE_BRANCH))}`,
    'base_enc=$(printf \'%s\' "$base" | jq -sRr @uri)',
    'gh api -X PUT "repos/' + repoPath + '/branches/$base_enc/protection" --input - <<\'JSON\'',
    JSON.stringify({
      required_status_checks: {
        strict: true,
        contexts: [context],
      },
      enforce_admins: false,
      required_pull_request_reviews: null,
      restrictions: null,
    }),
    'JSON',
  ].join('\n');
}

function buildManualCommand(result) {
  if (!result?.repo || !result?.context) return null;
  if (result.reason === 'required-context-missing') {
    return buildAddContextCommand(result.repo, result.baseBranch, result.context);
  }
  if (result.reason === 'branch-protection-missing') {
    return buildBootstrapProtectionCommand(result.repo, result.baseBranch, result.context);
  }
  if (result.reason === 'branch-protection-forbidden') {
    return buildAddContextCommand(result.repo, result.baseBranch, result.context);
  }
  return null;
}

function summarizeBranchProtectionResults(results) {
  const summary = {
    total: 0,
    ok: 0,
    applied: 0,
    requiredContextMissing: 0,
    protectionMissing: 0,
    forbidden: 0,
    failed: 0,
  };
  for (const result of results || []) {
    summary.total += 1;
    if (result?.ok === true) {
      summary.ok += 1;
      if (result?.applied === true) summary.applied += 1;
      continue;
    }
    if (result?.reason === 'required-context-missing') summary.requiredContextMissing += 1;
    else if (result?.reason === 'branch-protection-missing') summary.protectionMissing += 1;
    else if (result?.reason === 'branch-protection-forbidden') summary.forbidden += 1;
    else summary.failed += 1;
  }
  return summary;
}

function writeBranchProtectionAuditRecord(
  rootDir,
  result,
  {
    directoryPath = null,
    now = new Date().toISOString(),
    writeFileImpl = writeFileAtomic,
  } = {},
) {
  const record = {
    schemaVersion: BRANCH_PROTECTION_AUDIT_SCHEMA_VERSION,
    recordedAt: now,
    repo: result.repo,
    baseBranch: result.baseBranch,
    context: result.context,
    ok: result.ok === true,
    reason: result.reason,
    requiredContexts: Array.isArray(result.requiredContexts) ? result.requiredContexts : [],
    action: classifyBranchProtectionAction(result),
    applied: result.applied === true,
    manualCommand: buildManualCommand(result),
  };
  if (result?.error) record.error = String(result.error);
  if (result?.applyError) record.applyError = String(result.applyError);
  const filePath = directoryPath
    ? join(directoryPath, `${sanitizePathFragment(result.repo)}--${sanitizePathFragment(result.baseBranch || DEFAULT_BASE_BRANCH)}.json`)
    : branchProtectionAuditFilePath(rootDir, result.repo, result.baseBranch);
  writeFileImpl(filePath, `${JSON.stringify(record, null, 2)}\n`);
  return { filePath, record };
}

async function addRequiredStatusCheckContext({
  repoPath,
  baseBranch = DEFAULT_BASE_BRANCH,
  context,
  execFileImpl = execFileAsync,
  env = process.env,
  retryOptions = {},
} = {}) {
  const { owner, repo } = parseRepoSlug(repoPath);
  const branch = String(baseBranch || DEFAULT_BASE_BRANCH);
  const desiredContext = String(context || '').trim();
  const args = [
    'api',
    '-X',
    'POST',
    `repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}/protection/required_status_checks/contexts`,
    '-f',
    `contexts[]=${desiredContext}`,
  ];
  const { stdout } = await execGhApiWithTransientRetry(
    execFileImpl,
    args,
    {
      env: allowlistedGhEnv(env),
      maxBuffer: 2 * 1024 * 1024,
    },
    retryOptions,
  );
  const parsed = JSON.parse(String(stdout || '[]'));
  return Array.isArray(parsed)
    ? [...new Set(parsed.map((item) => String(item)).filter(Boolean))].sort()
    : [desiredContext];
}

async function ensureAdversarialGateRequiredContext({
  result,
  execFileImpl = execFileAsync,
  env = process.env,
} = {}) {
  if (!result || result.ok === true || result.reason !== 'required-context-missing') {
    return result;
  }
  try {
    const requiredContexts = await addRequiredStatusCheckContext({
      repoPath: result.repo,
      baseBranch: result.baseBranch,
      context: result.context,
      execFileImpl,
      env,
    });
    return {
      ...result,
      ok: requiredContexts.includes(result.context),
      reason: requiredContexts.includes(result.context)
        ? 'required-context-present'
        : 'required-context-missing',
      requiredContexts,
      applied: requiredContexts.includes(result.context),
    };
  } catch (err) {
    return {
      ...result,
      ok: false,
      applied: false,
      reason: classifyGhProtectionError(err),
      applyError: String(err?.stderr || err?.message || err),
    };
  }
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
    let context;
    try {
      context = resolveGateStatusContext(options.env ?? defaults.env);
    } catch {
      context = 'invalid-status-context-config';
    }
    const key = `${repoPath}#${baseBranch}#${context}`;
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
  BRANCH_PROTECTION_AUDIT_RELATIVE_DIR,
  BRANCH_PROTECTION_AUDIT_SCHEMA_VERSION,
  DEFAULT_BASE_BRANCH,
  DEFAULT_BRANCH_PROTECTION_CACHE_TTL_MS,
  addRequiredStatusCheckContext,
  branchProtectionAuditDirPath,
  branchProtectionAuditFilePath,
  buildManualCommand,
  createBranchProtectionChecker,
  ensureAdversarialGateRequiredContext,
  fetchAdversarialGateBranchProtection,
  formatBranchProtectionWarning,
  normalizeRequiredContexts,
  resolveBaseBranchForRepo,
  summarizeBranchProtectionResults,
  warnForMissingAdversarialGateBranchProtection,
  writeBranchProtectionAuditRecord,
};
