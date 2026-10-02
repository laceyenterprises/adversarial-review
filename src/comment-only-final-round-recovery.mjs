// Native-owned, explicitly invoked recovery. No dispatch, re-review, merge,
// fetch, checkout, terminal rewrite or fabricated worker completion.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync, readdirSync, existsSync, statSync, writeFileSync, linkSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execGhWithRetry } from './gh-cli.mjs';
import { findLiveAmaCloserLease } from './ama/closer-lease.mjs';
import { listActiveAmaCloserDispatches } from './ama/dispatch-closer.mjs';
import { listFollowUpJobsInDir, readRemediationReplyArtifact } from './follow-up-jobs.mjs';
import { normalizeEffectiveReviewVerdict } from './kernel/verdict.mjs';
import { assessWorkerLivenessDetailed } from './remediation-worker-liveness.mjs';
import { inspectRemediationCiRegression } from './remediation-ci-regression.mjs';
import { resolveCommentOnlyFinalRoundCompletion } from './comment-only-final-round-completion.mjs';
import { recoveryDigest, recoveryRecordPath, RECOVERY_LIMIT, withCommentOnlyRecovery } from './comment-only-recovery-record.mjs';
import { tryAcquireFollowUpReconcileClaim, releaseFollowUpReconcileClaim } from './remediation-reconcile-claim.mjs';

