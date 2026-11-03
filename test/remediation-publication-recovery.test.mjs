import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { proveFinalRoundWorkerPush } from '../src/comment-only-final-round.mjs';
import { findCommittedUnpublishedWork } from '../src/remediation-unpublished.mjs';
import { buildFollowUpJob, buildRemediationReply, writeFollowUpJob, readFollowUpJob,
  requeueFollowUpJobForNextRound } from '../src/follow-up-jobs.mjs';
import { guardRereviewCiBeforeReviewer } from '../src/reviewer-ci-admission.mjs';
import { findLatestFollowUpJob } from '../src/operator-retrigger-helpers.mjs';
import { proveStoppedPublication } from '../src/remediation-publication-recovery.mjs';

const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const log = { warn() {} };
function commit(dir, file, text, message) {
  writeFileSync(join(dir, file), text);
  git(dir, 'add', file);
  git(dir, 'commit', '-qm', message);
  return git(dir, 'rev-parse', 'HEAD');
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'publication-recovery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = join(root, 'remote.git'), workspace = join(root, 'worker'), publisher = join(root, 'publisher');
  mkdirSync(remote); git(remote, 'init', '-q', '--bare', '-b', 'main');
  git(root, 'clone', '-q', remote, workspace);
  commit(workspace, 'base.txt', 'base\n', 'base');
  git(workspace, 'push', '-q', 'origin', 'main');
  git(workspace, 'checkout', '-qb', 'repair');
  const reviewed = commit(workspace, 'feature.txt', 'feature\n', 'reviewed feature');
  const job = buildFollowUpJob({ repo: 'fixture/repo', prNumber: 42, revisionRef: reviewed,
    reviewerModel: 'codex', baseBranch: 'main', reviewBody: '## Verdict\nComment only\n' });
  const local = commit(workspace, 'fix.txt', 'repair\n', `repair\n\nWorker-Job-Id: ${job.jobId}`);
  git(workspace, 'push', '-q', 'origin', 'repair');
  git(root, 'clone', '-q', remote, publisher);
  commit(publisher, 'trunk.txt', 'moved\n', 'advance trunk');
  git(publisher, 'push', '-q', 'origin', 'main');
  git(publisher, 'checkout', '-qb', 'repair', 'origin/repair');
  git(publisher, 'rebase', '-q', 'main');
  const live = git(publisher, 'rev-parse', 'HEAD');
  git(publisher, 'push', '-q', '--force-with-lease', 'origin', 'repair');
  const execFileImpl = async (cmd, argv, options) => cmd === 'gh'
    ? { stdout: `${git(remote, 'rev-parse', 'refs/heads/repair')}\n` }
    : { stdout: execFileSync(cmd, argv, { ...options, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  const proofArgs = { repo: job.repo, prNumber: job.prNumber, jobId: job.jobId,
    reviewedHead: reviewed, baseBranch: 'main', workspaceDir: workspace, execFileImpl, log };
  const ciGate = { state: 'failed', headSha: live, failedChecks: [{ name: 'fixture-check', state: 'FAILURE' }] };
  return { root, remote, workspace, publisher, job, local, live, execFileImpl, proofArgs, ciGate };
}
function stop(f, { final = false, cap = 2 } = {}) {
  const job = { ...f.job, status: 'stopped', finalRound: final ? 'comment-only' : null,
    reReview: final ? { requested: false, suppressed: 'comment-only-final-round' } : { requested: false },
    remediationWorker: { state: 'completed', workspaceDir: f.workspace },
    unpublishedWork: { commitSha: f.local, workspaceDir: f.workspace },
    completion: { withheldPushHeadSha: f.live, finalRoundOutcome: { completed: false, reason: 'no-proven-push' } },
    remediationPlan: { ...f.job.remediationPlan, currentRound: 1, maxRounds: cap,
      rounds: [{ round: 1, state: 'stopped' }], stop: { code: 'committed-unpublished', reason: 'publication unproven' } } };
  const replyPath = join(f.root, 'reply.json');
  writeFileSync(replyPath, JSON.stringify(buildRemediationReply({ job, summary: 'Repair published.' })));
  job.remediationReply = { path: replyPath };
  const jobPath = join(f.root, 'data/follow-up-jobs/stopped', `${job.jobId}.json`);
  writeFollowUpJob(jobPath, job);
  return { job, jobPath };
}
const admission = (f, extra = {}) => guardRereviewCiBeforeReviewer({ rootDir: f.root, repo: f.job.repo,
  prNumber: 42, passKind: 'rereview', reviewerHeadSha: f.live, execFileImpl: f.execFileImpl,
  inspectCiImpl: async () => f.ciGate, log, deliverAlertImpl: async () => {}, ...extra });

test('a pushed A rebased and pushed as A-prime is proven from the stale worker checkout', async t => {
  const f = fixture(t);
  assert.notEqual(f.local, f.live);
  const proof = await proveFinalRoundWorkerPush(f.proofArgs);
  assert.equal(proof.workerPushedHeadSha, f.live);
  assert.equal(proof.proof.publication, 'patch-equivalent-live-head');
  assert.equal(git(f.workspace, 'rev-parse', 'HEAD'), f.local);
  assert.equal(await findCommittedUnpublishedWork({ reply: { summary: 'Publisher refused publication before retry.' },
    job: f.job, workspaceDir: f.workspace, execFileImpl: f.execFileImpl }), null);
});

test('a local commit never pushed remains unpublished and names both heads', async t => {
  const f = fixture(t);
  const never = commit(f.workspace, 'never.txt', 'never\n', `not pushed\n\nWorker-Job-Id: ${f.job.jobId}`);
  const proof = await proveFinalRoundWorkerPush(f.proofArgs);
  assert.equal(proof.workerPushedHeadSha, null);
  const debt = await findCommittedUnpublishedWork({ reply: { summary: 'Work is unpushed.' },
    job: f.job, workspaceDir: f.workspace, execFileImpl: f.execFileImpl });
  assert.equal(debt.commitSha, never);
  assert.equal(debt.liveHeadSha, f.live);
  assert.match(debt.publicationReason, /worker-patch-not-published/);
});

test('a live unrelated worker-trailed change cannot prove the missing local patch', async t => {
  const f = fixture(t);
  git(f.publisher, 'reset', '--hard', 'main');
  const other = commit(f.publisher, 'other.txt', 'different\n', `other\n\nWorker-Job-Id: ${f.job.jobId}`);
  git(f.publisher, 'push', '-q', '--force-with-lease', 'origin', 'repair');
  const proof = await proveFinalRoundWorkerPush(f.proofArgs);
  assert.equal(proof.liveHeadSha, other);
  assert.equal(proof.workerPushedHeadSha, null);
});

test('published committed-unpublished debt requeues exactly once and keeps the spent round', async t => {
  const f = fixture(t); stop(f);
  const first = await admission(f);
  assert.equal(first.reason, 'ci-regression-requeued');
  assert.equal(first.job.status, 'pending');
  assert.equal(first.job.remediationPlan.currentRound, 1);
  assert.equal(first.job.remediationPlan.maxRounds, 2);
  assert.equal(first.job.remediationPlan.nextAction.round, 2);
  assert.equal(first.job.revisionRef, f.live);
  const bytes = JSON.stringify(readFollowUpJob(first.jobPath));
  const second = await admission(f, { requeueImpl: () => assert.fail('must not requeue twice') });
  assert.equal(second.reason, 'ci-regression-remediation-active');
  assert.equal(JSON.stringify(readFollowUpJob(second.jobPath)), bytes);
});

test('a valid completed final round reconciles directly to hammer ownership even at its cap', async t => {
  const f = fixture(t); stop(f, { final: true, cap: 1 });
  const first = await admission(f);
  assert.equal(first.reason, 'ci-regression-hammer-owned');
  assert.equal(first.job.status, 'completed');
  assert.equal(first.job.completion.workerPushedHeadSha, f.live);
  assert.equal(first.job.remediationPlan.stop, null);
  assert.equal(first.job.remediationPlan.rounds[0].state, 'completed');
  assert.equal(first.job.remediationPlan.currentRound, 1);
  assert.equal(first.job.remediationPlan.maxRounds, 1);
  const second = await admission(f, { requeueImpl: () => assert.fail('completed final round must retain owner') });
  assert.equal(second.reason, 'ci-regression-hammer-owned');
});

test('changed job evidence invalidates publication recovery under the queue lock', async t => {
  const f = fixture(t); const stopped = stop(f);
  const proof = await proveStoppedPublication({ ...stopped, headSha: f.live, ciGate: f.ciGate, execFileImpl: f.execFileImpl, log });
  const job = { ...stopped.job, reviewBody: 'changed concurrently' };
  writeFollowUpJob(stopped.jobPath, job);
  assert.throws(() => requeueFollowUpJobForNextRound({ rootDir: f.root, jobPath: stopped.jobPath,
    revisionRef: f.live, publicationRecovery: proof }), /stopped:committed-unpublished/);
});

test('unpublished work cannot requeue and a proven incomplete round cannot exceed its cap', async t => {
  const f = fixture(t); const stopped = stop(f, { cap: 1 });
  assert.throws(() => requeueFollowUpJobForNextRound({ rootDir: f.root, jobPath: stopped.jobPath,
    revisionRef: f.live }), /stopped:committed-unpublished/);
  const result = await admission(f);
  assert.equal(result.job.status, 'stopped');
  assert.equal(result.job.remediationPlan.currentRound, 1);
  assert.equal(result.job.remediationPlan.maxRounds, 1);
  assert.equal(result.job.remediationPlan.stop.code, 'max-rounds-reached');
  assert.equal(result.needsOperator, true);
});

test('a partially published worker series and unavailable live objects remain unproven', async t => {
  const f = fixture(t);
  commit(f.workspace, 'second.txt', 'second repair\n', `second repair\n\nWorker-Job-Id: ${f.job.jobId}`);
  const stopped = stop(f);
  assert.equal(await proveStoppedPublication({ ...stopped, headSha: f.live,
    ciGate: f.ciGate, execFileImpl: f.execFileImpl, log }), null);
  const unknown = await proveFinalRoundWorkerPush({ ...f.proofArgs,
    execFileImpl: async (command, argv, options) => {
      if (command === 'git' && argv.includes('fetch')) throw new Error('connection reset');
      return f.execFileImpl(command, argv, options);
    } });
  assert.equal(unknown.workerPushedHeadSha, null);
  assert.equal(unknown.transient, true);
});

test('a real review blocker cannot be erased by publication recovery', async t => {
  const f = fixture(t); const stopped = stop(f, { final: true });
  writeFileSync(stopped.job.remediationReply.path, JSON.stringify(buildRemediationReply({ job: stopped.job,
    outcome: 'blocked', summary: 'Repair published but a decision remains.',
    blockers: [{ finding: 'Needs a product decision.' }] })));
  const proof = await proveStoppedPublication({ ...stopped, headSha: f.live, ciGate: f.ciGate, execFileImpl: f.execFileImpl, log });
  assert.equal(proof.completedFinalRound, false);
  const result = await admission(f);
  assert.equal(result.job.status, 'pending');
  assert.equal(result.job.finalRound, null);
  assert.equal(result.job.remediationPlan.currentRound, 1);
});


for (const final of [false, true]) test(`two admissions sharing a stopped snapshot retain the single ${final ? 'hammer' : 'remediation'} owner`, async t => {
  const f = fixture(t); const stopped = stop(f, { final });
  const snapshot = { ...stopped, job: readFollowUpJob(stopped.jobPath) };
  let reads = 0;
  const latestJobFinder = (...args) => ++reads <= 2 ? snapshot : findLatestFollowUpJob(...args);
  const results = await Promise.all([admission(f, { latestJobFinder }), admission(f, { latestJobFinder })]);
  assert.equal(results.filter(result => result.needsOperator).length, 0);
  assert.ok(results.every(result => result.job.status === (final ? 'completed' : 'pending')));
  assert.equal(results[0].jobPath, results[1].jobPath);
  const job = readFollowUpJob(results[0].jobPath);
  assert.equal(job.remediationPlan.currentRound, 1);
  assert.equal(job.remediationPlan.maxRounds, 2);
  if (!final) assert.equal(job.remediationPlan.nextAction.round, 2);
});
