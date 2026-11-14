import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import os, { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureReviewStateSchema } from '../src/review-state.mjs';
import { reapRunningPassTimeouts } from '../src/reviewer-pass-reaper.mjs';
import { ensureDuplicateFamilySchema, upsertDuplicateFamilies } from '../src/duplicate-family-state.mjs';
import { duplicateFamilyWorkflowMain } from '../src/duplicate-family-workflow-cli.mjs';
import { ensureTtmTrackerSchema, syncTtmFlags } from '../src/ttm-tracker.mjs';
import { recordLiveShadow } from '../src/finalization/live-shadow.mjs';
import { openFinalizationShadowStore } from '../src/finalization/shadow-store.mjs';

const at = '2026-01-01T00:00:00.000Z';
const repo = 'example/repo';

function fixture(t) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(at) });
  const rootDir = mkdtempSync(join(tmpdir(), 'immediate-store-'));
  const file = join(rootDir, 'synthetic.db');
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE writer_probe (value INTEGER); INSERT INTO writer_probe VALUES (0)');
  const writer = new Database(file, { timeout: 0 });
  const closeDb = db.close.bind(db);
  t.after(() => {
    writer.close();
    if (db.open) closeDb();
    rmSync(rootDir, { recursive: true, force: true });
  });
  return { rootDir, db, writer };
}

// Inject a competing write just AFTER the real first SELECT establishes its
// snapshot. No scheduling, sleeps, worker load, or production data is involved.
// A deferred transaction lets this writer commit and then fails its own write
// with SQLITE_BUSY_SNAPSHOT. An immediate transaction excludes the writer.
function contendAfterRead(db, writer, pattern) {
  const prepare = db.prepare.bind(db);
  let attempts = 0;
  let blocked = 0;
  db.prepare = sql => {
    const statement = prepare(sql);
    if (!pattern.test(sql)) return statement;
    for (const method of ['get', 'all']) {
      const read = statement[method].bind(statement);
      statement[method] = (...args) => {
        const result = read(...args);
        if (db.inTransaction && attempts === 0) {
          attempts += 1;
          try {
            writer.prepare('UPDATE writer_probe SET value = value + 1').run();
          } catch (error) {
            assert.equal(error.code, 'SQLITE_BUSY');
            blocked += 1;
          }
        }
        return result;
      };
    }
    return statement;
  };
  return () => {
    assert.equal(attempts, 1, 'competing writer ran after the transaction read');
    assert.equal(blocked, 1, 'transaction reserved the writer before reading');
    assert.equal(writer.prepare('SELECT value FROM writer_probe').get().value, 0);
    writer.prepare('UPDATE writer_probe SET value = value + 1').run();
    assert.equal(writer.prepare('SELECT value FROM writer_probe').get().value, 1,
      'writer reservation was released after commit');
  };
}

function family() {
  return {
    familyId: 'synthetic-family', familyKey: 'synthetic-key',
    targetRepo: repo, baseBranch: 'main', normalizedWorkIdentity: 'synthetic-work',
    strongestSignal: 'dispatch-ticket',
    candidates: [1, 2].map(prNumber => ({
      repoPath: repo, prNumber, title: `Synthetic work ${prNumber}`,
      prState: 'open', baseBranch: 'main', headBranch: `work-${prNumber}`,
      headSha: `head-${prNumber}`, baseSha: 'base', workIdentity: {},
    })),
  };
}

test('posted artifact settlement reserves the writer before reading its claim', t => {
  const { db, writer, rootDir } = fixture(t);
  ensureReviewStateSchema(db);
  db.prepare(`INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer,
    review_status, reviewer_session_uuid, reviewer_started_at, reviewer_head_sha)
    VALUES (?, 1, ?, 'claude', 'reviewing', 'synthetic-session', ?, 'head-1')`)
    .run(repo, at, at);
  db.prepare(`INSERT INTO reviewer_passes (repo, pr_number, attempt_number,
    reviewer_class, reviewer_model, pass_kind, started_at, status, head_sha,
    gh_comment_id, body_captured_at, metadata_json)
    VALUES (?, 1, 1, 'claude', 'claude', 'first-pass', ?, 'running', 'head-1',
      'synthetic-artifact', ?, '{"reviewerSessionUuid":"synthetic-session"}')`).run(repo, at, at);
  const verify = contendAfterRead(db, writer, /SELECT review_status, reviewer_session_uuid/);
  const errors = [];
  reapRunningPassTimeouts({ db, rootDir, now: () => new Date(),
    log: { log() {}, warn() {}, error: message => errors.push(message) },
    queueFollowUpForRecoveredPostedReviewImpl: () => ({ queued: false }),
    recordReviewLatencyEventImpl: () => {} });
  assert.deepEqual(errors, []);
  assert.equal(db.prepare('SELECT review_status FROM reviewed_prs').get().review_status, 'posted');
  assert.equal(db.prepare('SELECT status FROM reviewer_passes').get().status, 'completed');
  verify();
});

