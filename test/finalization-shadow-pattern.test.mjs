import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { shadowPatternKey } from '../src/finalization/shadow-pattern.mjs';
import { openFinalizationShadowStore, openReadOnlyFinalizationShadowStore } from '../src/finalization/shadow-store.mjs';
import { buildShadowReport, effectiveDisposition, renderShadowReport } from '../src/finalization/shadow-report.mjs';
import { finalizationMain } from '../src/finalization-cli.mjs';

const at = n => new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString();
const observation = (n = 0, changes = {}) => ({
  subjectKey: { domainId: 'code-pr', subjectExternalId: 'example/project#1' },
  revisionRef: 'synthetic-head', observedAt: at(n),
  v1Action: { kind: 'remediate', detail: 'remediate:live-owner' },
  v2Decision: { kind: 'wait', reason: 'no verdict at current revision' },
  classification: { relation: 'diverge', direction: 'open', class: 'unclassified', disposition: 'open' },
  live: { source: 'synthetic' }, foldError: false, sawHeadMove: false, sawExhaustion: false,
  ...changes,
});
const audit = n => ({ at: at(n), principal: '  synthetic-reviewer  ', note: 'Synthetic evidence reviewed.' });
const record = sample => ({ ...audit(1), key: shadowPatternKey(sample), kind: 'equivalent', evidenceSampleIds: [sample.id] });
function fixture(t) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  return openFinalizationShadowStore({ db });
}

test('pattern keys are exact, versioned and independent of subject, head, source and time', () => {
  const original = observation();
  const key = shadowPatternKey(original);
  assert.deepEqual(JSON.parse(key), ['shadow-pattern-v1', 'remediate', 'remediate:live-owner', 'wait', 'no verdict at current revision']);
  assert.equal(shadowPatternKey(observation(20, { subjectKey: { domainId: 'other', subjectExternalId: 'example/other#99' },
    revisionRef: 'another-head', v1Action: { ...original.v1Action, sourceRef: 'another-source' } })), key);
  for (const changes of [
    { v1Action: { kind: 'wait', detail: 'remediate:live-owner' } },
    { v1Action: { kind: 'remediate', detail: 'hammer:live-owner' } },
    { v2Decision: { kind: 'escalate', reason: original.v2Decision.reason } },
    { v2Decision: { kind: 'wait', reason: 'checks patience expired' } },
  ]) assert.notEqual(shadowPatternKey(observation(0, changes)), key);
  for (const detail of ['unknown:new-pattern', 'remediate:live-owner ', 'head:abc123', 'example/project#1']) {
    assert.equal(shadowPatternKey(observation(0, { v1Action: { kind: 'wait', detail } })), null);
  }
  assert.equal(shadowPatternKey(observation(0, { v2Decision: { kind: 'wait', reason: 'new reason' } })), null);
  assert.notEqual(shadowPatternKey(observation(0, { v1Action: { kind: 'hammer-dispatch' } })), null);
});

test('matching future observations capture a disposition; unmatched and failures stay open', t => {
  const store = fixture(t);
  const sample = store.append(observation());
  const pattern = store.addPattern(record(sample));
  assert.equal(pattern.principal, audit(1).principal);
  assert.equal(effectiveDisposition(store.read()[0]), 'open', 'no retroactive backfill');
  const match = store.append(observation(2));
  assert.equal(effectiveDisposition(match), 'resolved');
  assert.deepEqual(match.patternDisposition, pattern);
  assert.equal(effectiveDisposition(store.append(observation(2, {
    v2Decision: { kind: 'escalate', reason: 'verdict patience expired at current revision' },
  }))), 'open');
  assert.equal(effectiveDisposition(store.append(observation(2, { foldError: true }))), 'open');
  assert.equal(effectiveDisposition(store.append(observation(2, {
    v2Decision: { kind: 'wait', reason: 'new reason' }, patternDisposition: pattern,
  }))), 'open', 'caller cannot inject a disposition');
  assert.equal(effectiveDisposition(store.append(observation(0))), 'open', 'backdated sample predates creation');
  store.annotate(match.id, { ...audit(3), disposition: 'open', direction: 'open' });
  assert.equal(effectiveDisposition(store.read().find(o => o.id === match.id)), 'open');
  store.annotate(sample.id, { ...audit(3), disposition: 'resolved', direction: 'benign' });
  assert.equal(effectiveDisposition(store.read().find(o => o.id === sample.id)), 'resolved');
});

