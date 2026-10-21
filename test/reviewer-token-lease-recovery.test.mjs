import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { journalReviewerTokenLease, readReviewerTokenLeases, reconcileReviewerTokenLeases } from '../src/reviewer-token-leases.mjs';
import { selectReviewerTokenAccount, updateReviewerTokenLease } from '../src/reviewer-token-pool.mjs';
import { spawnReviewer, settleReviewerAttempt } from '../src/reviewer-spawn-settle.mjs';
import { reconcileReviewerSessions } from '../src/reviewer-reattach.mjs';
import { writeReviewerRunRecord } from '../src/adapters/reviewer-runtime/run-state.mjs';
import { ensureReviewStateSchema } from '../src/review-state.mjs';
import { shouldBackoffReviewerSpawn } from '../src/reviewer-cascade.mjs';

const receipt = { identity: 'codex-reviewer', tokenAccountId: 'openai-primary', provider: 'codex',
  brokerProvider: 'codex', pooled: true, hold: false,
  lease: { account_id: 'openai-primary', lease_id: 'lease-1', generation: 1, request_id: 'session', identity: 'codex-reviewer' } };
const quiet = { log() {}, warn() {} };
function scratch(t) {
  const root = mkdtempSync(join(tmpdir(), 'lease-recovery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function sweep(rootDir, overrides = {}) {
  return reconcileReviewerTokenLeases({ rootDir, rows: [], readRecord: () => null,
    probeAlive: () => false, findProcess: () => ({ found: false }),
    now: new Date(Date.now() + 120_000), log: quiet, ...overrides });
}

test('pre-acquire intent recovers a transport killed after broker acquisition without a run record', async t => {
  const rootDir = scratch(t);
  const wire = JSON.parse(readFileSync(new URL('fixtures/identity-token-selection.v1.json', import.meta.url))).defaults;
  const held = await selectReviewerTokenAccount({ rootDir, reviewerModel: 'codex', requestId: 'session',
    oauth: wire.oauth, model: 'gpt-6', acquire: true, log: quiet,
    ownerImpl: async () => {
      assert.equal(readReviewerTokenLeases(rootDir).length, 1, 'intent precedes broker call');
      throw new Error('transport killed after grant');
    } });
  assert.equal(held.hold, true);
  const operations = [];
  await sweep(rootDir, {
    ownerImpl: async value => { operations.push(value); return { ok: true, lease: receipt.lease }; },
    updateLease: async (value, operation) => operations.push({ value, operation }),
  });
  assert.equal(operations[0].operation, 'recover');
  assert.equal(operations[0].requestId, 'session');
  assert.equal(operations[1].operation, 'release');
  assert.deepEqual(readReviewerTokenLeases(rootDir), []);
});

test('failure before beginReviewerPass leaves a recoverable journal; no runtime starts', async t => {
  const rootDir = scratch(t);
  await assert.rejects(spawnReviewer({ rootDir, repo: 'sample/project', prNumber: 7,
    reviewerModel: 'codex', builderTag: 'claude-code', reviewerSessionUuid: 'session',
    selectReviewerTokenAccountImpl: async () => receipt,
    quotaCheckEnv: {}, readReviewerQuotaDecisionImpl: async () => ({ available: true }),
    beginReviewerPassImpl() { throw new Error('begin pass failed'); },
    reviewerRuntimeAdapterOverride: { describe: () => ({ id: 'cli-direct' }),
      spawnReviewer: () => assert.fail('must not launch') },
  }), /begin pass failed/);
  assert.equal(readReviewerTokenLeases(rootDir).length, 1);
  const operations = [];
  await sweep(rootDir, { updateLease: async (_, operation) => operations.push(operation) });
  assert.deepEqual(operations, ['release']);
  assert.deepEqual(readReviewerTokenLeases(rootDir), []);
});

for (const operation of ['renew', 'release']) test(`${operation} requires a positive transport acknowledgement`, async t => {
  const rootDir = scratch(t);
  for (const result of [{ held: 'evidence-unknown' }, null, false, {}, { ok: true, operation: 'other' }]) {
    await assert.rejects(updateReviewerTokenLease(receipt, operation, { rootDir, ownerImpl: async () => result }), /operation failed/);
  }
  if (operation === 'release') assert.equal(readReviewerTokenLeases(rootDir).length, 1);
});

test('failed release logs and survives row settlement; an empty-row reconcile retries it', async t => {
  const rootDir = scratch(t);
  const warnings = [];
  const warn = console.warn;
  console.warn = value => warnings.push(value);
  try {
    const result = await spawnReviewer({ rootDir, reviewerModel: 'codex', builderTag: 'claude-code', reviewerSessionUuid: 'session',
      selectReviewerTokenAccountImpl: async () => receipt,
      updateReviewerTokenLeaseImpl: (value, operation, options) => updateReviewerTokenLease(value, operation,
        { ...options, ownerImpl: async () => ({ held: 'evidence-unknown' }) }),
      reviewerRuntimeAdapterOverride: { describe: () => ({ id: 'unbound' }) },
    });
    assert.equal(result.failureClass, 'reviewer-account-held');
  } finally { console.warn = warn; }
  assert.ok(warnings.some(value => value.includes('release unavailable')));
  assert.equal(readReviewerTokenLeases(rootDir).length, 1);
  const db = new Database(':memory:');
  t.after(() => db.close());
  ensureReviewStateSchema(db);
  const operations = [];
  await reconcileReviewerSessions({ db, rootDir, log: quiet,
    now: new Date(Date.now() + 120_000), probeAlive: () => false,
    findReviewerProcess: () => ({ found: false }),
    updateReviewerTokenLeaseImpl: async (_, operation) => operations.push(operation) });
  assert.deepEqual(operations, ['release']);
  assert.deepEqual(readReviewerTokenLeases(rootDir), []);
});

test('all live journals renew outside row cap; corrupt records use process evidence, never expiry', async t => {
  const rootDir = scratch(t);
  const db = new Database(':memory:');
  t.after(() => db.close());
  ensureReviewStateSchema(db);
  for (let i = 0; i < 7; i++) journalReviewerTokenLease(rootDir, `session-${i}`, receipt.identity, receipt.lease, 9000 + i);
  const operations = [];
  await reconcileReviewerSessions({ db, rootDir, log: quiet, maxRows: 0,
    now: new Date(Date.now() + 120_000), probeAlive: () => true,
    updateReviewerTokenLeaseImpl: async (_, operation) => operations.push(operation) });
  assert.deepEqual(operations, Array(7).fill('renew'));
  assert.equal(readReviewerTokenLeases(rootDir).length, 7);
  await sweep(rootDir, { readRecord: () => null, probeAlive: () => false,
    findProcess: () => ({ found: null }), updateLease: () => assert.fail('unknown probe retains') });
  assert.equal(readReviewerTokenLeases(rootDir).length, 7);
});

test('unrelated declaration errors preserve legacy routing, but last-good enrollment survives restart', async t => {
  const rootDir = scratch(t);
  const warnings = [];
  const common = { rootDir, reviewerModel: 'codex', log: { warn: value => warnings.push(value) },
    ownerImpl: () => assert.fail('no broker call'),
    resolvePoolsImpl: () => { throw new Error('builder config invalid'); } };
  assert.equal(await selectReviewerTokenAccount(common), null);
  assert.ok(warnings[0].includes('routing=legacy'));
  // A successful read persists enrollment even when account evidence holds.
  await selectReviewerTokenAccount({ ...common, model: 'gpt-6',
    resolvePoolsImpl: () => ({ identity_token_pools: { 'codex-reviewer': ['openai-primary'] }, token_accounts: {} }),
    ownerImpl: async () => ({ held: 'evidence-unknown' }) });
  const result = await selectReviewerTokenAccount(common);
  assert.equal(result.reason, 'pool-configuration-unreadable');
  assert.ok(warnings[1].includes('routing=hold'));
  assert.equal(await selectReviewerTokenAccount({ ...common, reviewerModel: 'claude' }), null);
});

test('account hold logs repo, PR and reason, and engages bounded pre-claim backoff without attempt charge', t => {
  const rootDir = scratch(t);
  const warnings = [];
  const releases = [];
  settleReviewerAttempt({ rootDir, repoPath: 'sample/project', prNumber: 7,
    reviewerModel: 'codex', result: { ok: false, failureClass: 'reviewer-account-held', error: 'evidence-unknown', reviewerSessionUuid: 'session' },
    log: { warn: value => warnings.push(value) },
    statements: { releaseReviewerClaim: { run: (...args) => releases.push(args) } } });
  assert.deepEqual(releases, [['session', 'sample/project', 7]]);
  assert.match(warnings[0], /repo=sample\/project pr=7 reason=evidence-unknown/);
  const gate = shouldBackoffReviewerSpawn(rootDir, { repo: 'sample/project', prNumber: 7 });
  assert.equal(gate.shouldBackoff, true);
  assert.equal(gate.state.lastFailureClass, 'reviewer-account-held');
});

test('corrupt run records release only after both PGID and session probes confirm drain', async t => {
  const rootDir = scratch(t);
  mkdirSync(join(rootDir, 'data', 'reviewer-runs'), { recursive: true });
  writeFileSync(join(rootDir, 'data', 'reviewer-runs', 'session.json'), '{');
  journalReviewerTokenLease(rootDir, 'session', receipt.identity, receipt.lease, 9001);
  const db = new Database(':memory:');
  t.after(() => db.close());
  ensureReviewStateSchema(db);
  let alive = true;
  const operations = [];
  const options = { db, rootDir, log: quiet, now: new Date(Date.now() + 120_000),
    probeAlive: () => alive, findReviewerProcess: () => ({ found: false }),
    updateReviewerTokenLeaseImpl: async (_, operation) => operations.push(operation) };
  await reconcileReviewerSessions(options);
  assert.deepEqual(operations, ['renew']);
  alive = false;
  await reconcileReviewerSessions(options);
  assert.deepEqual(operations, ['renew', 'release']);
  assert.deepEqual(readReviewerTokenLeases(rootDir), []);
});

test('quota cooldown write failure warns and still completes the drained pass', async t => {
  const rootDir = scratch(t);
  const blockedPath = join(rootDir, 'blocked-state');
  writeFileSync(blockedPath, 'not a directory');
  const warnings = [];
  const warn = console.warn;
  console.warn = value => warnings.push(value);
  let completed = false;
  const operations = [];
  try {
    const result = await spawnReviewer({ rootDir, repo: 'sample/project', prNumber: 7,
      reviewerModel: 'codex', builderTag: 'claude-code', reviewerSessionUuid: 'session',
      selectReviewerTokenAccountImpl: async () => receipt,
      updateReviewerTokenLeaseImpl: async (_, operation) => operations.push(operation),
      quotaCheckEnv: { ADVERSARIAL_REVIEW_STATE_DIR: blockedPath }, readReviewerQuotaDecisionImpl: async () => ({ available: true }),
      beginReviewerPassImpl() {}, completeReviewerPassImpl() { completed = true; },
      readBestReviewerEvidenceTokenUsageImpl: async () => null, ledgerLookupSleepImpl: async () => {},
      reviewerRuntimeAdapterOverride: { describe: () => ({ id: 'cli-direct' }),
        spawnReviewer: async () => ({ ok: false, failureClass: 'quota-exhausted' }) },
    });
    assert.equal(result.failureClass, 'quota-exhausted');
  } finally { console.warn = warn; }
  assert.equal(completed, true);
  assert.deepEqual(operations, ['release']);
  assert.ok(warnings.some(value => value.includes('quota cooldown persistence failed')));
});

test('failed kill retains capacity after terminal row settlement until a later drain probe', async t => {
  const rootDir = scratch(t);
  const db = new Database(':memory:');
  t.after(() => db.close());
  ensureReviewStateSchema(db);
  db.prepare(`INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, pr_state,
    review_status, reviewer_session_uuid, reviewer_pgid, reviewer_started_at,
    reviewer_head_sha, reviewer_timeout_ms) VALUES ('sample/project', 7, ?, 'codex', 'merged',
    'reviewing', 'session', 9001, ?, 'head', 3600000)`).run(new Date().toISOString(), new Date().toISOString());
  writeReviewerRunRecord(rootDir, { sessionUuid: 'session', state: 'spawned', pgid: 9001,
    subjectContext: { reviewerAccountReceipt: receipt } });
  let alive = true;
  const operations = [];
  const options = { db, rootDir, log: quiet, probeAlive: () => alive,
    probeSession: () => ({ alive, matched: true }), findReviewerProcess: () => ({ found: false }),
    killProcessGroup: () => false,
    updateReviewerTokenLeaseImpl: async (_, operation) => operations.push(operation) };
  await reconcileReviewerSessions(options);
  assert.deepEqual(operations, ['renew']);
  assert.equal(db.prepare("SELECT count(*) AS n FROM reviewed_prs WHERE review_status = 'reviewing'").get().n, 0);
  assert.equal(readReviewerTokenLeases(rootDir).length, 1);
  alive = false;
  await reconcileReviewerSessions(options);
  assert.deepEqual(operations, ['renew', 'release']);
  assert.deepEqual(readReviewerTokenLeases(rootDir), []);
});
