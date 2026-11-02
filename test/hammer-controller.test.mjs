// Offline fixtures must never select an inherited own-launch HCP credential.
for (const key of ['HCP_TOKEN_PATH', 'HCP_TOKEN', 'HCP_BEARER_TOKEN']) delete process.env[key];
process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS || ''} --import=${new URL('./helpers/dispatch-files-preload.mjs', import.meta.url).href}`;
import { installDispatchFileProducerFixture } from './helpers/dispatch-files-fixture.mjs';
installDispatchFileProducerFixture();
import './helpers/dispatch-read-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { Duplex, PassThrough } from 'node:stream';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, renameSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { assertHammerController, controllerGroupSnapshot, createControllerGroupCensus, controllerLaunchId, controllerLaunchEnvironment, controllerLedgerTarget, groupStillOwned, releaseControllerLease, runHammerController,
  LAUNCH_POLL_MS, LAUNCH_READ_ATTEMPTS, LAUNCH_UNREADABLE_GRACE_MS } from '../src/ama/hammer-controller.mjs';
import { acquireMergeLease, inspectMergeLease, releaseMergeLease, mergeLeaseFilePath } from '../src/ama/merge-lease.mjs';
import { readLaunchRequestStatusFromLedgerAsync } from '../src/session-ledger-read-adapter.mjs';
import { createControllerCensus, nativeControllerIdentity } from '../src/controller-process-census.mjs';
import Database from 'better-sqlite3';

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

function recordEnvironment(dir, value = '1', launchRequestId = 'lrq_controller-test') {
  const path = join(dir, 'dispatch', launchRequestId);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'env-contract.json'), JSON.stringify({
    launchProvenance: { launchRequestId, workerClass: 'hammer' },
    ADVERSARIAL_DISPATCH_READS_ENABLED: value,
  }));
}

function fixture(t, script, { realCensus = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ham-controller-'));
  recordEnvironment(dir);
  const env = { ...process.env, HQ_ROOT: dir, HAM_HQ_ROOT: dir, HAM_RUN_DIR: dir, HAM_ROOT_DIR: dir, HAM_REPO: 'fixture/repo',
    HAM_PR_NUMBER: '42', HQ_LAUNCH_REQUEST_ID: 'lrq_controller-test', AGENT_OS_WORKER_LRQ_ID: 'lrq_controller-test' };
  delete env.LAUNCH_REQUEST_ID;
  for (const key of ['HAM_CONTROLLER_RECORD', 'HAM_CONTROLLER_TOKEN', 'HAM_CONTROLLER_PID', 'HAM_CONTROLLER_FD']) delete env[key];
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

test('controller database target compatibility shim never selects local state',()=>{
  assert.equal(controllerLedgerTarget({AGENT_OS_SESSION_LEDGER_BACKEND:'postgres',AGENT_OS_SESSION_LEDGER_CANONICAL_DSN:'synthetic'}),undefined);
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
    assert.ok(options.timeout >= 2000 && options.timeout <= 12000);
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

// Public launch observations ignore local/standby database configuration.
for (const [status, outcome] of [['running', /spawn-reached/], ['succeeded', /refusing controller start/], ['missing', /refusing controller start/]]) {
  test(`controller bootstrap uses SDK launch evidence (${status})`, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'controller-sdk-'));
    recordEnvironment(dir);
    t.after(() => rmSync(dir, { recursive:true, force:true }));
    let reads=0;
    await assert.rejects(runHammerController('/does-not-run', [], {
      env: {HQ_ROOT:dir,HAM_RUN_DIR:dir,HAM_ROOT_DIR:dir,HAM_REPO:'example/repo',HAM_PR_NUMBER:'42',HQ_LAUNCH_REQUEST_ID:'lrq_controller-test'},
      readLaunchImpl: args => readLaunchRequestStatusFromLedgerAsync({...args,dispatchSession:{dispatchLookup:async()=>{
        reads++;
        const items=status==='missing'?[]:[{launch_request_id:'lrq_controller-test',status}];
        return {schema_version:1,status:items.length?'found':'not_found',complete:true,roots:items.map(row=>row.launch_request_id),items,retry_edges:[]};
      }}}),delayImpl:async()=>{},spawnImpl:()=>{throw Error('spawn-reached');},
    }),outcome);
    assert.equal(reads,status==='missing'?LAUNCH_READ_ATTEMPTS:1);
  });
}

for (const probe of [launch('canceled'), launch('blocked_needs_decision'), { ok: false }, launch('future-status')]) {
  test(`start refuses non-executable launch ${probe.row?.status || 'unreadable'}`, async t => {
    const f = fixture(t, 'exit 0');
    await assert.rejects(runHammerController('/does-not-run', [], {
      env: f.env,
      readLaunchImpl: async () => probe, delayImpl: async () => {},
    }), /refusing controller start/);
  });
}

for (const value of [undefined, '', '0', 'true', 1, '1']) {
  test(`controller reads recorded activation ${JSON.stringify(value)}, ignoring later exports`, async t => {
    const f = fixture(t, 'exit 0');
    recordEnvironment(f.dir, value);
    // Undefined is a missing field, not the helper's default enabled fixture.
    if (value === undefined) {
      const path = join(f.dir, 'dispatch/lrq_controller-test/env-contract.json');
      writeFileSync(path, JSON.stringify({ launchProvenance: { launchRequestId: 'lrq_controller-test' } }));
    }
    const env = { ...f.env, ADVERSARIAL_DISPATCH_READS_ENABLED: value === '1' ? '0' : '1' };
    let observed;
    await assert.rejects(runHammerController('/does-not-run', [], {
      env, delayImpl: async () => {},
      readLaunchImpl: args => {
        observed = args.env.ADVERSARIAL_DISPATCH_READS_ENABLED;
        if (observed !== '1') return { ok: false, reason: 'dispatch reads disabled' };
        return launch('running');
      },
      spawnImpl: () => { throw Error('spawn-reached'); },
    }), value === '1' ? /spawn-reached/ : /refusing controller start/);
    assert.equal(observed, value === '1' ? '1' : '0');
    assert.equal(env.ADVERSARIAL_DISPATCH_READS_ENABLED, value === '1' ? '0' : '1');
  });
}

for (const otherRoots of [false, true]) {
  test(`controller uses HAM_HQ_ROOT ${otherRoots ? 'ahead of other roots' : 'without other roots'}`, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'controller-root-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const launchRequestId = 'lrq_custom';
    recordEnvironment(dir, '1', launchRequestId);
    const env = { HAM_HQ_ROOT: dir, HAM_RUN_DIR: dir, HAM_ROOT_DIR: dir,
      HAM_REPO: 'fixture/repo', HAM_PR_NUMBER: '42', HQ_LAUNCH_REQUEST_ID: launchRequestId,
      ADVERSARIAL_DISPATCH_READS_ENABLED: '0',
      ...(otherRoots ? { HQ_ROOT: join(dir, 'wrong-hq'), AGENT_OS_HQ_ROOT: join(dir, 'wrong-agent-hq') } : {}) };
    await assert.rejects(runHammerController('/does-not-run', [], {
      env,
      readLaunchImpl: args => {
        assert.equal(args.hqRoot, dir);
        assert.equal(args.env.ADVERSARIAL_DISPATCH_READS_ENABLED, '1');
        return { ok: true, row: { launch_request_id: launchRequestId, status: 'running' } };
      },
      spawnImpl: () => { throw Error('spawn-reached'); },
    }), /spawn-reached/);
    assert.equal(env.ADVERSARIAL_DISPATCH_READS_ENABLED, '0');
  });
}

test('controller launch environment defaults to process.env', t => {
  const dir = mkdtempSync(join(tmpdir(), 'controller-default-env-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  recordEnvironment(dir, '1', 'lrq_default-env');
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { controllerLaunchEnvironment } from ${JSON.stringify(new URL('../src/ama/hammer-controller.mjs', import.meta.url).href)};
    console.log(controllerLaunchEnvironment().ADVERSARIAL_DISPATCH_READS_ENABLED);
  `], { encoding: 'utf8', timeout: 10000,
    env: { NODE_OPTIONS: process.env.NODE_OPTIONS, TMPDIR: process.env.TMPDIR,
      ADVERSARIAL_REVIEW_TEST_SANDBOX_ROOT: process.env.ADVERSARIAL_REVIEW_TEST_SANDBOX_ROOT, HQ_ROOT: dir, HQ_LAUNCH_REQUEST_ID: 'lrq_default-env', ADVERSARIAL_DISPATCH_READS_ENABLED: '0' } });
  assert.equal(output.trim(), '1');
});

