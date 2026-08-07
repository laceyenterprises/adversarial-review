import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  probeHammerWorkerActivity,
  reapCloserHammerWorktrees,
  resolveEntryLaunchRequestId,
} from '../src/ama/closer-worktree-reaper.mjs';

// Regression coverage for the 2026-08-06 hammer `worker_killed` cascade: the
// closer worktree reaper deleted a live hammer's worktree the instant its PR
// merged, while the hammer was still running its long post-merge close sequence.
// The fix defers the reap while the hammer's dispatch is still active.

function mergedRepoWorktreeExecFile({ calls, workerDir }) {
  const worktreePath = join(workerDir, 'agent-os');
  return async (cmd, args) => {
    calls.push({ cmd, args });
    const joined = args.join(' ');
    if (cmd === 'git' && joined.includes('remote get-url origin')) {
      return { stdout: 'git@github.com:laceyenterprises/adversarial-review.git\n', stderr: '' };
    }
    if (cmd === 'git' && joined.includes('worktree list --porcelain')) {
      return {
        stdout: [
          `worktree ${join(workerDir, '..', '..', 'repos', 'adversarial-review')}`,
          'branch refs/heads/main',
          '',
          `worktree ${worktreePath}`,
          'branch refs/heads/claude-code/HAM',
          '',
        ].join('\n'),
        stderr: '',
      };
    }
    return { stdout: '', stderr: '' };
  };
}

function seedMergedHammer(hqRoot, workerId, { withManifest, launchRequestId } = {}) {
  const workerDir = join(hqRoot, 'workers', workerId);
  const worktreePath = join(workerDir, 'agent-os');
  mkdirSync(worktreePath, { recursive: true });
  if (withManifest) {
    writeFileSync(
      join(workerDir, 'workspace.json'),
      JSON.stringify({ workspacePath: worktreePath, launchRequestId }),
    );
  }
  return { workerDir, worktreePath };
}

const mergedGh = async ({ args }) => ({
  stdout: JSON.stringify(
    args[2] === '791'
      ? { state: 'MERGED', mergedAt: '2026-08-06T12:00:00Z', closedAt: '2026-08-06T12:00:00Z' }
      : { state: 'OPEN', mergedAt: null, closedAt: null },
  ),
});

test('reaper DEFERS a merged worktree whose hammer dispatch is still active', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ama-closer-live-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const hqRoot = join(root, 'hq');
  const repoPath = join(hqRoot, 'repos', 'adversarial-review');
  const { workerDir } = seedMergedHammer(hqRoot, 'hammer-ama-pr-791-live', {
    withManifest: true,
    launchRequestId: 'lrq_active_791',
  });

  const calls = [];
  const probeCalls = [];
  const result = await reapCloserHammerWorktrees({
    hqRoot,
    cursorPath: join(root, 'cursor.json'),
    hqPath: '/bin/hq',
    repoPaths: [repoPath],
    execFileImpl: mergedRepoWorktreeExecFile({ calls, workerDir }),
    execGhWithRetryImpl: mergedGh,
    probeWorkerActivityImpl: async ({ launchRequestId }) => {
      probeCalls.push(launchRequestId);
      return { active: true, status: 'running' };
    },
    limit: 10,
    logger: { info() {}, warn() {} },
  });

  assert.equal(result.terminal, 1, 'PR classified terminal (merged)');
  assert.equal(result.deferredActiveWorker, 1, 'deferred because hammer is live');
  assert.equal(result.reaped, 0, 'live worktree NOT reaped');
  assert.deepEqual(probeCalls, ['lrq_active_791']);
  assert.equal(
    calls.some((c) => c.cmd === '/bin/hq' && c.args[1] === 'worker' && c.args[2] === 'hammer-ama-pr-791-live'),
    false,
    'tear-down never invoked for a live hammer',
  );
  assert.equal(
    calls.some((c) => c.cmd === 'git' && c.args.includes('remove')),
    false,
    'git worktree remove never invoked for a live hammer',
  );
});

test('reaper REAPS a merged worktree whose hammer dispatch is terminal', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ama-closer-term-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const hqRoot = join(root, 'hq');
  const repoPath = join(hqRoot, 'repos', 'adversarial-review');
  const { workerDir } = seedMergedHammer(hqRoot, 'hammer-ama-pr-791-done', {
    withManifest: true,
    launchRequestId: 'lrq_done_791',
  });

  const calls = [];
  const result = await reapCloserHammerWorktrees({
    hqRoot,
    cursorPath: join(root, 'cursor.json'),
    hqPath: '/bin/hq',
    repoPaths: [repoPath],
    execFileImpl: mergedRepoWorktreeExecFile({ calls, workerDir }),
    execGhWithRetryImpl: mergedGh,
    probeWorkerActivityImpl: async () => ({ active: false, status: 'succeeded', reason: 'terminal' }),
    limit: 10,
    logger: { info() {}, warn() {} },
  });

  assert.equal(result.terminal, 1);
  assert.equal(result.deferredActiveWorker, 0);
  assert.equal(result.reaped, 1, 'terminal hammer worktree IS reaped');
  assert.equal(
    calls.some((c) => c.cmd === '/bin/hq' && c.args[2] === 'hammer-ama-pr-791-done'),
    true,
    'tear-down invoked once the hammer is terminal',
  );
});

