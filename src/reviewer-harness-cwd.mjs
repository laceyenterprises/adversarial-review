import { chmodSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

const ownedCwds = new Map();

export function isOwnedReviewerCwd(cwd) {
  return ownedCwds.has(cwd);
}

export function pidInUse(pid) {
  try { process.kill(Number(pid), 0); return true; }
  catch (err) { return err.code !== 'ESRCH'; }
}

function removeEmptyWorkspace(path) {
  const entries = readdirSync(path);
  // Positive and unknown liveness both hold the workspace. An interrupted
  // spawn may leave a pending marker before its detached group is known.
  for (const entry of entries) {
    if (entry === 'cwd') continue;
    const group = /^group-([1-9][0-9]*)$/.exec(entry);
    if (!group || pidInUse(-Number(group[1]))) return;
  }
  for (const entry of entries) {
    const child = join(path, entry);
    if (entry === 'cwd') rmdirSync(child);
    else unlinkSync(child);
  }
  rmdirSync(path);
}

export function collectEmptyReviewerCwds(root, log = console) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const run = /^run-([1-9][0-9]*)-[a-zA-Z0-9]{6}$/.exec(entry.name);
    if (!run || !entry.isDirectory() || pidInUse(run[1])) continue;
    try { removeEmptyWorkspace(join(root, entry.name)); }
    catch (err) {
      if (!['ENOENT', 'ENOTEMPTY'].includes(err.code)) log.warn(`[reviewer] empty workspace cleanup failed: ${err.code || 'unknown'}`);
    }
  }
}

export function createEmptyReviewerCwd(root, { log = console, pinGroup, sharedTraversal = false } = {}) {
  collectEmptyReviewerCwds(root, log);
  const path = mkdtempSync(join(root, `run-${process.pid}-`));
  if (sharedTraversal) chmodSync(path, 0o711);
  const cwd = join(path, 'cwd');
  const cwdMode = sharedTraversal ? 0o555 : 0o500;
  mkdirSync(cwd, { mode: cwdMode });
  chmodSync(cwd, cwdMode);
  ownedCwds.set(cwd, { path, pinGroup });
  const release = () => {
    ownedCwds.delete(cwd);
    process.removeListener('exit', release);
    try { removeEmptyWorkspace(path); }
    catch (err) {
      if (!['ENOENT', 'ENOTEMPTY'].includes(err.code)) log.warn(`[reviewer] empty workspace cleanup failed: ${err.code || 'unknown'}`);
    }
  };
  process.once('exit', release);
  return { cwd, release };
}

export async function withReviewerCwdProcess(cwd, spawnOperation) {
  const owned = ownedCwds.get(cwd);
  if (!owned) return spawnOperation(null);
  const pending = join(owned.path, `pending-${randomUUID()}`);
  writeFileSync(pending, '', { mode: 0o600, flag: 'wx' });
  let spawnObserved = false;
  try {
    return await spawnOperation(({ pgid }) => {
      spawnObserved = true;
      owned.pinGroup?.(pgid);
      renameSync(pending, join(owned.path, `group-${pgid}`));
    });
  } finally {
    if (!spawnObserved) unlinkSync(pending);
  }
}