test('missing, malformed and foreign launch environment refuses before any dispatch read', async t => {
  const f = fixture(t, 'exit 0');
  const path = join(f.dir, 'dispatch/lrq_controller-test/env-contract.json');
  for (const content of [null, '{broken', JSON.stringify({ launchProvenance: { launchRequestId: 'lrq_foreign' }, ADVERSARIAL_DISPATCH_READS_ENABLED: '1' })]) {
    if (content === null) rmSync(path); else writeFileSync(path, content);
    assert.throws(() => controllerLaunchEnvironment(f.env));
    await assert.rejects(runHammerController('/does-not-run', [], {
      env: { ...f.env, ADVERSARIAL_DISPATCH_READS_ENABLED: '1' },
      readLaunchImpl: () => assert.fail('unconfirmed launch must not read dispatch'),
    }));
  }
});

test('normal script preserves real failure and releases only its matching lease', { timeout: 12000 }, async t => {
  const f = fixture(t, 'exit 7');
  const p = f.start();
  assert.equal((await p.closed)[0], 7, `${p.output()} ${JSON.stringify(f.receipt())}`);
  assert.equal(f.receipt().state, 'quiescent');
  assert.equal(f.receipt().leaseCleanup.released, true);
  assert.equal(inspectMergeLease({ rootDir: f.dir, repo: 'fixture/repo', base: 'main' }).holder, null);
});

