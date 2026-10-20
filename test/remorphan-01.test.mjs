import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireAmaCloserLease } from '../src/ama/closer-lease.mjs';
import { resolveMergeAgentCoexistenceForWatcher } from '../src/ama-closure-orchestration.mjs';
import { recoverOrphan, probeOrphanOwnership, ownerlessBoundMs, OWNERLESS_BOUND_MS, isOrphanRecoveryWait } from '../src/ama/orphan-watchdog.mjs';
import Database from 'better-sqlite3';
import { openReviewStateDb, ensureReviewStateSchema, hasSettledCommentOnlyVerdict } from '../src/review-state.mjs';

function setup(t) {
  const rootDir = mkdtempSync(join(tmpdir(), 'ownerproof-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const calls = { launches: [], reviews: [], pages: [], logs: [] };
  const args = { rootDir, repo: 'example/repo', prNumber: 8086, headSha: 'current',
    candidate: { prState: 'open', headSha: 'current' }, labels: [],
    result: { amaEnabled: true, reason: 'lease-held' },
    reviewStateRow: { review_status: 'posted', reviewer_head_sha: 'current' },
    hasOwnerImpl: async () => ({ owned: false }),
    dispatchHammer: async evidence => { calls.launches.push(evidence); return { dispatched: true, reason: 'launched' }; },
    requestRereviewImpl: async evidence => { calls.reviews.push(evidence); return { triggered: true, reason: 'requested' }; },
    pageImpl: async (...page) => calls.pages.push(page),
    logger: { log: line => calls.logs.push(line), info() {}, warn() {} } };
  const tick = (minutes, overrides = {}) => recoverOrphan({ ...args,
    now: new Date(Date.UTC(2026, 9, 11, 16, minutes)).toISOString(), ...overrides });
  const record = (bucket, value) => {
    const dir = join(rootDir, 'data', 'follow-up-jobs', bucket);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'example__repo-pr-8086-current.json'), JSON.stringify({ repo: args.repo, prNumber: args.prNumber, headSha: args.headSha, ...value }));
  };
  return { args, calls, tick, record };
}

function recoveryState(rootDir) {
  const dir = join(rootDir, 'data', 'follow-up-jobs', 'orphan-watchdog');
  const db = new Database(join(dir, readdirSync(dir).find(name => name.endsWith('.db'))), { readonly: true });
  try { return db.prepare('SELECT * FROM heads WHERE head=?').get('current'); }
  finally { db.close(); }
}

test('ORPHANACTION-01: settled Comment-only final round selects hammer after a newer push', async t => {
  const { tick, calls, record } = setup(t);
  record('completed', { status: 'completed', revisionRef: 'old', finalRound: 'comment-only',
    reviewBody: '## Non-blocking issues\n- Clarify the example.\n## Verdict\nComment only',
    reReview: { suppressed: 'comment-only-final-round' },
    completion: { workerPushedHeadSha: 'a'.repeat(40) } });
  const overrides = { reviewStateRow: { review_status: 'posted', reviewer_head_sha: 'old' },
    result: { amaEnabled: true, ownerProofFacts: { headSha: 'current', reviewedHeadSha: 'old', verdict: 'comment-only' } } };
  await tick(0, overrides); await tick(15, overrides);
  assert.equal(calls.launches.length, 1);
  assert.equal(calls.reviews.length, 0);
});

test('ORPHANACTION-01: review admission and recovery share captured-pass settlement evidence', async t => {
  const { args, tick, calls } = setup(t);
  const db = openReviewStateDb(args.rootDir);
  try {
    ensureReviewStateSchema(db);
    db.prepare(`INSERT INTO reviewer_passes
      (repo, pr_number, attempt_number, reviewer_class, pass_kind, started_at, status, head_sha, body_md)
      VALUES (?, ?, 1, 'codex', 'first-pass', '2026-10-01T00:00:00Z', 'completed', ?, ?)`)
      .run(args.repo, args.prNumber, args.headSha, '## Verdict\nComment only');
  } finally { db.close(); }
  const overrides = { reviewStateRow: { review_status: 'posted', reviewer_head_sha: 'old' } };
  await tick(0, overrides); await tick(15, overrides);
  assert.equal(calls.launches.length, 1);
  assert.equal(calls.reviews.length, 0);
});

