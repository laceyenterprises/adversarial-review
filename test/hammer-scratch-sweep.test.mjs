import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lutimesSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { amaCloserDispatchFilePath, createHammerScratchDir } from '../src/ama/dispatch-closer.mjs';
import { createHammerScratchSweepTicker, HAMMER_SCRATCH_MAX_AGE_MS,
  HAMMER_SCRATCH_SWEEP_INTERVAL_MS, readHammerScratchProcessSnapshot, sweepHammerScratchDirs } from '../src/ama/hammer-scratch-sweep.mjs';

const nowMs = Date.parse('2026-10-16T12:00:00Z');
const old = new Date(nowMs - HAMMER_SCRATCH_MAX_AGE_MS - 60_000);
const identity = { repo: 'fixture/repo', prNumber: 42, headSha: 'synthetic-head' };

for (const platform of ['darwin', 'linux']) {
  test(`HAMTMP-03: ${platform} process census includes environments, cwd and open files with bounded commands`, async () => {
    const calls = [];
    const snapshot = await readHammerScratchProcessSnapshot({ timeout: 1234, platform,
      execFileImpl: async (command, args, options) => {
        calls.push({ command, args, options });
        return { stdout: command === 'ps' ? '123 synthetic-hammer TMPDIR=/fixture/scratch' : 'p123\nn/fixture/open-file' };
      } });
    assert.match(snapshot, /TMPDIR=\/fixture\/scratch/);
    assert.match(snapshot, /n\/fixture\/open-file/);
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
    readProcessSnapshotImpl: async () => '123 synthetic-idle-process',
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
  return { root, promptDir, logs, options, scratch, record };
}

test('HAMTMP-03: an orphan older than the bound is removed and its freed bytes are logged', async t => {
  const f = fixture(t);
  const orphan = f.scratch();
  const removed = await sweepHammerScratchDirs(f.root, f.options);
  assert.equal(existsSync(orphan), false);
  assert.equal(removed.length, 1);
  assert.ok(removed[0].bytesFreed > 0);
  assert.equal(f.logs.length, 1);
  assert.deepEqual(JSON.parse(f.logs[0]), { event: 'ama_closer.scratch_swept',
    name: removed[0].name, bytesFreed: removed[0].bytesFreed, reason: 'orphan' });
  assert.deepEqual(await sweepHammerScratchDirs(f.root, f.options), []);
});

test('HAMTMP-03: a live run survives an effective sweep even with an old directory', async t => {
  const f = fixture(t);
  const live = f.scratch();
  const orphan = f.scratch();
  f.record(live, { lastObservedStatus: 'running' });
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
    readProcessSnapshotImpl: () => `123 synthetic-hammer TMPDIR=${path}` });
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
    sweepImpl: () => { calls += 1; return new Promise(resolve => { finish = resolve; }); } });
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