test('revocation and expiry stop future application, retain history and preserve deduped decisions', t => {
  const store = fixture(t);
  const sample = store.append(observation());
  const first = store.addPattern({ ...record(sample), expiresAt: at(4) });
  assert.throws(() => store.addPattern(record(sample)), /UNIQUE/);
  const matched = store.append(observation(2, { dedupeKey: 'synthetic-pair' }));
  assert.equal(effectiveDisposition(matched), 'resolved');
  assert.equal(effectiveDisposition(store.append(observation(4))), 'open', 'expiry is exclusive');
  const revoked = store.revokePattern(first.id, audit(5));
  assert.deepEqual(revoked.revocation, audit(5));
  assert.throws(() => store.revokePattern(first.id, audit(6)), /already revoked/);
  assert.equal(effectiveDisposition(store.append(observation(6))), 'open');
  assert.deepEqual(store.append(observation(6, { dedupeKey: 'synthetic-pair' })), matched);
  const second = store.addPattern({ ...record(sample), ...audit(7), kind: 'v2-defect', ticketRef: 'EXAMPLE-42' });
  assert.notEqual(second.id, first.id);
  assert.equal(effectiveDisposition(store.append(observation(8))), 'resolved');
  assert.equal(store.listPatterns().length, 2);
  assert.deepEqual(store.read().find(o => o.id === matched.id).patternDisposition, first);
  const read = openReadOnlyFinalizationShadowStore({ db: store.db });
  assert.deepEqual(read.listPatterns(), store.listPatterns());
});

test('audit, evidence, linked defect ticket and expiry validation fail closed', t => {
  const store = fixture(t);
  const sample = store.append(observation());
  const base = record(sample);
  for (const invalid of [
    { principal: ' ' }, { note: '' }, { at: 'invalid' }, { at: '2026' }, { at: 1 }, { kind: 'unknown' },
    { kind: 'v2-defect' }, { kind: 'v2-defect', ticketRef: 'no-link' },
    { evidenceSampleIds: [] }, { evidenceSampleIds: [999] }, { evidenceSampleIds: [1.5] },
    { key: 'wrong-key' }, { expiresAt: at(0) }, { expiresAt: 'invalid' },
  ]) assert.throws(() => store.addPattern({ ...base, ...invalid }));
  const pattern = store.addPattern({ ...base, kind: 'policy' });
  assert.throws(() => store.revokePattern(pattern.id, { ...audit(2), principal: '' }));
  assert.throws(() => store.revokePattern(pattern.id, audit(0)));
  assert.equal(store.listPatterns()[0].revocation, null);
});

test('report counts pattern, individual and open dispositions per exact pattern', t => {
  const store = fixture(t);
  const sample = store.append(observation());
  const pattern = store.addPattern(record(sample));
  const matched = store.append(observation(2));
  const individual = store.append(observation(3));
  store.annotate(individual.id, { ...audit(4), disposition: 'resolved', direction: 'benign' });
  const other = store.append(observation(4, { v2Decision: { kind: 'wait', reason: 'checks patience expired' } }));
  const model = buildShadowReport({ observations: store.read(), now: at(10) });
  assert.deepEqual(model.patterns, [
    { key: shadowPatternKey(sample), total: 3, byPattern: 1, byIndividualOverride: 1, open: 1, byClassifier: 0 },
    { key: shadowPatternKey(other), total: 1, byPattern: 0, byIndividualOverride: 0, open: 1, byClassifier: 0 },
  ]);
  assert.equal(model.openDivergences, 2);
  assert.equal(model.promotionGate.openDivergences, 2);
  assert.match(renderShadowReport(model), /by_pattern=1 by_individual_override=1 open=1/);
  assert.equal(model.divergences.find(d => d.id === individual.id).overridden, true);
  assert.deepEqual(model.divergences.find(d => d.id === matched.id).evidence.patternDisposition, pattern);
  assert.equal(model.divergences.find(d => d.id === sample.id).evidence.patternDisposition, null);
});

