import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// `ps -o lstart` is only second-resolution; allow a small window when
// comparing it to the persisted ISO timestamp.
const PGID_IDENTITY_TOLERANCE_MS = 5_000;

function isPgidAlive(pgid, processKillImpl = process.kill) {
  if (!Number.isInteger(pgid) || pgid <= 0) return false;
  try {
    processKillImpl(-pgid, 0);
    return true;
  } catch (err) {
    if (err?.code === 'ESRCH') return false;
    if (err?.code === 'EPERM') return true;
    throw err;
  }
}

async function verifyPgidIdentity(pgid, expectedSpawnedAt, {
  execFileImpl = execFileAsync,
} = {}) {
  if (!Number.isInteger(pgid) || pgid <= 0) {
    return { match: false, reason: 'invalid pgid' };
  }
  if (!expectedSpawnedAt) {
    return { match: false, reason: 'record has no spawnedAt to compare' };
  }
  let lstart = '';
  try {
    const { stdout } = await execFileImpl('ps', ['-o', 'lstart=', '-p', String(pgid)], { timeout: 5_000 });
    lstart = String(stdout || '').trim();
  } catch (err) {
    return { match: false, reason: `ps probe failed: ${err?.message || err}` };
  }
  if (!lstart) {
    return { match: false, reason: 'ps returned no start time (pgid may have just exited)' };
  }
  const actualMs = Date.parse(lstart);
  const expectedMs = Date.parse(expectedSpawnedAt);
  if (!Number.isFinite(actualMs) || !Number.isFinite(expectedMs)) {
    return { match: false, reason: `unparseable timestamps actual=${lstart} expected=${expectedSpawnedAt}` };
  }
  const drift = Math.abs(actualMs - expectedMs);
  if (drift <= PGID_IDENTITY_TOLERANCE_MS) {
    return { match: true, startedAt: lstart };
  }
  return { match: false, startedAt: lstart, reason: `start-time drift ${drift}ms exceeds tolerance ${PGID_IDENTITY_TOLERANCE_MS}ms` };
}

export {
  isPgidAlive,
  verifyPgidIdentity,
};
