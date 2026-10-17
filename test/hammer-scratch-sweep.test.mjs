import { launchRetryFixture } from './helpers/launch-retry-fixture.mjs';
import { readLaunchRequestStatusFromLedgerAsync } from '../src/session-ledger-read-adapter.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lutimesSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { amaCloserDispatchFilePath, createHammerScratchDir } from '../src/ama/dispatch-closer.mjs';
import { createHammerScratchSweepTicker, HAMMER_SCRATCH_MAX_AGE_MS,
  HAMMER_SCRATCH_SWEEP_INTERVAL_MS, readHammerScratchProcessSnapshot, sweepHammerScratchDirs } from '../src/ama/hammer-scratch-sweep.mjs';

const nowMs = Date.parse('2026-10-16T12:00:00Z');
const old = new Date(nowMs - HAMMER_SCRATCH_MAX_AGE_MS - 60_000);
const identity = { repo: 'fixture/repo', prNumber: 42, headSha: 'synthetic-head' };
let freshImport = 0;

async function freshSweeper() {
  // A fresh module has no in-memory record index, as after a watcher restart.
  freshImport += 1;
  return import(`../src/ama/hammer-scratch-sweep.mjs?synthetic-restart=${freshImport}`);
}

for (const platform of ['darwin', 'linux']) {
  test(`HAMTMP-03: ${platform} process census includes environments, cwd and open files with bounded commands`, async () => {
    const calls = [];
    const snapshot = await readHammerScratchProcessSnapshot({ timeout: 1234, platform,
      execFileImpl: async (command, args, options) => {
        calls.push({ command, args, options });
        return { stdout: command === 'ps' ? '123 synthetic-hammer TMPDIR=/fixture/scratch' : 'p123\nn/fixture/open-file' };
      } });
    assert.match(snapshot.ps, /TMPDIR=\/fixture\/scratch/);
    assert.match(snapshot.lsof, /n\/fixture\/open-file/);
    assert.deepEqual(calls[0].args, [platform === 'darwin' ? '-Eww' : 'eww', '-axo', 'pid=,command=']);
    assert.equal(calls[1].command, 'lsof');
    assert.deepEqual(calls[1].args, ['-nP', '-a', '-u', String(process.getuid()), '-F', 'n']);
    assert.ok(calls.every(call => call.options.timeout === 1234 && call.options.maxBuffer > 0));
    await assert.rejects(readHammerScratchProcessSnapshot({ timeout: 1234,
      execFileImpl: async command => {
        if (command === 'lsof') throw new Error('synthetic unavailable command');
        return { stdout: 'synthetic process' };
      } }), /unreadable process census/);
  });
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'hammer-sweep-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const promptDir = join(root, 'data', 'follow-up-jobs', 'ama-closer-prompts');
  const logs = [];
  const options = { nowMs, logger: { info: line => logs.push(line), warn: line => logs.push(line) },
    readProcessSnapshotImpl: async () => ({ ps: '123 synthetic-idle-process', lsof: 'p123\nn/fixture/unrelated' }),
    readLaunchRequestStatusImpl: () => ({ ok: true, row: { status: 'succeeded' } }),
    readPullRequestStateImpl: () => ({ state: 'OPEN' }),
    readWorkerStatusImpl: () => ({ ok: true, row: { status: 'succeeded', pid: 12345 } }),
    processKillImpl: () => { throw Object.assign(new Error('synthetic absent process'), { code: 'ESRCH' }); } };
  function scratch() {
    const path = createHammerScratchDir(promptDir);
    const log = join(path, 'ci-failed.log');
    writeFileSync(log, 'synthetic CI output');
    utimesSync(log, old, old);
    utimesSync(path, old, old);
    return path;
  }
  function record(path, fields = {}) {
    const dispatchPath = amaCloserDispatchFilePath(root, identity);
    mkdirSync(dirname(dispatchPath), { recursive: true });
    writeFileSync(dispatchPath, JSON.stringify({ ...identity, state: 'dispatched',
      scratchDir: path, promptDir, launchRequestId: 'synthetic-lrq',
      lastObservedStatus: 'succeeded', ...fields }));
    return dispatchPath;
  }
  function history(count) {
    const directory = dirname(amaCloserDispatchFilePath(root, identity));
    mkdirSync(directory, { recursive: true });
    for (let n = 0; n < count; n += 1) {
      writeFileSync(join(directory, `synthetic-history-${n}.json`), JSON.stringify({
        state: 'succeeded', scratchDir: `/synthetic-missing/history-${n}`,
        evidence: 'synthetic history '.repeat(250),
      }));
    }
    return directory;
  }
  return { root, promptDir, logs, options, scratch, record, history };
}

function syntheticCensus({ ps = '123 synthetic-idle-process', lsof = 'p123\nn/fixture/unrelated' } = {}) {
  return args => readHammerScratchProcessSnapshot({ ...args,
    execFileImpl: async command => ({ stdout: command === 'ps' ? ps : lsof }),
  });
}

function sweepSummary(f) {
  const summaries = f.logs.filter(line => line.startsWith('{')).map(line => JSON.parse(line))
    .filter(row => row.event === 'ama_closer.scratch_sweep_summary');
  assert.equal(summaries.length, 1, 'one reason-count summary per sweep');
  return summaries[0];
}

test('SCRATCHCENSUS-02: unrelated open audit files named after owner ids do not protect terminal scratch', async t => {
  const f = fixture(t);
  const path = f.scratch();
  f.record(path, { workerId: 'synthetic-worker' });
  const removed = await sweepHammerScratchDirs(f.root, { ...f.options,
    readProcessSnapshotImpl: syntheticCensus({
      ps: '123 synthetic-log-shipper',
      lsof: 'p123\nn/fixture/dispatch/audit/synthetic-lrq.jsonl\nn/fixture/dispatch/audit/synthetic-worker.jsonl',
    }),
  });
  assert.equal(removed.length, 1);
  assert.equal(existsSync(path), false);
  assert.equal(sweepSummary(f).kept['process-references-id'], 0);
});

