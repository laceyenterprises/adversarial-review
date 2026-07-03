import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  main as backfillReviewerPassesMain,
  parseArgs as parseBackfillReviewerPassArgs,
} from '../scripts/backfill-reviewer-passes.mjs';
import {
  createEmptySqliteDb,
  createSessionLedgerDb,
  reviewerPassTokenReaderFixtures,
} from './helpers/session-ledger-fixtures.mjs';
import { main as tokensMain } from '../src/tokens-cli.mjs';
import {
  backfillReviewerPasses,
  beginReviewerPass,
  completeReviewerPass,
  readBestReviewerEvidenceTokenUsage,
  readClaudeTranscriptTokenUsage,
  readCodexTranscriptTokenUsage,
  readReviewerSessionTokenUsage,
  tagTokenUsage,
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

function makeCaptureStream() {
  let text = '';
  return {
    write(chunk) {
      text += String(chunk);
    },
    read() {
      return text;
    },
  };
}

test('reviewer_passes schema migrates existing tables to reviewer_model', () => {
  const rootDir = tempRoot();
  const db = openReviewStateDb(rootDir);
  try {
    db.exec(`
      CREATE TABLE reviewer_passes (
        pass_id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        attempt_number INTEGER NOT NULL,
        reviewer_class TEXT NOT NULL,
        pass_kind TEXT NOT NULL,
        started_at TEXT NOT NULL,
        status TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE(repo, pr_number, attempt_number, pass_kind)
      );
    `);
    ensureReviewStateSchema(db);
    const columns = db.prepare('PRAGMA table_info(reviewer_passes)').all().map((column) => column.name);
    assert.ok(columns.includes('reviewer_model'));
  } finally {
    db.close();
  }
});

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
  const db = openReviewStateDb(rootDir);
  try {
    ensureReviewStateSchema(db);
    const inserted = db.prepare('SELECT reviewer_class, reviewer_model FROM reviewer_passes WHERE pr_number = 42').get();
    assert.equal(inserted.reviewer_class, 'claude');
    assert.equal(inserted.reviewer_model, 'claude-sonnet');
  } finally {
    db.close();
  }

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
  assert.equal(row.reviewer_model, 'claude-sonnet');
});

test('worker-run and reviewer-session readers accept ledger target object, URI, and --ledger-db alias', () => {
  const rootDir = tempRoot();
  for (const fixture of reviewerPassTokenReaderFixtures(rootDir)) {
    const workerUsage = readWorkerRunTokenUsage({
      workerRunId: 'wr_1',
      rootDir,
      ...fixture.apply(),
    });
    const failedWorkerUsage = readWorkerRunTokenUsage({
      workerRunId: 'wr_2',
      rootDir,
      ...fixture.apply(),
    });
    const reviewerUsage = readReviewerSessionTokenUsage({
      adapterSessionKey: 'session-1',
      workspacePath: '/tmp/review-workspace',
      startedAt: '2026-05-18T00:59:00.000Z',
      endedAt: '2026-05-18T01:03:00.000Z',
      rootDir,
      ...fixture.apply(),
    });

    assert.equal(workerUsage.workerRunId, 'wr_1', fixture.name);
    assert.equal(workerUsage.input, 120, fixture.name);
    assert.equal(workerUsage.output, 45, fixture.name);
    assert.equal(workerUsage.cacheRead, 11, fixture.name);
    assert.equal(workerUsage.cacheWrite, 7, fixture.name);
    assert.equal(workerUsage.guardrail, 165, fixture.name);
    assert.equal(workerUsage.usageTag, 'guardrail', fixture.name);
    assert.equal(workerUsage.costUSD, 0.35, fixture.name);
    assert.equal(workerUsage.source, 'session-ledger', fixture.name);
    assert.equal(failedWorkerUsage.workerRunId, 'wr_2', fixture.name);
    assert.equal(failedWorkerUsage.input, 999, fixture.name);
    assert.equal(failedWorkerUsage.output, 333, fixture.name);
    assert.equal(failedWorkerUsage.guardrail, null, fixture.name);
    assert.equal(failedWorkerUsage.usageTag, null, fixture.name);
    assert.equal(failedWorkerUsage.source, 'session-ledger', fixture.name);

    assert.equal(reviewerUsage.adapterSessionKey, 'session-1', fixture.name);
    assert.equal(reviewerUsage.input, 120, fixture.name);
    assert.equal(reviewerUsage.output, 45, fixture.name);
    assert.equal(reviewerUsage.cacheRead, 11, fixture.name);
    assert.equal(reviewerUsage.cacheWrite, 7, fixture.name);
    assert.equal(reviewerUsage.costUSD, 0.35, fixture.name);
    assert.equal(reviewerUsage.source, 'session-ledger', fixture.name);
  }
});

