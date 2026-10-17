import { runDaemonCleanMergeAttempt } from '../src/daemon-clean-merge.mjs';
import { primaryChangeFixture } from './helpers/primary-change.mjs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guardStackedBase, inspectStackedBase } from '../src/ama/stacked-base.mjs';
import { maybeDispatchAmaCloser } from '../src/ama/dispatch-closer.mjs';
import { fetchMergeAgentCandidate } from '../src/merge-agent-candidate.mjs';
import { resolveMergeAgentCoexistenceForWatcher } from '../src/ama-closure-orchestration.mjs';
import { consumeNextFollowUpJob } from '../src/follow-up-remediation.mjs';
import { createFollowUpJob } from '../src/follow-up-jobs.mjs';

const repo = 'example/widget';
function fixture(t, { base = 'feature/parent', merged = true, fork = false, defaultBranch = 'trunk' } = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'stacked-base-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const calls = [], comments = [];
  const execFileImpl = async (cmd, args) => {
    calls.push(args);
    const endpoint = args[1];
    let data;
    if (args[0] === 'pr' && args[1] === 'view') data = { baseRefName: base, state: 'OPEN', labels: [], statusCheckRollup: [] };
    else if (endpoint === `repos/${repo}/pulls/41`) data = { base: { ref: base, repo: { default_branch: defaultBranch } } };
    else if (endpoint.startsWith(`repos/${repo}/pulls?`)) data = [{ merged_at: merged ? '2026-10-16T08:00:00Z' : null,
      head: { ref: base, repo: { full_name: fork ? 'contributor/widget' : repo } } }];
    else if (endpoint.endsWith('/comments')) {
      if (args.includes('POST')) comments.push({ body: args.find(arg => arg.startsWith('body=')).slice(5) });
      data = args.includes('POST') ? {} : [comments];
    } else if (endpoint.includes('/branches/')) throw new Error('no protection fixture');
    else throw new Error(`Unexpected fixture call: ${cmd} ${args.join(' ')}`);
    return { stdout: JSON.stringify(data), stderr: '' };
  };
  return { rootDir, repo, prNumber: 41, execFileImpl, calls, comments };
}

test('merged parent branch holds closer dispatch, persists reason and comments once across concurrent walks', async t => {
  const f = fixture(t);
  const call = () => maybeDispatchAmaCloser({ cfg: { enabled: true },
    prMetadata: { prNumber: 41 }, dispatchContext: { ...f, baseBranch: 'feature/parent' },
    execFileImpl: f.execFileImpl });
  const held = await Promise.all([call(), call()]);
  assert.ok(held.every(result => result.reason === 'stacked-base-merged' && result.skipMergeAgent));
  await call();
  assert.equal(f.comments.length, 1);
  assert.match(f.comments[0].body, /Rebase.*trunk.*retarget/s);
  assert.equal(f.calls.filter(args => args[0] === 'dispatch' || args[1] === 'merge').length, 0);
  const file = readdirSync(join(f.rootDir, 'data', 'stacked-base-holds')).find(name => name.endsWith('.json'));
  assert.equal(JSON.parse(readFileSync(join(f.rootDir, 'data', 'stacked-base-holds', file))).reason, 'stacked-base-merged');
});

test('live candidate carries the hold through coexistence without remediation or merge fallback', async t => {
  const f = fixture(t);
  const candidate = await fetchMergeAgentCandidate(repo, 41, f);
  assert.equal(candidate.stackedBaseHold?.reason, 'stacked-base-merged');
  const result = await resolveMergeAgentCoexistenceForWatcher({ ...f, repoPath: repo, candidate,
    maybeDispatchAmaClosureForImpl: () => assert.fail('held base cannot dispatch closure'),
    logger: { info() {}, warn() {} } });
  assert.equal(result.outcome, 'await-operator');
  assert.equal(result.amaClosureResult.reason, 'stacked-base-merged');
});

