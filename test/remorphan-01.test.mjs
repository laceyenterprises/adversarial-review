import test from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, existsSync, mkdtempSync, mkdirSync, openSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { amaCloserLeaseFilePath } from '../src/ama/closer-lease.mjs';
import { recoverOrphan, hasOrphanOwner, orphanDispatchReasonsCovered, probeOrphanOwnership } from '../src/ama/orphan-watchdog.mjs';

function setup(t, pr = 7707) {
  const rootDir = mkdtempSync(join(tmpdir(), 'remorphan-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const fixture = JSON.parse(readFileSync(new URL(`./fixtures/remorphan/${pr}.json`, import.meta.url)));
  const calls = { dispatch: [], pages: [], reviews: [] };
  const args = { ...fixture, rootDir, repo: 'example/repo', headSha: 'current-head',
    candidate: { prState: 'open', headSha: 'current-head' }, reviewStateRow: { review_status: 'posted' },
    hasOwnerImpl: async () => false,
    closerHeadImpl: async () => ({ suppressed: true, reason: 'closer-commit-trailer' }),
    dispatchHammer: async evidence => { calls.dispatch.push(evidence); return { dispatched: true }; },
    pageImpl: async (...page) => calls.pages.push(page),
    requestRereviewImpl: async request => { calls.reviews.push(request); return { triggered: true }; } };
  return { args, calls, tick: overrides => recoverOrphan({ ...args, ...overrides }) };
}
for (const pr of [7707, 7716, 7704]) test(`#${pr} replay waits six observations and launches one HAM`, async t => {
  const { tick, calls } = setup(t, pr);
  for (let i = 0; i < 5; i++) { await tick(); assert.equal(calls.dispatch.length, 0); }
  assert.equal((await tick()).outcome, 'ama-dispatched');
  assert.equal(calls.dispatch.length, 1);
  assert.equal(calls.dispatch[0].primaryRepair, pr === 7716);
  assert.equal(calls.dispatch[0].closerHead, pr === 7704);
  await tick({ hasOwnerImpl: async () => true });
  assert.equal(calls.dispatch.length, 1);
});
for (const owner of ['remediator', 'closer', 'merge-agent', 'reviewer']) test(`live ${owner} resets consecutive ticks`, async t => {
  const { tick, calls } = setup(t);
  for (let i = 0; i < 5; i++) await tick();
  await tick({ hasOwnerImpl: async () => true });
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(calls.dispatch.length, 0);
});
for (const label of ['do-not-merge', 'no-merge-hold', 'merge-agent-skip']) test(`${label} forbids dispatch`, async t => {
  const { tick, calls } = setup(t);
  for (let i = 0; i < 8; i++) await tick({ labels: [label] });
  assert.equal(calls.dispatch.length, 0);
});
test('two failed attempts exhaust durably and page once with evidence', async t => {
  const { tick, calls } = setup(t);
  const failure = { dispatchHammer: async () => { calls.dispatch.push('failed'); return { dispatched: false, reason: 'failed' }; } };
  for (let i = 0; i < 25; i++) await tick(failure);
  assert.equal(calls.dispatch.length, 2);
  assert.equal(calls.pages.length, 1);
  assert.equal(calls.pages[0][1].payload.attempts, 2);
  assert.equal(calls.pages[0][1].payload.lastAttempt.reason, 'failed');
});
test('uncertifiable closer head requests one exact-head review', async t => {
  const { tick, calls } = setup(t, 7704);
  for (let i = 0; i < 20; i++) await tick({ dispatchHammer: async () => ({ dispatched: false, reason: 'cannot-recertify' }) });
  assert.equal(calls.reviews.length, 1);
  assert.equal(calls.reviews[0].targetRevisionRef, 'current-head');
});
test('external stale head cannot enter orphan HAM route', async t => {
  const { tick, calls } = setup(t, 7704);
  for (let i = 0; i < 8; i++) await tick({ closerHeadImpl: async () => ({ suppressed: false }) });
  assert.equal(calls.dispatch.length, 0);
});
for (const override of [{ candidate: { prState: 'closed' } }, { candidate: { prState: 'merged' } },
  { candidate: { prState: 'open', isDraft: true } }, { result: { amaEnabled: true, reasons: ['security-hold'] } }]) {
  test(`terminal/draft/safety state: ${JSON.stringify(override)}`, async t => {
    const { tick, calls } = setup(t);
    for (let i = 0; i < 8; i++) await tick(override);
    assert.equal(calls.dispatch.length, 0);
  });
}
test('cross-head closer and merge-agent ledger probes fail closed', async t => {
  const { args } = setup(t);
  for (const bucket of ['ama-closer-dispatches', 'merge-agent-dispatches']) {
    const dir = join(args.rootDir, 'data', 'follow-up-jobs', bucket);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'example__repo-pr-7707-old.json'), JSON.stringify({ repo: args.repo, prNumber: args.prNumber,
      headSha: 'older-head', launchRequestId: 'lrq-live' }));
    assert.equal(await hasOrphanOwner({ ...args, readStatusImpl: async () => ({ ok: true, row: { status: 'running' } }) }), true);
    assert.equal(await hasOrphanOwner({ ...args, readStatusImpl: async () => ({ ok: false }) }), true);
    rmSync(dir, { recursive: true });
  }
});
test('pending remediation job and reviewer queue retain ownership', async t => {
  const { args } = setup(t);
  assert.equal(await hasOrphanOwner({ ...args, reviewStateRow: { review_status: 'reviewing' } }), true);
  const dir = join(args.rootDir, 'data', 'follow-up-jobs', 'pending');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'job.json'), JSON.stringify({ repo: args.repo, prNumber: args.prNumber }));
  assert.equal(await hasOrphanOwner(args), true);
});
test('concurrent observers serialize dispatch and restart preserves attempt budget', async t => {
  const { tick, calls } = setup(t);
  for (let i = 0; i < 5; i++) await tick();
  await Promise.all([tick(), tick(), tick()]);
  assert.equal(calls.dispatch.length, 1);
});

