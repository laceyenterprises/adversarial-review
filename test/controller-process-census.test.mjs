import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createControllerCensus, nativeControllerIdentity } from '../src/controller-process-census.mjs';
import { currentProcessGroupId } from '../src/process-group-identity.mjs';

const python = process.env.HQ_PYTHON3 || process.env.AGENT_OS_PY || 'python3';

test('native census validates the wire shape and retains timeout and isolation budgets', () => {
  const result = nativeControllerIdentity('group', 42, { timeoutImpl: nominal => { assert.equal(nominal, 2000); return 12000; }, execFileSyncImpl(bin, args, options) {
    assert.equal(bin, python);
    assert.deepEqual(args.slice(0, 2), ['-I', '-B']);
    assert.deepEqual(args.slice(-2), ['group', '42']);
    assert.equal(options.timeout, 12000);
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

test('invalid helper arguments report only EINVAL and exit 2', () => {
  const helper = fileURLToPath(new URL('../src/controller_process_census.py', import.meta.url));
  for (const args of [[], ['pgid'], ['pgid', '42', 'extra'], ['pgid', 'not-a-pid'],
    ['pgid', '1'], ['unsupported', '42']]) {
    const result = spawnSync(python, ['-I', '-B', helper, ...args], { encoding: 'utf8', timeout: 2000 });
    assert.ifError(result.error);
    assert.equal(result.status, 2, JSON.stringify(args));
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'controller census: EINVAL\n');
  }
  assert.throws(() => nativeControllerIdentity('unsupported', 42),
    error => error.code === 'EINVAL' && unavailable('EINVAL').test(error.message));
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

// A synthetic serve-mode helper: `answer` maps each request line to raw output.
function fakeHelpers(answer) {
  const spawned = [];
  const spawnImpl = (bin, args, options) => {
    const helper = Object.assign(new EventEmitter(), { bin, args, options, stdin: new PassThrough(),
      stdout: new PassThrough(), exitCode: null, signalCode: null, requests: [], kills: [], unref() {},
      kill(signal) { this.kills.push(signal); this.signalCode = signal; setImmediate(() => this.emit('exit', null, signal)); return true; } });
    let buffered = '';
    helper.stdin.on('data', chunk => {
      buffered += chunk;
      for (let end; (end = buffered.indexOf('\n')) >= 0;) {
        const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
        helper.requests.push(line);
        answer(line, helper, spawned.length);
      }
    });
    spawned.push(helper);
    return helper;
  };
  return { spawned, spawnImpl };
}

test('round census keeps one helper and re-reads the kernel on every request', async () => {
  let reads = 0;
  const { spawned, spawnImpl } = fakeHelpers((line, helper) => {
    reads += 1;
    helper.stdout.write(`${JSON.stringify({ ok: [{ pid: 42, birth: `100.00000${reads}` }] })}\n`);
  });
  const census = createControllerCensus({ spawnImpl, env: { HQ_PYTHON3: 'fixture-python' } });
  const births = [];
  for (let tick = 0; tick < 5; tick += 1) births.push((await census.group(42))[0].birth);
  census.close();
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].bin, 'fixture-python');
  assert.deepEqual(spawned[0].args.slice(0, 2), ['-I', '-B']);
  assert.deepEqual(spawned[0].args.slice(-1), ['serve']);
  assert.deepEqual(spawned[0].requests, Array(5).fill('group 42'));
  // Five distinct answers: nothing was served from an earlier request.
  assert.deepEqual(births, [1, 2, 3, 4, 5].map(read => `100.00000${read}`));
  assert.deepEqual(spawned[0].kills, ['SIGKILL']);
});

test('round census fails closed on every unreadable answer and replaces the helper', async () => {
  const cases = [
    ['refusal', (helper) => helper.stdout.write('{"error":"EPERM"}\n'), 'EPERM', 'EPERM'],
    ['not json', (helper) => helper.stdout.write('not json\n'), 'EMALFORMED', 'EMALFORMED'],
    ['bad member', (helper) => helper.stdout.write('{"ok":[{"pid":42}]}\n'), 'EMALFORMED', 'EMALFORMED'],
    ['duplicate member', (helper) => helper.stdout.write(`${JSON.stringify({ ok: [{ pid: 42, birth: '1.000001' },
      { pid: 42, birth: '1.000001' }] })}\n`), 'EMALFORMED', 'EMALFORMED'],
    ['two answers', (helper) => helper.stdout.write('{"ok":[]}\n{"ok":[]}\n'), 'EMALFORMED', 'EMALFORMED'],
    ['no answer key', (helper) => helper.stdout.write('{}\n'), 'EMALFORMED', 'EMALFORMED'],
    ['helper exit', (helper) => { helper.exitCode = 2; helper.emit('exit', 2, null); }, undefined, 'exit 2'],
    ['spawn error', (helper) => helper.emit('error', Object.assign(new Error('spawn fixture ENOENT'), { code: 'ENOENT' })),
      'ENOENT', 'ENOENT'],
    ['silence', () => {}, 'ETIMEDOUT', 'ETIMEDOUT'],
  ];
  for (const [label, misbehave, code, detail] of cases) {
    const { spawned, spawnImpl } = fakeHelpers((line, helper, count) => {
      if (count === 1) misbehave(helper);
      else helper.stdout.write('{"ok":[{"pid":42,"birth":"123.000001"}]}\n');
    });
    const census = createControllerCensus({ spawnImpl, timeoutMs: 50 });
    await assert.rejects(census.group(42), error => error.code === code && unavailable(detail).test(error.message), label);
    // The failed helper is retired; the next tick starts a fresh one.
    if (label !== 'helper exit') assert.deepEqual(spawned[0].kills, ['SIGKILL'], label);
    assert.deepEqual(await census.group(42), [{ pid: 42, birth: '123.000001' }], label);
    assert.equal(spawned.length, 2, label);
    census.close();
  }
});

test('round census retires a helper that exits or errors while idle between ticks', async () => {
  for (const [label, die] of [
    ['idle exit', helper => { helper.exitCode = 1; helper.emit('exit', 1, null); }],
    ['idle error', helper => helper.emit('error', Object.assign(new Error('fixture EPIPE'), { code: 'EPIPE' }))],
  ]) {
    const { spawned, spawnImpl } = fakeHelpers((line, helper) => helper.stdout.write('{"ok":[]}\n'));
    // A long timeout: a dead helper left in place would stall the next tick here.
    const census = createControllerCensus({ spawnImpl, timeoutMs: 5000 });
    assert.deepEqual(await census.group(42), [], label);
    die(spawned[0]);
    const started = Date.now();
    assert.deepEqual(await census.group(42), [], label);
    assert.ok(Date.now() - started < 1000, label);
    assert.equal(spawned.length, 2, label);
    assert.deepEqual(spawned[1].requests, ['group 42'], label);
    census.close();
  }
});

test('round census refuses overlapping requests, unsolicited output and cancels on close', async () => {
  const { spawned, spawnImpl } = fakeHelpers(() => {});
  const census = createControllerCensus({ spawnImpl, timeoutMs: 5000 });
  const first = census.group(42);
  await assert.rejects(census.group(42), error => error.code === 'EBUSY');
  census.close();
  await assert.rejects(first, error => error.code === 'ECANCELED');
  assert.deepEqual(spawned[0].kills, ['SIGKILL']);
  await assert.rejects(census.group(1), /invalid controller census identity/);

  const chatty = fakeHelpers((line, helper) => helper.stdout.write('{"ok":[]}\n'));
  const second = createControllerCensus({ spawnImpl: chatty.spawnImpl });
  assert.deepEqual(await second.group(42), []);
  chatty.spawned[0].stdout.write('{"ok":[{"pid":42,"birth":"1.000001"}]}\n');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(chatty.spawned[0].kills, ['SIGKILL']);
  assert.deepEqual(await second.group(42), []);
  assert.equal(chatty.spawned.length, 2);
  second.close();
});

test('round census with an absent interpreter fails closed naming the mechanism', async () => {
  const census = createControllerCensus({ env: { HQ_PYTHON3: '/nonexistent/python3' } });
  await assert.rejects(census.group(42), error => error.code === 'ENOENT' && unavailable('ENOENT').test(error.message));
  census.close();
});

test('serve-mode helper answers pgid refusals over the real interpreter', async () => {
  const helper = fileURLToPath(new URL('../src/controller_process_census.py', import.meta.url));
  const result = spawnSync(python, ['-I', '-B', helper, 'serve'],
    { input: 'pgid 1\nbogus\npgid 2147483646\n', encoding: 'utf8', timeout: 5000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0);
  assert.deepEqual(result.stdout.trim().split('\n').map(line => JSON.parse(line)),
    [{ error: 'EINVAL' }, { error: 'EINVAL' }, { error: 'ESRCH' }]);
  const census = createControllerCensus();
  await assert.rejects(census.pgid(2 ** 31 - 2), error => error.code === 'ESRCH');
  assert.equal(await census.pgid(process.pid), nativeControllerIdentity('pgid', process.pid));
  census.close();
});

test('Darwin round census matches the one-shot census for the same live group', { skip: process.platform !== 'darwin', timeout: 20000 }, async t => {
  const group = spawn('/bin/bash', ['-c', 'echo ready; sleep 30 & sleep 30 & wait'],
    { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => { try { process.kill(-group.pid, 'SIGKILL'); } catch { /* already drained */ } });
  await once(group.stdout, 'data');
  const execFileSyncImpl = (bin, args, options) => execFileSync(bin, args, { ...options, timeout: 10000 });
  const census = createControllerCensus({ timeoutMs: 10000 });
  t.after(() => census.close());
  const order = members => [...members].sort((a, b) => a.pid - b.pid);
  for (let index = 0; index < 5; index += 1) {
    const oneShot = order(nativeControllerIdentity('group', group.pid, { execFileSyncImpl }));
    const round = order(await census.group(group.pid));
    if (oneShot.length !== round.length) continue; // A member was still starting between the two reads.
    assert.deepEqual(round, oneShot);
    assert.ok(round.some(member => member.pid === group.pid));
    return;
  }
  assert.fail('the one-shot and round census never observed the same group');
});

test('a slow ownership census survives within its load-aware budget', () => {
  const observe = timeoutImpl => nativeControllerIdentity('pgid', 42, { timeoutImpl,
    execFileSyncImpl(_bin, _args, options) {
      if (options.timeout < 3000) throw Object.assign(new Error('slow scheduler'), { code: 'ETIMEDOUT' });
      return '42';
    } });
  assert.throws(() => observe(base => base), { code: 'ETIMEDOUT' });
  assert.equal(observe(base => base * 3), 42);
});

test('persistent census sizes every request with the shared load-aware deadline', async () => {
  const f = fakeHelpers((_line, helper) => helper.stdout.write('{"ok":42}\n'));
  let sizes = 0;
  const census = createControllerCensus({ spawnImpl: f.spawnImpl,
    timeoutImpl: base => { assert.equal(base, 2000); sizes++; return base * 3; } });
  try {
    assert.equal(await census.pgid(42), 42);
    assert.equal(await census.pgid(42), 42);
    assert.equal(sizes, 2);
  } finally { census.close(); }
});
