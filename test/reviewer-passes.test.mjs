import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openReviewStateDb } from '../src/review-state.mjs';
import { main as tokensMain } from '../src/tokens-cli.mjs';
import {
  backfillReviewerPassesFromWorkspaces,
  ensureReviewerPassesSchema,
  insertReviewerPassStarted,
  readTokenUsageFromSessionLedger,
  updateReviewerPassCompleted,
} from '../src/reviewer-passes.mjs';

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'adv-reviewer-passes-'));
}

function makeLedgerDb(path) {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE runtime_sessions (
      session_id TEXT PRIMARY KEY,
      adapter_session_key TEXT NOT NULL,
      source_path TEXT,
      transcript_ref TEXT
    );
    CREATE TABLE transcript_entries (
      runtime_session_id TEXT,
      event_timestamp TEXT NOT NULL,
      content_json TEXT,
      tool_metadata_json TEXT
    );
    CREATE TABLE worker_runs (
      run_id TEXT PRIMARY KEY,
      launch_request_id TEXT,
      session_id TEXT,
      session_name TEXT,
      started_at TEXT,
      ended_at TEXT,
      token_usage_input INTEGER,
      token_usage_output INTEGER,
      token_usage_cost_usd REAL,
      token_usage_source TEXT
    );
  `);
  return db;
}

test('reviewer pass writer inserts once and updates terminal token usage', () => {
  const rootDir = tempRoot();
  const db = openReviewStateDb(rootDir);
  try {
    insertReviewerPassStarted(db, {
      repo: 'laceyenterprises/demo',
      prNumber: 42,
      attemptNumber: 1,
      reviewerClass: 'codex',
      passKind: 'first-pass',
      workspacePath: rootDir,
      startedAt: '2026-05-15T00:00:00.000Z',
    });
    insertReviewerPassStarted(db, {
      repo: 'laceyenterprises/demo',
      prNumber: 42,
      attemptNumber: 1,
      reviewerClass: 'codex',
      passKind: 'first-pass',
      workspacePath: rootDir,
      startedAt: '2026-05-15T00:00:01.000Z',
    });

    const count = db.prepare('SELECT COUNT(*) AS count FROM reviewer_passes').get().count;
    assert.equal(count, 1);

    updateReviewerPassCompleted(db, {
      repo: 'laceyenterprises/demo',
      prNumber: 42,
      attemptNumber: 1,
      passKind: 'first-pass',
      endedAt: '2026-05-15T00:02:00.000Z',
      status: 'completed',
      tokenUsage: {
        input: 100,
        output: 25,
        cacheRead: 10,
        cacheWrite: 4,
        source: 'session-ledger',
      },
    });

    const row = db.prepare('SELECT * FROM reviewer_passes').get();
    assert.equal(row.status, 'completed');
    assert.equal(row.token_input, 100);
    assert.equal(row.token_output, 25);
    assert.equal(row.token_cache_read, 10);
    assert.equal(row.token_cache_write, 4);
  } finally {
    db.close();
  }
});

test('session-ledger transcript lookup populates token and cache columns', () => {
  const rootDir = tempRoot();
  const ledgerPath = join(rootDir, 'ledger.db');
  const ledger = makeLedgerDb(ledgerPath);
  try {
    ledger.prepare('INSERT INTO runtime_sessions (session_id, adapter_session_key) VALUES (?, ?)').run('rs-1', 'review-session-1');
    ledger.prepare(
      'INSERT INTO transcript_entries (runtime_session_id, event_timestamp, content_json) VALUES (?, ?, ?)'
    ).run(
      'rs-1',
      '2026-05-15T00:01:00.000Z',
      JSON.stringify({
        model: 'claude-sonnet',
        usage: {
          input_tokens: 80,
          output_tokens: 20,
          cache_read_input_tokens: 30,
          cache_creation_input_tokens: 12,
        },
      }),
    );
  } finally {
    ledger.close();
  }

  const result = readTokenUsageFromSessionLedger({
    rootDir,
    dbPath: ledgerPath,
    adapterSessionKeys: ['review-session-1'],
    startedAt: '2026-05-15T00:00:00.000Z',
    endedAt: '2026-05-15T00:02:00.000Z',
  });
  assert.equal(result.reason, null);
  assert.deepEqual(result.sessionIds, ['rs-1']);
  assert.equal(result.tokenUsage.input, 80);
  assert.equal(result.tokenUsage.output, 20);
  assert.equal(result.tokenUsage.cacheRead, 30);
  assert.equal(result.tokenUsage.cacheWrite, 12);
  assert.equal(result.tokenUsage.costUSD, null);
});

test('tokens CLI prints per-PR rollup with reviewer breakdown', () => {
  const rootDir = tempRoot();
  const db = openReviewStateDb(rootDir);
  try {
    ensureReviewerPassesSchema(db);
    db.prepare(
      `INSERT INTO reviewer_passes
       (repo, pr_number, attempt_number, reviewer_class, pass_kind, started_at, status,
        token_input, token_output, token_cache_read, token_cache_write, token_cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('laceyenterprises/demo', 7, 1, 'codex', 'first-pass', '2026-05-15T00:00:00.000Z', 'completed', 10, 5, 2, 1, null);
    db.prepare(
      `INSERT INTO reviewer_passes
       (repo, pr_number, attempt_number, reviewer_class, pass_kind, started_at, status,
        token_input, token_output, token_cache_read, token_cache_write, token_cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('laceyenterprises/demo', 7, 2, 'claude', 'remediation', '2026-05-15T00:10:00.000Z', 'completed', 20, 10, 4, 2, 0.25);
  } finally {
    db.close();
  }

  let output = '';
  const code = tokensMain(['--root', rootDir, '--by-pr', '--since', '2026-05-01T00:00:00.000Z'], {
    stdout: { write: (text) => { output += text; } },
    stderr: { write: () => {} },
  });
  assert.equal(code, 0);
  assert.match(output, /laceyenterprises\/demo#7/);
  assert.match(output, /54/);
  assert.match(output, /codex:1/);
  assert.match(output, /claude:1/);
});

test('reviewer pass backfill is idempotent for existing workspaces', () => {
  const rootDir = tempRoot();
  const workspace = join(rootDir, 'data', 'follow-up-jobs', 'workspaces', 'job-1');
  const completedDir = join(rootDir, 'data', 'follow-up-jobs', 'completed');
  const transcriptRoot = join(rootDir, 'transcripts');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(completedDir, { recursive: true });
  mkdirSync(transcriptRoot, { recursive: true });
  writeFileSync(join(completedDir, 'job-1.json'), `${JSON.stringify({
    schemaVersion: 2,
    jobId: 'job-1',
    repo: 'laceyenterprises/demo',
    prNumber: 99,
    status: 'completed',
    createdAt: '2026-05-15T00:00:00.000Z',
    claimedAt: '2026-05-15T00:01:00.000Z',
    completedAt: '2026-05-15T00:10:00.000Z',
    workspaceDir: 'data/follow-up-jobs/workspaces/job-1',
    remediationPlan: { mode: 'bounded-manual-rounds', maxRounds: 3, currentRound: 2, rounds: [] },
    remediationWorker: {
      model: 'claude-code',
      state: 'completed',
      spawnedAt: '2026-05-15T00:02:00.000Z',
      workspaceDir: 'data/follow-up-jobs/workspaces/job-1',
    },
  })}\n`);
  writeFileSync(join(transcriptRoot, 'claude.jsonl'), [
    JSON.stringify({
      type: 'assistant',
      cwd: workspace,
      message: {
        usage: {
          input_tokens: 50,
          output_tokens: 15,
          cache_read_input_tokens: 5,
          cache_creation_input_tokens: 3,
        },
      },
    }),
    '',
  ].join('\n'));

  const db = openReviewStateDb(rootDir);
  try {
    const first = backfillReviewerPassesFromWorkspaces(db, {
      rootDir,
      transcriptRoots: [transcriptRoot],
      now: () => '2026-05-15T01:00:00.000Z',
    });
    const second = backfillReviewerPassesFromWorkspaces(db, {
      rootDir,
      transcriptRoots: [transcriptRoot],
      now: () => '2026-05-15T01:00:00.000Z',
    });
    assert.equal(first.populatedRows, 1);
    assert.equal(second.populatedRows, 1);
    const rows = db.prepare('SELECT * FROM reviewer_passes').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].reviewer_class, 'claude');
    assert.equal(rows[0].attempt_number, 2);
    assert.equal(rows[0].token_input, 50);
    assert.equal(rows[0].token_cache_write, 3);
  } finally {
    db.close();
  }
});
