import { spawn, execFileSync } from 'node:child_process';
import { fstatSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { constants, hostname } from 'node:os';
import { join } from 'node:path';
import { Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { readLaunchRequestStatusFromLedgerAsync } from '../session-ledger-read-adapter.mjs';
import { launchRequestMeaning } from './launch-request-status.mjs';
import { inspectMergeLease, releaseMergeLease } from './merge-lease.mjs';
import { writeFileAtomic } from '../atomic-write.mjs';
import { currentProcessGroupId } from '../process-group-identity.mjs';
import { nativeControllerIdentity } from '../controller-process-census.mjs';

// Registration belongs to this invocation, never the shared PR or LRQ name.
export function controllerLaunchId(env) {
  const ids = [...new Set([env.HQ_LAUNCH_REQUEST_ID, env.AGENT_OS_WORKER_LRQ_ID,
    env.LAUNCH_REQUEST_ID].filter(Boolean))];
  if (ids.length !== 1 || !/^lrq_[A-Za-z0-9-]+$/.test(ids[0])) {
    throw new Error('hammer controller requires one unambiguous HQ launch identity');
  }
  return ids[0];
}

export function assertHammerController(env = process.env, { readGroupImpl = currentProcessGroupId } = {}) {
  const record = JSON.parse(readFileSync(env.HAM_CONTROLLER_RECORD, 'utf8'));
  if (record.schemaVersion !== 1 || record.state !== 'running' || record.token !== env.HAM_CONTROLLER_TOKEN
      || record.launchRequestId !== controllerLaunchId(env)
      || record.controllerPid !== Number(env.HAM_CONTROLLER_PID)
      || !Number.isInteger(record.controllerPid) || record.controllerPid <= 1
      || !Number.isInteger(record.shellPid) || record.shellPid <= 1
      || process.ppid !== record.shellPid) {
    throw new Error('hammer controller ownership unconfirmed');
  }
  if (readGroupImpl() !== record.shellPid) throw new Error('hammer controller process group unconfirmed');
  process.kill(record.controllerPid, 0);
  if (env.HAM_CONTROLLER_FD !== '4') throw new Error('hammer controller cancellation pipe missing');
  const pipe = fstatSync(4);
  if (!pipe.isFIFO() && !pipe.isSocket()) throw new Error('hammer controller cancellation pipe invalid');
  return record;
}

export function confirmControllerValidation() {
  // The controller probes from outside the test group. Do not accept a test
  // while background descendants remain, even if they closed both output pipes.
  return new Promise(resolve => {
    let pipe;
    try { pipe = new Socket({ fd: 4, readable: true, writable: true }); }
    catch { resolve(false); return; }
    let done = false, received = '';
    const finish = ok => { if (done) return; done = true; pipe.destroy(); resolve(ok); };
    // Allow one poll, bounded HQ read and bounded process census to complete.
    pipe.setTimeout(10_000, () => finish(false));
    pipe.on('error', () => finish(false));
    pipe.on('close', () => finish(false));
    pipe.on('data', chunk => {
      received += chunk;
      if (received.includes('\n')) finish(received === 'clear\n');
    });
    pipe.write(`complete:${process.pid}\n`);
  });
}

// No environment/command census: retain only identities in our owned group.
export function controllerGroupSnapshot(pgid, { execFileSyncImpl = execFileSync, platform = process.platform } = {}) {
  if (platform === 'darwin' && execFileSyncImpl === execFileSync) {
    return nativeControllerIdentity('group', pgid);
  }
  const output = execFileSyncImpl('/bin/ps', ['-axo', 'pid=,pgid=,stat=,lstart='], {
    encoding: 'utf8', timeout: 2000, maxBuffer: 1024 * 1024,
    env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
  });
  if (!output.trim()) throw new Error('empty process census');
  return output.split('\n').filter(line => line.trim()).flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!match || !Number.isFinite(Date.parse(match[4]))) throw new Error('malformed process census');
    if (Number(match[2]) !== pgid || match[3].startsWith('Z')) return [];
    return [{ pid: Number(match[1]), birth: match[4] }];
  });
}

// A group number alone is never a signal capability after leader exit. Keep
// witnessed member births, and refuse a group containing only new identities.
export function groupStillOwned(members, witnessed, leaderLive, pgid) {
  if (!Number.isInteger(pgid) || pgid <= 1) return false;
  const matched = members.some(member => witnessed.get(member.pid) === member.birth);
  if (!matched && !(witnessed.size === 0 && leaderLive && members.some(member => member.pid === pgid))) return false;
  for (const member of members) witnessed.set(member.pid, member.birth);
  return true;
}