const execFileAsync = promisify(execFile);
export async function recoverTerminalCommentOnlyRound({ rootDir, jobId, workspaceDir, apply = false,
  execFileImpl = execFileAsync, livenessImpl = assessWorkerLivenessDetailed,
  ciImpl = inspectRemediationCiRegression, now = () => new Date().toISOString(), log = console,
} = {}) {
  const execute = execFileImpl;
  execFileImpl = (command, args, options = {}) => execute(command, args, {
    ...options, timeout: Math.min(options.timeout || 15000, 15000),
  });
  const archive = join(rootDir, 'data', 'follow-up-jobs', 'stopped-archived');
  const archived = existsSync(archive) ? readdirSync(archive, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    .flatMap((entry) => readdirSync(join(archive, entry.name)).filter((name) => name === `${jobId}.json`)
      .map((name) => { const jobPath = join(archive, entry.name, name); return { jobPath, job: JSON.parse(readFileSync(jobPath, 'utf8')) }; })) : [];
  const entries = [...listFollowUpJobsInDir(rootDir, 'stopped'), ...archived];
  const matches = entries.filter(({ job }) => job.jobId === jobId);
  if (matches.length !== 1) throw new Error('recovery-requires-one-stopped-job');
  const { jobPath } = matches[0];
  const job = JSON.parse(readFileSync(jobPath, 'utf8'));
  const uid = process.getuid?.();
  if (uid === undefined || statSync(rootDir).uid !== uid || statSync(jobPath).uid !== uid) {
    throw new Error('recovery-requires-native-file-owner');
  }
  if (job.status !== 'stopped' || job.finalRound !== 'comment-only' ||
      job.reReview?.suppressed !== 'comment-only-final-round' ||
      normalizeEffectiveReviewVerdict(job.reviewBody) !== 'comment-only' ||
      !['no-progress', 'max-rounds-reached'].includes(job.remediationPlan?.stop?.code) ||
      job.remediationWorker?.state !== 'completed' ||
      !(job.remediationWorker?.dispatchMode === 'hq' && job.remediationWorker?.dispatchId ||
        Number.isInteger(job.remediationWorker?.processId) && job.remediationWorker.processId > 0) ||
      job.completion?.workerPushedHeadSha || !/^[a-f0-9]{40}$/u.test(job.completion?.withheldPushHeadSha || '') ||
      !String(job.completion?.finalRoundOutcome?.push || '').startsWith('reviewed-commit-not-replayed ')) {
    throw new Error('terminal-job-not-eligible-for-replay-recovery');
  }
  if (withCommentOnlyRecovery(rootDir, job).finalRoundRecovery) return { action: 'already-recovered', jobId };
  const claim = tryAcquireFollowUpReconcileClaim({ jobPath, now });
  if (!claim.acquired) throw new Error('recovery-reconcile-claim-held');
  try {
    const checkOwnership = async () => {
      const active = ['pending', 'inProgress'].flatMap((status) => listFollowUpJobsInDir(rootDir, status))
        .some(({ job: candidate }) => candidate.repo === job.repo && candidate.prNumber === job.prNumber);
      if (active || findLiveAmaCloserLease(rootDir, job) ||
          listActiveAmaCloserDispatches(rootDir).some((record) => record.repo === job.repo && Number(record.prNumber) === job.prNumber)) throw new Error('recovery-active-owner-or-finalizer');
      const live = await livenessImpl(job, { execFileImpl, now });
      if (live.state !== 'exited') throw new Error('recovery-worker-terminality-unproven');
      const remote = await execGhWithRetry({ execFileImpl, log, args: ['pr', 'view', String(job.prNumber),
        '--repo', job.repo, '--json', 'state,headRefOid'] });
      const pr = JSON.parse(remote.stdout);
      if (pr.state !== 'OPEN' || pr.headRefOid !== job.completion.withheldPushHeadSha) throw new Error('recovery-live-pr-changed');
      return live;
    };
    await checkOwnership();
    const sourceDigest = recoveryDigest(job);
    const replyPath = job.remediationReply?.path || job.remediationWorker?.replyPath;
    const reply = readRemediationReplyArtifact(replyPath, { expectedJob: job });
    const replyDigest = recoveryDigest(reply);
    // Read-only workspace check: unlike the normal completion audit, recovery
    // must never fetch into or otherwise mutate the historical worker tree.
    const audit = async () => {
      const { stdout } = await execFileImpl('git', ['--no-optional-locks', '--no-replace-objects', '-C', workspaceDir, 'status', '--porcelain'], { timeout: 15000, maxBuffer: 1024 * 1024 });
      return { suspect: String(stdout || '').trim() ? ['dirty-workspace'] : [], error: null };
    };
    const result = await resolveCommentOnlyFinalRoundCompletion({ job, jobPath, reply, workspaceDir,
      auditWorkspaceForContaminationImpl: audit, inspectRemediationCiRegressionImpl: ciImpl,
      execFileImpl, log, retryDelaysMs: [], deliverAlertImpl: async () => {},
      writeJobImpl: () => { throw new Error('recovery-does-not-rewrite-history'); } });
    const head = result.workerPushedHeadSha;
    const completed = result.completed && head === job.completion.withheldPushHeadSha &&
      result.completionFields.workerPushProof?.generatedIndexPolicy === 'agent-os-main-index-v1';
    const record = { schemaVersion: 1, jobId, repo: job.repo, prNumber: job.prNumber,
      reviewedHead: job.revisionRef, head: job.completion.withheldPushHeadSha,
      sourceDigest, replyDigest, evaluatedAt: now(), completed: Boolean(completed), completion: result.completionFields };
    if (!apply) return { action: 'preview', record };
    await checkOwnership();
    if (recoveryDigest(JSON.parse(readFileSync(jobPath, 'utf8'))) !== sourceDigest ||
        recoveryDigest(readRemediationReplyArtifact(replyPath, { expectedJob: job })) !== replyDigest) throw new Error('recovery-artifacts-changed');
    // Re-run the proof immediately before immutable publication. A concurrent
    // force-push is rejected by the proof fence; downstream still probes live
    // head/checks under its own lease before any merge.
    if (completed) {
      const refreshed = await resolveCommentOnlyFinalRoundCompletion({ job, jobPath, reply, workspaceDir,
        auditWorkspaceForContaminationImpl: audit, inspectRemediationCiRegressionImpl: ciImpl,
        execFileImpl, log, retryDelaysMs: [], deliverAlertImpl: async () => {},
        writeJobImpl: () => { throw new Error('recovery-does-not-rewrite-history'); } });
      if (!refreshed.completed || refreshed.workerPushedHeadSha !== head) throw new Error('recovery-proof-changed');
    }
    await checkOwnership();
    if (recoveryDigest(JSON.parse(readFileSync(jobPath, 'utf8'))) !== sourceDigest ||
        recoveryDigest(readRemediationReplyArtifact(replyPath, { expectedJob: job })) !== replyDigest) throw new Error('recovery-artifacts-changed');
    for (let attempt = 1; attempt <= RECOVERY_LIMIT; attempt += 1) {
      const path = recoveryRecordPath(rootDir, jobId, attempt);
      mkdirSync(dirname(path), { recursive: true });
      try {
        const temp = `${path}.${process.pid}.tmp`;
        try {
          writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o640 });
          linkSync(temp, path);
        } finally { rmSync(temp, { force: true }); }
        return { action: completed ? 'recovered' : 'withheld', record, recordPath: path };
      } catch (err) { if (err.code !== 'EEXIST') throw err; }
    }
    throw new Error('recovery-attempt-limit');
  } finally { releaseFollowUpReconcileClaim(claim); }
}
