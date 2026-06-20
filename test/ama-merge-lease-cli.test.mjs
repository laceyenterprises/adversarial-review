import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main as mergeLeaseMain } from '../bin/merge-lease.mjs';
import {
  acquireMergeLease,
  inspectMergeLease,
  mergeLeaseFilePath,
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
