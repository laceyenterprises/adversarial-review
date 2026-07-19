// Fast-merge GitHub I/O layer.
//
// Self-contained GitHub read/transport primitives for the fast-merge gate:
// the `gh` exec wrapper, transient-transport retry, JSON/pagination parsing,
// and the HAM (hammer) provenance reads (commit + issue timeline) plus their
// pure normalizers. These were extracted verbatim from
// `follow-up-merge-agent.mjs` (ARC-19 decomposition) so the merge-agent
// monolith no longer owns the low-level GitHub read machinery.
//
// The HAM *verification* chain, PR-view/checks fetchers, and the fast-merge
// orchestrator stay in the monolith: they depend on shared HQ-config helpers
// (`resolveHqRoot`/`resolveHqOwner`) and the pervasive `isoNow`, which are used
// broadly across the monolith and do not belong in this leaf. The monolith
// imports the transport + provenance-read functions back from here.
//
// `sleep`/`isExecTimeout`/`execFileAsync` are trivial retry/timeout primitives
// kept module-private, mirroring the same pattern already used by
// `reviewer.mjs` and `ama/labels.mjs` (each of which owns its own `withGhRetry`
// and `sleep`).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { hamAuditCommentAuthorMatches, parseCommitTrailers } from './ama/ham-provenance.mjs';

const execFileAsync = promisify(execFile);

const FAST_MERGE_GH_RETRY_DELAYS_MS = [250, 1_000];
const FAST_MERGE_GH_TIMEOUT_MS = 30_000;

function sleep(ms) {
  if (!ms) return Promise.resolve();
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isExecTimeout(err) {
  return err?.code === 'ETIMEDOUT'
    || err?.killed === true
    || String(err?.message || '').toLowerCase().includes('timed out');
}

function execFileFromGhClient(ghClient) {
  if (typeof ghClient === 'function') return ghClient;
  if (typeof ghClient?.execFile === 'function') return ghClient.execFile.bind(ghClient);
  if (typeof ghClient?.execFileImpl === 'function') return ghClient.execFileImpl.bind(ghClient);
  return execFileAsync;
}

function isRetryableGhTransportError(err) {
  if (isExecTimeout(err)) return true;
  const detail = [
    err?.code,
    err?.message,
    err?.stderr,
    err?.stdout,
  ].filter(Boolean).join('\n').toLowerCase();
  return /\b(etimedout|econnreset|econnrefused|ehostunreach|eai_again|enotfound|epipe|eagain)\b/.test(detail)
    || detail.includes('timeout')
    || detail.includes('timed out')
    || detail.includes('temporary failure')
    || detail.includes('temporarily unavailable')
    || detail.includes('rate limit')
    || detail.includes('secondary rate limit')
    || detail.includes('502 bad gateway')
    || detail.includes('503 service unavailable')
    || detail.includes('504 gateway timeout');
}

async function withGhRetry(operation, {
  retryDelaysMs = FAST_MERGE_GH_RETRY_DELAYS_MS,
  isRetryable = isRetryableGhTransportError,
} = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      return await operation();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt >= retryDelaysMs.length) {
        throw err;
      }
      await sleep(retryDelaysMs[attempt]);
    }
  }
  throw lastErr;
}

function parseGhJson(stdout, fallback = {}) {
  return JSON.parse(String(stdout || '').trim() || JSON.stringify(fallback));
}

function normalizeVerifiedHamCommit(commitJson = {}) {
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
    trailers: parseCommitTrailers(message),
    author: commitJson?.author?.login || commitJson?.commit?.author?.login || null,
    committer: commitJson?.committer?.login || commitJson?.commit?.committer?.login || null,
    changedFiles,
  };
}

function timelineCommentBody(event) {
  if (!event || typeof event !== 'object') return '';
  if (typeof event.body === 'string') return event.body;
  if (typeof event.comment?.body === 'string') return event.comment.body;
  return '';
}

function timelineCommentAuthor(event) {
  return (
    event?.user?.login
    || event?.actor?.login
    || event?.comment?.user?.login
    || null
  );
}

function hasMatchingHamAuditComment(timelineJson, verifiedCommit) {
  const timeline = Array.isArray(timelineJson) ? timelineJson : [];
  const remediatedFindings = String(verifiedCommit?.trailers?.['remediated-findings'] || '').trim();
  return timeline.some((event) => {
    const body = timelineCommentBody(event);
    if (!body || !hamAuditCommentAuthorMatches(timelineCommentAuthor(event))) return false;
    return body.includes('Closed-By: hammer (adversarial-pipe-mode)')
      && (!remediatedFindings || body.includes(remediatedFindings));
  });
}

function flattenGhPaginatedJson(parsed) {
  if (!Array.isArray(parsed)) return [];
  if (parsed.every((item) => Array.isArray(item))) return parsed.flat();
  return parsed;
}

async function fetchFastMergeHamCommit({ ghClient, repo, headSha }) {
  const execFileImpl = execFileFromGhClient(ghClient);
  const { stdout } = await withGhRetry(() => execFileImpl('gh', [
    'api',
    `repos/${repo}/commits/${headSha}`,
  ], {
    maxBuffer: 5 * 1024 * 1024,
    timeout: FAST_MERGE_GH_TIMEOUT_MS,
  }));
  return normalizeVerifiedHamCommit(parseGhJson(stdout));
}

async function fetchFastMergeTimeline({ ghClient, repo, prNumber }) {
  const execFileImpl = execFileFromGhClient(ghClient);
  const { stdout } = await withGhRetry(() => execFileImpl('gh', [
    'api',
    `repos/${repo}/issues/${prNumber}/timeline`,
    '--paginate',
    '--slurp',
  ], {
    maxBuffer: 5 * 1024 * 1024,
    timeout: FAST_MERGE_GH_TIMEOUT_MS,
  }));
  return flattenGhPaginatedJson(parseGhJson(stdout, []));
}

export {
  FAST_MERGE_GH_TIMEOUT_MS,
  execFileFromGhClient,
  isRetryableGhTransportError,
  withGhRetry,
  parseGhJson,
  hasMatchingHamAuditComment,
  fetchFastMergeHamCommit,
  fetchFastMergeTimeline,
};
