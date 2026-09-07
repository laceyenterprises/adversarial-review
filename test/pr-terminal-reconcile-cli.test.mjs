import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import { main, parseArgs } from '../src/pr-terminal-reconcile-cli.mjs';
import { readPrTerminalReconcileState } from '../src/pr-terminal-reconcile.mjs';

// TREC-01 item 3: the operator-facing drain. These exercise the real CLI
// against a real SQLite ledger, with only the GitHub call injected.

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'trec01-cli-'));
}

function seedLedger(rootDir, rows) {
  mkdirSync(join(rootDir, 'data'), { recursive: true });
  const db = new Database(join(rootDir, 'data', 'reviews.db'));
  db.exec(`
    CREATE TABLE reviewed_prs (
      id INTEGER PRIMARY KEY,
      repo TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      pr_state TEXT NOT NULL DEFAULT 'open',
      merged_at TEXT,
      closed_at TEXT
    );
  `);
  const insert = db.prepare('INSERT INTO reviewed_prs (repo, pr_number) VALUES (?, ?)');
  for (const row of rows) insert.run(row.repo, row.prNumber);
  return db;
}

function collectingIo(db, live) {
  const out = [];
  const err = [];
  return {
    io: {
      db,
      stdout: { write: (chunk) => out.push(chunk) },
      stderr: { write: (chunk) => err.push(chunk) },
      fetchLiveState: async (repo, prNumber) => {
        const entry = live[prNumber];
        if (entry instanceof Error) throw entry;
        return entry;
      },
    },
    out,
    err,
  };
}

const ROWS = [
  { repo: 'laceyenterprises/agent-os', prNumber: 6364 },
  { repo: 'laceyenterprises/agent-os', prNumber: 6394 },
  { repo: 'laceyenterprises/agent-os', prNumber: 6393 },
];
const LIVE = {
  6364: { state: 'MERGED', mergedAt: '2026-09-07T05:10:03Z', closedAt: '2026-09-07T05:10:03Z' },
  6394: { state: 'CLOSED', mergedAt: null, closedAt: '2026-09-07T05:50:15Z' },
  6393: { state: 'OPEN', mergedAt: null, closedAt: null },
};

test('parseArgs rejects a non-positive cap instead of sweeping everything', () => {
  assert.throws(() => parseArgs(['--cap', '0']), /--cap requires a positive integer/);
  assert.throws(() => parseArgs(['--cap', 'lots']), /--cap requires a positive integer/);
  assert.throws(() => parseArgs(['--nope']), /Unknown argument/);
  assert.equal(parseArgs(['--dry-run']).dryRun, true);
});

test('the sweep drains stale rows and leaves the genuinely open one alone', async () => {
  const rootDir = tempRoot();
  const db = seedLedger(rootDir, ROWS);
  try {
    const { io, out } = collectingIo(db, LIVE);
    const code = await main(['--root', rootDir], io);

    assert.equal(code, 0, 'a fully resolved sweep exits 0');
    const state = db.prepare('SELECT pr_number, pr_state, merged_at, closed_at FROM reviewed_prs ORDER BY pr_number').all();
    assert.deepEqual(state, [
      { pr_number: 6364, pr_state: 'merged', merged_at: '2026-09-07T05:10:03Z', closed_at: null },
      { pr_number: 6393, pr_state: 'open', merged_at: null, closed_at: null },
      { pr_number: 6394, pr_state: 'closed', merged_at: null, closed_at: '2026-09-07T05:50:15Z' },
    ]);
    assert.match(out.join(''), /merged:     1/);
    assert.match(out.join(''), /closed:     1/);

    // The attestation the health surface reads must exist after a real run.
    const attestation = readPrTerminalReconcileState(rootDir);
    assert.equal(attestation.source, 'operator-cli');
    assert.equal(attestation.merged, 1);
    assert.equal(attestation.unresolvedCount, 0);
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('--dry-run writes neither the ledger nor the attestation', async () => {
  const rootDir = tempRoot();
  const db = seedLedger(rootDir, ROWS);
  try {
    const { io, out } = collectingIo(db, LIVE);
    const code = await main(['--root', rootDir, '--dry-run'], io);

    assert.equal(code, 0);
    assert.match(out.join(''), /Would reconcile 3 open PR\(s\)/);
    const states = db.prepare('SELECT pr_state FROM reviewed_prs').all().map((r) => r.pr_state);
    assert.deepEqual(states, ['open', 'open', 'open'], 'a dry run must not mutate the ledger');
    // Critically: a dry run must NOT refresh the attestation. Doing so would
    // clear review:pr_lifecycle_mirror_unverified without having fixed anything
    // -- the operator would have silenced the finding that sent them here.
    assert.equal(
      readPrTerminalReconcileState(rootDir),
      null,
      'a dry run must not claim the mirror was verified',
    );
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('an unresolvable PR exits non-zero and is named, not silently skipped', async () => {
  const rootDir = tempRoot();
  const db = seedLedger(rootDir, ROWS);
  try {
    const { io, out } = collectingIo(db, {
      ...LIVE,
      6394: new Error('Command failed: gh api\ngh: Bad credentials (HTTP 401)'),
    });
    const code = await main(['--root', rootDir], io);

    assert.equal(code, 1, 'a partly unverified mirror must not report success');
    const text = out.join('');
    assert.match(text, /UNRESOLVED: 1/);
    assert.match(text, /agent-os#6394: .*Bad credentials \(HTTP 401\)/);
    // The other PR still reconciles — one failure must not blind the sweep.
    assert.equal(
      db.prepare('SELECT pr_state FROM reviewed_prs WHERE pr_number = 6364').get().pr_state,
      'merged',
    );
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
