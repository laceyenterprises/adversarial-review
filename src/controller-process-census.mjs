import { execFileSync, spawn } from 'node:child_process';
import { loadAwareTimeoutMs } from './load-aware-timeout.mjs';
import { fileURLToPath } from 'node:url';

const helperPath = fileURLToPath(new URL('./controller_process_census.py', import.meta.url));
const NO_OPERATOR_CHANGE = 'it executes no setuid binary and needs no operator process-introspection change';

// Name the failed mechanism so a refusal is not mistaken for a host permission
// gap. Only bounded errno and exhaustion metadata may leave the helper.
function censusUnavailable(verb, interpreter, cause, code = cause?.code, metadata) {
  const mechanism = verb === 'pgid' ? 'getpgid' : 'kern.proc.pgrp sysctl';
  const detail = code || (Number.isInteger(cause?.status) ? `exit ${cause.status}` : 'unreadable');
  return Object.assign(new Error(`controller process census unavailable: ${mechanism} census helper `
    + `controller_process_census.py via ${interpreter} failed (${detail}); ${NO_OPERATOR_CHANGE}`
    + (metadata ? `; retryable census read exhausted (${metadata.attempts} attempts, ${metadata.elapsedMs ?? 'unknown'} ms, last errno ${code})` : '')),
    { code, retryable: Boolean(metadata), ...(metadata ? { censusAttempts: metadata.attempts, censusElapsedMs: metadata.elapsedMs } : {}) });
}

function retryMetadata(code, reply) {
  return ['EIO', 'EINTR'].includes(code) && reply?.retryable === true
    && Number.isSafeInteger(reply.attempts) && reply.attempts > 0 && reply.attempts <= 1_000_000
    && (reply.elapsedMs === undefined || (Number.isSafeInteger(reply.elapsedMs) && reply.elapsedMs >= 0 && reply.elapsedMs <= 60_000))
    ? { attempts: reply.attempts, elapsedMs: reply.elapsedMs } : undefined;
}

function requestBudget(timeoutImpl, timeoutMs) {
  return Math.max(1, Math.min(40_000, timeoutMs ?? timeoutImpl(2000)));
}