test('reviewer session lookup skips empty HQ_ROOT ledger stubs', () => {
  const rootDir = tempRoot();
  const hqRoot = path.join(rootDir, 'agent-os-hq');
  const stubLedger = path.join(hqRoot, 'session-ledger', 'ledger.db');
  const realLedger = path.join(rootDir, '.agent-os', 'session-ledger', 'ledger.db');
  mkdirSync(path.dirname(stubLedger), { recursive: true });
  createEmptySqliteDb(stubLedger);
  createSessionLedgerDb(realLedger);

  const usage = readReviewerSessionTokenUsage({
    adapterSessionKey: 'session-1',
    workspacePath: '/tmp/review-workspace',
    startedAt: '2026-05-18T00:59:00.000Z',
    endedAt: '2026-05-18T01:03:00.000Z',
    ledgerTarget: { backend: 'sqlite', path: realLedger },
    env: { HQ_ROOT: hqRoot },
    rootDir,
  });

  assert.equal(usage.adapterSessionKey, 'session-1');
  assert.equal(usage.input, 120);
  assert.equal(usage.output, 45);
  assert.equal(usage.source, 'session-ledger');
});

test('worker-run lookup skips empty HQ_ROOT ledger stubs', () => {
  const rootDir = tempRoot();
  const hqRoot = path.join(rootDir, 'agent-os-hq');
  const stubLedger = path.join(hqRoot, 'session-ledger', 'ledger.db');
  const realLedger = path.join(rootDir, '.agent-os', 'session-ledger', 'ledger.db');
  mkdirSync(path.dirname(stubLedger), { recursive: true });
  createEmptySqliteDb(stubLedger);
  createSessionLedgerDb(realLedger);

  const usage = readWorkerRunTokenUsage({
    workerRunId: 'wr_1',
    ledgerTarget: { backend: 'sqlite', path: realLedger },
    env: { HQ_ROOT: hqRoot },
    rootDir,
  });

  assert.equal(usage.workerRunId, 'wr_1');
  assert.equal(usage.input, 120);
  assert.equal(usage.output, 45);
  assert.equal(usage.cacheRead, 11);
  assert.equal(usage.cacheWrite, 7);
  assert.equal(usage.guardrail, 165);
  assert.equal(usage.usageTag, 'guardrail');
  assert.equal(usage.source, 'session-ledger');
});

test('reviewer pass usage tag records guardrail attribution metadata', () => {
  const rootDir = tempRoot();
  beginReviewerPass(rootDir, {
    repo: 'laceyenterprises/agent-os',
    prNumber: 43,
    attemptNumber: 1,
    reviewerClass: 'codex',
    passKind: 'first-pass',
    startedAt: '2026-05-18T00:00:00.000Z',
  });
  const tagged = tagTokenUsage(
    { input: 20, output: 8, total: 28, source: 'codex-json' },
    'guardrail',
  );
  const row = completeReviewerPass(rootDir, {
    repo: 'laceyenterprises/agent-os',
    prNumber: 43,
    attemptNumber: 1,
    passKind: 'first-pass',
    status: 'completed',
    tokenUsage: tagged,
  });
  const metadata = JSON.parse(row.metadata_json);
  assert.equal(row.token_input, 20);
  assert.equal(row.token_output, 8);
  assert.equal(row.token_total, 28);
  assert.equal(metadata.tokenUsageTag, 'guardrail');
  assert.equal(metadata.tokenUsageGuardrail, 28);
});

test('reviewer pass usage tag preserves explicit null guardrail attribution', () => {
  const rootDir = tempRoot();
  const tagged = tagTokenUsage(
    { input: 999, output: 333, guardrail: null, source: 'session-ledger' },
    'guardrail',
  );
  beginReviewerPass(rootDir, {
    repo: 'laceyenterprises/agent-os',
    prNumber: 44,
    attemptNumber: 1,
    reviewerClass: 'codex',
    passKind: 'first-pass',
    startedAt: '2026-05-18T00:00:00.000Z',
  });
  const row = completeReviewerPass(rootDir, {
    repo: 'laceyenterprises/agent-os',
    prNumber: 44,
    attemptNumber: 1,
    passKind: 'first-pass',
    status: 'completed',
    tokenUsage: tagged,
  });
  const metadata = JSON.parse(row.metadata_json);

  assert.equal(tagged.input, 999);
  assert.equal(tagged.output, 333);
  assert.equal(tagged.guardrail, null);
  assert.equal(tagged.usageTag, 'guardrail');
  assert.equal(Object.prototype.hasOwnProperty.call(metadata, 'tokenUsageGuardrail'), true);
  assert.equal(metadata.tokenUsageGuardrail, null);
});

test('reviewer session lookup prefers adapter session keys over newer workspace siblings', () => {
  const rootDir = tempRoot();
  const ledgerDb = path.join(rootDir, 'ledger.db');
  createSessionLedgerDb(ledgerDb);

  const usage = readReviewerSessionTokenUsage({
    adapterSessionKey: 'session-1',
    workspacePath: '/tmp/review-workspace',
    startedAt: '2026-05-18T00:59:00.000Z',
    endedAt: '2026-05-18T01:03:00.000Z',
    ledgerTarget: `sqlite://${ledgerDb}`,
    rootDir,
  });

  assert.equal(usage.adapterSessionKey, 'session-1');
  assert.equal(usage.input, 120);
  assert.equal(usage.output, 45);
});