test('SCRATCHCENSUS-02: launch id in a process environment protects terminal scratch', async t => {
  const f = fixture(t);
  const path = f.scratch();
  f.record(path);
  const removed = await sweepHammerScratchDirs(f.root, { ...f.options,
    readProcessSnapshotImpl: syntheticCensus({ ps: '123 synthetic-hammer LAUNCH_REQUEST_ID=synthetic-lrq' }),
  });
  assert.deepEqual(removed, []);
  assert.equal(existsSync(path), true);
  assert.equal(sweepSummary(f).kept['process-references-id'], 1);
});

test('SCRATCHCENSUS-02: an open file inside scratch protects terminal scratch', async t => {
  const f = fixture(t);
  const path = f.scratch();
  f.record(path);
  assert.deepEqual(await sweepHammerScratchDirs(f.root, { ...f.options,
    readProcessSnapshotImpl: syntheticCensus({ lsof: `p123\nn${path}/nested/synthetic.log` }),
  }), []);
  assert.equal(existsSync(path), true);
  assert.equal(sweepSummary(f).kept['process-references-path'], 1);
});

test('SCRATCHCENSUS-02: summary counts each kept candidate by its first protection reason', async t => {
  const f = fixture(t);
  const paths = Array.from({ length: 7 }, () => f.scratch());
  for (const index of [0, 1, 3]) {
    const owner = f.record(paths[index], { launchRequestId: `synthetic-lrq-${index}`,
      state: index === 1 ? 'dispatching' : 'dispatched' });
    writeFileSync(join(dirname(owner), `synthetic-owner-${index}.json`), readFileSync(owner));
    rmSync(owner);
  }
  utimesSync(paths[4], new Date(nowMs), new Date(nowMs));
  utimesSync(join(paths[5], 'ci-failed.log'), new Date(nowMs), new Date(nowMs));
  const removed = await sweepHammerScratchDirs(f.root, { ...f.options,
    readWorkerStatusImpl: ({ launchRequestId }) => ({ ok: true,
      row: { status: launchRequestId === 'synthetic-lrq-0' ? 'running' : 'succeeded' } }),
    readProcessSnapshotImpl: syntheticCensus({ ps: `123 synthetic-hammer TMPDIR=${paths[2]} LAUNCH_REQUEST_ID=synthetic-lrq-3` }),
  });
  assert.equal(removed.length, 1);
  const summary = sweepSummary(f);
  assert.deepEqual(summary.kept, { 'live-owner': 1, 'non-terminal': 1,
    'process-references-path': 1, 'process-references-id': 1, 'too-young': 2 });
  assert.equal(summary.removed, 1);
  assert.equal(summary.remainingCandidates, 0);
  assert.equal(summary.completed, true);
  assert.ok(f.logs.every(line => !line.includes('LAUNCH_REQUEST_ID=')));
});

for (const [kind, fileName, protects] of [
  ['cwd', path => path, true],
  ['real cwd', path => realpathSync(path), true],
  ['real nested file', path => `${realpathSync(path)}/nested/synthetic.log`, true],
  ['sibling prefix', path => `${path}-other/synthetic.log`, false],
  ['embedded path', path => `/fixture/audit${path}/synthetic.log`, false],
]) {
  for (const [ending, newline] of [['LF', '\n'], ['CRLF', '\r\n']]) {
    test(`SCRATCHCENSUS-02: open-file path boundaries (${kind}, ${ending})`, async t => {
      const f = fixture(t);
      const path = f.scratch();
      f.record(path);
      const removed = await sweepHammerScratchDirs(f.root, { ...f.options,
        readProcessSnapshotImpl: syntheticCensus({ lsof: `p123${newline}n${fileName(path)}${newline}` }),
      });
      assert.equal(existsSync(path), protects);
      assert.equal(removed.length, protects ? 0 : 1);
      assert.equal(sweepSummary(f).kept['process-references-path'], protects ? 1 : 0);
    });
  }
}

for (const ps of ['123 synthetic-hammer --launch=synthetic-lrq',
  '123 synthetic-hammer WORKER_ID=synthetic-worker', '123 synthetic-hammer --worker=synthetic-worker']) {
  test(`SCRATCHCENSUS-02: process arguments and environments retain owner ids (${ps})`, async t => {
    const f = fixture(t);
    const path = f.scratch();
    f.record(path, { workerId: 'synthetic-worker' });
    assert.deepEqual(await sweepHammerScratchDirs(f.root, { ...f.options,
      readProcessSnapshotImpl: syntheticCensus({ ps }),
    }), []);
    assert.equal(existsSync(path), true);
    assert.equal(sweepSummary(f).kept['process-references-id'], 1);
  });
}

for (const snapshot of ['synthetic-secret-legacy-census', {},
  { ps: '123 synthetic-secret', lsof: '' }, { ps: '', lsof: 'p123\nn/fixture/synthetic-secret' }]) {
  test('SCRATCHCENSUS-02: malformed or partial split census fails closed without exposing contents', async t => {
    const f = fixture(t);
    const path = f.scratch();
    assert.deepEqual(await sweepHammerScratchDirs(f.root, { ...f.options,
      readProcessSnapshotImpl: () => snapshot,
    }), []);
    assert.equal(existsSync(path), true);
    assert.equal(sweepSummary(f).completed, false);
    assert.equal(sweepSummary(f).remainingCandidates, 1);
    assert.ok(f.logs.every(line => !line.includes('synthetic-secret')));
  });
}

