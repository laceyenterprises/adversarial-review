import './helpers/rate-limit-state-isolation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reconcileFollowUpJob } from '../src/follow-up-remediation.mjs';
import { getFollowUpJobDir, writeFollowUpJob } from '../src/follow-up-jobs.mjs';
import { ensureReviewStateSchema, getReviewRow, openReviewStateDb, requestReviewRereview } from '../src/review-state.mjs';
import { findFinalRemediationPushJob, isCompletedFinalRemediationJob } from '../src/comment-only-final-round.mjs';
import { FINAL_ROUND_PROOF_TRANSIENT_WINDOW_MS } from '../src/comment-only-final-round-completion.mjs';
import { readCompletedRemediationRounds } from '../src/ama/hammer-head-validation.mjs';
import { readHeadAttestationChainForPr, resolveDaemonWorkerIdentityFromHeadAttestation } from '../src/daemon-worker-identity.mjs';
import incident from './fixtures/commentclose-01/pr-11403-final-fix-all.json' with { type: 'json' };

const HEAD = incident.priorWrapper.completion.workerPushedHeadSha;
const BASE = 'a'.repeat(40);
const REPLAYED = '63f56b58e8e946dc8f9859da28da7b9cc2a63301';
const LRQ = 'lrq_native_fixture';
const quiet = { log() {}, warn() {}, error() {} };