test('default branch, unmerged parent and same-named fork branches stay eligible; retarget releases hold', async t => {
  for (const options of [{ base: 'trunk' }, { merged: false }, { fork: true }]) {
    const f = fixture(t, options);
    assert.equal((await inspectStackedBase(f)).ok, true);
    assert.equal(f.comments.length, 0);
  }
  const f = fixture(t);
  assert.equal((await guardStackedBase(f)).reason, 'stacked-base-merged');
  const retargeted = fixture(t, { base: 'trunk' });
  assert.equal(await guardStackedBase({ ...retargeted, rootDir: f.rootDir }), null);
  const file = readdirSync(join(f.rootDir, 'data', 'stacked-base-holds')).find(name => name.endsWith('.json'));
  assert.equal(JSON.parse(readFileSync(join(f.rootDir, 'data', 'stacked-base-holds', file))).reason, null);
  assert.equal((await guardStackedBase(f)).reason, 'stacked-base-merged');
  assert.equal(f.comments.length, 1, 'restacking retains the original comment receipt');
  assert.equal(JSON.parse(readFileSync(join(f.rootDir, 'data', 'stacked-base-holds', file))).reason, 'stacked-base-merged');
});

test('unreadable base evidence fails closed without posting a retarget claim', async t => {
  const f = fixture(t);
  const held = await guardStackedBase({ ...f, execFileImpl: async () => { throw new Error('API unavailable'); } });
  assert.equal(held.reason, 'stacked-base-read-failed');
  assert.equal(held.needsOperator, false);
  assert.equal(f.comments.length, 0);
});

test('remediation stops before spawning on a merged parent branch', async t => {
  const f = fixture(t);
  createFollowUpJob({ rootDir: f.rootDir, jobId: 'synthetic-job', repo, prNumber: 41,
    baseBranch: 'feature/parent', branch: 'feature/child', reviewerModel: 'claude',
    createdAt: '2026-10-16T10:00:00Z', reviewBody: '## Verdict\nRequest changes',
    changedFiles: ['src/widget.mjs'], remediationPlan: { maxRounds: 2, currentRound: 0, rounds: [] } });
  const result = await consumeNextFollowUpJob({ ...f, promptTemplate: 'synthetic prompt',
    resolvePRLifecycleImpl: async () => ({ state: 'OPEN', source: 'live' }),
    spawnImpl: () => assert.fail('held base cannot spawn remediation'),
    postCommentImpl: () => assert.fail('shared retarget comment already owns delivery'),
    log: { log() {}, warn() {} } });
  assert.equal(result.reason, 'stacked-base-merged');
  assert.equal(result.job?.remediationWorker?.state, 'never-spawned');
  assert.equal(f.comments.length, 1);
});