test('ORPHANACTION-01: an older Comment-only verdict without a settled final round leaves review open', async t => {
  const { tick, calls, record } = setup(t);
  record('completed', { status: 'completed', revisionRef: 'old', reviewBody: '## Verdict\nComment only' });
  const overrides = { reviewStateRow: { review_status: 'posted', reviewer_head_sha: 'old' },
    result: { amaEnabled: true, ownerProofFacts: { headSha: 'current', reviewedHeadSha: 'old', verdict: 'comment-only' } } };
  await tick(0, overrides); await tick(15, overrides);
  assert.equal(calls.launches.length, 0);
  assert.equal(calls.reviews.length, 1);
  assert.equal(calls.reviews[0].targetRevisionRef, 'current');
});

// LAC-2072: these facts select dispatch admission only. False or absent
// terminal evidence on an unreviewed current head must retain exact-head review.
for (const facts of [
  {},
  { reviewCycleExhausted: false, commentOnlyFinalRoundCompleted: false },
  { reviewCycleExhausted: true, commentOnlyFinalRoundCompleted: false },
  { reviewCycleExhausted: false, commentOnlyFinalRoundCompleted: true },
  { reviewCycleExhausted: true, commentOnlyFinalRoundCompleted: true },
  { reviewCycleExhausted: 'false', commentOnlyFinalRoundCompleted: 'true' },
]) test(`LAC-2072: recovery respects terminal owner facts: ${JSON.stringify(facts)}`, async t => {
  const { tick, calls } = setup(t);
  const overrides = {
    reviewStateRow: { review_status: 'posted', reviewer_head_sha: 'old' },
    result: { amaEnabled: true, ownerProofFacts: {
      headSha: 'current', reviewedHeadSha: 'old', verdict: 'comment-only', ...facts,
    } },
  };
  await tick(0, overrides); await tick(15, overrides);
  const closed = facts.reviewCycleExhausted === true || facts.commentOnlyFinalRoundCompleted === true;
  assert.equal(calls.launches.length, closed ? 1 : 0);
  assert.equal(calls.reviews.length, closed ? 0 : 1);
  if (!closed) assert.equal(calls.reviews[0].targetRevisionRef, 'current');
  assert.equal(calls.pages.length, 0);
});

for (const evidence of [
  { reviewStateRow: { rereview_reason: 'system-review-ceiling-closure' } },
  { dispatchJob: { reviewCycleCapReached: true } },
  { dispatchJob: { remediationStopCode: 'max-rounds-reached' } },
]) test(`ORPHANACTION-01: closed re-review evidence selects hammer: ${JSON.stringify(evidence)}`, async t => {
  const { tick, calls } = setup(t);
  const overrides = { reviewStateRow: { review_status: 'posted', reviewer_head_sha: 'old' }, ...evidence };
  await tick(0, overrides); await tick(15, overrides);
  assert.equal(calls.launches.length, 1);
  assert.equal(calls.reviews.length, 0);
});

for (const reason of [undefined, null, 42, {}, '']) {
  test(`HAM: partial retry reason settles without throwing: ${JSON.stringify(reason)}`, async t => {
    const { args, tick, calls } = setup(t);
    await tick(0);
    await tick(15, { dispatchHammer: async () => ({ reason }) });
    const state = recoveryState(args.rootDir);
    assert.equal(state.attempts, 1);
    assert.equal(JSON.parse(state.outcomes)[0].reason, String(reason || ''));
    assert.equal(calls.pages.length, 0);
  });
}

for (const settled of [false, true]) {
  test(`HAM: unmigrated review database falls back without mutation (settled=${settled})`, async t => {
    const { args, record, tick, calls } = setup(t);
    const dir = join(args.rootDir, 'data');
    mkdirSync(dir, { recursive: true });
    const db = new Database(join(dir, 'reviews.db'));
    db.close();
    if (settled) record('completed', { status: 'completed', revisionRef: args.headSha,
      reviewBody: '## Verdict\nComment only' });
    const warnings = [];
    assert.equal(hasSettledCommentOnlyVerdict(args.rootDir, args, { warn: message => warnings.push(message) }), settled);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /no such table: reviewer_passes/);
    const readonly = new Database(join(dir, 'reviews.db'), { readonly: true });
    try { assert.deepEqual(readonly.prepare("SELECT name FROM sqlite_master WHERE type='table'").all(), []); }
    finally { readonly.close(); }
    if (settled) assert.equal(hasSettledCommentOnlyVerdict(args.rootDir,
      { ...args, automaticMalformedRecovery: true }, { warn() {} }), false);
    const overrides = { reviewStateRow: { review_status: 'posted', reviewer_head_sha: 'old' } };
    await tick(0, overrides); await tick(15, overrides);
    assert.equal(calls.launches.length, settled ? 1 : 0);
    assert.equal(calls.reviews.length, settled ? 0 : 1);
    assert.equal(calls.pages.length, 0);
  });
}

