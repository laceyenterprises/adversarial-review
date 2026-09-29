// A completed comment-only remediation may hand a descendant head to AMA.
// The job's reviewed head must still be the settled verdict head; an unrelated
// review or an unproven ancestry transition cannot grant closer authority.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execGhWithRetry } from './gh-cli.mjs';
import { normalizeEffectiveReviewVerdict } from './kernel/verdict.mjs';

const SHA = /^[0-9a-f]{40}$/iu;

export function suppressFinalRoundFollowUp(pushedHeads, headSha, reviewPostedAt) {
  return pushedHeads?.some((entry) => entry.workerPushedHeadSha === headSha &&
    (!entry.completedAt || Date.parse(reviewPostedAt) <= Date.parse(entry.completedAt))) || false;
}

// COMMENTCLOSE-01: the proof method recorded on a push proven by replay below.
export const FINAL_ROUND_REPLAY_PROOF = 'git-cherry-replay';

// A git failure the next attempt can clear: the network, or a lock another git
// process holds. The final round retries these instead of withholding its proof.
const TRANSIENT_GIT_FAILURE = /(?:unable to access|could not resolve host|failed to connect|connection (?:reset|timed out)|connection refused|network is unreachable|operation timed out|timed out|timeout|TLS|SSL|HTTP 5\d\d|The requested URL returned error: 5\d\d|remote end hung up unexpectedly|early EOF|RPC failed|temporary failure|temporarily unavailable|input\/output error|i\/o error|index\.lock|could not lock|cannot lock ref|unable to create [^\n]*lock)/iu;

export function isTransientGitFailure(text) {
  return TRANSIENT_GIT_FAILURE.test(String(text || ''));
}

function cherryEntries(stdout) {
  return String(stdout || '').split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).map((line) => {
    const match = line.match(/^([+-])\s+([0-9a-f]{7,40})\b/iu);
    return match ? { sign: match[1], sha: match[2] } : { sign: '?', sha: line };
  });
}

function hasWorkerJobTrailer(message, jobId) {
  return String(message || '').split(/\r?\n/u).some((line) => line === `Worker-Job-Id: ${jobId}`);
}

/**
 * Prove that the live PR head is this final round's own push.
 *
 * Every remediator rebases onto a freshly fetched `origin/<base>` before it
 * edits, so its push is usually NOT a descendant of the reviewed head; GitHub
 * compare reports it `diverged`. The previous ancestry-only proof therefore
 * returned null, silently, for most final rounds that pushed (agent-os#7293 and
 * #7311 were `diverged`), which is why their pushed heads were reviewed again.
 *
 * The proof is local and structural instead. With the workspace HEAD equal to
 * the live PR head and carrying this job's `Worker-Job-Id` trailer:
 *   1. every reviewed commit has a patch-equivalent in HEAD
 *      (`git cherry HEAD <reviewed>` lists only `-`), so nothing reviewed was
 *      dropped or rewritten;
 *   2. HEAD adds no merge commit beyond the reviewed head and the base;
 *   3. every commit HEAD adds beyond the reviewed head and the base that is not
 *      such a replay carries this job's trailer
 *      (`git cherry <reviewed> HEAD origin/<base>`).
 * A human commit replayed under the worker's, a conflict-rewritten reviewed
 * commit, or a merge fails closed. Every withheld proof logs its reason; a
 * `gh` failure throws so the job stays in progress and the next reconcile
 * retries it. A git failure that `isTransientGitFailure` recognizes is withheld
 * with `transient: true`; the caller retries it rather than holding the head.
 *
 * @returns {Promise<{ workerPushedHeadSha: string|null, liveHeadSha: string|null,
 *   reason: string, proof?: object, transient?: boolean }>}
 */