for (const kind of ['terminal', 'unreadable', 'malformed', 'different-launch']) {
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
    if (kind === 'malformed') {
      writeFileSync(f.launchPath + '.tmp', '{');
      renameSync(f.launchPath + '.tmp', f.launchPath);
    } else {
      f.cancel(kind === 'terminal' ? launch('canceled') : kind === 'unreadable' ? { ok: false }
        : { ok: true, row: { launch_request_id: 'lrq_foreign', status: 'running' } });
    }
    await until(() => existsSync(join(f.dir, 'result')));
    assert.equal(readFileSync(join(f.dir, 'result'), 'utf8'), '143');
    assert.equal(f.receipt().reason, ['unreadable', 'malformed'].includes(kind) ? 'launch-unreadable' : 'launch-ended');
    if (kind === 'malformed') assert.equal(f.receipt().launchReadLastError, 'SyntaxError');
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
  assert.throws(() => assertHammerController(env, { readGroupImpl: () => null }), { code: 'EOBSERVATION' });
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
function simulate(t, { reads, onTick = () => {}, env = {}, ...options }) {
  const f = fixture(t, 'exit 0');
  const simulatedEnv = { ...f.env, ...env };
  for (const key of Object.keys(simulatedEnv)) if (simulatedEnv[key] === undefined) delete simulatedEnv[key];
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
    env: simulatedEnv, timeoutMs: 3_600_000, readTimeoutImpl: () => 30_000, nowImpl: () => clock,
    delayImpl: ms => { clock += ms; onTick(sim); return new Promise(resolve => setImmediate(resolve)); },
    readLaunchImpl: async args => { readCalls.push({ ...args, at: clock }); return reads(readCalls.length, sim, args); },
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

// A synthetic serve-mode census helper whose answers come from `members`.
function censusHelpers(members) {
  const spawned = [], requests = [];
  const spawnImpl = () => {
    const helper = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(),
      exitCode: null, signalCode: null, kill(signal) { this.signalCode = signal; return true; }, unref() {} });
    helper.stdin.on('data', chunk => {
      for (const line of String(chunk).split('\n').filter(Boolean)) {
        requests.push(line);
        helper.stdout.write(`${JSON.stringify({ ok: members() })}\n`);
      }
    });
    spawned.push(helper);
    return helper;
  };
  const groupCensusImpl = ({ env }) => createControllerGroupCensus({ platform: 'darwin', env,
    createCensusImpl: options => createControllerCensus({ ...options, spawnImpl }) });
  return { spawned, requests, groupCensusImpl };
}