for (const hold of [
  { holdReason: 'fleet-quota-status-unavailable' },
  { holdReason: 'fleet-quota-status-unreadable' },
  { reason: 'adapter-failed', holdReason: 'fleet-quota-status-unavailable' },
  { reason: 'adapter-failed', holdReason: 'fleet-quota-status-unreadable' },
  { reason: 'all-fallbacks-grounded', holdReason: 'fleet-quota-status-unavailable' },
  { reason: 'all-fallbacks-grounded', holdReason: 'fleet-quota-status-unreadable' },
  { reason: 'harness-hold:fleet-quota-status-unavailable' },
  { reason: 'harness-hold:fleet-quota-status-unreadable' },
  { reason: 'harness-hold:all-fallbacks-grounded', holdReason: 'fleet-quota-status-unavailable' },
  { reason: 'harness-hold:all-fallbacks-grounded', holdReason: 'fleet-quota-status-unreadable' },
  { reason: 'stacked-base-read-failed' },
]) test(`ORPHANACTION-01: transient hold refunds recovery: ${JSON.stringify(hold)}`, async t => {
  const { args, tick, calls } = setup(t);
  assert.equal(isOrphanRecoveryWait(hold), true);
  const overrides = { dispatchHammer: async () => ({ dispatched: false, ...hold }) };
  await tick(0);
  for (const minute of [15, 16, 17]) await tick(minute, overrides);
  const state = recoveryState(args.rootDir);
  assert.equal(state.attempts, 0);
  assert.deepEqual(JSON.parse(state.outcomes), []);
  assert.equal(JSON.parse(state.evidence).reason, hold.reason || '');
  assert.equal(JSON.parse(state.evidence).holdReason,
    hold.holdReason || (hold.reason?.startsWith('harness-hold:') ? hold.reason.slice('harness-hold:'.length) : undefined));
  assert.equal(calls.pages.length, 0);
  // A route-level observation also holds without spending or probing ownership.
  await tick(18, { result: { amaEnabled: true, ...hold },
    hasOwnerImpl: async () => assert.fail('wait cannot start an ownership read') });
  assert.equal(recoveryState(args.rootDir).attempts, 0);
  await tick(19); await tick(20);
  assert.equal(calls.launches.length, 2);
  assert.equal((await tick(21)).outcome, 'recovery-exhausted');
});

for (const hold of [
  { reason: 'all-fallbacks-grounded' },
  { reason: 'all-fallbacks-grounded', holdReason: 'all-fallbacks-grounded' },
  { reason: 'harness-hold:all-fallbacks-grounded' },
  { reason: 'all-fallbacks-grounded', holdReason: 'unknown-hold' },
  { reason: 'harness-hold:fleet-quota-status-unavailable', holdReason: 'quota-exhausted' },
  { reason: 'harness-hold:fleet-quota-status-unreadable', holdReason: 'quota-exhausted' },
]) test(`ORPHANACTION-01: grounded or unknown hold spends recovery: ${JSON.stringify(hold)}`, async t => {
  const { args, tick, calls } = setup(t);
  assert.equal(isOrphanRecoveryWait(hold), false);
  const overrides = { dispatchHammer: async () => ({ dispatched: false, ...hold }) };
  await tick(0); await tick(15, overrides); await tick(16, overrides);
  const state = recoveryState(args.rootDir);
  assert.equal(state.attempts, 2);
  const holdReason = hold.holdReason || (hold.reason.startsWith('harness-hold:') ? hold.reason.slice('harness-hold:'.length) : undefined);
  for (const outcome of JSON.parse(state.outcomes)) {
    assert.equal(outcome.reason, hold.reason);
    assert.equal(outcome.holdReason, holdReason);
  }
  assert.equal(JSON.parse(state.evidence).holdReason, holdReason);
  assert.equal((await tick(17)).outcome, 'recovery-exhausted');
  assert.equal(calls.pages.length, 1);
});

