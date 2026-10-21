import './helpers/rate-limit-state-isolation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFollowUpJob, claimNextFollowUpJob, readFollowUpJob, markFollowUpJobSpawned, buildRemediationReply, reapTerminalFollowUpWorkspaces } from '../src/follow-up-jobs.mjs';
import { buildRemediationPrompt } from '../src/remediation-prompt-builder.mjs';
import { publishRemediation } from '../src/remediation-publication.mjs';
import { findCommittedUnpublishedWork } from '../src/remediation-unpublished.mjs';
import { pickAdversarialGateStatus } from '../src/adversarial-gate-status.mjs';
import { reconcileFollowUpJob } from '../src/follow-up-remediation.mjs';
import { spawnReviewer } from '../src/reviewer-spawn-settle.mjs';
import { queueFollowUpForRecoveredPostedReview } from '../src/reviewer-pass-reaper.mjs';
import { createAgentRuntimeReviewerRuntimeAdapter } from '../src/adapters/reviewer-runtime/agent-runtime/index.mjs';
import { readReviewerRunRecord } from '../src/adapters/reviewer-runtime/run-state.mjs';

const reviewBody = '## Summary\nFix the synthetic retry.\n\n## Verdict\nRequest changes';
const head = 'a'.repeat(40);
function root(t) {
  const rootDir = mkdtempSync(join(tmpdir(), 'remedbranch-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  return rootDir;
}
function input(t) {
  return { rootDir: root(t), repo: 'fixture/repo', prNumber: 42,
    reviewerModel: 'Gemini 3.8 Flash (High)', reviewBody, revisionRef: head, builderTag: 'codex' };
}

test('REMEDBRANCH-01: job creation resolves a missing branch with one fake PR read', t => {
  const options = input(t);
  let reads = 0;
  const result = createFollowUpJob({ ...options, branch: '  ', builderTag: null, readPRHeadImpl: identity => {
    reads++;
    assert.deepEqual(identity, { repo: 'fixture/repo', prNumber: 42 });
    return { branch: 'feature/retry', builderTag: 'codex' };
  } });
  assert.equal(reads, 1);
  assert.equal(result.job.branch, 'feature/retry');
  assert.equal(result.job.builderTag, 'codex');
  assert.equal(readFollowUpJob(result.jobPath).branchResolution, null);
});

test('REMEDBRANCH-01: unresolved head holds and retries without charging a round or returning a worker job', t => {
  const options = input(t);
  const result = createFollowUpJob({ ...options, readPRHeadImpl: () => { throw new Error('synthetic read unavailable'); } });
  assert.equal(result.job.branchResolution.reason, 'branch-unresolved');
  const retryAt = result.job.branchResolution.retryAfter;
  assert.equal(claimNextFollowUpJob({ rootDir: options.rootDir, claimedAt: retryAt,
    readPRHeadImpl: () => ({ branch: null }) }), null);
  const held = readFollowUpJob(result.jobPath);
  assert.equal(held.remediationPlan.currentRound, 0);
  assert.equal(held.status, 'pending');
  const claimed = claimNextFollowUpJob({ rootDir: options.rootDir,
    claimedAt: held.branchResolution.retryAfter, readPRHeadImpl: () => ({ branch: 'feature/retry' }) });
  assert.equal(claimed.job.branch, 'feature/retry');
  assert.equal(claimed.job.branchResolution, null);
});

test('REMEDBRANCH-01: a branchless legacy prompt gives the publisher PR identity without an empty branch flag', t => {
  const options = input(t);
  const { job } = createFollowUpJob({ ...options, readPRHeadImpl: () => ({ branch: null }) });
  const replyPath = join(options.rootDir, 'replies', 'reply.json');
  const prompt = buildRemediationPrompt(job, { template: 'Synthetic instructions.', remediationReplyPath: replyPath,
    hqRoot: options.rootDir, launchRequestId: 'fixture-launch' });
  assert.doesNotMatch(prompt, /--branch\s+''/u);
  assert.match(prompt, /--repo 'fixture\/repo' --pr '42'/u);
});

test('REMEDBRANCH-01: publisher hydrates a missing branch before Git and refuses unresolved evidence', async () => {
  for (const branch of ['feature/retry', null]) {
    const calls = [];
    await assert.rejects(publishRemediation({ baseBranch: 'main', previousHead: head, repo: 'fixture/repo', prNumber: 42,
      execFileImpl: async (command, args, options) => {
        calls.push({ command, args });
        if (command === 'gh') {
          assert.deepEqual(args, ['api', 'repos/fixture/repo/pulls/42']);
          assert.equal(options.timeout, 8000);
          return { stdout: JSON.stringify({ base: { ref: 'main' }, head: { ref: branch } }) };
        }
        assert.equal(branch, 'feature/retry');
        throw new Error('synthetic Git boundary reached');
      } }), branch ? /synthetic Git boundary/ : { code: 'remediation-publication-unproven' });
    assert.equal(calls.some(call => call.args.includes('push')), false);
    if (!branch) assert.equal(calls.length, 1);
  }
});

test('REMEDBRANCH-01: agent-runtime posted review retains subject branch and builder tag through pass recovery', async t => {
  const rootDir = root(t);
  const sessionUuid = 'synthetic-review-session';
  let metadata;
  mkdirSync(join(rootDir, 'prompts', 'code-pr'), { recursive: true });
  writeFileSync(join(rootDir, 'prompts', 'code-pr', 'reviewer.first.md'), 'Synthetic review instructions.');
  const adapter = createAgentRuntimeReviewerRuntimeAdapter({ rootDir,
    agentRuntime: { async run(request) { return { runRef: request.idempotencyKey, mode: 'os',
      async await() { return { status: 'completed', artifact: { body: reviewBody } }; }, async cancel() {} }; } },
    logger: { warn() {}, error() {} } });
  let posted = 0;
  const result = await spawnReviewer({ rootDir, repo: 'fixture/repo', prNumber: 42,
    reviewerModel: 'Gemini 3.8 Flash (High)', builderTag: 'codex', branch: 'feature/retry',
    reviewerHeadSha: head, reviewerSessionUuid: sessionUuid, reviewAttemptNumber: 1, reviewDbAttemptNumber: 1,
    reviewerRuntimeAdapterOverride: adapter, domainId: 'code-pr',
    readReviewerQuotaDecisionImpl: async () => ({ available: true }),
    beginReviewerPassImpl: (_root, pass) => { metadata = pass.metadata; },
    completeReviewerPassImpl: (_root, pass) => { metadata = { ...metadata, ...pass.metadata }; },
    readBestReviewerEvidenceTokenUsageImpl: async () => null,
    readDurablePostedAtImpl: () => null,
    fetchPullRequestHeadAndStateImpl: async () => ({ state: 'open', headRefOid: head }),
    postGitHubReviewWithCaptureImpl: async () => { posted++; },
  });
  assert.equal(result.ok, true);
  assert.equal(posted, 1);
  const record = readReviewerRunRecord(rootDir, sessionUuid);
  assert.equal(record.subjectContext.branch, 'feature/retry');
  assert.equal(record.subjectContext.builderTag, 'codex');
  const queued = queueFollowUpForRecoveredPostedReview({ rootDir,
    row: { repo: 'fixture/repo', pr_number: 42, reviewer_model: 'Gemini 3.8 Flash (High)',
      head_sha: head, body_md: reviewBody, metadata_json: JSON.stringify(metadata) },
    reviewPostedAt: '2026-01-01T00:00:00Z', resolveHandoffConfigImpl: () => ({ enabled: false }),
    readSingleReviewDecisionImpl: () => null });
  const job = readFollowUpJob(queued.jobPath);
  assert.equal(job.branch, 'feature/retry');
  assert.equal(job.builderTag, 'codex');
});

test('REMEDBRANCH-01: reported committed-unpublished work names job and retained local commit in the gate', async t => {
  const commitSha = 'b'.repeat(40);
  const job = { jobId: 'fixture-job', repo: 'fixture/repo', prNumber: 42, revisionRef: head,
    status: 'stopped', reviewBody, remediationPlan: { stop: { code: 'committed-unpublished' } } };
  job.unpublishedWork = await findCommittedUnpublishedWork({ job, workspaceDir: root(t),
    reply: { summary: 'Committed locally but the publisher refused publication.', operationalBlockers: [{ finding: 'Empty branch prevented publication.', commitSha }] },
    execFileImpl: async () => ({ stdout: `${commitSha}\n` }) });
  const decision = pickAdversarialGateStatus({ repo: job.repo, prNumber: job.prNumber,
    reviewRow: { review_status: 'posted', pr_state: 'open' }, latestJob: job });
  assert.equal(decision.reason, 'remediation-committed-unpublished');
  assert.match(decision.description, /fixture-job/u);
  assert.match(decision.description, new RegExp(commitSha));
  assert.equal(decision.operatorDecisionRequired, false);
  assert.equal(decision.state, 'failure');
});

test('REMEDBRANCH-01: reconciliation stops committed-unpublished at the round cap and retains its workspace', async t => {
  const options = input(t);
  const savedEnv = { ...process.env };
  t.after(() => { for (const key of ['HQ_ROOT', 'ADV_WITH_HQ_INTEGRATION', 'ADV_REPLIES_ROOT', 'AGENT_OS_DEPLOY_CHECKOUT']) {
    if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key];
  } });
  delete process.env.HQ_ROOT;
  delete process.env.ADV_WITH_HQ_INTEGRATION;
  process.env.AGENT_OS_DEPLOY_CHECKOUT = join(options.rootDir, 'deploy');
  process.env.ADV_REPLIES_ROOT = join(options.rootDir, 'replies');
  const commitSha = 'b'.repeat(40);
  const created = createFollowUpJob({ ...options, branch: 'feature/retry', maxRemediationRounds: 1 });
  const claimed = claimNextFollowUpJob({ rootDir: options.rootDir });
  const workspaceDir = join(options.rootDir, 'data', 'follow-up-jobs', 'workspaces', created.job.jobId);
  mkdirSync(workspaceDir, { recursive: true });
  const replyPath = join(options.rootDir, 'replies', created.job.jobId, 'remediation-reply.json');
  mkdirSync(join(options.rootDir, 'replies', created.job.jobId), { recursive: true });
  const reply = buildRemediationReply({ job: claimed.job, outcome: 'blocked',
    summary: 'Committed the validated retry fix locally; publisher refused publication.',
    validation: ['Synthetic validation passed.'], addressed: [], pushback: [], blockers: [],
    operationalBlockers: [{ title: 'publication-blocked', finding: 'The publisher command had an empty branch and refused publication.',
      reasoning: 'The fix remains committed locally for publication.', commitSha }], reReviewRequested: false });
  writeFileSync(replyPath, JSON.stringify(reply));
  const outputPath = join(workspaceDir, 'last-message.md');
  writeFileSync(outputPath, reply.summary);
  const spawned = markFollowUpJobSpawned({ rootDir: options.rootDir, jobPath: claimed.jobPath,
    worker: { processId: 12345, workspaceDir, outputPath, replyPath, model: 'codex' } });
  const result = await reconcileFollowUpJob({ rootDir: options.rootDir, job: spawned.job, jobPath: spawned.jobPath,
    isWorkerRunning: () => false, resolvePRLifecycleImpl: async () => null,
    execFileImpl: async () => ({ stdout: `${commitSha}\n` }),
    postCommentImpl: async () => ({ posted: true }), log: { log() {}, warn() {}, error() {} } });
  assert.equal(result.action, 'stopped', JSON.stringify(result.job.failure));
  assert.equal(result.job.remediationPlan.stop.code, 'committed-unpublished');
  assert.equal(result.job.unpublishedWork.commitSha, commitSha);
  assert.match(result.job.commentDelivery.body, new RegExp(commitSha));
  assert.match(result.job.remediationPlan.stop.reason, new RegExp(created.job.jobId));
  assert.doesNotMatch(result.job.remediationPlan.stop.reason, /operator decision required/u);
  let removed = false;
  const reaped = reapTerminalFollowUpWorkspaces({ rootDir: options.rootDir,
    workspaceRootDir: join(options.rootDir, 'data', 'follow-up-jobs', 'workspaces'),
    nowMs: Date.parse('2030-01-01T00:00:00Z'), ttlMs: 0,
    rmSyncImpl: () => { removed = true; } });
  assert.equal(reaped.scanned, 1);
  assert.equal(removed, false);
});