test('QCP-08: a round starts one census helper instead of one child per tick, with the same decisions', async t => {
  const ticks = 8;
  const round = async census => {
    let finished = false, reads = 0;
    const members = () => (finished ? [] : [{ pid: 4242, birth: '100.000001' }]);
    const sim = simulate(t, { reads: () => launch('running'), snapshotImpl: undefined, ...census(members),
      onTick: s => { if (++reads >= ticks && !finished) { finished = true; s.exit(0); } } });
    const { status, receipt } = await sim.done;
    return { status, reason: receipt.reason, state: receipt.state, drained: receipt.drained, signals: sim.signals };
  };
  // Before: the one-shot census starts a helper child for every tick.
  const legacy = [];
  const before = await round(members => ({ snapshotImpl: pgid => controllerGroupSnapshot(pgid, { platform: 'darwin',
    nativeImpl: (verb, pid) => nativeControllerIdentity(verb, pid, { execFileSyncImpl(bin, args) {
      legacy.push(args.slice(-2)); return JSON.stringify(members());
    } }) }) }));
  // After: one helper serves the round; it still answers one fresh read per tick.
  let helpers;
  const after = await round(members => { helpers = censusHelpers(members); return { groupCensusImpl: helpers.groupCensusImpl }; });
  assert.deepEqual(after, before);
  assert.deepEqual(before, { status: 0, reason: 'shell-exited', state: 'quiescent', drained: true, signals: [] });
  assert.ok(legacy.length > ticks, `one census per tick: ${legacy.length}`);
  assert.deepEqual(legacy, Array(legacy.length).fill(['group', '4242']));
  assert.equal(helpers.spawned.length, 1);
  assert.deepEqual(helpers.requests, Array(legacy.length).fill('group 4242'));
  // The round closed its helper; nothing outlives the controller.
  assert.equal(helpers.spawned[0].signalCode, 'SIGKILL');
});

test('QCP-08: a census refused mid-round never authorizes a group signal', async t => {
  let calls = 0;
  const census = { snapshot: async pgid => {
    assert.equal(pgid, 4242);
    if (++calls <= 2) return [{ pid: 4242, birth: '100.000001' }];
    throw Object.assign(new Error('fixture census refused'), { code: 'EPERM' });
  }, closed: false, close() { this.closed = true; } };
  const sim = simulate(t, { reads: () => launch('running'), snapshotImpl: undefined, groupCensusImpl: () => census });
  const { status, receipt } = await sim.done;
  assert.equal(status, 125);
  assert.deepEqual(sim.signals, []);
  assert.equal(receipt.reason, 'process-probe-unreadable');
  assert.equal(receipt.probeError, 'EPERM');
  assert.equal(receipt.directTermSent, true);
  assert.equal(receipt.directKillSent, true);
  assert.equal(receipt.state, 'cleanup-unconfirmed');
  assert.equal(census.closed, true);
});

test('QCP-08: a validator request that lands during a census is judged by the next census', async t => {
  const token = '22222222-2222-4222-8222-222222222222';
  let calls = 0, sim;
  const shell = { pid: 4242, birth: '100.000001' }, validator = { pid: 999, birth: '100.000002' };
  const descendant = { pid: 1000, birth: '100.000003' };
  sim = simulate(t, { reads: () => launch('running'), snapshotImpl: async () => {
    calls += 1;
    if (sim?.signals.length) return [];
    if (calls === 3) {
      // The descendant forks after this census began; the request arrives before it answers.
      sim.control.push(`complete:999:${token}\n`);
      await new Promise(resolve => setImmediate(resolve));
      return [shell, validator];
    }
    return calls > 3 ? [shell, validator, descendant] : [shell];
  } });
  const { receipt } = await sim.done;
  assert.deepEqual(sim.answers, [`blocked:${token}\n`]);
  assert.equal(receipt.reason, 'validation-descendants-or-probe-unconfirmed');
});

const gateToken = '11111111-1111-4111-8111-111111111111';
const gateRequest = `launch:123:${gateToken}\n`;
const gateReplies = sim => sim.answers.filter(answer => !answer.startsWith('wait:'));

