import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  probeHammerWorkerActivity,
  probeWorkerDirectoryUse,
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
  assert.deepEqual(out, { state: 'active', active: true, defer: false, status: 'running', reason: 'active', pid: 4242 });
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

test('probeWorkerDirectoryUse: same-uid cwd match marks worker active and scopes by pid', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ama-lsof-active-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workerDir = join(root, 'hammer-ama-pr-791-active');
  const worktree = join(workerDir, 'agent-os');
  mkdirSync(worktree, { recursive: true });
  const calls = [];
  const out = await probeWorkerDirectoryUse({
    workerDir,
    pid: 4242,
    timeoutMs: 12345,
    execFileImpl: async (cmd, args, options) => {
      calls.push({ cmd, args, options });
      return { stdout: `p4242\nn${join(worktree, 'subdir')}\n` };
    },
  });

  assert.equal(out.state, 'active');
  assert.equal(out.reason, 'cwd-in-worker-dir');
  assert.equal(out.matches, 1);
  assert.deepEqual(calls[0].args, ['-a', '-d', 'cwd', '-Fn', '-p', '4242']);
  assert.equal(calls[0].options.timeout, 12345);
});

test('probeWorkerDirectoryUse: same-uid no-match is inactive only after a clean probe', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ama-lsof-inactive-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workerDir = join(root, 'hammer-ama-pr-791-inactive');
  mkdirSync(join(workerDir, 'agent-os'), { recursive: true });

  const out = await probeWorkerDirectoryUse({
    workerDir,
    execFileImpl: async () => ({ stdout: `p1\nn${join(root, 'elsewhere')}\n` }),
  });

  assert.deepEqual(out, { state: 'inactive', reason: 'no-cwd-in-worker-dir', matches: 0 });
});

test('probeWorkerDirectoryUse: exit-1 without diagnostics is inactive, diagnostics are unknown', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ama-lsof-exit1-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workerDir = join(root, 'hammer-ama-pr-791-exit1');
  mkdirSync(workerDir, { recursive: true });

  const cleanExitOne = await probeWorkerDirectoryUse({
    workerDir,
    execFileImpl: async () => {
      const err = new Error('no files');
      err.code = 1;
      err.stderr = '';
      throw err;
    },
  });
  assert.deepEqual(cleanExitOne, { state: 'inactive', reason: 'no-cwd-in-worker-dir', matches: 0 });

  const diagnosticExitOne = await probeWorkerDirectoryUse({
    workerDir,
    execFileImpl: async () => {
      const err = new Error('permission denied');
      err.code = 1;
      err.stderr = 'lsof: WARNING: cannot stat() some file system\n';
      throw err;
    },
  });
  assert.equal(diagnosticExitOne.state, 'unknown');
  assert.equal(diagnosticExitOne.reason, 'process-probe-error:1');
});

test('probeWorkerDirectoryUse: timeout, maxBuffer, and missing lsof are unknown', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ama-lsof-unknown-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workerDir = join(root, 'hammer-ama-pr-791-unknown');
  mkdirSync(workerDir, { recursive: true });

  for (const err of [
    Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' }),
    Object.assign(new Error('maxBuffer exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }),
    Object.assign(new Error('spawn lsof ENOENT'), { code: 'ENOENT' }),
  ]) {
    const out = await probeWorkerDirectoryUse({
      workerDir,
      execFileImpl: async () => {
        throw err;
      },
    });
    assert.equal(out.state, 'unknown');
    assert.match(out.reason, /^process-probe-error:/);
  }
});

test('probeWorkerDirectoryUse: cross-uid worker directory is unobservable and never trusts a negative', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ama-lsof-cross-uid-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workerDir = join(root, 'hammer-ama-pr-791-crossuid');
  mkdirSync(workerDir, { recursive: true });
  let execCalled = false;

  const out = await probeWorkerDirectoryUse({
    workerDir,
    statSyncImpl: () => ({ uid: 501 }),
    getuidImpl: () => 502,
    execFileImpl: async () => {
      execCalled = true;
      return { stdout: '' };
    },
  });

  assert.equal(out.state, 'unknown');
  assert.equal(out.reason, 'cross-uid-unobservable');
  assert.equal(out.ownerUid, 501);
  assert.equal(out.callerUid, 502);
  assert.equal(execCalled, false);
});

test('probeWorkerDirectoryUse: caller-owned directory with foreign run-as user is unobservable', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ama-lsof-run-as-user-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workerDir = join(root, 'hammer-ama-pr-791-run-as-user');
  mkdirSync(workerDir, { recursive: true });
  let execCalled = false;

  const out = await probeWorkerDirectoryUse({
    workerDir,
    env: { AGENT_OS_WORKER_RUN_AS_USER: 'agentos-worker' },
    statSyncImpl: () => ({ uid: 502 }),
    getuidImpl: () => 502,
    currentUserImpl: () => 'airlock',
    execFileImpl: async () => {
      execCalled = true;
      return { stdout: '' };
    },
  });

  assert.equal(out.state, 'unknown');
  assert.equal(out.reason, 'run-as-user-unobservable');
  assert.equal(out.configuredRunAsUser, 'agentos-worker');
  assert.equal(out.currentUser, 'airlock');
  assert.equal(execCalled, false);
});

