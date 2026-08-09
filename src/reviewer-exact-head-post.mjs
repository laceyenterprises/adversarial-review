// Bind a review write to the exact commit the reviewer inspected.  GitHub's
// normal `gh pr review` command otherwise submits against the current head.

function parseExactHeadReviewArtifact(stdout, { repo, prNumber, reviewerHeadSha } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(String(stdout || '').trim());
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
      '--raw-field', `body=${reviewBody}`,
      '--raw-field', 'event=COMMENT',
      '--raw-field', `commit_id=${reviewerHeadSha}`,
    ],
    { env, maxBuffer: 5 * 1024 * 1024 }
  );
  return {
    reviewArtifact: parseExactHeadReviewArtifact(response?.stdout, {
      repo, prNumber, reviewerHeadSha,
    }),
  };
}

export { postExactHeadReview };