test('SCRATCHCENSUS-01: 100 terminal candidates share a slow census and retain progress at the scan deadline', async t => {
  const f = fixture(t);
  for (let index = 0; index < 100; index += 1) {
    const path = f.scratch();
    const owner = f.record(path);
    writeFileSync(join(dirname(owner), `synthetic-owner-${index}.json`), readFileSync(owner));
    rmSync(owner);
  }
  let clock = nowMs;
  t.mock.method(Date, 'now', () => clock);
  let censusCalls = 0;
  const removed = await sweepHammerScratchDirs(f.root, { ...f.options, scanBudgetMs: 2500,
    readWorkerStatusImpl: () => {
      clock += 50;
      return { ok: true, row: { status: 'succeeded' } };
    },
    readProcessSnapshotImpl: async ({ timeout }) => {
      censusCalls += 1;
      clock += 1000; // One simulated second per full census; no host process reads.
      if (timeout < 1000) throw new Error('synthetic census timeout');
      return { ps: '123 synthetic-idle-process', lsof: 'p123\nn/fixture/unrelated' };
    },
  });
  assert.ok(removed.length > 0 && removed.length < 100);
  assert.equal(censusCalls, 1);
  assert.ok(!f.logs.some(line => line.includes('sweep deferred')));
  const progress = f.logs.map(line => JSON.parse(line)).find(row => row.event === 'ama_closer.scratch_sweep_paused');
  assert.equal(progress.reason, 'scan-budget');
  assert.equal(progress.removed, removed.length);
  assert.equal(progress.remainingCandidates, 100 - removed.length);
  assert.equal(sweepSummary(f).removed, removed.length);
  assert.equal(sweepSummary(f).completed, false);
  assert.equal(sweepSummary(f).remainingCandidates, progress.remainingCandidates);
});

test('SCRATCHCENSUS-01: a census path stays protected across a batch without repeated process reads', async t => {
  const f = fixture(t);
  const protectedPath = f.scratch();
  for (let index = 0; index < 5; index += 1) f.scratch();
  let calls = 0;
  const removed = await sweepHammerScratchDirs(f.root, { ...f.options,
    readProcessSnapshotImpl: ({ timeout }) => {
      calls += 1;
      assert.equal(timeout, 15_000);
      return { ps: `123 synthetic-hammer TMPDIR=${protectedPath}`, lsof: 'p123\nn/fixture/unrelated' };
    },
  });
  assert.equal(removed.length, 5);
  assert.equal(existsSync(protectedPath), true);
  assert.equal(calls, 1);
});

test('SCRATCHCENSUS-01: nonzero census exit defers every deletion and logs only duration and byte counts', async t => {
  const f = fixture(t);
  const paths = [f.scratch(), f.scratch(), f.scratch()];
  const removed = await sweepHammerScratchDirs(f.root, { ...f.options,
    readProcessSnapshotImpl: args => readHammerScratchProcessSnapshot({ ...args,
      execFileImpl: async command => {
        if (command === 'lsof') throw Object.assign(new Error('synthetic-secret-output'), { code: 1 });
        return { stdout: '123 synthetic-secret-environment' };
      },
    }),
  });
  assert.deepEqual(removed, []);
  assert.ok(paths.every(existsSync));
  assert.ok(f.logs.some(line => line.includes('sweep deferred: unreadable process census')));
  const diagnostic = f.logs.filter(line => line.startsWith('{')).map(line => JSON.parse(line))
    .find(row => row.event === 'ama_closer.scratch_process_census');
  assert.equal(diagnostic.outcome, 'unreadable');
  assert.ok(diagnostic.durationMs >= 0);
  assert.equal(diagnostic.psBytes, Buffer.byteLength('123 synthetic-secret-environment'));
  assert.equal(diagnostic.lsofBytes, 0);
  assert.ok(f.logs.every(line => !line.includes('synthetic-secret')));
});

for (const refreshedLive of [false, true]) {
  test(`SCRATCHCENSUS-01: refresh once after 30 seconds and stop before a third census (live=${refreshedLive})`, async t => {
    const f = fixture(t);
    for (let index = 0; index < 4; index += 1) {
      const owner = f.record(f.scratch());
      writeFileSync(join(dirname(owner), `synthetic-owner-${index}.json`), readFileSync(owner));
      rmSync(owner);
    }
    let clock = nowMs;
    t.mock.method(Date, 'now', () => clock);
    let calls = 0;
    let completed = false;
    const removed = await sweepHammerScratchDirs(f.root, { ...f.options, scanBudgetMs: 200_000,
      readWorkerStatusImpl: () => {
        clock += 31_000;
        return { ok: true, row: { status: 'succeeded' } };
      },
      readProcessSnapshotImpl: ({ timeout }) => {
        calls += 1;
        assert.equal(timeout, 15_000);
        return { ps: refreshedLive && calls === 2 ? '123 synthetic-lrq' : '123 synthetic-idle-process',
          lsof: 'p123\nn/fixture/unrelated' };
      },
      onSweepComplete: () => { completed = true; },
    });
    assert.equal(calls, 2);
    assert.equal(removed.length, refreshedLive ? 1 : 2);
    assert.equal(completed, false);
    const progress = JSON.parse(f.logs.at(-1));
    assert.equal(progress.reason, 'census-expired');
    assert.equal(progress.remainingCandidates, 2);
    assert.ok(!f.logs.some(line => line.includes('sweep deferred')));
  });
}