test('worker-run lookup prefers explicit workerRunId over a newer launch request sibling', () => {
  const rootDir = tempRoot();
  const ledgerDb = path.join(rootDir, 'ledger.db');
  createSessionLedgerDb(ledgerDb);

  const usage = readWorkerRunTokenUsage({
    workerRunId: 'wr_1_shared',
    launchRequestId: 'shared-lrq',
    ledgerTarget: { backend: 'sqlite', path: ledgerDb },
    rootDir,
  });

  assert.equal(usage.workerRunId, 'wr_1_shared');
  assert.equal(usage.launchRequestId, 'shared-lrq-old');
  assert.equal(usage.input, 120);
  assert.equal(usage.output, 45);
});

test('token rollup logs unsupported postgres backend once per scope', () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    const workerUsage = readWorkerRunTokenUsage({
      workerRunId: 'wr_1',
      ledgerTarget: { backend: 'postgres', databaseName: 'agent_os_ledger' },
    });
    const workerUsageAgain = readWorkerRunTokenUsage({
      workerRunId: 'wr_2',
      ledgerTarget: { backend: 'postgres', databaseName: 'agent_os_ledger' },
    });
    const reviewerUsage = readReviewerSessionTokenUsage({
      adapterSessionKey: 'session-1',
      ledgerTarget: { backend: 'postgres', databaseName: 'agent_os_ledger' },
    });

    assert.equal(workerUsage, null);
    assert.equal(workerUsageAgain, null);
    assert.equal(reviewerUsage, null);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /unsupported-ledger-backend.*worker-run/);
  assert.match(warnings[1], /unsupported-ledger-backend.*reviewer-session/);
});

test('backfill reviewer-pass CLI accepts backend-neutral ledger targets', () => {
  const parsed = parseBackfillReviewerPassArgs([
    '--root-dir', '/tmp/repo',
    '--ledger-target', 'sqlite:///tmp/ledger.db',
    '--dry-run',
  ]);

  assert.equal(parsed.rootDir, '/tmp/repo');
  assert.equal(parsed.ledgerTarget, 'sqlite:///tmp/ledger.db');
  assert.equal(parsed.ledgerDbDeprecated, false);
  assert.equal(parsed.dryRun, true);
});

test('backfill reviewer-pass CLI keeps --ledger-db as a deprecated alias', () => {
  const parsed = parseBackfillReviewerPassArgs([
    '--ledger-db', '/tmp/legacy-ledger.db',
  ]);

  assert.deepEqual(parsed.ledgerTarget, {
    backend: 'sqlite',
    path: '/tmp/legacy-ledger.db',
    source: 'deprecated-ledger-db-path',
    deprecatedAlias: true,
  });
  assert.equal(parsed.ledgerDbDeprecated, true);
});

test('backfill reviewer-pass CLI lets --ledger-target override deprecated --ledger-db warning', () => {
  const parsed = parseBackfillReviewerPassArgs([
    '--ledger-db', '/tmp/legacy-ledger.db',
    '--ledger-target', 'sqlite:///tmp/current-ledger.db',
  ]);

  assert.equal(parsed.ledgerTarget, 'sqlite:///tmp/current-ledger.db');
  assert.equal(parsed.ledgerDbDeprecated, false);
});