export function releaseControllerLease({ env, shellPid, startedAt, drained,
  inspectImpl = inspectMergeLease, releaseImpl = releaseMergeLease } = {}) {
  if (!drained) return { released: false, reason: 'process-drain-unconfirmed' };
  let acquired;
  try { acquired = JSON.parse(readFileSync(join(env.HAM_RUN_DIR, 'merge-lease-acquire.json'), 'utf8')); }
  catch (error) {
    return { released: false, reason: error.code === 'ENOENT' ? 'no-acquisition-receipt' : 'acquisition-unreadable' };
  }
  // The acquire CLI writes only after obtaining the holder. Never infer an ID
  // from a PR number, a terminal launch, an expired deadline or another worker.
  if (acquired.acquired !== true || acquired.holder !== Number(env.HAM_PR_NUMBER)
      || acquired.holderPid !== shellPid || !acquired.leaseId
      || !(Date.parse(acquired.acquiredAt) >= Date.parse(startedAt))) {
    return { released: false, reason: 'acquisition-not-owned' };
  }
  const prefix = `${env.HAM_REPO}::`;
  if (!acquired.key?.startsWith(prefix)) return { released: false, reason: 'acquisition-not-owned' };
  const base = acquired.key.slice(prefix.length);
  const identity = { rootDir: env.HAM_ROOT_DIR, repo: env.HAM_REPO, base };
  const lease = inspectImpl(identity).holder;
  if (!lease) return { released: false, reason: 'already-released' };
  if (lease.leaseId !== acquired.leaseId || lease.holderPid !== shellPid
      || lease.holderHost !== hostname() || lease.holderPr !== acquired.holder
      || lease.holderHead !== acquired.holderHead || lease.acquiredAt !== acquired.acquiredAt) {
    return { released: false, reason: 'lease-not-owned' };
  }
  return releaseImpl({ ...identity, leaseId: lease.leaseId, holderPr: lease.holderPr,
    holderHead: lease.holderHead, acquiredAt: lease.acquiredAt, reason: 'controller-drained' });
}