async function replay(t, { checks = 'green', changeReply = () => {}, valid = true, produced = true,
  extraCommit = false, moved = false, reviewerLive = false, attestationReadError = () => null,
  changeAttestations = rows => rows, changeWorkspace = manifest => manifest,
  workerStatus = 'succeeded', liveState = 'open', requireVerifierPath = false,
  transientSince, reviewBody = incident.job.reviewBody } = {}) {
  const rootDir = realpathSync(mkdtempSync(join(tmpdir(), 'lac2318-')));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const previous = process.env.HQ_ROOT;
  process.env.HQ_ROOT = rootDir;
  t.after(() => { if (previous === undefined) delete process.env.HQ_ROOT; else process.env.HQ_ROOT = previous; });
  if (requireVerifierPath) {
    const verifyEnv = {
      AGENT_OS_ROOT: join(rootDir, 'deployed-agent-os'),
      AGENT_OS_HEAD_ATTESTATION_HMAC_KEY_FILE: undefined,
      AGENT_OS_HEAD_ATTESTATION_HMAC_KEY_V1: undefined,
    };
    for (const [key, value] of Object.entries(verifyEnv)) {
      const prior = process.env[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
      t.after(() => { if (prior === undefined) delete process.env[key]; else process.env[key] = prior; });
    }
  }
  const job = { ...structuredClone(incident.job), status: 'in_progress', reviewBody };
  delete job.completedAt;
  if (transientSince) job.finalRoundProofTransient = { since: transientSince, attempts: 3 };
  const slot = join(rootDir, 'workers', 'native-fixture');
  const workspace = join(slot, 'repo');
  mkdirSync(join(workspace, '.git'), { recursive: true });
  const replyDir = join(rootDir, 'dispatch', 'remediation-replies', job.jobId);
  mkdirSync(replyDir, { recursive: true });
  const replyPath = join(replyDir, 'remediation-reply.json');
  const reply = structuredClone(incident.reply);
  changeReply(reply);
  writeFileSync(replyPath, JSON.stringify(reply));
  job.remediationWorker = { dispatchMode: 'hq', dispatchId: LRQ, launchRequestId: LRQ,
    hqRoot: rootDir, hqOwnerUser: 'fixture-owner', custodyRepo: 'agent-os', custodyBranch: job.branch,
    ticketRef: job.jobId, workerClass: 'codex', state: 'spawned', requiresProducedAttestation: true,
    spawnedAt: job.remediationPlan.rounds[0].spawnedAt, replyPath };
  writeFileSync(join(slot, 'workspace.json'), JSON.stringify(changeWorkspace({ workerId: 'native-fixture', hqRoot: rootDir,
    worktreePath: workspace, launchRequestId: LRQ, workerClass: 'codex', ownerUser: 'fixture-owner',
    ticketRef: job.jobId, repo: 'agent-os', branch: job.branch, expectedCompletionShape: 'branch-push' })));
  const jobPath = join(getFollowUpJobDir(rootDir, 'inProgress'), `${job.jobId}.json`);
  writeFollowUpJob(jobPath, job);
  const db = openReviewStateDb(rootDir);
  t.after(() => db.close());
  ensureReviewStateSchema(db);
  const readRow = () => getReviewRow(db, { repo: job.repo, prNumber: job.prNumber });
  db.prepare(`INSERT INTO reviewed_prs
    (repo, pr_number, domain_id, subject_external_id, reviewer, pr_state, review_status, review_attempts, reviewed_at,
      revision_ref, reviewer_head_sha, reviewer_pgid, reviewer_session_uuid, reviewer_lease_expires_at)
    VALUES (?, ?, 'code-pr', ?, 'gemini', 'open', ?, 1, ?, ?, ?, ?, ?, ?)`)
    .run(job.repo, job.prNumber, `${job.repo}#${job.prNumber}`,
      reviewerLive ? 'reviewing' : 'posted', incident.job.completedAt, HEAD,
      reviewerLive ? HEAD : job.revisionRef, reviewerLive ? process.pid : null,
      reviewerLive ? 'fixture-live-session' : null, reviewerLive ? '2026-11-22T07:32:00Z' : null);
  const beforeRow = readRow();
  const requests = [], wakes = [], comments = [];
  let liveReads = 0;
  let attestationReads = 0;
  const execFileImpl = async (bin, args, options) => {
    if (args[0] === 'attest') {
      const failure = attestationReadError(++attestationReads);
      if (failure) throw failure;
      assert.deepEqual(args, ['attest', 'chain', '--root', rootDir, '--repo', job.repo, '--pr', String(job.prNumber), '--json']);
      if (requireVerifierPath && options.env.AGENT_OS_HEAD_ATTESTATION_HMAC_KEY_FILE !==
        join(process.env.AGENT_OS_ROOT, '.secrets/local/head-attestation-hmac-key-v1')) {
        throw new Error('hq attest: error: AGENT_OS_HEAD_ATTESTATION_HMAC_KEY_V1 must provide at least 32 secret bytes');
      }
      return { stdout: JSON.stringify(changeAttestations(produced ? [
        { kind: 'produced', valid, repo: job.repo, pr_number: job.prNumber, head_sha: HEAD,
          parent_head_sha: job.revisionRef, payload: { source: 'hq_branch_push', branch: job.branch,
            launch_request_id: LRQ, worker_class: 'codex' }, attestation_id: 'lha_fixture', ts: '2026-11-22T07:30:00Z' },
      ] : [])) };
    }
    if (args[0] === 'dispatch' && args[1] === 'status') return { stdout: JSON.stringify({
      status: workerStatus, dispatchId: LRQ, launchRequestId: LRQ, ticketRef: job.jobId,
      workerRunId: 'wrun_fixture', workspacePath: workspace, repo: workspace,
    }) };
    if (bin === 'git') {
      const cmd = args[args.indexOf('-C') + 2];
      if (cmd === 'config') return { stdout: `git@github.com:${job.repo}.git` };
      if (cmd === 'rev-parse') return { stdout: args.includes('--show-toplevel') ? workspace
        : args.some(arg => arg.startsWith('origin/')) ? BASE : HEAD };
      if (cmd === 'show') return { stdout: 'Add failure coverage\n\nWorker-Class: codex\n' };
      if (cmd === 'rev-list') return { stdout: '' };
      if (cmd === 'cherry') return { stdout: args.at(-1) === BASE
        ? `- ${REPLAYED}\n+ ${HEAD}\n${extraCommit ? `+ ${'c'.repeat(40)}\n` : ''}`
        : `- ${job.revisionRef}\n` };
    }
    if (bin === 'gh' && args[0] === 'api') {
      if (args[1].includes('/git/ref/heads/')) return { stdout: JSON.stringify({
        ref: `refs/heads/${job.branch}`, object: { type: 'commit', sha: HEAD },
      }) };
      if (args[1].endsWith(`/pulls/${job.prNumber}`)) return { stdout: JSON.stringify({
        number: job.prNumber, state: liveState, head: { sha: ++liveReads > 1 && moved ? 'd'.repeat(40) : HEAD,
          ref: job.branch, repo: { full_name: job.repo } }, base: { ref: 'main', repo: { full_name: job.repo } },
      }) };
    }
    assert.fail(`Unexpected fixture command ${bin} ${args.join(' ')}`);
  };
  const reconcile = async job => reconcileFollowUpJob({ rootDir, job, jobPath, now: () => incident.job.completedAt,
    execFileImpl, log: quiet, workerTerminalEvent: workerStatus === 'succeeded' ? { lrq: LRQ, status: 'succeeded' } : null,
    resolvePRLifecycleImpl: async () => ({ source: 'live', headSha: workerStatus === 'succeeded' ? HEAD : job.revisionRef,
      prState: 'open', mergeable: 'MERGEABLE' }),
    auditWorkspaceForContaminationImpl: async () => ({ suspect: [], error: null }),
    inspectRemediationCiRegressionImpl: async () => ({ headSha: HEAD, state: checks }),
    requestReviewRereviewImpl: input => { requests.push(input); return requestReviewRereview({ ...input, logger: quiet }); },
    requestWatcherWakeImpl: input => wakes.push(input), requestRereviewWakeImpl: () => ({}),
    postCommentImpl: async ({ body }) => { comments.push(body); return { posted: false }; },
  });
  const result = await reconcile(job);
  return { rootDir, result, reconcile, requests, wakes, comments, beforeRow, afterRow: readRow(), attestationReads };
}

test('native follow-up reads its canonical branch-push receipt and records the replay edge', async t => {
  const { rootDir, result, requests, beforeRow, afterRow } = await replay(t, { requireVerifierPath: true });
  assert.equal(result.action, 'completed');
  assert.equal(result.job.completion.workerPushProof.producedAttestationId, 'lha_fixture');
  const edges = await readCompletedRemediationRounds(rootDir, result.job.repo, result.job.prNumber);
  assert.deepEqual(edges.map(({ startHeadSha, resultingHeadSha }) => [startHeadSha, resultingHeadSha]),
    [[result.job.revisionRef, HEAD]]);
  assert.deepEqual(requests, []);
  assert.deepEqual(afterRow, beforeRow);
});

for (const repo of [undefined, null, 42, {}]) test(`exact attestation subject refuses ${JSON.stringify(repo)} repository input`, async () => {
  const result = await resolveDaemonWorkerIdentityFromHeadAttestation({
    repo, prNumber: 42, currentHeadSha: HEAD, requireExactSubject: true,
    readHeadAttestationChainForPrImpl: async () => [{
      kind: 'produced', valid: true, repo: 'fixture/repo', pr_number: 42, head_sha: HEAD,
    }],
  });
  assert.deepEqual(result, { ok: false, reason: 'produced-attestation-subject-mismatch' });
});

test('native follow-up accepts a numeric-string attestation PR and records the replay edge', async t => {
  const { rootDir, result } = await replay(t, {
    changeAttestations: ([row]) => [{ ...row, pr_number: String(row.pr_number) }],
  });
  assert.equal(result.action, 'completed');
  const edges = await readCompletedRemediationRounds(rootDir, result.job.repo, result.job.prNumber);
  assert.deepEqual(edges.map(({ startHeadSha, resultingHeadSha }) => [startHeadSha, resultingHeadSha]),
    [[result.job.revisionRef, HEAD]]);
});

for (const [prNumber, producedPrNumber] of [
  [42, '43'], [42, 'invalid'], [42, null], [42, [42]], [1, true],
  [0, ''], [null, null], [-1, '-1'], [1.5, '1.5'],
]) test(`exact attestation subject refuses PR ${JSON.stringify(prNumber)} / ${JSON.stringify(producedPrNumber)}`, async () => {
  const result = await resolveDaemonWorkerIdentityFromHeadAttestation({
    repo: 'fixture/repo', prNumber, currentHeadSha: HEAD, requireExactSubject: true,
    readHeadAttestationChainForPrImpl: async () => [{
      kind: 'produced', valid: true, repo: 'fixture/repo', pr_number: producedPrNumber, head_sha: HEAD,
    }],
  });
  assert.deepEqual(result, { ok: false, reason: 'produced-attestation-subject-mismatch' });
});

for (const workerStatus of ['running', 'unknown']) test(`native follow-up leaves a ${workerStatus} worker active`, async t => {
  const { rootDir, result, attestationReads, requests } = await replay(t, { workerStatus });
  assert.equal(result.action, 'active');
  assert.equal(attestationReads, 0);
  assert.deepEqual(requests, []);
  assert.deepEqual(await readCompletedRemediationRounds(rootDir, result.job.repo, result.job.prNumber), []);
});

test('canonical chain read preserves an explicit verifier and the configured ledger target', async () => {
  const env = { AGENT_OS_ROOT: '/fixture/deploy',
    AGENT_OS_HEAD_ATTESTATION_HMAC_KEY_FILE: '/fixture/private/configured-verifier',
    AGENT_OS_SESSION_LEDGER_TARGET: 'fixture-target' };
  const rows = await readHeadAttestationChainForPr({ repo: 'fixture/repo', prNumber: 1, env, useDeployVerifier: true,
    execFileImpl: async (_bin, _args, options) => {
      assert.deepEqual(options.env, env);
      return { stdout: '[]' };
    } });
  assert.deepEqual(rows, []);
});

for (const checks of ['green', 'pending']) test(`PR 11403 final fix-all keeps closure with ${checks} on the published head`, async t => {
  const { rootDir, result, requests, wakes, comments, beforeRow, afterRow } = await replay(t, { checks });
  assert.equal(result.action, 'completed');
  assert.deepEqual(requests, []);
  assert.equal(result.job.reReview.requested, false);
  assert.equal(result.job.reReview.nextAction.action, checks === 'green' ? 'hammer' : 'wait-for-CI');
  assert.equal(result.job.reReview.nextAction.head, HEAD);
  assert.equal(result.job.completion.finalRemediationPush, true);
  assert.deepEqual(result.job.completion.workerPushProof, { method: 'git-cherry-replay',
    reviewedCommitsReplayed: 1, workerCommits: 1, producedAttestationId: 'lha_fixture' });
  assert.equal(result.job.remediationPlan.prRound.number, 3);
  assert.equal(result.job.reviewBody, incident.job.reviewBody);
  assert.deepEqual(result.job.remediationReply.payload, incident.reply);
  assert.deepEqual(afterRow, beforeRow);
  assert.match(comments[0], /final fix-all round 1 of 1 \(PR round 3\)/);
  assert.equal(comments[0].includes('**Informational wait.** Owner: CI.'), checks === 'pending');
  assert.doesNotMatch(comments[0], /3 of 2|stale-verdict|Re-review status:.*queued/);
  assert.equal(wakes.length, 1);
  assert.ok(findFinalRemediationPushJob(rootDir, { ...incident.job, headSha: HEAD }));
  assert.equal(findFinalRemediationPushJob(rootDir, { ...incident.job, headSha: 'd'.repeat(40) }), null);
  const corrupt = structuredClone(result.job);
  delete corrupt.completion.workerPushProof.workerCommits;
  assert.equal(isCompletedFinalRemediationJob(corrupt), false);
});

test('PR 11403 replay preserves an already live reviewer claim', async t => {
  const { result, requests, beforeRow, afterRow } = await replay(t, { reviewerLive: true });
  assert.equal(result.action, 'completed');
  assert.deepEqual(requests, []);
  assert.deepEqual(afterRow, beforeRow);
  assert.equal(result.job.reReview.nextAction.reason, 'live-owner');
  assert.equal(result.job.reReview.nextAction.actor, 'reviewer');
});

test('PR 11403 replay retries a brief attestation read failure', async t => {
  const { result, requests, attestationReads } = await replay(t, {
    attestationReadError: attempt => attempt === 1 ? new Error('database is locked') : null,
  });
  assert.equal(attestationReads, 2);
  assert.equal(result.action, 'completed');
  assert.equal(result.job.completion.workerPushProof.producedAttestationId, 'lha_fixture');
  assert.deepEqual(requests, []);
});

test('PR 11403 replay keeps custody across ticks when attestation reads stay transient', async t => {
  const { result, reconcile, requests, wakes, attestationReads } = await replay(t, {
    attestationReadError: attempt => attempt <= 3 ? Object.assign(new Error('read failed'), { code: 'ETIMEDOUT' }) : null,
  });
  assert.equal(attestationReads, 3);
  assert.equal(result.action, 'active');
  assert.equal(result.reason, 'final-round-proof-transient');
  assert.equal(result.job.status, 'in_progress');
  assert.equal(result.job.finalRoundProofTransient.attempts, 3);
  assert.equal(result.job.finalRoundProofTransient.error, 'head-attestation-chain-read-failed');
  assert.deepEqual(wakes, []);
  assert.equal((await reconcile(result.job)).action, 'completed');
  assert.deepEqual(requests, []);
});

test('PR 11403 replay withholds publication after the transient proof window', async t => {
  const { result, wakes, attestationReads } = await replay(t, {
    transientSince: new Date(Date.now() - FINAL_ROUND_PROOF_TRANSIENT_WINDOW_MS).toISOString(),
    attestationReadError: () => new Error('database is locked'),
  });
  assert.equal(attestationReads, 3);
  assert.equal(result.action, 'stopped');
  assert.equal(result.job.completion.finalRoundOutcome.push, 'head-attestation-chain-read-failed');
  assert.equal(result.job.completion.withheldPushHeadSha, HEAD);
  assert.deepEqual(wakes, []);
});

test('PR 11403 legacy completed receipt does not establish exact-head custody', t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'lac2318-legacy-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const job = { ...incident.job, ...incident.priorWrapper, status: 'completed',
    completion: { ...incident.priorWrapper.completion, finalRemediationPush: true },
    reReview: { requested: false, nextAction: { action: 'wait-for-CI', head: HEAD } } };
  writeFollowUpJob(join(getFollowUpJobDir(rootDir, 'completed'), `${job.jobId}.json`), job);
  assert.equal(isCompletedFinalRemediationJob(job), false);
  assert.equal(findFinalRemediationPushJob(rootDir, { ...job, headSha: HEAD }), null);
});

