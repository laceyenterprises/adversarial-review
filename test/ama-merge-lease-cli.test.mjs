import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

import { defaultPidAliveFn, main as mergeLeaseMain } from '../bin/merge-lease.mjs';
import {
  acquireMergeLease,
  inspectMergeLease,
  mergeLeaseFilePath,
  readMergeLeaseAttempts,
  recordMergeLeaseGateAttempt,
  readMergeLeaseWaiters,
  releaseMergeLease,
  upsertMergeLeaseWaiter,
} from '../src/ama/merge-lease.mjs';

const REPO = 'owner/name';
const BASE = 'main';
const HOST = 'test-host';

function freshRoot() {
  return mkdtempSync(join(tmpdir(), 'ama-merge-lease-cli-'));
}

function capture() {
  let stdout = '';
  let stderr = '';
  return {
    stdout: {
      write(chunk) {
        stdout += chunk;
      },
    },
    stderr: {
      write(chunk) {
        stderr += chunk;
      },
    },
    get stdoutText() {
      return stdout;
    },
    get stderrText() {
      return stderr;
    },
  };
}

function jsonOutput(io) {
  return JSON.parse(io.stdoutText);
}

function fakeDeps(overrides = {}) {
  const io = capture();
  let nowMs = overrides.startMs ?? Date.parse('2026-06-20T18:00:00Z');
  const deps = {
    stdout: io.stdout,
    stderr: io.stderr,
    selfPid: 9000,
    host: HOST,
    pidAliveFn: () => true,
    nowMs: () => nowMs,
    nowIso: () => new Date(nowMs).toISOString(),
    sleep: async (ms) => {
      nowMs += ms;
      if (typeof overrides.onSleep === 'function') {
        await overrides.onSleep({ nowMs, advance: (delta) => { nowMs += delta; } });
      }
    },
    ...overrides,
  };
  delete deps.startMs;
  delete deps.onSleep;
  return { deps, io };
}

function acquireFixture(rootDir, overrides = {}) {
  return acquireMergeLease({
    rootDir,
    repo: REPO,
    base: BASE,
    holderPr: 100,
    holderHead: 'held-head',
    holderPid: 7100,
    holderHost: HOST,
    now: '2026-06-20T18:00:00.000Z',
    pidAliveFn: () => true,
    ...overrides,
  });
}

function writeLiveMutationLock(lockPath, lockId, acquiredAt = '2999-01-01T00:00:00.000Z') {
  writeFileSync(
    lockPath,
    `${JSON.stringify({
      schemaVersion: 1,
      lockId,
      holderPid: process.pid,
      holderHost: hostname(),
      acquiredAt,
    }, null, 2)}\n`,
  );
}

async function runCli(rootDir, args, overrides = {}) {
  const { deps, io } = fakeDeps(overrides);
  const code = await mergeLeaseMain([args[0], '--root-dir', rootDir, ...args.slice(1)], deps);
  return { code, io };
}

