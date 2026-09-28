// A completed comment-only remediation may hand a descendant head to AMA.
// The job's reviewed head must still be the settled verdict head; an unrelated
// review or an unproven ancestry transition cannot grant closer authority.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execGhWithRetry } from './gh-cli.mjs';
import { normalizeEffectiveReviewVerdict } from './kernel/verdict.mjs';

const SHA = /^[0-9a-f]{40}$/iu;

export function hasSettledCommentOnlyReviewHead(rootDir, { repo, prNumber, headSha }) {
  const prefix = `${String(repo || '').replace(/\//gu, '__').replace(/[^a-zA-Z0-9_.-]/gu, '-')}-pr-${Number(prNumber)}-`;
  for (const status of ['pending', 'in-progress', 'completed', 'failed', 'stopped']) {
    const dir = join(rootDir, 'data', 'follow-up-jobs', status);
    let names;
    try {
      names = readdirSync(dir).filter((name) => name.startsWith(prefix) && name.endsWith('.json'));
    } catch (err) {
      if (err?.code === 'ENOENT') continue;
      throw err;
    }
    for (const name of names) {
      let contents;
      try {
        contents = readFileSync(join(dir, name), 'utf8');
      } catch (err) {
        if (err?.code === 'ENOENT') continue;
        throw err;
      }
      const job = JSON.parse(contents);
      if (job?.repo === repo && Number(job?.prNumber) === Number(prNumber) &&
          job?.revisionRef === headSha &&
          normalizeEffectiveReviewVerdict(job.reviewBody) === 'comment-only') return true;
    }
  }
  return false;
}

export function hasCompletedCommentOnlyFinalRound(rootDir, { repo, prNumber }) {
  const dir = join(rootDir, 'data', 'follow-up-jobs', 'completed');
  const prefix = `${String(repo || '').replace(/\//gu, '__').replace(/[^a-zA-Z0-9_.-]/gu, '-')}-pr-${Number(prNumber)}-`;
  let names;
  try {
    names = readdirSync(dir).filter((name) => name.startsWith(prefix) && name.endsWith('.json'));
  } catch (err) {
    if (err?.code === 'ENOENT') return false;
    throw err;
  }
  for (const name of names) {
    let contents;
    try {
      contents = readFileSync(join(dir, name), 'utf8');
    } catch (err) {
      if (err?.code === 'ENOENT') continue;
      throw err;
    }
    const job = JSON.parse(contents);
    if (job?.repo === repo && Number(job?.prNumber) === Number(prNumber) &&
        job?.status === 'completed' && job?.finalRound === 'comment-only' &&
        job?.reReview?.suppressed === 'comment-only-final-round') return true;
  }
  return false;
}

export async function proveCommentOnlyFinalRoundHead({
  repo,
  reviewedHead,
  currentHead,
  completedRevisionRefs = [],
  execFileImpl,
  logger = console,
  sleep,
  refreshGhAuthImpl,
}) {
  if (!SHA.test(String(reviewedHead || '')) || !SHA.test(String(currentHead || '')) ||
      !completedRevisionRefs.includes(reviewedHead) || typeof execFileImpl !== 'function') {
    return false;
  }
  if (reviewedHead === currentHead) return true;
  const { stdout } = await execGhWithRetry({
    execFileImpl,
    args: ['api', `repos/${repo}/compare/${reviewedHead}...${currentHead}`, '--jq', '.status'],
    log: logger,
    ...(sleep ? { sleep } : {}),
    ...(refreshGhAuthImpl ? { refreshGhAuthImpl } : {}),
  });
  return String(stdout || '').trim() === 'ahead';
}