export async function proveFinalRoundWorkerPush({
  repo, prNumber, jobId, reviewedHead, baseBranch, workspaceDir, execFileImpl,
  withheldBecause = null, log = console, sleep,
}) {
  let remoteSha;
  try {
    const remote = await execGhWithRetry({
      execFileImpl, args: ['pr', 'view', String(prNumber), '--repo', repo, '--json', 'headRefOid', '--jq', '.headRefOid'],
      log, ...(sleep ? { sleep } : {}),
    });
    remoteSha = String(remote.stdout || '').trim();
  } catch (err) {
    log.warn?.(`[follow-up-remediation] Worker-push proof failed for ${repo}#${prNumber}: ${err?.message || err}`);
    throw err;
  }
  const liveHeadSha = SHA.test(remoteSha) ? remoteSha : null;
  const withheld = (reason) => {
    log.warn?.(
      `[follow-up-remediation] Withholding final-round push proof for ${repo}#${prNumber}: ${reason} ` +
        `(reviewed=${String(reviewedHead || 'none').slice(0, 12)} live=${String(liveHeadSha || 'none').slice(0, 12)})`
    );
    return { workerPushedHeadSha: null, liveHeadSha, reason };
  };
  if (withheldBecause) return withheld(withheldBecause);
  if (!SHA.test(String(reviewedHead || ''))) return withheld('reviewed-head-invalid');
  const git = async (args) => String((await execFileImpl('git', ['-C', workspaceDir, ...args], {
    maxBuffer: 10 * 1024 * 1024,
  })).stdout || '');
  try {
    const localSha = (await git(['rev-parse', 'HEAD'])).trim();
    if (!SHA.test(localSha) || localSha !== liveHeadSha) return withheld(`live-head-mismatch local=${localSha.slice(0, 12) || 'none'}`);
    if (localSha === reviewedHead) return { workerPushedHeadSha: null, liveHeadSha, reason: 'no-push' };
    if (!hasWorkerJobTrailer(await git(['show', '-s', '--format=%B', 'HEAD']), jobId)) return withheld('head-not-worker-commit');
    const base = `origin/${baseBranch}`;
    const dropped = cherryEntries(await git(['cherry', localSha, reviewedHead])).filter(({ sign }) => sign !== '-');
    if (dropped.length > 0) return withheld(`reviewed-commit-not-replayed ${dropped[0].sha.slice(0, 12)}`);
    if ((await git(['rev-list', '--merges', localSha, `^${reviewedHead}`, `^${base}`])).trim()) {
      return withheld('merge-commit-in-push');
    }
    const pushed = cherryEntries(await git(['cherry', reviewedHead, localSha, base]));
    const added = pushed.filter(({ sign }) => sign !== '-');
    for (const { sha } of added) {
      if (!hasWorkerJobTrailer(await git(['show', '-s', '--format=%B', sha]), jobId)) {
        return withheld(`foreign-commit-in-push ${sha.slice(0, 12)}`);
      }
    }
    const reviewedCommitsReplayed = pushed.length - added.length;
    return {
      workerPushedHeadSha: localSha,
      liveHeadSha,
      reason: reviewedCommitsReplayed > 0 ? 'replayed-onto-base' : 'descendant',
      proof: { method: FINAL_ROUND_REPLAY_PROOF, reviewedCommitsReplayed, workerCommits: added.length },
    };
  } catch (err) {
    const diagnostic = String(err?.message || err).split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).join(' ');
    return { ...withheld(`git-proof-failed: ${diagnostic}`), transient: isTransientGitFailure(diagnostic) };
  }
}

// Directory metadata changes on the atomic rename used by job writes and moves.
// Cache parsed, PR-scoped records until that changes so watcher ticks do not
// repeatedly JSON-parse the (potentially large) completed job directory.
const jobScanCache = new Map();
const JOB_SCAN_CACHE_LIMIT = 128;

// Also the PR-scoped job scan behind one-follow-up-per-review (follow-up-review-claim.mjs).
export function scanPrFollowUpJobs(rootDir, status, repo, prNumber, log = console) {
  return scanCommentOnlyJobs(rootDir, status, repo, prNumber, log);
}

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

// The daemon sweeps stopped jobs older than a day into
// stopped-archived/<YYYY-MM>/ (archiveStoppedFollowUpJobs). An archived job keeps
// `status: 'stopped'` and keeps every authority it had in stopped/: its recorded
// push, its withheld head, and its one-follow-up-per-review key.
const ARCHIVED_STOPPED_DIR = 'stopped-archived';

