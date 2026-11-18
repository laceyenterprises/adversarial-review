import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activeRemediationStopDecision } from '../src/follow-up-lifecycle.mjs';
import { cancelHqDispatch } from '../src/remediation-hq-dispatch.mjs';

const exec = promisify(execFile);
const refusal = 'cancel requires authenticated actor identity (set HQ_PARENT_SESSION via `hq self` or HQ_OPERATOR_PRINCIPAL)';
const worker = { dispatchMode: 'hq', dispatchId: 'lrq_owned', launchRequestId: 'lrq_owned',
  workerClass: 'remediator-codex', hqRoot: '/fixture/hq', hqParentSession: 'session:fixture:submitter' };

// Models cli_watch._resolve_cancel_actor and watch.cancel_dispatch's separate
// requested_auth_owner fence. No live HQ command, identity lookup or DB access.
async function mockCancel(_bin, args, { env }) {
  const actor = env.HQ_OPERATOR_PRINCIPAL || env.HQ_PARENT_SESSION;
  const reason = !actor ? refusal : env.USER !== 'fixture-owner' ? 'cross-owner cancel is not authorized' : null;
  assert.equal(args.includes('--as-owner'), false);
  if (reason) throw Object.assign(new Error('cancel refused'), { code: 1, stdout: JSON.stringify({ ok: false, reason }) });
  return { stdout: JSON.stringify({ ok: true, cancelApplied: true, actor }) };
}

test('LAC-2218 missing cancellation actor reproduces HQ refusal without inventing identity', async () => {
  const result = await cancelHqDispatch({ worker: { ...worker, hqParentSession: undefined },
    env: { USER: 'fixture-owner' }, execFileImpl: mockCancel });
  assert.equal(result.cancelled, false);
  assert.equal(result.attempts, 1);
  assert.equal(JSON.parse(result.stdout).reason, refusal);
});

test('LAC-2218 accepted submitting session crosses cancel boundary; owner fence and explicit actors survive', async () => {
  for (const explicit of [{}, { HQ_PARENT_SESSION: 'session:fixture:current' }, { HQ_OPERATOR_PRINCIPAL: 'operator:fixture' }]) {
    const result = await cancelHqDispatch({ worker, env: { USER: 'fixture-owner', ...explicit }, execFileImpl: mockCancel });
    assert.equal(result.cancelled, true);
    assert.equal(JSON.parse(result.stdout).actor, explicit.HQ_OPERATOR_PRINCIPAL || explicit.HQ_PARENT_SESSION || worker.hqParentSession);
  }
  const denied = await cancelHqDispatch({ worker, env: { USER: 'other-owner' }, execFileImpl: mockCancel });
  assert.equal(denied.cancelled, false);
  assert.match(denied.stdout, /cross-owner/);
});

