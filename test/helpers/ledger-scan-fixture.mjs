import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildFollowUpJob, ensureFollowUpJobDirs, getFollowUpJobDir } from '../../src/follow-up-jobs.mjs';

export const ledgerSubjects = [
  { repo: 'sample/project', prNumber: 87 },
  { repo: 'sample/project', prNumber: 8776 },
  { repo: 'sample/other', prNumber: 87 },
  { repo: 'sample__project', prNumber: 87 },
  { repo: 'sample/project', prNumber: 87, domainId: 'research-finding' },
  { repo: 'sample/project', prNumber: 999 },
];

// Synthetic queue records, including older schema versions and absent domainId.
export function writeLedgerScanFixture(rootDir) {
  ensureFollowUpJobDirs(rootDir);
  const paths = [];
  const add = (bucket, suffix, overrides = {}) => {
    const base = buildFollowUpJob({
      repo: 'sample/project', prNumber: 87, reviewerModel: 'codex',
      reviewBody: '## Verdict\nRequest changes',
      reviewPostedAt: '2026-01-01T00:00:00.000Z', ...overrides,
    });
    const job = {
      ...base, domainId: undefined,
      status: bucket === 'inProgress' ? 'in_progress' : bucket,
      remediationWorker: { state: 'completed' }, ...overrides,
      jobId: `${base.jobId}-${suffix}`,
      remediationPlan: { ...base.remediationPlan, ...overrides.remediationPlan },
    };
    const dir = bucket.startsWith('stopped-archived/')
      ? join(rootDir, 'data', 'follow-up-jobs', bucket) : getFollowUpJobDir(rootDir, bucket);
    mkdirSync(dir, { recursive: true });
    const jobPath = join(dir, `${job.jobId}.json`);
    writeFileSync(jobPath, JSON.stringify(job));
    paths.push(jobPath);
    return job;
  };
  for (const [index, bucket] of ['pending', 'inProgress', 'completed', 'failed', 'stopped'].entries()) {
    add(bucket, bucket, {
      revisionRef: String(index + 1).repeat(40), nonBlockingOnly: index >= 2,
      completedAt: bucket === 'completed' ? '2026-01-03T00:00:00.000Z' : null,
      failedAt: bucket === 'failed' ? '2026-01-04T00:00:00.000Z' : null,
      stoppedAt: bucket === 'stopped' ? '2026-01-05T00:00:00.000Z' : null,
      claimedAt: bucket === 'inProgress' ? '2026-01-02T00:00:00.000Z' : null,
      remediationPlan: {
        currentRound: index, maxRounds: 6,
        rounds: [{ round: index, startHeadSha: 'a'.repeat(40), publishedHeadSha: 'b'.repeat(40) }],
        retryHistory: [{ round: index, requeuedAt: '2026-01-01T01:00:00.000Z', retryMetadata: { code: 'infrastructure-refund' } }],
      },
    });
    add(bucket, `near-${bucket}`, { prNumber: 8776, remediationPlan: { currentRound: 20 } });
    add(bucket, `other-${bucket}`, { repo: 'sample/other', remediationPlan: { currentRound: 30 } });
    add(bucket, `collision-${bucket}`, { repo: 'sample__project', remediationPlan: { currentRound: 40 } });
    add(bucket, `domain-${bucket}`, { domainId: 'research-finding', remediationPlan: { currentRound: 50 } });
  }
  add('completed', 'never-spawned', { remediationWorker: { state: 'never-spawned' },
    completedAt: '2026-01-06T00:00:00.000Z', remediationPlan: { currentRound: 80 } });
  add('completed', 'legacy', { schemaVersion: 1,
    completedAt: '2026-01-01T00:00:00.000Z', remediationPlan: { maxRounds: 6 } });
  add('failed', 'final', { finalRound: 'comment-only', revisionRef: 'c'.repeat(40),
    failedAt: '2026-01-07T00:00:00.000Z', reReview: { suppressed: 'comment-only-final-round' },
    completion: { workerPushedHeadSha: 'd'.repeat(40), workerPushProof: { method: 'git-cherry-replay' } },
    riskClass: 'high', remediationPlan: { currentRound: 4, maxRounds: 6 } });
  const single = { singleReview: { applied: true }, remediationWorker: { state: 'never-spawned' },
    stoppedAt: '2026-01-08T00:00:00.000Z',
    remediationPlan: { currentRound: 6, maxRounds: 6, stop: { code: 'max-rounds-reached', reason: 'single-review: synthetic stop' } } };
  add('stopped', 'single', single);
  add('stopped-archived/2026-01', 'single', single);
  add('stopped-archived/2026-01', 'archived', { status: 'stopped', finalRound: 'comment-only',
    revisionRef: 'e'.repeat(40), reReview: { suppressed: 'comment-only-final-round' },
    stoppedAt: '2026-01-09T00:00:00.000Z', completion: { workerPushedHeadSha: 'f'.repeat(40) },
    remediationPlan: { retryHistory: [{ round: 1, requeuedAt: '2026-01-01T02:00:00.000Z', retryMetadata: { code: 'infrastructure-refund' } }] } });
  // A directory with a job extension deterministically fails readFileSync,
  // even when the test process can bypass file permission bits.
  const unreadable = join(getFollowUpJobDir(rootDir, 'completed'), 'sample__project-pr-87-unreadable.json');
  mkdirSync(unreadable);
  paths.push(unreadable);
  const corrupt = join(getFollowUpJobDir(rootDir, 'failed'), 'sample__project-pr-87-corrupt.json');
  writeFileSync(corrupt, '{');
  paths.push(corrupt);
  return paths;
}
