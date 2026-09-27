import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchWorkspaceTrashDeleter, workspaceTrashDir } from '../src/follow-up-workspace-trash.mjs';

test('workspace trash launches one detached low-priority deleter while its PID lock is held', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'follow-up-trash-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspaceRoot = join(root, 'workspaces');
  mkdirSync(workspaceRoot);
  const trashDir = workspaceTrashDir(workspaceRoot);
  mkdirSync(trashDir);
  const calls = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    return Object.assign(new EventEmitter(), { pid: process.pid, unref() {} });
  };
  assert.equal(launchWorkspaceTrashDeleter({ trashDir, spawnImpl, probeImpl: () => ({ status: 0 }) }), true);
  assert.equal(launchWorkspaceTrashDeleter({ trashDir, spawnImpl }), false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, process.platform === 'darwin' ? 'taskpolicy' : 'nice');
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.stdio, 'ignore');
  assert.equal(Number(readFileSync(`${trashDir}.delete.lock`, 'utf8')), process.pid);
});

test('workspace trash resolves a symlinked workspace root to its physical volume', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'follow-up-trash-symlink-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const physicalRoot = join(root, 'volume', 'workspaces');
  mkdirSync(physicalRoot, { recursive: true });
  const link = join(root, 'workspaces-link');
  symlinkSync(physicalRoot, link);
  assert.equal(workspaceTrashDir(link), join(realpathSync(join(root, 'volume')), 'workspaces.trash'));
});

test('aged PID lock is retried even when its PID has been reused by a live process', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'follow-up-trash-stale-lock-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const trashDir = workspaceTrashDir(join(root, 'workspaces'));
  mkdirSync(trashDir);
  const lockPath = `${trashDir}.delete.lock`;
  writeFileSync(lockPath, String(process.pid));
  const old = new Date(Date.now() - 7 * 60 * 60 * 1000);
  utimesSync(lockPath, old, old);
  const warnings = [];
  const child = Object.assign(new EventEmitter(), { pid: process.pid, unref() {} });
  assert.equal(launchWorkspaceTrashDeleter({
    trashDir, spawnImpl: () => child, probeImpl: () => ({ status: 0 }),
    logger: { warn: (message) => warnings.push(message) },
  }), true);
  assert.match(warnings.join('\n'), /removing stale deleter lock/);
  assert.equal(Number(readFileSync(lockPath, 'utf8')), process.pid);
});

test('aged PID lock stays held for a verified deleter or an inconclusive process probe', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'follow-up-trash-live-lock-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const trashDir = workspaceTrashDir(join(root, 'workspaces'));
  mkdirSync(trashDir);
  const lockPath = `${trashDir}.delete.lock`;
  writeFileSync(lockPath, String(process.pid));
  const old = new Date(Date.now() - 7 * 60 * 60 * 1000);
  utimesSync(lockPath, old, old);
  let spawned = false;
  const spawnImpl = () => { spawned = true; throw new Error('unexpected spawn'); };
  const probes = [];
  assert.equal(launchWorkspaceTrashDeleter({
    trashDir, spawnImpl,
    probeImpl: (command, args) => {
      probes.push({ command, args });
      return { status: 0, stdout: `node follow-up-workspace-trash-delete.mjs ${trashDir}` };
    },
  }), false);
  assert.deepEqual(probes[0], { command: 'ps', args: ['-ww', '-p', String(process.pid), '-o', 'command='] });
  assert.equal(launchWorkspaceTrashDeleter({
    trashDir, spawnImpl, probeImpl: () => ({ status: null, error: new Error('timeout') }),
  }), false);
  assert.equal(spawned, false);
  assert.equal(readFileSync(lockPath, 'utf8'), String(process.pid));
});

