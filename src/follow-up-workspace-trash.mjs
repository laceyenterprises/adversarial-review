import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The trash is a sibling of the workspace root so rename stays on one volume.
export function workspaceTrashDir(workspaceRootDir) {
  return join(dirname(workspaceRootDir), `${basename(workspaceRootDir)}.trash`);
}

export function launchWorkspaceTrashDeleter({ trashDir, spawnImpl = spawn, probeImpl = spawnSync, logger = console } = {}) {
  if (!existsSync(trashDir)) return false;
  const lockPath = `${trashDir}.delete.lock`;
  let fd;
  try {
    fd = openSync(lockPath, 'wx');
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    let pid = 0;
    try { pid = Number(readFileSync(lockPath, 'utf8')); } catch { /* retry below */ }
    if (pid > 0) {
      try { process.kill(pid, 0); return false; } catch (probeErr) {
        if (probeErr.code !== 'ESRCH') return false;
      }
    } else {
      // Give a launcher time to write its child PID before treating the lock as stale.
      try { if (Date.now() - statSync(lockPath).mtimeMs < 60_000) return false; } catch { return false; }
    }
    try { unlinkSync(lockPath); } catch { return false; }
    return launchWorkspaceTrashDeleter({ trashDir, spawnImpl, probeImpl, logger });
  }
  try {
    const script = fileURLToPath(new URL('./follow-up-workspace-trash-delete.mjs', import.meta.url));
    const args = [process.execPath, script, trashDir, lockPath];
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