test('backfill reviewer-pass CLI warns for deprecated --ledger-db and still reads the ledger', () => {
  const stdout = makeCaptureStream();
  const stderr = makeCaptureStream();
  const rootDir = tempRoot();
  const ledgerDb = path.join(rootDir, 'ledger.db');
  createSessionLedgerDb(ledgerDb);
  const completedDir = path.join(rootDir, 'data', 'follow-up-jobs', 'completed');
  mkdirSync(completedDir, { recursive: true });
  writeFileSync(path.join(completedDir, 'job-cli.json'), JSON.stringify({
    repo: 'laceyenterprises/agent-os',
    prNumber: 43,
    jobId: 'job-cli',
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

  const rc = backfillReviewerPassesMain([
    '--root-dir', rootDir,
    '--ledger-db', ledgerDb,
    '--dry-run',
  ], { stdout, stderr });

  assert.equal(rc, 0);
  assert.match(stderr.read(), /warning: --ledger-db is deprecated; use --ledger-target instead/);
  const output = stdout.read();
  assert.match(output, /reviewer_passes backfill dry_run=true considered=1/);
  assert.match(output, /would_insert_or_update=1/);
  assert.match(output, /token_matched=1/);
});

test('backfill is idempotent for historical follow-up workspaces', () => {
  const rootDir = tempRoot();
  const ledgerDb = path.join(rootDir, 'ledger.db');
  createSessionLedgerDb(ledgerDb);
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

  const first = backfillReviewerPasses(rootDir, { ledgerTarget: { backend: 'sqlite', path: ledgerDb } });
  const second = backfillReviewerPasses(rootDir, { ledgerTarget: { backend: 'sqlite', path: ledgerDb } });

  assert.equal(first.considered, 1);
  assert.equal(second.considered, 1);
  assert.equal(first.uniquePassKeys, 1);
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

test('backfill dry-run reports eligible live-shaped jobs without writing reviewer passes', () => {
  const rootDir = tempRoot();
  const ledgerDb = path.join(rootDir, 'ledger.db');
  createSessionLedgerDb(ledgerDb);
  const archiveDir = path.join(rootDir, 'data', 'follow-up-jobs', 'stopped-archived', '2026-05');
  mkdirSync(archiveDir, { recursive: true });
  writeFileSync(path.join(archiveDir, 'job-archive.json'), JSON.stringify({
    repo: 'laceyenterprises/agent-os',
    prNumber: 46,
    jobId: 'job-archive',
    status: 'stopped',
    stoppedAt: '2026-05-18T01:02:00.000Z',
    workspaceDir: '/tmp/review-workspace',
    remediationPlan: { currentRound: 2 },
    remediationWorker: {
      model: 'codex',
      state: 'stopped',
      spawnedAt: '2026-05-18T01:00:00.000Z',
      workerRunId: 'wr_1',
      workspaceDir: '/tmp/review-workspace',
    },
  }), 'utf8');

  const result = backfillReviewerPasses(rootDir, { ledgerTarget: { backend: 'sqlite', path: ledgerDb }, dryRun: true });

  assert.equal(result.considered, 1);
  assert.equal(result.wouldInsertOrUpdate, 1);
  assert.equal(result.uniquePassKeys, 1);
  assert.equal(result.insertedOrUpdated, 0);
  assert.equal(result.tokenMatched, 1);
  assert.equal(countReviewerPasses(rootDir), 0);
});

test('codex transcript fallback links token counts by workspace cwd and launch window', () => {
  const rootDir = tempRoot();
  const workspace = path.join(rootDir, 'follow-up-workspaces', 'job-transcript');
  const codexRoot = path.join(rootDir, 'codex-sessions');
  const codexDayDir = path.join(codexRoot, '2026', '05', '18');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(codexDayDir, { recursive: true });
  const transcriptPath = path.join(codexDayDir, 'rollout-2026-05-18T04-00-10-session-1.jsonl');
  writeFileSync(transcriptPath, [
    JSON.stringify({
      timestamp: '2026-05-18T04:00:10.000Z',
      type: 'session_meta',
      payload: {
        id: 'codex-session-1',
        timestamp: '2026-05-18T04:00:10.000Z',
        cwd: workspace,
      },
    }),
    JSON.stringify({
      timestamp: '2026-05-18T04:01:10.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 321,
            cached_input_tokens: 123,
            output_tokens: 45,
            reasoning_output_tokens: 7,
            total_tokens: 366,
          },
        },
      },
    }),
    '',
  ].join('\n'), 'utf8');

  const usage = readCodexTranscriptTokenUsage({
    workspacePath: workspace,
    startedAt: '2026-05-18T04:00:00.000Z',
    endedAt: '2026-05-18T04:02:00.000Z',
    sessionRoots: [codexRoot],
    rootDir,
  });
  assert.equal(usage.input, 321);
  assert.equal(usage.output, 45);
  assert.equal(usage.cacheRead, 123);
  assert.equal(usage.source, 'codex-transcript');
  assert.equal(usage.adapterSessionKey, 'codex-session-1');

  const completedDir = path.join(rootDir, 'data', 'follow-up-jobs', 'completed');
  mkdirSync(completedDir, { recursive: true });
  writeFileSync(path.join(completedDir, 'job-transcript.json'), JSON.stringify({
    repo: 'laceyenterprises/agent-os',
    prNumber: 47,
    jobId: 'job-transcript',
    status: 'completed',
    completedAt: '2026-05-18T04:02:00.000Z',
    remediationPlan: {
      currentRound: 3,
      rounds: [{
        round: 3,
        finishedAt: '2026-05-18T04:02:00.000Z',
        worker: {
          model: 'gpt-5.2',
          spawnedAt: '2026-05-18T04:00:00.000Z',
          workspaceDir: workspace,
        },
      }],
    },
  }), 'utf8');

  const result = backfillReviewerPasses(rootDir, {
    codexSessionRoots: [codexRoot],
    transcriptFallback: true,
  });

  assert.equal(result.considered, 1);
  assert.equal(result.tokenMatched, 1);
  assert.equal(result.transcriptMatched, 1);
  const db = openReviewStateDb(rootDir);
  try {
    ensureReviewStateSchema(db);
    const row = db.prepare('SELECT * FROM reviewer_passes WHERE pr_number = 47').get();
    const metadata = JSON.parse(row.metadata_json);
    assert.equal(row.attempt_number, 3);
    assert.equal(row.reviewer_model, 'gpt-5.2');
    assert.equal(row.token_input, 321);
    assert.equal(row.token_output, 45);
    assert.equal(row.token_cache_read, 123);
    assert.equal(row.token_total, 366);
    assert.equal(row.token_source, 'codex-transcript');
    assert.equal(metadata.transcriptSessionId, 'codex-session-1');
    assert.equal(metadata.transcriptPath, transcriptPath);
  } finally {
    db.close();
  }
});

test('claude transcript fallback links input output and cache token counts', () => {
  const rootDir = tempRoot();
  const workspace = path.join(rootDir, 'follow-up-workspaces', 'job-claude-transcript');
  const claudeRoot = path.join(rootDir, 'claude-projects');
  const projectDir = path.join(claudeRoot, '-tmp-job-claude-transcript');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  const transcriptPath = path.join(projectDir, 'claude-session-1.jsonl');
  writeFileSync(transcriptPath, [
    JSON.stringify({
      type: 'user',
      timestamp: '2026-05-18T05:00:00.000Z',
      cwd: workspace,
      sessionId: 'claude-session-1',
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-05-18T05:01:00.000Z',
      cwd: workspace,
      sessionId: 'claude-session-1',
      message: {
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 20,
          cache_read_input_tokens: 30,
          output_tokens: 40,
        },
      },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-05-18T05:02:00.000Z',
      cwd: workspace,
      sessionId: 'claude-session-1',
      message: {
        usage: {
          input_tokens: 1,
          cache_creation_input_tokens: 2,
          cache_read_input_tokens: 3,
          output_tokens: 4,
        },
      },
    }),
    '',
  ].join('\n'), 'utf8');

  const direct = readClaudeTranscriptTokenUsage({
    workspacePath: workspace,
    startedAt: '2026-05-18T05:00:00.000Z',
    endedAt: '2026-05-18T05:03:00.000Z',
    sessionRoots: [claudeRoot],
    rootDir,
  });
  assert.equal(direct.input, 11);
  assert.equal(direct.output, 44);
  assert.equal(direct.cacheRead, 33);
  assert.equal(direct.cacheWrite, 22);
  assert.equal(direct.total, 110);
  assert.equal(direct.source, 'claude-transcript');

  const preferred = readBestReviewerEvidenceTokenUsage({
    workspacePath: workspace,
    startedAt: '2026-05-18T05:00:00.000Z',
    endedAt: '2026-05-18T05:03:00.000Z',
    reviewerModel: 'claude-code',
    claudeSessionRoots: [claudeRoot],
    codexSessionRoots: [],
    rootDir,
  });
  assert.equal(preferred.source, 'claude-transcript');
  assert.equal(preferred.cacheRead, 33);

  const completedDir = path.join(rootDir, 'data', 'follow-up-jobs', 'completed');
  mkdirSync(completedDir, { recursive: true });
  writeFileSync(path.join(completedDir, 'job-claude-transcript.json'), JSON.stringify({
    repo: 'laceyenterprises/agent-os',
    prNumber: 49,
    jobId: 'job-claude-transcript',
    status: 'completed',
    completedAt: '2026-05-18T05:03:00.000Z',
    remediationPlan: {
      currentRound: 1,
      rounds: [{
        round: 1,
        worker: {
          model: 'claude-code',
          spawnedAt: '2026-05-18T05:00:00.000Z',
          workspaceDir: workspace,
        },
      }],
    },
  }), 'utf8');

  const result = backfillReviewerPasses(rootDir, {
    claudeSessionRoots: [claudeRoot],
    transcriptFallback: true,
  });

  assert.equal(result.tokenMatched, 1);
  assert.equal(result.claudeTranscriptMatched, 1);
  const db = openReviewStateDb(rootDir);
  try {
    ensureReviewStateSchema(db);
    const row = db.prepare('SELECT * FROM reviewer_passes WHERE pr_number = 49').get();
    const metadata = JSON.parse(row.metadata_json);
    assert.equal(row.reviewer_model, 'claude-code');
    assert.equal(row.token_input, 11);
    assert.equal(row.token_output, 44);
    assert.equal(row.token_cache_read, 33);
    assert.equal(row.token_cache_write, 22);
    assert.equal(row.token_total, 110);
    assert.equal(row.token_source, 'claude-transcript');
    assert.equal(metadata.transcriptSessionId, 'claude-session-1');
    assert.equal(metadata.transcriptPath, transcriptPath);
  } finally {
    db.close();
  }
});

test('claude transcript fallback aggregates split files for one logical workspace session', () => {
  const rootDir = tempRoot();
  const claudeRoot = path.join(rootDir, 'claude-sessions');
  const workspace = path.join(rootDir, 'follow-up-workspaces', 'job-rereview-split-session');
  const projectDir = path.join(claudeRoot, '-tmp-job-rereview-split-session');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(projectDir, { recursive: true });

  const firstSegmentPath = path.join(projectDir, 'claude-session-part-1.jsonl');
  writeFileSync(firstSegmentPath, [
    JSON.stringify({
      type: 'user',
      timestamp: '2026-06-04T10:00:00.000Z',
      cwd: workspace,
      sessionId: 'claude-reviewer',
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-06-04T10:01:00.000Z',
      cwd: workspace,
      sessionId: 'claude-reviewer',
      message: { usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 1, cache_read_input_tokens: 2 } },
    }),
    '',
  ].join('\n'), 'utf8');

  const secondSegmentPath = path.join(projectDir, 'claude-session-part-2.jsonl');
  writeFileSync(secondSegmentPath, [
    JSON.stringify({
      type: 'user',
      timestamp: '2026-06-04T11:00:00.000Z',
      cwd: workspace,
      sessionId: 'claude-reviewer',
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-06-04T11:02:00.000Z',
      cwd: workspace,
      sessionId: 'claude-reviewer',
      message: { usage: { input_tokens: 100, output_tokens: 200, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 } },
    }),
    '',
  ].join('\n'), 'utf8');

  const usage = readClaudeTranscriptTokenUsage({
    workspacePath: workspace,
    startedAt: '2026-06-04T09:30:00.000Z',
    endedAt: '2026-06-04T12:00:00.000Z',
    sessionRoots: [claudeRoot],
    rootDir,
  });

  assert.ok(usage, 'expected grouped workspace-only session to return a usage record, got null');
  assert.equal(usage.source, 'claude-transcript');
  assert.equal(usage.adapterSessionKey, 'claude-reviewer');
  assert.equal(usage.transcriptPath, secondSegmentPath);
  assert.equal(usage.input, 110);
  assert.equal(usage.output, 220);
  assert.equal(usage.cacheRead, 6);
  assert.equal(usage.cacheWrite, 4);
  assert.equal(usage.total, 340);
});

