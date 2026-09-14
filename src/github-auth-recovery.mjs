import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const GITHUB_AUTH_PUSH_RETRY_DELAYS_MS = [250, 750];

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function githubAuthRecoveryErrorDetail(err) {
  return [err?.stderr, err?.stdout, err?.message]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join('\n');
}

function isTransientGitPushError(err) {
  const detail = githubAuthRecoveryErrorDetail(err);
  return /(?:unable to access|could not resolve host|failed to connect|connection (?:reset|timed out|closed)|connection refused|network is unreachable|operation timed out|timed out|timeout|TLS|SSL|HTTP 5\d\d|The requested URL returned error: 5\d\d|remote end hung up unexpectedly|early EOF|RPC failed|temporary failure|temporarily unavailable|service unavailable|bad gateway|gateway timeout)/i.test(detail);
}

function normalizeOperationalBlockerCategory(blocker) {
  const raw = blocker && typeof blocker === 'object' && !Array.isArray(blocker)
    ? (blocker.category || blocker.title || blocker.code || blocker.finding)
    : blocker;
  const normalized = String(raw || '')
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/[_\s]+/g, '-')
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!normalized) return 'unknown';
  if (normalized.includes('github-auth') || normalized === 'auth-failure' || normalized === 'missing-auth') {
    return 'github-auth';
  }
  return normalized;
}

function operationalBlockerText(blocker) {
  if (!blocker || typeof blocker !== 'object' || Array.isArray(blocker)) return String(blocker || '');
  return [
    blocker.title,
    blocker.category,
    blocker.code,
    blocker.finding,
    blocker.reasoning,
    blocker.needsHumanInput,
    blocker.detail,
    blocker.message,
  ].map((value) => String(value || '')).join('\n');
}

function classifyGithubAuthOperationalBlocker(blocker) {
  const text = operationalBlockerText(blocker).toLocaleLowerCase('en-US');
  if (normalizeOperationalBlockerCategory(blocker) !== 'github-auth') return null;
  if (
    /revoked entitlement|entitlement revoked|missing app installation|installation (?:not found|missing)|resource not accessible by integration|permission denied|403|forbidden|workflow scope|workflows permission|contents permission/.test(text)
  ) {
    return { kind: 'terminal', reason: 'terminal-github-auth' };
  }
  if (
    /expired|invalid|bad credentials|no usable|missing non-interactive|could not fetch|could not push|authentication failed|credential|token|oauth/.test(text)
  ) {
    return { kind: 'recoverable', reason: 'recoverable-github-auth' };
  }
  return { kind: 'terminal', reason: 'unclassified-github-auth' };
}

function findGithubAuthOperationalBlocker(reply) {
  const blockers = Array.isArray(reply?.operationalBlockers) ? reply.operationalBlockers : [];
  for (const blocker of blockers) {
    const classification = classifyGithubAuthOperationalBlocker(blocker);
    if (classification) return { blocker, classification };
  }
  return null;
}

function extractCommitShaFromOperationalBlocker(blocker) {
  const candidates = [
    blocker?.commitSha,
    blocker?.commit,
    blocker?.headSha,
    blocker?.unpushedSha,
    blocker?.validatedCommit,
  ];
  for (const candidate of candidates) {
    const value = String(candidate || '').trim();
    if (/^[0-9a-f]{7,40}$/i.test(value)) return value;
  }
  const match = operationalBlockerText(blocker).match(/\b[0-9a-f]{7,40}\b/i);
  return match ? match[0] : null;
}

async function preserveUnpushedCommit({
  hqRoot,
  workspaceDir,
  repo,
  prNumber,
  jobId,
  commitSha,
  observedAt,
  execFileImpl = execFileAsync,
}) {
  const sha = String(commitSha || '').trim();
  if (!sha) return { preserved: false, reason: 'missing-commit-sha' };
  await execFileImpl('git', ['-C', workspaceDir, 'cat-file', '-e', `${sha}^{commit}`]);
  const safeRepo = String(repo || 'unknown').replace(/[^A-Za-z0-9_.-]+/g, '_');
  const safeJob = String(jobId || `pr-${prNumber}`).replace(/[^A-Za-z0-9_.-]+/g, '_');
  const stamp = String(observedAt || new Date().toISOString()).replace(/[^0-9A-Za-z]+/g, '-');
  const rescueDir = join(hqRoot, 'rescues', 'adversarial-review', 'github-auth', safeRepo, `pr-${prNumber}`);
  mkdirSync(rescueDir, { recursive: true });
  const bundlePath = join(rescueDir, `${stamp}-${safeJob}-${sha.slice(0, 12)}.bundle`);
  const rescueRef = `refs/adversarial-review/rescues/${safeJob}/${sha}`;
  try {
    await execFileImpl('git', ['-C', workspaceDir, 'update-ref', rescueRef, sha]);
    await execFileImpl('git', ['-C', workspaceDir, 'bundle', 'create', bundlePath, rescueRef], {
      maxBuffer: 5 * 1024 * 1024,
    });
    await execFileImpl('git', ['-C', workspaceDir, 'bundle', 'verify', bundlePath], {
      maxBuffer: 5 * 1024 * 1024,
    });
  } finally {
    try {
      await execFileImpl('git', ['-C', workspaceDir, 'update-ref', '-d', rescueRef]);
    } catch {
      // Best-effort cleanup; the durable artifact is the verified bundle.
    }
  }
  return {
    preserved: true,
    kind: 'git-bundle',
    path: bundlePath,
    ref: rescueRef,
    commitSha: sha,
    repo,
    prNumber,
    createdAt: observedAt,
  };
}

