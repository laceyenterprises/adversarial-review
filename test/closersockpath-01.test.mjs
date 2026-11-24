import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync,
  symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { readAmaAuditEntry } from '../src/ama/audit.mjs';
import { classifyCloserOutcome } from '../src/ama/closer-inconclusive-retry.mjs';
import { createValidationScratch, reapValidationScratch, validationScratchEnv } from '../src/ama/hammer-validation-scratch.mjs';

const validator = new URL('../bin/hammer-validate.mjs', import.meta.url).pathname;
const socketFault = 'harness-fault:socket-path';
const diagnostics = JSON.parse(readFileSync(new URL('./fixtures/hammer-socket-diagnostics.json', import.meta.url)));

function fixture(t) {
  const root = mkdtempSync('/tmp/ar-sock-test-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('pytest basetemp relocation preserves flags across shell quoting styles', () => {
  const root = '/tmp/ar-hv-12345678';
  for (const option of [
    '--basetemp=/long/run/tmp-tests',
    '--basetemp="/long/run with spaces/tmp-tests"',
    "--basetemp='/long/run with spaces/tmp-tests'",
    '--basetemp="/long/run with \\"quotes\\"/tmp-tests"',
    '--basetemp=/first --basetemp="/last path"',
  ]) {
    const env = { HAM_RUN_DIR: '/long/run', PYTEST_ADDOPTS: `-q ${option} -o tmp_path_retention_count=1` };
    const relocated = validationScratchEnv(env, root);
    const basetemps = option.includes('/first') ? `--basetemp=${root}/p --basetemp=${root}/p` : `--basetemp=${root}/p`;
    assert.equal(relocated.PYTEST_ADDOPTS, `-q ${basetemps} -o tmp_path_retention_count=1`);
    assert.equal(env.PYTEST_ADDOPTS, `-q ${option} -o tmp_path_retention_count=1`);
  }
  const flags = '-q -k test_basetemp --custom-basetemp=/keep';
  assert.equal(validationScratchEnv({ HAM_RUN_DIR: '/long/run', PYTEST_ADDOPTS: flags }, root).PYTEST_ADDOPTS, flags);
  assert.equal(validationScratchEnv({ HAM_RUN_DIR: '/long/run' }, root).PYTEST_ADDOPTS, undefined);
});