for (const afterRefresh of ['idle', 'process', 'worker', 'owner', 'expired']) {
  test(`SCRATCHCENSUS-01: expiration during final checks refreshes and revalidates the candidate (${afterRefresh})`, async t => {
    const f = fixture(t);
    const paths = [f.scratch(), f.scratch()];
    for (let index = 0; index < paths.length; index += 1) {
      const owner = f.record(paths[index]);
      writeFileSync(join(dirname(owner), `synthetic-owner-${index}.json`), readFileSync(owner));
      rmSync(owner);
    }
    let clock = nowMs;
    let ticking = false;
    let censusStartedAt;
    let calls = 0;
    let completed = false;
    t.mock.method(Date, 'now', () => ticking ? clock++ : clock);
    const removed = await sweepHammerScratchDirs(f.root, { ...f.options, scanBudgetMs: 200_000,
      readWorkerStatusImpl: () => {
        if (calls === 1 || (calls === 2 && afterRefresh === 'expired')) {
          // Enter with a fresh census, then cross 30 seconds during final checks.
          clock = censusStartedAt + 29_997;
          ticking = true;
        }
        return { ok: true, row: { status: calls === 2 && afterRefresh === 'worker' ? 'running' : 'succeeded' } };
      },
      readProcessSnapshotImpl: () => {
        calls += 1;
        censusStartedAt = clock;
        ticking = false;
        if (calls === 2 && afterRefresh === 'owner') {
          const directory = dirname(amaCloserDispatchFilePath(f.root, identity));
          for (let index = 0; index < paths.length; index += 1) {
            writeFileSync(join(directory, `synthetic-owner-${index}.json`), JSON.stringify({ state: 'dispatching' }));
          }
        }
        return { ps: calls === 2 && afterRefresh === 'process' ? '123 synthetic-lrq' : '123 synthetic-idle-process',
          lsof: 'p123\nn/fixture/unrelated' };
      },
      onSweepComplete: () => { completed = true; },
    });
    assert.equal(calls, 2);
    assert.equal(removed.length, afterRefresh === 'idle' ? 2 : 1);
    assert.equal(paths.filter(existsSync).length, afterRefresh === 'idle' ? 0 : 1);
    assert.equal(completed, afterRefresh !== 'expired');
    const pauses = f.logs.map(line => JSON.parse(line)).filter(row => row.event === 'ama_closer.scratch_sweep_paused');
    assert.deepEqual(pauses.map(row => [row.reason, row.remainingCandidates]), afterRefresh === 'expired' ? [['census-expired', 1]] : []);
  });
}

test('SCRATCHCENSUS-01: successful census measures UTF-8 bytes without exposing process contents', async () => {
  const logs = [];
  const outputs = { ps: '123 synthetic-secret-é', lsof: 'p123\nn/synthetic-secret-λ' };
  const snapshot = await readHammerScratchProcessSnapshot({ timeout: 15_000,
    logger: { info: line => logs.push(line) },
    execFileImpl: async command => ({ stdout: outputs[command] }),
  });
  assert.deepEqual(snapshot, outputs);
  assert.equal(logs.length, 1);
  const diagnostic = JSON.parse(logs[0]);
  assert.equal(diagnostic.outcome, 'ok');
  assert.equal(diagnostic.psBytes, Buffer.byteLength(outputs.ps));
  assert.equal(diagnostic.lsofBytes, Buffer.byteLength(outputs.lsof));
  assert.ok(diagnostic.durationMs >= 0);
  assert.ok(!logs[0].includes('synthetic-secret'));
});

for (const status of ['succeeded', 'canceled']) {
  test(`HAMTMP-05: ledger ${status} reclaims old scratch owned by a starting record`, async t => {
    const f = fixture(t);
    const path = f.scratch();
    f.record(path, { lastObservedStatus: 'starting' });
    const calls = [];
    const removed = await sweepHammerScratchDirs(f.root, { ...f.options,
      readLaunchRequestStatusImpl: args => {
        calls.push(args);
        return { ok: true, row: { status } };
      } });
    assert.equal(removed.length, 1);
    assert.equal(existsSync(path), false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].launchRequestId, 'synthetic-lrq');
  });
}

test('HAMTMP-05: injected subprocess handles launch and worker ledger probes within the scan budget', async t => {
  const f = fixture(t);
  const path = f.scratch();
  f.record(path, { lastObservedStatus: 'starting' });
  const calls = [];
  const env = { SYNTHETIC_LEDGER: 'fixture' };
  const probe = name => ({ spawnSyncImpl }) => {
    const result = spawnSyncImpl('synthetic-ledger', [name], { timeout: 60_000, encoding: 'utf8', env });
    assert.equal(result.stdout, 'synthetic response');
    return { ok: true, row: { status: 'succeeded' } };
  };
  const removed = await sweepHammerScratchDirs(f.root, { ...f.options, scanBudgetMs: 5000,
    spawnSyncImpl: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, stdout: 'synthetic response' };
    },
    readLaunchRequestStatusImpl: probe('launch'),
    readWorkerStatusImpl: probe('worker'),
  });
  assert.equal(removed.length, 1);
  assert.equal(existsSync(path), false);
  assert.deepEqual(calls.map(call => call.args), [['launch'], ['worker']]);
  for (const call of calls) {
    assert.equal(call.command, 'synthetic-ledger');
    assert.equal(call.options.encoding, 'utf8');
    assert.equal(call.options.env, env);
    assert.ok(call.options.timeout > 0 && call.options.timeout <= 5000);
  }
});

test('HAMTMP-05: a running launch protects starting scratch until the ledger is terminal', async t => {
  const f = fixture(t);
  const path = f.scratch();
  f.record(path, { lastObservedStatus: 'starting' });
  let probes = 0;
  assert.deepEqual(await sweepHammerScratchDirs(f.root, { ...f.options,
    readLaunchRequestStatusImpl: () => { probes += 1; return { ok: true, row: { status: 'running' } }; },
    readPullRequestStateImpl: () => ({ state: 'MERGED' }),
  }), []);
  assert.equal(probes, 1, 'consult ledger truth even when the record still says starting');
  assert.equal(existsSync(path), true);
  assert.equal((await sweepHammerScratchDirs(f.root, f.options)).length, 1);
});