test('ORPHANACTION-01: explicit hold reason takes precedence over the harness reason suffix', async t => {
  const { args, tick } = setup(t);
  await tick(0);
  await tick(15, { dispatchHammer: async () => ({
    reason: 'harness-hold:all-fallbacks-grounded', holdReason: 'quota-exhausted',
  }) });
  const state = recoveryState(args.rootDir);
  assert.equal(JSON.parse(state.outcomes)[0].holdReason, 'quota-exhausted');
  assert.equal(JSON.parse(state.evidence).holdReason, 'quota-exhausted');
});

test('ORPHANACTION-01: exhausted page text names both outcome reasons and underlying hold', async t => {
  const { tick, calls } = setup(t);
  await tick(0);
  await tick(15, { dispatchHammer: async () => ({ reason: 'all-fallbacks-grounded', holdReason: 'quota-exhausted' }) });
  await tick(16, { dispatchHammer: async () => ({ reason: 'launch-refused' }) });
  await tick(17);
  assert.match(calls.pages[0][0], /attempt 1: all-fallbacks-grounded \(quota-exhausted\); attempt 2: launch-refused/);
  assert.deepEqual(calls.pages[0][1].payload.outcomes.map(outcome => outcome.reason), ['all-fallbacks-grounded', 'launch-refused']);
});

