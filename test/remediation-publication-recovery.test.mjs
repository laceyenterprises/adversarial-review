import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { proveFinalRoundWorkerPush } from '../src/comment-only-final-round.mjs';
import { findCommittedUnpublishedWork } from '../src/remediation-unpublished.mjs';
import { buildFollowUpJob, buildRemediationReply, writeFollowUpJob, readFollowUpJob,
  requeueFollowUpJobForNextRound } from '../src/follow-up-jobs.mjs';
import { guardRereviewCiBeforeReviewer } from '../src/reviewer-ci-admission.mjs';
import { findLatestFollowUpJob } from '../src/operator-retrigger-helpers.mjs';
import { proveStoppedPublication } from '../src/remediation-publication-recovery.mjs';
import { resolveCommentOnlyFinalRoundCompletion } from '../src/comment-only-final-round-completion.mjs';
import { completeWorkerPublishedHead, findWorkerPublishedHead } from '../src/remediation-published-head.mjs';
import { deliveryRetryIndexPointerPath } from '../src/adapters/comms/github-pr-comments/comment-delivery.mjs';
import { createGithubOwnerTokenSelector, githubOwnerTokens } from '../src/github-owner-token.mjs';

Object.assign(githubOwnerTokens, createGithubOwnerTokenSelector({ readHomeOwner: () => null }));

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
function fixture(t, { hq = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'publication-recovery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const slot = hq ? join(root, 'workers', 'worker') : root;
  mkdirSync(slot, { recursive: true });
  const remote = join(root, 'remote.git'), workspace = join(slot, 'repo'), publisher = join(root, 'publisher');
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
  if (!hq) return { root, remote, workspace, publisher, job, local, live, execFileImpl, proofArgs, ciGate };

  const origin = 'git@github.com:fixture/repo.git';
  git(workspace, 'remote', 'set-url', 'origin', origin);
  git(workspace, 'config', `url.${remote}.insteadOf`, origin);
  job.branch = 'repair';
  job.remediationWorker = { dispatchMode: 'hq', dispatchId: 'lrq_fixture',
    launchRequestId: 'lrq_fixture', hqRoot: root, workspaceDir: slot, workerClass: 'codex' };
  const status = { status: 'succeeded', dispatchId: 'lrq_fixture', launchRequestId: 'lrq_fixture',
    workerRunId: 'wrun_fixture', ticketRef: job.jobId, workerClass: 'codex',
    workspacePath: slot, repo: workspace, branch: 'provisioned-ticket-branch' };
  const read = async (cmd, argv, options) => {
    if (cmd === 'hq') return { stdout: JSON.stringify(status) };
    if (cmd === 'gh' && argv.includes('repos/fixture/repo/pulls/42')) {
      return { stdout: JSON.stringify({ number: 42, state: 'open',
        head: { sha: git(remote, 'rev-parse', 'refs/heads/repair'), ref: 'repair', repo: { full_name: job.repo } },
        base: { ref: 'main', repo: { full_name: job.repo } } }) };
    }
    if (cmd === 'gh' && argv.includes('repos/fixture/repo/git/ref/heads/repair')) {
      return { stdout: JSON.stringify({ ref: 'refs/heads/repair',
        object: { type: 'commit', sha: git(remote, 'rev-parse', 'refs/heads/repair') } }) };
    }
    return execFileImpl(cmd, argv, options);
  };
  return { root, slot, remote, workspace, publisher, job, local, live, execFileImpl: read, proofArgs, ciGate, status };
}
function stop(f, { final = false, cap = 2 } = {}) {
  const job = { ...f.job, status: 'stopped', finalRound: final ? 'comment-only' : null,
    reReview: final ? { requested: false, suppressed: 'comment-only-final-round' } : { requested: false },
    remediationWorker: { state: 'completed', workspaceDir: f.workspace, ...f.job.remediationWorker },
    unpublishedWork: { commitSha: f.local, workspaceDir: f.slot || f.workspace },
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

test('HQ publication proof uses the selected repository beneath a non-Git worker root', async t => {
  const f = fixture(t, { hq: true });
  git(f.slot, 'clone', '-q', f.remote, join(f.slot, 'another-repo'));
  const debt = await findCommittedUnpublishedWork({ reply: { summary: `Commit ${f.local} is unpublished.` },
    job: f.job, workspaceDir: f.slot, execFileImpl: f.execFileImpl, log });
  assert.equal(debt, null);
  const stopped = stop(f, { final: true, cap: 1 });
  f.status.workspacePath = f.workspace;
  // Older workers could only report a SHA abbreviation while the root probe failed.
  stopped.job.unpublishedWork.commitSha = f.local.slice(0, 12);
  writeFollowUpJob(stopped.jobPath, stopped.job);
  const source = readFileSync(stopped.jobPath, 'utf8');
  const proof = await proveStoppedPublication({ ...stopped, headSha: f.live, ciGate: f.ciGate, execFileImpl: f.execFileImpl, log });
  assert.equal(proof.headSha, f.live);
  assert.equal(proof.completedFinalRound, true);
  assert.equal(readFileSync(stopped.jobPath, 'utf8'), source);
  assert.equal(git(f.workspace, 'rev-parse', 'HEAD'), f.local);
});

test('HQ selection refuses conflicting, missing, malformed or foreign owner associations', async t => {
  const f = fixture(t, { hq: true });
  const second = join(f.slot, 'second');
  git(f.slot, 'clone', '-q', f.remote, second);
  const stopped = stop(f);
  const source = readFileSync(stopped.jobPath, 'utf8');
  // A copied manifest or job path cannot stand in for owner status.
  writeFileSync(join(f.slot, 'workspace.json'), JSON.stringify({ ...f.status, worktreePath: f.workspace }));
  stopped.job.unpublishedWork.workspaceDir = f.workspace;
  for (const malformed of [
    { ...f.status, repo: null },
    { ...f.status, repo: f.slot },
    { ...f.status, workspacePath: second },
    { ...f.status, launchRequestId: 'lrq_other' },
    { ...f.status, ticketRef: 'another-job' },
    { ...f.status, workerRunId: {} },
    { ...f.status, repo: f.publisher, workspacePath: f.publisher },
    'invalid JSON',
  ]) {
    const commands = [];
    const execFileImpl = async (cmd) => {
      commands.push(cmd);
      return { stdout: typeof malformed === 'string' ? malformed : JSON.stringify(malformed) };
    };
    assert.equal(await proveStoppedPublication({ ...stopped, headSha: f.live, execFileImpl, log }), null);
    assert.deepEqual(commands, ['hq'], 'no repository probe without a unique owner association');
  }
  git(f.workspace, 'remote', 'set-url', 'origin', 'git@github.com:another-owner/repo.git');
  assert.equal(await proveStoppedPublication({ ...stopped, headSha: f.live, execFileImpl: f.execFileImpl, log }), null);
  assert.equal(readFileSync(stopped.jobPath, 'utf8'), source);
});

test('HQ proof retains debt when the destination is partial, malformed or moves during inspection', async t => {
  const f = fixture(t, { hq: true });
  const stopped = stop(f);
  const source = readFileSync(stopped.jobPath, 'utf8');
  for (const failure of ['wrong-ref', 'wrong-repo', 'missing-destination', 'malformed-destination', 'malformed-replay', 'concurrent-head']) {
    let prReads = 0;
    const execFileImpl = async (cmd, argv, options) => {
      const path = argv[1];
      if (cmd === 'git' && argv.includes('cherry') && failure === 'malformed-replay') {
        return { stdout: `+ ${f.local} unexpected text\n` };
      }
      const result = await f.execFileImpl(cmd, argv, options);
      if (cmd === 'gh' && path.includes('/git/ref/heads/')) {
        if (failure === 'missing-destination') return { stdout: '{}' };
        if (failure === 'malformed-destination') return { stdout: '{' };
      }
      if (cmd === 'gh' && path.includes('/pulls/')) {
        const pr = JSON.parse(result.stdout);
        prReads++;
        if (failure === 'wrong-ref') pr.head.ref = 'other';
        if (failure === 'wrong-repo') pr.head.repo.full_name = 'other/repo';
        if (failure === 'concurrent-head' && prReads === 2) pr.head.sha = f.local;
        return { stdout: JSON.stringify(pr) };
      }
      return result;
    };
    assert.equal(await proveStoppedPublication({ ...stopped, headSha: f.live, execFileImpl, log }), null, failure);
  }
  assert.equal(await proveStoppedPublication({ ...stopped, headSha: f.live.slice(0, 12), execFileImpl: f.execFileImpl, log }), null);
  assert.equal(await proveStoppedPublication({ ...stopped, job: { ...stopped.job,
    unpublishedWork: { ...stopped.job.unpublishedWork, commitSha: f.live } },
    headSha: f.live, execFileImpl: f.execFileImpl, log }), null);
  assert.equal(readFileSync(stopped.jobPath, 'utf8'), source);
});

test('HQ final-round completion withholds authority when owner metadata is missing', async t => {
  const f = fixture(t, { hq: true });
  const stopped = stop(f, { final: true });
  const job = { ...stopped.job, workspaceDir: f.workspace, remediationWorker: {
    ...stopped.job.remediationWorker, spawnedAt: '2026-11-20T00:00:00Z' } };
  assert.equal(findWorkerPublishedHead({ rootDir: f.root, job, headSha: f.local,
    execFileSyncImpl: () => assert.fail('HQ fast path cannot use a stored workspace') }), null);
  delete f.status.repo;
  const result = await resolveCommentOnlyFinalRoundCompletion({ ...stopped, workspaceDir: f.workspace,
    reply: buildRemediationReply({ job, summary: 'I published the repair.' }), execFileImpl: f.execFileImpl, log,
    auditWorkspaceForContaminationImpl: () => assert.fail('unverified workspace must never be audited') });
  assert.equal(result.completed, false);
  assert.equal(result.workerPushedHeadSha, null);
  assert.equal(result.completionFields.withheldPushHeadSha, f.live);
});

test('a malformed completion destination preserves the source and its publication evidence', async t => {
  const f = fixture(t);
  const stopped = stop(f);
  const job = { ...stopped.job, status: 'in_progress',
    remediationWorker: { ...stopped.job.remediationWorker, spawnedAt: '2026-11-20T00:00:00Z' } };
  const source = join(f.root, 'data/follow-up-jobs/in-progress', `${job.jobId}.json`);
  const destination = join(f.root, 'data/follow-up-jobs/completed', `${job.jobId}.json`);
  mkdirSync(join(f.root, 'data/follow-up-jobs/completed'), { recursive: true });
  writeFollowUpJob(source, job);
  const bytes = readFileSync(source, 'utf8');
  for (const [contents, error] of [
    ['{', SyntaxError],
    [JSON.stringify({ jobId: job.jobId, status: 'completed' }), /Conflicting follow-up job/],
  ]) {
    writeFileSync(destination, contents);
    assert.throws(() => completeWorkerPublishedHead({ rootDir: f.root, jobPath: source, headSha: f.local }), error);
    assert.equal(readFileSync(source, 'utf8'), bytes);
    assert.equal(readFileSync(destination, 'utf8'), contents);
  }
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
  assert.equal(first.job.commentDelivery.posted, false);
  assert.equal(first.job.commentDelivery.deliveryKind, 'remediation-reply');
  assert.match(first.job.commentDelivery.body, /Repair published/);
  assert.equal(JSON.parse(readFileSync(deliveryRetryIndexPointerPath(f.root, first.jobPath), 'utf8')).jobPath, first.jobPath);
  rmSync(deliveryRetryIndexPointerPath(f.root, first.jobPath));
  const second = await admission(f, { requeueImpl: () => assert.fail('completed final round must retain owner') });
  assert.equal(second.reason, 'ci-regression-hammer-owned');
  assert.equal(JSON.parse(readFileSync(deliveryRetryIndexPointerPath(f.root, second.jobPath), 'utf8')).jobPath, second.jobPath);
});

test('changed job evidence invalidates publication recovery under the queue lock', async t => {
  const f = fixture(t); const stopped = stop(f);
  const proof = await proveStoppedPublication({ ...stopped, headSha: f.live, ciGate: f.ciGate, execFileImpl: f.execFileImpl, log });
  const job = { ...stopped.job, reviewBody: 'changed concurrently' };
  writeFollowUpJob(stopped.jobPath, job);
  assert.throws(() => requeueFollowUpJobForNextRound({ rootDir: f.root, jobPath: stopped.jobPath,
    revisionRef: f.live, publicationRecovery: proof }), /stopped:committed-unpublished/);
});

test('admission reuses the known live head and keeps the final GitHub head fence', async t => {
  const f = fixture(t); const stopped = stop(f);
  for (const moved of [false, true]) {
    let lookups = 0;
    const proof = await proveStoppedPublication({ ...stopped, headSha: f.live, ciGate: f.ciGate, log,
      execFileImpl: async (command, args, options) => {
        if (command === 'gh') {
          lookups += 1;
          return { stdout: moved ? `${f.local}\n` : `${f.live}\n` };
        }
        return f.execFileImpl(command, args, options);
      } });
    assert.equal(lookups, 1, 'only the final live-head recheck needs GitHub');
    if (moved) assert.equal(proof, null, 'a changed live head invalidates the supplied snapshot');
    else assert.equal(proof.headSha, f.live);
  }
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

test('concurrent admissions report in-place budget exhaustion using the reclassified job', async t => {
  const f = fixture(t); const stopped = stop(f, { cap: 1 });
  const snapshot = { ...stopped, job: readFollowUpJob(stopped.jobPath) };
  const warnings = [];
  let reads = 0;
  const latestJobFinder = (...args) => ++reads <= 2 ? snapshot : findLatestFollowUpJob(...args);
  const results = await Promise.all([admission(f, { latestJobFinder, log: { warn: line => warnings.push(line) } }),
    admission(f, { latestJobFinder, log: { warn: line => warnings.push(line) } })]);
  for (const result of results) {
    assert.equal(result.reason, 'ci-regression-stopped');
    assert.equal(result.needsOperator, true);
    assert.equal(result.jobPath, stopped.jobPath);
    assert.equal(result.job.remediationPlan.stop.code, 'max-rounds-reached');
    assert.equal(result.job.remediationPlan.currentRound, 1);
    assert.equal(result.job.remediationPlan.maxRounds, 1);
    assert.equal(result.job.publicationRecovery.headSha, f.live);
    assert.match(result.closureBlocker, /round-budget-exhausted \(1\/1\)/);
  }
  assert.doesNotMatch(warnings.join('\n'), /no longer exists|requeue failed/);
  assert.equal(readFollowUpJob(stopped.jobPath).remediationPlan.currentRound, 1);
});
