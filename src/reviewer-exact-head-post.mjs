// Bind a review write to the exact commit the reviewer inspected.  GitHub's
// normal `gh pr review` command otherwise submits against the current head.

import { normalizeEffectiveReviewVerdict } from './review-verdict.mjs';

function exactHeadReviewEventForBody(reviewBody) {
  const verdict = normalizeEffectiveReviewVerdict(reviewBody);
  if (verdict === 'request-changes') return 'REQUEST_CHANGES';
  if (verdict === 'approved') return 'APPROVE';
  return 'COMMENT';
}

function parseExactHeadReviewArtifact(stdout, { repo, prNumber, reviewerHeadSha } = {}) {
  const text = String(stdout || '').trim();
  const jsonStart = text.indexOf('{');
  const payload = jsonStart >= 0 ? text.slice(jsonStart).trim() : text;
  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch (err) {
    throw new Error(
      `GitHub returned an invalid exact-head review response for ${repo}#${prNumber}: ${err?.message || err}`
    );
  }
  const reviewId = parsed?.id;
  const commitId = String(parsed?.commit_id || '').trim();
  if (!reviewId || commitId !== reviewerHeadSha) {
    throw new Error(
      `GitHub did not confirm review ${repo}#${prNumber} on reviewed head ${reviewerHeadSha}`
    );
  }
  return { id: String(reviewId), commitId };
}

function parseExactHeadReviewArtifactOrNull(stdout, { repo, prNumber, reviewerHeadSha, log = console } = {}) {
  try {
    return parseExactHeadReviewArtifact(stdout, { repo, prNumber, reviewerHeadSha });
  } catch (err) {
    log.warn?.(
      `[reviewer] exact-head review post for ${repo}#${prNumber} returned an unverified artifact; falling back to GitHub lookup: ${err?.message || err}`
    );
    return null;
  }
}

async function postExactHeadReview({
  execFileImpl,
  repo,
  prNumber,
  reviewBody,
  reviewerHeadSha,
  env,
} = {}) {
  const response = await execFileImpl(
    'gh',
    [
      'api', '--method', 'POST', `repos/${repo}/pulls/${prNumber}/reviews`,
      '--input', '-',
    ],
    {
      env,
      input: JSON.stringify({
        body: reviewBody,
        event: exactHeadReviewEventForBody(reviewBody),
        commit_id: reviewerHeadSha,
      }),
      maxBuffer: 5 * 1024 * 1024,
    }
  );
  return { stdout: response?.stdout };
}

export { exactHeadReviewEventForBody, parseExactHeadReviewArtifact, parseExactHeadReviewArtifactOrNull, postExactHeadReview };
