import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  createApiCallRecorder,
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
