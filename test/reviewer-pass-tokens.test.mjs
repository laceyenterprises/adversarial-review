import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { main as tokensMain } from '../src/tokens-cli.mjs';
import {
  backfillReviewerPasses,
  beginReviewerPass,
  completeReviewerPass,
  readWorkerRunTokenUsage,
} from '../src/reviewer-pass-tokens.mjs';
import { ensureReviewStateSchema, openReviewStateDb } from '../src/review-state.mjs';

function tempRoot() {
  return mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
}

function countReviewerPasses(rootDir) {
  const db = openReviewStateDb(rootDir);
  try {
    ensureReviewStateSchema(db);
    return db.prepare('SELECT COUNT(*) AS count FROM reviewer_passes').get().count;
  } finally {
    db.close();
  }
}

function createLedgerDb(dbPath) {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE runtime_sessions (
      session_id TEXT PRIMARY KEY,
      adapter_session_key TEXT,
      total_input_tokens INTEGER,
      total_output_tokens INTEGER,
      total_cache_read_tokens INTEGER,
      total_cache_write_tokens INTEGER,
      total_cost_usd REAL,
      source_path TEXT,
      started_at TEXT,
      ended_at TEXT
    );
    CREATE TABLE worker_runs (
      run_id TEXT PRIMARY KEY,
      launch_request_id TEXT,
      session_id TEXT,
      token_usage_input INTEGER,
      token_usage_output INTEGER,
      token_usage_cost_usd REAL,
      token_usage_source TEXT,
      started_at TEXT,
      ended_at TEXT,
      updated_at TEXT
    );
  `);
  db.prepare(
    `INSERT INTO runtime_sessions (
       session_id, adapter_session_key, total_input_tokens, total_output_tokens,
       total_cache_read_tokens, total_cache_write_tokens, total_cost_usd,
       source_path, started_at, ended_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'rs_1',
    'session-1',
    120,
    45,
    11,
    7,
    0.35,
    '/tmp/review-workspace',
    '2026-05-18T01:00:00.000Z',
    '2026-05-18T01:02:00.000Z'
  );
  db.prepare(
    `INSERT INTO worker_runs (
       run_id, launch_request_id, session_id, token_usage_input,
       token_usage_output, token_usage_cost_usd, token_usage_source,
       started_at, ended_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'wr_1',
    'lrq_1',
    'rs_1',
    120,
    45,
    0.35,
    'session-ledger',
    '2026-05-18T01:00:00.000Z',
    '2026-05-18T01:02:00.000Z',
    '2026-05-18T01:02:00.000Z'
  );
  db.close();
}

test('reviewer pass writer inserts running row, completes it, and unique key prevents duplicates', () => {
  const rootDir = tempRoot();
  beginReviewerPass(rootDir, {
    repo: 'laceyenterprises/agent-os',
    prNumber: 42,
    attemptNumber: 1,
    reviewerClass: 'claude-sonnet',
    passKind: 'first-pass',
    workspacePath: rootDir,
    startedAt: '2026-05-18T00:00:00.000Z',
  });
  beginReviewerPass(rootDir, {
    repo: 'laceyenterprises/agent-os',
    prNumber: 42,
    attemptNumber: 1,
    reviewerClass: 'claude-sonnet',
    passKind: 'first-pass',
    workspacePath: rootDir,
    startedAt: '2026-05-18T00:00:00.000Z',
  });
  assert.equal(countReviewerPasses(rootDir), 1);

  const row = completeReviewerPass(rootDir, {
    repo: 'laceyenterprises/agent-os',
    prNumber: 42,
    attemptNumber: 1,
    passKind: 'first-pass',
    status: 'completed',
    endedAt: '2026-05-18T00:01:00.000Z',
    tokenUsage: {
      input: 10,
      output: 4,
      cacheRead: 3,
      cacheWrite: 2,
      source: 'session-ledger',
    },
  });
  assert.equal(row.status, 'completed');
  assert.equal(row.token_input, 10);
  assert.equal(row.token_output, 4);
  assert.equal(row.token_cache_read, 3);
  assert.equal(row.token_cache_write, 2);
  assert.equal(row.token_cost_usd, null);
  assert.equal(row.token_source, 'session-ledger');
});

test('worker-run rollup join reads token columns and cache totals from runtime session', () => {
  const rootDir = tempRoot();
  const ledgerDb = path.join(rootDir, 'ledger.db');
  createLedgerDb(ledgerDb);

  const usage = readWorkerRunTokenUsage({
    workerRunId: 'wr_1',
    ledgerDbPath: ledgerDb,
    rootDir,
  });

  assert.equal(usage.workerRunId, 'wr_1');
  assert.equal(usage.input, 120);
  assert.equal(usage.output, 45);
  assert.equal(usage.cacheRead, 11);
  assert.equal(usage.cacheWrite, 7);
  assert.equal(usage.costUSD, 0.35);
  assert.equal(usage.source, 'session-ledger');
});

test('backfill is idempotent for historical follow-up workspaces', () => {
  const rootDir = tempRoot();
  const ledgerDb = path.join(rootDir, 'ledger.db');
  createLedgerDb(ledgerDb);
  const completedDir = path.join(rootDir, 'data', 'follow-up-jobs', 'completed');
  mkdirSync(completedDir, { recursive: true });
  writeFileSync(path.join(completedDir, 'job-1.json'), JSON.stringify({
    repo: 'laceyenterprises/agent-os',
    prNumber: 43,
    jobId: 'job-1',
    status: 'completed',
    completedAt: '2026-05-18T01:02:00.000Z',
    workspaceDir: '/tmp/review-workspace',
    remediationPlan: { currentRound: 1 },
    remediationWorker: {
      model: 'codex',
      state: 'completed',
      spawnedAt: '2026-05-18T01:00:00.000Z',
      workerRunId: 'wr_1',
      workspaceDir: '/tmp/review-workspace',
    },
  }), 'utf8');

  const first = backfillReviewerPasses(rootDir, { ledgerDbPath: ledgerDb });
  const second = backfillReviewerPasses(rootDir, { ledgerDbPath: ledgerDb });

  assert.equal(first.considered, 1);
  assert.equal(second.considered, 1);
  assert.equal(countReviewerPasses(rootDir), 1);
  const db = openReviewStateDb(rootDir);
  try {
    ensureReviewStateSchema(db);
    const row = db.prepare('SELECT * FROM reviewer_passes WHERE pr_number = 43').get();
    assert.equal(row.pass_kind, 'remediation');
    assert.equal(row.worker_run_id, 'wr_1');
    assert.equal(row.token_input, 120);
    assert.equal(row.token_cache_read, 11);
  } finally {
    db.close();
  }
});

test('tokens CLI prints per-PR rollup with reviewer breakdown', () => {
  const rootDir = tempRoot();
  beginReviewerPass(rootDir, {
    repo: 'laceyenterprises/agent-os',
    prNumber: 44,
    attemptNumber: 1,
    reviewerClass: 'codex',
    passKind: 'first-pass',
    startedAt: '2026-05-18T00:00:00.000Z',
  });
  completeReviewerPass(rootDir, {
    repo: 'laceyenterprises/agent-os',
    prNumber: 44,
    attemptNumber: 1,
    passKind: 'first-pass',
    status: 'completed',
    tokenUsage: { input: 100, output: 50, costUSD: 0.25, source: 'litellm' },
  });
  const out = { value: '', write(chunk) { this.value += chunk; } };
  const err = { value: '', write(chunk) { this.value += chunk; } };
  const code = tokensMain(['--root-dir', rootDir, '--by-pr'], { stdout: out, stderr: err });

  assert.equal(code, 0);
  assert.match(out.value, /laceyenterprises\/agent-os#44/);
  assert.match(out.value, /150/);
  assert.match(out.value, /codex:150\/\$0\.25/);
});
