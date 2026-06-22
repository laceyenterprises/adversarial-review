import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ADAPTER_MAX_BUFFER = 25 * 1024 * 1024;
const ADAPTER_TIMEOUT_MS = 30_000;

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return null;
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
    throw new Error(`GitHub adapter returned empty ${kind} payload`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    const wrapped = new Error(`GitHub adapter returned malformed ${kind} JSON: ${err?.message || err}`);
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
    'GH_TOKEN',
    'GITHUB_TOKEN',
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

function makeAdapterArgs(kind, params = {}) {
  const args = ['read', '--kind', kind, '--json'];
  appendCommonAdapterArgs(args, params);
  return args;
}

function makeAdapterWriteArgs(kind, params = {}) {
  const args = ['write', '--kind', kind, '--json'];
  appendCommonAdapterArgs(args, params);
  if (params.body !== undefined) args.push('--body', String(params.body));
  if (params.state !== undefined) args.push('--state', String(params.state));
  if (params.context !== undefined) args.push('--context', String(params.context));
  if (params.description !== undefined) args.push('--description', String(params.description));
  if (params.action !== undefined) args.push('--action', String(params.action));
  if (params.reviewerLogin !== undefined) args.push('--reviewer-login', String(params.reviewerLogin));
  if (params.matchHeadCommit !== undefined) args.push('--match-head-commit', String(params.matchHeadCommit));
  if (params.mergeMethod !== undefined) args.push('--merge-method', String(params.mergeMethod));
  if (params.deleteBranch !== undefined) args.push(params.deleteBranch ? '--delete-branch' : '--no-delete-branch');
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
  const { stdout } = await execFileImpl(adapterBin, makeAdapterArgs(kind, params), {
    maxBuffer: ADAPTER_MAX_BUFFER,
    timeout: ADAPTER_TIMEOUT_MS,
    env: buildAdapterEnv(env),
  });
  return parseAdapterJson(stdout, kind);
}

function adapterUnsupportedError(err) {
  const detail = [
    err?.message,
    err?.stderr,
    err?.stdout,
  ].filter(Boolean).join('\n').toLowerCase();
  return /\bunsupported\b|\bunknown\b|\bunrecognized\b|\binvalid choice\b/.test(detail)
    && /\bwrite\b|\bkind\b|\boperation\b|\bcommand\b/.test(detail);
}

async function writeGitHubAdapter(kind, params = {}, {
  execFileImpl,
  env = process.env,
  rootDir,
} = {}) {
  if (typeof execFileImpl !== 'function') {
    throw new TypeError('writeGitHubAdapter requires execFileImpl');
  }
  const adapterBin = resolveGitHubAdapterBin({ env, rootDir });
  if (!adapterBin) return null;
  const { stdout } = await execFileImpl(adapterBin, makeAdapterWriteArgs(kind, params), {
    maxBuffer: ADAPTER_MAX_BUFFER,
    timeout: ADAPTER_TIMEOUT_MS,
    env: buildAdapterEnv(env),
  });
  return parseAdapterJson(stdout, kind);
}

function asPayloadObject(payload, kind) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`GitHub adapter ${kind} payload must be an object`);
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
  return unwrapPayload(payload, 'rollup', 'pull-request-rollup');
}

async function readAdapterReviewContext(repo, prNumber, options) {
  const payload = await runGitHubAdapter('pull-request-review-context', { repo, prNumber }, options);
  if (!payload) return null;
  return unwrapPayload(payload, 'rollup', 'pull-request-review-context');
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
  const bodies = unwrapPayload(payload, 'bodies', 'pull-request-review-bodies-for-head');
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
        commitId: body.commitId ?? body.commit_id ?? null,
      };
    }
    return String(body || '');
  });
}

async function readAdapterLatestLabelEvent(repo, prNumber, labelName, { currentHeadSha = null, ...options } = {}) {
  const payload = await runGitHubAdapter('latest-label-event', { repo, prNumber, labelName, currentHeadSha }, options);
  if (!payload) return null;
  return unwrapPayload(payload, 'event', 'latest-label-event');
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
  return unwrapPayload(payload, 'pullRequest', 'pull-request');
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

async function writeAdapterPullRequestReview(repo, prNumber, { body, reviewerLogin = null } = {}, options) {
  return writeGitHubAdapter('pull-request-review', { repo, prNumber, body, reviewerLogin }, options);
}

async function writeAdapterIssueComment(repo, prNumber, { body } = {}, options) {
  return writeGitHubAdapter('issue-comment', { repo, prNumber, body }, options);
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

async function writeAdapterPullRequestMerge(repo, prNumber, {
  matchHeadCommit,
  mergeMethod = 'squash',
  deleteBranch = true,
} = {}, options) {
  return writeGitHubAdapter('pull-request-merge', {
    repo,
    prNumber,
    matchHeadCommit,
    mergeMethod,
    deleteBranch,
  }, options);
}

const __test__ = {
  adapterUnsupportedError,
  buildAdapterEnv,
  candidateSuperprojectAdapterPaths,
  isTrustedAutoDiscoveredAdapterBin,
  makeAdapterArgs,
  makeAdapterWriteArgs,
  parseAdapterJson,
  resolveGitHubAdapterBin,
  trustedAutoDiscoveryRoots,
};

export {
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
