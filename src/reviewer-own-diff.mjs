// REVIEWCHUNK-01: review the PR's own diff.
//
// `gh pr diff` is computed from the base SHA GitHub stored for the PR. After a
// PR merges its base branch back in, that stored base can go stale and the PR
// diff then carries every base-branch change the merge pulled in (agent-os
// PR 7981: 68 files in the PR diff, 33 in the real change). The reviewer then
// spends its budget, and its blocking findings, on code the PR never wrote.
//
// The PR's own change is merge-base(head, CURRENT base-branch tip)...head,
// which is exactly what GitHub's three-dot compare returns. This module fetches
// that diff and swaps it in only when its file set disagrees with the PR diff's
// and is a strict subset of it — the stale-base inflation shape. Anything else
// (no base ref, a fetch failure, an empty or unrelated compare) fails open to
// the PR diff, so this can narrow the review but never widen or block it.

import { execGhWithRetry } from './gh-cli.mjs';
import { parseDiffFiles } from './reviewer-util.mjs';

function diffFilePaths(diffText) {
  const paths = new Set();
  for (const file of parseDiffFiles(diffText)) {
    if (file.path) paths.add(file.path);
  }
  return paths;
}

async function fetchCompareOwnDiff(repo, baseRef, headSha, { execGhWithRetryImpl = execGhWithRetry } = {}) {
  const range = `${encodeURIComponent(baseRef)}...${encodeURIComponent(headSha)}`;
  const { stdout: diffStdout } = await execGhWithRetryImpl({
    args: ['api', '-H', 'Accept: application/vnd.github.diff', `repos/${repo}/compare/${range}`],
  });
  let mergeBaseSha = null;
  try {
    const { stdout } = await execGhWithRetryImpl({
      args: ['api', `repos/${repo}/compare/${range}`, '--jq', '.merge_base_commit.sha'],
    });
    mergeBaseSha = String(Buffer.isBuffer(stdout) ? stdout.toString('utf8') : stdout || '').trim() || null;
  } catch {
    // The merge-base SHA is audit metadata only; the diff above is authoritative.
  }
  return {
    diff: Buffer.isBuffer(diffStdout) ? diffStdout.toString('utf8') : String(diffStdout || ''),
    mergeBaseSha,
  };
}

async function resolvePrOwnReviewDiff({
  repo,
  prNumber,
  headSha,
  baseRef,
  prDiff,
  fetchCompareOwnDiffImpl = fetchCompareOwnDiff,
  log = console,
} = {}) {
  const prDiffText = String(prDiff || '');
  const unchanged = (reason, extra = {}) => ({ diff: prDiffText, scope: { source: 'pr-diff', reason, ...extra } });
  const normalizedBaseRef = String(baseRef || '').trim();
  const normalizedHead = String(headSha || '').trim();
  if (!repo || !normalizedBaseRef || !normalizedHead) return unchanged('missing-base-ref-or-head');

  let compare;
  try {
    compare = await fetchCompareOwnDiffImpl(repo, normalizedBaseRef, normalizedHead);
  } catch (err) {
    log?.warn?.(`[reviewer] WARN: own-diff compare failed for ${repo}#${prNumber}; reviewing the PR diff: ${err?.message || err}`);
    return unchanged('compare-failed');
  }

  const prPaths = diffFilePaths(prDiffText);
  const ownPaths = diffFilePaths(compare?.diff || '');
  const counts = { baseRef: normalizedBaseRef, mergeBaseSha: compare?.mergeBaseSha || null,
    prDiffFileCount: prPaths.size, ownDiffFileCount: ownPaths.size };
  if (ownPaths.size === 0) return unchanged('own-diff-empty', counts);
  const sameFiles = ownPaths.size === prPaths.size && [...ownPaths].every((path) => prPaths.has(path));
  if (sameFiles) return unchanged('file-sets-agree', counts);
  if (![...ownPaths].every((path) => prPaths.has(path))) {
    log?.warn?.(
      `[reviewer] WARN: own-diff for ${repo}#${prNumber} is not a subset of the PR diff ` +
        `(pr=${prPaths.size} own=${ownPaths.size}); reviewing the PR diff`
    );
    return unchanged('own-diff-not-subset', counts);
  }
  log?.warn?.(
    `[reviewer] review-diff-scope repo=${repo} pr=${prNumber} source=merge-base-compare ` +
      `base=${normalizedBaseRef} merge_base=${counts.mergeBaseSha || 'unknown'} ` +
      `pr_diff_files=${prPaths.size} own_diff_files=${ownPaths.size}`
  );
  return { diff: compare.diff, scope: { source: 'merge-base-compare', ...counts } };
}

export {
  diffFilePaths,
  fetchCompareOwnDiff,
  resolvePrOwnReviewDiff,
};