test('HAMTMP-05: unreadable launch ledger blocks reclaim and reports deferral', async t => {
  const f = fixture(t);
  const path = f.scratch();
  f.record(path, { lastObservedStatus: 'starting' });
  assert.deepEqual(await sweepHammerScratchDirs(f.root, { ...f.options,
    readLaunchRequestStatusImpl: () => ({ ok: false, reason: 'synthetic-ledger-unavailable' }),
    readPullRequestStateImpl: () => assert.fail('unreadable ledger must block PR fallback'),
  }), []);
  assert.equal(existsSync(path), true);
  assert.match(f.logs[0], /sweep deferred.*unreadable launch ledger/);
  assert.equal((await sweepHammerScratchDirs(f.root, f.options)).length, 1);
});

for (const state of ['MERGED', 'CLOSED', 'OPEN']) {
  test(`HAMTMP-05: legacy starting owner with missing launch row uses live PR state ${state}`, async t => {
    const f = fixture(t);
    const path = f.scratch();
    f.record(path, { lastObservedStatus: 'starting' });
    const removed = await sweepHammerScratchDirs(f.root, { ...f.options,
      readLaunchRequestStatusImpl: () => ({ ok: false, reason: 'missing-launch-request-row' }),
      readWorkerStatusImpl: () => ({ ok: false, reason: 'missing-worker-run-row' }),
      readPullRequestStateImpl: args => {
        assert.equal(args.repo, identity.repo);
        assert.ok(args.timeout > 0 && args.timeout <= 5000);
        return { state };
      },
    });
    assert.equal(removed.length, state === 'OPEN' ? 0 : 1);
    assert.equal(existsSync(path), state === 'OPEN');
  });
}

test('HAMTMP-05: a failed legacy PR read preserves its scratch and continues the sweep', async t => {
  const f = fixture(t);
  const paths = [f.scratch(), f.scratch(), f.scratch()];
  for (const [index, path] of paths.entries()) {
    const owner = f.record(path, { prNumber: index + 1, lastObservedStatus: 'starting' });
    writeFileSync(join(dirname(owner), `synthetic-pr-${index + 1}.json`), readFileSync(owner));
    rmSync(owner);
  }
  const probes = [];
  let completed = false;
  const removed = await sweepHammerScratchDirs(f.root, { ...f.options,
    readLaunchRequestStatusImpl: () => ({ ok: false, reason: 'missing-launch-request-row' }),
    readWorkerStatusImpl: () => ({ ok: false, reason: 'missing-worker-run-row' }),
    readPullRequestStateImpl: async ({ prNumber }) => {
      probes.push(prNumber);
      if (probes.length === 1) throw new Error('synthetic gh subprocess failure');
      return { state: 'MERGED' };
    },
    onSweepComplete: () => { completed = true; },
  });
  assert.equal(probes.length, 3, 'a failed PR lookup must not abort independent candidates');
  assert.equal(removed.length, 2);
  assert.equal(completed, true);
  for (const [index, path] of paths.entries()) {
    assert.equal(existsSync(path), index + 1 === probes[0], 'only the unreadable PR retains scratch');
  }
});

test('HAMTMP-05: terminal launch still retains scratch referenced by a live process', async t => {
  const f = fixture(t);
  const path = f.scratch();
  f.record(path, { lastObservedStatus: 'starting' });
  assert.deepEqual(await sweepHammerScratchDirs(f.root, { ...f.options,
    readProcessSnapshotImpl: () => ({ ps: `123 synthetic-hammer TMPDIR=${path}`, lsof: 'p123\nn/fixture/unrelated' }) }), []);
  assert.equal(existsSync(path), true);
});

test('HAMTMP-05: real offline launch ledger controls starting records', async t => {
  const { createRequire } = await import('node:module');
  const Database = createRequire(import.meta.url)('better-sqlite3');
  const f = fixture(t);
  const path = f.scratch();
  f.record(path, { lastObservedStatus: 'starting' });
  const ledgerDbPath = join(f.root, 'synthetic-ledger.sqlite');
  const db = new Database(ledgerDbPath);
  t.after(() => db.close());
  db.exec('CREATE TABLE launch_requests (launch_request_id TEXT PRIMARY KEY, status TEXT, updated_at TEXT, terminal_at TEXT, failure_class TEXT)');
  db.prepare('INSERT INTO launch_requests VALUES (?, ?, NULL, NULL, NULL)').run('synthetic-lrq', 'running');
  const options = { ...f.options, ledgerDbPath, env: { AGENT_OS_SESSION_LEDGER_BACKEND: 'sqlite' } };
  delete options.readLaunchRequestStatusImpl;
  assert.deepEqual(await sweepHammerScratchDirs(f.root, options), []);
  assert.equal(existsSync(path), true);
  db.prepare('UPDATE launch_requests SET status = ?').run('succeeded');
  assert.equal((await sweepHammerScratchDirs(f.root, options)).length, 1);
  assert.equal(existsSync(path), false);
});

test('HAMTMP-04: a cold sweep reclaims old scratch with more history than the former read cap', async t => {
  const f = fixture(t);
  const orphan = f.scratch();
  const live = f.scratch();
  f.record(live, { lastObservedStatus: 'running' });
  f.options.readLaunchRequestStatusImpl = () => ({ ok: true, row: { status: 'running' } });
  f.history(3509);
  const { sweepHammerScratchDirs: coldSweep } = await freshSweeper();
  assert.equal((await coldSweep(f.root, f.options)).length, 1);
  assert.equal(existsSync(orphan), false);
  assert.equal(existsSync(live), true);
});

