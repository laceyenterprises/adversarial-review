import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordLiveShadow, liveV1Action } from '../src/finalization/live-shadow.mjs';
import { openFinalizationShadowStore, openReadOnlyFinalizationShadowStore } from '../src/finalization/shadow-store.mjs';
import { openFinalizationLedgerStore } from '../src/finalization/ledger-store.mjs';
import { buildShadowReport, buildMlrPromotionGate } from '../src/finalization/shadow-report.mjs';
import { closureOwnerShadowEvidence } from '../src/pr-next-action-consumer.mjs';
import { deriveNextActionSnapshot, nextAction } from '../src/pr-next-action.mjs';
import { shadowNextAction } from '../src/pr-next-action-shadow.mjs';

const now = '2026-08-20T00:00:00.000Z';
const complete = value => ({ state: 'complete', value, provenance: { sourceRef: 'fixture:read' } });
function snapshot(head = 'head-a', at = now, base = 'main') {
  return { subjectKey: 'example/repo#1', head, observedAt: at, passId: `pass:${at}`, observations: {
    pr: complete({ headSha: head, baseBranch: base, state: 'open', mergeable: 'MERGEABLE' }),
    reviews: complete({ headSha: head, verdict: 'approved', blockingFindingState: 'known',
      nonBlockingFindingState: 'known', blockingFindingCount: 0, nonBlockingFindingCount: 0 }),
    checks: complete({ headSha: head, requiredContexts: ['unit'], rollup: [
      { name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: at },
    ] }),
  } };
}
function fixture(t) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  const shadowStore = openFinalizationShadowStore({ db });
  const ledger = openFinalizationLedgerStore({ db });
  const record = (s, legacy = { action: 'daemon-merge', reason: 'merged-this-pass' }) =>
    recordLiveShadow({ snapshot: s, legacy, repo: 'example/repo', prNumber: 1, source: 'fixture', shadowStore });
  return { db, ledger, shadowStore, record };
}

test('live ingestion atomically replays once and compares the existing fold on every lane', t => {
  const { ledger, shadowStore, record } = fixture(t);
  for (const base of ['main', 'release']) {
    const s = snapshot('head-a', now, base);
    const first = record(s);
    assert.equal(record(s).id, first.id);
    assert.equal(first.live.lane.base, base);
    assert.equal(first.v2Decision.kind, 'wait');
    assert.equal(first.v2Decision.reason, 'primary-change provenance unavailable');
    assert.equal(first.classification.relation, 'diverge');
  }
  assert.equal(shadowStore.read().length, 2);
  const events = ledger.read({ domainId: 'code-pr', subjectExternalId: 'example/repo#1' });
  assert.equal(events.filter(e => e.type === 'revision_advanced').length, 1);
  assert.equal(events.filter(e => e.type === 'verdict_recorded').length, 1);
  assert.ok(events.every(e => e.idempotencyKey && e.sourceRef));
  assert.equal(shadowStore.read()[0].live.source, 'organic');
  assert.ok(shadowStore.read()[0].dedupeKey);
  assert.throws(() => shadowStore.annotate(1, { disposition: 'resolved', at: now }), /triage requires/);
  const report = buildShadowReport({ observations: shadowStore.read(), now });
  assert.deepEqual(report.shadow.lanes.map(l => l.lane.base), ['main', 'release']);
  assert.ok(report.shadow.lanes.every(l => l.consumer.build.startsWith('sha256:')));
});

test('same-head polls retain the first revision anchor and expire missing-check patience', t => {
  const { record, ledger } = fixture(t);
  const first = snapshot();
  first.observations.checks = { state: 'unknown', value: null };
  assert.equal(record(first).v2Decision.kind, 'wait');
  const later = snapshot('head-a', '2026-08-20T00:31:00Z');
  later.observations.checks = { state: 'unknown', value: null };
  assert.equal(record(later).v2Decision.kind, 'escalate');
  const events = ledger.read({ domainId: 'code-pr', subjectExternalId: 'example/repo#1' });
  assert.equal(events.filter(e => e.type === 'revision_advanced').length, 1);
});

