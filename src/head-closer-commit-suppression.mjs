import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { execGhWithRetry, isTransientGhError } from './gh-cli.mjs';
import { parseCommitTrailers } from './ama/ham-provenance.mjs';

const execFileAsync = promisify(execFile);

const HEAD_CLOSER_SUPPRESSION_RETRY_BACKOFF_MS = [250, 1000];
const LOCAL_GIT_TIMEOUT_MS = 20000;
const LOCAL_GIT_MAX_BUFFER = 1024 * 1024 * 16;

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Read the head commit from the LOCAL checkout instead of `gh api commits/<sha>`.
//
// The terminal-remediation closer commit carries its identity in the commit message
// (`Closed-By: hammer …` trailer) plus its parent + changed files — all of which live
// in local git. The remote `gh api commits` probe fails-closed in the watcher DAEMON
// context (no interactive gh auth), which silently starved the hammer stale-review-head
// resume for EVERY closer-advanced head (retain-loop-cap -> AWAIT_OPERATOR_ACTION,
// forcing operator hand-merges). Local git needs no gh auth, so it is robust in the
// daemon. Returns a commit shaped like the `gh api` payload (so
// `isTerminalCloserCommitIdentity` / `normalizeVerifiedCloserCommit` consume it
// unchanged), or `null` if the commit cannot be read locally (caller falls back to gh).
export async function fetchVerifiedCommitFromLocalGit({
  repoPath,
  prNumber,
  headSha,
  execFileImpl = execFileAsync,
  logger = console,
} = {}) {
  const sha = String(headSha || '').trim();
  if (!repoPath || !sha) return null;
  const runGit = async (args) => {
    const { stdout } = await execFileImpl('git', ['-C', repoPath, ...args], {
      timeout: LOCAL_GIT_TIMEOUT_MS,
      maxBuffer: LOCAL_GIT_MAX_BUFFER,
    });
    return String(stdout || '');
  };
  const readCommit = async () => {
    // Two calls avoid any in-body separator hazard: an identity line (%H + %P are
    // all hex, whitespace-separated) then the raw body (%B, may contain newlines).
    const identityLine = (await runGit(['show', '-s', '--format=%H %P', `${sha}^{commit}`]))
      .split('\n')[0]
      .trim();
    const identityParts = identityLine.split(/\s+/).filter(Boolean);
    const readSha = String(identityParts[0] || sha).trim();
    const parentSha = String(identityParts[1] || '').trim();
    const message = String(await runGit(['show', '-s', '--format=%B', `${sha}^{commit}`])).replace(/\n+$/, '');
    let files = [];
    try {
      const fileOut = await runGit(['diff-tree', '--no-commit-id', '--name-only', '-r', `${sha}^{commit}`]);
      files = fileOut.split('\n').map((line) => line.trim()).filter(Boolean);
    } catch {
      // changed-files is best-effort; identity comes from the trailer.
    }
    return {
      sha: readSha,
      message,
      commit: { message },
      committer: { login: null },
      author: { login: null },
      parents: parentSha ? [{ sha: parentSha }] : [],
      files: files.map((filename) => ({ filename })),
    };
  };
  try {
    return await readCommit();
  } catch (err) {
    // The commit may not be fetched into the checkout yet — fetch the PR head once, retry.
    if (prNumber) {
      try {
        await runGit(['fetch', '--quiet', 'origin', `pull/${prNumber}/head`]);
        return await readCommit();
      } catch (err2) {
        logger?.debug?.(
          `[watcher] local closer-commit read failed for ${repoPath}#${prNumber} ` +
            `head=${sha.slice(0, 12)} after PR-head fetch: ${err2?.message || err2}`
        );
        return null;
      }
    }
    logger?.debug?.(
      `[watcher] local closer-commit read failed for ${repoPath}#${prNumber} ` +
        `head=${sha.slice(0, 12)}: ${err?.message || err}`
    );
    return null;
  }
}

function normalizeIdentityPart(value) {
  return String(value || '').trim().toLowerCase();
}

const TERMINAL_CLOSER_BOT_IDENTITIES = new Set([
  'hammer',
  'merge-agent-lacey',
  'the-hammer-lacey[bot]',
]);