function repository(t) {
  const dir = mkdtempSync(join(tmpdir(), 'lac-2218-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'core.hooksPath', '/dev/null');
  const commit = value => { writeFileSync(join(dir, 'source'), value); git('add', 'source'); git('commit', '-m', value); return git('rev-parse', 'HEAD'); };
  const reviewed = commit('reviewed');
  return { dir, git, commit, reviewed };
}

function decision(repo, headSha, execFileImpl, liveness = { state: 'active' }) {
  return activeRemediationStopDecision({
    lifecycle: { source: 'live', prState: 'open', headSha }, liveness,
    job: { repo: 'fixture/project', prNumber: 1, revisionRef: repo.reviewed, remediationWorker: worker },
    rootDir: repo.dir, execFileImpl,
    parseHqWorkerWorkspaceFromPayloadImpl: () => repo.dir,
  });
}

test('LAC-2218 controlled lifecycle/read/rewrite interleavings preserve both own pushes before attestation visibility', async t => {
  const repo = repository(t);
  const firstPush = repo.commit('first published');
  const secondPush = repo.commit('second published');
  // Each pass starts with the published tip. After the lifecycle observation,
  // the worker replaces its history before the monitor reads HEAD ancestry.
  // No sleeps, network, timers or final publication attestation are involved.
  const staleClassifications = [];
  for (const published of [firstPush, secondPush]) {
    for (let run = 0; run < 20; run += 1) {
      repo.git('reset', '--hard', published);
      let rewrote = false;
      const stop = await decision(repo, published, async (bin, args, options) => {
        assert.equal(bin, 'git', 'history must protect custody while attestation is not yet visible');
        if (args.includes('merge-base') && args.at(-1) === 'HEAD') {
          repo.git('reset', '--hard', repo.reviewed);
          repo.commit(`rewritten ${published} ${run}`);
          rewrote = true;
        }
        return exec(bin, args, options);
      });
      assert.equal(rewrote, true);
      if (stop) staleClassifications.push({ published, run, stopCode: stop.stopCode });
    }
  }
  assert.deepEqual(staleClassifications, [], 'all 40 own-publication interleavings must retain custody');
});

test('LAC-2218 external absent/fetched heads cancel; exact owner attestations protect non-ancestral publication', async t => {
  const repo = repository(t);
  repo.commit('owned');
  const own = repo.git('rev-parse', 'HEAD');
  // An external object is fetched into a remote ref, never checked out by the worker.
  const tree = repo.git('rev-parse', 'HEAD^{tree}');
  const external = repo.git('commit-tree', tree, '-p', repo.reviewed, '-m', 'external');
  repo.git('update-ref', 'refs/remotes/origin/external', external);
  for (const head of ['f'.repeat(40), external]) {
    for (const rows of [[], [{ kind: 'produced', valid: false, head_sha: head }],
      [{ kind: 'produced', valid: true, head_sha: head, payload: { launch_request_id: 'lrq_other', worker_class: worker.workerClass } }]]) {
      const stop = await decision(repo, head, (bin, args, options) => bin === 'git' ? exec(bin, args, options)
        : Promise.resolve({ stdout: JSON.stringify(rows) }));
      assert.equal(stop?.stopCode, 'stale-review-head');
    }
  }
  // Exact produced receipts can also establish publication from an authorized
  // native publisher whose commit is not in the current workspace's history.
  for (const head of ['e'.repeat(40), external]) {
    const stop = await decision(repo, head, (bin, args, options) => bin === 'git' ? exec(bin, args, options)
      : Promise.resolve({ stdout: JSON.stringify([{ kind: 'produced', valid: true, head_sha: head,
        payload: { launch_request_id: worker.launchRequestId, worker_class: worker.workerClass } }]) }));
    assert.equal(stop, null);
  }
  assert.equal(await decision(repo, own, exec), null);
  assert.equal(await decision(repo, external, async () => { throw new Error('must not inspect or cancel terminal worker'); },
    { state: 'exited' }), null);
});

test('LAC-2218 checks 128 reflog tips with one graph query and retains ancestors of replaced tips', async t => {
  const repo = repository(t);
  const tree = repo.git('rev-parse', 'HEAD^{tree}');
  const published = repo.git('commit-tree', tree, '-p', repo.reviewed, '-m', 'published ancestor');
  const tips = Array.from({ length: 128 }, (_, i) =>
    repo.git('commit-tree', tree, '-p', i === 127 ? published : repo.reviewed, '-m', `tip ${i}`));
  const external = repo.git('commit-tree', tree, '-p', repo.reviewed, '-m', 'external');
  for (const head of [external, published]) {
    const graphCalls = [];
    const stop = await decision(repo, head, (bin, args, options) => {
      if (bin !== 'git') return Promise.resolve({ stdout: '[]' });
      if (args.includes('reflog')) return Promise.resolve({ stdout: tips.join('\n') });
      if (args.includes('rev-list') || (args.includes('merge-base') && args.at(-1) !== 'HEAD')) {
        graphCalls.push({ args, options });
      }
      return exec(bin, args, options);
    });
    assert.equal(stop?.stopCode ?? null, head === external ? 'stale-review-head' : null);
    assert.equal(graphCalls.length, 1, 'the full reflog must use a single graph traversal');
    assert.ok(graphCalls[0].options.timeout > 0 && graphCalls[0].options.timeout <= 5000);
  }
});

test('LAC-2218 failed batched history query retains custody', async t => {
  const repo = repository(t);
  const tree = repo.git('rev-parse', 'HEAD^{tree}');
  const external = repo.git('commit-tree', tree, '-p', repo.reviewed, '-m', 'external');
  const stop = await decision(repo, external, (bin, args, options) => {
    if (args.includes('rev-list')) throw Object.assign(new Error('history query timed out'), { code: 'ETIMEDOUT' });
    return bin === 'git' ? exec(bin, args, options) : Promise.resolve({ stdout: '[]' });
  });
  assert.equal(stop, null);
});

test('LAC-2218 an accepted asynchronous cancel intent does not certify worker termination', async () => {
  const result = await cancelHqDispatch({ worker, env: {}, execFileImpl: async () => ({
    stdout: JSON.stringify({ ok: true, cancelApplied: false, requestedAction: 'cancel', currentStatus: 'running' }),
  }) });
  assert.equal(result.cancelled, false);
  assert.equal(result.exitCode, 0);
  assert.equal(result.error, 'hq-cancellation-not-confirmed');
});

test('LAC-2218 unreadable/truncated HEAD history and unavailable attestation reads retain unknown custody', async t => {
  const repo = repository(t);
  repo.commit('owned');
  const tree = repo.git('rev-parse', 'HEAD^{tree}');
  const external = repo.git('commit-tree', tree, '-p', repo.reviewed, '-m', 'external');
  for (const history of [null, '', `${`${'a'.repeat(40)}\n`.repeat(129)}`]) {
    const stop = await decision(repo, external, (bin, args, options) => {
      if (args.includes('reflog')) {
        if (history === null) throw new Error('unreadable history');
        return Promise.resolve({ stdout: history });
      }
      return exec(bin, args, options);
    });
    assert.equal(stop, null);
  }
  const unknown = await decision(repo, 'f'.repeat(40), (bin, args, options) => {
    if (bin === 'git') return exec(bin, args, options);
    throw new Error('attestation read unavailable');
  });
  assert.equal(unknown, null);
});


test('LAC-2218 exit zero without a valid HQ termination receipt retains custody', async () => {
  for (const stdout of ['', 'cancelled', '{', '{}', '{"ok":false,"cancelApplied":true}', '{"ok":true}']) {
    const result = await cancelHqDispatch({ worker, env: {}, execFileImpl: async () => ({ stdout }) });
    assert.equal(result.cancelled, false);
    assert.equal(result.error, 'hq-cancellation-not-confirmed');
  }
});