test('merge-lease acquire when free prints acquired:true and exits 0', async () => {
  const rootDir = freshRoot();
  try {
    const { code, io } = await runCli(rootDir, [
      'acquire',
      '--repo', REPO,
      '--base', BASE,
      '--pr', '123',
      '--head', 'abc123',
      '--owner-pid', '8123',
      '--wait', '1',
    ]);
    const out = jsonOutput(io);
    assert.equal(code, 0);
    assert.equal(out.acquired, true);
    assert.equal(out.key, `${REPO}::${BASE}`);
    assert.equal(out.holder, 123);
    assert.equal(out.holderHead, 'abc123');
    assert.equal(out.holderPid, 8123);
    assert.equal(out.waited_s, 0);
    assert.equal(inspectMergeLease({ rootDir, repo: REPO, base: BASE }).holder.leaseId, out.leaseId);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('merge-lease acquire rejects missing dead and self owner pid before writing holder', async () => {
  const cases = [
    {
      name: 'missing',
      args: ['--wait', '0'],
      deps: {},
    },
    {
      name: 'dead',
      args: ['--owner-pid', '8123', '--wait', '0'],
      deps: { pidAliveFn: () => false },
    },
    {
      name: 'self',
      args: ['--owner-pid', '9000', '--wait', '0'],
      deps: {},
    },
  ];

  for (const c of cases) {
    const rootDir = freshRoot();
    try {
      const { code, io } = await runCli(rootDir, [
        'acquire',
        '--repo', REPO,
        '--base', BASE,
        '--pr', '123',
        '--head', c.name,
        ...c.args,
      ], c.deps);
      assert.equal(code, 64, c.name);
      assert.equal(io.stdoutText, '');
      assert.match(io.stderrText, /error:/);
      assert.equal(existsSync(mergeLeaseFilePath(rootDir, { repo: REPO, base: BASE })), false);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  }
});

test('merge-lease acquire rejects unsafe repo and base path inputs before deriving files', async () => {
  const cases = [
    {
      name: 'repo traversal',
      args: ['--repo', '../../elsewhere', '--base', BASE],
      message: /--repo must be shaped owner\/name/,
    },
    {
      name: 'base traversal',
      args: ['--repo', REPO, '--base', '../main'],
      message: /--base must be a safe branch name/,
    },
    {
      name: 'base absolute',
      args: ['--repo', REPO, '--base', '/main'],
      message: /--base must be a safe branch name/,
    },
  ];

  for (const c of cases) {
    const rootDir = freshRoot();
    try {
      const { code, io } = await runCli(rootDir, [
        'acquire',
        ...c.args,
        '--pr', '123',
        '--head', 'abc123',
        '--owner-pid', '8123',
        '--wait', '0',
      ]);
      assert.equal(code, 64, c.name);
      assert.equal(io.stdoutText, '');
      assert.match(io.stderrText, c.message);
      assert.equal(existsSync(join(rootDir, 'data', 'merge-leases')), false);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  }
});

test('default pid liveness treats EPERM as live and ESRCH as dead', () => {
  const realKill = process.kill;
  try {
    process.kill = (pid, signal) => {
      assert.equal(signal, 0);
      if (pid === 8123) {
        const err = new Error('operation not permitted');
        err.code = 'EPERM';
        throw err;
      }
      if (pid === 8124) {
        const err = new Error('no such process');
        err.code = 'ESRCH';
        throw err;
      }
      return true;
    };

    assert.equal(defaultPidAliveFn(8123), true);
    assert.equal(defaultPidAliveFn(8124), false);
    assert.equal(defaultPidAliveFn(8125), true);
  } finally {
    process.kill = realKill;
  }
});

test('merge-lease acquire maps unexpected runtime errors to retryable exit without usage text', async () => {
  const rootDir = freshRoot();
  try {
    const { code, io } = await runCli(rootDir, [
      'acquire',
      '--repo', REPO,
      '--base', BASE,
      '--pr', '123',
      '--head', 'runtime-error',
      '--owner-pid', '8123',
      '--wait', '1',
    ], {
      acquireMergeLease: () => {
        const err = new Error('EIO while writing lease');
        err.code = 'EIO';
        throw err;
      },
    });
    assert.equal(code, 75);
    assert.equal(io.stdoutText, '');
    assert.match(io.stderrText, /retryable runtime failure: EIO while writing lease/);
    assert.doesNotMatch(io.stderrText, /Usage:/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('merge-lease needs-revalidation emits rendered decisions through the integrated CLI', async () => {
  const rootDir = freshRoot();
  try {
    const { code, io } = await runCli(rootDir, [
      'needs-revalidation',
      '--repo-path', '/repo',
      '--base', BASE,
      '--validation-base', '1'.repeat(40),
      '--current-base', '2'.repeat(40),
      '--changed-files-from', 'HEAD',
    ], {
      assessMergeLeaseNeedsRevalidation: async (options) => {
        assert.deepEqual(options, {
          repoPath: '/repo',
          base: BASE,
          validationBase: '1'.repeat(40),
          currentBase: '2'.repeat(40),
          changedFilesFrom: 'HEAD',
        });
        return {
          needsRevalidation: true,
          reason: 'unverified-current-base',
          currentBase: '2'.repeat(40),
          mainAdvancedBy: null,
          overlappingFiles: [],
          detail: 'fatal: could not fetch',
        };
      },
    });

    assert.equal(code, 0);
    assert.deepEqual(jsonOutput(io), {
      needsRevalidation: true,
      reason: 'unverified-current-base',
      currentBase: '2'.repeat(40),
      mainAdvancedBy: null,
      overlappingFiles: [],
      detail: 'fatal: could not fetch',
    });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('merge-lease acquire blocks in-process then acquires after holder releases', async () => {
  const rootDir = freshRoot();
  try {
    const held = acquireFixture(rootDir);
    let released = false;
    const { code, io } = await runCli(rootDir, [
      'acquire',
      '--repo', REPO,
      '--base', BASE,
      '--pr', '124',
      '--head', 'after-release',
      '--owner-pid', '8124',
      '--wait', '3',
    ], {
      onSleep: () => {
        if (released) return;
        released = true;
        releaseMergeLease({
          rootDir,
          repo: REPO,
          base: BASE,
          leaseId: held.lease.leaseId,
          holderPr: held.lease.holderPr,
          holderHead: held.lease.holderHead,
          acquiredAt: held.lease.acquiredAt,
        });
      },
    });
    const out = jsonOutput(io);
    assert.equal(code, 0);
    assert.equal(out.acquired, true);
    assert.equal(out.holder, 124);
    assert.equal(out.holderHead, 'after-release');
    assert.equal(out.waited_s, 0);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('merge-lease acquire honors FIFO durable waiter order', async () => {
  const rootDir = freshRoot();
  try {
    upsertMergeLeaseWaiter({
      rootDir,
      repo: REPO,
      base: BASE,
      pr: 201,
      head: 'earlier-head',
      holderPid: 8201,
      holderHost: HOST,
      waiterId: 'w-earlier',
      arrivedAt: '2026-06-20T18:00:01.000Z',
    });

    const later = await runCli(rootDir, [
      'acquire',
      '--repo', REPO,
      '--base', BASE,
      '--pr', '202',
      '--head', 'later-head',
      '--owner-pid', '8202',
      '--wait', '0',
    ], {
      startMs: Date.parse('2026-06-20T18:00:02Z'),
    });
    assert.equal(later.code, 75);
    assert.equal(jsonOutput(later.io).timedOut, true);
    assert.deepEqual(readMergeLeaseWaiters(rootDir, { repo: REPO, base: BASE }).map((w) => w.waiterId), ['w-earlier']);

    const earlier = await runCli(rootDir, [
      'acquire',
      '--repo', REPO,
      '--base', BASE,
      '--pr', '201',
      '--head', 'earlier-head',
      '--owner-pid', '8201',
      '--wait', '0',
    ], {
      startMs: Date.parse('2026-06-20T18:00:02Z'),
    });
    const out = jsonOutput(earlier.io);
    assert.equal(earlier.code, 0);
    assert.equal(out.acquired, true);
    assert.equal(out.holder, 201);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('merge-lease acquire timeout exits 75 with acquired:false timedOut:true', async () => {
  const rootDir = freshRoot();
  try {
    acquireFixture(rootDir);
    const { code, io } = await runCli(rootDir, [
      'acquire',
      '--repo', REPO,
      '--base', BASE,
      '--pr', '125',
      '--head', 'timeout-head',
      '--owner-pid', '8125',
      '--wait', '1',
    ]);
    const out = jsonOutput(io);
    assert.equal(code, 75);
    assert.equal(out.acquired, false);
    assert.equal(out.timedOut, true);
    assert.equal(out.waited_s, 1);
    assert.deepEqual(readMergeLeaseWaiters(rootDir, { repo: REPO, base: BASE }), []);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('merge-lease acquire retries mutation-lock contention until the wait deadline', async () => {
  const rootDir = freshRoot();
  try {
    const leasePath = mergeLeaseFilePath(rootDir, { repo: REPO, base: BASE });
    const lockPath = `${leasePath}.mutation.lock`;
    mkdirSync(join(rootDir, 'data', 'merge-leases'), { recursive: true });
    writeLiveMutationLock(lockPath, 'mll_live_cli');

    let lockReleased = false;
    const { code, io } = await runCli(rootDir, [
      'acquire',
      '--repo', REPO,
      '--base', BASE,
      '--pr', '126',
      '--head', 'after-lock',
      '--owner-pid', '8126',
      '--wait', '1',
    ], {
      onSleep: () => {
        if (lockReleased) return;
        lockReleased = true;
        unlinkSync(lockPath);
      },
    });

    const out = jsonOutput(io);
    assert.equal(code, 0);
    assert.equal(out.acquired, true);
    assert.equal(out.holder, 126);
    assert.equal(out.holderHead, 'after-lock');
    assert.equal(io.stderrText, '');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('merge-lease acquire maps mutation-lock contention at deadline to retryable timeout', async () => {
  const rootDir = freshRoot();
  try {
    const leasePath = mergeLeaseFilePath(rootDir, { repo: REPO, base: BASE });
    const lockPath = `${leasePath}.mutation.lock`;
    mkdirSync(join(rootDir, 'data', 'merge-leases'), { recursive: true });
    writeLiveMutationLock(lockPath, 'mll_live_cli_timeout');

    const { code, io } = await runCli(rootDir, [
      'acquire',
      '--repo', REPO,
      '--base', BASE,
      '--pr', '127',
      '--head', 'lock-timeout',
      '--owner-pid', '8127',
      '--wait', '0',
    ]);

    const out = jsonOutput(io);
    assert.equal(code, 75);
    assert.equal(out.acquired, false);
    assert.equal(out.timedOut, true);
    assert.equal(io.stderrText, '');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('merge-lease acquire succeeds when waiter cleanup lock is busy after holder write', async () => {
  const rootDir = freshRoot();
  try {
    const { code, io } = await runCli(rootDir, [
      'acquire',
      '--repo', REPO,
      '--base', BASE,
      '--pr', '128',
      '--head', 'post-write-lock',
      '--owner-pid', '8128',
      '--wait', '1',
    ], {
      acquireMergeLease: (options) => acquireMergeLease({
        ...options,
        _afterHolderWrite: ({ leasePath }) => {
          writeLiveMutationLock(`${leasePath}.mutation.lock`, 'mll_post_write_cleanup');
        },
      }),
    });

    const out = jsonOutput(io);
    assert.equal(code, 0);
    assert.equal(out.acquired, true);
    assert.equal(out.holder, 128);
    assert.equal(out.holderHead, 'post-write-lock');
    assert.equal(inspectMergeLease({ rootDir, repo: REPO, base: BASE }).holder.holderPid, 8128);
    assert.equal(io.stderrText, '');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('merge-lease release with matching lease id releases holder', async () => {
  const rootDir = freshRoot();
  try {
    const held = acquireFixture(rootDir, { holderPr: 301, holderHead: 'release-head' });
    const { code, io } = await runCli(rootDir, [
      'release',
      '--repo', REPO,
      '--base', BASE,
      '--pr', '301',
      '--lease-id', held.lease.leaseId,
    ]);
    const out = jsonOutput(io);
    assert.equal(code, 0);
    assert.equal(out.released, true);
    assert.equal(existsSync(held.leasePath), false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('merge-lease release with stale lease id does not delete current holder', async () => {
  const rootDir = freshRoot();
  try {
    const held = acquireFixture(rootDir, { holderPr: 302, holderHead: 'current-head' });
    const { code, io } = await runCli(rootDir, [
      'release',
      '--repo', REPO,
      '--base', BASE,
      '--pr', '302',
      '--lease-id', 'ml_stale',
    ]);
    const out = jsonOutput(io);
    assert.equal(code, 0);
    assert.equal(out.released, false);
    assert.equal(inspectMergeLease({ rootDir, repo: REPO, base: BASE }).holder.leaseId, held.lease.leaseId);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('merge-lease release retries mutation-lock-busy before returning success', async () => {
  const rootDir = freshRoot();
  try {
    const held = acquireFixture(rootDir, { holderPr: 303, holderHead: 'busy-then-release-head' });
    const lockPath = `${held.leasePath}.mutation.lock`;
    writeLiveMutationLock(lockPath, 'mll_busy_release_retry');
    let lockReleased = false;
    const { code, io } = await runCli(rootDir, [
      'release',
      '--repo', REPO,
      '--base', BASE,
      '--pr', '303',
      '--lease-id', held.lease.leaseId,
    ], {
      onSleep: () => {
        if (lockReleased) return;
        lockReleased = true;
        unlinkSync(lockPath);
      },
    });
    const out = jsonOutput(io);
    assert.equal(code, 0);
    assert.equal(out.released, true);
    assert.equal(out.existingLease, null);
    assert.equal(existsSync(held.leasePath), false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('merge-lease release reports persistent mutation-lock-busy as retryable', async () => {
  const rootDir = freshRoot();
  try {
    const held = acquireFixture(rootDir, { holderPr: 304, holderHead: 'busy-release-head' });
    writeLiveMutationLock(`${held.leasePath}.mutation.lock`, 'mll_busy_release');
    const { code, io } = await runCli(rootDir, [
      'release',
      '--repo', REPO,
      '--base', BASE,
      '--pr', '304',
      '--lease-id', held.lease.leaseId,
    ]);
    const out = jsonOutput(io);
    assert.equal(code, 75);
    assert.equal(out.released, false);
    assert.equal(out.retryable, true);
    assert.equal(out.reason, 'mutation-lock-busy');
    assert.equal(out.existingLease.leaseId, held.lease.leaseId);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('merge-lease reconcile releases holder whose PR is merged', async () => {
  const rootDir = freshRoot();
  try {
    const held = acquireFixture(rootDir, { holderPr: 305, holderHead: 'merged-head' });
    const { code, io } = await runCli(rootDir, [
      'reconcile',
      '--repo', REPO,
      '--base', BASE,
    ], {
      execFileImpl: (file, args, options, callback) => {
        assert.equal(file, 'gh');
        assert.deepEqual(args, ['pr', 'view', '305', '--repo', REPO, '--json', 'state']);
        assert.equal(options.timeout, 30000);
        assert.equal(options.maxBuffer, 10 * 1024 * 1024);
        callback(null, '{"state":"MERGED"}\n', '');
      },
    });
    const out = jsonOutput(io);
    assert.equal(code, 0);
    assert.equal(out.reconciled, true);
    assert.equal(out.released, true);
    assert.equal(out.reason, 'holder-pr-merged');
    assert.equal(out.holderPrState, 'MERGED');
    assert.equal(out.existingLease, null);
    assert.equal(existsSync(held.leasePath), false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('merge-lease reconcile prunes released holder gate attempt', async () => {
  const rootDir = freshRoot();
  try {
    acquireFixture(rootDir, { holderPr: 307, holderHead: 'merged-attempt-head' });
    recordMergeLeaseGateAttempt({
      rootDir,
      repo: REPO,
      base: BASE,
      pr: 307,
      head: 'merged-attempt-head',
      now: '2026-06-20T18:00:10.000Z',
      maxAttempts: 5,
    });
    recordMergeLeaseGateAttempt({
      rootDir,
      repo: REPO,
      base: BASE,
      pr: 308,
      head: 'other-head',
      now: '2026-06-20T18:00:11.000Z',
      maxAttempts: 5,
    });
    const { code, io } = await runCli(rootDir, [
      'reconcile',
      '--repo', REPO,
      '--base', BASE,
    ], {
      execFileImpl: (file, args, options, callback) => {
        assert.equal(file, 'gh');
        assert.deepEqual(args, ['pr', 'view', '307', '--repo', REPO, '--json', 'state']);
        assert.equal(options.timeout, 30000);
        callback(null, '{"state":"MERGED"}\n', '');
      },
    });

    const out = jsonOutput(io);
    assert.equal(code, 0);
    assert.equal(out.released, true);
    assert.deepEqual(
      readMergeLeaseAttempts(rootDir, { repo: REPO, base: BASE }).map((attempt) => `${attempt.pr}:${attempt.head}`),
      ['308:other-head'],
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('merge-lease reconcile releases dead-owner-pid holder without calling gh', async () => {
  const rootDir = freshRoot();
  try {
    acquireFixture(rootDir, { holderPr: 306, holderPid: 99999, holderHost: HOST });
    const { code, io } = await runCli(rootDir, [
      'reconcile',
      '--repo', REPO,
      '--base', BASE,
    ], {
      pidAliveFn: (pid) => pid !== 99999,
      execFileImpl: () => {
        throw new Error('gh should not be called');
      },
    });
    const out = jsonOutput(io);
    assert.equal(code, 0);
    assert.equal(out.released, true);
    assert.equal(out.reason, 'dead-holder-pid');
    assert.equal(inspectMergeLease({ rootDir, repo: REPO, base: BASE }).exists, false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('merge-lease status reports holder and waiter ages', async () => {
  const rootDir = freshRoot();
  try {
    const held = acquireFixture(rootDir, {
      holderPr: 401,
      holderHead: 'status-head',
      now: '2026-06-20T18:00:00.000Z',
    });
    upsertMergeLeaseWaiter({
      rootDir,
      repo: REPO,
      base: BASE,
      pr: 402,
      head: 'waiter-head',
      holderPid: 8402,
      holderHost: HOST,
      waiterId: 'w-status',
      arrivedAt: '2026-06-20T18:00:10.000Z',
    });
    recordMergeLeaseGateAttempt({
      rootDir,
      repo: REPO,
      base: BASE,
      pr: 402,
      head: 'waiter-head',
      now: '2026-06-20T18:00:15.000Z',
      maxAttempts: 5,
    });
    recordMergeLeaseGateAttempt({
      rootDir,
      repo: REPO,
      base: BASE,
      pr: 402,
      head: 'waiter-head',
      now: '2026-06-20T18:00:30.000Z',
      maxAttempts: 5,
    });
    const { code, io } = await runCli(rootDir, [
      'status',
      '--repo', REPO,
      '--base', BASE,
    ], {
      startMs: Date.parse('2026-06-20T18:01:00Z'),
    });
    const out = jsonOutput(io);
    assert.equal(code, 0);
    assert.equal(out.key, `${REPO}::${BASE}`);
    assert.equal(out.holder.leaseId, held.lease.leaseId);
    assert.equal(out.holder.ageSeconds, 60);
    assert.equal(out.waiters.length, 1);
    assert.equal(out.waiters[0].waiterId, 'w-status');
    assert.equal(out.waiters[0].ageSeconds, 50);
    assert.equal(out.attempts.length, 1);
    assert.equal(out.attempts[0].pr, 402);
    assert.equal(out.attempts[0].attempts, 2);
    assert.equal(out.attempts[0].ageSeconds, 45);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('merge-lease acquire parks after max gate attempts', async () => {
  const rootDir = freshRoot();
  try {
    acquireFixture(rootDir);
    const first = await runCli(rootDir, [
      'acquire',
      '--repo', REPO,
      '--base', BASE,
      '--pr', '601',
      '--head', 'starved-head',
      '--owner-pid', '8601',
      '--wait', '0',
    ], {
      maxGateAttempts: 2,
    });
    assert.equal(first.code, 75);
    assert.equal(jsonOutput(first.io).timedOut, true);

    const second = await runCli(rootDir, [
      'acquire',
      '--repo', REPO,
      '--base', BASE,
      '--pr', '601',
      '--head', 'starved-head',
      '--owner-pid', '8601',
      '--wait', '0',
    ], {
      maxGateAttempts: 2,
    });
    assert.equal(second.code, 75);
    assert.equal(jsonOutput(second.io).timedOut, true);

    const parked = await runCli(rootDir, [
      'acquire',
      '--repo', REPO,
      '--base', BASE,
      '--pr', '601',
      '--head', 'starved-head',
      '--owner-pid', '8601',
      '--wait', '0',
    ], {
      maxGateAttempts: 2,
    });
    const out = jsonOutput(parked.io);
    assert.equal(parked.code, 70);
    assert.equal(out.parked, true);
    assert.equal(out.reason, 'max-gate-attempts');
    assert.equal(out.attempts, 3);
    assert.equal(out.maxAttempts, 2);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('merge-lease acquire reclaims stale dead-owner-pid holder during wait', async () => {
  const rootDir = freshRoot();
  try {
    acquireFixture(rootDir, { holderPid: 99999, holderHost: HOST, holderHead: 'dead-head' });
    const { code, io } = await runCli(rootDir, [
      'acquire',
      '--repo', REPO,
      '--base', BASE,
      '--pr', '501',
      '--head', 'after-reclaim',
      '--owner-pid', '8501',
      '--wait', '1',
    ], {
      pidAliveFn: (pid) => pid !== 99999,
    });
    const out = jsonOutput(io);
    assert.equal(code, 0);
    assert.equal(out.acquired, true);
    assert.equal(out.holder, 501);
    assert.equal(out.holderHead, 'after-reclaim');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