test('watcher coexistence invokes orphan recovery on sixth tick', async t => {
  const { resolveMergeAgentCoexistenceForWatcher } = await import('../src/ama-closure-orchestration.mjs');
  for (const pr of [7707, 7716, 7704]) {
    const { args, calls } = setup(t, pr);
    const input = { rootDir: args.rootDir, repoPath: args.repo, prNumber: pr,
      candidate: args.candidate, currentRevisionRef: args.headSha,
      reviewStateRow: args.reviewStateRow, dispatchJob: args.dispatchJob,
      maybeDispatchAmaClosureForImpl: async options => {
        if (options.orphanRecovery) { calls.dispatch.push(options.orphanRecovery); return { dispatched: true }; }
        return args.result;
      },
      orphanOptions: { hasOwnerImpl: args.hasOwnerImpl, closerHeadImpl: args.closerHeadImpl,
        pageImpl: args.pageImpl, requestRereviewImpl: args.requestRereviewImpl },
      logger: { info() {}, warn() {} } };
    for (let i = 0; i < 5; i++) await resolveMergeAgentCoexistenceForWatcher(input);
    assert.equal(calls.dispatch.length, 0);
    assert.equal((await resolveMergeAgentCoexistenceForWatcher(input)).outcome, 'ama-dispatched');
    assert.equal(calls.dispatch.length, 1);
  }
});
test('head change resets tick streak and never refunds a previous head budget', async t => {
  const { tick, calls } = setup(t);
  const fail = { dispatchHammer: async () => { calls.dispatch.push('failed'); return { dispatched: false }; } };
  for (let i = 0; i < 12; i++) await tick(fail);
  await tick({ ...fail, headSha: 'new-head', candidate: { prState: 'open', headSha: 'new-head' } });
  await tick(fail);
  assert.equal(calls.dispatch.length, 2);
  assert.equal(calls.pages.length, 1);
});
test('exhaustion still pages when ordinary HAM retry cap takes over', async t => {
  const { tick, calls } = setup(t);
  for (let i = 0; i < 12; i++) await tick({ dispatchHammer: async () => ({ dispatched: false }) });
  await tick({ result: { amaEnabled: true, reason: 'dispatch-retry-exhausted' } });
  assert.equal(calls.pages.length, 1);
});
test('page enqueue failure retries delivery without another HAM', async t => {
  const { args, tick, calls } = setup(t);
  for (let i = 0; i < 12; i++) await tick({ dispatchHammer: async () => { calls.dispatch.push('failed'); return { dispatched: false }; } });
  await tick({ pageImpl: async () => { throw new Error('outbox unavailable'); }, logger: { warn() {} } });
  assert.equal(readWatchdog(args).pageError, 'outbox unavailable');
  await tick();
  await tick();
  assert.equal(calls.pages.length, 1);
  assert.equal(calls.dispatch.length, 2);
});
test('raced live-owner refusal refunds reserved attempt', async t => {
  const { tick, calls } = setup(t);
  for (let i = 0; i < 18; i++) await tick({ dispatchHammer: async () => ({ dispatched: false, reason: 'active-remediation-job' }) });
  assert.equal(calls.pages.length, 0);
  for (let i = 0; i < 6; i++) await tick();
  assert.equal(calls.dispatch.length, 1);
});
test('terminal merge-agent ledger defeats stale dispatched label', async t => {
  const { args } = setup(t);
  const dir = join(args.rootDir, 'data', 'follow-up-jobs', 'merge-agent-dispatches');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'example__repo-pr-7707-old.json'), JSON.stringify({ repo: args.repo, prNumber: args.prNumber, launchRequestId: 'terminal-lrq' }));
  assert.equal(await hasOrphanOwner({ ...args, labels: ['merge-agent-dispatched'],
    readStatusImpl: async () => ({ ok: true, row: { status: 'failed' } }) }), false);
});