test('validation binds a real Unix socket and resolves a local module from a deep checkout', t => {
  const root = fixture(t);
  const checkout = join(root, 'checkout-'.repeat(15));
  mkdirSync(checkout);
  writeFileSync(join(checkout, 'dependency.cjs'), 'module.exports = 42;');
  writeFileSync(join(checkout, 'socket-test.cjs'), `
    const assert = require('node:assert/strict');
    const { lstatSync, mkdirSync, realpathSync } = require('node:fs');
    const { createServer } = require('node:net');
    const { tmpdir } = require('node:os');
    const { dirname, join } = require('node:path');
    const root = tmpdir();
    assert.equal(realpathSync(root), root);
    assert.equal(lstatSync(root).mode & 0o777, 0o700);
    assert.equal(lstatSync(root).uid, process.getuid());
    assert.equal(process.env.TMP, root);
    assert.equal(process.env.TEMP, root);
    assert.equal(process.env.PYTEST_ADDOPTS, '--quiet --basetemp=' + join(root, 'p'));
    assert.equal(require('./dependency.cjs'), 42);
    const socket = join(root, 'fixture-gateway-abcdef/longer/run/gateway-runtime.sock');
    assert.ok(Buffer.byteLength(socket) <= 92);
    mkdirSync(dirname(socket), { recursive: true });
    const server = createServer().listen(socket, () => {
      assert.ok(lstatSync(socket).isSocket());
      console.log('scratch=' + root);
      server.close();
    });
  `);
  const result = spawnSync(process.execPath, [validator, '--', process.execPath, './socket-test.cjs'], {
    cwd: checkout, encoding: 'utf8', timeout: 10_000,
    env: { PATH: process.env.PATH, HOME: root, NETGUARD_LOG: process.env.NETGUARD_LOG || '',
      HAM_RUN_DIR: checkout, TMPDIR: checkout, TMP: checkout, TEMP: checkout,
      PYTEST_ADDOPTS: `--quiet --basetemp=${JSON.stringify(join(checkout, 'tmp-tests'))}` },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const scratch = result.stdout.match(/^scratch=(.+)$/m)?.[1];
  assert.match(scratch, /^\/(?:private\/)?tmp\/ar-hv-[a-f0-9]{8}$/);
  assert.equal(existsSync(scratch), false);
  assert.equal(existsSync(join(checkout, 'tmp-tests')), false);
});

test('an overlong real temp parent fails before creating any scratch', async t => {
  const root = fixture(t);
  const base = join(root, 'é'.repeat(25));
  mkdirSync(base);
  await assert.rejects(createValidationScratch(base), /harness-fault:socket-path:.*bytes/);
  assert.deepEqual(readdirSync(base), []);
});

test('orphan reaping preserves live, recent, and symlink candidates', async t => {
  const root = realpathSync(fixture(t));
  for (const id of ['00000001', '00000002', '00000003', '00000004', '00000005']) {
    mkdirSync(join(root, `ar-hv-${id}`), { mode: 0o700 });
  }
  const path = id => join(root, `ar-hv-${id}`);
  writeFileSync(join(path('00000002'), '.validator-pid'), String(process.pid));
  symlinkSync(path('00000001'), path('00000006'));
  const now = Date.now() + 2 * 24 * 60 * 60 * 1000;
  await reapValidationScratch(root, { snapshot: () => { assert.fail('recent scratch should not request a census'); } });
  await reapValidationScratch(root, { now, snapshot: async () => ({ ps: 'unavailable', lsof: '', cwdTimedOut: true }) });
  assert.ok(existsSync(path('00000001')));
  await reapValidationScratch(root, { now: now + 60_000,
    snapshot: () => { assert.fail('timed-out census must still enforce the cooldown'); } });
  assert.ok(existsSync(path('00000001')));
  let censuses = 0;
  const later = { now: now + 2 * 60 * 60 * 1000, snapshot: async () => {
    censuses++;
    return { ps: `child TMPDIR=${path('00000003')}`, lsof: `n${path('00000004')}/child` };
  } };
  await Promise.all([reapValidationScratch(root, later), reapValidationScratch(root, later)]);
  assert.equal(censuses, 1);
  assert.equal(existsSync(path('00000001')), false);
  assert.equal(existsSync(path('00000005')), false);
  for (const id of ['00000002', '00000003', '00000004']) assert.ok(existsSync(path(id)));
  assert.ok(lstatSync(path('00000006')).isSymbolicLink());
});

for (const { name, output, socketPathFault } of diagnostics) {
  test(`validation exit is classified for ${name}`, t => {
    const root = fixture(t);
    const env = { PATH: process.env.PATH, HOME: root, TMPDIR: root,
      NETGUARD_LOG: process.env.NETGUARD_LOG || '', HAM_HQ_ROOT: root, HAM_REPO: 'fixture/example',
      HAM_PR_NUMBER: '42', HAM_REVIEWED_SHA: 'a'.repeat(40), HQ_LAUNCH_REQUEST_ID: 'lrq_fixture',
      HQ_WORKER_RUN_ID: 'wrun_fixture', HAM_CLOSE_VALIDATION_RECEIPT: join(root, 'validation.json') };
    const result = spawnSync(process.execPath, [validator, '--', process.execPath, '-e',
      `process.stderr.write(${JSON.stringify(output)}); process.exitCode = 1;`], {
      cwd: root, env, encoding: 'utf8', timeout: 10_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, socketPathFault ? 75 : 1, result.stderr);
    const receipt = JSON.parse(readFileSync(env.HAM_CLOSE_VALIDATION_RECEIPT, 'utf8'));
    assert.equal(receipt.outcome, socketPathFault ? socketFault : undefined);
    const audit = readAmaAuditEntry(root, env.HAM_REPO, 42, env.HAM_REVIEWED_SHA);
    if (socketPathFault) {
      assert.match(result.stderr, /validation scratch: \/(?:private\/)?tmp\/ar-hv-[a-f0-9]{8}/);
      assert.match(receipt.socketPathDiagnostic, /validation scratch: \/(?:private\/)?tmp\/ar-hv-[a-f0-9]{8}/);
      const attempt = audit.attempts.at(-1);
      assert.equal(attempt.reason, socketFault);
      assert.equal(attempt.outcome, 'deferred');
      assert.equal(attempt.continuation.headSha, env.HAM_REVIEWED_SHA);
      assert.deepEqual(classifyCloserOutcome({ reason: attempt.reason }),
        { kind: 'inconclusive', reason: socketFault, origin: 'infrastructure' });
    } else {
      assert.equal(receipt.socketPathDiagnostic, undefined);
      assert.ok(!audit);
    }
  });
}

test('canonical TAP battery preserves a product failure alongside a passing socket diagnostic name', t => {
  const root = fixture(t);
  const receipt = join(root, 'validation.json');
  mkdirSync(join(root, 'test'));
  writeFileSync(join(root, 'package.json'), '{"name":"adversarial-review"}');
  writeFileSync(join(root, 'test/run-tests.mjs'), `
    import { spawnSync } from 'node:child_process';
    process.exitCode = spawnSync(process.execPath,
      ['--test', '--test-reporter=tap', ...process.argv.slice(2)], { stdio: 'inherit' }).status;
  `);
  writeFileSync(join(root, 'test/mixed.test.mjs'), `
    import test from 'node:test';
    test('OSError: AF_UNIX path too long', () => {});
    test('product regression', () => { throw new Error('product failure'); });
  `);
  const result = spawnSync(process.execPath, [validator, '--canonical', '--', 'test/mixed.test.mjs'], {
    cwd: root, encoding: 'utf8', timeout: 10_000,
    env: { PATH: process.env.PATH, HOME: root, NETGUARD_LOG: process.env.NETGUARD_LOG || '',
      HAM_CLOSE_VALIDATION_RECEIPT: receipt },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /^ok \d+ - OSError: AF_UNIX path too long$/m);
  assert.match(result.stdout, /^not ok \d+ - product regression$/m);
  const evidence = JSON.parse(readFileSync(receipt, 'utf8'));
  assert.equal(evidence.outcome, undefined);
  assert.equal(evidence.checks[0].status, 'failed');
});