for (const infraAttempts of [0, 3]) {
  test(`timed-out pass settlement reserves the writer before reading its claim (${infraAttempts} recoveries)`, t => {
    const { db, writer, rootDir } = fixture(t);
    t.mock.method(os, 'loadavg', () => [0, 0, 0]);
    ensureReviewStateSchema(db);
    db.prepare(`INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer,
      review_status, reviewer_session_uuid, reviewer_started_at, reviewer_head_sha,
      infra_auto_recover_attempts)
      VALUES (?, 1, ?, 'claude', 'reviewing', 'synthetic-session', ?, 'head-1', ?)`)
      .run(repo, at, at, infraAttempts);
    db.prepare(`INSERT INTO reviewer_passes (repo, pr_number, attempt_number,
      reviewer_class, reviewer_model, pass_kind, started_at, status, head_sha, metadata_json)
      VALUES (?, 1, 1, 'claude', 'claude', 'first-pass', ?, 'running', 'head-1',
        '{"reviewerSessionUuid":"synthetic-session"}')`).run(repo, at);
    const verify = contendAfterRead(db, writer, /SELECT review_status, reviewer_session_uuid/);
    const errors = [];
    const result = reapRunningPassTimeouts({ db, rootDir,
      now: () => new Date('2026-01-01T02:00:00.000Z'),
      isReviewerAlive: () => false,
      log: { log() {}, warn() {}, error: (...args) => errors.push(args) },
      recordReviewLatencyEventImpl: () => {} });
    assert.deepEqual(errors, []);
    assert.equal(result.reaped, 1);
    assert.equal(result.reviewClaimsReleased, infraAttempts === 0 ? 1 : 0);
    assert.equal(result.reviewClaimsFailed, infraAttempts === 3 ? 1 : 0);
    assert.equal(db.prepare('SELECT review_status FROM reviewed_prs').get().review_status,
      infraAttempts === 0 ? 'pending-upstream' : 'failed');
    assert.equal(db.prepare('SELECT status FROM reviewer_passes').get().status, 'failed');
    verify();
  });
}

test('duplicate family upsert reserves the writer before reading existing state', t => {
  const { db, writer } = fixture(t);
  ensureDuplicateFamilySchema(db);
  const verify = contendAfterRead(db, writer, /SELECT \* FROM duplicate_families WHERE family_key/);
  assert.deepEqual(upsertDuplicateFamilies(db, [family()], { now: at }), ['synthetic-family']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM duplicate_family_candidates').get().n, 2);
  verify();
});

test('selection audit confirmation reserves the writer before reading the selection', async t => {
  const { db, writer } = fixture(t);
  upsertDuplicateFamilies(db, [family()], { now: at });
  db.prepare('UPDATE duplicate_families SET content_evidence_json = ?').run(JSON.stringify({
    pairs: [{ corroborated: true, members: [1, 2].map(prNumber => ({ prNumber, headSha: `head-${prNumber}` })) }],
  }));
  const verify = contendAfterRead(db, writer, /SELECT status, operator_override_json FROM duplicate_families/);
  db.close = () => {};
  const errors = [];
  const code = await duplicateFamilyWorkflowMain([
    'select', 'synthetic-family', '--survivor', '1',
    '--report', 'docs/research/duplicate-pr-divergence/reports/synthetic.md',
    '--reason', 'synthetic choice', '--salvage', 'synthetic salvage',
    '--validation', 'synthetic validation', '--actor', 'synthetic-actor',
  ], {
    openReviewStateDbImpl: () => db, stdout: { write() {} },
    stderr: { write: message => errors.push(message) },
    execFileImpl: async (_command, args) => {
      if (args[0] === 'pr' && args[1] === 'view') return { stdout: JSON.stringify({ headRefOid: 'head-1' }) };
      if (args[0] === 'api') return { stdout: JSON.stringify({ type: 'file', sha: 'synthetic-blob' }) };
      if (args[0] === 'pr' && args[1] === 'comment') return { stdout: '' };
      throw new Error(`unexpected command: ${args.join(' ')}`);
    },
    sleepImpl: async () => { throw new Error('unexpected retry'); },
  });
  assert.equal(code, 0, errors.join('\n'));
  const override = JSON.parse(db.prepare('SELECT operator_override_json FROM duplicate_families').get().operator_override_json);
  assert.equal(override.selection.auditPending, false);
  verify();
});

test('TTM flag synchronization reserves the writer before reading flag state', t => {
  const { db, writer } = fixture(t);
  ensureTtmTrackerSchema(db);
  const verify = contendAfterRead(db, writer, /SELECT state FROM ttm_flag_state/);
  const result = syncTtmFlags(db, [{
    eventKey: 'synthetic-flag', repo, prNumber: 1, flagKind: 'terminal-but-unmerged',
    openedAt: at, settledAt: at, mergedAt: null, elapsedMinutes: 10,
    budgetMinutes: 5, terminalUnmergedMinutes: 10, reviewRounds: 1, details: {},
  }], { observedAt: at });
  assert.equal(result.activated, 1);
  assert.equal(db.prepare('SELECT state FROM ttm_flag_state').get().state, 'active');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ttm_flag_events').get().n, 1);
  verify();
});

test('live shadow recording reserves the writer before reading the ledger', t => {
  const { db, writer } = fixture(t);
  const shadowStore = openFinalizationShadowStore({ db });
  const verify = contendAfterRead(db, writer, /SELECT \* FROM finalization_ledger/);
  const observation = recordLiveShadow({
    shadowStore, repo, prNumber: 1, source: 'synthetic',
    snapshot: { subjectKey: `${repo}#1`, head: 'head-1', observedAt: at, observations: {} },
    legacy: { action: 'wait', reason: 'synthetic' },
  });
  assert.ok(observation.id);
  assert.equal(shadowStore.read().length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM finalization_ledger').get().n, 1);
  verify();
});
