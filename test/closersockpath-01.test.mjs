import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync,
  symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { readAmaAuditEntry } from '../src/ama/audit.mjs';
import { classifyCloserOutcome } from '../src/ama/closer-inconclusive-retry.mjs';
import { createValidationScratch, reapValidationScratch } from '../src/ama/hammer-validation-scratch.mjs';

const validator = new URL('../bin/hammer-validate.mjs', import.meta.url).pathname;
const socketFault = 'harness-fault:socket-path';

function fixture(t) {
  const root = mkdtempSync('/tmp/ar-sock-test-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

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
  await reapValidationScratch(root, { now, snapshot: async () => ({
    ps: `child TMPDIR=${path('00000003')}`, lsof: `n${path('00000004')}/child`,
  }) });
  assert.equal(existsSync(path('00000001')), false);
  assert.equal(existsSync(path('00000005')), false);
  for (const id of ['00000002', '00000003', '00000004']) assert.ok(existsSync(path(id)));
  assert.ok(lstatSync(path('00000006')).isSymbolicLink());
});

for (const [diagnostic, expected] of [
  ['OSError: AF_UNIX path too long', socketFault],
  ['listen ENAMETOOLONG: /fixture/run.sock', socketFault],
  ['ENAMETOOLONG: open an ordinary file', undefined],
]) {
  test(`validation exit is classified from ${diagnostic}`, t => {
    const root = fixture(t);
    const env = { PATH: process.env.PATH, HOME: root, TMPDIR: root,
      NETGUARD_LOG: process.env.NETGUARD_LOG || '', HAM_HQ_ROOT: root, HAM_REPO: 'fixture/example',
      HAM_PR_NUMBER: '42', HAM_REVIEWED_SHA: 'a'.repeat(40), HQ_LAUNCH_REQUEST_ID: 'lrq_fixture',
      HQ_WORKER_RUN_ID: 'wrun_fixture', HAM_CLOSE_VALIDATION_RECEIPT: join(root, 'validation.json') };
    const result = spawnSync(process.execPath, [validator, '--', process.execPath, '-e',
      `console.error(${JSON.stringify(diagnostic)}); process.exit(1);`], {
      cwd: root, env, encoding: 'utf8', timeout: 10_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, expected ? 75 : 1, result.stderr);
    const receipt = JSON.parse(readFileSync(env.HAM_CLOSE_VALIDATION_RECEIPT, 'utf8'));
    assert.equal(receipt.outcome, expected);
    const audit = readAmaAuditEntry(root, env.HAM_REPO, 42, env.HAM_REVIEWED_SHA);
    if (expected) {
      const attempt = audit.attempts.at(-1);
      assert.equal(attempt.reason, socketFault);
      assert.equal(attempt.outcome, 'deferred');
      assert.equal(attempt.continuation.headSha, env.HAM_REVIEWED_SHA);
      assert.deepEqual(classifyCloserOutcome({ reason: attempt.reason }),
        { kind: 'inconclusive', reason: socketFault, origin: 'infrastructure' });
    } else assert.ok(!audit);
  });
}