test('one elapsed-time bound, with a positive environment override', () => {
  assert.equal(OWNERLESS_BOUND_MS, 900000);
  assert.equal(ownerlessBoundMs({}), 900000);
  assert.equal(ownerlessBoundMs({ OWNERPROOF_IDLE_MINUTES: '2' }), 120000);
  for (const value of ['0', '-1', 'bad']) assert.equal(ownerlessBoundMs({ OWNERPROOF_IDLE_MINUTES: value }), 900000);
});
test('PR 8086: terminal lease on current head cannot prove ownership', async t => {
  const { args, calls, tick } = setup(t);
  const dir = join(args.rootDir, 'data', 'ama-closer-leases');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'example__repo-pr-8086-current.json'), JSON.stringify({ status: 'terminal', terminalOutcome: 'failed-without-merge' }));
  const overrides = { hasOwnerImpl: probeOrphanOwnership };
  await tick(0, overrides);
  await tick(14, overrides);
  assert.equal(calls.launches.length, 0);
  await tick(15, overrides);
  assert.deepEqual(calls.launches, [{ ownerProof: true, headSha: 'current' }]);
  assert.match(calls.logs[0], /^\[watcher\] ownerless-recovery repo=example\/repo pr=8086 head=current idle_minutes=15 last_reason=lease-held action=hammer$/);
});
test('PR 8089: closer-authored stale head and not-eligible hammer requests current review', async t => {
  const { tick, calls } = setup(t);
  const overrides = { reviewStateRow: { review_status: 'posted', reviewer_head_sha: 'old' },
    result: { amaEnabled: true, reason: 'not-eligible', reasons: ['stale-review-head', 'verdict-not-settled-success', 'blocking-findings-unknown'] } };
  await tick(0, overrides); await tick(15, overrides);
  assert.equal(calls.launches.length, 0);
  assert.equal(calls.reviews[0].targetRevisionRef, 'current');
  assert.equal(calls.reviews[0].ownerlessRecovery, true);
});
test('PR 8088: settled comment-only review with findings and conflict launches hammer', async t => {
  const { tick, calls } = setup(t);
  const overrides = { candidate: { prState: 'open', mergeable: 'CONFLICTING' },
    result: { amaEnabled: true, reason: 'not-eligible', ownerProofFacts: { headSha: 'current', reviewedHeadSha: 'current', verdict: 'comment-only', checks: [], mergeable: 'CONFLICTING' } },
    dispatchJob: { nonBlockingFindingCount: 10, remediationStopCode: 'comment-only-final-round' } };
  await tick(0, overrides); await tick(15, overrides);
  assert.equal(calls.launches.length, 1); assert.equal(calls.reviews.length, 0);
});
test('PR 8085: exhausted re-arm counter requests undispatched review', async t => {
  const { tick, calls } = setup(t);
  const overrides = { reviewStateRow: { review_status: 'pending', revision_ref: 'current', rereview_requested_at: '2026-10-11T15:00:00Z', watchdog_rearm_count: 100 },
    result: { amaEnabled: true, reason: 'watchdog-rearm-cap-exhausted' } };
  await tick(0, overrides); await tick(15, overrides);
  assert.equal(calls.reviews.length, 1);
});
test('arbitrary new refusal reasons do not strand PRs', async t => {
  const { tick, calls } = setup(t);
  const overrides = { result: { amaEnabled: true, reason: 'a-future-stop', reasons: ['unrecognized'] } };
  await tick(0, overrides); await tick(15, overrides);
  assert.equal(calls.launches.length, 1);
});
test('live ledger run prevents recovery and resets the idle timer', async t => {
  const { args, record, tick, calls } = setup(t);
  record('ama-closer-dispatches', { launchRequestId: 'lrq' });
  const live = await probeOrphanOwnership({ ...args, readStatusImpl: async () => ({ ok: true, row: { status: 'running' } }) });
  assert.equal(live.owned, true);
  await tick(0); await tick(15, { hasOwnerImpl: async () => live }); await tick(16); await tick(30);
  assert.equal(calls.launches.length, 0); await tick(31); assert.equal(calls.launches.length, 1);
});
for (const label of ['do-not-merge', 'no-merge-hold', 'merge-agent-skip']) test(`held PR ${label} ignored`, async t => {
  const { tick, calls } = setup(t);
  await tick(0, { labels: [label] }); await tick(60, { labels: [label] });
  assert.equal(calls.launches.length + calls.reviews.length + calls.pages.length, 0);
});
for (const state of ['closed', 'merged']) test(`terminal ${state} PR ignored`, async t => {
  const { tick, calls } = setup(t);
  await tick(0, { candidate: { prState: state } }); await tick(60, { candidate: { prState: state } });
  assert.equal(calls.launches.length, 0);
});
test('third recovery pages once with both outcomes and never launches', async t => {
  const { tick, calls } = setup(t);
  await tick(0); await tick(15); await tick(30);
  assert.equal((await tick(45)).outcome, 'recovery-exhausted'); await tick(60);
  assert.equal(calls.launches.length, 2); assert.equal(calls.pages.length, 1);
  const payload = calls.pages[0][1].payload;
  assert.equal(payload.headSha, 'current'); assert.equal(payload.prNumber, 8086);
  assert.deepEqual(payload.outcomes.map(a => a.reason), ['launched', 'launched']);
});
test('unknown ledger evidence becomes ownerless after the same bound', async t => {
  const { args, record, tick, calls } = setup(t);
  record('ama-closer-dispatches', { launchRequestId: 'lrq' });
  const unknown = await probeOrphanOwnership({ ...args, readStatusImpl: async () => ({ ok: false, reason: 'ledger-unavailable' }) });
  assert.equal(unknown.owned, false); assert.equal(unknown.uncertain, true);
  await tick(0, { hasOwnerImpl: async () => unknown }); await tick(14, { hasOwnerImpl: async () => unknown });
  assert.equal(calls.launches.length, 0); await tick(15, { hasOwnerImpl: async () => unknown }); assert.equal(calls.launches.length, 1);
});
test('queue row, remediation flag and reviewing status alone are not ownership', async t => {
  const { args, record } = setup(t);
  record('pending', {});
  const owner = await probeOrphanOwnership({ ...args, reviewStateRow: { review_status: 'reviewing', remediation_pending: true } });
  assert.equal(owner.owned, false);
});
test('live remediation process proves ownership', async t => {
  const { args, record } = setup(t);
  record('in-progress', { remediationWorker: { processId: 123 } });
  assert.equal((await probeOrphanOwnership({ ...args, processKillImpl: () => {} })).owned, true);
});
test('review request ownership is bounded and head-specific', async t => {
  const { args } = setup(t);
  const row = { review_status: 'pending', revision_ref: 'current', rereview_requested_at: '2026-10-11T16:00:00Z' };
  const probe = (now, revision_ref = 'current') => probeOrphanOwnership({ ...args, reviewStateRow: { ...row, revision_ref }, now });
  assert.equal((await probe('2026-10-11T16:14:00Z')).owned, true);
  assert.equal((await probe('2026-10-11T16:15:00Z')).owned, false);
  assert.equal((await probe('2026-10-11T16:01:00Z', 'old')).owned, false);
});
test('concurrent recoveries serialize and a moved head gets its own budget', async t => {
  const { tick, calls } = setup(t);
  await tick(0); await Promise.all([tick(15), tick(15), tick(15)]);
  assert.equal(calls.launches.length, 1);
  await tick(30); await tick(45);
  const moved = { headSha: 'next', reviewStateRow: { review_status: 'posted', reviewer_head_sha: 'next' } };
  await tick(46, moved); assert.equal(calls.launches.length, 3);
  await tick(61, moved); assert.equal(calls.launches.length, 4);
});
test('thrown launches consume a bounded attempt with a durable outcome', async t => {
  const { tick, calls } = setup(t);
  const overrides = { dispatchHammer: async () => { throw new Error('timeout after admission'); } };
  await tick(0, overrides); await tick(15, overrides); await tick(30, overrides); await tick(45, overrides);
  assert.equal(calls.pages[0][1].payload.outcomes.length, 2);
  assert.equal(calls.pages[0][1].payload.outcomes[0].reason, 'timeout after admission');
});

