import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('./controller_process_census.py', import.meta.url));

export function nativeControllerIdentity(verb, pid, { execFileSyncImpl = execFileSync, env = process.env } = {}) {
  if (!Number.isInteger(pid) || pid <= 1) throw new Error('invalid controller census identity');
  const output = execFileSyncImpl(env.HQ_PYTHON3 || env.AGENT_OS_PY || 'python3', ['-I', '-B', helper, verb, String(pid)], {
    encoding: 'utf8', timeout: 2000, maxBuffer: 1024 * 1024, env,
  });
  const result = JSON.parse(output);
  if (verb === 'pgid' && Number.isInteger(result) && result > 1) return result;
  if (verb === 'group' && Array.isArray(result)) {
    const seen = new Set();
    for (const member of result) {
      if (!Number.isInteger(member.pid) || member.pid <= 1 || seen.has(member.pid)
          || !/^[1-9]\d*\.\d{6}$/.test(member.birth)) throw new Error('malformed native controller census');
      seen.add(member.pid);
    }
    return result;
  }
  throw new Error('malformed native controller census');
}