for (const [backend, canonical] of [
  ['postgres', undefined], ['postgres', ''], ['postgres', 'postgres://runtime.example/ledger'],
  ['sqlite', 'postgres://runtime.example/ledger'], [undefined, 'postgres://runtime.example/ledger'],
]) {
  test(`controller startup and polling respect backend=${backend} and canonical=${Boolean(canonical)}`, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'ham-controller-ledger-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const sqlite = join(dir, 'ledger.db');
    const db = new Database(sqlite);
    t.after(() => db.close());
    db.exec(`CREATE TABLE launch_requests (launch_request_id TEXT, status TEXT, updated_at TEXT, terminal_at TEXT, failure_class TEXT);
      INSERT INTO launch_requests VALUES ('lrq_controller-test', 'running', NULL, NULL, NULL)`);
    const sim = simulate(t, {
      env: { AGENT_OS_CONFIG_PATH: '/dev/null', AGENT_OS_SESSION_LEDGER_BACKEND: backend,
        AGENT_OS_SESSION_LEDGER_POSTGRES_RUNTIME: undefined,
        AGENT_OS_SESSION_LEDGER_TARGET: backend === 'postgres' ? 'postgres://override.example/ledger' : undefined,
        AGENT_OS_SESSION_LEDGER_DB_PATH: backend === 'postgres' ? undefined : sqlite,
        SESSION_LEDGER_DB_PATH: undefined, AGENT_OS_SESSION_LEDGER_DSN: 'postgres://test.example/ledger',
        AGENT_OS_SESSION_LEDGER_CANONICAL_DSN: canonical },
      reads: async (n, _sim, args) => {
        if (n > 1) db.exec("UPDATE launch_requests SET status = 'canceled'");
        return readLaunchRequestStatusFromLedgerAsync({ ...args, dispatchSession: {dispatchLookup:async()=>{
          const row=launch(n===1?'running':'canceled').row;
          return {schema_version:1,status:'found',complete:true,roots:[row.launch_request_id],items:[row],retry_edges:[]};
        }} });
      },
    });
    const { status, receipt } = await sim.done;
    assert.equal(status, 143);
    assert.equal(receipt.reason, 'launch-ended');
    assert.ok(sim.readCalls.length >= 2);
    for (const read of sim.readCalls) {
      assert.equal(read.ledgerTarget, undefined);
      assert.equal(read.env.AGENT_OS_SESSION_LEDGER_DSN, 'postgres://test.example/ledger');
    }
    assert.equal(receipt.launchReadSource, 'app-sdk');
    for (const secret of ['runtime.example', 'test.example', 'override.example', sqlite]) {
      assert.ok(!JSON.stringify(receipt).includes(secret), 'registration must not retain connection details');
    }
  });
}

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

test('a poll delayed beyond the grace window does not make a readable launch unreadable', async t => {
  const pollMs = LAUNCH_UNREADABLE_GRACE_MS + 1000;
  const sim = simulate(t, {
    pollMs,
    reads: () => launch('running'),
    onTick: s => { if (s.clock() >= 2 * pollMs) s.exit(0); },
  });
  const { status, receipt } = await sim.done;
  assert.equal(status, 0);
  assert.equal(receipt.reason, 'shell-exited');
  assert.equal(receipt.launchReadFailures, 0);
  assert.ok(sim.readCalls.length >= 2, 'a periodic read starts before its result is available');
  assert.deepEqual(sim.signals, []);
});

test('validator stop after a delayed poll cancels the registered round as validation-stopped', async t => {
  const sim = simulate(t, {
    pollMs: LAUNCH_UNREADABLE_GRACE_MS + 1000,
    reads: (n, s) => {
      // Queue the validator cancellation behind the resumed poll. The launch
      // remains readable throughout; elapsed scheduler time is not read failure.
      if (n === 2) setImmediate(() => s.control.push('stop\n'));
      return launch('running');
    },
  });
  const { status, receipt } = await sim.done;
  assert.equal(status, 143);
  assert.equal(receipt.reason, 'validation-stopped');
  assert.equal(receipt.state, 'quiescent');
  assert.equal(receipt.launchReadFailures, 0);
  assert.equal(sim.signals[0].signal, 'SIGTERM');
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

test('start refuses a terminal read at once and an unreadable launch after three reads', async t => {
  const { env } = fixture(t, 'exit 0');
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
          s.control.push(gateRequest);
        }
        if (gateAt !== undefined && s.clock() >= gateAt + 10_000) s.exit(0);
      },
    });
    const { receipt } = await sim.done;
    assert.equal(gateReplies(sim)[0], answer.trim() + ':' + gateToken + '\n');
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
      if (s.clock() === 3_000) { readsAtGate = s.readCalls.length; s.control.push(gateRequest); }
      if (readsAtAnswer === undefined && s.answers.length) readsAtAnswer = s.readCalls.length;
      if (s.clock() >= 8_000) s.exit(0);
    },
  });
  assert.equal((await sim.done).status, 0);
  assert.deepEqual(gateReplies(sim), [`clear:${gateToken}\n`]);
  assert.equal(readsAtAnswer, readsAtGate);
});

