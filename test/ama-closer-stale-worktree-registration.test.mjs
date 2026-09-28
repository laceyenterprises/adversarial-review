import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  __testables__,
  isStaleWorktreeRegistrationError,
} from '../src/ama/dispatch-closer.mjs';

const { teardownSamePrHammerHolder } = __testables__;

const PR_NUMBER = 5889;
const WORKER_ID = 'claude-code-spv-03';

// The preflight resolves the holder's launch request from workspace.json on
// disk, so the fixture must materialise a real worker dir. Deliberately does
// NOT create the worktree directory itself -- its absence is the defect under
// test.
function makeHqRoot() {
  const root = mkdtempSync(join(tmpdir(), 'ama-stale-wt-'));
  const workerDir = join(root, 'workers', WORKER_ID);
  mkdirSync(workerDir, { recursive: true });
  writeFileSync(
    join(workerDir, 'workspace.json'),
    JSON.stringify({ launchRequestId: 'lrq_637a5137' })
  );
  return root;
}

// Verbatim from the live strand (agent-os#5889). The holder worker had already
// SUCCEEDED and its directory no longer existed, so git kept the branch pinned
// through leftover administrative metadata. `worktree remove --force` cannot
// clear that: --force overrides dirty/locked, not missing.
function provisionError(holder) {
  return {
    stderr: [
      '[hq] dispatch failed: ProvisionError',
      `detail: [hq] PR branch 'claude-code-spv-03/SPV-03' is already checked out by another worker worktree (${holder}).`,
      'Dispatch could not safely reuse or drop it automatically; run `hq worker tear-down claude-code-spv-03`.',
    ].join('\n'),
  };
}

const STALE_REMOVE_STDERR = "fatal: 'holder' is not a working tree\n";

test('isStaleWorktreeRegistrationError distinguishes stale metadata from real failures', () => {
  assert.equal(isStaleWorktreeRegistrationError(STALE_REMOVE_STDERR), true);
  assert.equal(
    isStaleWorktreeRegistrationError("fatal: 'x' is not a working tree"),
    true
  );
  assert.equal(
    isStaleWorktreeRegistrationError('fatal: No such file or directory'),
    true
  );

  // Must NOT swallow genuine removal failures -- those still need to abort the
  // teardown rather than be papered over with a prune.
  assert.equal(
    isStaleWorktreeRegistrationError("fatal: '/w' contains modified or untracked files, use --force to delete it"),
    false
  );
  assert.equal(isStaleWorktreeRegistrationError('fatal: permission denied'), false);
  assert.equal(isStaleWorktreeRegistrationError(''), false);
  assert.equal(isStaleWorktreeRegistrationError(null), false);
});

test('a missing holder worktree uses scoped worker tear-down', async () => {
  const HQ_ROOT = makeHqRoot();
  const HOLDER = join(HQ_ROOT, 'workers', WORKER_ID, 'agent-os');
  const calls = [];
  const execFileImpl = async (bin, args) => {
    calls.push([bin, ...args].join(' '));
    if (bin === 'hq') {
      const err = new Error('worker not found');
      err.stderr = 'worker not found';
      throw err;
    }
    if (bin === 'git' && args.includes('remove')) {
      const err = new Error('git worktree remove failed');
      err.stderr = STALE_REMOVE_STDERR;
      throw err;
    }
    return { stdout: '', stderr: '' };
  };

  const result = await teardownSamePrHammerHolder({
    err: provisionError(HOLDER),
    prNumber: PR_NUMBER,
    hqPath: 'hq',
    hqRoot: HQ_ROOT,
    execFileImpl,
    logger: { log() {}, error() {} },
    readLatestWorkerRunStatusImpl: async () => ({
      ok: true,
      row: {
        status: 'succeeded',
        launch_request_id: 'lrq_637a5137',
        run_id: 'wrun_spv03',
      },
    }),
    sleepImpl: async () => {},
  });

  assert.equal(result.ok, true);
  assert.ok(calls.some(c => c.includes('worker tear-down ' + WORKER_ID)));
  assert.ok(result.attempts.some(attempt => attempt.alreadyAbsent));
  assert.ok(calls.some(c => c.includes('worktree prune')), 'must release the stale branch registration');
});

test('a missing holder worktree retries transient hq tear-down errors', async () => {
  const hqRoot = makeHqRoot();
  const holder = join(hqRoot, 'workers', WORKER_ID, 'agent-os');
  let calls = 0;
  const delays = [];
  const result = await teardownSamePrHammerHolder({
    err: provisionError(holder), prNumber: PR_NUMBER, hqPath: 'hq', hqRoot,
    execFileImpl: async (bin) => {
      if (bin === 'git') return { stdout: '' };
      assert.equal(bin, 'hq');
      calls += 1;
      if (calls < 3) {
        const error = new Error('transient EIO');
        error.code = 'EIO';
        throw error;
      }
      return { stdout: '' };
    },
    readLatestWorkerRunStatusImpl: async () => ({ ok: true, row: { status: 'succeeded' } }),
    sleepImpl: async (ms) => { delays.push(ms); },
    logger: { warn() {} },
  });
  assert.equal(result.ok, true);
  assert.equal(calls, 3);
  assert.deepEqual(delays, [250, 1_000]);
  assert.equal(result.attempts.find(attempt => attempt.action === 'hq-worker-tear-down').attempts, 3);
});

test('a missing worktree with a live holder run is left alone', async () => {
  const hqRoot = makeHqRoot();
  const holder = join(hqRoot, 'workers', WORKER_ID, 'agent-os');
  const calls = [];
  const result = await teardownSamePrHammerHolder({
    err: provisionError(holder), prNumber: PR_NUMBER, hqPath: 'hq', hqRoot,
    execFileImpl: async (...args) => { calls.push(args); return { stdout: '' }; },
    readLatestWorkerRunStatusImpl: async () => ({ ok: true, row: { status: 'running' } }),
    logger: { warn() {} },
  });
  assert.equal(result.ok, false);
  assert.equal(result.attempts[0].action, 'missing-worktree-live-holder');
  assert.equal(calls.length, 0);
});

test('a genuine remove failure still aborts teardown and does not prune', async () => {
  const HQ_ROOT = makeHqRoot();
  const HOLDER = join(HQ_ROOT, 'workers', WORKER_ID, 'agent-os');
  const calls = [];
  const execFileImpl = async (bin, args) => {
    calls.push([bin, ...args].join(' '));
    if (bin === 'git' && args.includes('remove')) {
      const err = new Error('git worktree remove failed');
      err.stderr = "fatal: '/w' contains modified or untracked files, use --force to delete it\n";
      throw err;
    }
    return { stdout: '', stderr: '' };
  };

  await teardownSamePrHammerHolder({
    existsSyncImpl: () => true,
    err: provisionError(HOLDER),
    prNumber: PR_NUMBER,
    hqPath: 'hq',
    hqRoot: HQ_ROOT,
    execFileImpl,
    logger: { log() {}, error() {} },
    readLatestWorkerRunStatusImpl: async () => ({
      ok: true,
      row: {
        status: 'succeeded',
        launch_request_id: 'lrq_637a5137',
        run_id: 'wrun_spv03',
      },
    }),
    sleepImpl: async () => {},
  });

  assert.equal(
    calls.some(c => c.includes('worktree prune')),
    false,
    'a dirty-worktree failure is not a stale registration and must not be pruned away'
  );
});