test('reaper immediately reaps a readable manifest without launchRequestId and skips cwd probing', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ama-closer-no-launch-id-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const hqRoot = join(root, 'hq');
  const repoPath = join(hqRoot, 'repos', 'adversarial-review');
  const workerId = 'hammer-ama-pr-791-no-launch-id';
  const { workerDir } = seedMergedHammer(hqRoot, workerId, { withManifest: true });
  const calls = [];
  let cwdProbeCalled = false;

  const result = await reapCloserHammerWorktrees({
    hqRoot,
    cursorPath: join(root, 'cursor.json'),
    hqPath: '/bin/hq',
    repoPaths: [repoPath],
    execFileImpl: mergedRepoWorktreeExecFile({ calls, workerDir }),
    execGhWithRetryImpl: mergedGh,
    probeWorkerDirectoryUseImpl: async () => {
      cwdProbeCalled = true;
      return { state: 'active' };
    },
    limit: 10,
    logger: { info() {}, warn() {} },
  });

  assert.equal(result.reaped, 1);
  assert.equal(cwdProbeCalled, false);
  assert.equal(tearDownCalled(calls, workerId), true);
});

test('reaper eventually reaps a merged absent-dispatch worktree after repeated unknown probes and no live cwd', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ama-closer-bounded-unknown-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const hqRoot = join(root, 'hq');
  const repoPath = join(hqRoot, 'repos', 'adversarial-review');
  const workerId = 'hammer-ama-pr-791-bounded-unknown';
  const { workerDir } = seedMergedHammer(hqRoot, workerId, {
    withManifest: true,
    launchRequestId: 'lrq_absent_791',
  });
  const cursorPath = join(root, 'cursor.json');
  const calls = [];
  const logs = [];
  const options = {
    hqRoot,
    cursorPath,
    hqPath: '/bin/hq',
    repoPaths: [repoPath],
    execFileImpl: mergedRepoWorktreeExecFile({ calls, workerDir }),
    execGhWithRetryImpl: mergedGh,
    probeWorkerActivityImpl: async () => ({
      state: 'unknown', active: false, defer: true, reason: 'probe-error:SIGTERM',
    }),
    probeWorkerDirectoryUseImpl: async () => ({
      state: 'inactive', reason: 'no-cwd-in-worker-dir', matches: 0,
    }),
    unknownProbeLimit: 3,
    limit: 10,
    logger: { info(line) { logs.push(line); }, warn() {} },
  };

  const first = await reapCloserHammerWorktrees(options);
  const second = await reapCloserHammerWorktrees(options);
  const third = await reapCloserHammerWorktrees(options);

  assert.equal(first.reaped, 0);
  assert.equal(second.reaped, 0);
  assert.equal(third.reaped, 1, 'bounded unknown status plus definitive no-process evidence reaps');
  const decision = logs.map((line) => JSON.parse(line)).find(
    (record) => record.event === 'closer_worktree_reap.unknown_probe_resolved',
  );
  assert.equal(decision.livenessState, 'unknown');
  assert.equal(decision.probeFailureCount, 3);
  assert.equal(decision.processState, 'inactive');
  assert.equal(decision.decision, 'reap');
});

test('reaper never reaps a live worker when the dispatch probe repeatedly fails', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ama-closer-live-unknown-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const hqRoot = join(root, 'hq');
  const repoPath = join(hqRoot, 'repos', 'adversarial-review');
  const workerId = 'hammer-ama-pr-791-live-unknown';
  const { workerDir } = seedMergedHammer(hqRoot, workerId, {
    withManifest: true,
    launchRequestId: 'lrq_live_791',
  });
  const cursorPath = join(root, 'cursor.json');
  const calls = [];
  const logs = [];
  const options = {
    hqRoot,
    cursorPath,
    hqPath: '/bin/hq',
    repoPaths: [repoPath],
    execFileImpl: mergedRepoWorktreeExecFile({ calls, workerDir }),
    execGhWithRetryImpl: mergedGh,
    probeWorkerActivityImpl: async () => ({
      state: 'unknown', active: false, defer: true, reason: 'probe-error:SIGTERM',
    }),
    probeWorkerDirectoryUseImpl: async () => ({
      state: 'active', reason: 'cwd-in-worker-dir', matches: 1,
    }),
    unknownProbeLimit: 2,
    limit: 10,
    logger: { info(line) { logs.push(line); }, warn() {} },
  };

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const result = await reapCloserHammerWorktrees(options);
    assert.equal(result.reaped, 0, `attempt ${attempt + 1} preserves the live worktree`);
  }
  assert.equal(tearDownCalled(calls, workerId), false);
  const lastDeferred = logs.map((line) => JSON.parse(line)).filter(
    (record) => record.event === 'closer_worktree_reap.deferred_active_worker',
  ).at(-1);
  assert.equal(lastDeferred.livenessState, 'unknown');
  assert.equal(lastDeferred.processState, 'active');
});