export function scanArchivedStoppedFollowUpJobs(rootDir, repo, prNumber, log = console) {
  let months;
  try {
    months = readdirSync(join(rootDir, 'data', 'follow-up-jobs', ARCHIVED_STOPPED_DIR), { withFileTypes: true })
      .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
  return months.flatMap((month) => scanCommentOnlyJobs(rootDir, `${ARCHIVED_STOPPED_DIR}/${month}`, repo, prNumber, log));
}

// Terminal jobs for the PR, archived stopped jobs included, as { status, job }.
function terminalFollowUpJobs(rootDir, repo, prNumber, log) {
  return [
    ...['completed', 'stopped', 'failed'].flatMap((status) =>
      scanCommentOnlyJobs(rootDir, status, repo, prNumber, log).map((job) => ({ status, job }))),
    ...scanArchivedStoppedFollowUpJobs(rootDir, repo, prNumber, log).map((job) => ({ status: 'stopped', job })),
  ];
}

function isTerminalFinalRound(status, job) {
  return job.status === status && job.finalRound === 'comment-only' &&
    job.reReview?.suppressed === 'comment-only-final-round';
}

export function hasSettledCommentOnlyReviewHead(rootDir, { repo, prNumber, headSha }, log = console) {
  const settled = (job) => job.revisionRef === headSha && normalizeEffectiveReviewVerdict(job.reviewBody) === 'comment-only';
  return ['pending', 'in-progress'].some((status) => scanCommentOnlyJobs(rootDir, status, repo, prNumber, log).some(settled)) ||
    terminalFollowUpJobs(rootDir, repo, prNumber, log).some(({ job }) => settled(job));
}

// COMMENTCLOSE-01: a final round that stopped (for example on pending CI in an
// older reconciler) still pushed its head; that head is not re-reviewed either.
export function hasCommentOnlyFinalRoundPush(rootDir, { repo, prNumber, headSha }, log = console) {
  if (!SHA.test(String(headSha || ''))) return false;
  return terminalFollowUpJobs(rootDir, repo, prNumber, log).some(({ status, job }) =>
    isTerminalFinalRound(status, job) && job.completion?.workerPushedHeadSha === headSha);
}

// COMMENTCLOSE-01: a final round whose push could not be proven while the PR head
// moved records that live head as `completion.withheldPushHeadSha` and alerts.
// Review of that head is held (an explicit operator retrigger still overrides)
// instead of silently re-opening the review the final round was meant to end.
export function hasUnprovenCommentOnlyFinalRoundHead(rootDir, { repo, prNumber, headSha }, log = console) {
  if (!SHA.test(String(headSha || ''))) return false;
  return terminalFollowUpJobs(rootDir, repo, prNumber, log).some(({ status, job }) =>
    isTerminalFinalRound(status, job) && job.completion?.withheldPushHeadSha === headSha);
}

// COMMENTCLOSE-01: the terminal final-round job that pushed `workerPushedHeadSha`
// for `reviewedHead`. Its reviewBody is the settled Comment only review, so the
// AMA closer can read the verdict of a head the final round moved on from.
export function findCommentOnlyFinalRoundPushJob(rootDir, { repo, prNumber, reviewedHead, workerPushedHeadSha }, log = console) {
  if (!SHA.test(String(reviewedHead || '')) || !SHA.test(String(workerPushedHeadSha || ''))) return null;
  let found = null;
  let foundAt = '';
  for (const { status, job } of terminalFollowUpJobs(rootDir, repo, prNumber, log)) {
    if (!isTerminalFinalRound(status, job) || job.revisionRef !== reviewedHead ||
        job.completion?.workerPushedHeadSha !== workerPushedHeadSha) continue;
    const at = job.completedAt || job.stoppedAt || job.failedAt || '';
    if (!found || at > foundAt) {
      found = job;
      foundAt = at;
    }
  }
  return found;
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
  const entry = (Array.isArray(completedPushedHeads) ? completedPushedHeads : []).find((candidate) => (
    candidate?.reviewedHead === reviewedHead && candidate?.workerPushedHeadSha === currentHead
  ));
  if (!SHA.test(String(reviewedHead || '')) || !SHA.test(String(currentHead || '')) ||
      !(Array.isArray(completedRevisionRefs) && completedRevisionRefs.includes(reviewedHead)) || !entry ||
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
  const status = String(stdout || '').trim();
  // A replay-proven push (COMMENTCLOSE-01) is the reviewed commits replayed onto
  // the freshly fetched base plus the worker's own commits, so it is `diverged`
  // by construction. A legacy ancestry-only record still needs `ahead`.
  return status === 'ahead' || (status === 'diverged' && entry.pushProof === FINAL_ROUND_REPLAY_PROOF);
}
