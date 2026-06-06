import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { resolveApiCallLogDir } from '../src/api-telemetry.mjs';
import { formatApiStats, main, parseSinceWindow, readApiCallRows, summarizeApiCallRows, filterRows } from '../scripts/api-stats.mjs';

function makeRootDir(prefix = 'api-stats-') {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function writeFixtureLog(rootDir, fileName, rows) {
  const logDir = resolveApiCallLogDir(rootDir);
  mkdirSync(logDir, { recursive: true });
  writeFileSync(
    path.join(logDir, fileName),
    `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
    'utf8'
  );
}

test('api-stats fixture summary matches the expected snapshot', () => {
  const rootDir = makeRootDir();
  try {
    writeFixtureLog(rootDir, '2026-06-05.jsonl', [
      { timestamp: '2026-06-05T11:15:00.000Z', category: 'pr_view', repo: 'laceyenterprises/adversarial-review', pr: 1388, status: 200, durationMs: 90 },
      { timestamp: '2026-06-05T11:20:00.000Z', category: 'diff_fetch', repo: 'laceyenterprises/adversarial-review', pr: 1388, status: 200, durationMs: 120 },
      { timestamp: '2026-06-05T11:25:00.000Z', category: 'labels_list', repo: 'laceyenterprises/adversarial-review', pr: 1388, status: 200, durationMs: 40 },
      { timestamp: '2026-06-05T11:30:00.000Z', category: 'timeline_events', repo: 'laceyenterprises/adversarial-review', pr: 1388, status: 200, durationMs: 50 },
      { timestamp: '2026-06-05T11:35:00.000Z', category: 'review_post', repo: 'laceyenterprises/adversarial-review', pr: 1388, status: 200, durationMs: 80 },
      { timestamp: '2026-06-05T11:40:00.000Z', category: 'rate_limit_throttle_seconds', repo: 'laceyenterprises/adversarial-review', pr: 1388, status: 200, durationMs: 30000 },
      { timestamp: '2026-06-05T11:45:00.000Z', category: 'pr_view', repo: 'laceyenterprises/another-repo', pr: 77, status: 200, durationMs: 60 },
      { timestamp: '2026-06-05T11:50:00.000Z', category: 'files_list', repo: 'laceyenterprises/another-repo', pr: 77, status: 200, durationMs: 70 },
    ]);

    const rows = filterRows(readApiCallRows(rootDir), {
      since: parseSinceWindow('1h'),
      nowMs: Date.parse('2026-06-05T12:00:00.000Z'),
    });
    const summary = summarizeApiCallRows(rows, { budget: 5000 });

    assert.equal(
      formatApiStats(summary, { since: parseSinceWindow('1h') }),
      [
        'Window: 1h',
        'Total calls: 7/5000 (0.1%) | Remaining: 4993',
        'Throttle activations: 1 (30s total)',
        'By category:',
        '  diff_fetch: 1',
        '  pr_view: 2',
        '  labels_list: 1',
        '  timeline_events: 1',
        '  files_list: 1',
        '  review_post: 1',
        'By repo:',
        '  laceyenterprises/adversarial-review: 5',
        '  laceyenterprises/another-repo: 2',
        '',
      ].join('\n')
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('--since filter respects the requested time bound', () => {
  const rootDir = makeRootDir();
  try {
    writeFixtureLog(rootDir, '2026-06-05.jsonl', [
      { timestamp: '2026-06-05T10:30:00.000Z', category: 'pr_view', repo: 'laceyenterprises/adversarial-review', pr: 1, status: 200, durationMs: 10 },
      { timestamp: '2026-06-05T11:30:00.000Z', category: 'pr_view', repo: 'laceyenterprises/adversarial-review', pr: 2, status: 200, durationMs: 10 },
    ]);

    const rows = filterRows(readApiCallRows(rootDir), {
      since: parseSinceWindow('1h'),
      nowMs: Date.parse('2026-06-05T12:00:00.000Z'),
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].pr, 2);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('--repo filter restricts the count correctly', async () => {
  const rootDir = makeRootDir();
  const stdout = [];
  const originalWrite = process.stdout.write;
  try {
    writeFixtureLog(rootDir, '2026-06-05.jsonl', [
      { timestamp: '2026-06-05T11:15:00.000Z', category: 'pr_view', repo: 'laceyenterprises/adversarial-review', pr: 1, status: 200, durationMs: 10 },
      { timestamp: '2026-06-05T11:20:00.000Z', category: 'review_post', repo: 'laceyenterprises/adversarial-review', pr: 1, status: 200, durationMs: 10 },
      { timestamp: '2026-06-05T11:25:00.000Z', category: 'pr_view', repo: 'laceyenterprises/another-repo', pr: 2, status: 200, durationMs: 10 },
    ]);

    process.stdout.write = (chunk) => {
      stdout.push(String(chunk));
      return true;
    };
    await main(['--since', '1h', '--repo', 'laceyenterprises/adversarial-review'], {
      rootDir,
      nowMs: Date.parse('2026-06-05T12:00:00.000Z'),
    });
    assert.equal(stdout.join(''), [
      'Window: 1h',
      'Total calls: 2/5000 (0.0%) | Remaining: 4998',
      'Throttle activations: 0 (0s total)',
      'By category:',
      '  pr_view: 1',
      '  review_post: 1',
      'By repo:',
      '  laceyenterprises/adversarial-review: 2',
      '',
    ].join('\n'));
  } finally {
    process.stdout.write = originalWrite;
    rmSync(rootDir, { recursive: true, force: true });
  }
});