for (const [name, input] of [
  ['omitted advisory', { changeReply: reply => { reply.nonBlocking = []; } }],
  ['partial reply without a corroborated wait', { changeReply: reply => { reply.operationalBlockers = []; } }],
  ['unverified dispute', { changeReply: reply => {
    const [{ title, finding }] = reply.nonBlocking;
    reply.nonBlocking = [];
    reply.pushback = [{ title, finding, reasoning: 'This test is unnecessary.' }];
  } }],
  ['operator-only CI decline', {
    reviewBody: incident.job.reviewBody.replace(/- \*\*Recommended fix:\*\* .*/,
      '- **Recommended fix:** Add a required CI check for directory failures.'),
    changeReply: reply => {
      const [{ title }] = reply.nonBlocking;
      reply.nonBlocking = [];
      reply.pushback = [{ title, finding: 'Add a required CI check.', reasoning: 'declined: CI changes are operator-only' }];
    },
  }],
  ['human-owned blocker', { changeReply: reply => {
    reply.operationalBlockers[0].needsHumanInput = 'Approve access to a required signing key.';
  } }],
  ['missing produced attestation', { produced: false }],
  ['invalid produced attestation', { valid: false }],
  ['permanent attestation read failure', { attestationReadError: () => new Error('permission denied') }],
  ['receipt from a different repository', { changeAttestations: ([row]) => [{ ...row, repo: 'other/repo' }] }],
  ['receipt from a different PR', { changeAttestations: ([row]) => [{ ...row, pr_number: row.pr_number + 1 }] }],
  ['receipt for a different head', { changeAttestations: ([row]) => [{ ...row, head_sha: 'e'.repeat(40) }] }],
  ['receipt from another launch', { changeAttestations: ([row]) => [{ ...row, payload: { ...row.payload, launch_request_id: 'lrq_other' } }] }],
  ['newer competing publication custody', { changeAttestations: ([row]) => [row, { ...row, ts: '2026-11-22T07:30:01Z',
    attestation_id: 'lha_other', payload: { ...row.payload, launch_request_id: 'lrq_other' } }] }],
  ['workspace for another launch', { changeWorkspace: manifest => ({ ...manifest, launchRequestId: 'lrq_other' }) }],
  ['closed source PR', { liveState: 'closed' }],
  ['unknown source PR state', { liveState: 'unknown' }],
  ['foreign added commit', { extraCommit: true }],
  ['head changes during proof', { moved: true }],
]) test(`PR 11403 replay refuses closure custody with ${name}`, async t => {
  const { rootDir, result, requests, wakes } = await replay(t, input);
  assert.equal(result.action, 'stopped');
  assert.deepEqual(requests, []);
  assert.deepEqual(wakes, []);
  assert.equal(result.job.completion.finalRemediationPush, false);
  assert.deepEqual(await readCompletedRemediationRounds(rootDir, result.job.repo, result.job.prNumber), []);
  assert.equal(findFinalRemediationPushJob(rootDir, { ...incident.job, headSha: HEAD }), null);
});