test('HAMTMP-04: unreadable ownership blocks a large census until repaired, including after restart', async t => {
  const f = fixture(t);
  const scratch = f.scratch();
  const owner = f.record(scratch);
  f.history(1153);
  writeFileSync(owner, 'synthetic unreadable JSON');
  const { sweepHammerScratchDirs: firstSweep } = await freshSweeper();
  assert.deepEqual(await firstSweep(f.root, f.options), []);
  assert.equal(existsSync(scratch), true);
  f.record(scratch);
  const { sweepHammerScratchDirs: restartedSweep } = await freshSweeper();
  assert.equal((await restartedSweep(f.root, f.options)).length, 1);
  assert.equal(existsSync(scratch), false, 'repaired ownership must allow an effective sweep');
});

test('HAMTMP-04: partial fingerprint indexing survives repeated watcher restarts', async t => {
  const f = fixture(t);
  const orphan = f.scratch();
  f.history(5);
  for (let pass = 0; pass < 5; pass += 1) {
    const { sweepHammerScratchDirs: restartedSweep } = await freshSweeper();
    const removed = await restartedSweep(f.root, { ...f.options, maxRecordReads: 1 });
    assert.equal(removed.length, pass === 4 ? 1 : 0);
    assert.equal(existsSync(orphan), pass !== 4);
  }
});

test('HAMTMP-04: a scan deadline checkpoints its prefix before a restart', async t => {
  const f = fixture(t);
  const orphan = f.scratch();
  f.history(5);
  const { sweepHammerScratchDirs: firstSweep } = await freshSweeper();
  let clockReads = 0;
  const clock = t.mock.method(Date, 'now', () => clockReads++ < 3 ? 1000 : 1001);
  try {
    assert.deepEqual(await firstSweep(f.root, { ...f.options, scanBudgetMs: 1 }), []);
  } finally { clock.mock.restore(); }
  const progress = f.logs.map(line => JSON.parse(line)).find(row => row.event === 'ama_closer.scratch_sweep_paused');
  assert.equal(progress.reason, 'scan-budget');
  assert.equal(progress.remainingCandidates, 1);
  assert.equal(existsSync(orphan), true);
  const { sweepHammerScratchDirs: restartedSweep } = await freshSweeper();
  assert.equal((await restartedSweep(f.root, { ...f.options, maxRecordReads: 3 })).length, 1);
  assert.equal(existsSync(orphan), false);
});

test('HAMTMP-04: a persisted fingerprint cannot hide a changed live owner after restart', async t => {
  const f = fixture(t);
  const owned = f.scratch();
  f.record(owned);
  f.history(3);
  const { sweepHammerScratchDirs: firstSweep } = await freshSweeper();
  await firstSweep(f.root, { ...f.options, maxRemovals: 0 });
  f.record(owned, { lastObservedStatus: 'running' });
  f.options.readLaunchRequestStatusImpl = () => ({ ok: true, row: { status: 'running' } });
  const orphan = f.scratch();
  const { sweepHammerScratchDirs: restartedSweep } = await freshSweeper();
  assert.deepEqual(await restartedSweep(f.root, { ...f.options, maxRecordReads: 0 }), []);
  assert.equal(existsSync(orphan), true, 'stale cached ownership cannot authorize deletion');
  assert.equal((await restartedSweep(f.root, { ...f.options, maxRecordReads: 1 })).length, 1);
  assert.equal(existsSync(owned), true);
  assert.equal(existsSync(orphan), false);
});

test('HAMTMP-04: a corrupt checkpoint falls back to source records and preserves unreadable ownership', async t => {
  const f = fixture(t);
  const owned = f.scratch();
  const owner = f.record(owned, { lastObservedStatus: 'running' });
  f.options.readLaunchRequestStatusImpl = () => ({ ok: true, row: { status: 'running' } });
  await sweepHammerScratchDirs(f.root, f.options);
  const checkpoint = join(f.root, 'data', 'follow-up-jobs', 'hammer-scratch-record-index.json');
  for (const contents of ['synthetic truncated checkpoint', JSON.stringify({ schemaVersion: 1,
    entries: [['../synthetic-escape.json', { version: 'synthetic', record: {} }]] })]) {
    writeFileSync(checkpoint, contents);
    writeFileSync(owner, 'synthetic unreadable ownership');
    const { sweepHammerScratchDirs: restartedSweep } = await freshSweeper();
    assert.deepEqual(await restartedSweep(f.root, f.options), []);
    assert.equal(existsSync(owned), true);
  }
});

test('HAMTMP-04: deferred first passes retry within a minute, then completed sweeps run hourly', async t => {
  const f = fixture(t);
  const orphan = f.scratch();
  f.history(3);
  let clock = nowMs;
  const ticker = createHammerScratchSweepTicker({ rootDir: f.root, ...f.options,
    now: () => clock, maxRecordReads: 1 });
  for (let pass = 0; pass < 3; pass += 1) {
    assert.equal((await ticker.tick()).length, pass === 2 ? 1 : 0);
    assert.equal(existsSync(orphan), pass !== 2);
    clock += 59_999;
    assert.deepEqual(await ticker.tick(), []);
    clock += 1;
  }
  const next = f.scratch();
  assert.deepEqual(await ticker.tick(), []);
  assert.equal(existsSync(next), true, 'a complete sweep switches to hourly maintenance');
  clock += HAMMER_SCRATCH_SWEEP_INTERVAL_MS - 60_000;
  assert.equal((await ticker.tick()).length, 1);
  assert.equal(existsSync(next), false);
});

