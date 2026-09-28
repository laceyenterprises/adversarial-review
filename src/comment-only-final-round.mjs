// A completed comment-only remediation may hand a descendant head to AMA.
// The job's reviewed head must still be the settled verdict head; an unrelated
// review or an unproven ancestry transition cannot grant closer authority.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execGhWithRetry } from './gh-cli.mjs';
import { normalizeEffectiveReviewVerdict } from './kernel/verdict.mjs';

const SHA = /^[0-9a-f]{40}$/iu;

export function suppressFinalRoundFollowUp(pushedHeads, headSha, reviewPostedAt) {
  return pushedHeads?.some((entry) => entry.workerPushedHeadSha === headSha &&
    (!entry.completedAt || Date.parse(reviewPostedAt) <= Date.parse(entry.completedAt))) || false;
}

export async function captureFinalRoundWorkerPushedHead({
  rootDir, repo, prNumber, jobId, workspaceDir, execFileImpl, resolvePRLifecycleImpl, log = console,
}) {
  try {
    const [localHead, remoteHead] = await Promise.all([
      execFileImpl('git', ['-C', workspaceDir, 'rev-parse', 'HEAD']),
      resolvePRLifecycleImpl(rootDir, { repo, prNumber, execFileImpl }),
    ]);
    const localSha = String(localHead.stdout || '').trim();
    if (SHA.test(localSha) && remoteHead?.source === 'live' && localSha === remoteHead.headSha) {
      const commit = await execFileImpl('git', ['-C', workspaceDir, 'show', '-s', '--format=%B', 'HEAD']);
      if (String(commit.stdout || '').split(/\r?\n/u).some((line) => line === `Worker-Job-Id: ${jobId}`)) {
        return localSha;
      }
    }
    log.warn?.(`[follow-up-remediation] No worker-push proof for ${repo}#${prNumber}: head, live PR, or worker job trailer did not match`);
  } catch (err) {
    log.warn?.(`[follow-up-remediation] Worker-push proof failed for ${repo}#${prNumber}: ${err?.message || err}`);
  }
  return null;
}

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
      let job;
      try {
        job = JSON.parse(contents);
      } catch (err) {
        console.warn(`[comment-only-final-round] Skipping malformed job ${join(dir, name)}: ${err?.message || err}`);
        continue;
      }
      if (job?.repo === repo && Number(job?.prNumber) === Number(prNumber) &&
          job?.revisionRef === headSha &&
          normalizeEffectiveReviewVerdict(job.reviewBody) === 'comment-only') return true;
    }
  }
  return false;
}

export function hasCompletedCommentOnlyFinalRound(rootDir, { repo, prNumber, headSha }) {
  if (!SHA.test(String(headSha || ''))) return false;
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
    let job;
    try {
      job = JSON.parse(contents);
    } catch (err) {
      console.warn(`[comment-only-final-round] Skipping malformed job ${join(dir, name)}: ${err?.message || err}`);
      continue;
    }
    if (job?.repo === repo && Number(job?.prNumber) === Number(prNumber) &&
        job?.status === 'completed' && job?.finalRound === 'comment-only' &&
        job?.reReview?.suppressed === 'comment-only-final-round' &&
        job?.completion?.workerPushedHeadSha === headSha) return true;
  }
  return false;
}

export async function proveCommentOnlyFinalRoundHead({
  repo,
  reviewedHead,
  currentHead,
  completedRevisionRefs = [],
  completedPushedHeads = [],
  execFileImpl,
  logger = console,
  sleep,
  refreshGhAuthImpl,
}) {
  if (!SHA.test(String(reviewedHead || '')) || !SHA.test(String(currentHead || '')) ||
      !completedRevisionRefs.includes(reviewedHead) ||
      !completedPushedHeads.some((entry) => entry.reviewedHead === reviewedHead && entry.workerPushedHeadSha === currentHead) ||
      typeof execFileImpl !== 'function') {
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