export function nativeControllerIdentity(verb, pid, { execFileSyncImpl = execFileSync, env = process.env, timeoutImpl = loadAwareTimeoutMs } = {}) {
  if (!Number.isInteger(pid) || pid <= 1) throw new Error('invalid controller census identity');
  const interpreter = env.HQ_PYTHON3 || env.AGENT_OS_PY || 'python3';
  if (verb !== 'pgid' && verb !== 'group') throw censusUnavailable(verb, interpreter, null, 'EINVAL');
  let result;
  const budget = requestBudget(timeoutImpl);
  try {
    const output = execFileSyncImpl(interpreter, ['-I', '-B', helperPath, verb, String(pid)], {
      encoding: 'utf8', timeout: budget + 1000, maxBuffer: 1024 * 1024, env: { ...env, HAM_CENSUS_RETRY_BUDGET_MS: String(budget) }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    result = JSON.parse(output);
  } catch (error) {
    // Only explicit syscall exhaustion carries retry metadata.
    const reported = String(error?.stderr || '').match(/^controller census: ([A-Z][A-Z0-9]{1,15})(?: retry-exhausted=([1-9]\d{0,6})(?: elapsed-ms=(\d{1,5}))?)?$/m);
    throw censusUnavailable(verb, interpreter, error,
      error?.code || reported?.[1] || (error instanceof SyntaxError ? 'EMALFORMED' : undefined),
      !error?.code ? retryMetadata(reported?.[1], { retryable: Boolean(reported?.[2]), attempts: Number(reported?.[2]),
        elapsedMs: reported?.[3] === undefined ? undefined : Number(reported[3]) }) : undefined);
  }
  return validatedIdentity(verb, interpreter, result);
}

function validatedIdentity(verb, interpreter, result) {
  if (verb === 'pgid' && Number.isInteger(result) && result > 1) return result;
  if (verb === 'group' && Array.isArray(result)) {
    const seen = new Set();
    for (const member of result) {
      if (!Number.isInteger(member?.pid) || member.pid <= 1 || seen.has(member.pid)
          || !/^[1-9]\d*\.\d{6}$/.test(member.birth)) throw censusUnavailable(verb, interpreter, null, 'EMALFORMED');
      seen.add(member.pid);
    }
    return result;
  }
  throw censusUnavailable(verb, interpreter, null, 'EMALFORMED');
}

// One helper serves a controller's whole round, so a tick spawns nothing. Each
// request is a fresh kernel read: no answer outlives its request. Any timeout,
// exit, refusal or malformed reply rejects, and the next request starts a new
// helper. Requests never overlap; the controller awaits each census.
export function createControllerCensus({ spawnImpl = spawn, env = process.env, timeoutMs, timeoutImpl = loadAwareTimeoutMs } = {}) {
  const interpreter = env.HQ_PYTHON3 || env.AGENT_OS_PY || 'python3';
  let helper, pending;
  let helperBudget;
  const retire = () => {
    if (!helper) return;
    const retired = helper; helper = undefined;
    retired.stdin?.destroy(); retired.stdout?.destroy();
    if (retired.exitCode === null && retired.signalCode === null) retired.kill('SIGKILL');
    retired.unref?.();
  };
  const settle = (value, error) => {
    if (!pending) return;
    const { resolve, reject, timer } = pending; pending = undefined;
    clearTimeout(timer);
    if (error) { retire(); reject(error); } else resolve(value);
  };
  const fail = (code, cause, metadata) => settle(undefined, censusUnavailable(pending?.verb, interpreter, cause, code, metadata));
  const start = () => {
    const child = spawnImpl(interpreter, ['-I', '-B', helperPath, 'serve'], { env: { ...env, HAM_CENSUS_RETRY_BUDGET_MS: String(helperBudget) }, stdio: ['pipe', 'pipe', 'ignore'] });
    // Only a pending request's timer keeps the event loop alive.
    child.unref?.(); child.stdin.unref?.(); child.stdout.unref?.();
    let received = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (child !== helper) return;
      // An answer nobody asked for is not a census; never let it reach a later request.
      if (!pending) { retire(); return; }
      received += chunk;
      if (received.length > 1024 * 1024) { fail('EMALFORMED'); return; }
      const end = received.indexOf('\n');
      if (end < 0) return;
      const line = received.slice(0, end); received = received.slice(end + 1);
      let reply;
      try { reply = JSON.parse(line); } catch { reply = null; }
      // Legacy errno-only replies remain definitive unavailable evidence.
      if (/^[A-Z][A-Z0-9]{1,15}$/.test(reply?.error)) {
        fail(reply.error, undefined, retryMetadata(reply.error, reply));
        return;
      }
      if (!reply || !('ok' in reply) || received !== '') { fail('EMALFORMED'); return; }
      let result;
      try { result = validatedIdentity(pending.verb, interpreter, reply.ok); }
      catch (error) { settle(undefined, error); return; }
      settle(result);
    });
    // A helper that dies between requests is retired too, so the next request
    // starts a fresh one instead of writing to a dead pipe until its timeout.
    child.on('error', error => { if (child === helper) { fail(undefined, error); retire(); } });
    child.on('exit', code => { if (child === helper) { fail(undefined, { status: code }); retire(); } });
    child.stdin.on('error', () => { /* the exit or spawn error names the failure */ });
    return child;
  };
  function request(verb, pid) {
    if (!Number.isInteger(pid) || pid <= 1) return Promise.reject(new Error('invalid controller census identity'));
    if (pending) return Promise.reject(censusUnavailable(verb, interpreter, null, 'EBUSY'));
    return new Promise((resolve, reject) => {
      // The persistent helper uses one frozen budget; transport gets separate
      // unscaled startup/serialization slack so it cannot race kernel exhaustion.
      if (!helper) helperBudget = requestBudget(timeoutImpl, timeoutMs);
      pending = { resolve, reject, verb, timer: setTimeout(() => fail('ETIMEDOUT'), helperBudget + 1000) };
      try {
        helper ??= start();
        helper.stdin.write(`${verb} ${pid}\n`);
      } catch (error) { fail(undefined, error); }
    });
  }
  return {
    group: pid => request('group', pid),
    pgid: pid => request('pgid', pid),
    close() { fail('ECANCELED'); retire(); },
  };
}