test('reaper defers when escalated process probe cannot observe the worker uid', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ama-closer-cross-uid-unknown-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const hqRoot = join(root, 'hq');
  const repoPath = join(hqRoot, 'repos', 'adversarial-review');
  const workerId = 'hammer-ama-pr-791-cross-uid-unknown';
  const { workerDir } = seedMergedHammer(hqRoot, workerId, {
    withManifest: true,
    launchRequestId: 'lrq_cross_uid_791',
  });
  const calls = [];
  const result = await reapCloserHammerWorktrees({
    hqRoot,
    cursorPath: join(root, 'cursor.json'),
    hqPath: '/bin/hq',
    repoPaths: [repoPath],
    execFileImpl: mergedRepoWorktreeExecFile({ calls, workerDir }),
    execGhWithRetryImpl: mergedGh,
    probeWorkerActivityImpl: async () => ({
      state: 'unknown', active: false, defer: true, reason: 'probe-error:SIGTERM',
    }),
    probeWorkerDirectoryUseImpl: async () => ({
      state: 'unknown', reason: 'cross-uid-unobservable',
    }),
    unknownProbeLimit: 1,
    limit: 10,
    logger: { info() {}, warn() {} },
  });

  assert.equal(result.reaped, 0);
  assert.equal(result.deferredActiveWorker, 1);
  assert.equal(tearDownCalled(calls, workerId), false);
});

test('reaper prunes stale and absent-worker probeFailures before persisting cursor', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ama-closer-probe-failure-gc-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const hqRoot = join(root, 'hq');
  const repoPath = join(hqRoot, 'repos', 'adversarial-review');
  const workerId = 'hammer-ama-pr-791-current';
  const { workerDir } = seedMergedHammer(hqRoot, workerId, {
    withManifest: true,
    launchRequestId: 'lrq_current_791',
  });
  mkdirSync(join(hqRoot, 'workers', 'hammer-ama-pr-791-off-page', 'agent-os'), { recursive: true });
  const cursorPath = join(root, 'cursor.json');
  writeFileSync(cursorPath, `${JSON.stringify({
    schemaVersion: 1,
    probeFailures: {
      [workerId]: {
        failureCount: 1,
        firstFailureAt: '2026-09-20T00:00:00.000Z',
        lastFailureAt: '2026-09-20T00:00:00.000Z',
        lastReason: 'probe-error:SIGTERM',
      },
      'hammer-ama-pr-791-off-page': {
        failureCount: 2,
        firstFailureAt: '2026-09-20T00:00:00.000Z',
        lastFailureAt: '2026-09-20T00:00:00.000Z',
        lastReason: 'probe-error:SIGTERM',
      },
      'hammer-ama-pr-791-gone': {
        failureCount: 2,
        firstFailureAt: '2026-09-20T00:00:00.000Z',
        lastFailureAt: '2026-09-20T00:00:00.000Z',
        lastReason: 'probe-error:SIGTERM',
      },
      'hammer-ama-pr-791-stale': {
        failureCount: 2,
        firstFailureAt: '2026-09-19T00:00:00.000Z',
        lastFailureAt: '2026-09-19T00:00:00.000Z',
        lastReason: 'probe-error:SIGTERM',
      },
    },
  }, null, 2)}\n`);

  await reapCloserHammerWorktrees({
    hqRoot,
    cursorPath,
    hqPath: '/bin/hq',
    repoPaths: [repoPath],
    execFileImpl: mergedRepoWorktreeExecFile({ calls: [], workerDir }),
    execGhWithRetryImpl: mergedGh,
    probeWorkerActivityImpl: async () => ({
      state: 'active', active: true, defer: false, status: 'running',
    }),
    limit: 10,
    scanLimit: 1,
    probeFailureTtlMs: 7 * 24 * 60 * 60 * 1000,
    logger: { info() {}, warn() {} },
  });

  const persisted = JSON.parse(readFileSync(cursorPath, 'utf8'));
  assert.equal(persisted.schemaVersion, 2);
  assert.deepEqual(persisted.probeFailures, {
    'hammer-ama-pr-791-off-page': {
      failureCount: 2,
      firstFailureAt: '2026-09-20T00:00:00.000Z',
      lastFailureAt: '2026-09-20T00:00:00.000Z',
      lastReason: 'probe-error:SIGTERM',
    },
  });
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
