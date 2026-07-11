// The AMA closer records its pass post-merge and only briefly polls the ledger
// for the hammer worker's rollup, so a slow rollup leaves the closer pass with
// null tokens — and the job-driven backfill only heals remediation. This
// reviewer_passes-driven backfill must re-read the ledger and fill null-token
// closer passes once the worker-pool capture lands the hammer tokens.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import { createSessionLedgerDb } from './helpers/session-ledger-fixtures.mjs';
import {
  beginReviewerPass,
  completeReviewerPass,
  backfillCloserReviewerPasses,
} from '../src/reviewer-pass-tokens.mjs';

const HERMETIC_CONFIG_ENV = { AGENT_OS_CONFIG_PATH: '/dev/null' };

function tempRoot() {
  return mkdtempSync(path.join(tmpdir(), 'closer-backfill-'));
}

function readPass(rootDir, repo, prNumber) {
  const db = new Database(path.join(rootDir, 'data', 'reviews.db'), { readonly: true });
  try {
    return db.prepare(
      `SELECT token_input, token_output, token_source, status FROM reviewer_passes
        WHERE repo=? AND pr_number=? AND pass_kind='closer'`
    ).get(repo, prNumber);
  } finally {
    db.close();
  }
}

function seedNullCloserPass(rootDir, { workerRunId, launchRequestId = 'lrq_1' }) {
  beginReviewerPass(rootDir, {
    repo: 'lacey/repo', prNumber: 7, attemptNumber: 1,
    reviewerClass: 'codex', reviewerModel: 'hammer', passKind: 'closer',
    workerRunId, metadata: { amaCloser: true, launchRequestId },
  });
  completeReviewerPass(rootDir, {
    repo: 'lacey/repo', prNumber: 7, attemptNumber: 1, passKind: 'closer',
    status: 'completed', workerRunId, tokenUsage: null, // rollup not ready -> null
  });
}

test('backfillCloserReviewerPasses fills a null closer pass from the ledger', () => {
  const rootDir = tempRoot();
  const hqRoot = path.join(rootDir, 'agent-os-hq');
  const realLedger = path.join(rootDir, '.agent-os', 'session-ledger', 'ledger.db');
  mkdirSync(path.dirname(realLedger), { recursive: true });
  createSessionLedgerDb(realLedger); // provides worker_run wr_1 (input=120, output=45)

  seedNullCloserPass(rootDir, { workerRunId: 'wr_1' });
  assert.equal(readPass(rootDir, 'lacey/repo', 7).token_input, null, 'starts null');

  const result = backfillCloserReviewerPasses(rootDir, {
    ledgerTarget: { backend: 'sqlite', path: realLedger },
    env: { ...HERMETIC_CONFIG_ENV, HQ_ROOT: hqRoot },
  });

  assert.equal(result.considered, 1);
  assert.equal(result.filled, 1);
  const row = readPass(rootDir, 'lacey/repo', 7);
  assert.equal(row.token_input, 120);
  assert.equal(row.token_output, 45);
  assert.equal(row.token_source, 'session-ledger');
  assert.equal(row.status, 'completed', 'existing status preserved');
});

test('backfillCloserReviewerPasses dry-run reports but writes nothing', () => {
  const rootDir = tempRoot();
  const realLedger = path.join(rootDir, '.agent-os', 'session-ledger', 'ledger.db');
  mkdirSync(path.dirname(realLedger), { recursive: true });
  createSessionLedgerDb(realLedger);
  seedNullCloserPass(rootDir, { workerRunId: 'wr_1' });

  const result = backfillCloserReviewerPasses(rootDir, {
    ledgerTarget: { backend: 'sqlite', path: realLedger },
    env: HERMETIC_CONFIG_ENV,
    dryRun: true,
  });
  assert.equal(result.filled, 1);
  assert.equal(readPass(rootDir, 'lacey/repo', 7).token_input, null, 'dry-run writes nothing');
});

test('backfillCloserReviewerPasses leaves a pass null when the ledger has no usage', () => {
  const rootDir = tempRoot();
  const realLedger = path.join(rootDir, '.agent-os', 'session-ledger', 'ledger.db');
  mkdirSync(path.dirname(realLedger), { recursive: true });
  createSessionLedgerDb(realLedger);
  seedNullCloserPass(rootDir, { workerRunId: 'wr_does_not_exist', launchRequestId: 'lrq_none' });

  const result = backfillCloserReviewerPasses(rootDir, {
    ledgerTarget: { backend: 'sqlite', path: realLedger },
    env: HERMETIC_CONFIG_ENV,
  });
  assert.equal(result.considered, 1);
  assert.equal(result.filled, 0);
  assert.equal(result.stillMissing, 1);
});