function normalizeTrailerIdentity(value) {
  return normalizeIdentityPart(value).replace(/\s+\(.*$/, '');
}

function normalizeCommitTrailers(trailers) {
  if (!trailers || typeof trailers !== 'object') return {};
  if (!Array.isArray(trailers)) return trailers;
  const normalized = {};
  for (const trailer of trailers) {
    if (!trailer || typeof trailer !== 'object') continue;
    const key = trailer.key ?? trailer.name ?? trailer.token ?? trailer.label;
    const value = trailer.value ?? trailer.text ?? trailer.rawValue;
    if (key !== undefined && value !== undefined) {
      normalized[String(key)] = value;
    }
  }
  return normalized;
}

export function isTerminalCloserCommitIdentity(commit = {}) {
  const message = commit?.commit?.message || commit?.message || '';
  const trailers = {
    ...parseCommitTrailers(message),
    ...normalizeCommitTrailers(commit?.trailers),
  };
  const normalizedTrailers = {};
  for (const [key, value] of Object.entries(trailers)) {
    normalizedTrailers[normalizeIdentityPart(key)] = String(value || '').trim();
  }
  const trailerKey = normalizedTrailers['closed-by'] ? 'closed-by' : 'closer';
  const trailerIdentity = normalizeTrailerIdentity(normalizedTrailers[trailerKey]);
  if (TERMINAL_CLOSER_BOT_IDENTITIES.has(trailerIdentity)) {
    return {
      suppressed: true,
      reason: 'closer-commit-trailer',
      matched: trailerKey === 'closed-by' ? 'Closed-By' : 'Closer',
    };
  }

  const candidates = [
    commit?.committer?.login,
  ].map(normalizeIdentityPart).filter(Boolean);
  const closerIdentity = candidates.find((candidate) => TERMINAL_CLOSER_BOT_IDENTITIES.has(candidate));
  if (closerIdentity) {
    return {
      suppressed: true,
      reason: 'closer-commit-identity',
      matched: closerIdentity,
    };
  }

  return { suppressed: false, reason: null };
}

export function normalizeVerifiedCloserCommit(commitJson = {}) {
  const sha = String(commitJson?.sha || commitJson?.oid || '').trim();
  const parentSha = String(
    commitJson?.parents?.[0]?.sha
      || commitJson?.parents?.nodes?.[0]?.oid
      || commitJson?.parentSha
      || '',
  ).trim();
  const message = commitJson?.commit?.message || commitJson?.message || '';
  const changedFiles = Array.isArray(commitJson?.files)
    ? commitJson.files
      .map((file) => String(file?.filename || file?.path || '').trim())
      .filter(Boolean)
    : [];
  return {
    sha,
    parentSha,
    message,
    trailers: parseCommitTrailers(message),
    author: commitJson?.author?.login || commitJson?.commit?.author?.login || null,
    committer: commitJson?.committer?.login || commitJson?.commit?.committer?.login || null,
    changedFiles,
  };
}

export async function fetchHeadCloserVerifiedCommit({
  repoPath,
  prNumber,
  headSha,
  execFileImpl = execFileAsync,
  execGhWithRetryImpl = execGhWithRetry,
  fetchVerifiedCommitFromLocalGitImpl = fetchVerifiedCommitFromLocalGit,
  logger = console,
  retryBackoffMs = [250, 1000],
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const sha = String(headSha || '').trim();
  if (!repoPath || !sha) return null;
  // Daemon-robust: read the closer commit from the local checkout first. The remote
  // `gh api commits` fetch fails-closed in the watcher daemon context (no interactive
  // gh auth), which silently starved the hammer stale-review-head resume for every
  // closer-advanced head; local git needs no gh auth.
  const localCommit = await fetchVerifiedCommitFromLocalGitImpl({
    repoPath,
    prNumber,
    headSha: sha,
    execFileImpl,
    logger,
  });
  if (localCommit) return normalizeVerifiedCloserCommit(localCommit);
  const retryDelays = Array.isArray(retryBackoffMs) ? retryBackoffMs : [];
  try {
    const { stdout } = await execGhWithRetryImpl({
      execFileImpl,
      args: [
        'api',
        `repos/${repoPath}/commits/${sha}`,
      ],
      retries: retryDelays.length,
      backoffMs: Number(retryDelays[0]) || 500,
      sleep: sleepImpl,
    });
    const parsed = JSON.parse(String(stdout || '{}'));
    return normalizeVerifiedCloserCommit(parsed);
  } catch (err) {
    logger?.warn?.(
      `[watcher] closer commit verification fetch failed for ${repoPath}#${prNumber} ` +
        `head=${sha.slice(0, 12)}; failing closed: ${err?.message || err}`
    );
    throw err;
  }
}

export async function getHeadCloserCommitSuppression({
  repoPath,
  prNumber,
  headSha,
  execFileImpl = execFileAsync,
  execGhWithRetryImpl = execGhWithRetry,
  fetchVerifiedCommitFromLocalGitImpl = fetchVerifiedCommitFromLocalGit,
  logger = console,
  retryBackoffMs = [250, 1000],
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const sha = String(headSha || '').trim();
  if (!repoPath || !sha) return { suppressed: false, reason: null };
  // Daemon-robust: the terminal-closer identity is carried in the commit message
  // (`Closed-By: hammer` trailer), which local git reads without gh auth. The remote
  // probe below is the fallback for the rare case the commit is absent from the local
  // checkout, and for a committer.login-only closer identity (not derivable locally).
  const localCommit = await fetchVerifiedCommitFromLocalGitImpl({
    repoPath,
    prNumber,
    headSha: sha,
    execFileImpl,
    logger,
  });
  if (localCommit) {
    const localIdentity = isTerminalCloserCommitIdentity(localCommit);
    if (localIdentity?.suppressed === true) return localIdentity;
  }
  const retryDelays = Array.isArray(retryBackoffMs) ? retryBackoffMs : [];
  try {
    const { stdout } = await execGhWithRetryImpl({
      execFileImpl,
      args: [
        'api',
        `repos/${repoPath}/commits/${sha}`,
        '--jq',
        '{sha:.sha,message:.commit.message,committerLogin:.committer.login}',
      ],
      retries: retryDelays.length,
      backoffMs: Number(retryDelays[0]) || 500,
      sleep: sleepImpl,
    });
    const raw = JSON.parse(String(stdout || '{}'));
    const commit = {
      sha: raw.sha || sha,
      message: raw.message || '',
      committer: { login: raw.committerLogin || null },
    };
    return isTerminalCloserCommitIdentity(commit);
  } catch (err) {
    logger?.warn?.(
      `[watcher] closer commit identity probe failed for ${repoPath}#${prNumber} ` +
        `head=${sha.slice(0, 12)}; failing closed: ${err?.message || err}`
    );
    throw err;
  }
}

export function createHeadCloserCommitSuppressionResolver(options = {}) {
  let suppressionPromise = null;
  return () => {
    if (!suppressionPromise) {
      suppressionPromise = getHeadCloserCommitSuppression(options);
    }
    return suppressionPromise;
  };
}

export async function getHeadCloserCommitSuppressionWithBoundedRetry({
  repoPath,
  prNumber,
  headSha,
  getHeadCloserCommitSuppressionImpl = getHeadCloserCommitSuppression,
  logger = console,
  retryBackoffMs = HEAD_CLOSER_SUPPRESSION_RETRY_BACKOFF_MS,
  sleepImpl = sleepMs,
} = {}) {
  const retryDelays = Array.isArray(retryBackoffMs) ? retryBackoffMs : [];
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await getHeadCloserCommitSuppressionImpl({
        repoPath,
        prNumber,
        headSha,
        logger,
      });
    } catch (err) {
      if (!isTransientGhError(err) || attempt >= retryDelays.length) throw err;
      const delayMs = Math.max(0, Number(retryDelays[attempt]) || 0);
      logger?.warn?.(
        `[watcher] closer commit suppression probe transient failure for ` +
        `${repoPath}#${prNumber}; retrying ${attempt + 1}/${retryDelays.length} ` +
        `after ${delayMs}ms: ${err?.message || err}`
      );
      if (delayMs > 0) await sleepImpl(delayMs);
    }
  }
}