test('head moves retain budget history; repeated polls never become distinct finalizations', t => {
  const { record, shadowStore } = fixture(t);
  const s = snapshot();
  s.observations.policy = complete({ reviewCeilingReached: true });
  record(s, { action: 'hammer', legacyReason: 'dispatched' });
  const landed = snapshot('head-b', '2026-08-20T00:01:00.000Z');
  const o = record(landed);
  assert.equal(o.sawHeadMove, true);
  assert.equal(o.sawExhaustion, true);
  const report = buildMlrPromotionGate([...shadowStore.read(), o, o], '2026-08-21T00:00:00Z');
  assert.equal(report.finalizations, 1);
  assert.equal(report.headMoves, 1);
  assert.equal(report.exhaustionCloses, 1);
});

test('fold or evidence errors persist escalate and cannot auto-clear the gate', t => {
  const { db, record, shadowStore } = fixture(t);
  record(snapshot());
  db.prepare("UPDATE finalization_ledger SET payload_json='{}' WHERE event_type='verdict_recorded'").run();
  const o = record(snapshot('head-b', '2026-08-20T00:02:00Z'));
  assert.equal(o.foldError, true);
  assert.equal(o.v2Decision.kind, 'escalate');
  assert.equal(o.classification.disposition, 'open');
  assert.equal(shadowStore.read().at(-1).v2Decision.kind, 'escalate');
  assert.equal(buildMlrPromotionGate(shadowStore.read(), now).promotable, false);
});

test('unknown required set cannot produce green; live divergences stay bidirectional', t => {
  const { record } = fixture(t);
  const s = snapshot();
  delete s.observations.checks.value.requiredContexts;
  s.observations.checks.value.conclusion = 'SUCCESS';
  const o = record(s);
  assert.notEqual(o.v2Decision.kind, 'finalize-now');
  assert.equal(o.classification.disposition, 'open');
  assert.equal(o.classification.direction, 'open');
  assert.equal(liveV1Action({ action: 'hammer', reason: 'live-owner' }, 'fixture').kind, 'wait');
  assert.equal(liveV1Action({ action: 'daemon-merge', reason: 'clean-exact-head' }, 'fixture').kind, 'wait');
});

test('unreadable refresh cannot reuse earlier green checks; holds and the brake remain authoritative', t => {
  const { record } = fixture(t);
  record(snapshot());
  const failed = snapshot('head-a', '2026-08-20T00:01:00Z');
  failed.observations.checks = { state: 'unknown', value: null };
  assert.equal(record(failed).v2Decision.kind, 'escalate');
  const held = snapshot('head-b', '2026-08-20T00:02:00Z');
  held.observations.pr.value.labels = ['no-merge-hold'];
  assert.equal(record(held).v2Decision.kind, 'escalate');
  const disabled = snapshot('head-c', '2026-08-20T00:03:00Z');
  disabled.observations.policy = complete({ autonomousMergeExecutionEnabled: false });
  assert.equal(record(disabled).v2Decision.kind, 'escalate');
});

test('out-of-order observations escalate without moving the ledger back to an older head', t => {
  const { record, ledger } = fixture(t);
  record(snapshot('head-b', '2026-08-20T00:01:00Z'));
  assert.equal(record(snapshot()).v2Decision.kind, 'escalate');
  const events = ledger.read({ domainId: 'code-pr', subjectExternalId: 'example/repo#1' });
  assert.equal(events.filter(e => e.type === 'revision_advanced').at(-1).revisionRef, 'head-b');
});

test('added snapshot metadata does not change the executing next-action decision', () => {
  const evidence = closureOwnerShadowEvidence({ currentHead: 'head-a' }, {
    subjectKey: 'example/repo#1', observedAt: now,
    candidate: { headSha: 'head-a', prState: 'open', baseBranch: 'release',
      branchProtection: { ok: true, requiredContexts: ['not-reported'] } },
    checksRollup: [{ name: 'unit', conclusion: 'SUCCESS' }],
  });
  const enriched = deriveNextActionSnapshot(evidence);
  const original = structuredClone(enriched);
  delete original.observations.pr.value.baseBranch;
  delete original.observations.checks.value.headSha;
  delete original.observations.checks.value.finalizationRequiredContexts;
  assert.deepEqual(nextAction(enriched), nextAction(original));
});

test('confirmed execution results override selected ownership without counting dispatch as a finalization', t => {
  const { shadowStore } = fixture(t);
  const shared = { snapshot: snapshot(), legacy: { action: 'hammer', reason: 'live-owner' },
    source: 'fixture', repo: 'example/repo', prNumber: 1, shadowStore };
  const waiting = recordLiveShadow(shared);
  const dispatched = recordLiveShadow({ ...shared, v1Action: { kind: 'hammer-dispatch' } });
  assert.equal(waiting.v1Action.kind, 'wait');
  assert.equal(dispatched.v1Action.kind, 'hammer-dispatch');
  assert.notEqual(waiting.id, dispatched.id);
  assert.equal(buildMlrPromotionGate(shadowStore.read(), now).finalizations, 0);
});

