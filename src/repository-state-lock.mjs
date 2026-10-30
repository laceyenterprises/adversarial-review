import { AsyncLocalStorage } from 'node:async_hooks';
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { join, resolve } from 'node:path';
import fsExt from 'fs-ext';
import { refreshRepositoryObservationCaches } from './repository-state-cache.mjs';

const cycles = new AsyncLocalStorage();

export function repositoryStateBusy(message) {
  return Object.assign(new Error(message), { code: 'REPOSITORY_STATE_BUSY' });
}

export function repositoryRenamePendingPath(rootDir) {
  return join(rootDir, 'data', 'repository-renames', 'pending.json');
}

function acquire(rootDir, mode) {
  mkdirSync(join(rootDir, 'data'), { recursive: true });
  const fd = openSync(join(rootDir, 'data', '.repository-state.lock'), 'a', 0o600);
  try {
    fsExt.flockSync(fd, mode);
    return fd;
  } catch (error) {
    closeSync(fd);
    if (!['EAGAIN', 'EWOULDBLOCK'].includes(error.code)) throw error;
    throw repositoryStateBusy('Repository state is in use; retry on the next cycle');
  }
}

// A cycle owns its reads as well as its writes: a migration cannot move a file
// between a reader's snapshot and its subsequent compare-and-swap.
export function acquireRepositoryStateOwner(rootDir) {
  if (!rootDir) return () => {};
  const root = resolve(rootDir), fd = acquire(root, 'shnb');
  try {
    if (existsSync(repositoryRenamePendingPath(root)) || existsSync(repositoryObservationPath(root))) {
      throw repositoryStateBusy('Repository rename recovery must finish before the next cycle');
    }
    refreshRepositoryObservationCaches(root);
  } catch (error) { closeSync(fd); throw error; }
  let active = true;
  return () => { if (active) { active = false; closeSync(fd); } };
}

export async function withRepositoryStateCycle(rootDir, run) {
  if (!rootDir) return run();
  const root = resolve(rootDir);
  // Each async owner needs its own descriptor. Detached settlement may outlive
  // the poll that started it; borrowing that poll's lock would release early.
  const release = acquireRepositoryStateOwner(root);
  const scope = { root, active: true };
  try {
    return await cycles.run(scope, run);
  } finally {
    scope.active = false;
    release();
  }
}

export function repositoryObservationPath(rootDir) {
  return join(rootDir, 'data', 'repository-renames', 'observation.json');
}

export function inRepositoryStateCycle(rootDir) {
  const scope = cycles.getStore();
  return scope?.active && scope.mode !== 'exclusive' && scope.root === resolve(rootDir);
}

export function withRepositoryStateRead(rootDir, run) {
  if (!rootDir) return run();
  const root = resolve(rootDir), scope = cycles.getStore();
  if (scope?.active && scope.root === root) return run();
  const fd = acquire(root, 'shnb'), current = { root, active: true };
  try {
    if (existsSync(repositoryRenamePendingPath(root)) || existsSync(repositoryObservationPath(root))) {
      throw repositoryStateBusy('Repository rename recovery must finish before a state mutation');
    }
    refreshRepositoryObservationCaches(root);
    return cycles.run(current, run);
  } finally { current.active = false; closeSync(fd); }
}

export function withRepositoryStateMigration(rootDir, run) {
  const parent = cycles.getStore();
  if (parent?.active && parent.mode === 'exclusive' && parent.root === resolve(rootDir)) return run();
  if (inRepositoryStateCycle(rootDir)) {
    throw repositoryStateBusy('Repository identity changed during a cycle; retry discovery');
  }
  const fd = acquire(rootDir, 'exnb');
  const scope = { root: resolve(rootDir), active: true, mode: 'exclusive' };
  try { return cycles.run(scope, run); } finally { scope.active = false; closeSync(fd); }
}
