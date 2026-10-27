import './helpers/load-aware-timeout-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { captureCloserProcessSync, captureCloserProcess, probeCloserSubmitter } from '../src/ama/dispatch-submitter.mjs';

const stamp = 'Thu Oct 22 10:18:18 2026';
const startedAt = '2026-10-22T10:18:18.000Z';
const record = { dispatchIdempotencyKey: 'synthetic-dispatch-key',
  dispatchWatcher: { pid: 12345, startedAt }, dispatchSubmitter: { pid: 12346, startedAt } };
const dead = () => { throw Object.assign(Error('absent'), { code: 'ESRCH' }); };

for (const suffix of ['', ' ', '   ']) {
  for (const pid of [0, 12345, 12346]) {
    test(`empty command process row remains distinct: pid=${pid}, spaces=${suffix.length}`, () => {
      const result = probeCloserSubmitter(record, { watcherPid: 12345 }, {
        processKillImpl: dead,
        processExecFileSyncImpl: () => `99 ${stamp} unrelated\n${pid} ${stamp}${suffix}\n`,
      });
      assert.equal(result.reason, undefined);
      assert.equal(result.watcher.status, pid === 12345 ? 'live' : 'gone');
      assert.equal(result.submitter.status, pid === 12346 ? 'live' : 'gone');
      assert.equal(result.key.status, 'absent');
    });
  }
}

test('continuation containing the dispatch key belongs to the empty-command row', () => {
  const result = probeCloserSubmitter(record, { watcherPid: 12345 }, {
    processKillImpl: dead,
    processExecFileSyncImpl: () => `99 ${stamp} unrelated\n12346 ${stamp}\n${record.dispatchIdempotencyKey}\n`,
  });
  assert.equal(result.submitter.status, 'live');
  assert.deepEqual(result.key.pids, [12346]);
});

test('capture and scan preserve caller environment with fixed locale and timezone', async () => {
  const env = { PATH: '/synthetic/tool-path', LC_ALL: 'fr_FR', TZ: 'Pacific/Honolulu' };
  const check = options => {
    assert.equal(options.env.PATH, env.PATH);
    assert.equal(options.env.LC_ALL, 'C');
    assert.equal(options.env.TZ, 'UTC');
    assert.equal(options.env.HOME, process.env.HOME);
    assert.equal(options.timeout, 1000);
  };
  const captured = await captureCloserProcess(12346, { env,
    processExecFileImpl: async (command, args, options) => {
      assert.equal(command, 'ps');
      assert.deepEqual(args, ['-o', 'lstart=', '-p', '12346']);
      check(options);
      return { stdout: `${stamp}\n` };
    },
  });
  assert.deepEqual(captured, { pid: 12346, startedAt });
  const result = probeCloserSubmitter(record, { watcherPid: 12345 }, { env,
    processKillImpl: dead,
    processExecFileSyncImpl: (_command, _args, options) => {
      check(options);
      return `99 ${stamp} unrelated\n`;
    },
  });
  assert.equal(result.key.status, 'absent');
  assert.deepEqual(env, { PATH: '/synthetic/tool-path', LC_ALL: 'fr_FR', TZ: 'Pacific/Honolulu' });
});

test('capture yields to the event loop and fails closed on an asynchronous probe error', async () => {
  let ticked = false;
  const capture = captureCloserProcess(12346, {
    processExecFileImpl: async () => {
      await new Promise(resolve => setImmediate(() => { ticked = true; resolve(); }));
      throw Object.assign(Error('timeout'), { code: 'ETIMEDOUT' });
    },
  });
  assert.equal(ticked, false);
  assert.deepEqual(await capture, { pid: 12346, startedAt: null });
  assert.equal(ticked, true);
  assert.equal(await captureCloserProcess(0), null);
});


test('CLOSERLEASEDEAD-01 synchronous process identity uses normalized bounded ps evidence', () => {
  assert.deepEqual(captureCloserProcessSync(4242, { processExecFileSyncImpl: (command, args, options) => {
    assert.equal(command, 'ps');
    assert.deepEqual(args, ['-o', 'lstart=', '-p', '4242']);
    assert.equal(options.timeout, 1000);
    assert.equal(options.env.TZ, 'UTC');
    return stamp;
  } }), { pid: 4242, startedAt });
  for (const processExecFileSyncImpl of [() => '', () => 'malformed', () => { throw Error('unreadable'); }]) {
    assert.deepEqual(captureCloserProcessSync(4242, { processExecFileSyncImpl }), { pid: 4242, startedAt: null });
  }
});
