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
// The gate defers the reap while the hammer is live — AND (Gemini review of #793)
// defers on any TRANSIENT probe/manifest failure rather than failing open to
// reap, so a momentary blip under load can never delete a live worker's cwd.

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

const mergedGh = async () => ({
  stdout: JSON.stringify({ state: 'MERGED', mergedAt: '2026-08-06T12:00:00Z', closedAt: '2026-08-06T12:00:00Z' }),
});

function tearDownCalled(calls, workerId) {
  return calls.some((c) => c.cmd === '/bin/hq' && c.args[0] === 'worker' && c.args[1] === 'tear-down' && c.args[2] === workerId);
}

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
      return { active: true, defer: false, status: 'running' };
    },
    limit: 10,
    logger: { info() {}, warn() {} },
  });

  assert.equal(result.terminal, 1, 'PR classified terminal (merged)');
  assert.equal(result.deferredActiveWorker, 1, 'deferred because hammer is live');
  assert.equal(result.reaped, 0, 'live worktree NOT reaped');
  assert.deepEqual(probeCalls, ['lrq_active_791']);
  assert.equal(tearDownCalled(calls, 'hammer-ama-pr-791-live'), false, 'tear-down never invoked');
  assert.equal(calls.some((c) => c.cmd === 'git' && c.args.includes('remove')), false);
});

test('reaper DEFERS a merged worktree when the dispatch probe fails transiently (fail-to-defer)', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ama-closer-probe-transient-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const hqRoot = join(root, 'hq');
  const repoPath = join(hqRoot, 'repos', 'adversarial-review');
  const { workerDir } = seedMergedHammer(hqRoot, 'hammer-ama-pr-791-probefail', {
    withManifest: true,
    launchRequestId: 'lrq_probefail_791',
  });

  const calls = [];
  const result = await reapCloserHammerWorktrees({
    hqRoot,
    cursorPath: join(root, 'cursor.json'),
    hqPath: '/bin/hq',
    repoPaths: [repoPath],
    execFileImpl: mergedRepoWorktreeExecFile({ calls, workerDir }),
    execGhWithRetryImpl: mergedGh,
    // Simulates the fixed probe returning a defer verdict on a transient failure
    // (5s timeout kill / EAGAIN fork failure / busy hq).
    probeWorkerActivityImpl: async () => ({ active: false, defer: true, reason: 'probe-error:ETIMEDOUT' }),
    limit: 10,
    logger: { info() {}, warn() {} },
  });

  assert.equal(result.deferredActiveWorker, 1, 'transient probe failure defers, never reaps');
  assert.equal(result.reaped, 0, 'no reap on a transient probe failure');
  assert.equal(tearDownCalled(calls, 'hammer-ama-pr-791-probefail'), false);
});

test('reaper DEFERS a merged worktree when the manifest read fails transiently (EIO)', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ama-closer-manifest-eio-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const hqRoot = join(root, 'hq');
  const repoPath = join(hqRoot, 'repos', 'adversarial-review');
  // Single-child (no workspace.json) so discovery uses the real single-child
  // fallback; the injected EIO readFileImpl only hits the liveness gate's
  // manifest read, which must DEFER (not null-and-reap) on transient I/O.
  const { workerDir } = seedMergedHammer(hqRoot, 'hammer-ama-pr-791-eio', { withManifest: false });

  const calls = [];
  let probed = false;
  const result = await reapCloserHammerWorktrees({
    hqRoot,
    cursorPath: join(root, 'cursor.json'),
    hqPath: '/bin/hq',
    repoPaths: [repoPath],
    execFileImpl: mergedRepoWorktreeExecFile({ calls, workerDir }),
    execGhWithRetryImpl: mergedGh,
    readFileImpl: async () => {
      const err = new Error('input/output error');
      err.code = 'EIO';
      throw err;
    },
    probeWorkerActivityImpl: async () => {
      probed = true;
      return { active: false, defer: false, status: 'succeeded' };
    },
    limit: 10,
    logger: { info() {}, warn() {} },
  });

  assert.equal(result.deferredActiveWorker, 1, 'transient manifest read defers');
  assert.equal(result.reaped, 0, 'no reap on a transient manifest read failure');
  assert.equal(probed, false, 'probe not reached — manifest defer short-circuits');
  assert.equal(tearDownCalled(calls, 'hammer-ama-pr-791-eio'), false);
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
    probeWorkerActivityImpl: async () => ({ active: false, defer: false, status: 'succeeded', reason: 'terminal' }),
    limit: 10,
    logger: { info() {}, warn() {} },
  });

  assert.equal(result.terminal, 1);
  assert.equal(result.deferredActiveWorker, 0);
  assert.equal(result.reaped, 1, 'terminal hammer worktree IS reaped');
  assert.equal(tearDownCalled(calls, 'hammer-ama-pr-791-done'), true);
});

test('reaper reaps a merged worktree with an absent manifest (ENOENT → untracked → safe reap)', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ama-closer-nolrq-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const hqRoot = join(root, 'hq');
  const repoPath = join(hqRoot, 'repos', 'adversarial-review');
  // No workspace.json → real readFile returns ENOENT → untracked → reap proceeds.
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
      return { active: true, defer: false, status: 'running' };
    },
    limit: 10,
    logger: { info() {}, warn() {} },
  });

  assert.equal(probed, false, 'probe not consulted when the manifest is absent');
  assert.equal(result.deferredActiveWorker, 0);
  assert.equal(result.reaped, 1, 'absent-manifest merged tree still reaped (no leak)');
});

