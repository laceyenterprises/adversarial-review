import './helpers/dispatch-files-preload.mjs';
import './helpers/load-aware-timeout-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { captureCloserProcess, captureCloserProcessSync, probeCloserSubmitter } from '../src/ama/dispatch-submitter.mjs';
import { hammerNetworkCall, hammerLocalGit } from '../src/ama/hammer-api-network.mjs';
import { currencyGit, createReviewCurrencyReader } from '../src/ama/review-currency.mjs';
import { probeCompanionWait } from '../src/ama/companion-stop-wait.mjs';
import { reapCloserHammerWorktrees } from '../src/ama/closer-worktree-reaper.mjs';

const timeout = () => Object.assign(Error('synthetic timed out'), { code: 'ETIMEDOUT', killed: true, signal: 'SIGTERM',
  stderr: 'no such process; is not a working tree' });
const quiet = { info() {}, log() {}, warn() {}, error() {} };
const sha = ch => ch.repeat(40);
function loaded(t) {
  t.mock.method(os, 'loadavg', () => [os.cpus().length * 3, 0, 0]);
  t.mock.method(childProcess, 'execFileSync', command => {
    assert.equal(command, '/bin/ps');
    return `${os.cpus().length * 100}\n`;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}
function temp(t) {
  const dir = mkdtempSync(join(os.tmpdir(), 'timeoutsweep-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

for (const command of ['git', 'gh']) test(`hammer ${command} retries scaled timeout and propagates exhaustion`, async t => {
  loaded(t);
  const dir = temp(t);
  const env = { ...process.env, HAMMER_LACEY_GH_TOKEN: 'synthetic-token', HAM_ROOT_DIR: dir,
    GHO_RATE_LIMIT_SHARED_STATE_PATH: join(dir, 'budget.json') };
  let calls = 0;
  const options = { env, sleep: async () => {}, execFileImpl: (_command, _args, opts) => {
    assert.equal(opts.timeout, 90000);
    if (++calls < 3) throw timeout();
    return Buffer.from('observed');
  } };
  assert.equal(String(await hammerNetworkCall(command, ['fetch'], undefined, options)), 'observed');
  calls = 0;
  await assert.rejects(hammerNetworkCall(command, ['fetch'], undefined, { ...options,
    execFileImpl: (_command, _args, opts) => { calls++; assert.equal(opts.timeout, 90000); throw timeout(); } }),
  { code: 'ETIMEDOUT' });
  assert.equal(calls, 3);
});

test('all submitter probes scale at call time and a slow scan cannot prove absence', async t => {
  loaded(t);
  const processExecFileSyncImpl = (_command, _args, opts) => { assert.equal(opts.timeout, 6000); throw timeout(); };
  const processExecFileImpl = async (...args) => processExecFileSyncImpl(...args);
  assert.deepEqual(captureCloserProcessSync(42, { processExecFileSyncImpl }), { pid: 42, startedAt: null });
  assert.deepEqual(await captureCloserProcess(42, { processExecFileImpl }), { pid: 42, startedAt: null });
  const result = probeCloserSubmitter({ dispatchIdempotencyKey: 'synthetic', dispatchSubmitter: { pid: 43 } },
    { watcherPid: 42 }, { processExecFileSyncImpl, processKillImpl: () => {} });
  assert.equal(result.submitter.status, 'unknown');
  assert.equal(result.key.status, 'unknown');
  assert.equal(result.reason, 'process-scan-unreadable');
});

test('currency git scales and rejects the timeout without consuming partial stdout', async t => {
  loaded(t);
  t.mock.method(childProcess, 'execFile', (_command, _args, opts, callback) => {
    assert.equal(opts.timeout, 90000);
    setImmediate(() => callback(timeout(), 'proof-looking-partial-output'));
    return { stdin: { on() {}, end() {} } };
  });
  syncBuiltinESMExports();
  await assert.rejects(currencyGit(['synthetic']), { code: 'ETIMEDOUT' });
  const reader = () => createReviewCurrencyReader({ repo: 'fixture/repo', prNumber: 1, comments: [],
    pr: { head: { sha: sha('b') }, base: { sha: sha('c') } },
    get: async () => ({ status: 'diverged' }), git: () => currencyGit(['synthetic']) });
  assert.equal((await reader()(sha('a'), sha('b'))).current, false);
  // A later evaluation can prove currency. No negative receipt was written.
  assert.equal((await reader()(sha('b'), sha('b'))).current, true);
});

test('companion read scales and a timeout cannot become open or closed', async t => {
  loaded(t);
  await assert.rejects(probeCompanionWait({ repo: 'fixture/repo', prNumber: 1, headSha: sha('a'),
    prMetadata: { baseSha: sha('b') }, stop: { companionWait: { repo: 'fixture/component', prNumber: 2, submodulePath: 'tools/component' } },
    execFileImpl: async (_command, _args, opts) => { assert.equal(opts.timeout, 90000); throw timeout(); } }),
  { code: 'ETIMEDOUT' });
});

for (const operation of ['remove', 'prune', 'tear-down']) test(`reaper ${operation} timeout stays incomplete and retries on next pass`, async t => {
  loaded(t);
  const root = temp(t), workerId = 'hammer-ama-pr-1-synthetic';
  const workerDir = join(root, 'workers', workerId), tree = join(workerDir, 'repo');
  mkdirSync(tree, { recursive: true });
  let slow = true, deletes = 0, attempts = 0;
  const options = { hqRoot: root, hqPath: '/synthetic/hq', repoPaths: ['/synthetic/repo'], cursorPath: join(root, 'cursor.json'),
    logger: quiet, rmSyncImpl: () => { deletes++; },
    execGhWithRetryImpl: async () => ({ stdout: JSON.stringify({ state: 'MERGED' }) }),
    execFileImpl: async (command, args, opts) => {
      if (args.includes(operation)) {
        assert.equal(opts.timeout, 360000);
        attempts++;
        if (slow) throw timeout();
      }
      if (args.includes('get-url')) return { stdout: 'https://github.com/fixture/repo.git' };
      if (args.includes('--porcelain')) return { stdout: `worktree ${tree}\n${operation === 'prune' ? 'prunable\n' : ''}\n` };
      return { stdout: '' };
    } };
  // Prune is reached only when the registered directory is already gone.
  if (operation === 'prune') rmSync(tree, { recursive: true });
  const first = await reapCloserHammerWorktrees(options);
  assert.equal(first.reaped, 0);
  assert.equal(first.errors, 1);
  assert.equal(deletes, 0, 'uncertain removal cannot authorize disk fallback');
  assert.equal(existsSync(workerDir), true);
  slow = false;
  assert.equal((await reapCloserHammerWorktrees(options)).reaped, 1);
  assert.equal(attempts, 2);
});

test('registration deadline scales once and an exhausted scan defers unknown directories', async t => {
  loaded(t);
  const root = temp(t), workerDir = join(root, 'workers', 'hammer-ama-pr-2-synthetic');
  mkdirSync(join(workerDir, 'repo'), { recursive: true });
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const result = await reapCloserHammerWorktrees({ hqRoot: root, hqPath: '/synthetic/hq', repoPaths: ['/synthetic/repo'],
    registrationBudgetMs: 100, budgetMs: 100, cursorPath: join(root, 'cursor.json'), logger: quiet,
    execFileImpl: async (_command, args, opts) => {
      if (args.includes('rev-parse')) {
        assert.equal(opts.timeout, 600, 'outer registration budget scales once');
        now += 601;
        throw timeout();
      }
      assert.fail('expired discovery must not start another operation');
    }, rmSyncImpl: () => assert.fail('incomplete registration is not absence') });
  assert.equal(result.reaped, 0);
  assert.equal(result.deferredIncompleteRegistration, 1);
});

test('local publication Git scales its wait and propagates an unknown timeout', t => {
  loaded(t);
  assert.throws(() => hammerLocalGit(['merge-base', '--is-ancestor', 'synthetic-a', 'synthetic-b'], {
    execFileImpl: (command, args, opts) => {
      assert.equal(command, 'git');
      assert.equal(args[0], 'merge-base');
      assert.equal(opts.timeout, 180000);
      throw timeout();
    },
  }), { code: 'ETIMEDOUT' });
});

test('unregistered cleanup retains disk on teardown timeout and reaps after a successful retry', async t => {
  loaded(t);
  const root = temp(t), workerDir = join(root, 'workers', 'hammer-ama-pr-3-synthetic');
  mkdirSync(join(workerDir, 'repo'), { recursive: true });
  let slow = true, deletes = 0;
  const options = { hqRoot: root, repoPaths: [], hqPath: '/synthetic/hq', cursorPath: join(root, 'cursor.json'), logger: quiet,
    execFileImpl: async (_command, args, opts) => {
      assert.equal(args[1], 'tear-down');
      assert.equal(opts.timeout, 360000);
      if (slow) throw timeout();
      return { stdout: '' };
    }, rmSyncImpl: () => { deletes++; } };
  assert.equal((await reapCloserHammerWorktrees(options)).reaped, 0);
  assert.equal(deletes, 0);
  assert.ok(existsSync(workerDir));
  slow = false;
  assert.equal((await reapCloserHammerWorktrees(options)).reaped, 1);
  assert.equal(deletes, 1);
});

test('reap pass budget scales without changing the next-pass polling cadence', async t => {
  loaded(t);
  const root = temp(t);
  for (const id of [4, 5]) mkdirSync(join(root, 'workers', `hammer-ama-pr-${id}-synthetic`, 'repo'), { recursive: true });
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const result = await reapCloserHammerWorktrees({ hqRoot: root, repoPaths: [], hqPath: '/synthetic/hq',
    budgetMs: 100, cursorPath: join(root, 'cursor.json'), logger: quiet, rmSyncImpl() {},
    execFileImpl: async () => { now += 200; return { stdout: '' }; } });
  assert.equal(result.reaped, 2, 'the scaled 600ms budget admits the second candidate after 200ms');
  assert.equal(result.budgetExceeded, false);
});