test('the existing next-action observer persists its confirmed action through the live composition', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'finalization-live-shadow-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const s = snapshot();
  const result = await shadowNextAction({ source: 'fixture-observer',
    legacy: { action: 'hammer', actor: 'hammer', reason: 'live-owner' },
    finalizationV1Action: { kind: 'hammer-dispatch' },
    shared: { snapshot: s, decision: nextAction(s) }, rootDir,
    repo: 'example/repo', prNumber: 1, now: () => Date.parse(now), env: {}, sink: async () => {} });
  assert.ok(result);
  const store = openReadOnlyFinalizationShadowStore({ rootDir });
  try {
    const [pair] = store.read();
    assert.equal(pair.v1Action.kind, 'hammer-dispatch');
    assert.equal(pair.live.lane.base, 'main');
    assert.equal(pair.foldError, false);
  } finally { store.close(); }
});

function outcome(n, extra = {}) {
  return { subjectKey: { domainId: 'code-pr', subjectExternalId: `example/repo#${n}` },
    observedAt: '2026-08-10T00:00:00Z', v1Action: { kind: 'merged', sourceRef: `fixture:${n}` },
    v2Decision: { kind: 'finalize-now' }, sawHeadMove: n === 1, sawExhaustion: n === 2,
    classification: { relation: 'agree', disposition: 'resolved' },
    live: { source: 'organic', terminalOutcome: 'merged', lane: { repository: 'example/repo', base: 'main' } },
    ...extra };
}

test('MLR-04 arithmetic requires 50 distinct landed subjects plus both organic examples', () => {
  const rows = Array.from({ length: 50 }, (_, n) => outcome(n + 1));
  assert.equal(buildMlrPromotionGate(rows.slice(1), now).promotable, false);
  assert.equal(buildMlrPromotionGate(rows, now).promotable, true);
  assert.equal(buildMlrPromotionGate([...rows.slice(1), ...Array(100).fill(rows[1])], now).finalizations, 49);
  assert.equal(buildMlrPromotionGate(rows.map(o => ({ ...o, live: { ...o.live, source: 'synthetic' } })), now).finalizations, 0);
  assert.equal(buildMlrPromotionGate(rows.map(o => ({ ...o, v1Action: { kind: 'hammer-dispatch', sourceRef: 'fixture' } })), now).finalizations, 0);
  assert.equal(buildMlrPromotionGate(rows.map(o => ({ ...o, sawExhaustion: false })), now).promotable, false);
  const closed = outcome(51, { v1Action: { kind: 'close', sourceRef: 'fixture:closed' },
    live: { source: 'organic', terminalOutcome: 'closed', lane: { repository: 'example/repo', base: 'main' } },
    sawHeadMove: true, sawExhaustion: true });
  const terminalGate = buildMlrPromotionGate([...rows.slice(2), closed], now);
  assert.equal(terminalGate.finalizations, 49);
  assert.equal(terminalGate.headMoves, 0);
  assert.equal(terminalGate.exhaustionCloses, 0);
  const oldOpen = outcome(60, { observedAt: '2026-07-01T00:00:00Z',
    classification: { relation: 'diverge', disposition: 'open' } });
  const report = buildShadowReport({ observations: rows, promotionHistory: [...rows, oldOpen], now });
  assert.equal(report.promotionGate.openDivergences, 1);
  assert.equal(report.promotable, false);
  oldOpen.dispositionOverride = { disposition: 'resolved', principal: 'fixture-operator', note: 'evidence checked' };
  assert.equal(buildMlrPromotionGate([...rows, oldOpen], now).promotable, true);
  const failure = outcome(61, { foldError: true });
  assert.equal(buildMlrPromotionGate([...rows, failure], now).promotable, false);
  failure.dispositionOverride = { disposition: 'resolved', principal: 'fixture-operator', note: 'ledger repaired' };
  assert.equal(buildMlrPromotionGate([...rows, failure], now).promotable, true);
});


