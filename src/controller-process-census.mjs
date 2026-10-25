import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('./controller_process_census.py', import.meta.url));
const NO_OPERATOR_CHANGE = 'it executes no setuid binary and needs no operator process-introspection change';

// Name the failed mechanism so a refusal is not mistaken for a host permission
// gap. Keep the code bounded; never echo helper output beyond its errno token.
function censusUnavailable(verb, interpreter, cause, code = cause?.code) {
  const mechanism = verb === 'pgid' ? 'getpgid' : 'kern.proc.pgrp sysctl';
  const detail = code || (Number.isInteger(cause?.status) ? `exit ${cause.status}` : 'unreadable');
  return Object.assign(new Error(`controller process census unavailable: ${mechanism} census helper `
    + `controller_process_census.py via ${interpreter} failed (${detail}); ${NO_OPERATOR_CHANGE}`), { code });
}

export function nativeControllerIdentity(verb, pid, { execFileSyncImpl = execFileSync, env = process.env } = {}) {
  if (!Number.isInteger(pid) || pid <= 1) throw new Error('invalid controller census identity');
  const interpreter = env.HQ_PYTHON3 || env.AGENT_OS_PY || 'python3';
  let result;
  try {
    const output = execFileSyncImpl(interpreter, ['-I', '-B', helper, verb, String(pid)], {
      encoding: 'utf8', timeout: 2000, maxBuffer: 1024 * 1024, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    result = JSON.parse(output);
  } catch (error) {
    // The helper reports an OS refusal as its errno name only.
    const reported = String(error?.stderr || '').match(/^controller census: ([A-Z][A-Z0-9]{1,15})$/m)?.[1];
    throw censusUnavailable(verb, interpreter, error,
      error?.code || reported || (error instanceof SyntaxError ? 'EMALFORMED' : undefined));
  }
  if (verb === 'pgid' && Number.isInteger(result) && result > 1) return result;
  if (verb === 'group' && Array.isArray(result)) {
    const seen = new Set();
    for (const member of result) {
      if (!Number.isInteger(member.pid) || member.pid <= 1 || seen.has(member.pid)
          || !/^[1-9]\d*\.\d{6}$/.test(member.birth)) throw censusUnavailable(verb, interpreter, null, 'EMALFORMED');
      seen.add(member.pid);
    }
    return result;
  }
  throw censusUnavailable(verb, interpreter, null, 'EMALFORMED');
}