test('live reviewer process for current head prevents recovery; a different head does not', async t => {
  const { args } = setup(t);
  const options = { ...args, processKillImpl: () => {}, now: '2026-10-11T16:00:00Z',
    reviewStateRow: { review_status: 'reviewing', reviewer_head_sha: 'current', reviewer_pgid: 123 } };
  assert.equal((await probeOrphanOwnership(options)).owned, true);
  assert.equal((await probeOrphanOwnership({ ...options, headSha: 'different' })).owned, false);
});

test('page enqueue failure retries without an extra recovery', async t => {
  const { tick, calls } = setup(t);
  await tick(0); await tick(15); await tick(30);
  await tick(45, { pageImpl: async () => { throw new Error('pager unavailable'); } });
  await tick(60);
  assert.equal(calls.launches.length, 2);
  assert.equal(calls.pages.filter(p => p[1].event === 'ama.orphan_recovery.exhausted').length, 1);
});

for (const status of ['succeeded', 'failed', 'operator_triage_required', 'reaped_stuck_requested', 'reaped', 'cancelled', 'completed', 'rejected']) {
  test(`terminal ${status} launch cannot retain ownership through a dispatch record`, async t => {
    const { args, record } = setup(t);
    record('ama-closer-dispatches', { launchRequestId: 'terminal' });
    assert.equal((await probeOrphanOwnership({ ...args, readStatusImpl: async () => ({ ok: true, row: { status } }) })).owned, false);
  });
}
test('terminal ledger evidence is cached without caching live runs', async t => {
  const { args, record } = setup(t);
  record('merge-agent-dispatches', { launchRequestId: 'cached-terminal' });
  let reads = 0;
  const readStatusImpl = async () => { reads += 1; return { ok: true, row: { status: 'failed' } }; };
  await probeOrphanOwnership({ ...args, readStatusImpl }); await probeOrphanOwnership({ ...args, readStatusImpl });
  assert.equal(reads, 1);
});

test('head movement cannot restart the PR-wide absence-of-owner bound', async t => {
  const { tick, calls } = setup(t);
  await tick(0);
  const next = { headSha: 'next', reviewStateRow: { review_status: 'posted', reviewer_head_sha: 'next' } };
  await tick(14, next); assert.equal(calls.launches.length, 0);
  await tick(15, next); assert.equal(calls.launches.length, 1);
});

for (const reason of ['lease-held', 'not-eligible', 'dispatch-status-unknown']) {
  test(`closure routes ownerless ${reason} through elapsed recovery and its two-attempt budget`, async t => {
    const { args, calls } = setup(t);
    const observations = [];
    const run = minutes => resolveMergeAgentCoexistenceForWatcher({
      rootDir: args.rootDir, repoPath: args.repo, prNumber: args.prNumber,
      currentRevisionRef: args.headSha, candidate: args.candidate,
      reviewStateRow: args.reviewStateRow, labelNames: [], logger: args.logger,
      maybeDispatchAmaClosureForImpl: async options => {
        if (options.orphanRecovery) {
          observations.push(options.orphanRecovery);
          return { dispatched: false, reason: 'test-admission-refused' };
        }
        return { amaEnabled: true, skipMergeAgent: true, reason };
      },
      recoverAmaAutomationImpl: () => assert.fail('ownerless watchdog retains this tick'),
      orphanOptions: { hasOwnerImpl: args.hasOwnerImpl, pageImpl: args.pageImpl,
        now: new Date(Date.UTC(2026, 9, 11, 16, minutes)).toISOString(), env: {} },
    });
    for (let poll = 0; poll < 8; poll += 1) assert.equal((await run(0)).outcome, 'ama-pending');
    await run(14);
    assert.equal(observations.length, 0, 'frequent polls cannot shorten the grace');
    await run(15); await run(16);
    assert.deepEqual(observations, [
      { ownerProof: true, headSha: args.headSha }, { ownerProof: true, headSha: args.headSha },
    ]);
    assert.equal((await run(17)).outcome, 'recovery-exhausted');
    await run(18);
    assert.equal(calls.pages.length, 1);
    assert.deepEqual(calls.pages[0][1].payload.outcomes.map(outcome => outcome.reason),
      ['test-admission-refused', 'test-admission-refused']);
  });
}