test('poll timestamps do not grow the fact ledger; real transitions and head returns do', t => {
  const { record, ledger } = fixture(t);
  const subject = { domainId: 'code-pr', subjectExternalId: 'example/repo#1' };
  const first = snapshot();
  first.observations.policy = complete({ reviewCeilingReached: true });
  record(first);
  const original = ledger.read(subject);
  for (let i = 1; i <= 20; i++) {
    const later = structuredClone(first);
    later.observedAt = new Date(Date.parse(now) + i * 1000).toISOString();
    later.passId = `pass:${i}`;
    later.observations.checks.value.rollup[0].completedAt = later.observedAt;
    record(later);
  }
  assert.deepEqual(ledger.read(subject), original);
  const changed = snapshot('head-a', '2026-08-20T00:01:00Z');
  changed.observations.checks.value.rollup[0].conclusion = 'FAILURE';
  changed.observations.pr.value.mergeable = 'DIRTY';
  changed.observations.reviews.value.blockingFindingCount = 1;
  record(changed);
  record(snapshot('head-a', '2026-08-20T00:02:00Z'));
  const events = ledger.read(subject);
  for (const type of ['checks_settled', 'mergeability_observed', 'verdict_recorded']) {
    assert.equal(events.filter(e => e.type === type).length, 3, type);
  }
  record(snapshot('head-b', '2026-08-20T00:03:00Z'));
  record(snapshot('head-a', '2026-08-20T00:04:00Z'));
  assert.deepEqual(ledger.read(subject).filter(e => e.type === 'revision_advanced').map(e => e.revisionRef),
    ['head-a', 'head-b', 'head-a']);
});

test('partial snapshots preserve prior evidence while explicit failed refreshes escalate', t => {
  const { record, ledger } = fixture(t);
  record(snapshot());
  const subject = { domainId: 'code-pr', subjectExternalId: 'example/repo#1' };
  const before = ledger.read(subject);
  const partial = { ...snapshot('head-a', '2026-08-20T00:01:00Z'), observations: {} };
  assert.equal(record(partial).foldError, false);
  assert.deepEqual(ledger.read(subject), before);
  for (const name of ['reviews', 'checks']) {
    const failed = { ...partial, observations: { [name]: { state: 'error', value: null } } };
    assert.equal(record(failed).foldError, true, name);
  }
});

test('configured check contexts settle on unprotected repositories and enforce missing contexts', t => {
  const { record, ledger } = fixture(t);
  for (const protection of [undefined, { ok: false }, { ok: true, requiredContexts: ['extra'] }]) {
    const evidence = closureOwnerShadowEvidence({ currentHead: 'head-a', checks: 'SUCCESS' }, {
      subjectKey: 'example/repo#1', observedAt: now,
      cfg: { getMergeAuthorityConfig: () => ({ requiredCheckContexts: ['unit'] }) },
      candidate: { headSha: 'head-a', branchProtection: protection },
      checksRollup: [{ name: 'unit', conclusion: 'SUCCESS' }],
    });
    const s = deriveNextActionSnapshot(evidence);
    record(s);
    const check = ledger.read({ domainId: 'code-pr', subjectExternalId: 'example/repo#1' })
      .filter(e => e.type === 'checks_settled').at(-1);
    assert.equal(check.requiredChecksPresent, protection?.ok !== true);
    assert.equal(check.conclusion, protection?.ok === true ? 'pending' : 'success');
  }
});


test('live ingestion converges ledger schema once per borrowed connection', t => {
  const { db, record } = fixture(t);
  const exec = db.exec.bind(db);
  let schemaWrites = 0;
  db.exec = sql => { schemaWrites++; return exec(sql); };
  record(snapshot());
  assert.equal(schemaWrites, 1);
  record(snapshot('head-a', '2026-08-20T00:01:00Z'));
  assert.equal(schemaWrites, 1);
});


test('daemon calls reuse app-root connection and schema setup across polls', t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'live-shadow-cache-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const exec = Database.prototype.exec;
  let schemaWrites = 0;
  Database.prototype.exec = function(sql) { schemaWrites++; return exec.call(this, sql); };
  try {
    const options = { rootDir, legacy: { action: 'wait' }, source: 'fixture', repo: 'example/repo', prNumber: 1 };
    recordLiveShadow({ ...options, snapshot: snapshot() });
    const first = schemaWrites;
    assert.ok(first > 0);
    recordLiveShadow({ ...options, snapshot: snapshot('head-a', '2026-08-20T00:01:00Z') });
    assert.equal(schemaWrites, first);
  } finally { Database.prototype.exec = exec; }
});