function watchdogPath(args) {
  const key = createHash('sha256').update(`${args.repo}#${args.prNumber}`).digest('hex');
  return join(args.rootDir, 'data', 'follow-up-jobs', 'orphan-watchdog', `${key}.db`);
}
function readWatchdog(args) {
  const db = new Database(watchdogPath(args));
  try { return db.prepare('SELECT * FROM heads WHERE head=?').get(args.headSha); }
  finally { db.close(); }
}
for (const dispatchJob of [
  { remediationStopCode: 'operator-stop', remediationRound: 1, remediationPlan: { maxRounds: 2 } },
  { remediationStopCode: 'unknown-stop', remediationRound: 1, remediationPlan: { maxRounds: 2 } },
  {}, { remediationRound: 1 }, { remediationPlan: { currentRound: '', maxRounds: 2 } },
]) test(`explicit stops and missing round budgets forbid orphan dispatch: ${JSON.stringify(dispatchJob)}`, async t => {
  const { tick, calls } = setup(t);
  for (let i = 0; i < 15; i++) assert.equal(await tick({ dispatchJob }), null);
  assert.equal(calls.dispatch.length, 0);
  assert.equal(calls.pages.length, 0);
});
test('an explicit persisted round below max remains eligible', async t => {
  const { tick, calls } = setup(t);
  for (let i = 0; i < 6; i++) await tick({ dispatchJob: { remediationPlan: { currentRound: 1, maxRounds: 2 } } });
  assert.equal(calls.dispatch.length, 1);
});
test('proven pre-launch gate refusal refunds the reservation', async t => {
  const { args, tick, calls } = setup(t);
  for (let i = 0; i < 18; i++) await tick({ dispatchHammer: async () => ({ dispatched: false, reason: 'gate-read-failed' }) });
  assert.equal(readWatchdog(args).attempts, 0);
  assert.equal(readWatchdog(args).reserved, 0);
  assert.equal(calls.pages.length, 0);
});
for (const failure of ['timeout', 'github-transient', 'abort']) test(`${failure} after launch retains the charged attempt`, async t => {
  const { args, tick, calls } = setup(t);
  for (let i = 0; i < 5; i++) await tick();
  await tick({ dispatchHammer: async () => {
    dispatchRecord(args, { dispatchedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') });
    throw Object.assign(new Error('launch accepted but follow-up failed'), failure === 'timeout'
      ? { code: 'AMA_COEXISTENCE_OPERATION_TIMEOUT' } : failure === 'abort' ? { name: 'AbortError' } : { code: 'ECONNRESET' });
  } });
  assert.equal(readWatchdog(args).attempts, 1);
  assert.equal(readWatchdog(args).reserved, 1);
  const probe = options => probeOrphanOwnership({ ...options,
    readStatusImpl: async () => ({ ok: true, row: { status: 'failed' } }) });
  await tick({ hasOwnerImpl: probe });
  assert.equal(readWatchdog(args).attempts, 1);
  assert.equal(readWatchdog(args).reserved, 0);
  assert.equal(calls.dispatch.length, 0);
});
test('signal abort after dispatch begins preserves reservation before propagating cancellation', async t => {
  const { args, tick } = setup(t);
  const controller = new AbortController();
  for (let i = 0; i < 5; i++) await tick();
  await assert.rejects(tick({ signal: controller.signal, dispatchHammer: async () => {
    controller.abort(new Error('watcher bounce')); throw controller.signal.reason;
  } }), /watcher bounce/);
  assert.equal(readWatchdog(args).attempts, 1);
  assert.equal(readWatchdog(args).reserved, 1);
});
test('signal abort before dispatch starts refunds without invoking HAM', async t => {
  const { args, tick, calls } = setup(t);
  const controller = new AbortController();
  for (let i = 0; i < 5; i++) await tick();
  await assert.rejects(tick({ signal: controller.signal, hasOwnerImpl: async () => {
    controller.abort(new Error('watcher bounce')); return false;
  } }), /watcher bounce/);
  assert.equal(readWatchdog(args).attempts, 0);
  assert.equal(readWatchdog(args).reserved, 0);
  assert.equal(calls.dispatch.length, 0);
});
function dispatchRecord(args, record, bucket = 'ama-closer-dispatches', suffix = 'old') {
  const dir = join(args.rootDir, 'data', 'follow-up-jobs', bucket);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `example__repo-pr-${args.prNumber}-${suffix}.json`), JSON.stringify({
    repo: args.repo, prNumber: args.prNumber, headSha: args.headSha, state: 'dispatched', launchRequestId: 'lrq-old', ...record,
  }));
}
for (const status of ['operator_triage_required', 'reaped_stuck_requested', 'reaped', 'completed', 'rejected']) {
  test(`${status} is terminal ownership evidence`, async t => {
    const { args, tick, calls } = setup(t);
    dispatchRecord(args, {});
    const probe = options => probeOrphanOwnership({ ...options, readStatusImpl: async () => ({ ok: true, row: { status } }) });
    assert.equal(await hasOrphanOwner({ ...args, readStatusImpl: async () => ({ ok: true, row: { status } }) }), false);
    for (let i = 0; i < 6; i++) await tick({ hasOwnerImpl: probe });
    assert.equal(calls.dispatch.length, 1);
  });
}
for (const kind of ['missing-row', 'corrupt-record', 'missing-id']) test(`${kind} ownership pages after six ticks without dispatch`, async t => {
  const { args, tick, calls } = setup(t);
  dispatchRecord(args, kind === 'missing-id' ? { launchRequestId: null } : {});
  if (kind === 'corrupt-record') writeFileSync(join(args.rootDir, 'data/follow-up-jobs/ama-closer-dispatches', `example__repo-pr-${args.prNumber}-old.json`), '{bad');
  const probe = options => probeOrphanOwnership({ ...options, readStatusImpl: async () => ({ ok: false, reason: 'missing-launch-request-row' }) });
  for (let i = 0; i < 5; i++) await tick({ hasOwnerImpl: probe });
  assert.equal(calls.pages.length, 0);
  for (let i = 0; i < 5; i++) await tick({ hasOwnerImpl: probe });
  assert.equal(calls.pages.length, 1);
  assert.equal(calls.pages[0][1].event, 'ama.orphan_recovery.ownership-uncertain');
  assert.equal(calls.dispatch.length, 0);
  assert.equal(readWatchdog(args).attempts, 0);
});
test('terminal successor lease releases an unrepaired historical source record', async t => {
  const { args } = setup(t);
  dispatchRecord(args, { headSha: 'old-head' });
  const dir = join(args.rootDir, 'data/ama-closer-leases');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `example__repo-pr-${args.prNumber}-successor.json`), JSON.stringify({
    repo: args.repo, prNumber: args.prNumber, headSha: 'successor', status: 'terminal', supersededHeads: ['old-head'],
  }));
  assert.equal(await hasOrphanOwner({ ...args, readStatusImpl: () => { throw new Error('obsolete source must not probe'); } }), false);
});
test('fleet history is filtered before parsing or probing', async t => {
  const { args } = setup(t);
  dispatchRecord(args, {});
  const dir = join(args.rootDir, 'data/follow-up-jobs/ama-closer-dispatches');
  for (let i = 0; i < 100; i++) writeFileSync(join(dir, `other__repo-pr-${i}-old.json`), '{bad');
  let probes = 0;
  const ownership = await probeOrphanOwnership({ ...args, readStatusImpl: async () => {
    probes++; return { ok: true, row: { status: 'failed' } };
  } });
  assert.equal(probes, 1);
  assert.equal(ownership.uncertain, false);
});
for (const launched of [false, true]) test(`interrupted reservation reconciles ${launched ? 'launch evidence' : 'no launch'}`, async t => {
  const { args, tick, calls } = setup(t);
  await tick();
  const db = new Database(watchdogPath(args));
  db.prepare('UPDATE heads SET attempts=1,reserved=1,evidence=? WHERE head=?').run(JSON.stringify({
    reservationStartedAt: '2026-10-04T00:00:00Z', reason: 'reserved-outcome-unknown',
  }), args.headSha);
  db.close();
  if (launched) dispatchRecord(args, { dispatchedAt: '2026-10-04T00:01:00Z' });
  await tick({ hasOwnerImpl: options => probeOrphanOwnership({ ...options,
    readStatusImpl: async () => ({ ok: true, row: { status: 'failed' } }) }) });
  assert.equal(readWatchdog(args).reserved, 0);
  assert.equal(readWatchdog(args).attempts, launched ? 1 : 0);
  assert.equal(calls.dispatch.length, 0);
});
test('exhaustion payload contains bounded summaries without review bodies', async t => {
  const { tick, calls } = setup(t);
  for (let i = 0; i < 13; i++) await tick({
    reviewStateRow: { review_status: 'posted', review_body: 'untrusted-review'.repeat(10000) },
    dispatchHammer: async () => ({ dispatched: false, reason: 'failure', reviewBody: 'untrusted-worker'.repeat(10000) }),
  });
  const payload = calls.pages[0][1].payload;
  assert.equal(payload.reviewStateRow, undefined);
  assert.equal(payload.dispatchJob, undefined);
  assert.equal(payload.result, undefined);
  assert.ok(JSON.stringify(payload).length < 2000);
});
test('operator merge-agent request preempts watchdog recovery through exhaustion', async t => {
  const { resolveMergeAgentCoexistenceForWatcher } = await import('../src/ama-closure-orchestration.mjs');
  const { args, tick, calls } = setup(t, 7716);
  for (let i = 0; i < 12; i++) await tick({ dispatchHammer: async () => ({ dispatched: false }) });
  const input = { rootDir: args.rootDir, repoPath: args.repo, prNumber: args.prNumber,
    candidate: args.candidate, currentRevisionRef: args.headSha, reviewStateRow: args.reviewStateRow,
    dispatchJob: args.dispatchJob, labelNames: ['merge-agent-requested'],
    mergeAgentRequestEvent: { id: 'event', headSha: args.headSha, actor: 'operator', createdAt: '2026-10-04T00:00:00Z' },
    maybeDispatchAmaClosureForImpl: async () => ({ ...args.result, needsOperator: true, skipMergeAgent: true }),
    recoverOrphanImpl: () => { throw new Error('operator request must bypass watchdog'); },
    logger: { info() {}, warn() {}, log() {} },
  };
  for (let i = 0; i < 8; i++) assert.equal((await resolveMergeAgentCoexistenceForWatcher(input)).outcome, 'dispatch-merge-agent');
  assert.equal(calls.dispatch.length, 0);
  assert.equal(calls.pages.length, 0);
});
test('watchdog migrates legacy head rows without resetting their attempt budgets', async t => {
  const { args, tick } = setup(t);
  mkdirSync(join(args.rootDir, 'data/follow-up-jobs/orphan-watchdog'), { recursive: true });
  const db = new Database(watchdogPath(args));
  db.exec('CREATE TABLE heads (head TEXT PRIMARY KEY, ticks INTEGER DEFAULT 0, attempts INTEGER DEFAULT 0, paged INTEGER DEFAULT 0, rereview INTEGER DEFAULT 0, evidence TEXT)');
  db.prepare('INSERT INTO heads(head,attempts) VALUES (?,2)').run(args.headSha);
  db.close();
  assert.equal((await tick()).outcome, 'recovery-exhausted');
  assert.equal(readWatchdog(args).attempts, 2);
  assert.equal(readWatchdog(args).reserved, 0);
  assert.equal(readWatchdog(args).paged, 1);
});
test('synchronous ledger subprocess timeout honors the ownership budget', async t => {
  const { args } = setup(t);
  dispatchRecord(args, {});
  const start = Date.now();
  const ownership = await probeOrphanOwnership({ ...args, timeoutMs: 50,
    readStatusImpl: ({ spawnSyncImpl }) => {
      const child = spawnSyncImpl(process.execPath, ['-e', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000)'],
        { timeout: 30000, killSignal: 'SIGKILL' });
      assert.equal(child.error?.code, 'ETIMEDOUT');
      return { ok: false, reason: 'ledger-read-timeout' };
    },
  });
  assert.equal(ownership.uncertain, true);
  assert.ok(Date.now() - start < 1500, 'probe must not inherit the 30s ledger timeout');
});
test('coexistence ownership operation timeout holds dispatch and pages uncertainty', async t => {
  const { resolveMergeAgentCoexistenceForWatcher } = await import('../src/ama-closure-orchestration.mjs');
  const { args, calls } = setup(t);
  const input = { rootDir: args.rootDir, repoPath: args.repo, prNumber: args.prNumber,
    candidate: args.candidate, currentRevisionRef: args.headSha,
    reviewStateRow: args.reviewStateRow, dispatchJob: args.dispatchJob, operationTimeoutMs: 5,
    maybeDispatchAmaClosureForImpl: async () => args.result,
    orphanOptions: { hasOwnerImpl: () => new Promise(() => {}), pageImpl: args.pageImpl },
    logger: { info() {}, warn() {} } };
  for (let i = 0; i < 6; i++) assert.equal((await resolveMergeAgentCoexistenceForWatcher(input)).outcome, 'ama-pending');
  assert.equal(calls.pages.length, 1);
  assert.equal(calls.dispatch.length, 0);
});

