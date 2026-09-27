import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_DELETER_LOCK_AGE_MS = 6 * 60 * 60 * 1000;

// The trash is a sibling of the workspace root so rename stays on one volume.
export function workspaceTrashDir(workspaceRootDir) {
  const physicalRoot = existsSync(workspaceRootDir) ? realpathSync(workspaceRootDir) : workspaceRootDir;
  return join(dirname(physicalRoot), `${basename(physicalRoot)}.trash`);
}

export function launchWorkspaceTrashDeleter({ trashDir, rootDir, workspaceRootDir, spawnImpl = spawn, probeImpl = spawnSync, logger = console } = {}) {
  if (!existsSync(trashDir)) return false;
  const lockPath = `${trashDir}.delete.lock`;
  let fd;
  try {
    fd = openSync(lockPath, 'wx');
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    let pid = 0;
    try { pid = Number(readFileSync(lockPath, 'utf8')); } catch { /* retry below */ }
    let ageMs = Infinity;
    try { ageMs = Math.max(0, Date.now() - statSync(lockPath).mtimeMs); } catch { /* retry below */ }
    if (pid > 0) {
      try {
        process.kill(pid, 0);
        if (ageMs < MAX_DELETER_LOCK_AGE_MS) {
          logger?.warn?.(`[follow-up-workspace-trash] deleter-lock-held pid=${pid} ageMs=${Math.round(ageMs)}`);
          return false;
        }
        // A genuinely long-running deleter keeps its lock. Age alone only
        // breaks a lock whose PID now belongs to something else or is unknown.
        const owner = probeImpl('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 5_000 });
        if (owner.status === 0 && String(owner.stdout || '').includes('follow-up-workspace-trash-delete.mjs')
          && String(owner.stdout || '').includes(trashDir)) {
          logger?.warn?.(`[follow-up-workspace-trash] long-running deleter-lock-held pid=${pid} ageMs=${Math.round(ageMs)}`);
          return false;
        }
      } catch (probeErr) {
        if (probeErr.code !== 'ESRCH' && ageMs < MAX_DELETER_LOCK_AGE_MS) {
          logger?.warn?.(`[follow-up-workspace-trash] deleter-lock-unverifiable pid=${pid} ageMs=${Math.round(ageMs)}`);
          return false;
        }
      }
    } else {
      // Give a launcher time to write its child PID before treating the lock as stale.
      if (ageMs < 60_000) return false;
    }
    logger?.warn?.(`[follow-up-workspace-trash] removing stale deleter lock pid=${pid || 'unknown'} ageMs=${Math.round(ageMs)}`);
    try { unlinkSync(lockPath); } catch { return false; }
    return launchWorkspaceTrashDeleter({ trashDir, rootDir, workspaceRootDir, spawnImpl, probeImpl, logger });
  }
  try {
    const script = fileURLToPath(new URL('./follow-up-workspace-trash-delete.mjs', import.meta.url));
    const args = [process.execPath, script, trashDir, lockPath, rootDir || '', workspaceRootDir || ''];
    const taskpolicy = process.platform === 'darwin'
      && probeImpl('taskpolicy', ['-h'], { stdio: 'ignore' }).error?.code !== 'ENOENT';
    const command = taskpolicy ? 'taskpolicy' : 'nice';
    const child = spawnImpl(command, taskpolicy ? ['-b', ...args] : ['-n', '10', ...args], {
      detached: true, stdio: 'ignore',
    });
    child.once('error', (err) => {
      logger?.warn?.(`[follow-up-workspace-trash] deleter-spawn-failed: ${err?.message || err}`);
      try {
        if (Number(readFileSync(lockPath, 'utf8')) === child.pid) unlinkSync(lockPath);
      } catch { /* a later sweep can retry */ }
    });
    if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
      try { unlinkSync(lockPath); } catch { /* a later sweep can retry */ }
      return false;
    }
    writeFileSync(fd, String(child.pid));
    child.unref();
    return true;
  } catch (err) {
    try { unlinkSync(lockPath); } catch { /* preserve original error */ }
    throw err;
  } finally {
    closeSync(fd);
  }
}

export function ensureWorkspaceTrashDir(workspaceRootDir) {
  const trashDir = workspaceTrashDir(workspaceRootDir);
  mkdirSync(trashDir, { recursive: true });
  return trashDir;
}
