import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { watcherWakePath } from '../src/watcher-wake.mjs';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const CLI_PATH = join(REPO_ROOT, 'bin', 'watcher-wake.mjs');

async function runCli(args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI_PATH, ...args], {
      timeout: 15_000,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return {
      code: Number.isInteger(err?.code) ? err.code : 1,
      stdout: String(err?.stdout || ''),
      stderr: String(err?.stderr || err?.message || ''),
    };
  }
}

test('watcher-wake CLI writes the HAM eligible wake payload', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'watcher-wake-cli-'));
  try {
    const result = await runCli([
      '--root-dir', rootDir,
      '--repo', 'laceyenterprises/agent-os',
      '--pr', '6561',
      '--head-sha', 'abc123abc123abc123abc123abc123abc123abc1',
      '--reason', 'hammer-pr-eligible',
      '--requested-at', '2026-09-10T21:40:00.000Z',
      '--request-id', 'test-hammer-eligible',
    ]);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, '');
    const rendered = JSON.parse(result.stdout);
    const persisted = JSON.parse(readFileSync(watcherWakePath(rootDir), 'utf8'));
    assert.deepEqual(rendered, {
      requested: true,
      filePath: watcherWakePath(rootDir),
      payload: persisted,
    });
    // `pending_subjects` carries the un-consumed subjects so a burst of wakes
    // does not lose all but the last (review follow-up on #1052). The
    // top-level fields still describe the newest request, so readers predating
    // the list are unaffected; on a fresh root the list holds just this one.
    assert.deepEqual(persisted, {
      schema_version: 1,
      request_id: 'test-hammer-eligible',
      requested_at: '2026-09-10T21:40:00.000Z',
      reason: 'hammer-pr-eligible',
      repo: 'laceyenterprises/agent-os',
      pr_number: 6561,
      head_sha: 'abc123abc123abc123abc123abc123abc123abc1',
      pending_subjects: [
        {
          repo: 'laceyenterprises/agent-os',
          pr_number: 6561,
          head_sha: 'abc123abc123abc123abc123abc123abc123abc1',
          requested_at: '2026-09-10T21:40:00.000Z',
        },
      ],
    });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('watcher-wake CLI rejects malformed PR identity before writing', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'watcher-wake-cli-'));
  try {
    const result = await runCli([
      '--root-dir', rootDir,
      '--repo', '../agent-os',
      '--pr', 'not-a-number',
    ]);
    assert.equal(result.code, 64);
    assert.match(result.stderr, /--repo must be shaped owner\/name/);
    assert.throws(() => readFileSync(watcherWakePath(rootDir), 'utf8'), /ENOENT/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('watcher-wake CLI rejects malformed requested-at before writing', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'watcher-wake-cli-'));
  try {
    for (const timestamp of ['nonsense', 'September 27, 2026', '2026-09-27', '2026-09-27T18:29:12']) {
      const result = await runCli([
        '--root-dir', rootDir, '--repo', 'o/r', '--pr', '17', '--requested-at', timestamp,
      ]);
      assert.equal(result.code, 64, timestamp);
      assert.match(result.stderr, /--requested-at must be an ISO timestamp/);
    }
    assert.throws(() => readFileSync(watcherWakePath(rootDir), 'utf8'), /ENOENT/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('watcher-wake CLI accepts an ISO timestamp with an explicit offset', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'watcher-wake-cli-'));
  try {
    const requestedAt = '2026-09-27T11:29:12-07:00';
    const result = await runCli([
      '--root-dir', rootDir, '--repo', 'o/r', '--pr', '17', '--requested-at', requestedAt,
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(readFileSync(watcherWakePath(rootDir), 'utf8')).requested_at, requestedAt);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