test('HAMTMP-03: an orphan older than the bound is removed and its freed bytes are logged', async t => {
  const f = fixture(t);
  const orphan = f.scratch();
  const removed = await sweepHammerScratchDirs(f.root, f.options);
  assert.equal(existsSync(orphan), false);
  assert.equal(removed.length, 1);
  assert.ok(removed[0].bytesFreed > 0);
  assert.equal(f.logs.length, 2);
  assert.deepEqual(JSON.parse(f.logs[0]), { event: 'ama_closer.scratch_swept',
    name: removed[0].name, bytesFreed: removed[0].bytesFreed, reason: 'orphan' });
  assert.deepEqual(await sweepHammerScratchDirs(f.root, f.options), []);
});

test('HAMTMP-03: a live run survives an effective sweep even with an old directory', async t => {
  const f = fixture(t);
  const live = f.scratch();
  const orphan = f.scratch();
  f.record(live, { lastObservedStatus: 'running' });
  f.options.readLaunchRequestStatusImpl = () => ({ ok: true, row: { status: 'running' } });
  const removed = await sweepHammerScratchDirs(f.root, f.options);
  assert.equal(existsSync(live), true);
  assert.equal(existsSync(orphan), false, 'the sweep must actually run; a no-op is not protection');
  assert.equal(removed.length, 1);
});

test('HAMTMP-03: old terminal records are swept without changing merge authority', async t => {
  const f = fixture(t);
  const scratchDir = f.scratch();
  const path = f.record(scratchDir);
  const before = readFileSync(path, 'utf8');
  assert.equal((await sweepHammerScratchDirs(f.root, f.options)).length, 1);
  assert.equal(existsSync(scratchDir), false);
  assert.equal(readFileSync(path, 'utf8'), before);
  assert.equal(JSON.parse(f.logs[0]).reason, 'terminal');
});

for (const row of [{ status: 'succeeded', pid: 12345 }, { status: 'running' }]) {
  test(`HAMTMP-03: live worker evidence protects a terminal record (${JSON.stringify(row)})`, async t => {
    const f = fixture(t);
    const path = f.scratch();
    f.record(path);
    await sweepHammerScratchDirs(f.root, { ...f.options,
      readWorkerStatusImpl: () => ({ ok: true, row }), processKillImpl: () => {} });
    assert.equal(existsSync(path), true);
  });
}

test('HAMTMP-03: a live orphan process retaining TMPDIR survives the sweep', async t => {
  const f = fixture(t);
  const path = f.scratch();
  await sweepHammerScratchDirs(f.root, { ...f.options,
    readProcessSnapshotImpl: () => ({ ps: `123 synthetic-hammer TMPDIR=${path}`, lsof: 'p123\nn/fixture/unrelated' }) });
  assert.equal(existsSync(path), true);
});

test('HAMTMP-03: a failed worker read is not treated as a missing worker', async t => {
  const f = fixture(t);
  const path = f.scratch();
  f.record(path);
  await sweepHammerScratchDirs(f.root, { ...f.options,
    readWorkerStatusImpl: () => ({ ok: false, reason: 'synthetic-database-unavailable' }) });
  assert.equal(existsSync(path), true);
});

for (const census of [() => '', () => { throw new Error('synthetic census failure'); }]) {
  test('HAMTMP-03: unreadable process evidence preserves orphans and reports deferral', async t => {
    const f = fixture(t);
    const path = f.scratch();
    await sweepHammerScratchDirs(f.root, { ...f.options, readProcessSnapshotImpl: census });
    assert.equal(existsSync(path), true);
    assert.match(f.logs[0], /sweep deferred/);
  });
}

test('HAMTMP-03: corrupt records never turn a live owner into an orphan', async t => {
  const f = fixture(t);
  const path = f.scratch();
  writeFileSync(f.record(path), 'synthetic invalid JSON');
  await sweepHammerScratchDirs(f.root, f.options);
  assert.equal(existsSync(path), true);
  assert.match(f.logs[0], /sweep deferred/);
});

test('HAMTMP-03: young directories and recently modified nested evidence survive', async t => {
  const f = fixture(t);
  const young = createHammerScratchDir(f.promptDir);
  utimesSync(young, new Date(nowMs), new Date(nowMs));
  const active = f.scratch();
  const nested = join(active, 'pytest-of-synthetic');
  mkdirSync(nested);
  writeFileSync(join(nested, 'ledger.db-wal'), 'synthetic recent WAL');
  utimesSync(nested, new Date(nowMs), new Date(nowMs));
  utimesSync(join(nested, 'ledger.db-wal'), new Date(nowMs), new Date(nowMs));
  utimesSync(active, old, old);
  await sweepHammerScratchDirs(f.root, f.options);
  assert.equal(existsSync(young), true);
  assert.equal(existsSync(active), true);
});

test('HAMTMP-03: dispatching intents retain scratch despite inherited terminal status', async t => {
  const f = fixture(t);
  const path = f.scratch();
  f.record(path, { state: 'dispatching' });
  assert.deepEqual(await sweepHammerScratchDirs(f.root, f.options), []);
  assert.equal(existsSync(path), true);
});

test('HAMTMP-03: sweep never follows scratch or parent symlinks or removes other names', async t => {
  const f = fixture(t);
  const outside = join(f.root, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'keep'), 'synthetic evidence');
  mkdirSync(f.promptDir, { recursive: true });
  symlinkSync(outside, join(f.promptDir, 'hammer-scratch-link'), 'dir');
  mkdirSync(join(f.promptDir, 'other-state'));
  const path = f.scratch();
  symlinkSync(outside, join(path, 'nested-link'), 'dir');
  lutimesSync(join(path, 'nested-link'), old, old);
  utimesSync(path, old, old);
  await sweepHammerScratchDirs(f.root, f.options);
  assert.equal(existsSync(path), false);
  assert.equal(existsSync(join(outside, 'keep')), true);
  assert.equal(existsSync(join(f.promptDir, 'hammer-scratch-link')), true);
  assert.equal(existsSync(join(f.promptDir, 'other-state')), true);
  rmSync(f.promptDir, { recursive: true });
  symlinkSync(outside, f.promptDir, 'dir');
  assert.deepEqual(await sweepHammerScratchDirs(f.root, f.options), []);
  assert.equal(existsSync(join(outside, 'keep')), true);
});

