import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { execGhWithRetry, isTransientGhError } from './gh-cli.mjs';
import { parseCommitTrailers } from './ama/ham-provenance.mjs';

const execFileAsync = promisify(execFile);

const HEAD_CLOSER_SUPPRESSION_RETRY_BACKOFF_MS = [250, 1000];

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

export async function getHeadCloserCommitSuppression({
  repoPath,
  prNumber,
  headSha,
  execFileImpl = execFileAsync,
  execGhWithRetryImpl = execGhWithRetry,
  logger = console,
  retryBackoffMs = [250, 1000],
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const sha = String(headSha || '').trim();
  if (!repoPath || !sha) return { suppressed: false, reason: null };
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
