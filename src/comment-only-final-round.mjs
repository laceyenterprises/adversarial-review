// A completed comment-only remediation may hand a descendant head to AMA.
// The job's reviewed head must still be the settled verdict head; an unrelated
// review or an unproven ancestry transition cannot grant closer authority.
const SHA = /^[0-9a-f]{40}$/iu;

export async function proveCommentOnlyFinalRoundHead({
  repo,
  reviewedHead,
  currentHead,
  completedRevisionRefs = [],
  execFileImpl,
  logger = console,
}) {
  if (!SHA.test(String(reviewedHead || '')) || !SHA.test(String(currentHead || '')) ||
      !completedRevisionRefs.includes(reviewedHead) || typeof execFileImpl !== 'function') {
    return false;
  }
  if (reviewedHead === currentHead) return true;
  try {
    const { stdout } = await execFileImpl('gh', [
      'api', `repos/${repo}/compare/${reviewedHead}...${currentHead}`, '--jq', '.status',
    ], { timeout: 30_000 });
    return String(stdout || '').trim() === 'ahead';
  } catch (err) {
    logger.warn?.(`[watcher] comment-only final-round ancestry proof failed for ${repo}: ${err?.message || err}`);
    return false;
  }
}