test('HAMTMP-03: batch and time limits bound sweep work', async t => {
  const f = fixture(t);
  const paths = [f.scratch(), f.scratch(), f.scratch()];
  assert.equal((await sweepHammerScratchDirs(f.root, { ...f.options, maxRemovals: 1 })).length, 1);
  assert.equal(paths.filter(existsSync).length, 2);
  assert.deepEqual(await sweepHammerScratchDirs(f.root, { ...f.options, scanBudgetMs: 0 }), []);
  assert.equal(paths.filter(existsSync).length, 2);
});

test('HAMTMP-03: ownership changes during worker probing prevent removal', async t => {
  const f = fixture(t);
  const path = f.scratch();
  f.record(path);
  await sweepHammerScratchDirs(f.root, { ...f.options, readWorkerStatusImpl: () => {
    f.record(path, { lastObservedStatus: 'running' });
    return { ok: true, row: { status: 'succeeded' } };
  } });
  assert.equal(existsSync(path), true);
});

test('HAMTMP-03: historical JSON indexing advances across bounded passes and refreshes changed owners', async t => {
  const f = fixture(t);
  const orphan = f.scratch();
  const terminal = f.scratch();
  const owner = f.record(terminal);
  const historical = [];
  for (let n = 0; n < 4; n += 1) {
    const path = join(dirname(owner), `historical-${n}.json`);
    writeFileSync(path, JSON.stringify({ state: 'succeeded', scratchDir: `/gone/${n}` }));
    historical.push(path);
  }
  const options = { ...f.options, maxRecordReads: 1 };
  for (let pass = 0; pass < 4; pass += 1) {
    assert.deepEqual(await sweepHammerScratchDirs(f.root, options), []);
    assert.equal(existsSync(orphan), true, 'partial ownership evidence cannot authorize deletion');
  }
  f.record(terminal, { lastObservedStatus: 'running' });
  options.readLaunchRequestStatusImpl = () => ({ ok: true, row: { status: 'running' } });
  // A changed owner consumes a new read regardless of enumeration order.
  await sweepHammerScratchDirs(f.root, options);
  await sweepHammerScratchDirs(f.root, options);
  assert.equal(existsSync(orphan), false, 'unchanged history must not starve reclamation');
  assert.equal(existsSync(terminal), true, 'cached terminal state cannot override a new live owner');
  writeFileSync(historical[0], 'invalid JSON');
  const nextOrphan = f.scratch();
  assert.deepEqual(await sweepHammerScratchDirs(f.root, options), []);
  assert.equal(existsSync(nextOrphan), true, 'new corruption invalidates the cached evidence');
});

test('HAMTMP-03: indexed history still admits new owners and refuses replaced records', async t => {
  const f = fixture(t);
  const terminal = f.scratch();
  const owner = f.record(terminal, { lastObservedStatus: 'running' });
  f.options.readLaunchRequestStatusImpl = () => ({ ok: true, row: { status: 'running' } });
  await sweepHammerScratchDirs(f.root, { ...f.options, maxRecordReads: 1 });
  const newlyOwned = f.scratch();
  const newOwner = join(dirname(owner), 'new-owner.json');
  writeFileSync(newOwner, JSON.stringify({ state: 'dispatched', scratchDir: newlyOwned,
    lastObservedStatus: 'running' }));
  assert.deepEqual(await sweepHammerScratchDirs(f.root, { ...f.options, maxRecordReads: 0 }), []);
  await sweepHammerScratchDirs(f.root, { ...f.options, maxRecordReads: 1 });
  assert.equal(existsSync(newlyOwned), true);
  const orphan = f.scratch();
  rmSync(newOwner);
  symlinkSync(owner, newOwner);
  assert.deepEqual(await sweepHammerScratchDirs(f.root, f.options), []);
  assert.equal(existsSync(orphan), true);
});

test('HAMTMP-03: ticker runs at startup, hourly, and never overlaps', async () => {
  let clock = nowMs;
  let calls = 0;
  let finish;
  const ticker = createHammerScratchSweepTicker({ rootDir: '/fixture/state', now: () => clock,
    sweepImpl: (_root, options) => {
      calls += 1;
      return new Promise(resolve => { finish = result => { options.onSweepComplete(); resolve(result); }; });
    } });
  const first = ticker.tick();
  assert.equal(calls, 1);
  clock += HAMMER_SCRATCH_SWEEP_INTERVAL_MS;
  assert.deepEqual(await ticker.tick(), []);
  finish([]);
  await first;
  const second = ticker.tick();
  assert.equal(calls, 2);
  finish([]);
  await second;
  clock += HAMMER_SCRATCH_SWEEP_INTERVAL_MS - 1;
  assert.deepEqual(await ticker.tick(), []);
  assert.equal(calls, 2);
});

for (const status of ['requested', 'failed']) {
  test(`SCRATCHRACE-01: sweep respects a ${status} transitive fleet retry over a terminal owner`, async t => {
    const f = fixture(t);
    const scratch = f.scratch();
    f.record(scratch, { launchRequestId: 'synthetic-lrq', state: 'launch-terminal', lastObservedStatus: 'failed' });
    const ledgerTarget = launchRetryFixture(f.root, status);
    const result = await sweepHammerScratchDirs(f.root, { ...f.options, ledgerTarget,
      readLaunchRequestStatusImpl: readLaunchRequestStatusFromLedgerAsync });
    assert.equal(existsSync(scratch), status === 'requested', JSON.stringify(result));
  });
}
