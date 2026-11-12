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
  pendingRepairEpoch, observeRepairOwner, reconcileRepairOwner,
  REPAIR_PROVISION_DEADLINE_MS } from '../src/repair-epochs.mjs';
import { admitExhaustedHeadVerdict, isExhaustedHeadVerdictRequested } from '../src/exhausted-head-verdict.mjs';
import { readHammerRetryCapLedger, recordHammerRetryDispatch, refundCloserSelfError,
  hammerRetryCapFilePath } from '../src/ama/hammer-retry-cap.mjs';
import { classifyClosureOwnership } from '../src/merge-agent-rescue-classifier.mjs';
import { classifyCloserOutcome } from '../src/ama/closer-inconclusive-retry.mjs';
import { isHarnessFault } from '../src/harness-fault.mjs';
import { refundReviewHarnessFault, REVIEW_HARNESS_REFUND_CAP } from '../src/review-harness-retry.mjs';
import { ensureReviewStateSchema, requestReviewRereview } from '../src/review-state.mjs';

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

for (const cause of ['closure-retry-exhausted', 'closure-lifetime-exhausted',
  'closer-self-error-budget-exhausted', 'budget-exhausted-closure', 'retry-exhausted', 'lifetime-exhausted']) {
  test(`${cause} selects in-place repair without a live owner`, () => {
    const decision = { action: 'hammer', actor: 'closure-recovery', reason: cause,
      head: old, queue: { intent: 'reconcile' } };
    assert.equal(classifyClosureOwnership(decision, old).decision, 'repair-in-place');
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