test('probeHammerWorkerActivity: active status + live pid => active, not deferred', async () => {
  const out = await probeHammerWorkerActivity({
    hqPath: '/bin/hq',
    launchRequestId: 'lrq_x',
    execFileImpl: async () => ({ stdout: JSON.stringify({ status: 'running', pid: 4242 }) }),
    processKillImpl: (pid, sig) => {
      assert.equal(pid, 4242);
      assert.equal(sig, 0);
    },
  });
  assert.deepEqual(out, { active: true, defer: false, status: 'running', reason: 'active', pid: 4242 });
});

test('probeHammerWorkerActivity: active status + dead pid => phantom (reap allowed)', async () => {
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
  assert.equal(out.defer, false);
  assert.equal(out.reason, 'phantom');
});

test('probeHammerWorkerActivity: terminal status => reap allowed (definitive read)', async () => {
  const out = await probeHammerWorkerActivity({
    hqPath: '/bin/hq',
    launchRequestId: 'lrq_x',
    execFileImpl: async () => ({ stdout: JSON.stringify({ status: 'succeeded', pid: 1 }) }),
    processKillImpl: () => true,
  });
  assert.equal(out.active, false);
  assert.equal(out.defer, false);
  assert.equal(out.reason, 'terminal');
});

test('probeHammerWorkerActivity: timeout-kill (transient) => DEFER after bounded retry', async () => {
  let attempts = 0;
  const out = await probeHammerWorkerActivity({
    hqPath: '/bin/hq',
    launchRequestId: 'lrq_x',
    execFileImpl: async () => {
      attempts += 1;
      const err = new Error('spawn hq ETIMEDOUT');
      err.killed = true;
      err.signal = 'SIGTERM';
      throw err;
    },
  });
  assert.equal(attempts, 2, 'transient failure is retried once');
  assert.equal(out.active, false);
  assert.equal(out.defer, true, 'transient probe failure DEFERS (never reaps)');
  assert.match(out.reason, /^probe-error:/);
});

test('probeHammerWorkerActivity: EAGAIN fork failure => DEFER', async () => {
  const out = await probeHammerWorkerActivity({
    hqPath: '/bin/hq',
    launchRequestId: 'lrq_x',
    execFileImpl: async () => {
      const err = new Error('spawn EAGAIN');
      err.code = 'EAGAIN';
      throw err;
    },
  });
  assert.equal(out.defer, true);
  assert.equal(out.active, false);
});

test('probeHammerWorkerActivity: non-JSON body (busy hq) => DEFER', async () => {
  const out = await probeHammerWorkerActivity({
    hqPath: '/bin/hq',
    launchRequestId: 'lrq_x',
    execFileImpl: async () => ({ stdout: 'database is locked\n' }),
  });
  assert.equal(out.defer, true);
  assert.equal(out.active, false);
  assert.equal(out.reason, 'probe-nonjson');
});

test('probeHammerWorkerActivity: missing launchRequestId => not active, not deferred', async () => {
  const out = await probeHammerWorkerActivity({ hqPath: '/bin/hq', launchRequestId: null });
  assert.equal(out.active, false);
  assert.equal(out.defer, false);
  assert.equal(out.reason, 'no-launch-request-id');
});

test('probeHammerWorkerActivity: active status with no pid stays active (cannot disprove)', async () => {
  const out = await probeHammerWorkerActivity({
    hqPath: '/bin/hq',
    launchRequestId: 'lrq_x',
    execFileImpl: async () => ({ stdout: JSON.stringify({ status: 'starting' }) }),
  });
  assert.equal(out.active, true);
  assert.equal(out.defer, false);
  assert.equal(out.status, 'starting');
  assert.equal(out.pid, null);
});

test('resolveEntryLaunchRequestId: reads launchRequestId; ENOENT untracked; EIO defers', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ama-lrq-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workerDir = join(root, 'hammer-ama-pr-791-x');
  mkdirSync(workerDir, { recursive: true });
  writeFileSync(join(workerDir, 'workspace.json'), JSON.stringify({ launchRequestId: 'lrq_zzz' }));

  const ok = await resolveEntryLaunchRequestId({ workerDir });
  assert.equal(ok.launchRequestId, 'lrq_zzz');
  assert.equal(ok.defer, false);

  const noDir = await resolveEntryLaunchRequestId({});
  assert.equal(noDir.launchRequestId, null);
  assert.equal(noDir.defer, false);

  const enoent = await resolveEntryLaunchRequestId({ workerDir: join(root, 'nope') });
  assert.equal(enoent.launchRequestId, null);
  assert.equal(enoent.defer, false, 'ENOENT is definitively untracked (safe reap)');
  assert.equal(enoent.reason, 'manifest-absent');

  const eio = await resolveEntryLaunchRequestId(
    { workerDir },
    {
      readFileImpl: async () => {
        const err = new Error('io');
        err.code = 'EMFILE';
        throw err;
      },
    },
  );
  assert.equal(eio.launchRequestId, null);
  assert.equal(eio.defer, true, 'transient manifest read DEFERS');
  assert.match(eio.reason, /^manifest-read-error:/);

  const malformed = await resolveEntryLaunchRequestId(
    { workerDir },
    { readFileImpl: async () => '{not-json' },
  );
  assert.equal(malformed.launchRequestId, null);
  assert.equal(malformed.defer, false, 'malformed JSON is definitive (safe reap)');
  assert.equal(malformed.reason, 'manifest-malformed');
});