test('CLI add/list/revoke records principal verbatim and lists read-only', t => {
  const store = fixture(t);
  const sample = store.append(observation());
  let text = '', error = '', readOpens = 0, writeOpens = 0;
  const io = { now: at(1), stdout: { write: value => { text += value; } }, stderr: { write: value => { error += value; } },
    openPatternStore: () => { writeOpens++; return store; },
    openPatternReadStore: () => { readOpens++; return openReadOnlyFinalizationShadowStore({ db: store.db }); } };
  assert.equal(finalizationMain(['shadow-pattern', 'add', '--key', shadowPatternKey(sample), '--kind', 'equivalent',
    '--principal', audit(1).principal, '--note', 'Synthetic review.', '--evidence', String(sample.id)], io), 0);
  const created = JSON.parse(text);
  assert.equal(created.principal, audit(1).principal);
  text = '';
  assert.equal(finalizationMain(['shadow-pattern', 'list'], io), 0);
  assert.equal(JSON.parse(text).length, 1);
  assert.equal(readOpens, 1);
  assert.equal(writeOpens, 1);
  text = '';
  assert.equal(finalizationMain(['shadow-pattern', 'revoke', '--id', String(created.id), '--principal', 'synthetic-reviewer', '--note', 'Synthetic revoke.'], { ...io, now: at(2) }), 0);
  assert.equal(JSON.parse(text).revocation.note, 'Synthetic revoke.');
  assert.equal(finalizationMain(['shadow-pattern', 'add', '--key', 'key'], io), 2);
  assert.equal(finalizationMain(['shadow-pattern', 'list', '--principal', 'unexpected'], io), 2);
  assert.equal(finalizationMain(['shadow-pattern', 'revoke', '--id', String(created.id), '--principal', 'synthetic-reviewer', '--note', 'Again.'], io), 1);
  assert.match(error, /already revoked/);
});


test('pattern listing on the previous schema is read-only and migration preserves observations', t => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(readFileSync(new URL('../migrations/20260718_finalization_shadow.sql', import.meta.url), 'utf8'));
  const before = db.pragma('schema_version', { simple: true });
  const read = openReadOnlyFinalizationShadowStore({ db });
  assert.deepEqual(read.listPatterns(), []);
  assert.equal(db.pragma('schema_version', { simple: true }), before);
  const store = openFinalizationShadowStore({ db });
  const sample = store.append(observation());
  const pattern = store.addPattern(record(sample));
  const reopened = openFinalizationShadowStore({ db });
  assert.deepEqual(reopened.listPatterns(), [pattern]);
  assert.equal(reopened.read().length, 1);
  assert.equal(effectiveDisposition(reopened.append(observation(2))), 'resolved');
});

test('concurrent matching appends serialize pattern lookup and retain one deduped decision', { timeout: 15000 }, async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'shadow-pattern-race-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const store = openFinalizationShadowStore({ rootDir });
  t.after(() => store.close());
  const sample = store.append(observation());
  const pattern = store.addPattern(record(sample));
  const gate = new SharedArrayBuffer(4);
  const workers = Array.from({ length: 2 }, () => new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { openFinalizationShadowStore } = await import(workerData.moduleUrl);
      const store = openFinalizationShadowStore({ rootDir: workerData.rootDir });
      parentPort.postMessage({ ready: true });
      Atomics.wait(new Int32Array(workerData.gate), 0, 0);
      const observation = store.append(workerData.observation);
      store.close();
      parentPort.postMessage({ observation });
    })().catch(error => { throw error; });
  `, { eval: true, workerData: { moduleUrl: new URL('../src/finalization/shadow-store.mjs', import.meta.url).href,
    rootDir, gate, observation: observation(2, { dedupeKey: 'synthetic-concurrent-pair' }) } }));
  t.after(async () => { await Promise.all(workers.map(w => w.terminate())); });
  let ready = 0;
  const results = await Promise.all(workers.map(worker => new Promise((resolve, reject) => {
    worker.on('error', reject);
    worker.on('message', message => {
      if (message.ready) {
        if (++ready === workers.length) {
          Atomics.store(new Int32Array(gate), 0, 1);
          Atomics.notify(new Int32Array(gate), 0);
        }
      } else resolve(message.observation);
    });
  })));
  assert.equal(results[0].id, results[1].id);
  assert.equal(results[0].patternDisposition.id, pattern.id);
  assert.equal(store.read().length, 2);
});


test('report fails closed on malformed or mismatched pattern references', () => {
  const sample = observation();
  const record = { id: 1, key: shadowPatternKey(sample), kind: 'equivalent', principal: 'synthetic-reviewer', note: 'Synthetic review.' };
  assert.equal(effectiveDisposition({ ...sample, patternDisposition: record }), 'resolved');
  for (const changes of [{ id: 0 }, { kind: 'unknown' }, { key: 'other' }, { principal: '' }, { note: '' }]) {
    assert.equal(effectiveDisposition({ ...sample, patternDisposition: { ...record, ...changes } }), 'open');
  }
  const unknown = observation(0, { v2Decision: { kind: 'wait', reason: 'new reason' } });
  assert.equal(effectiveDisposition({ ...unknown, patternDisposition: { ...record, key: null } }), 'open');
});