test('claude transcript fallback prefers a session-key match over a workspace-only match', () => {
  const rootDir = tempRoot();
  const claudeRoot = path.join(rootDir, 'claude-sessions');
  const workspace = path.join(rootDir, 'follow-up-workspaces', 'job-rereview-keymatch');
  const projectDir = path.join(claudeRoot, '-tmp-job-rereview-keymatch');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(projectDir, { recursive: true });

  // Workspace-only match — newer, but NOT the reviewer's session
  const workspaceOnlyPath = path.join(projectDir, 'claude-stranger.jsonl');
  writeFileSync(workspaceOnlyPath, [
    JSON.stringify({
      type: 'user',
      timestamp: '2026-06-04T11:00:00.000Z',
      cwd: workspace,
      sessionId: 'claude-stranger',
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-06-04T11:02:00.000Z',
      cwd: workspace,
      sessionId: 'claude-stranger',
      message: { usage: { input_tokens: 9999, output_tokens: 9999, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
    }),
    '',
  ].join('\n'), 'utf8');

  // Session-key match — older, but is the reviewer's actual session
  const sessionKeyPath = path.join(projectDir, 'claude-reviewer.jsonl');
  writeFileSync(sessionKeyPath, [
    JSON.stringify({
      type: 'user',
      timestamp: '2026-06-04T10:00:00.000Z',
      cwd: workspace,
      sessionId: 'claude-reviewer',
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-06-04T10:01:00.000Z',
      cwd: workspace,
      sessionId: 'claude-reviewer',
      message: { usage: { input_tokens: 7, output_tokens: 11, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
    }),
    '',
  ].join('\n'), 'utf8');

  const usage = readClaudeTranscriptTokenUsage({
    sessionKeys: ['claude-reviewer'],
    workspacePath: workspace,
    startedAt: '2026-06-04T09:30:00.000Z',
    endedAt: '2026-06-04T12:00:00.000Z',
    sessionRoots: [claudeRoot],
    rootDir,
  });

  assert.ok(usage, 'expected a usage record');
  assert.equal(usage.adapterSessionKey, 'claude-reviewer', 'should prefer session-key match over workspace-only match');
  assert.equal(usage.input, 7);
  assert.equal(usage.output, 11);
});

test('claude transcript fallback returns null for same-session files that extend beyond the requested pass window', () => {
  const rootDir = tempRoot();
  const claudeRoot = path.join(rootDir, 'claude-sessions');
  const workspace = path.join(rootDir, 'follow-up-workspaces', 'job-rereview-adjacent-session');
  const projectDir = path.join(claudeRoot, '-tmp-job-rereview-adjacent-session');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(projectDir, { recursive: true });

  const inWindowPath = path.join(projectDir, 'claude-session-pass-1.jsonl');
  writeFileSync(inWindowPath, [
    JSON.stringify({
      type: 'user',
      timestamp: '2026-06-04T10:00:00.000Z',
      cwd: workspace,
      sessionId: 'claude-reviewer',
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-06-04T10:02:00.000Z',
      cwd: workspace,
      sessionId: 'claude-reviewer',
      message: { usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 1, cache_read_input_tokens: 2 } },
    }),
    '',
  ].join('\n'), 'utf8');

  const graceWindowSiblingPath = path.join(projectDir, 'claude-session-pass-2.jsonl');
  writeFileSync(graceWindowSiblingPath, [
    JSON.stringify({
      type: 'user',
      timestamp: '2026-06-04T10:12:00.000Z',
      cwd: workspace,
      sessionId: 'claude-reviewer',
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-06-04T10:13:00.000Z',
      cwd: workspace,
      sessionId: 'claude-reviewer',
      message: { usage: { input_tokens: 100, output_tokens: 200, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 } },
    }),
    '',
  ].join('\n'), 'utf8');

  const usage = readClaudeTranscriptTokenUsage({
    sessionKeys: ['claude-reviewer'],
    workspacePath: workspace,
    startedAt: '2026-06-04T09:58:00.000Z',
    endedAt: '2026-06-04T10:05:00.000Z',
    sessionRoots: [claudeRoot],
    rootDir,
  });

  assert.equal(usage, null);
  assert.ok(inWindowPath);
  assert.ok(graceWindowSiblingPath);
});

test('claude transcript fallback returns null for same-session files from another workspace', () => {
  const rootDir = tempRoot();
  const claudeRoot = path.join(rootDir, 'claude-sessions');
  const workspace = path.join(rootDir, 'follow-up-workspaces', 'job-rereview-session-key-workspace');
  const otherWorkspace = path.join(rootDir, 'follow-up-workspaces', 'job-rereview-session-key-other-workspace');
  const projectDir = path.join(claudeRoot, '-tmp-job-rereview-session-key-workspace');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(otherWorkspace, { recursive: true });
  mkdirSync(projectDir, { recursive: true });

  const requestedWorkspacePath = path.join(projectDir, 'claude-session-requested-workspace.jsonl');
  writeFileSync(requestedWorkspacePath, [
    JSON.stringify({
      type: 'user',
      timestamp: '2026-06-04T10:00:00.000Z',
      cwd: workspace,
      sessionId: 'claude-reviewer',
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-06-04T10:01:00.000Z',
      cwd: workspace,
      sessionId: 'claude-reviewer',
      message: { usage: { input_tokens: 7, output_tokens: 11, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
    }),
    '',
  ].join('\n'), 'utf8');

  const otherWorkspacePath = path.join(projectDir, 'claude-session-other-workspace.jsonl');
  writeFileSync(otherWorkspacePath, [
    JSON.stringify({
      type: 'user',
      timestamp: '2026-06-04T10:02:00.000Z',
      cwd: otherWorkspace,
      sessionId: 'claude-reviewer',
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-06-04T10:03:00.000Z',
      cwd: otherWorkspace,
      sessionId: 'claude-reviewer',
      message: { usage: { input_tokens: 70, output_tokens: 110, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
    }),
    '',
  ].join('\n'), 'utf8');

  const usage = readClaudeTranscriptTokenUsage({
    sessionKeys: ['claude-reviewer'],
    workspacePath: workspace,
    startedAt: '2026-06-04T09:58:00.000Z',
    endedAt: '2026-06-04T10:05:00.000Z',
    sessionRoots: [claudeRoot],
    rootDir,
  });

  assert.equal(usage, null);
  assert.ok(requestedWorkspacePath);
  assert.ok(otherWorkspacePath);
});

test('claude transcript fallback returns null for ambiguous workspace-only matches', () => {
  const rootDir = tempRoot();
  const claudeRoot = path.join(rootDir, 'claude-sessions');
  const workspace = path.join(rootDir, 'follow-up-workspaces', 'job-rereview-ambiguous-workspace');
  const projectDir = path.join(claudeRoot, '-tmp-job-rereview-ambiguous-workspace');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(projectDir, { recursive: true });

  const olderPath = path.join(projectDir, 'claude-older.jsonl');
  writeFileSync(olderPath, [
    JSON.stringify({
      type: 'user',
      timestamp: '2026-06-04T10:00:00.000Z',
      cwd: workspace,
      sessionId: 'claude-older',
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-06-04T10:01:00.000Z',
      cwd: workspace,
      sessionId: 'claude-older',
      message: { usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
    }),
    '',
  ].join('\n'), 'utf8');

  const newerPath = path.join(projectDir, 'claude-newer.jsonl');
  writeFileSync(newerPath, [
    JSON.stringify({
      type: 'user',
      timestamp: '2026-06-04T11:00:00.000Z',
      cwd: workspace,
      sessionId: 'claude-newer',
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-06-04T11:02:00.000Z',
      cwd: workspace,
      sessionId: 'claude-newer',
      message: { usage: { input_tokens: 100, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
    }),
    '',
  ].join('\n'), 'utf8');

  const usage = readClaudeTranscriptTokenUsage({
    workspacePath: workspace,
    startedAt: '2026-06-04T09:30:00.000Z',
    endedAt: '2026-06-04T12:00:00.000Z',
    sessionRoots: [claudeRoot],
    rootDir,
  });

  assert.equal(usage, null);
  assert.ok(olderPath);
  assert.ok(newerPath);
});

test('claude transcript fallback returns null when no transcripts match', () => {
  const rootDir = tempRoot();
  const claudeRoot = path.join(rootDir, 'claude-sessions');
  const workspace = path.join(rootDir, 'follow-up-workspaces', 'job-no-match');
  const otherWorkspace = path.join(rootDir, 'follow-up-workspaces', 'job-other');
  const projectDir = path.join(claudeRoot, '-tmp-other');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(otherWorkspace, { recursive: true });
  mkdirSync(projectDir, { recursive: true });

  const transcriptPath = path.join(projectDir, 'claude-other.jsonl');
  writeFileSync(transcriptPath, [
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-06-04T10:01:00.000Z',
      cwd: otherWorkspace,
      sessionId: 'claude-other',
      message: { usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
    }),
    '',
  ].join('\n'), 'utf8');

  const usage = readClaudeTranscriptTokenUsage({
    workspacePath: workspace,
    sessionKeys: ['unknown-session'],
    startedAt: '2026-06-04T09:30:00.000Z',
    endedAt: '2026-06-04T12:00:00.000Z',
    sessionRoots: [claudeRoot],
    rootDir,
  });

  assert.equal(usage, null);
});

test('backfill recovers codex exec token total and session id from worker log', () => {
  const rootDir = tempRoot();
  const workspace = path.join(rootDir, 'follow-up-workspaces', 'job-worker-log');
  const logPath = path.join(workspace, '.adversarial-follow-up', 'codex-worker.log');
  mkdirSync(path.dirname(logPath), { recursive: true });
  writeFileSync(logPath, [
    'OpenAI Codex v0.130.0',
    'workdir: /tmp/example',
    'session id: 019e3ebb-58d0-7061-ab5b-b690cf4df3af',
    JSON.stringify({
      type: 'turn.completed',
      usage: {
        input_tokens: 1000,
        cached_input_tokens: 400,
        output_tokens: 25,
        total_tokens: 1025,
      },
    }),
    'tokens used',
    '287,605',
    '',
  ].join('\n'), 'utf8');
  const completedDir = path.join(rootDir, 'data', 'follow-up-jobs', 'completed');
  mkdirSync(completedDir, { recursive: true });
  writeFileSync(path.join(completedDir, 'job-worker-log.json'), JSON.stringify({
    repo: 'laceyenterprises/agent-os',
    prNumber: 48,
    jobId: 'job-worker-log',
    status: 'completed',
    completedAt: '2026-05-18T04:02:00.000Z',
    workspaceDir: workspace,
    remediationPlan: {
      currentRound: 1,
      rounds: [{
        round: 1,
        worker: {
          model: 'codex',
          spawnedAt: '2026-05-18T04:00:00.000Z',
          workspaceDir: workspace,
          logPath,
        },
      }],
    },
  }), 'utf8');

  const result = backfillReviewerPasses(rootDir);

  assert.equal(result.considered, 1);
  assert.equal(result.tokenMatched, 1);
  assert.equal(result.workerLogMatched, 1);
  const db = openReviewStateDb(rootDir);
  try {
    ensureReviewStateSchema(db);
    const row = db.prepare('SELECT * FROM reviewer_passes WHERE pr_number = 48').get();
    const metadata = JSON.parse(row.metadata_json);
    assert.equal(row.token_input, 1000);
    assert.equal(row.token_output, 25);
    assert.equal(row.token_cache_read, 400);
    assert.equal(row.token_total, 1025);
    assert.equal(row.token_source, 'codex-worker-log');
    assert.equal(metadata.transcriptSessionId, '019e3ebb-58d0-7061-ab5b-b690cf4df3af');
    assert.equal(metadata.workerLogPath, logPath);
  } finally {
    db.close();
  }
});

test('codex transcript fallback reads turn.completed token usage', () => {
  const rootDir = tempRoot();
  const workspace = path.join(rootDir, 'follow-up-workspaces', 'job-codex-transcript-turn');
  const codexRoot = path.join(rootDir, 'codex-sessions');
  const transcriptPath = path.join(codexRoot, '2026', '05', '18', 'rollout.jsonl');
  mkdirSync(path.dirname(transcriptPath), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(transcriptPath, [
    JSON.stringify({
      type: 'session_meta',
      timestamp: '2026-05-18T06:00:00.000Z',
      payload: {
        id: 'codex-session-turn',
        cwd: workspace,
      },
    }),
    JSON.stringify({
      type: 'turn.completed',
      timestamp: '2026-05-18T06:03:00.000Z',
      usage: {
        input_tokens: 222,
        cached_input_tokens: 111,
        output_tokens: 33,
        total_tokens: 255,
      },
    }),
    '',
  ].join('\n'), 'utf8');

  const usage = readCodexTranscriptTokenUsage({
    workspacePath: workspace,
    startedAt: '2026-05-18T05:59:00.000Z',
    endedAt: '2026-05-18T06:05:00.000Z',
    sessionRoots: [codexRoot],
  });

  assert.equal(usage.input, 222);
  assert.equal(usage.output, 33);
  assert.equal(usage.cacheRead, 111);
  assert.equal(usage.total, 255);
  assert.equal(usage.source, 'codex-transcript');
  assert.equal(usage.adapterSessionKey, 'codex-session-turn');
  assert.equal(usage.transcriptPath, transcriptPath);
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

test('tokens CLI groups --by-reviewer by raw reviewer model when available', () => {
  const rootDir = tempRoot();
  beginReviewerPass(rootDir, {
    repo: 'laceyenterprises/agent-os',
    prNumber: 45,
    attemptNumber: 1,
    reviewerClass: 'claude-sonnet',
    passKind: 'first-pass',
    startedAt: '2026-05-18T00:00:00.000Z',
  });
  completeReviewerPass(rootDir, {
    repo: 'laceyenterprises/agent-os',
    prNumber: 45,
    attemptNumber: 1,
    passKind: 'first-pass',
    status: 'completed',
    tokenUsage: { input: 5, output: 7, source: 'session-ledger' },
  });
  const out = { value: '', write(chunk) { this.value += chunk; } };
  const err = { value: '', write(chunk) { this.value += chunk; } };
  const code = tokensMain(['--root-dir', rootDir, '--by-reviewer'], { stdout: out, stderr: err });

  assert.equal(code, 0);
  assert.match(out.value, /claude-sonnet/);
  assert.doesNotMatch(out.value, /^claude\s/m);
});