test('REVIEWALERT-01 pending ownership defaults to the current timestamp when now is omitted', async t => {
  const { args } = setup(t);
  acquireAmaCloserLease({ rootDir: args.rootDir, repo: args.repo, prNumber: args.prNumber,
    headSha: args.headSha, now: new Date().toISOString(), watcherPid: 123 });
  const owner = await probeOrphanOwnership({ rootDir: args.rootDir, repo: args.repo,
    prNumber: args.prNumber, headSha: args.headSha, processKillImpl: () => {},
    readStatusImpl: async () => { throw new Error('pending ownership needs no ledger read'); } });
  assert.deepEqual(owner, { owned: true, proof: 'pending-closer-lease' });
});

test('pending lease exclusion is explicit and does not exclude other ownership evidence', async t => {
  const { args } = setup(t);
  const now = new Date().toISOString();
  acquireAmaCloserLease({ ...args, now, watcherPid: process.pid });
  const probe = options => probeOrphanOwnership({ ...args, now, processKillImpl: () => {}, ...options });
  assert.equal((await probe({})).proof, 'pending-closer-lease');
  assert.equal((await probe({ excludeWatcherPid: process.pid + 1 })).proof, 'pending-closer-lease');
  assert.equal((await probe({ excludeWatcherPid: String(process.pid) })).owned, false);
  assert.equal((await probe({ excludeWatcherPid: process.pid,
    reviewStateRow: { reviewer_head_sha: args.headSha, reviewer_pgid: process.pid } })).proof, 'live-reviewer');
});

test('REVIEWALERT-01 pending provisioning owns the head despite a prior terminal launch', async t => {
  const { args, calls, tick } = setup(t);
  Object.assign(args, { repo: 'example/project', prNumber: 1, headSha: 'a'.repeat(40),
    candidate: { prState: 'open', headSha: 'a'.repeat(40) },
    reviewStateRow: { review_status: 'posted', reviewer_head_sha: 'a'.repeat(40) } });
  const at = '2026-10-11T16:00:00Z';
  acquireAmaCloserLease({ rootDir: args.rootDir, ...args, now: at, watcherPid: 123 });
  const dir = join(args.rootDir, 'data', 'follow-up-jobs', 'ama-closer-dispatches');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `example__project-pr-1-${args.headSha}.json`), JSON.stringify({
    repo: args.repo, prNumber: args.prNumber, headSha: args.headSha,
    state: 'dispatching', launchRequestId: 'synthetic-previous-launch' }));
  const probe = options => probeOrphanOwnership({ ...options, processKillImpl: () => {},
    readStatusImpl: async () => ({ ok: true, row: { status: 'failed' } }) });
  const live = await probe({ ...args, now: at });
  assert.equal(live.proof, 'pending-closer-lease');
  for (const minutes of [0, 15, 16, 17]) await tick(minutes, { hasOwnerImpl: probe });
  assert.equal(calls.launches.length, 0);
  assert.equal(calls.pages.length, 0);
  assert.equal((await probeOrphanOwnership({ ...args, now: at,
    processKillImpl: () => { const error = new Error('dead'); error.code = 'ESRCH'; throw error; },
    readStatusImpl: async () => ({ ok: true, row: { status: 'failed' } }) })).owned, false);
  assert.equal((await probe({ ...args, now: '2026-10-11T17:00:00Z' })).owned, false);
  assert.equal((await probe({ ...args, headSha: 'different', now: at })).owned, false);
});


for (const status of ['failed', 'pending', 'inflight']) {
  test(`ORPHANPAGE-01: unqueued ${status} page retries next pass`, async t => {
    const { tick, calls } = setup(t);
    await tick(0); await tick(15); await tick(30);
    await tick(45, { pageImpl: async () => ({ queued: false, status }) });
    await tick(60); await tick(75);
    assert.equal(calls.launches.length, 2);
    assert.equal(calls.pages.filter(page => page[1].event === 'ama.orphan_recovery.exhausted').length, 1);
  });
}