export async function runHammerController(script, args = [], {
  env = process.env, pollMs = 1000, graceMs = 2000, drainMs = 1000,
  timeoutMs = 7_200_000,
  readLaunchImpl = readLaunchRequestStatusFromLedgerAsync,
  snapshotImpl = controllerGroupSnapshot,
  releaseImpl = releaseControllerLease,
  spawnImpl = spawn,
  signalGroupImpl = (pid, signal) => process.kill(pid, signal),
} = {}) {
  const launchRequestId = controllerLaunchId(env);
  if (env.HAM_CONTROLLER_RECORD) throw new Error('nested hammer controllers are refused');
  if (!env.HAM_RUN_DIR || !env.HAM_ROOT_DIR || !env.HAM_REPO || !/^[1-9]\d*$/.test(env.HAM_PR_NUMBER || '')) {
    throw new Error('source inputs.sh before starting the hammer controller');
  }
  const readLaunch = () => readLaunchImpl({ launchRequestId, env, rootDir: env.HAM_ROOT_DIR,
    hqRoot: env.HAM_HQ_ROOT, timeoutMs: 2000, signal: AbortSignal.timeout(2000) });
  function permitted(probe) {
    const meaning = launchRequestMeaning(probe?.row);
    return probe?.ok === true && probe.row?.launch_request_id === launchRequestId
      && meaning.status && !meaning.terminal && !meaning.parked;
  }
  if (!permitted(await readLaunch())) throw new Error('HQ launch is terminal, parked or unreadable; refusing controller start');
  const token = randomUUID();
  const recordPath = join(env.HAM_RUN_DIR, `controller-${token}.json`);
  const startedAt = new Date().toISOString();
  const childEnv = { ...env, HAM_CONTROLLER_PID: String(process.pid), HAM_CONTROLLER_TOKEN: token,
    HAM_CONTROLLER_RECORD: recordPath, HAM_CONTROLLER_FD: '4' };
  // Gate exec on durable registration; no lease or validator can run first.
  const child = spawnImpl('/bin/bash', ['-c',
    'trap \'HAM_CONTROLLER_CANCELLED=1; exit 143\' TERM; trap \'HAM_CONTROLLER_CANCELLED=1; exit 130\' INT; trap \'HAM_CONTROLLER_CANCELLED=1; exit 129\' HUP; IFS= read -r ready || exit 125; source "$@"',
    'hammer-controller', script, ...args], {
    env: childEnv, detached: true, stdio: ['pipe', 'inherit', 'inherit', 'ignore', 'pipe'],
  });
  let spawnError;
  child.on('error', error => {
    // ChildProcess also emits error for refused kill operations. Those do not
    // prove a failed spawn or an empty group.
    if (!child.pid) spawnError = error;
    else record.signalError = error.code || 'unknown';
  });
  let exited = false, status;
  child.on('exit', (code, signal) => { exited = true; status = code ?? (signal ? 128 + constants.signals[signal] : 127); });
  const record = { schemaVersion: 1, token, launchRequestId, controllerPid: process.pid,
    shellPid: child.pid, startedAt, state: 'running' };
  const persist = () => writeFileAtomic(recordPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  const witnessed = new Map();
  let reason, stopAt, termSent = false, killSent = false, drained = false;
  const stop = why => { if (!reason) { reason = why; stopAt = performance.now(); } };
  const handlers = ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGALRM'].map(signal => {
    const handler = () => stop(`signal:${signal}`);
    process.on(signal, handler);
    return [signal, handler];
  });
  // A validator shares the controller group. Its timeout requests cancellation
  // of the entire round, including grandchildren that close their stdio.
  let controlInput = '', pendingValidator;
  child.stdio[4].on('data', chunk => {
    controlInput += chunk;
    if (controlInput.length > 1024) { stop('invalid-validation-message'); return; }
    while (controlInput.includes('\n')) {
      const end = controlInput.indexOf('\n');
      const line = controlInput.slice(0, end); controlInput = controlInput.slice(end + 1);
      if (/^complete:[1-9]\d*$/.test(line)) pendingValidator = Number(line.slice(9));
      else stop('validation-stopped');
    }
  });
  child.stdio[4].on('error', () => stop('control-pipe-error'));
  const begun = performance.now();
  let nextRead = begun;
  try {
    writeFileAtomic(recordPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, overwrite: false });
    child.stdin.on('error', () => stop('bootstrap-failed'));
    // Check introspection before permitting any script/lease side effects.
    const initialMembers = snapshotImpl(child.pid);
    if (!initialMembers.some(member => member.pid === child.pid)) throw new Error('controller shell identity unavailable');
    for (const member of initialMembers) witnessed.set(member.pid, member.birth);
    child.stdin.end('ready\n');
    while (true) {
      const now = performance.now();
      if (spawnError) { stop('spawn-failed'); drained = true; break; }
      if (!reason && now >= nextRead) {
        try { if (!permitted(await readLaunch())) stop('launch-ended-or-unreadable'); }
        catch { stop('launch-unreadable'); }
        nextRead = performance.now() + pollMs;
      }
      if (now - begun >= timeoutMs) stop('controller-timeout');
      if (exited) stop('shell-exited');
      let members;
      try { members = snapshotImpl(child.pid); }
      catch (error) { record.probeError = error.code || 'unknown'; stop('process-probe-unreadable'); }
      if (members?.length === 0 && exited) { drained = true; break; }
      const owned = members && groupStillOwned(members, witnessed, !exited, child.pid);
      // A census can observe the shell's exit before Node delivers its exit
      // event. An empty group grants no signal authority; wait for that event
      // before deciding whether the completed script succeeded.
      if (members?.length && !owned) stop('process-identity-unconfirmed');
      if (pendingValidator) {
        const clear = !reason && owned && members.some(member => member.pid === pendingValidator)
          && members.every(member => member.pid === child.pid || member.pid === pendingValidator);
        if (!clear) stop('validation-descendants-or-probe-unconfirmed');
        child.stdio[4].write(clear ? 'clear\n' : 'blocked\n');
        pendingValidator = undefined;
      }
      if (reason) {
        if (record.state !== 'stopping') { record.state = 'stopping'; persist(); }
        if (owned) {
          const signal = performance.now() - stopAt < graceMs ? 'SIGTERM' : 'SIGKILL';
          if ((signal === 'SIGTERM' && !termSent) || (signal === 'SIGKILL' && !killSent)) {
            try {
              signalGroupImpl(-child.pid, signal);
              if (signal === 'SIGTERM') termSent = true; else killSent = true;
            } catch (error) { if (error.code !== 'ESRCH') record.signalError = error.code; }
          }
        }
        if ((!members || (owned && record.signalError)) && !exited) {
          // An unreadable census cannot authorize a group signal. Stop only
          // our still-live direct child; retain unknown descendant/lease state.
          const signal = performance.now() - stopAt < graceMs ? 'SIGTERM' : 'SIGKILL';
          const key = signal === 'SIGTERM' ? 'directTermSent' : 'directKillSent';
          if (!record[key]) record[key] = child.kill(signal);
        }
        if (performance.now() - stopAt >= graceMs + drainMs) break;
      }
      await delay(reason ? Math.min(pollMs, 100) : pollMs);
    }
    record.state = drained ? 'quiescent' : 'cleanup-unconfirmed';
    record.reason = reason;
    record.finishedAt = new Date().toISOString();
    record.termSent = termSent;
    record.killSent = killSent;
    record.drained = drained;
    try { record.leaseCleanup = releaseImpl({ env, shellPid: child.pid, startedAt, drained }); }
    catch { record.leaseCleanup = { released: false, reason: 'lease-cleanup-failed' }; }
    persist();
    if (record.leaseCleanup.reason === 'lease-cleanup-failed' || record.leaseCleanup.reason === 'mutation-lock-busy') return 125;
    return drained && reason === 'shell-exited' ? status : drained ? 143 : 125;
  } catch (error) {
    // Bootstrap has not released stdin if initial registration/probing failed.
    // A live direct-child handle is safe even when process inspection is denied.
    if (!exited) child.kill('SIGTERM');
    child.stdin.destroy();
    record.state = 'cleanup-unconfirmed';
    record.reason = 'controller-error';
    record.errorCode = error.code || 'unknown';
    record.drained = false;
    try { persist(); } catch { /* Keep the original registration if disk failed. */ }
    return 125;
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
    child.stdio[4].destroy();
    // On unknown drain retain the private receipt and canonical HQ markers.
    // Never trade an uncertain process for an unfenced lease deletion.
    child.unref();
  }
}
