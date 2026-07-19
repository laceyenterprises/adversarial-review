import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  apiStatusFromError,
  createApiCallRecorder,
  resolveDefaultApiCallRootDir,
  resolveApiCallLogDir,
} from '../src/api-telemetry.mjs';

function makeRootDir(prefix = 'api-telemetry-') {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function readJsonl(filePath) {
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test('recordApiCall writes one JSONL line with all required fields', () => {
  const rootDir = makeRootDir();
  try {
    const recorder = createApiCallRecorder({
      rootDir,
      nowMs: () => Date.parse('2026-06-05T08:15:00.000Z'),
      timestampNow: () => '2026-06-05T08:15:00.000Z',
    });

    const filePath = recorder.recordApiCall({
      category: 'pr_view',
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 1388,
      status: 200,
      durationMs: 123.4,
    });
    recorder.flush();

    assert.deepEqual(readJsonl(filePath), [
      {
        timestamp: '2026-06-05T08:15:00.000Z',
        category: 'pr_view',
        repo: 'laceyenterprises/adversarial-review',
        pr: 1388,
        status: 200,
        durationMs: 123,
      },
    ]);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('accepts the github-api GraphQL telemetry categories (pr_commits, pr_mergeability)', () => {
  // Regression: github-api.mjs emits `pr_commits` (commit-subject GraphQL query)
  // and `pr_mergeability` (mergeability adapter read), but both were missing from
  // CATEGORY_ORDER, so the real recorder threw "Unsupported API telemetry
  // category" in production — non-fatal, but every such telemetry row was
  // silently dropped. The github-api tests mock the recorder, so only a
  // real-recorder assertion catches this.
  const rootDir = makeRootDir();
  try {
    const recorder = createApiCallRecorder({
      rootDir,
      nowMs: () => Date.parse('2026-07-19T04:45:00.000Z'),
      timestampNow: () => '2026-07-19T04:45:00.000Z',
    });
    for (const category of ['pr_commits', 'pr_mergeability']) {
      // Before the fix this call threw "Unsupported API telemetry category".
      const filePath = recorder.recordApiCall({
        category,
        repo: 'laceyenterprises/adversarial-review',
        prNumber: 637,
        status: 200,
        durationMs: 42,
      });
      recorder.flush();
      assert.ok(
        readJsonl(filePath).some((row) => row.category === category),
        `expected a persisted ${category} telemetry row`,
      );
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('daily rotation writes to a new UTC file after midnight', () => {
  const rootDir = makeRootDir();
  try {
    let now = Date.parse('2026-06-05T23:59:59.900Z');
    const recorder = createApiCallRecorder({
      rootDir,
      nowMs: () => now,
      timestampNow: () => new Date(now).toISOString(),
    });

    const firstPath = recorder.recordApiCall({
      category: 'pr_view',
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 1388,
      status: 200,
      durationMs: 10,
    });
    now = Date.parse('2026-06-06T00:00:00.100Z');
    const secondPath = recorder.recordApiCall({
      category: 'review_post',
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 1388,
      status: 200,
      durationMs: 20,
    });
    recorder.flush();

    assert.match(firstPath, /2026-06-05\.jsonl$/);
    assert.match(secondPath, /2026-06-06\.jsonl$/);
    assert.equal(readJsonl(firstPath).length, 1);
    assert.equal(readJsonl(secondPath).length, 1);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('retention sweep deletes files older than the configured window', () => {
  const rootDir = makeRootDir();
  try {
    const logDir = resolveApiCallLogDir(rootDir);
    mkdirSync(logDir, { recursive: true });
    writeFileSync(path.join(logDir, '2026-05-20.jsonl'), '{}\n', 'utf8');
    writeFileSync(path.join(logDir, '2026-06-04.jsonl'), '{}\n', 'utf8');
    writeFileSync(path.join(logDir, '2026-06-05.jsonl'), '{}\n', 'utf8');

    const recorder = createApiCallRecorder({
      rootDir,
      env: { GHO_API_CALL_LOG_RETENTION_DAYS: '2' },
      nowMs: () => Date.parse('2026-06-05T12:00:00.000Z'),
      timestampNow: () => '2026-06-05T12:00:00.000Z',
    });
    recorder.recordApiCall({
      category: 'pr_view',
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 1388,
      status: 200,
      durationMs: 10,
    });
    recorder.flush();

    assert.equal(readdirSync(logDir).includes('2026-05-20.jsonl'), false);
    assert.equal(readdirSync(logDir).includes('2026-06-04.jsonl'), true);
    assert.equal(readdirSync(logDir).includes('2026-06-05.jsonl'), true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('rotation uses atomic rename and leaves clean JSONL files across boundary traffic', () => {
  const rootDir = makeRootDir();
  const renameCalls = [];
  try {
    let now = Date.parse('2026-06-05T23:59:59.990Z');
    const recorder = createApiCallRecorder({
      rootDir,
      nowMs: () => now,
      timestampNow: () => new Date(now).toISOString(),
      renameFileSync: (from, to) => {
        renameCalls.push({ from, to });
        return renameSync(from, to);
      },
    });

    for (let index = 0; index < 5; index += 1) {
      recorder.recordApiCall({
        category: 'pr_view',
        repo: 'laceyenterprises/adversarial-review',
        prNumber: 1388,
        status: 200,
        durationMs: index,
      });
    }
    now = Date.parse('2026-06-06T00:00:00.010Z');
    for (let index = 0; index < 5; index += 1) {
      recorder.recordApiCall({
        category: 'review_post',
        repo: 'laceyenterprises/adversarial-review',
        prNumber: 1388,
        status: 200,
        durationMs: index,
      });
    }
    recorder.flush();

    const logDir = resolveApiCallLogDir(rootDir);
    assert.equal(renameCalls.length >= 2, true);
    assert.deepEqual(
      readdirSync(logDir).sort(),
      ['2026-06-05.jsonl', '2026-06-06.jsonl'],
    );
    assert.equal(readJsonl(path.join(logDir, '2026-06-05.jsonl')).length, 5);
    assert.equal(readJsonl(path.join(logDir, '2026-06-06.jsonl')).length, 5);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('recordApiCall batches row writes until flush', () => {
  const rootDir = makeRootDir();
  const appendPayloads = [];
  try {
    const recorder = createApiCallRecorder({
      rootDir,
      nowMs: () => Date.parse('2026-06-05T08:15:00.000Z'),
      timestampNow: () => '2026-06-05T08:15:00.000Z',
      appendFileSyncImpl: (fd, payload, encoding) => {
        if (payload) appendPayloads.push(payload);
        return writeFileSync(fd, payload, encoding);
      },
    });

    const filePath = recorder.recordApiCall({
      category: 'pr_view',
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 1388,
      status: 200,
      durationMs: 10,
    });
    recorder.recordApiCall({
      category: 'files_list',
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 1388,
      status: 200,
      durationMs: 20,
    });

    assert.equal(appendPayloads.length, 0);
    assert.equal(recorder.getState().pendingRows, 2);

    recorder.flush();

    assert.equal(appendPayloads.length, 1);
    assert.equal(readJsonl(filePath).length, 2);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('canonical telemetry columns are not overwritten by extra fields', () => {
  const rootDir = makeRootDir();
  try {
    const recorder = createApiCallRecorder({
      rootDir,
      nowMs: () => Date.parse('2026-06-05T08:15:00.000Z'),
      timestampNow: () => '2026-06-05T08:15:00.000Z',
    });
    const filePath = recorder.recordApiCall({
      category: 'pr_view',
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 1388,
      status: 200,
      durationMs: 123,
      extra: {
        status: 'rogue',
        timestamp: '1999-01-01T00:00:00.000Z',
        category: 'graphql_pr_rollup',
      },
    });
    recorder.flush();

    assert.deepEqual(readJsonl(filePath), [
      {
        timestamp: '2026-06-05T08:15:00.000Z',
        category: 'pr_view',
        repo: 'laceyenterprises/adversarial-review',
        pr: 1388,
        status: 200,
        durationMs: 123,
      },
    ]);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('apiStatusFromError keeps HTTP and local execution failures distinct', () => {
  assert.equal(apiStatusFromError({ status: 403 }), 403);
  assert.equal(apiStatusFromError({ response: { status: 429 } }), 429);
  assert.equal(apiStatusFromError({ code: 1 }), 'exec_error');
  assert.equal(apiStatusFromError({ signal: 'SIGTERM' }), 'exec_error');
  assert.equal(apiStatusFromError({ command: 'gh pr diff' }), 'exec_error');
  assert.equal(apiStatusFromError({ code: 'ENOENT' }), 'ENOENT');
  assert.equal(apiStatusFromError({}), 'error');
});

test('default API call root is disabled in tests and can be configured', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  assert.equal(resolveDefaultApiCallRootDir({ NODE_ENV: 'test' }), null);
  assert.equal(resolveDefaultApiCallRootDir({ NODE_TEST_CONTEXT: '1' }), null);
  assert.equal(resolveDefaultApiCallRootDir({ GHO_API_CALL_LOG_DISABLE: '1', GHO_API_CALL_LOG_ROOT_DIR: '/tmp/ignored' }), null);
  assert.equal(resolveDefaultApiCallRootDir({ GHO_API_CALL_LOG_ROOT_DIR: '/tmp/gho-api-log' }), '/tmp/gho-api-log');
  assert.equal(resolveDefaultApiCallRootDir({}), repoRoot);
});