for (const head of ['old-head', 'current-head']) test(`stale dispatching on ${head} pages uncertainty and retains reservations`, async t => {
  const { args, tick, calls } = setup(t, 7716);
  await tick();
  const db = new Database(watchdogPath(args));
  db.prepare('UPDATE heads SET attempts=1,reserved=1,evidence=? WHERE head=?').run(JSON.stringify({
    reservationStartedAt: '2026-10-04T00:00:00.123Z', reason: 'reserved-outcome-unknown',
  }), args.headSha);
  db.close();
  dispatchRecord(args, { headSha: head, state: 'dispatching', launchRequestId: null, lastAttemptedAt: '2026-10-04T00:00:00Z' });
  const leasePath = amaCloserLeaseFilePath(args.rootDir, { ...args, headSha: head });
  mkdirSync(join(args.rootDir, 'data/ama-closer-leases'), { recursive: true });
  writeFileSync(leasePath, JSON.stringify({ ...args, headSha: head, status: 'pending', watcherPid: 42,
    acquiredAt: '2026-10-04T00:00:00Z' }));
  const probe = options => probeOrphanOwnership({ ...options, now: '2026-10-04T01:00:00Z',
    processKillImpl: () => { throw Object.assign(new Error('dead'), { code: 'ESRCH' }); },
    readStatusImpl: () => { throw new Error('no launch id to probe'); } });
  assert.equal((await probe(args)).owned, false);
  for (let i = 0; i < 7; i++) await tick({ hasOwnerImpl: probe });
  assert.equal(calls.dispatch.length, 0);
  assert.equal(calls.pages.length, 1);
  assert.equal(calls.pages[0][1].event, 'ama.orphan_recovery.ownership-uncertain');
  assert.equal(readWatchdog(args).attempts, 1);
  assert.equal(readWatchdog(args).reserved, 1);
});
for (const kind of ['live', 'dead-pid', 'expired', 'missing', 'corrupt']) test(`${kind} pending lease classifies dispatching ownership`, async t => {
  const { args } = setup(t);
  const now = '2026-10-04T01:00:00Z';
  dispatchRecord(args, { state: 'dispatching', launchRequestId: null, lastAttemptedAt: now });
  mkdirSync(join(args.rootDir, 'data/ama-closer-leases'), { recursive: true });
  if (kind !== 'missing') writeFileSync(amaCloserLeaseFilePath(args.rootDir, args), kind === 'corrupt' ? '{bad'
    : JSON.stringify({ status: 'pending', watcherPid: 42, acquiredAt: kind === 'expired' ? '2026-10-04T00:00:00Z' : now }));
  const ownership = await probeOrphanOwnership({ ...args, now: kind === 'missing' ? '2026-10-04T01:01:00Z' : now,
    processKillImpl: () => { if (kind === 'dead-pid') throw Object.assign(new Error('dead'), { code: 'ESRCH' }); } });
  assert.equal(ownership.owned, kind === 'live');
  assert.equal(ownership.uncertain, kind !== 'live');
});
for (const state of ['dispatched', 'no-dispatch']) test(`second-truncated ${state} receipt reconciles before live-owner return`, async t => {
  const { args, tick } = setup(t);
  await tick();
  const db = new Database(watchdogPath(args));
  db.prepare('UPDATE heads SET attempts=1,reserved=1,evidence=? WHERE head=?').run(JSON.stringify({
    reservationStartedAt: '2026-10-04T00:00:00.789Z',
  }), args.headSha);
  db.close();
  dispatchRecord(args, { state, dispatchedAt: state === 'dispatched' ? '2026-10-04T00:00:00Z' : null,
    lastAttemptedAt: '2026-10-04T00:00:00Z' });
  await tick({ hasOwnerImpl: options => probeOrphanOwnership({ ...options,
    readStatusImpl: async () => ({ ok: true, row: { status: 'running' } }) }) });
  assert.equal(readWatchdog(args).reserved, 0);
  assert.equal(readWatchdog(args).attempts, 1);
});
test('background observations preserve the eligible tick streak', async t => {
  const { tick, calls } = setup(t);
  for (let i = 0; i < 6; i++) {
    await tick({ result: { amaEnabled: true, reason: 'ama-closer-dispatch-backgrounded', skipMergeAgent: true } });
    await tick();
  }
  assert.equal(calls.dispatch.length, 1);
});
test('unreadable primary-change evidence pages uncertainty without repair admission', async t => {
  const { args, tick, calls } = setup(t, 7716);
  assert.equal(orphanDispatchReasonsCovered(['primary-change-unknown']), false);
  for (let i = 0; i < 7; i++) await tick({ result: { ...args.result, reasons: ['primary-change-unknown', 'ci-not-green'] } });
  assert.equal(calls.dispatch.length, 0);
  assert.equal(calls.pages.length, 1);
  assert.equal(calls.pages[0][1].event, 'ama.orphan_recovery.ownership-uncertain');
  assert.ok(calls.pages[0][1].payload.ownershipReasons.includes('primary-change-unknown'));
});
test('empty head observations leave real head streaks and rows intact', async t => {
  const { args, tick, calls } = setup(t);
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(await tick({ headSha: '' }), null);
  assert.equal(readWatchdog(args).ticks, 5);
  const db = new Database(watchdogPath(args));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM heads').get().count, 1);
  db.close();
  await tick();
  assert.equal(calls.dispatch.length, 1);
});
for (const failure of ['mkdir-EACCES', 'open-ENOSPC', 'flock-EACCES', 'database-EACCES', 'update-ENOSPC', 'corrupt-database', 'malformed-evidence']) {
  for (const eligible of failure === 'malformed-evidence' ? [true] : [true, false]) test(`${failure} on ${eligible ? 'eligible' : 'ineligible'} tick retains coexistence hold`, async t => {
    const { resolveMergeAgentCoexistenceForWatcher } = await import('../src/ama-closure-orchestration.mjs');
    const { args, tick, calls } = setup(t, 7716);
    await tick();
    const warnings = [];
    const options = { ...args, logger: { info() {}, warn: message => warnings.push(message) } };
    const fail = code => { throw Object.assign(new Error(`injected ${code}`), { code }); };
    if (failure === 'mkdir-EACCES' || failure === 'open-ENOSPC') options.fsImpl = { existsSync, mkdirSync, openSync, closeSync,
      ...(failure === 'mkdir-EACCES' ? { mkdirSync: () => fail('EACCES') } : { openSync: () => fail('ENOSPC') }) };
    if (failure === 'flock-EACCES') options.flockSyncImpl = () => fail('EACCES');
    if (failure === 'database-EACCES') options.DatabaseImpl = class { constructor() { fail('EACCES'); } };
    if (failure === 'update-ENOSPC') options.DatabaseImpl = class {
      constructor(path) {
        const db = new Database(path);
        const prepare = db.prepare.bind(db);
        db.prepare = sql => sql.startsWith('UPDATE heads') ? { run: () => fail('ENOSPC') } : prepare(sql);
        return db;
      }
    };
    if (failure === 'corrupt-database') writeFileSync(watchdogPath(args), 'not a sqlite database');
    if (failure === 'malformed-evidence') {
      const db = new Database(watchdogPath(args));
      db.prepare('UPDATE heads SET evidence=?').run('{bad');
      db.close();
    }
    const result = eligible ? { ...args.result, skipMergeAgent: false } : { amaEnabled: false, reason: 'not-eligible' };
    const output = await resolveMergeAgentCoexistenceForWatcher({ rootDir: args.rootDir, repoPath: args.repo,
      prNumber: args.prNumber, candidate: args.candidate, currentRevisionRef: args.headSha,
      dispatchJob: args.dispatchJob, reviewStateRow: args.reviewStateRow, logger: options.logger,
      maybeDispatchAmaClosureForImpl: async () => result, orphanOptions: { ...options, result },
      recoverAmaAutomationImpl: () => { throw new Error('failed store must retain hold'); } });
    assert.equal(output.outcome, 'ama-pending');
    assert.equal(output.amaClosureResult.skipMergeAgent, true);
    assert.equal(calls.dispatch.length, 0);
    assert.equal(calls.pages.length, 1);
    assert.equal(calls.pages[0][1].event, 'ama.orphan_recovery.store-error');
    assert.ok(warnings.some(message => message.includes('Orphan recovery failed')));
    if (!['corrupt-database', 'malformed-evidence'].includes(failure)) {
      // The failed path closed both DB and flock, so an ordinary tick can resume.
      await tick();
      assert.equal(readWatchdog(args).ticks, 2);
    }
  });
}
test('store error plus pager failure remains held and logs both failures', async t => {
  const { tick } = setup(t);
  const warnings = [];
  const output = await tick({ DatabaseImpl: class { constructor() { throw new Error('database corrupt'); } },
    pageImpl: async () => { throw new Error('pager unavailable'); }, logger: { warn: message => warnings.push(message) } });
  assert.equal(output.outcome, 'ama-pending');
  assert.equal(output.amaClosureResult.skipMergeAgent, true);
  assert.equal(warnings.length, 2);
});