test('ORPHANPAGE-01: already delivered page marks head paged', async t => {
  const { tick, calls } = setup(t);
  await tick(0); await tick(15); await tick(30);
  await tick(45, { pageImpl: async () => ({ queued: false, status: 'delivered' }) });
  await tick(60);
  assert.equal(calls.pages.length, 0);
});

test('ORPHANPAGE-01: dead-letter page is terminal and warns once across later polls', async t => {
  const { tick, calls } = setup(t);
  const warnings = [];
  const logger = { log() {}, info() {}, warn: line => warnings.push(line) };
  await tick(0); await tick(15); await tick(30);
  await tick(45, { logger, pageImpl: async () => ({ queued: false, status: 'dead-letter' }) });
  await tick(60, { logger }); await tick(75, { logger });
  assert.equal(calls.launches.length, 2);
  assert.equal(calls.pages.length, 0);
  assert.deepEqual(warnings, ['Orphan recovery page is dead-lettered; operator action required']);
});

for (const conclusion of ['FAILURE', 'PENDING']) {
  test(`HAMROUTE-01: ${conclusion} external CI selects hammer recovery, never review reset`, async t => {
    const { tick, calls } = setup(t);
    const overrides = { reviewStateRow: { review_status: 'pending', reviewer_head_sha: 'old' },
      candidate: { prState: 'open', headSha: 'current',
        statusCheckRollup: [{ name: 'external-test', conclusion }] } };
    await tick(0, overrides);
    await tick(15, overrides);
    assert.equal(calls.launches.length, 1);
    assert.equal(calls.reviews.length, 0);
  });
}

test('HAMROUTE-01: waits retain idle time and refund attempts; two real launch failures page', async t => {
  const { tick, calls } = setup(t);
  const reasons = ['ama-coexistence-operation-timeout', 'ama-closer-dispatch-backgrounded',
    'operator-label-classification-pending', 'rate-limited-read'];
  await tick(0);
  for (const [index, reason] of reasons.entries()) {
    const waiting = await tick(15 + index * 5, {
      dispatchHammer: async () => ({ dispatched: false, reason }),
    });
    assert.equal(waiting.outcome, 'ama-pending');
    assert.equal(waiting.amaClosureResult.ownerlessIdleMs, (15 + index * 5) * 60000);
    assert.equal(calls.pages.length, 0);
  }
  const failed = { dispatchHammer: async () => ({ dispatched: false, reason: 'launch-failed' }) };
  await tick(35, failed);
  await tick(40, failed);
  const waiting = await tick(45, { result: { amaEnabled: true, reason: reasons[0] } });
  assert.equal(waiting.outcome, 'ama-pending');
  assert.equal(calls.pages.length, 0);
  assert.equal((await tick(50, failed)).outcome, 'recovery-exhausted');
  assert.equal(calls.pages.length, 1);
  assert.equal(calls.pages[0][1].payload.attempts, 2);
  assert.deepEqual(calls.pages[0][1].payload.outcomes.map(outcome => outcome.reason), ['launch-failed', 'launch-failed']);
});

test('HAMROUTE-01: CI-blocked ownership selects hammer even with no check rollup', async t => {
  const { tick, calls } = setup(t);
  const overrides = { reviewStateRow: { review_status: 'ci-blocked', reviewer_head_sha: 'old' },
    dispatchJob: { ciBlockedHammerOwner: true } };
  await tick(0, overrides); await tick(15, overrides);
  assert.equal(calls.reviews.length, 0);
  assert.equal(calls.launches.length, 1);
});

test('HAMROUTE-01: observing a proof wait never adds a live ownership read to the serial phase', async t => {
  const { tick, calls } = setup(t);
  const overrides = { result: { amaEnabled: true, reason: 'ama-coexistence-operation-timeout' },
    hasOwnerImpl: async () => assert.fail('wait observations cannot start an ownership read') };
  await tick(0, overrides);
  const waiting = await tick(15, overrides);
  assert.equal(waiting.amaClosureResult.ownerlessIdleMs, 15 * 60_000);
  assert.equal(calls.pages.length + calls.launches.length + calls.reviews.length, 0);
});
