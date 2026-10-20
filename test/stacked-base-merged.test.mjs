import './helpers/load-aware-timeout-fixture.mjs';
import { runDaemonCleanMergeAttempt } from '../src/daemon-clean-merge.mjs';
import { primaryChangeFixture } from './helpers/primary-change.mjs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
    else if (endpoint === `repos/${repo}/pulls/41`) data = { base: { ref: base, repo: { default_branch: defaultBranch } }, head: { ref: 'feature/child' } };
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

test('transient PR and parent-history failures recover within the bounded retry budget', async t => {
  const f = fixture(t);
  const attempts = new Map();
  const state = await inspectStackedBase({ ...f, execFileImpl: async (cmd, args) => {
    const count = (attempts.get(args[1]) || 0) + 1;
    attempts.set(args[1], count);
    if (count === 1) throw new Error('HTTP 503 Service Unavailable');
    return f.execFileImpl(cmd, args);
  } });
  assert.equal(state.reason, 'stacked-base-merged');
  assert.deepEqual([...attempts.values()], [2, 2]);
});

test('exhausted transient errors and permanent errors retain a read-failure hold', async t => {
  for (const [message, expectedAttempts] of [['HTTP 502 Bad Gateway', 3], ['HTTP 404 Not Found', 1]]) {
    const f = fixture(t);
    let attempts = 0;
    const held = await guardStackedBase({ ...f, execFileImpl: async () => {
      attempts++;
      throw new Error(message);
    } });
    assert.equal(held.reason, 'stacked-base-read-failed');
    assert.equal(attempts, expectedAttempts);
    assert.equal(f.comments.length, 0);
  }
});

test('a lost POST response is recovered from GitHub without duplicating the hold comment', async t => {
  const f = fixture(t);
  let posts = 0;
  const options = { ...f, execFileImpl: async (cmd, args) => {
    const result = await f.execFileImpl(cmd, args);
    if (args.includes('POST') && ++posts === 1) throw new Error('socket hang up');
    return result;
  } };
  assert.equal((await guardStackedBase(options)).reason, 'stacked-base-merged');
  assert.equal(posts, 1);
  assert.equal(f.comments.length, 1);
  await guardStackedBase(options);
  assert.equal(posts, 1, 'the durable receipt survives the lost POST response');
});

test('comment read and post transient failures recover without losing the delivery receipt', async t => {
  const f = fixture(t);
  const attempts = new Map();
  const options = { ...f, execFileImpl: async (cmd, args) => {
    if (args[1].endsWith('/comments')) {
      const key = args.includes('POST') ? 'post' : 'read';
      const count = (attempts.get(key) || 0) + 1;
      attempts.set(key, count);
      if (count === 1) throw new Error('TLS handshake timeout');
    }
    return f.execFileImpl(cmd, args);
  } };
  assert.equal((await guardStackedBase(options)).reason, 'stacked-base-merged');
  await guardStackedBase(options);
  assert.deepEqual(Object.fromEntries(attempts), { read: 3, post: 2 });
  assert.equal(f.comments.length, 1);
});

test('omitted root directory writes and clears the same hold receipt under cwd', async t => {
  const f = fixture(t);
  t.mock.method(process, 'cwd', () => f.rootDir);
  const { rootDir, ...options } = f;
  assert.equal((await guardStackedBase(options)).reason, 'stacked-base-merged');
  const retargeted = fixture(t, { base: 'trunk' });
  const { rootDir: retargetRoot, ...retargetOptions } = retargeted;
  assert.equal(await guardStackedBase(retargetOptions), null);
  const file = readdirSync(join(rootDir, 'data', 'stacked-base-holds')).find(name => name.endsWith('.json'));
  assert.equal(JSON.parse(readFileSync(join(rootDir, 'data', 'stacked-base-holds', file))).reason, null);
});

test('candidate hold returns a defined daemon disposition without attempting merge', async () => {
  const result = await runDaemonCleanMergeAttempt({ candidate: { stackedBaseHold: {
    reason: 'stacked-base-merged', skipMergeAgent: true,
  } }, guardStackedBaseImpl: () => assert.fail('candidate already owns hold evidence') });
  assert.equal(result.disposition, 'deferred');
  assert.equal(result.reason, 'stacked-base-merged');
});

