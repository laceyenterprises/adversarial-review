import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    return { pid: process.pid, unref() {} };
  };
  assert.equal(launchWorkspaceTrashDeleter({ trashDir, spawnImpl, probeImpl: () => ({ status: 0 }) }), true);
  assert.equal(launchWorkspaceTrashDeleter({ trashDir, spawnImpl }), false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, process.platform === 'darwin' ? 'taskpolicy' : 'nice');
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.stdio, 'ignore');
  assert.equal(Number(readFileSync(`${trashDir}.delete.lock`, 'utf8')), process.pid);
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