test('reaper reaps a merged worktree with no resolvable launchRequestId (leak-prevention preserved)', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ama-closer-nolrq-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const hqRoot = join(root, 'hq');
  const repoPath = join(hqRoot, 'repos', 'adversarial-review');
  // No workspace.json → no launchRequestId → gate is skipped, reap proceeds.
  const { workerDir } = seedMergedHammer(hqRoot, 'hammer-ama-pr-791-nolrq', { withManifest: false });

  const calls = [];
  let probed = false;
  const result = await reapCloserHammerWorktrees({
    hqRoot,
    cursorPath: join(root, 'cursor.json'),
    hqPath: '/bin/hq',
    repoPaths: [repoPath],
    execFileImpl: mergedRepoWorktreeExecFile({ calls, workerDir }),
    execGhWithRetryImpl: mergedGh,
    probeWorkerActivityImpl: async () => {
      probed = true;
      return { active: true, status: 'running' };
    },
    limit: 10,
    logger: { info() {}, warn() {} },
  });

  assert.equal(probed, false, 'probe not consulted when launchRequestId is unresolvable');
  assert.equal(result.deferredActiveWorker, 0);
  assert.equal(result.reaped, 1, 'unresolvable-but-merged tree still reaped (no leak)');
});

test('probeHammerWorkerActivity: active status + live pid => active', async () => {
  const out = await probeHammerWorkerActivity({
    hqPath: '/bin/hq',
    launchRequestId: 'lrq_x',
    execFileImpl: async () => ({ stdout: JSON.stringify({ status: 'running', pid: 4242 }) }),
    processKillImpl: (pid, sig) => {
      assert.equal(pid, 4242);
      assert.equal(sig, 0);
    },
  });
  assert.deepEqual(out, { active: true, status: 'running', reason: 'active', pid: 4242 });
});

test('probeHammerWorkerActivity: active status + dead pid => phantom, not active', async () => {
  const out = await probeHammerWorkerActivity({
    hqPath: '/bin/hq',
    launchRequestId: 'lrq_x',
    execFileImpl: async () => ({ stdout: JSON.stringify({ status: 'blocked', pid: 999999 }) }),
    processKillImpl: () => {
      const err = new Error('no such process');
      err.code = 'ESRCH';
      throw err;
    },
  });
  assert.equal(out.active, false);
  assert.equal(out.reason, 'phantom');
});

test('probeHammerWorkerActivity: terminal status => not active', async () => {
  const out = await probeHammerWorkerActivity({
    hqPath: '/bin/hq',
    launchRequestId: 'lrq_x',
    execFileImpl: async () => ({ stdout: JSON.stringify({ status: 'succeeded', pid: 1 }) }),
    processKillImpl: () => true,
  });
  assert.equal(out.active, false);
  assert.equal(out.reason, 'terminal');
});

test('probeHammerWorkerActivity: unreadable status => not active (reap proceeds)', async () => {
  const out = await probeHammerWorkerActivity({
    hqPath: '/bin/hq',
    launchRequestId: 'lrq_x',
    execFileImpl: async () => { throw new Error('hq boom'); },
  });
  assert.equal(out.active, false);
  assert.equal(out.reason, 'status-unreadable');
});

test('probeHammerWorkerActivity: missing launchRequestId => not active', async () => {
  const out = await probeHammerWorkerActivity({ hqPath: '/bin/hq', launchRequestId: null });
  assert.equal(out.active, false);
  assert.equal(out.reason, 'no-launch-request-id');
});

test('probeHammerWorkerActivity: active status with no pid stays active (cannot disprove)', async () => {
  const out = await probeHammerWorkerActivity({
    hqPath: '/bin/hq',
    launchRequestId: 'lrq_x',
    execFileImpl: async () => ({ stdout: JSON.stringify({ status: 'starting' }) }),
  });
  assert.equal(out.active, true);
  assert.equal(out.status, 'starting');
  assert.equal(out.pid, null);
});

test('resolveEntryLaunchRequestId reads launchRequestId from workspace.json', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ama-lrq-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workerDir = join(root, 'hammer-ama-pr-791-x');
  mkdirSync(workerDir, { recursive: true });
  writeFileSync(join(workerDir, 'workspace.json'), JSON.stringify({ launchRequestId: 'lrq_zzz' }));
  assert.equal(await resolveEntryLaunchRequestId({ workerDir }), 'lrq_zzz');
  assert.equal(await resolveEntryLaunchRequestId({}), null);
  assert.equal(await resolveEntryLaunchRequestId({ workerDir: join(root, 'nope') }), null);
});
