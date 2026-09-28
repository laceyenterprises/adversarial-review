// A completed comment-only remediation may hand a descendant head to AMA.
// The job's reviewed head must still be the settled verdict head; an unrelated
// review or an unproven ancestry transition cannot grant closer authority.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execGhWithRetry, isTransientGhError } from './gh-cli.mjs';
import { normalizeEffectiveReviewVerdict } from './kernel/verdict.mjs';

const SHA = /^[0-9a-f]{40}$/iu;

export function suppressFinalRoundFollowUp(pushedHeads, headSha, reviewPostedAt) {
  return pushedHeads?.some((entry) => entry.workerPushedHeadSha === headSha &&
    (!entry.completedAt || Date.parse(reviewPostedAt) <= Date.parse(entry.completedAt))) || false;
}

export async function captureFinalRoundWorkerPushedHead({
  repo, prNumber, jobId, reviewedHead, workspaceDir, execFileImpl, log = console, sleep,
}) {
  try {
    const [localHead, remoteHead] = await Promise.all([
      execFileImpl('git', ['-C', workspaceDir, 'rev-parse', 'HEAD']),
      execGhWithRetry({
        execFileImpl, args: ['pr', 'view', String(prNumber), '--repo', repo, '--json', 'headRefOid', '--jq', '.headRefOid'],
        log, ...(sleep ? { sleep } : {}),
      }),
    ]);
    const localSha = String(localHead.stdout || '').trim();
    const remoteSha = String(remoteHead.stdout || '').trim();
    if (SHA.test(localSha) && SHA.test(String(reviewedHead || '')) && localSha === remoteSha) {
      const commit = await execFileImpl('git', ['-C', workspaceDir, 'show', '-s', '--format=%B', 'HEAD']);
      if (String(commit.stdout || '').split(/\r?\n/u).some((line) => line === `Worker-Job-Id: ${jobId}`)) {
        if (reviewedHead === localSha) return null;
        try {
          const comparison = await execGhWithRetry({
            execFileImpl, args: ['api', `repos/${repo}/compare/${reviewedHead}...${localSha}`, '--jq', '.status'],
            log, ...(sleep ? { sleep } : {}),
          });
          return String(comparison.stdout || '').trim() === 'ahead' ? localSha : null;
        } catch (err) {
          if (isTransientGhError(err) || err?.authOutage) throw err;
          if (!/\b404\b|not found/iu.test(String(err?.stderr || err?.message || err))) throw err;
          return null;
        }
      }
    }
    log.warn?.(`[follow-up-remediation] No worker-push proof for ${repo}#${prNumber}: head, live PR, or worker job trailer did not match`);
  } catch (err) {
    log.warn?.(`[follow-up-remediation] Worker-push proof failed for ${repo}#${prNumber}: ${err?.message || err}`);
    throw err;
  }
  return null;
}

// Directory metadata changes on the atomic rename used by job writes and moves.
// Cache parsed, PR-scoped records until that changes so watcher ticks do not
// repeatedly JSON-parse the (potentially large) completed job directory.
const jobScanCache = new Map();
const JOB_SCAN_CACHE_LIMIT = 128;

function scanCommentOnlyJobs(rootDir, status, repo, prNumber, log) {
  const dir = join(rootDir, 'data', 'follow-up-jobs', status);
  let stamp;
  try {
    const metadata = statSync(dir, { bigint: true });
    stamp = `${metadata.mtimeNs}:${metadata.ctimeNs}`;
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
  const key = `${dir}:${repo}:${Number(prNumber)}`;
  const cached = jobScanCache.get(key);
  if (cached?.stamp === stamp) return cached.jobs;
  const prefix = `${String(repo || '').replace(/\//gu, '__').replace(/[^a-zA-Z0-9_.-]/gu, '-')}-pr-${Number(prNumber)}-`;
  let names;
  try {
    names = readdirSync(dir).filter((name) => name.startsWith(prefix) && name.endsWith('.json'));
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
  const jobs = [];
  for (const name of names) {
    let contents;
    try {
      contents = readFileSync(join(dir, name), 'utf8');
    } catch (err) {
      if (err?.code === 'ENOENT') continue;
      throw err;
    }
    try {
      const job = JSON.parse(contents);
      if (job?.repo === repo && Number(job?.prNumber) === Number(prNumber)) jobs.push(job);
    } catch (err) {
      log.warn?.(`[comment-only-final-round] Skipping malformed job ${join(dir, name)}: ${err?.message || err}`);
    }
  }
  if (jobScanCache.size >= JOB_SCAN_CACHE_LIMIT) jobScanCache.delete(jobScanCache.keys().next().value);
  jobScanCache.set(key, { stamp, jobs });
  return jobs;
}

export function hasSettledCommentOnlyReviewHead(rootDir, { repo, prNumber, headSha }, log = console) {
  return ['pending', 'in-progress', 'completed', 'failed', 'stopped'].some((status) =>
    scanCommentOnlyJobs(rootDir, status, repo, prNumber, log).some((job) =>
      job.revisionRef === headSha && normalizeEffectiveReviewVerdict(job.reviewBody) === 'comment-only'
    )
  );
}

export function hasCompletedCommentOnlyFinalRound(rootDir, { repo, prNumber, headSha }, log = console) {
  if (!SHA.test(String(headSha || ''))) return false;
  return scanCommentOnlyJobs(rootDir, 'completed', repo, prNumber, log).some((job) =>
    job.status === 'completed' && job.finalRound === 'comment-only' &&
    job.reReview?.suppressed === 'comment-only-final-round' &&
    job.completion?.workerPushedHeadSha === headSha
  );
}

// The watcher must leave the old review intact until reconcile either proves
// the pushed head or relinquishes the final-round handoff.
export function hasInProgressCommentOnlyFinalRound(rootDir, { repo, prNumber, reviewedHead }, log = console) {
  return scanCommentOnlyJobs(rootDir, 'in-progress', repo, prNumber, log).some((job) =>
    job.revisionRef === reviewedHead && job.finalRound === 'comment-only'
  );
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
