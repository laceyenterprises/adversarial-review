import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { Duplex, PassThrough } from 'node:stream';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, renameSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { assertHammerController, controllerGroupSnapshot, controllerLaunchId, groupStillOwned, releaseControllerLease, runHammerController,
  LAUNCH_POLL_MS, LAUNCH_UNREADABLE_GRACE_MS } from '../src/ama/hammer-controller.mjs';
import { acquireMergeLease, inspectMergeLease, releaseMergeLease, mergeLeaseFilePath } from '../src/ama/merge-lease.mjs';

const root = resolve(import.meta.dirname, '..');
const head = 'a'.repeat(40);
async function until(check) {
  const deadline = performance.now() + 8000;
  while (performance.now() < deadline) {
    const result = check();
    if (result) return result;
    await delay(20);
  }
  throw new Error('fixture rendezvous timed out');
}
const launch = status => ({ ok: true, row: { launch_request_id: 'lrq_controller-test', status } });
const publishReady = value => `const fs=require("node:fs"),p=process.env.HAM_RUN_DIR+"/test-ready";
  fs.writeFileSync(p+".tmp",JSON.stringify(${value}));fs.renameSync(p+".tmp",p);`;

function fixture(t, script, { realCensus = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ham-controller-'));
  const env = { ...process.env, HAM_RUN_DIR: dir, HAM_ROOT_DIR: dir, HAM_REPO: 'fixture/repo',
    HAM_PR_NUMBER: '42', HQ_LAUNCH_REQUEST_ID: 'lrq_controller-test', AGENT_OS_WORKER_LRQ_ID: 'lrq_controller-test' };
  delete env.LAUNCH_REQUEST_ID;
  const bin = join(dir, 'bin'); mkdirSync(bin);
  const ps = join(dir, 'group-probe.mjs');
  writeFileSync(ps, `import {readFileSync} from 'node:fs';
    if(process.argv[2]!=='-o'||process.argv[3]!=='pgid=')process.exit(1);
    console.log(JSON.parse(readFileSync(process.env.HAM_CONTROLLER_RECORD,'utf8')).shellPid);`);
  writeFileSync(join(bin, 'ps'), '#!/bin/sh\nexec "$CONTROLLER_FIXTURE_NODE" "$CONTROLLER_FIXTURE_PS" "$@"\n', { mode: 0o755 });
  if (!realCensus) Object.assign(env, { PATH: `${bin}:${env.PATH}`, CONTROLLER_FIXTURE_NODE: process.execPath, CONTROLLER_FIXTURE_PS: ps });
  const launchPath = join(dir, 'launch.json');
  writeFileSync(launchPath, JSON.stringify(launch('running')));
  const leaseHelper = join(dir, 'acquire.mjs');
  writeFileSync(leaseHelper, `
    import { writeFileSync } from 'node:fs';
    import { acquireMergeLease } from ${JSON.stringify(new URL('../src/ama/merge-lease.mjs', import.meta.url).href)};
    const r = acquireMergeLease({rootDir: process.env.HAM_ROOT_DIR, repo:'fixture/repo', base:'main',
      holderPr:42, holderHead:'${head}', holderPid:process.ppid, holderHost:${JSON.stringify(hostname())}});
    if (!r.acquired) process.exit(1);
    const l = r.lease;
    writeFileSync(process.env.HAM_RUN_DIR+'/merge-lease-acquire.json', JSON.stringify({acquired:true,
      key:'fixture/repo::main',holder:42,leaseId:l.leaseId,holderPid:l.holderPid,
      holderHead:l.holderHead,acquiredAt:l.acquiredAt}));
  `);
  const scriptPath = join(dir, 'close.sh');
  writeFileSync(scriptPath, `#!/bin/bash\nset -e\n"${process.execPath}" "${leaseHelper}"\n${script}\n`);
  const driver = join(dir, 'driver.mjs');
  writeFileSync(driver, `
    import {readFileSync,writeFileSync,renameSync} from 'node:fs';
    import {runHammerController,controllerGroupSnapshot} from ${JSON.stringify(new URL('../src/ama/hammer-controller.mjs', import.meta.url).href)};
    const status = await runHammerController(${JSON.stringify(scriptPath)}, [], {
      pollMs:20, graceMs:150, drainMs:1000, timeoutMs:10000, launchPollMs:20, gateWaitMs:2000,
      unreadableGraceMs:Number(process.env.FIXTURE_GRACE_MS||300), readTimeoutImpl:()=>50,
      readLaunchImpl:async()=>JSON.parse(readFileSync(${JSON.stringify(launchPath)},'utf8')),
      // The test owns these exact births. Inject the OS census so this offline
      // regression also runs in workers whose sandbox forbids ps.
      ...(${realCensus} ? {} : {snapshotImpl:pgid=>{
        try {readFileSync(process.env.HAM_RUN_DIR+'/probe-denied');throw Object.assign(new Error('fixture census denied'),{code:'EPERM'})} catch(e) {if(e.code!=='ENOENT')throw e}
        let ready={}; try {ready=JSON.parse(readFileSync(process.env.HAM_RUN_DIR+'/test-ready','utf8'))} catch {}
        return [pgid,ready.pid,ready.ppid].filter(Boolean).filter(pid=>{
          try {
            process.kill(pid,0);
            try {if(readFileSync('/proc/'+pid+'/stat','utf8').match(/\\) Z /))return false} catch {}
            return true;
          } catch(e) {if(e.code==='ESRCH')return false;throw e}
        }).map(pid=>({pid,birth:'fixture-'+pid}));
      }})
    });
    writeFileSync(${JSON.stringify(join(dir, 'result.tmp'))},String(status));
    renameSync(${JSON.stringify(join(dir, 'result.tmp'))},${JSON.stringify(join(dir, 'result'))});
    process.exitCode=status;
  `);
  let controller, detached = false;
  t.after(async () => {
    // These are exclusively fixture-owned children, never a host process scan.
    if (controller?.exitCode === null && controller.signalCode === null) {
      const closed = once(controller, 'close'); controller.kill('SIGTERM'); await closed;
    }
    if (detached && readdirSync(dir).some(name => /^controller-.*\.json$/.test(name))
        && !existsSync(join(dir, 'result'))) {
      writeFileSync(launchPath, JSON.stringify(launch('canceled')));
      await until(() => existsSync(join(dir, 'result')));
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, env, driver, launchPath,
    start() { controller = spawn(process.execPath, [driver], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; controller.stderr.on('data', b => { output += b; }); controller.stdout.resume();
      return { child: controller, closed: once(controller, 'close'), output: () => output }; },
    detach() {
      detached = true;
      return spawn(process.execPath, ['-e', `
        const {spawn}=require('node:child_process');
        const c=spawn(process.execPath,[${JSON.stringify(driver)}],{detached:true,stdio:'ignore'}); c.unref();
      `], { env, stdio: 'ignore' });
    },
    cancel(probe = launch('canceled')) {
      writeFileSync(launchPath + '.tmp', JSON.stringify(probe)); renameSync(launchPath + '.tmp', launchPath);
    },
    receipt() {
      const name = readdirSync(dir).find(name => /^controller-.*\.json$/.test(name));
      return name && JSON.parse(readFileSync(join(dir, name), 'utf8'));
    },
  };
}

test('launch identity refuses missing, conflicting and non-LRQ owners', () => {
  for (const env of [{}, { HQ_LAUNCH_REQUEST_ID: 'wrong' },
    { HQ_LAUNCH_REQUEST_ID: 'lrq_one', AGENT_OS_WORKER_LRQ_ID: 'lrq_other' }]) {
    assert.throws(() => controllerLaunchId(env), /unambiguous/);
  }
});

test('PID reuse or unknown group membership never authorizes a signal', () => {
  const known = new Map([[100, 'original']]);
  assert.equal(groupStillOwned([{ pid: 100, birth: 'reused' }], known, false, 100), false);
  assert.equal(groupStillOwned([{ pid: 100, birth: 'reused' }], known, true, 100), false);
  assert.equal(groupStillOwned([{ pid: 200, birth: 'foreign' }], known, false, 100), false);
  assert.equal(groupStillOwned([{ pid: 100, birth: 'original' }, { pid: 101, birth: 'child' }], known, false, 100), true);
  assert.equal(groupStillOwned([{ pid: 101, birth: 'child' }], known, false, 100), true);
  for (const pgid of [undefined, 0, -1, 1, NaN]) {
    assert.equal(groupStillOwned([{ pid: 100, birth: 'original' }], known, true, pgid), false);
  }
});

test('non-Darwin ps census excludes unrelated groups and zombies, and fails closed on unreadable data', () => {
  const source = '100 100 S Sat Oct 24 08:00:00 2026\n101 100 Z Sat Oct 24 08:01:00 2026\n200 200 S Sat Oct 24 08:02:00 2026\n';
  const platform = 'linux';
  const result = controllerGroupSnapshot(100, { platform, execFileSyncImpl: () => source });
  assert.deepEqual(result, [{ pid: 100, birth: 'Sat Oct 24 08:00:00 2026' }]);
  assert.deepEqual(controllerGroupSnapshot(999, { platform, execFileSyncImpl: () => source }), []);
  for (const text of ['', 'truncated', source + 'malformed']) {
    assert.throws(() => controllerGroupSnapshot(100, { platform, execFileSyncImpl: () => text }), /census/);
  }
  assert.throws(() => controllerGroupSnapshot(100, { platform, execFileSyncImpl() {
    throw Object.assign(new Error('fixture refusal'), { code: 'EPERM' });
  } }), { code: 'EPERM' });
});

test('Darwin census never executes setuid /bin/ps, so a sandbox exec refusal cannot reach it', () => {
  const executed = [];
  const execFileSyncImpl = bin => {
    executed.push(bin);
    throw Object.assign(new Error(`spawnSync ${bin} EPERM`), { code: 'EPERM' });
  };
  // Same synthetic group the ps fixture above describes: a live leader, a
  // zombie child and an unrelated group. The kernel filters the group.
  const members = [{ pid: 100, birth: '1792828800.000000' }];
  const nativeImpl = (verb, pgid) => { assert.deepEqual([verb, pgid], ['group', 100]); return members; };
  assert.deepEqual(controllerGroupSnapshot(100, { platform: 'darwin', execFileSyncImpl, nativeImpl }), members);
  assert.deepEqual(executed, []);
  const refusal = Object.assign(new Error('controller process census unavailable'), { code: 'EPERM' });
  assert.throws(() => controllerGroupSnapshot(100, { platform: 'darwin', execFileSyncImpl,
    nativeImpl() { throw refusal; } }), refusal);
  assert.deepEqual(executed, []);
});

test('Darwin census forwards the subprocess runner through the default native provider', () => {
  const members = [{ pid: 100, birth: '1792828800.000000' }];
  const executed = [];
  const result = controllerGroupSnapshot(100, { platform: 'darwin', execFileSyncImpl(bin, args, options) {
    executed.push(bin);
    assert.notEqual(bin, '/bin/ps');
    assert.deepEqual(args.slice(0, 2), ['-I', '-B']);
    assert.match(args[2], /controller_process_census\.py$/);
    assert.deepEqual(args.slice(3), ['group', '100']);
    assert.equal(options.timeout, 2000);
    return JSON.stringify(members);
  } });
  assert.deepEqual(result, members);
  assert.equal(executed.length, 1);
});

test('Darwin native census returns the same members and births as legacy ps parsing for a fake group',
  { skip: process.platform !== 'darwin', timeout: 15000 }, async t => {
    const leader = spawn(process.execPath, ['-e', `
      const child=require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});
      console.log(child.pid); setInterval(()=>{},1000);`], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    t.after(() => { try { process.kill(-leader.pid, 'SIGKILL'); } catch { /* already drained */ } });
    let output = '';
    leader.stdout.on('data', chunk => { output += chunk; });
    const childPid = await until(() => output.endsWith('\n') && Number(output.trim()));
    // Compare results, not the production 2s deadline, on a loaded test host.
    const execFileSyncImpl = (bin, args, options) => execFileSync(bin, args, { ...options, timeout: 10000 });
    const native = controllerGroupSnapshot(leader.pid, { execFileSyncImpl });
    assert.deepEqual(native.map(member => member.pid).sort((a, b) => a - b),
      [leader.pid, childPid].sort((a, b) => a - b), JSON.stringify(native));
    let legacy;
    try { legacy = controllerGroupSnapshot(leader.pid, { platform: 'linux', execFileSyncImpl }); }
    catch (error) {
      if (error.code !== 'EPERM') throw error;
      t.skip('setuid /bin/ps is denied in this sandbox; the native census above still read the group');
      return;
    }
    const byPid = new Map(legacy.map(member => [member.pid, member.birth]));
    assert.deepEqual([...byPid.keys()].sort((a, b) => a - b), native.map(member => member.pid).sort((a, b) => a - b),
      JSON.stringify({ native, legacy }));
    for (const member of native) {
      // ps lstart is the UTC second of the same kernel start time.
      assert.equal(Math.floor(Number(member.birth)) * 1000, Date.parse(`${byPid.get(member.pid)} GMT`),
        JSON.stringify({ native, legacy }));
    }
  });

for (const probe of [launch('canceled'), launch('blocked_needs_decision'), { ok: false }, launch('future-status')]) {
  test(`start refuses non-executable launch ${probe.row?.status || 'unreadable'}`, async () => {
    await assert.rejects(runHammerController('/does-not-run', [], {
      env: { HAM_RUN_DIR: '/fixture', HAM_ROOT_DIR: '/fixture', HAM_REPO: 'fixture/repo',
        HAM_PR_NUMBER: '42', HQ_LAUNCH_REQUEST_ID: 'lrq_controller-test' },
      readLaunchImpl: async () => probe, delayImpl: async () => {},
    }), /refusing controller start/);
  });
}

test('normal script preserves real failure and releases only its matching lease', { timeout: 12000 }, async t => {
  const f = fixture(t, 'exit 7');
  const p = f.start();
  assert.equal((await p.closed)[0], 7, `${p.output()} ${JSON.stringify(f.receipt())}`);
  assert.equal(f.receipt().state, 'quiescent');
  assert.equal(f.receipt().leaseCleanup.released, true);
  assert.equal(inspectMergeLease({ rootDir: f.dir, repo: 'fixture/repo', base: 'main' }).holder, null);
});

for (const kind of ['terminal', 'unreadable', 'different-launch']) {
  test(`${kind} ownership stops shell, validator and TERM-ignoring test after detach`, { timeout: 15000 }, async t => {
    const f = fixture(t, `
      "${process.execPath}" "${root}/bin/hammer-controller.mjs" assert-owner
      "${process.execPath}" "${root}/bin/hammer-validate.mjs" -- "${process.execPath}" -e '
        process.on("SIGTERM",()=>{});
        ${publishReady('{pid:process.pid,ppid:process.ppid}')}
        setInterval(()=>{},1000);'
      printf forbidden > "$HAM_RUN_DIR/audit"
    `);
    // The harness-like launcher exits, leaving the controller detached from it.
    const launcher = f.detach();
    assert.equal((await once(launcher, 'close'))[0], 0);
    await until(() => {
      if (existsSync(join(f.dir, 'result'))) throw new Error(`early controller exit: ${JSON.stringify(f.receipt())}`);
      return existsSync(join(f.dir, 'test-ready'));
    });
    const receipt = f.receipt();
    assert.equal(receipt.state, 'running');
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    t.after(async () => { const done = once(unrelated, 'close'); unrelated.kill(); await done; });
    const testPid = JSON.parse(readFileSync(join(f.dir, 'test-ready'), 'utf8')).pid;
    assert.ok(testPid > 1);
    f.cancel(kind === 'terminal' ? launch('canceled') : kind === 'unreadable' ? { ok: false }
      : { ok: true, row: { launch_request_id: 'lrq_foreign', status: 'running' } });
    await until(() => existsSync(join(f.dir, 'result')));
    assert.equal(readFileSync(join(f.dir, 'result'), 'utf8'), '143');
    assert.equal(f.receipt().state, 'quiescent');
    assert.equal(f.receipt().killSent, true);
    assert.equal(f.receipt().leaseCleanup.released, true);
    assert.equal(existsSync(join(f.dir, 'audit')), false);
    assert.equal(unrelated.exitCode, null);
    assert.equal(unrelated.signalCode, null);
    // A successful group census excludes only zombies; no live test remains.
    let live = true;
    try { process.kill(testPid, 0); }
    catch (error) { if (error.code === 'ESRCH') live = false; else throw error; }
    if (live && existsSync(`/proc/${testPid}/stat`)) live = !/\) Z /.test(readFileSync(`/proc/${testPid}/stat`, 'utf8'));
    assert.equal(live, false);
  });
}

test('a successor lease stays byte-identical when the canceled controller drains', { timeout: 12000 }, async t => {
  const f = fixture(t, 'printf ready > "$HAM_RUN_DIR/ready"\nsleep 30');
  const p = f.start();
  await until(() => existsSync(join(f.dir, 'ready')));
  const identity = { rootDir: f.dir, repo: 'fixture/repo', base: 'main' };
  const old = inspectMergeLease(identity).holder;
  assert.equal(releaseMergeLease({ ...identity, leaseId: old.leaseId, holderPr: old.holderPr,
    holderHead: old.holderHead, acquiredAt: old.acquiredAt }).released, true);
  assert.equal(acquireMergeLease({ ...identity, holderPr: 99, holderHead: 'b'.repeat(40), holderPid: process.pid }).acquired, true);
  const path = mergeLeaseFilePath(f.dir, identity);
  const before = readFileSync(path, 'utf8');
  f.cancel();
  assert.equal((await p.closed)[0], 143, p.output());
  assert.equal(readFileSync(path, 'utf8'), before);
  assert.equal(f.receipt().leaseCleanup.reason, 'lease-not-owned');
});

test('unconfirmed process drain never even inspects or releases a lease', () => {
  assert.deepEqual(releaseControllerLease({ drained: false, inspectImpl() { throw new Error('must not inspect'); } }),
    { released: false, reason: 'process-drain-unconfirmed' });
});

test('lease cleanup preserves foreign hosts, reused holders, heads and acquisition generations', t => {
  const f = fixture(t, 'exit 0');
  const acquired = { acquired: true, key: 'fixture/repo::main', holder: 42, holderPid: 12345,
    holderHead: head, leaseId: 'ml_fixture', acquiredAt: '2026-10-24T15:00:01Z' };
  writeFileSync(join(f.dir, 'merge-lease-acquire.json'), JSON.stringify(acquired));
  const holder = { holderPr: 42, holderPid: 12345, holderHead: head, leaseId: 'ml_fixture',
    holderHost: hostname(), acquiredAt: acquired.acquiredAt };
  for (const patch of [{ holderPr: 99 }, { holderPid: 23456 }, { holderHead: 'b'.repeat(40) },
    { leaseId: 'ml_successor' }, { holderHost: 'fixture-other-host' }, { acquiredAt: '2026-10-24T15:01:00Z' }]) {
    const result = releaseControllerLease({ env: f.env, shellPid: 12345,
      startedAt: '2026-10-24T15:00:00Z', drained: true,
      inspectImpl: () => ({ holder: { ...holder, ...patch } }),
      releaseImpl() { throw new Error('must not release another holder'); },
    });
    assert.equal(result.reason, 'lease-not-owned');
  }
  assert.equal(releaseControllerLease({ env: f.env, shellPid: 12345,
    startedAt: '2026-10-24T15:02:00Z', drained: true,
    inspectImpl() { throw new Error('stale receipt cannot inspect a holder'); },
  }).reason, 'acquisition-not-owned');
});

test('unregistered and stale-generation shells cannot claim controller ownership', t => {
  const f = fixture(t, 'exit 0');
  assert.throws(() => assertHammerController(f.env));
  const path = join(f.dir, 'stale-controller.json');
  const record = { schemaVersion: 1, state: 'quiescent', token: 'old', controllerPid: process.pid,
    shellPid: process.ppid, launchRequestId: 'lrq_controller-test' };
  writeFileSync(path, JSON.stringify(record));
  const env = { ...f.env, HAM_CONTROLLER_RECORD: path, HAM_CONTROLLER_TOKEN: 'old', HAM_CONTROLLER_PID: String(process.pid) };
  assert.throws(() => assertHammerController(env), /unconfirmed/);
  record.state = 'running'; writeFileSync(path, JSON.stringify(record));
  assert.throws(() => assertHammerController({ ...env, HAM_CONTROLLER_TOKEN: 'different' }), /unconfirmed/);
  assert.throws(() => assertHammerController(env, { readGroupImpl: () => record.shellPid + 1 }), /process group/);
  assert.throws(() => assertHammerController(env, { readGroupImpl: () => null }), /process group/);
});

test('nested controllers cannot introduce another detached ownership boundary', async () => {
  await assert.rejects(runHammerController('/must-not-run', [], {
    env: { HQ_LAUNCH_REQUEST_ID: 'lrq_controller-test', HAM_CONTROLLER_RECORD: '/outer/record' },
  }), /nested/);
});

test('unreadable process evidence fails before script or lease side effects', async t => {
  const f = fixture(t, 'exit 0');
  const status = await runHammerController('/must-not-execute', [], {
    env: f.env, readLaunchImpl: async () => launch('running'),
    snapshotImpl() { throw Object.assign(new Error('fixture denied census'), { code: 'EPERM' }); },
  });
  assert.equal(status, 125);
  assert.equal(f.receipt().state, 'cleanup-unconfirmed');
  assert.equal(f.receipt().errorCode, 'EPERM');
  assert.equal(existsSync(join(f.dir, 'merge-lease-acquire.json')), false);
});

test('lost process census stops the direct child but retains the owned lease and unknown drain', { timeout: 12000 }, async t => {
  const f = fixture(t, `exec "${process.execPath}" -e '
    process.on("SIGTERM",()=>{});
    require("node:fs").writeFileSync(process.env.HAM_RUN_DIR+"/ready","ready");
    setInterval(()=>{},1000);'`);
  const p = f.start();
  await until(() => existsSync(join(f.dir, 'ready')));
  writeFileSync(join(f.dir, 'probe-denied'), 'denied');
  assert.equal((await p.closed)[0], 125, p.output());
  const receipt = f.receipt();
  assert.equal(receipt.state, 'cleanup-unconfirmed');
  assert.equal(receipt.directTermSent, true);
  assert.equal(receipt.directKillSent, true);
  assert.equal(receipt.leaseCleanup.reason, 'process-drain-unconfirmed');
  assert.ok(inspectMergeLease({ rootDir: f.dir, repo: 'fixture/repo', base: 'main' }).holder);
});

test('a refused child kill is not a failed spawn and never proves quiescence', async t => {
  const f = fixture(t, 'exit 0');
  const child = Object.assign(new EventEmitter(), {
    pid: 4242, stdin: new PassThrough(), stdio: [null, null, null, null, new PassThrough()],
    kill() {
      setImmediate(() => this.emit('error', Object.assign(new Error('fixture kill refused'), { code: 'EPERM' })));
      return false;
    },
    unref() {},
  });
  let reads = 0;
  const status = await runHammerController('/fixture', [], {
    env: f.env, pollMs: 5, graceMs: 30, drainMs: 30, launchPollMs: 5,
    readLaunchImpl: async () => launch(++reads === 1 ? 'running' : 'canceled'),
    snapshotImpl: () => [{ pid: 4242, birth: 'fixture-birth' }], spawnImpl: () => child,
    signalGroupImpl(pid) {
      assert.equal(pid, -4242);
      throw Object.assign(new Error('fixture group signal refused'), { code: 'EPERM' });
    },
  });
  assert.equal(status, 125);
  assert.equal(f.receipt().state, 'cleanup-unconfirmed');
  assert.equal(f.receipt().signalError, 'EPERM');
  assert.equal(f.receipt().drained, false);
  assert.equal(f.receipt().leaseCleanup.reason, 'process-drain-unconfirmed');
});

for (const exitCode of [0, 7]) {
  test(`empty census before shell exit event preserves status ${exitCode}`, async t => {
    const f = fixture(t, 'exit 0');
    let exited = false, snapshots = 0;
    const child = Object.assign(new EventEmitter(), {
      pid: 4242, stdin: new PassThrough(), stdio: [null, null, null, null, new PassThrough()],
      kill() { throw new Error('empty census cannot authorize a signal'); },
      unref() {},
    });
    const status = await runHammerController('/fixture', [], {
      env: f.env, pollMs: 5, timeoutMs: 1000,
      readLaunchImpl: async () => launch('running'), spawnImpl: () => child,
      snapshotImpl() {
        if (++snapshots === 1) return [{ pid: 4242, birth: 'fixture-birth' }];
        if (snapshots === 2) setImmediate(() => { exited = true; child.emit('exit', exitCode); });
        return [];
      },
      signalGroupImpl() { throw new Error('empty census cannot authorize a group signal'); },
      releaseImpl({ drained }) {
        assert.equal(exited, true);
        assert.equal(drained, true);
        return { released: false, reason: 'no-acquisition-receipt' };
      },
    });
    assert.equal(status, exitCode);
    assert.equal(f.receipt().reason, 'shell-exited');
    assert.equal(f.receipt().drained, true);
  });
}

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  test(`controller ${signal} cancellation drains its shell and fences lease cleanup`, { timeout: 12000 }, async t => {
    const f = fixture(t, 'printf ready > "$HAM_RUN_DIR/ready"\nsleep 30');
    const p = f.start();
    await until(() => existsSync(join(f.dir, 'ready')));
    p.child.kill(signal);
    assert.equal((await p.closed)[0], 143, p.output());
    assert.equal(f.receipt().reason, `signal:${signal}`);
    assert.equal(f.receipt().state, 'quiescent');
    assert.equal(f.receipt().leaseCleanup.released, true);
  });
}

test('validator timeout cancels the whole registered round without an audit', { timeout: 12000 }, async t => {
  const f = fixture(t, `
    "${process.execPath}" --input-type=module -e '
      import {runBounded} from "${root}/src/ama/bounded-command.mjs";
      process.exitCode=await runBounded(process.execPath,["-e","setInterval(()=>{},1000)"],
        {timeoutMs:200,idleMs:100,graceMs:50});'
    printf forbidden > "$HAM_RUN_DIR/audit"
  `);
  const p = f.start();
  assert.equal((await p.closed)[0], 143, p.output());
  assert.equal(f.receipt().reason, 'validation-stopped');
  assert.equal(f.receipt().state, 'quiescent');
  assert.equal(f.receipt().leaseCleanup.released, true);
  assert.equal(existsSync(join(f.dir, 'audit')), false);
});

test('two successful validators confirm descendant drain and allow exact-head continuation', { timeout: 12000 }, async t => {
  const f = fixture(t, `
    for round in 1 2; do
      "${process.execPath}" "${root}/bin/hammer-validate.mjs" -- "${process.execPath}" -e '
        ${publishReady('{pid:process.pid,ppid:process.ppid}')} '
    done
    printf validated > "$HAM_RUN_DIR/audit"
  `);
  const p = f.start();
  assert.equal((await p.closed)[0], 0, `${p.output()} ${JSON.stringify(f.receipt())}`);
  assert.equal(readFileSync(join(f.dir, 'audit'), 'utf8'), 'validated');
  assert.equal(f.receipt().state, 'quiescent');
  assert.equal(f.receipt().leaseCleanup.released, true);
});

test('a successful test leader cannot hide a background descendant from validation', { timeout: 12000 }, async t => {
  const f = fixture(t, `
    "${process.execPath}" "${root}/bin/hammer-validate.mjs" -- "${process.execPath}" -e '
      const {spawn}=require("node:child_process");
      const child=spawn(process.execPath,["-e","process.on(\\"SIGTERM\\",()=>{}); console.log(\\"ready\\"); setInterval(()=>{},1000)"],{stdio:["ignore","pipe","ignore"]});
      child.stdout.once("data",()=>{
        ${publishReady('{pid:child.pid,ppid:process.ppid}')}
        child.unref(); child.stdout.destroy();
      });'
    printf forbidden > "$HAM_RUN_DIR/audit"
  `);
  const p = f.start();
  assert.equal((await p.closed)[0], 143, p.output());
  assert.equal(f.receipt().reason, 'validation-descendants-or-probe-unconfirmed');
  assert.equal(f.receipt().state, 'quiescent');
  assert.equal(f.receipt().killSent, true);
  assert.equal(existsSync(join(f.dir, 'audit')), false);
});

// These fixtures exercise the actual provider inside the inherited worker
// boundary. Only canonical launch reads are replaced with private local rows.
for (const exitCode of [0, 7]) {
  test(`real census admits assert-owner and preserves script exit ${exitCode}`, { timeout: 15000 }, async t => {
    const f = fixture(t, `"${process.execPath}" "${root}/bin/hammer-controller.mjs" assert-owner
      printf ready > "$HAM_RUN_DIR/ready"
      exit ${exitCode}`, { realCensus: true });
    const p = f.start();
    assert.equal((await p.closed)[0], exitCode, `${p.output()} ${JSON.stringify(f.receipt())}`);
    assert.equal(existsSync(join(f.dir, 'ready')), true);
    assert.equal(f.receipt().state, 'quiescent');
    assert.equal(f.receipt().drained, true);
    assert.equal(f.receipt().leaseCleanup.released, true);
    assert.deepEqual(controllerGroupSnapshot(f.receipt().shellPid), []);
  });
}

test('real census drains all matching descendants after leader exit and preserves unrelated group', { timeout: 15000 }, async t => {
  const f = fixture(t, `"${process.execPath}" -e '
    const {spawn}=require("node:child_process");
    const child=spawn(process.execPath,["-e", "process.on(\\"SIGTERM\\",()=>{});setInterval(()=>{},1000)"],{stdio:"ignore"});
    child.unref();
    process.on("SIGTERM",()=>{});
    ${publishReady('{pid:process.pid,ppid:process.ppid,child:child.pid}')}
    setInterval(()=>{},1000);' &
    wait`, { realCensus: true });
  const p = f.start();
  await until(() => existsSync(join(f.dir, 'test-ready')));
  const ready = JSON.parse(readFileSync(join(f.dir, 'test-ready'), 'utf8'));
  await until(() => controllerGroupSnapshot(f.receipt().shellPid).some(m => m.pid === ready.child));
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
  t.after(async () => { const done = once(unrelated, 'close'); unrelated.kill(); await done; });
  // Let the controller witness births before the group leader exits on TERM.
  await delay(100);
  f.cancel();
  assert.equal((await p.closed)[0], 143, `${p.output()} ${JSON.stringify(f.receipt())}`);
  assert.equal(f.receipt().killSent, true);
  assert.equal(f.receipt().drained, true);
  assert.equal(f.receipt().leaseCleanup.released, true);
  assert.deepEqual(controllerGroupSnapshot(f.receipt().shellPid), []);
  assert.equal(unrelated.exitCode, null);
  assert.equal(unrelated.signalCode, null);
});


test('missing native execution capability refuses readiness before any lease or script',
  { skip: process.platform !== 'darwin', timeout: 10000 }, async t => {
    const f = fixture(t, 'printf forbidden > "$HAM_RUN_DIR/audit"', { realCensus: true });
    f.env.HQ_PYTHON3 = join(f.dir, 'missing-python');
    const p = f.start();
    assert.equal((await p.closed)[0], 125);
    assert.match(p.output(), /refused before readiness: controller process census unavailable: kern\.proc\.pgrp sysctl census helper .* failed \(ENOENT\); it executes no setuid binary and needs no operator process-introspection change/);
    assert.equal(f.receipt().errorCode, 'ENOENT');
    assert.equal(f.receipt().state, 'cleanup-unconfirmed');
    assert.equal(f.receipt().drained, false);
    assert.equal(existsSync(join(f.dir, 'merge-lease-acquire.json')), false);
    assert.equal(existsSync(join(f.dir, 'audit')), false);
  });

// HAMCTLPOLL-01: a fake clock drives the controller loop; the fake shell
// leaves only after the scenario says so, or on the controller's TERM.
function simulate(t, { reads, onTick = () => {}, ...options }) {
  const f = fixture(t, 'exit 0');
  let clock = 0, exited = false;
  const answers = [], readCalls = [], signals = [];
  const control = new Duplex({ read() {}, write(chunk, _encoding, done) { answers.push(String(chunk)); done(); } });
  const child = Object.assign(new EventEmitter(), {
    pid: 4242, stdin: new PassThrough(), stdio: [null, null, null, null, control],
    kill() { return true; }, unref() {},
  });
  const sim = { answers, readCalls, signals, control, clock: () => clock,
    exit(code, signal = null) {
      if (exited) return;
      exited = true; child.emit('exit', code, signal);
    } };
  const run = runHammerController('/fixture', [], {
    env: f.env, timeoutMs: 3_600_000, readTimeoutImpl: () => 30_000, nowImpl: () => clock,
    delayImpl: ms => { clock += ms; onTick(sim); return new Promise(resolve => setImmediate(resolve)); },
    readLaunchImpl: async args => { readCalls.push({ ...args, at: clock }); return reads(readCalls.length, sim); },
    spawnImpl: () => child,
    snapshotImpl: () => (exited ? [] : [{ pid: 4242, birth: 'fixture-birth' }]),
    signalGroupImpl(pid, signal) {
      assert.equal(pid, -4242);
      signals.push({ signal, at: clock });
      setImmediate(() => sim.exit(null, signal));
    },
    releaseImpl: () => ({ released: false, reason: 'no-acquisition-receipt' }),
    ...options,
  });
  return { ...sim, done: run.then(status => ({ status, receipt: f.receipt() })) };
}
const unreadable = () => ({ ok: false, reason: 'fixture-read-timeout' });

test('one failed launch read mid-run does not stop the round', async t => {
  const sim = simulate(t, { reads: n => (n === 3 ? unreadable() : launch('running')),
    onTick: s => { if (s.clock() >= 45_000) s.exit(0); } });
  const { status, receipt } = await sim.done;
  assert.equal(status, 0);
  assert.equal(receipt.reason, 'shell-exited');
  assert.deepEqual(sim.signals, []);
  assert.equal(receipt.launchReadFailures, 1);
  assert.equal(receipt.launchReadLastError, 'fixture-read-timeout');
  assert.ok(Number.isFinite(Date.parse(receipt.launchReadFirstFailureAt)));
});

test('failed launch reads sustained past the grace window stop the round as unreadable', async t => {
  const sim = simulate(t, { reads: n => {
    if (n === 1) return launch('running');
    throw Object.assign(new Error('fixture read timeout'), { code: 'ETIMEDOUT' });
  } });
  const { status, receipt } = await sim.done;
  assert.equal(status, 143);
  assert.equal(receipt.reason, 'launch-unreadable');
  assert.equal(sim.signals[0].signal, 'SIGTERM');
  // No stop before the window, and none long after it.
  assert.ok(sim.signals[0].at >= LAUNCH_UNREADABLE_GRACE_MS, JSON.stringify(sim.signals));
  assert.ok(sim.signals[0].at <= LAUNCH_UNREADABLE_GRACE_MS + 2000, JSON.stringify(sim.signals));
  assert.ok(receipt.launchReadFailures >= 10 && receipt.launchReadFailures <= 12, String(receipt.launchReadFailures));
  assert.equal(receipt.launchReadLastError, 'ETIMEDOUT');
});

for (const status of ['canceled', 'blocked_needs_decision']) {
  test(`a readable ${status} launch stops the round at once`, async t => {
    const sim = simulate(t, { reads: n => launch(n === 3 ? status : 'running') });
    const result = await sim.done;
    assert.equal(result.status, 143);
    assert.equal(result.receipt.reason, 'launch-ended');
    assert.equal(sim.readCalls.length, 3);
    // The third read is due 20s in; the stop lands on the next pass.
    assert.ok(sim.signals[0].at <= 2 * LAUNCH_POLL_MS + 1000, JSON.stringify(sim.signals));
    assert.equal(result.receipt.launchReadFailures, 0);
  });
}

test('the launch read runs every 10 seconds, about 6 times a minute, never while one is in flight', async t => {
  let inFlight = 0, overlapped = false;
  const sim = simulate(t, {
    reads: async () => {
      if (++inFlight > 1) overlapped = true;
      await new Promise(resolve => setImmediate(resolve));
      inFlight -= 1;
      return launch('running');
    },
    onTick: s => { if (s.clock() >= 60_000) s.exit(0); },
  });
  assert.equal((await sim.done).status, 0);
  // The start read plus one every 10s; a 1s cadence would make about 60.
  assert.ok(sim.readCalls.length >= 6 && sim.readCalls.length <= 7, String(sim.readCalls.length));
  assert.deepEqual(sim.readCalls.slice(1, 6).map(read => read.at), [10_000, 20_000, 30_000, 40_000, 50_000]);
  assert.equal(overlapped, false);
});

test('each launch read uses the load-aware ledger timeout with a matching abort signal', async t => {
  const sim = simulate(t, { readTimeoutImpl: undefined, reads: () => launch('running'),
    onTick: s => { if (s.clock() >= 15_000) s.exit(0); } });
  assert.equal((await sim.done).status, 0);
  for (const read of sim.readCalls) {
    // The adapter's 30s nominal psql timeout, scaled up under load and never capped at 2s.
    assert.ok(read.timeoutMs >= 30_000, String(read.timeoutMs));
    assert.ok(read.signal instanceof AbortSignal);
  }
  // Abandoned reads cannot hold a finished controller open.
  assert.equal(sim.readCalls.at(-1).signal.aborted, true);
  const scaled = simulate(t, { readTimeoutImpl: () => 95_000, reads: () => launch('running'),
    onTick: s => { if (s.clock() >= 5_000) s.exit(0); } });
  assert.equal((await scaled.done).status, 0);
  assert.equal(scaled.readCalls[0].timeoutMs, 95_000);
});

test('start retries one failed launch read, then runs on a good one', async t => {
  const sim = simulate(t, { reads: n => (n === 1 ? unreadable() : launch('running')),
    onTick: s => { if (s.clock() >= 5_000) s.exit(0); } });
  const { status, receipt } = await sim.done;
  assert.equal(status, 0);
  assert.deepEqual(sim.readCalls.slice(0, 2).map(read => read.at), [0, 1000]);
  assert.equal(receipt.launchReadFailures, 1);
});

test('start refuses a terminal read at once and an unreadable launch after three reads', async () => {
  const env = { HAM_RUN_DIR: '/fixture', HAM_ROOT_DIR: '/fixture', HAM_REPO: 'fixture/repo',
    HAM_PR_NUMBER: '42', HQ_LAUNCH_REQUEST_ID: 'lrq_controller-test' };
  for (const [probe, expected] of [[launch('canceled'), 1], [unreadable(), 3]]) {
    let reads = 0;
    await assert.rejects(runHammerController('/does-not-run', [], { env, delayImpl: async () => {},
      readLaunchImpl: async () => { reads += 1; return probe; } }), /refusing controller start/);
    assert.equal(reads, expected);
  }
});

for (const [kind, gateRead, answer, reason] of [
  ['permitted', () => launch('running'), 'clear\n', 'shell-exited'],
  ['terminal', () => launch('canceled'), 'blocked\n', 'launch-ended'],
  ['unreadable', unreadable, 'blocked\n', 'shell-exited'],
]) {
  test(`a lease or merge step with a stale read takes a fresh read first: ${kind}`, async t => {
    let gateAt, readsAtGate;
    const sim = simulate(t, {
      // Periodic reads fail, so the newest permitted read (t=0) goes stale.
      reads: n => (n === 1 ? launch('running') : gateAt === undefined ? unreadable() : gateRead()),
      onTick: s => {
        if (gateAt === undefined && s.clock() >= 50_000) {
          gateAt = s.clock(); readsAtGate = s.readCalls.length;
          s.control.push('launch:123\n');
        }
        if (gateAt !== undefined && s.clock() >= gateAt + 10_000) s.exit(0);
      },
    });
    const { receipt } = await sim.done;
    assert.equal(sim.answers[0], answer);
    assert.ok(sim.readCalls.length > readsAtGate, 'the step took a fresh read');
    assert.equal(receipt.reason, reason);
    // An unreadable gate blocks only the step; the grace window alone ends a round.
    if (kind === 'unreadable') assert.deepEqual(sim.signals, []);
  });
}

test('a lease or merge step with a fresh permitted read clears without another read', async t => {
  let readsAtGate, readsAtAnswer;
  const sim = simulate(t, {
    reads: () => launch('running'),
    onTick: s => {
      if (s.clock() === 3_000) { readsAtGate = s.readCalls.length; s.control.push('launch:123\n'); }
      if (readsAtAnswer === undefined && s.answers.length) readsAtAnswer = s.readCalls.length;
      if (s.clock() >= 8_000) s.exit(0);
    },
  });
  assert.equal((await sim.done).status, 0);
  assert.deepEqual(sim.answers, ['clear\n']);
  assert.equal(readsAtAnswer, readsAtGate);
});

test('real shell: assert-launch clears on a fresh read and blocks a stale unreadable launch without ending the round',
  { timeout: 20000 }, async t => {
    const gate = `printf ready > "$HAM_RUN_DIR/ready"
      while [ ! -e "$HAM_RUN_DIR/go" ]; do sleep 0.05; done
      if "${process.execPath}" "${root}/bin/hammer-controller.mjs" assert-launch; then
        printf cleared > "$HAM_RUN_DIR/audit"
      else printf blocked > "$HAM_RUN_DIR/audit"; fi`;
    const clear = fixture(t, gate);
    writeFileSync(join(clear.dir, 'go'), 'go');
    const p = clear.start();
    assert.equal((await p.closed)[0], 0, `${p.output()} ${JSON.stringify(clear.receipt())}`);
    assert.equal(readFileSync(join(clear.dir, 'audit'), 'utf8'), 'cleared');

    const blocked = fixture(t, gate);
    blocked.env.FIXTURE_GRACE_MS = '60000';
    const q = blocked.start();
    await until(() => existsSync(join(blocked.dir, 'ready')));
    blocked.cancel({ ok: false, reason: 'fixture-read-timeout' });
    // Let the newest permitted read age past one poll plus one read timeout.
    await delay(300);
    writeFileSync(join(blocked.dir, 'go'), 'go');
    assert.equal((await q.closed)[0], 0, `${q.output()} ${JSON.stringify(blocked.receipt())}`);
    assert.equal(readFileSync(join(blocked.dir, 'audit'), 'utf8'), 'blocked');
    assert.equal(blocked.receipt().reason, 'shell-exited');
    assert.ok(blocked.receipt().launchReadFailures > 0);
    assert.equal(blocked.receipt().launchReadLastError, 'fixture-read-timeout');
  });

test('closing scripts take the lease and click merge only after assert-launch', () => {
  const acquire = readFileSync(join(root, 'bin/hammer-verify-head.sh'), 'utf8');
  const body = acquire.slice(acquire.indexOf('ham_acquire_merge_lease() {'));
  assert.ok(body.indexOf('assert-launch') < body.indexOf('merge-lease.mjs acquire'));
  const merge = readFileSync(join(root, 'bin/hammer-merge.sh'), 'utf8');
  const click = merge.indexOf('ham_gh pr merge <<PR_URL>>');
  // The gate follows the last pre-click recheck, so each retried click repeats it.
  assert.ok(click > 0 && merge.lastIndexOf('assert-launch', click) > merge.lastIndexOf('stacked-base-check.mjs', click));
});