test('hammer rechecks after CI waits and releases its lease without clicking merge', () => {
  const source = readFileSync(new URL('../bin/hammer-merge.sh', import.meta.url), 'utf8');
  const start = source.indexOf('  # A parent PR can merge while this hammer waits on CI.');
  const end = source.indexOf('  HAM_MERGE_EXECUTED_AT=', start);
  assert.ok(start > 0 && end > start, 'live check must precede the actual merge click');
  const fragment = source.slice(start, end).replace(/<<[A-Z_]+>>/g, 'synthetic');
  const result = spawnSync('bash', ['-c', `
    HAM_NODE_BIN=refuse_base
    refuse_base() { echo stacked-base-merged; return 20; }
    ham_append_terminal_audit() { echo "audit:$*"; }
    ham_release_merge_lease() { echo lease-released; }
    attempt_merge() { ${fragment}
 echo merge-clicked; }
    attempt_merge
  `], { encoding: 'utf8', timeout: 5_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 20);
  assert.match(result.stdout, /audit:failed-without-merge stacked-base-merged/);
  assert.match(result.stdout, /lease-released/);
  assert.doesNotMatch(result.stdout, /merge-clicked/);
});


test('merged-parent search follows pagination and bounds unreadable history', async t => {
  const f = fixture(t);
  const unmerged = Array.from({ length: 100 }, () => ({ merged_at: null }));
  const execFileImpl = async (cmd, args) => /[?&]page=1$/.test(args[1])
    ? { stdout: JSON.stringify(unmerged) } : f.execFileImpl(cmd, args);
  assert.equal((await inspectStackedBase({ ...f, execFileImpl })).reason, 'stacked-base-merged');
  assert.ok(f.calls.some(args => /[?&]page=2$/.test(args[1])));
  let pages = 0;
  const overBudget = async (cmd, args) => {
    if (args[1].includes('/pulls?')) { pages++; return { stdout: JSON.stringify(unmerged) }; }
    return f.execFileImpl(cmd, args);
  };
  assert.equal((await inspectStackedBase({ ...f, execFileImpl: overBudget })).reason, 'stacked-base-read-failed');
  assert.equal(pages, 10);
});


test('unreadable base evidence requeues remediation without spending its round', async t => {
  const f = fixture(t);
  createFollowUpJob({ rootDir: f.rootDir, repo, prNumber: 41,
    baseBranch: 'feature/parent', branch: 'feature/child', reviewerModel: 'claude',
    createdAt: '2026-10-16T10:00:00Z', reviewBody: '## Verdict\nRequest changes',
    changedFiles: ['src/widget.mjs'], remediationPlan: { maxRounds: 2, currentRound: 0, rounds: [] } });
  const result = await consumeNextFollowUpJob({ ...f, promptTemplate: 'synthetic prompt',
    now: () => '2026-10-16T11:00:00Z',
    execFileImpl: async () => { throw new Error('API unavailable'); },
    resolvePRLifecycleImpl: async () => ({ state: 'OPEN', source: 'live' }),
    spawnImpl: () => assert.fail('unreadable base cannot spawn remediation'),
    log: { log() {}, warn() {} } });
  assert.equal(result.reason, 'stacked-base-read-failed');
  assert.equal(result.job.status, 'pending');
  assert.equal(result.job.remediationPlan.currentRound, 0);
  assert.equal(result.job.remediationPlan.retryAfter, '2026-10-16T11:01:00.000Z');
});


test('an otherwise mergeable PR cannot click daemon merge into a merged parent branch', async t => {
  for (const base of ['feature/parent', 'trunk']) {
    const f = fixture(t, { base });
    const head = 'a'.repeat(40);
    let clicks = 0, released = 0;
    const checks = [{ name: 'synthetic-ci', conclusion: 'SUCCESS' }];
    const result = await runDaemonCleanMergeAttempt({
      rootDir: f.rootDir, repoPath: repo, prNumber: 41,
      cfg: { mergeMethod: 'squash', autonomousMergeExecutionEnabled: true, strictMode: true },
      candidate: { title: 'Synthetic change', baseBranch: base, headSha: head,
        statusCheckRollup: checks, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
        prState: 'open', labels: [], branchProtection: { requiredContexts: ['agent-os/adversarial-gate'] } },
      gateSnapshot: { reviewedHeadSha: head, settledReview: { verdict: 'comment-only' } },
      mergeabilityForGate: { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' },
      reviewState: { blockingFindingCount: 0, blockingFindingState: 'known',
        nonBlockingFindingCount: 0, nonBlockingFindingState: 'known' },
      reviewStateRow: { reviewer: 'codex' }, currentPrHeadSha: head,
      fetchPrimaryChangeImpl: async () => primaryChangeFixture(head),
      fetchRollupImpl: async () => ({ title: 'Synthetic change', state: 'OPEN', headRefOid: head,
        checks, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', labels: [] }),
      acquireMergeLeaseImpl: () => ({ acquired: true, lease: { repo, base, leaseId: 'synthetic-lease',
        holderPr: 41, holderHead: head, acquiredAt: '2026-10-16T10:00:00Z' } }),
      releaseMergeLeaseImpl: () => { released++; },
      readBuildCompletionSignalForPrImpl: () => ({ ok: true,
        row: { launch_request_id: 'lrq-synthetic', worker_class: 'codex', head_sha: head } }),
      readHeadAttestationChainForPrImpl: async () => [],
      dismissStaleRequestChangesOnResolved: false,
      execFileImpl: async (cmd, args) => {
        if (args[0] === 'pr' && args[1] === 'merge') { clicks++; return { stdout: '', stderr: '' }; }
        return f.execFileImpl(cmd, args);
      },
      env: { HQ_ROOT: f.rootDir }, logger: { log() {}, warn() {} },
    });
    if (base === 'feature/parent') {
      assert.equal(result.reason, 'stacked-base-merged');
      assert.equal(result.merged, false);
      assert.equal(clicks, 0);
      assert.equal(f.comments.length, 1);
    } else {
      assert.equal(result.merged, true, 'the same otherwise eligible PR merges after a safe retarget');
      assert.equal(clicks, 1);
    }
    assert.equal(released, 1);
  }
});