test('hold persistence failures return the hold without posting or throwing', async t => {
  for (const failure of ['mkdir', 'write']) {
    const f = fixture(t);
    const warnings = [];
    if (failure === 'mkdir') {
      writeFileSync(join(f.rootDir, 'data'), 'directory unavailable');
    } else {
      const key = createHash('sha256').update(`${repo}#41`).digest('hex');
      mkdirSync(join(f.rootDir, 'data', 'stacked-base-holds', `${key}.json`), { recursive: true });
    }
    const result = await guardStackedBase({ ...f,
      execFileImpl: failure === 'write' ? async () => { throw new Error('API unavailable'); } : f.execFileImpl,
      logger: { warn: message => warnings.push(message) } });
    assert.equal(result.reason, failure === 'mkdir' ? 'stacked-base-merged' : 'stacked-base-read-failed');
    assert.equal(result.skipMergeAgent, true);
    assert.equal(result.recoveryWait, true);
    assert.equal(f.comments.length, 0);
    assert.equal(warnings.length, 1);
    assert.doesNotMatch(warnings[0], /readError=/, 'an unpersisted hold must not emit a state-change warning');
    assert.match(warnings.at(-1), /hold persistence failed/);
  }
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


for (const [name, output, reason] of [
  ['merged parent', 'stacked-base-merged', 'stacked-base-merged'],
  ['merged parent with persistence warning', 'Stacked base hold persistence failed: read-only filesystem\nstacked-base-merged\n\n', 'stacked-base-merged'],
  ['read failure with diagnostic', 'Warning: could not check stacked-base-merged\nstacked-base-read-failed', 'stacked-base-read-failed'],
  ['unclassified failure', 'Unexpected subprocess failure', 'stacked-base-read-failed'],
]) {
  test(`hammer rechecks after CI waits and defers ${name} without clicking merge`, () => {
    const source = readFileSync(new URL('../bin/hammer-merge.sh', import.meta.url), 'utf8');
    const start = source.indexOf('  # A parent PR can merge while this hammer waits on CI.');
    const end = source.indexOf('  HAM_MERGE_EXECUTED_AT=', start);
    assert.ok(start > 0 && end > start, 'live check must precede the actual merge click');
    const fragment = source.slice(start, end).replace(/<<[A-Z_]+>>/g, 'synthetic');
    const result = spawnSync('bash', ['-c', `
    HAM_NODE_BIN=refuse_base
    refuse_base() { printf '%s\n' "$STACKED_BASE_OUTPUT" >&2; return 20; }
    ham_append_terminal_audit() { echo "audit:$*"; }
    ham_release_merge_lease() { echo lease-released; }
    attempt_merge() { ${fragment}
 echo merge-clicked; }
    attempt_merge
    `], { encoding: 'utf8', timeout: 5_000, env: { ...process.env, STACKED_BASE_OUTPUT: output } });
    assert.ifError(result.error);
    assert.equal(result.status, 20);
    assert.equal(result.stdout, `audit:deferred ${reason}\nlease-released\n`);
    assert.equal(result.stderr, `${output.trimEnd()}\n`);
    assert.doesNotMatch(result.stdout, /merge-clicked/);
  });
}


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


for (const { name, candidateBase, liveBase, held } of [
  { name: 'non-default candidate base holds a merged parent',
    candidateBase: 'feature/parent', liveBase: 'feature/parent', held: true },
  { name: 'default candidate base re-reads a live merged parent before clicking',
    candidateBase: 'trunk', liveBase: 'feature/parent', held: true },
  { name: 'default candidate base merges after a safe live retarget',
    candidateBase: 'trunk', liveBase: 'trunk', held: false },
]) {
  test(`daemon clean merge: ${name}`, async t => {
    const f = fixture(t, { base: liveBase });
    const head = 'a'.repeat(40);
    let clicks = 0, released = 0;
    const checks = [{ name: 'synthetic-ci', conclusion: 'SUCCESS' }];
    const result = await runDaemonCleanMergeAttempt({
      rootDir: f.rootDir, repoPath: repo, prNumber: 41,
      cfg: { mergeMethod: 'squash', autonomousMergeExecutionEnabled: true, strictMode: true },
      candidate: { title: 'Synthetic change', baseBranch: candidateBase, defaultBranch: 'trunk', headSha: head,
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
      acquireMergeLeaseImpl: () => ({ acquired: true, lease: { repo, base: candidateBase, leaseId: 'synthetic-lease',
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
    if (held) {
      assert.equal(result.reason, 'stacked-base-merged');
      assert.equal(result.merged, false);
      assert.equal(clicks, 0);
      assert.equal(f.comments.length, 1);
    } else {
      assert.equal(result.merged, true, 'the same otherwise eligible PR merges after a safe retarget');
      assert.equal(clicks, 1);
    }
    assert.equal(f.calls.filter(args => args[1] === `repos/${repo}/pulls/41`).length, 1,
      'the click boundary reads the callback repository and PR regardless of the candidate base');
    assert.equal(released, 1);
  });
}

for (const mode of ['os', 'local']) {
  test(`recovered job default cannot hide a merged parent before ${mode} remediation`, async t => {
    const f = fixture(t, { defaultBranch: 'main' });
    // Seed the same transport's default cache as a previous poll would.
    const execFileImpl = async (cmd, args) => args[1] === `repos/${repo}/pulls/42`
      ? { stdout: JSON.stringify({ base: { ref: 'main', repo: { default_branch: 'main' } } }) }
      : f.execFileImpl(cmd, args);
    assert.equal((await inspectStackedBase({ repo, prNumber: 42, execFileImpl })).ok, true);
    createFollowUpJob({ rootDir: f.rootDir, jobId: `recovered-${mode}`, repo, prNumber: 41,
      baseBranch: 'main', reviewerModel: 'claude',
      createdAt: '2026-10-16T10:00:00Z', reviewBody: '## Verdict\nRequest changes',
      changedFiles: ['src/widget.mjs'], remediationPlan: { maxRounds: 2, currentRound: 0, rounds: [] } });
    const result = await consumeNextFollowUpJob({ ...f, execFileImpl,
      healthRouter: { getMode: () => mode }, promptTemplate: 'synthetic prompt',
      resolvePRLifecycleImpl: async () => ({ state: 'OPEN', source: 'live' }),
      spawnImpl: () => assert.fail('recovered stacked job cannot spawn remediation'),
      log: { log() {}, warn() {} } });
    assert.equal(result.reason, 'stacked-base-merged');
    assert.equal(result.job.status, 'stopped');
    assert.equal(result.job.remediationPlan.stop.code, 'stacked-base-merged');
    assert.equal(result.job.remediationWorker.state, 'never-spawned');
    assert.equal(f.comments.length, 1);
  });
}
