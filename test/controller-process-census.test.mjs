import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { nativeControllerIdentity } from '../src/controller-process-census.mjs';
import { currentProcessGroupId } from '../src/process-group-identity.mjs';

const python = process.env.HQ_PYTHON3 || process.env.AGENT_OS_PY || 'python3';

test('native census validates the wire shape and retains timeout and isolation budgets', () => {
  const result = nativeControllerIdentity('group', 42, { execFileSyncImpl(bin, args, options) {
    assert.equal(bin, python);
    assert.deepEqual(args.slice(0, 2), ['-I', '-B']);
    assert.deepEqual(args.slice(-2), ['group', '42']);
    assert.equal(options.timeout, 2000);
    assert.equal(options.maxBuffer, 1024 * 1024);
    return '[{"pid":42,"birth":"123.000001"}]';
  } });
  assert.deepEqual(result, [{ pid: 42, birth: '123.000001' }]);
  for (const value of ['', 'null', '{}', '[{"pid":42}]', '[{"pid":0,"birth":"123.000001"}]',
    '[{"pid":42,"birth":"123.000001"},{"pid":42,"birth":"123.000001"}]']) {
    assert.throws(() => nativeControllerIdentity('group', 42, { execFileSyncImpl: () => value }));
  }
  for (const code of ['EPERM', 'ETIMEDOUT', 'ENOENT']) {
    assert.throws(() => nativeControllerIdentity('group', 42, { execFileSyncImpl() {
      throw Object.assign(new Error('denied'), { code });
    } }), { code });
  }
});

const unavailable = detail => new RegExp(`^controller process census unavailable: kern\\.proc\\.pgrp sysctl census helper `
  + `controller_process_census\\.py via .+ failed \\(${detail}\\); it executes no setuid binary and needs no `
  + 'operator process-introspection change$');

test('a missing helper or interpreter fails closed naming the mechanism, not operator introspection', () => {
  // Real interpreter, absent helper file: Python refuses to open it.
  assert.throws(() => nativeControllerIdentity('group', 42, { execFileSyncImpl(bin, args, options) {
    return execFileSync(bin, [...args.slice(0, 2), '/nonexistent/controller_process_census.py', ...args.slice(3)], options);
  } }), error => unavailable('exit 2').test(error.message));
  // Absent interpreter.
  assert.throws(() => nativeControllerIdentity('group', 42, { env: { HQ_PYTHON3: '/nonexistent/python3' } }),
    error => error.code === 'ENOENT' && unavailable('ENOENT').test(error.message));
  // A same-user read refusal reported by the helper keeps its errno name.
  assert.throws(() => nativeControllerIdentity('group', 42, { execFileSyncImpl() {
    throw Object.assign(new Error('Command failed'), { status: 2, stderr: 'controller census: EPERM\n' });
  } }), error => error.code === 'EPERM' && unavailable('EPERM').test(error.message));
  for (const output of ['not json', '[{"pid":42}]']) {
    assert.throws(() => nativeControllerIdentity('group', 42, { execFileSyncImpl: () => output }),
      error => error.code === 'EMALFORMED' && unavailable('EMALFORMED').test(error.message));
  }
});

test('the helper reports an OS refusal as its errno name only', () => {
  // pgid of a PID that cannot exist exercises the real os.getpgid refusal path.
  assert.throws(() => nativeControllerIdentity('pgid', 2 ** 31 - 2), error => error.code === 'ESRCH');
});

test('native kern.proc.pgrp allowed, zombie, denied, truncated and inconsistent fixtures', () => {
  execFileSync(python, ['-I', '-B', fileURLToPath(new URL('./fixtures/controller-census.py', import.meta.url))],
    { timeout: 5000, stdio: 'pipe' });
});

test('Darwin current PGID uses the available native path in the declared boundary', { skip: process.platform !== 'darwin' }, () => {
  const expected = nativeControllerIdentity('pgid', process.pid);
  assert.equal(currentProcessGroupId({ useCache: false }), expected);
});

test('Darwin group census reads members that exec a root-owned setuid tool', { skip: process.platform !== 'darwin', timeout: 20000 }, async t => {
  try { execFileSync('/bin/ps', ['-o', 'pid=', '-p', String(process.pid)], { stdio: 'ignore' }); }
  catch (error) {
    if (error.code !== 'EPERM') throw error;
    t.skip('setuid exec is denied in this sandbox, so no member can hold a foreign credential');
    return;
  }
  // Load-aware timeouts run setuid ps inside the controller group. A same-user
  // per-PID read is refused for such a member; the group census must not be.
  const group = spawn('/bin/bash', ['-c', 'echo ready; while :; do /bin/ps -A -o %cpu= >/dev/null; done'],
    { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => { try { process.kill(-group.pid, 'SIGKILL'); } catch { /* already drained */ } });
  await once(group.stdout, 'data');
  // Exercise the census result, not the production 2s deadline, on a loaded host.
  const execFileSyncImpl = (bin, args, options) => execFileSync(bin, args, { ...options, timeout: 10000 });
  for (let index = 0; index < 40; index += 1) {
    const members = nativeControllerIdentity('group', group.pid, { execFileSyncImpl });
    assert.ok(members.some(member => member.pid === group.pid));
  }
});