for (const readMs of [30_000, 90_000, 180_000]) {
  test(`a gate allows all three ${readMs}ms reads, including beyond the round grace`, async t => {
    let gateAt, pendingRead, attempts = 0;
    const sim = simulate(t, {
      readTimeoutImpl: () => readMs,
      reads: (n, s) => {
        if (n === 1) return launch('running');
        if (gateAt === undefined) return unreadable();
        if (gateReplies(s).length) return unreadable(); // Subsequent periodic read is outside the gate.
        attempts += 1;
        return new Promise(resolve => { pendingRead = { resolve, at: s.clock() + readMs, attempt: attempts }; });
      },
      onTick: s => {
        if (gateAt === undefined && s.clock() >= readMs + 20_000) {
          gateAt = s.clock(); s.control.push(gateRequest);
        }
        if (pendingRead && s.clock() >= pendingRead.at) {
          pendingRead.resolve(pendingRead.attempt === 3 ? launch('running') : unreadable());
          pendingRead = undefined;
        }
        if (gateReplies(s).length) s.exit(0);
      },
    });
    const result = await sim.done;
    assert.equal(result.status, 0);
    assert.equal(attempts, 3);
    assert.deepEqual(gateReplies(sim), [`clear:${gateToken}\n`]);
    assert.deepEqual(sim.signals, []);
    const advertised = Number(sim.answers[0].trim().split(':')[2]);
    assert.ok(advertised >= 3 * readMs + 10_000);
    assert.ok(sim.clock() >= gateAt + 3 * readMs);
  });
}

test('a read already in flight at the gate deadline resolves before a blocked reply', async t => {
  let gateAt, resolveRead, resolvedAt;
  const sim = simulate(t, {
    reads: n => {
      if (n === 1) return launch('running');
      if (gateAt === undefined) return unreadable();
      return new Promise(resolve => { resolveRead = resolve; });
    },
    onTick: s => {
      if (gateAt === undefined && s.clock() >= 50_000) {
        gateAt = s.clock(); s.control.push(gateRequest);
      }
      if (resolveRead && s.clock() >= gateAt + 100_000) {
        assert.deepEqual(gateReplies(s), [], 'no premature answer at the gate deadline');
        resolvedAt = s.clock(); resolveRead(unreadable()); resolveRead = undefined;
      }
      if (gateReplies(s).length) s.exit(0);
    },
  });
  await sim.done;
  assert.ok(resolvedAt >= gateAt + 100_000);
  assert.deepEqual(gateReplies(sim), [`blocked:${gateToken}\n`]);
});

test('an unreadable gate exhausts three load-scaled reads and then the round grace stops it', async t => {
  let gateAt, pendingRead, attempts = 0;
  const sim = simulate(t, {
    readTimeoutImpl: () => 90_000,
    reads: (n, s) => {
      if (n === 1) return launch('running');
      if (gateAt === undefined) return unreadable();
      if (gateReplies(s).length) return unreadable();
      attempts += 1;
      return new Promise(resolve => { pendingRead = { resolve, at: s.clock() + 90_000 }; });
    },
    onTick: s => {
      if (gateAt === undefined && s.clock() >= 110_000) { gateAt = s.clock(); s.control.push(gateRequest); }
      if (pendingRead && s.clock() >= pendingRead.at) { pendingRead.resolve(unreadable()); pendingRead = undefined; }
    },
  });
  const result = await sim.done;
  assert.equal(result.receipt.reason, 'launch-unreadable');
  assert.equal(attempts, 3);
  assert.deepEqual(gateReplies(sim), [`blocked:${gateToken}\n`]);
  assert.ok(sim.signals[0].at >= gateAt + 270_000);
});

