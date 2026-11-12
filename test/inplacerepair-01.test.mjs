import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { reserveRepairEpoch, bindRepairHead, repairCause, pageRepairCap,
  pendingRepairEpoch, observeRepairOwner, reconcileRepairOwner, repairEpochForHead,
  REPAIR_PROVISION_DEADLINE_MS } from '../src/repair-epochs.mjs';
import { admitExhaustedHeadVerdict, isExhaustedHeadVerdictRequested } from '../src/exhausted-head-verdict.mjs';
import { readHammerRetryCapLedger, recordHammerRetryDispatch, refundCloserSelfError,
  hammerRetryCapFilePath } from '../src/ama/hammer-retry-cap.mjs';
import { classifyClosureOwnership } from '../src/merge-agent-rescue-classifier.mjs';
import { classifyCloserOutcome } from '../src/ama/closer-inconclusive-retry.mjs';
import { isHarnessFault } from '../src/harness-fault.mjs';
import { refundReviewHarnessFault, REVIEW_HARNESS_REFUND_CAP } from '../src/review-harness-retry.mjs';
import { ensureReviewStateSchema, requestReviewRereview } from '../src/review-state.mjs';
import { readRepairFacts } from '../src/repair-facts.mjs';

const repo = 'example/widgets', prNumber = 17;
const old = 'a'.repeat(40), head = 'b'.repeat(40), later = 'c'.repeat(40);
function fixture(t) {
  const rootDir = mkdtempSync(join(tmpdir(), 'repair-epoch-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  return { rootDir, repo, prNumber, headSha: old, ownerKey: 'repair-submit-one', cause: 'closure-retry-exhausted' };
}
function reviewDb(t) {
  const db = new Database(':memory:');
  ensureReviewStateSchema(db);
  db.prepare(`INSERT INTO reviewed_prs(repo,pr_number,reviewed_at,reviewer,review_status,
    reviewer_head_sha,revision_ref,review_attempts,infra_auto_recover_attempts)
    VALUES (?,?,'2026-01-01T00:00:00Z','synthetic','posted',?,?,3,2)`).run(repo, prNumber, old, old);
  t.after(() => db.close());
  return db;
}

test('repair helper rejects malformed heads before opening the review database', async t => {
  const f = fixture(t);
  const { main } = await import('../bin/repair-in-place.mjs');
  // No database exists: reaching SQLite would produce a different error.
  for (const sha of [undefined, '', old.slice(1), `${old}a`, 'g'.repeat(40)]) {
    await assert.rejects(main([f.rootDir, repo, String(prNumber), sha, f.ownerKey]),
      { message: 'invalid repair request' });
  }
});

test('repair admission recognizes only a complete repair reason for the requested head', () => {
  const row = { revision_ref: head, rereview_requested_at: '2026-01-01T00:00:00Z' };
  const reason = `system-repair-epoch:repair-123a-bc:${head}`;
  for (const value of [reason, reason.toUpperCase(), `system-exhausted-head-verdict:${head}`]) {
    assert.equal(isExhaustedHeadVerdictRequested({ ...row, rereview_reason: value }, head), true);
  }
  for (const value of [null, '', `extra:${reason}`, `${reason}:extra`,
    `system-repair-epoch:repair-:${head}`, `system-repair-epoch:repair-xyz:${head}`,
    `system-repair-epoch:repair-123a-bc:${later}`]) {
    assert.equal(isExhaustedHeadVerdictRequested({ ...row, rereview_reason: value }, head), false);
  }
  assert.equal(isExhaustedHeadVerdictRequested({ ...row, rereview_reason: reason }, later), false);
  assert.equal(isExhaustedHeadVerdictRequested({ ...row, rereview_requested_at: null,
    rereview_reason: reason }, head), false);
});

test('verdict admission recognizes mixed-case revision references without admitting a different head', () => {
  for (const revision of [head, head.toUpperCase()]) {
    for (const requested of [head, head.toUpperCase()]) {
      const row = { revision_ref: revision, rereview_requested_at: '2026-01-01T00:00:00Z',
        rereview_reason: `system-repair-epoch:repair-123a-bc:${head}` };
      assert.equal(isExhaustedHeadVerdictRequested(row, requested), true);
      assert.equal(isExhaustedHeadVerdictRequested({ ...row, revision_ref: later }, requested), false);
    }
  }
});

test('repair facts count only array-shaped closer refund receipts', t => {
  const f = fixture(t), db = reviewDb(t);
  const path = hammerRetryCapFilePath(f.rootDir, f);
  reserveRepairEpoch(f);
  const ledger = readHammerRetryCapLedger(f.rootDir, f);
  ledger.selfErrorRefunds = { [old]: ['launch-one', 'launch-two'], [head]: ['launch-three'],
    nullEntry: null, numberEntry: 3, stringEntry: 'not-launches', objectEntry: { length: 99 } };
  writeFileSync(path, JSON.stringify(ledger));
  const row = db.prepare('SELECT * FROM reviewed_prs').get();
  const facts = readRepairFacts({ ...f, db, row });
  assert.equal(facts.refundedSpend.closer, 3);
});

for (const faultAtEnd of [false, true]) test(`refunded review messages stay bounded and keep their idempotency receipt (fault at end: ${faultAtEnd})`, t => {
  const f = fixture(t), db = reviewDb(t);
  const now = Date.parse('2026-01-01T00:01:00Z');
  // The first two faults retry immediately; the third receives backoff.
  for (let i = 0; i < 2; i++) {
    db.prepare(`UPDATE reviewed_prs SET review_status='failed', failure_message='[hcp-unavailable]', failed_at=?`)
      .run(`earlier-fault-${i}`);
    refundReviewHarnessFault({ ...f, db, row: db.prepare('SELECT * FROM reviewed_prs').get(), now });
  }
  db.prepare(`UPDATE reviewed_prs SET review_status='failed', failure_message=?, failed_at=?`)
    .run(faultAtEnd ? `${'x'.repeat(20_000)} [hcp-unavailable]` : `[hcp-unavailable] ${'x'.repeat(20_000)}`,
      '2026-01-01T00:00:00Z');
  const row = db.prepare('SELECT * FROM reviewed_prs').get();
  const refunded = refundReviewHarnessFault({ ...f, db, row, now });
  assert.ok(refunded.row.failure_message.length <= 4096);
  assert.ok(refunded.row.failure_message.startsWith(faultAtEnd ? 'xxx' : '[hcp-unavailable]'));
  assert.ok(refunded.row.failure_message.endsWith(`[harness-budget-refunded:${refunded.receipt.id}]`));
  for (let i = 0; i < 5; i++) {
    const repeated = refundReviewHarnessFault({ ...f, db, row: refunded.row, now });
    assert.equal(repeated.row.failure_message, refunded.row.failure_message);
    assert.equal(repeated.row.review_attempts, refunded.row.review_attempts);
    assert.equal(repeated.receipt.id, refunded.receipt.id);
    assert.equal(repeated.wait, true);
  }
  assert.equal(Object.keys(readHammerRetryCapLedger(f.rootDir, f).reviewHarnessRefunds).length, 3);
});

test('harness refund backoff aggregates case variants of the same head', t => {
  const f = fixture(t), db = reviewDb(t);
  const now = Date.parse('2026-01-01T00:01:00Z');
  const variants = [old, old.toUpperCase(), 'Aa'.repeat(20)];
  for (const [index, sha] of variants.entries()) {
    db.prepare(`UPDATE reviewed_prs SET review_status='failed', failure_message='[hcp-unavailable]',
      failed_at=?, reviewer_head_sha=?`).run(`failure-${index}`, sha);
    const result = refundReviewHarnessFault({ ...f, db, row: db.prepare('SELECT * FROM reviewed_prs').get(), now });
    assert.equal(result.receipt.headSha, sha, 'stored spelling is preserved');
    assert.equal(result.wait, index === 2, 'the third fault gets backoff across SHA case variants');
    assert.equal(result.row.review_attempts, 2 - index, 'each distinct fault is credited once');
  }
  assert.equal(Object.keys(readHammerRetryCapLedger(f.rootDir, f).reviewHarnessRefunds).length, 3);
});

test('missing applied harness receipt warns without rewriting or granting another refund', t => {
  const f = fixture(t), db = reviewDb(t);
  const warn = t.mock.method(console, 'warn', () => {});
  db.prepare(`UPDATE reviewed_prs SET review_status='failed', failure_message='[hcp-unavailable]',
    failed_at='2026-01-01T00:00:00Z'`).run();
  const refunded = refundReviewHarnessFault({ ...f, db, row: db.prepare('SELECT * FROM reviewed_prs').get() });
  const path = hammerRetryCapFilePath(f.rootDir, f);
  const ledger = readHammerRetryCapLedger(f.rootDir, f);
  delete ledger.reviewHarnessRefunds[refunded.receipt.id];
  writeFileSync(path, JSON.stringify(ledger));
  const before = readFileSync(path, 'utf8');
  const result = refundReviewHarnessFault({ ...f, db, row: refunded.row });
  assert.deepEqual(result, { row: refunded.row, wait: false, receipt: null });
  assert.deepEqual(db.prepare('SELECT * FROM reviewed_prs').get(), refunded.row);
  assert.equal(readFileSync(path, 'utf8'), before, 'the applied-marker path stays read-only');
  assert.equal(warn.mock.callCount(), 1);
  const message = warn.mock.calls[0].arguments[0];
  assert.match(message, /review harness refund receipt missing/);
  assert.ok(message.includes(`${repo}#${prNumber}`));
  assert.ok(message.includes(refunded.receipt.id));
});

for (const cause of ['closure-retry-exhausted', 'closure-lifetime-exhausted',
  'closer-self-error-budget-exhausted', 'budget-exhausted-closure', 'retry-exhausted', 'lifetime-exhausted']) {
  test(`${cause} selects in-place repair without a live owner`, () => {
    const decision = { action: 'hammer', actor: 'closure-recovery', reason: cause,
      head: old, queue: { intent: 'reconcile' } };
    assert.equal(classifyClosureOwnership(decision, old).decision, 'repair-in-place');
    assert.equal(classifyClosureOwnership(decision, old.toUpperCase()).decision, 'repair-in-place');
    assert.notEqual(classifyClosureOwnership(decision, head).decision, 'repair-in-place');
    assert.equal(repairCause({ row: { next_action_json: JSON.stringify(decision) } }), cause);
    assert.notEqual(classifyClosureOwnership({ ...decision, reason: 'live-owner',
      actor: 'hammer', queue: { intent: 'owned' } }, old).decision, 'repair-in-place');
  });
}
test('conflict and cycle-exhausted PR updates reserve a single epoch and retain uncertain custody', t => {
  const f = fixture(t);
  assert.equal(repairCause({ conflicting: true }), 'conflict-without-owner');
  assert.equal(repairCause({ cycleExhausted: true }), 'review-cycle-exhausted');
  const first = reserveRepairEpoch(f);
  assert.equal(reserveRepairEpoch(f).epoch.id, first.epoch.id);
  assert.equal(reserveRepairEpoch({ ...f, ownerKey: 'another-writer' }).reason, 'repair-owned');
  assert.equal(pendingRepairEpoch(f.rootDir, f).id, first.epoch.id);
});

test('malformed next-action JSON retains fallback repair causes', () => {
  const row = { next_action_json: '{"reason":' };
  assert.equal(repairCause({ row: { ...row, rereview_reason: 'closure-retry-exhausted' } }),
    'closure-retry-exhausted');
  assert.equal(repairCause({ row, cycleExhausted: true }), 'review-cycle-exhausted');
  assert.equal(repairCause({ row, conflicting: true }), 'conflict-without-owner');
  assert.equal(repairCause({ row }), null);
  assert.equal(repairCause({ row: { next_action_json: '{"reason":"review-cycle-cap-paused"}',
    rereview_reason: 'closure-retry-exhausted' } }), 'review-cycle-cap-paused');
  assert.throws(() => repairCause({ ledger: { __corrupt: true }, row }),
    /repair ledger unreadable/);
});

test('repair push admits exactly one head review through the real request CAS and refreshes closure budget', async t => {
  const f = fixture(t), db = reviewDb(t);
  for (let n = 0; n < 5; n++) recordHammerRetryDispatch(f.rootDir, f, {
    jobKey: old, headSha: old, launchRequestId: `old-launch-${n}`, now: '2026-01-01T00:00:00Z' });
  const epoch = reserveRepairEpoch(f).epoch;
  const readRow = () => db.prepare('SELECT * FROM reviewed_prs WHERE repo=? AND pr_number=?').get(repo, prNumber);
  let requests = 0, delivered = 0;
  const admit = (sha = head) => admitExhaustedHeadVerdict({
    exhausted: true, lifetimeExhausted: true, headSha: sha, row: readRow(), repairEpoch: epoch,
    countDelivered: () => delivered, classifyCloser: async () => ({ suppressed: false }),
    bindRepair: () => bindRepairHead({ ...f, headSha: sha, epochId: epoch.id }),
    request: args => { requests++; return requestReviewRereview({ rootDir: f.rootDir, db, repo, prNumber, ...args }); },
    readRow,
  });
  await admit();
  assert.equal(requests, 1);
  assert.equal(isExhaustedHeadVerdictRequested(readRow(), head), true);
  assert.match(readRow().rereview_reason, new RegExp(epoch.id));
  assert.equal(readRow().review_attempts, 0);
  assert.equal(readRow().infra_auto_recover_attempts, 0);
  await admit();
  assert.equal(requests, 1);
  delivered = 1;
  await admit();
  assert.equal(requests, 1);
  delivered = 0;
  await admit(later);
  assert.equal(requests, 1, 'an epoch cannot arm a second head');
  const ledger = readHammerRetryCapLedger(f.rootDir, f);
  assert.equal(ledger.lifetimeAttemptCount, 0);
  assert.equal(Object.keys(ledger.dispatchCharges).length, 5, 'real prior spend stays auditable');
  assert.equal(ledger.repairEpochs[0].priorSpend.lifetime, 5);
  recordHammerRetryDispatch(f.rootDir, f, { jobKey: head, headSha: head, launchRequestId: 'new-launch' });
  assert.equal(readHammerRetryCapLedger(f.rootDir, f).repairEpochs[0].id, epoch.id);
  assert.equal(readHammerRetryCapLedger(f.rootDir, f).lifetimeAttemptCount, 1);
});

test('repair admission retains closer heads, live review claims and malformed heads', async t => {
  const f = fixture(t), epoch = reserveRepairEpoch(f).epoch;
  let bound = 0, requested = 0;
  for (const [sha, suppressed] of [['malformed', false], [head, true]]) {
    await admitExhaustedHeadVerdict({ exhausted: true, lifetimeExhausted: true, headSha: sha,
      repairEpoch: epoch, row: { reviewer_head_sha: old }, countDelivered: () => 0,
      classifyCloser: async () => ({ suppressed }), bindRepair: () => { bound++; },
      request: () => { requested++; } });
  }
  assert.equal(bound, 0);
  assert.equal(requested, 0);
  const db = reviewDb(t);
  db.prepare("UPDATE reviewed_prs SET review_status='reviewing'").run();
  requestReviewRereview({ rootDir: f.rootDir, db, repo, prNumber, targetRevisionRef: head,
    reason: `system-repair-epoch:${epoch.id}:${head}`, ownerlessRecovery: true });
  assert.equal(db.prepare('SELECT review_status FROM reviewed_prs').get().review_status, 'reviewing');
});

for (const storedSha of [old, old.toUpperCase(), 'aA'.repeat(20)]) {
  test(`repair head identity ignores SHA case stored as ${storedSha.slice(0, 2)}`, async t => {
    const f = fixture(t);
    const epoch = reserveRepairEpoch({ ...f, headSha: storedSha }).epoch;
    for (const headSha of [old, old.toUpperCase(), 'Aa'.repeat(20)]) {
      assert.equal(bindRepairHead({ ...f, epochId: epoch.id, headSha }), null,
        'case changes cannot consume the reservation as a new builder head');
    }
    const bound = bindRepairHead({ ...f, epochId: epoch.id, headSha: 'bB'.repeat(20) });
    for (const headSha of [head, head.toUpperCase(), 'Bb'.repeat(20)]) {
      assert.equal(bindRepairHead({ ...f, epochId: epoch.id, headSha }).boundAt, bound.boundAt);
      assert.equal(repairEpochForHead(f.rootDir, f, headSha).id, epoch.id);
      assert.equal((await reconcileRepairOwner({ ...f, headSha, includeReviewedHead: true })).id, epoch.id);
    }
    assert.equal(bindRepairHead({ ...f, epochId: epoch.id, headSha: later }), null);
    assert.equal(repairEpochForHead(f.rootDir, f, later), null);

    const second = reserveRepairEpoch({ ...f, headSha: head.toUpperCase(), ownerKey: 'second' }).epoch;
    const retired = await reconcileRepairOwner({ ...f, headSha: head, includeReviewedHead: true,
      now: Date.now() + REPAIR_PROVISION_DEADLINE_MS,
      readImpl: async () => ({ ok: true, roots: [], absenceProof: {} }) });
    assert.equal(retired.id, epoch.id, 'retirement falls back to the same head regardless of case');
    assert.ok(readHammerRetryCapLedger(f.rootDir, f).repairEpochs.find(e => e.id === second.id).terminalAt);
  });
}

test('cap pages once with full history across heads and never opens a PR', async t => {
  const f = fixture(t);
  const one = reserveRepairEpoch(f).epoch;
  bindRepairHead({ ...f, headSha: head, epochId: one.id });
  const two = reserveRepairEpoch({ ...f, headSha: head, ownerKey: 'second' }).epoch;
  bindRepairHead({ ...f, headSha: later, epochId: two.id });
  const capped = reserveRepairEpoch({ ...f, headSha: later, ownerKey: 'third' });
  assert.equal(capped.reason, 'repair-epoch-cap');
  let pages = 0;
  const { observeClosureWait } = await import('../src/ama/closure-wait.mjs');
  const observeImpl = args => observeClosureWait({ ...args, pageImpl: async text => {
    pages++;
    assert.match(text, new RegExp(one.id));
    assert.match(text, new RegExp(two.id));
    return { ok: true };
  } });
  for (let n = 0; n < 3; n++) await pageRepairCap({ ...f, epochs: capped.epochs, observeImpl });
  assert.equal(pages, 1);
});

test('only terminal launch and complete retry evidence permit a successor epoch', async t => {
  const f = fixture(t), epoch = reserveRepairEpoch(f).epoch;
  for (const state of ['requested', 'running', 'blocked_needs_decision', 'succeeded']) {
    const observed = await observeRepairOwner({ ...f, epoch, readImpl: async () => ({
      ok: true, roots: ['fixture-launch'], retryEdges: [],
      rows: [{ launch_request_id: 'fixture-launch', status: state }],
    }) });
    assert.equal(observed.ownerState === 'terminal', state === 'succeeded');
    if (state === 'succeeded') {
      const next = reserveRepairEpoch({ ...f, ownerKey: 'successor', terminalOwner: observed });
      assert.equal(next.ok, true);
      assert.notEqual(next.epoch.id, epoch.id);
    }
  }
});

for (const fault of ['provision-failed', 'workspace-wait timeout',
  'hammer-wall-clock-exceeded while waiting for a workspace',
  'controller-setup-failed', 'quota-exhausted', 'credential-outage']) {
  test(`${fault} refunds review and closer spend and leaves evidence`, t => {
    const f = fixture(t), db = reviewDb(t);
    assert.equal(isHarnessFault(fault), true);
    assert.equal(classifyCloserOutcome({ reason: fault }).kind, 'inconclusive');
    db.prepare(`UPDATE reviewed_prs SET review_status='failed', failure_message=?, failed_at=?,
      reviewer_session_uuid='synthetic-session'`).run(fault, '2026-01-01T00:00:00Z');
    let row = db.prepare('SELECT * FROM reviewed_prs').get();
    const refund = refundReviewHarnessFault({ ...f, db, row, now: Date.parse('2026-01-01T00:01:00Z') });
    assert.equal(refund.row.review_attempts, 2);
    assert.equal(refund.row.infra_auto_recover_attempts, 1);
    assert.match(refund.row.failure_message, /harness-budget-refunded/);
    const path = hammerRetryCapFilePath(f.rootDir, f);
    const before = statSync(path);
    const contents = readFileSync(path, 'utf8');
    row = refundReviewHarnessFault({ ...f, db, row: refund.row }).row;
    assert.equal(statSync(path).ino, before.ino, 'applied path never rewrites the ledger');
    assert.equal(readFileSync(path, 'utf8'), contents);
    assert.equal(row.review_attempts, 2);
    recordHammerRetryDispatch(f.rootDir, f, { jobKey: old, headSha: old, launchRequestId: 'fault-launch' });
    assert.equal(refundCloserSelfError(f.rootDir, f, {
      jobKey: old, headSha: old, launchRequestId: 'fault-launch' }).refunded, true);
    assert.equal(readHammerRetryCapLedger(f.rootDir, f).lifetimeAttemptCount, 0);
  });
}
test('structured workspace wait evidence refunds an outer wall-clock stop', () => {
  assert.equal(classifyCloserOutcome({
    reason: 'hammer-wall-clock-exceeded',
    failureClass: 'workspace_wait',
    failureDetail: 'Supervisor expired while waiting for a workspace',
  }).kind, 'inconclusive');
  assert.equal(classifyCloserOutcome({
    reason: 'conflict-primary-unproven',
    failureDetail: 'workspace-wait timeout',
  }).kind, 'real');
});

test('real findings and unqualified wall-clock expiry remain charged', () => {
  for (const reason of ['predicate-failed', 'conflict-primary-unproven', 'hammer-wall-clock-exceeded']) {
    assert.equal(isHarnessFault(reason), false);
  }
});

test('free-text detail and bare signal exits do not refund unregistered stops', () => {
  for (const detail of ['Command failed with code 143', 'helper exit 142',
    'waiting for a workspace wall clock', 'workspace-wait timeout']) {
    assert.equal(classifyCloserOutcome({ reason: 'unregistered-real-stop',
      failureClass: 'runtime_timeout', failureDetail: detail }).kind, 'real');
  }
  for (const failure of ['Command failed with code 143', 'helper exit 142']) {
    assert.equal(isHarnessFault(failure), false);
  }
  assert.equal(isHarnessFault('Command failed with code 143: provision-failed'), true);
});

test('harness refunds have a PR-wide cap and bounded failure evidence', t => {
  const f = fixture(t), db = reviewDb(t);
  for (let i = 0; i < REVIEW_HARNESS_REFUND_CAP + 3; i++) {
    db.prepare(`UPDATE reviewed_prs SET review_status='failed', failed_at=?,
      failure_message=?, reviewer_head_sha=?`).run(`failure-${i}`,
      `[hcp-unavailable] ${'x'.repeat(2000)}`, i % 2 ? head : old);
    const row = db.prepare('SELECT * FROM reviewed_prs').get();
    const result = refundReviewHarnessFault({ ...f, db, row });
    assert.equal(result.row.review_attempts, row.review_attempts - (i < REVIEW_HARNESS_REFUND_CAP ? 1 : 0));
  }
  const refunds = Object.values(readHammerRetryCapLedger(f.rootDir, f).reviewHarnessRefunds);
  assert.equal(refunds.length, REVIEW_HARNESS_REFUND_CAP);
  assert.ok(refunds.every(refund => refund.failure.length <= 512));
});

test('harness refund clamps nullable legacy attempt counters to zero once', t => {
  const f = fixture(t), db = new Database(':memory:');
  t.after(() => db.close());
  // Synthetic legacy schema: the production schema already declares NOT NULL.
  db.exec(`CREATE TABLE reviewed_prs (repo TEXT, pr_number INTEGER, review_status TEXT,
    failed_at TEXT, failure_message TEXT, reviewer_session_uuid TEXT, reviewer_head_sha TEXT,
    review_attempts INTEGER, infra_auto_recover_attempts INTEGER)`);
  db.prepare(`INSERT INTO reviewed_prs VALUES (?,?,'failed','2026-01-01T00:00:00Z',
    '[hcp-unavailable]','legacy-session',?,NULL,NULL)`).run(repo, prNumber, old);
  const row = db.prepare('SELECT * FROM reviewed_prs').get();
  const refunded = refundReviewHarnessFault({ ...f, db, row });
  assert.equal(refunded.row.review_status, 'pending-upstream');
  assert.equal(refunded.row.review_attempts, 0);
  assert.equal(refunded.row.infra_auto_recover_attempts, 0);
  const replay = refundReviewHarnessFault({ ...f, db, row: refunded.row });
  assert.equal(replay.row.review_attempts, 0);
  assert.equal(replay.receipt.id, refunded.receipt.id);
});

test('watcher reconciliation resolves reviewed heads while pending custody takes precedence', async t => {
  const f = fixture(t);
  const options = { ...f, headSha: head, includeReviewedHead: true,
    readImpl: async () => ({ ok: false }) };
  assert.equal(await reconcileRepairOwner(options), null);
  const first = reserveRepairEpoch(f).epoch;
  bindRepairHead({ ...f, epochId: first.id, headSha: head });
  assert.equal(await reconcileRepairOwner({ ...options, includeReviewedHead: false }), null);
  assert.equal((await reconcileRepairOwner(options)).id, first.id);
  assert.equal(await reconcileRepairOwner({ ...options, headSha: later }), null);
  const second = reserveRepairEpoch({ ...f, headSha: head, ownerKey: 'second-owner' }).epoch;
  assert.equal((await reconcileRepairOwner(options)).id, second.id);
  const retired = await reconcileRepairOwner({ ...options,
    now: Date.now() + REPAIR_PROVISION_DEADLINE_MS,
    readImpl: async () => ({ ok: true, roots: [], absenceProof: {} }) });
  assert.equal(retired.id, first.id, 'retirement still falls back to the reviewed-head epoch');
  assert.equal(pendingRepairEpoch(f.rootDir, f), null);
});

test('watcher reconciliation retires terminal or absent repair launches and projects ownerless', async t => {
  const { resolveTtmOwner } = await import('../src/ttm-owner.mjs');
  for (const absent of [false, true]) {
    const f = { ...fixture(t), now: '2026-01-01T00:00:00Z' };
    reserveRepairEpoch(f);
    const now = Date.parse(f.now) + REPAIR_PROVISION_DEADLINE_MS;
    const readImpl = async () => absent
      ? { ok: true, roots: [], absenceProof: { kind: 'canonical-exact-selector-absence' } }
      : { ok: true, roots: ['fixture-launch'], retryEdges: [],
        rows: [{ launch_request_id: 'fixture-launch', status: 'failed' }] };
    assert.equal(await reconcileRepairOwner({ ...f, now, readImpl }), null);
    assert.equal(pendingRepairEpoch(f.rootDir, f), null);
    assert.ok(readHammerRetryCapLedger(f.rootDir, f).repairEpochs[0].terminalAt);
    assert.equal(resolveTtmOwner({ repairEpoch: pendingRepairEpoch(f.rootDir, f),
      review: { status: 'posted', suppressed: true } }, new Date(now).toISOString()).owner, null);
  }
});

test('repair observation bounds cadence and retains live, early absent and unreadable owners', async t => {
  for (const state of ['live', 'early-absent', 'unreadable', 'unproven-absent', 'retry']) {
    const f = { ...fixture(t), now: '2026-01-01T00:00:00Z' };
    reserveRepairEpoch(f);
    const now = Date.parse(f.now) + (state === 'early-absent' ? 1000 : REPAIR_PROVISION_DEADLINE_MS);
    let reads = 0;
    const readImpl = async () => {
      reads++;
      if (state === 'unreadable') return { ok: false };
      if (state.includes('absent')) return { ok: true, roots: [],
        ...(state === 'early-absent' ? { absenceProof: {} } : {}) };
      return { ok: true, roots: ['fixture-launch'],
        retryEdges: state === 'retry' ? [{ parent: 'fixture-launch', child: 'retry' }] : [],
        rows: [{ launch_request_id: 'fixture-launch', status: state === 'retry' ? 'failed' : 'running' },
          ...(state === 'retry' ? [{ launch_request_id: 'retry', status: 'running' }] : [])] };
    };
    assert.ok(await reconcileRepairOwner({ ...f, now, readImpl }));
    const count = reads;
    assert.ok(await reconcileRepairOwner({ ...f, now: now + 1000, readImpl }));
    assert.equal(reads, count, 'no repeated SDK read inside the cadence');
    assert.equal(pendingRepairEpoch(f.rootDir, f).terminalAt, undefined);
  }
});

test('failed retry-chain lookup retains repair custody as unknown', async t => {
  const f = { ...fixture(t), now: '2026-01-01T00:00:00Z' };
  const epoch = reserveRepairEpoch(f).epoch;
  const now = Date.parse(f.now) + REPAIR_PROVISION_DEADLINE_MS;
  let reads = 0;
  const readImpl = async selector => {
    reads++;
    if (selector.idempotency_key) return { ok: true, roots: ['fixture-launch'] };
    assert.deepEqual(selector, { launch_request_ids: ['fixture-launch'], include_retry_chain: true });
    return { ok: false, reason: 'timeout' };
  };
  const observed = await reconcileRepairOwner({ ...f, now, readImpl });
  assert.equal(reads, 2);
  assert.equal(observed.id, epoch.id);
  assert.equal(observed.ownerState, 'unknown');
  assert.equal(observed.ownerLaunch, 'fixture-launch');
  assert.equal(pendingRepairEpoch(f.rootDir, f).terminalAt, undefined);
});

test('a changed builder head binds before terminal worker retirement', async t => {
  const f = fixture(t), epoch = reserveRepairEpoch(f).epoch;
  const pending = await reconcileRepairOwner({ ...f, headSha: head,
    readImpl: async () => { throw new Error('must admit publication before probing retirement'); } });
  assert.equal(pending.id, epoch.id);
  assert.equal(bindRepairHead({ ...f, headSha: head, epochId: pending.id }).reviewHead, head);
});

// Exercise the existing cross-process flock rather than a mocked in-process
// read/modify/write. A competing observer may retry EBUSY, never steal custody.
test('22 concurrent reservation runs each retain exactly one repair owner', async t => {
  const f = fixture(t);
  const moduleUrl = pathToFileURL(join(process.cwd(), 'src/repair-epochs.mjs')).href;
  const execute = promisify(execFile);
  for (let round = 0; round < 22; round++) {
    const roundRoot = join(f.rootDir, String(round));
    const outcomes = await Promise.all(Array.from({ length: 4 }, (_, writer) => {
      const identity = { ...f, rootDir: roundRoot, ownerKey: `writer-${writer}` };
      const code = `import { reserveRepairEpoch } from ${JSON.stringify(moduleUrl)};
        let result;
        // Bound by wall time, not attempts: a loaded host can hold the
        // flock past a fixed count of short retries.
        for (const deadline = Date.now() + 10000; Date.now() < deadline;) {
          try { result = reserveRepairEpoch(${JSON.stringify(identity)}); break; }
          catch (error) { if (error.code !== 'EBUSY') throw error;
            await new Promise(resolve => setTimeout(resolve, 5)); }
        }
        if (!result) throw Error('reservation never completed');
        console.log(JSON.stringify(result));`;
      return execute(process.execPath, ['--input-type=module', '-e', code], { timeout: 15000 })
        .then(({ stdout }) => JSON.parse(stdout));
    }));
    assert.equal(outcomes.filter(outcome => outcome.ok).length, 1);
    assert.equal(readHammerRetryCapLedger(roundRoot, f).repairEpochs.length, 1);
  }
});

test('reserved repair excludes a new final-fix-all queue owner', async t => {
  const f = fixture(t);
  reserveRepairEpoch(f);
  const { handoffFinalFixAll } = await import('../src/ama/final-fix-all.mjs');
  let created = 0;
  const result = await handoffFinalFixAll({ ...f, reviewBody: 'Synthetic non-blocking finding',
    createJobImpl: () => { created++; throw Error('unexpected second writer'); } });
  assert.deepEqual(result, { action: 'hold', reason: 'repair-in-place-owned' });
  assert.equal(created, 0);
});

test('PR-update helper reserves an exhausted review epoch before launch and rejects queued custody', async t => {
  const f = fixture(t);
  const { openReviewStateDb } = await import('../src/review-state.mjs');
  const { getFollowUpJobDir } = await import('../src/follow-up-jobs.mjs');
  const { main } = await import('../bin/repair-in-place.mjs');
  const db = openReviewStateDb(f.rootDir);
  ensureReviewStateSchema(db);
  db.prepare(`INSERT INTO reviewed_prs(repo,pr_number,reviewed_at,reviewer,pr_state,
    review_status,reviewer_head_sha,rereview_reason)
    VALUES (?,?,'2026-01-01T00:00:00Z','synthetic','open','posted',?,?)`)
    .run(repo, prNumber, old, 'closure-retry-exhausted');
  db.close();
  const dir = getFollowUpJobDir(f.rootDir, 'pending');
  mkdirSync(dir, { recursive: true });
  const { followUpJobFilePrefix } = await import('../src/follow-up-job-names.mjs');
  const queued = join(dir, `${followUpJobFilePrefix(repo, prNumber)}synthetic-queue.json`);
  writeFileSync(queued, JSON.stringify({ jobId: 'synthetic-queue', repo, prNumber,
    status: 'pending', revisionRef: old }));
  const argv = [f.rootDir, repo, String(prNumber), old, f.ownerKey, 'false'];
  const held = await main(argv);
  assert.equal(held.reason, 'remediation-owned');
  assert.equal(pendingRepairEpoch(f.rootDir, f), null);
  rmSync(queued);
  const result = await main(argv);
  assert.equal(result.ok, true);
  assert.match(result.epoch.id, /^repair-/);
  assert.equal(result.epoch.ownerKey, f.ownerKey);
});

test('canonical next action and health retain the reserved repair owner across spent budgets', async t => {
  const f = fixture(t), epoch = reserveRepairEpoch(f).epoch;
  const { nextAction, deriveNextActionSnapshot } = await import('../src/pr-next-action.mjs');
  const { resolveTtmOwner } = await import('../src/ttm-owner.mjs');
  const base = { subjectKey: `${repo}#${prNumber}`, head: old, observedAt: '2026-01-01T00:00:00Z',
    observations: { pr: { state: 'OPEN', headSha: old, labels: [] },
      policy: { autonomousMergeExecutionEnabled: true, hammerCap: { lifetimeExhausted: true } },
      progress: { repairEpoch: epoch } } };
  const action = nextAction(deriveNextActionSnapshot(base));
  assert.equal(action.reason, 'repair-in-place-owned');
  assert.equal(action.actor, 'remediator');
  assert.equal(action.queue.intent, 'owned');
  assert.ok(action.evidenceRefs.includes(`repair-epoch:${epoch.id}`));
  assert.equal(resolveTtmOwner({ repairEpoch: epoch, review: { status: 'posted', suppressed: true } }).owner,
    'repair-worker');
  const closed = nextAction(deriveNextActionSnapshot({ ...base,
    observations: { ...base.observations, pr: { state: 'CLOSED', headSha: old } } }));
  assert.equal(closed.action, 'done');
  const held = nextAction(deriveNextActionSnapshot({ ...base,
    observations: { ...base.observations, pr: { state: 'OPEN', headSha: old, isDraft: true } } }));
  assert.equal(held.action, 'operator-hold');
});