async function retryGithubAuthPushOnce({
  workspaceDir,
  workerClass,
  branch,
  commitSha,
  env = process.env,
  execFileImpl = execFileAsync,
  retryDelaysMs = GITHUB_AUTH_PUSH_RETRY_DELAYS_MS,
  sleepImpl = sleep,
}) {
  const targetBranch = String(branch || '').trim();
  if (!targetBranch) {
    return { retried: false, pushed: false, reason: 'missing-pr-branch' };
  }
  const script = `
set -euo pipefail
source "${ROOT}/../../modules/worker-pool/lib/hq-gh.sh"
unset GH_TOKEN GITHUB_TOKEN HQ_ENTITLEMENT_GH_TOKEN
hq_resolve_worker_class_gh_token "$WORKER_CLASS"
token="$HQ_ENTITLEMENT_GH_TOKEN"
if [[ -z "$token" && -n "\${HQ_ENTITLEMENT_GH_TOKEN_VAR:-}" ]]; then
  token="\${!HQ_ENTITLEMENT_GH_TOKEN_VAR:-}"
fi
[[ -n "$token" ]]
export GH_TOKEN="$token" GITHUB_TOKEN="$token" GIT_TERMINAL_PROMPT=0
git -C "$WORKSPACE_DIR" push origin "$COMMIT_SHA:refs/heads/$TARGET_BRANCH" --force-with-lease
`;
  const options = {
    env: {
      ...env,
      WORKER_CLASS: workerClass || 'codex',
      WORKSPACE_DIR: workspaceDir,
      COMMIT_SHA: commitSha,
      TARGET_BRANCH: targetBranch,
    },
    maxBuffer: 5 * 1024 * 1024,
  };
  const attempts = [0, ...retryDelaysMs];
  let lastError = null;
  let lastTransient = false;
  let attemptsMade = 0;
  for (let attempt = 0; attempt < attempts.length; attempt += 1) {
    if (attempts[attempt] > 0) await sleepImpl(attempts[attempt]);
    attemptsMade = attempt + 1;
    try {
      await execFileImpl('bash', ['-lc', script], options);
      return { retried: true, pushed: true, reason: 'push-succeeded', attempts: attemptsMade };
    } catch (err) {
      lastError = err;
      lastTransient = isTransientGitPushError(err);
      if (!lastTransient || attempt === attempts.length - 1) break;
    }
  }
  const detail = githubAuthRecoveryErrorDetail(lastError).slice(0, 1200);
  return {
    retried: true,
    pushed: false,
    reason: 'push-failed-after-remint',
    error: detail,
    attempts: attemptsMade,
    transient: lastTransient,
  };
}

async function recoverGithubAuthOperationalBlocker({
  reply,
  hqRoot,
  workspaceDir,
  job,
  worker,
  completedAt,
  rootDir,
  resolveWorkerClass,
  buildRereviewResult,
  requestReviewRereviewImpl,
  execFileImpl = execFileAsync,
  env = process.env,
}) {
  const authBlocker = findGithubAuthOperationalBlocker(reply);
  if (!authBlocker) return { operationalBlockerRecovery: null, rereview: null, job: null };
  const commitSha = extractCommitShaFromOperationalBlocker(authBlocker.blocker);
  let rescue = null;
  try {
    rescue = await preserveUnpushedCommit({
      hqRoot,
      workspaceDir,
      repo: job.repo,
      prNumber: job.prNumber,
      jobId: job.jobId,
      commitSha,
      observedAt: completedAt,
      execFileImpl,
    });
  } catch (err) {
    rescue = {
      preserved: false,
      reason: 'preserve-failed',
      commitSha,
      error: String(err?.message || err).slice(0, 600),
    };
  }

  let retry = { retried: false, pushed: false, reason: authBlocker.classification.reason };
  let rereview = null;
  if (authBlocker.classification.kind === 'recoverable' && rescue?.preserved) {
    retry = await retryGithubAuthPushOnce({
      workspaceDir,
      workerClass: resolveWorkerClass(job, worker),
      branch: job.branch,
      commitSha: rescue.commitSha,
      env,
      execFileImpl,
    });
    if (retry.pushed) {
      const requestedAt = completedAt;
      const reason = 'Recovered a remediated commit after refreshing the worker GitHub credential.';
      const outcome = requestReviewRereviewImpl({
        rootDir,
        repo: job.repo,
        prNumber: job.prNumber,
        requestedAt,
        reason,
        targetRevisionRef: rescue.commitSha,
      });
      rereview = buildRereviewResult({
        requested: true,
        reason,
        outcome: {
          ...outcome,
          requestedAt,
        },
      });
    }
  }

  const operationalBlockerRecovery = {
    category: 'github-auth',
    classification: authBlocker.classification,
    rescue,
    retry,
    recordedAt: completedAt,
  };
  return {
    operationalBlockerRecovery,
    rereview,
    job: {
      ...job,
      operationalBlockerRecovery,
    },
  };
}

export {
  classifyGithubAuthOperationalBlocker,
  extractCommitShaFromOperationalBlocker,
  findGithubAuthOperationalBlocker,
  preserveUnpushedCommit,
  recoverGithubAuthOperationalBlocker,
  retryGithubAuthPushOnce,
};