for (const verb of ['complete', 'launch']) {
  test(`${verb} handshake discards stale replies and parses fragmented correlated frames`, { timeout: 5000 }, async t => {
    const helper = spawn(process.execPath, ['--input-type=module', '-e', `
      import { confirmControllerLaunch, confirmControllerValidation } from ${JSON.stringify(new URL('../src/ama/hammer-controller.mjs', import.meta.url).href)};
      process.exitCode = await ${verb === 'launch' ? 'confirmControllerLaunch' : 'confirmControllerValidation'}() ? 0 : 1;
    `], { stdio: ['ignore', 'pipe', 'pipe', 'ignore', 'pipe'] });
    t.after(() => helper.kill());
    const closed = once(helper, 'close');
    let input = '';
    helper.stdio[4].on('data', chunk => {
      input += chunk;
      if (!input.includes('\n')) return;
      const [requestVerb, pid, token] = input.trim().split(':');
      assert.equal(requestVerb, verb);
      assert.equal(Number(pid), helper.pid);
      assert.match(token, /^[a-f0-9-]{36}$/);
      // Both stale negatives and stale positives must be ignored, even when
      // coalesced with a partial reply for this caller.
      helper.stdio[4].write(`blocked:${gateToken}\nclear:${gateToken}\nclear:${token.slice(0, 10)}`);
      setImmediate(() => helper.stdio[4].end(`${token.slice(10)}\n`));
    });
    assert.equal((await closed)[0], 0);
  });
}

test('a stale clear cannot override a correlated blocked handshake', { timeout: 5000 }, async t => {
  const helper = spawn(process.execPath, ['--input-type=module', '-e', `
    import { confirmControllerLaunch } from ${JSON.stringify(new URL('../src/ama/hammer-controller.mjs', import.meta.url).href)};
    process.exitCode = await confirmControllerLaunch() ? 1 : 0;
  `], { stdio: ['ignore', 'pipe', 'pipe', 'ignore', 'pipe'] });
  t.after(() => helper.kill());
  const closed = once(helper, 'close');
  let input = '';
  helper.stdio[4].on('data', chunk => {
    input += chunk;
    if (!input.includes('\n')) return;
    const token = input.trim().split(':')[2];
    helper.stdio[4].end(`clear:${gateToken}\nwait:${token}:1000\nblocked:${token}\n`);
  });
  assert.equal((await closed)[0], 0);
});

test('a launch handshake adopts the controller advertised socket timeout', { timeout: 5000 }, async t => {
  const helper = spawn(process.execPath, ['--input-type=module', '-e', `
    import { confirmControllerLaunch } from ${JSON.stringify(new URL('../src/ama/hammer-controller.mjs', import.meta.url).href)};
    process.exitCode = await confirmControllerLaunch() ? 1 : 0;
  `], { stdio: ['ignore', 'pipe', 'pipe', 'ignore', 'pipe'] });
  t.after(() => helper.kill());
  const closed = once(helper, 'close');
  let input = '';
  helper.stdio[4].on('data', chunk => {
    input += chunk;
    if (!input.includes('\n')) return;
    const token = input.trim().split(':')[2];
    // Keep the socket open: only adoption of this budget can end the wait.
    helper.stdio[4].write(`wait:${token}:20\n`);
  });
  assert.equal((await closed)[0], 0);
});

test('real shell: assert-launch clears on a fresh read and blocks a stale unreadable launch without ending the round',
  { timeout: 20000 }, async t => {
    const gate = `printf ready > "$HAM_RUN_DIR/ready"
      while [ ! -e "$HAM_RUN_DIR/go" ]; do sleep 0.05; done
      if "${process.execPath}" "${root}/bin/hammer-controller.mjs" assert-launch; then
        printf cleared > "$HAM_RUN_DIR/audit"
      else printf blocked > "$HAM_RUN_DIR/audit"; fi`;
    const clear = fixture(t, gate);
    // This case tests a fresh read, not startup deadline expiry. Match the
    // unreadable-read sibling's grace on loaded full-suite CI workers.
    clear.env.FIXTURE_GRACE_MS = '60000';
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
  const click = merge.indexOf('<<ROOT_DIR>>/bin/legacy-lane-write.mjs');
  // The gate follows the last pre-click recheck, so each retried click repeats it.
  assert.ok(click > 0 && merge.lastIndexOf('assert-launch', click) > merge.lastIndexOf('stacked-base-check.mjs', click));
});
