import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, renameSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { assertHammerController, controllerGroupSnapshot, controllerLaunchId, groupStillOwned, releaseControllerLease, runHammerController } from '../src/ama/hammer-controller.mjs';
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

function fixture(t, script) {
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
  Object.assign(env, { PATH: `${bin}:${env.PATH}`, CONTROLLER_FIXTURE_NODE: process.execPath, CONTROLLER_FIXTURE_PS: ps });
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
    import {runHammerController} from ${JSON.stringify(new URL('../src/ama/hammer-controller.mjs', import.meta.url).href)};
    const status = await runHammerController(${JSON.stringify(scriptPath)}, [], {
      pollMs:20, graceMs:150, drainMs:1000, timeoutMs:10000,
      readLaunchImpl:async()=>JSON.parse(readFileSync(${JSON.stringify(launchPath)},'utf8')),
      // The test owns these exact births. Inject the OS census so this offline
      // regression also runs in workers whose sandbox forbids ps.
      snapshotImpl:pgid=>{
        try {readFileSync(process.env.HAM_RUN_DIR+'/probe-denied');throw Object.assign(new Error('fixture census denied'),{code:'EPERM'})} catch(e) {if(e.code!=='ENOENT')throw e}
        let ready={}; try {ready=JSON.parse(readFileSync(process.env.HAM_RUN_DIR+'/test-ready','utf8'))} catch {}
        return [pgid,ready.pid,ready.ppid].filter(Boolean).filter(pid=>{
          try {
            process.kill(pid,0);
            try {if(readFileSync('/proc/'+pid+'/stat','utf8').match(/\\) Z /))return false} catch {}
            return true;
          } catch(e) {if(e.code==='ESRCH')return false;throw e}
        }).map(pid=>({pid,birth:'fixture-'+pid}));
      }
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

test('production census excludes unrelated groups and zombies, and fails closed on unreadable data', () => {
  const source = '100 100 S Sat Oct 24 08:00:00 2026\n101 100 Z Sat Oct 24 08:01:00 2026\n200 200 S Sat Oct 24 08:02:00 2026\n';
  const result = controllerGroupSnapshot(100, { execFileSyncImpl: () => source });
  assert.deepEqual(result, [{ pid: 100, birth: 'Sat Oct 24 08:00:00 2026' }]);
  assert.deepEqual(controllerGroupSnapshot(999, { execFileSyncImpl: () => source }), []);
  for (const text of ['', 'truncated', source + 'malformed']) {
    assert.throws(() => controllerGroupSnapshot(100, { execFileSyncImpl: () => text }), /census/);
  }
  assert.throws(() => controllerGroupSnapshot(100, { execFileSyncImpl() {
    throw Object.assign(new Error('fixture refusal'), { code: 'EPERM' });
  } }), { code: 'EPERM' });
});

for (const probe of [launch('canceled'), launch('blocked_needs_decision'), { ok: false }, launch('future-status')]) {
  test(`start refuses non-executable launch ${probe.row?.status || 'unreadable'}`, async () => {
    await assert.rejects(runHammerController('/does-not-run', [], {
      env: { HAM_RUN_DIR: '/fixture', HAM_ROOT_DIR: '/fixture', HAM_REPO: 'fixture/repo',
        HAM_PR_NUMBER: '42', HQ_LAUNCH_REQUEST_ID: 'lrq_controller-test' },
      readLaunchImpl: async () => probe,
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
    env: f.env, pollMs: 5, graceMs: 30, drainMs: 30,
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