test('workspace trash spawn error is handled and releases its PID lock', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'follow-up-trash-spawn-error-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const trashDir = workspaceTrashDir(join(root, 'workspaces'));
  mkdirSync(trashDir);
  const child = Object.assign(new EventEmitter(), { pid: process.pid, unref() {} });
  const warnings = [];
  assert.equal(launchWorkspaceTrashDeleter({
    trashDir,
    spawnImpl: () => child,
    probeImpl: () => ({ status: 0 }),
    logger: { warn: (message) => warnings.push(message) },
  }), true);
  child.emit('error', Object.assign(new Error('spawn EAGAIN'), { code: 'EAGAIN' }));
  assert.equal(existsSync(`${trashDir}.delete.lock`), false);
  assert.match(warnings[0], /spawn EAGAIN/);
});

test('workspace trash rejects a spawn without a PID', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'follow-up-trash-no-pid-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const trashDir = workspaceTrashDir(join(root, 'workspaces'));
  mkdirSync(trashDir);
  const child = Object.assign(new EventEmitter(), { unref() {} });
  assert.equal(launchWorkspaceTrashDeleter({ trashDir, spawnImpl: () => child }), false);
  assert.equal(existsSync(`${trashDir}.delete.lock`), false);
  assert.doesNotThrow(() => child.emit('error', new Error('spawn ENOENT')));
});

test('workspace trash child deletes only entries placed in the trash directory', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'follow-up-trash-delete-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const trashDir = workspaceTrashDir(join(root, 'workspaces'));
  const discarded = join(trashDir, 'discarded');
  mkdirSync(discarded, { recursive: true });
  writeFileSync(join(discarded, 'artifact'), 'content');
  const script = new URL('../src/follow-up-workspace-trash-delete.mjs', import.meta.url);
  execFileSync(process.execPath, [script.pathname, trashDir, `${trashDir}.delete.lock`]);
  assert.equal(existsSync(discarded), false);
});

test('workspace trash child skips a failed delete and retries it on a later launch', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'follow-up-trash-retry-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const trashDir = workspaceTrashDir(join(root, 'workspaces'));
  const blocked = join(trashDir, 'a-blocked');
  const healthy = join(trashDir, 'z-healthy');
  mkdirSync(blocked, { recursive: true });
  mkdirSync(healthy);
  const preload = join(root, 'fail-one-delete.cjs');
  writeFileSync(preload, [
    "const fs = require('node:fs');",
    "const { syncBuiltinESMExports } = require('node:module');",
    "const { basename } = require('node:path');",
    'const realRmSync = fs.rmSync;',
    'const realReaddirSync = fs.readdirSync;',
    'fs.readdirSync = (target, options) => realReaddirSync(target, options).sort();',
    'fs.rmSync = (target, options) => {',
    "  if (basename(target) === 'a-blocked') {",
    "    const error = new Error('permission denied');",
    "    error.code = 'EACCES';",
    '    throw error;',
    '  }',
    '  return realRmSync(target, options);',
    '};',
    'syncBuiltinESMExports();',
  ].join('\n'));
  const script = new URL('../src/follow-up-workspace-trash-delete.mjs', import.meta.url);
  const lockPath = `${trashDir}.delete.lock`;
  const workspaceRoot = join(root, 'workspaces');
  execFileSync(process.execPath, ['--require', preload, script.pathname, trashDir, lockPath, root, workspaceRoot]);
  assert.equal(existsSync(blocked), true);
  assert.equal(existsSync(healthy), false);
  const anomalyDir = join(root, 'data', 'archive-anomalies');
  const anomalies = readdirSync(anomalyDir);
  assert.equal(anomalies.length, 1);
  const anomaly = JSON.parse(readFileSync(join(anomalyDir, anomalies[0]), 'utf8'));
  assert.equal(anomaly.type, 'terminal-workspace-reap-permission-denied');
  assert.equal(anomaly.error.code, 'EACCES');
  assert.equal(anomaly.trashPath, blocked);
  assert.equal(anomaly.action, 'left-workspace-in-trash');
  assert.equal(anomaly.workspacePath, join(workspaceRoot, 'a-blocked'));

  execFileSync(process.execPath, [script.pathname, trashDir, lockPath]);
  assert.equal(existsSync(blocked), false);
});
