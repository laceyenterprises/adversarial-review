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
import { fromLegacyClosureOwner, fromLegacyPostedReviewOutcome } from '../src/pr-next-action-consumer.mjs';
import { liveV1Action } from '../src/finalization/live-shadow.mjs';
import { workflowDecision } from '../src/finalization/workflow-decision.mjs';

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
const workflowReasons = [
  'live-owner: hammer holds an unexpired lease', 'live-owner: remediator holds an unexpired lease',
  'conflict requires owned repair', 'mergeability unknown',
  'final remediator head requires strict exact-head review',
  'merge and delivery verified', 'merged; post-merge activation pending', 'autonomous execution disabled',
  'unknown safety-relevant event', 'terminal launch retains dirty workspace',
  'workspace release requires exact holder evidence', 'launch observation expired',
  'verified launch in progress', 'launch requires verified progress',
  'worker kill requires effect reconciliation', 'operation effect requires readback',
  'primary-change evidence unknown', 'remediation admission or completion pending',
  'awaiting verdict for requested final remediator head',
  'failed final remediation requires recovery', 'primary-change provenance unavailable',
  'automated stop requires relevant evidence',
];
const fixedDetails = [
  'done:merged', 'hammer:ci-red-clean-verdict', 'hammer:lifetime-exhausted',
  'hammer:ownership-unreadable', 'hammer:primary-change-repair', 'hammer:retry-exhausted',
  'hammer:retry-no-merge', 'hammer:safety-refusal', 'hammer:suppressed-final-push',
  'operator-hold:needs-operator', 'remediate:conflict-primary-unproven', 'remediate:final-fix-all',
  'wait-for-CI:checks-pending', 'wait-for-CI:snapshot-refresh',
  'done:closed', 'operator-hold:hold-label', 'operator-hold:draft', 'operator-hold:merge-execution-disabled',
  'remediate:repair-in-place-owned', 'hammer:lease-expired', 'hammer:empty-diff-close',
  'hammer:primary-change-unreadable', 'hammer:merge-receipt-unconfirmed', 'daemon-merge:merge-receipt-unconfirmed',
  'hammer:automated-stop', 'hammer:conflict-rebase', 'hammer:operator-approval-applied',
  'hammer:hammer-final-no-merge', 'hammer:required-checks-resume', 'hammer:ci-runnerless',
  'hammer:daemon-failed-closed', 'hammer:review-ceiling', 'hammer:hammer-owned-head',
  'daemon-merge:carried-clean-head', 'review:attestation-invalid', 'review:exact-head-review',
  'review:handed-to-review', 'review:stale-verdict', 'wait-for-CI:pr-unknown', 'wait-for-CI:policy-unknown',
  'wait-for-CI:structural-restriction-pending', 'wait-for-CI:ci-infrastructure',
  'wait-for-CI:ci-infrastructure-evidence-pending', 'wait-for-CI:checks-unknown',
  'wait-for-CI:mergeability-unknown', 'wait-for-CI:rounds-unknown', 'wait-for-CI:reviews-unknown',
  'wait-for-CI:verdict-unknown', 'wait-for-CI:attestation-unknown', 'wait-for-CI:snapshot-malformed',
  'daemon-merge:merged-this-pass', 'remediate:clean-review-drain', 'operator-hold:retry-exhausted',
  'operator-hold:lifetime-exhausted', 'operator-hold:primary-change-repair', 'operator-hold:lease-expired',
  'operator-hold:checks-pending', 'operator-hold:review-findings-final',
  'operator-hold:operator-decision-required', 'done:terminal-observed',
];
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

test('fixed producer reasons and details key exactly; dynamic and whitespace variants do not', () => {
  for (const reason of workflowReasons) {
    assert.notEqual(shadowPatternKey(observation(0, { v2Decision: { kind: 'wait', reason } })), null, reason);
    assert.equal(shadowPatternKey(observation(0, { v2Decision: { kind: 'wait', reason: `${reason} ` } })), null);
  }
  for (const detail of fixedDetails) {
    assert.notEqual(shadowPatternKey(observation(0, { v1Action: { kind: 'wait', detail } })), null, detail);
    assert.equal(shadowPatternKey(observation(0, { v1Action: { kind: 'wait', detail: `${detail} ` } })), null);
  }
  for (const reason of [
    'live-owner: reviewer holds an unexpired lease', 'shadow ledger unavailable (synthetic failure)',
    'kill switch: wait intercepted (autonomous execution disabled)', 'awaiting attestations from: synthetic',
  ]) assert.equal(shadowPatternKey(observation(0, { v2Decision: { kind: 'wait', reason } })), null);
  for (const detail of ['operator-hold:operator-label-required:example-label', 'observe:unknown',
    'hammer:synthetic-raw-reason', 'operator-hold:synthetic-raw-reason']) {
    assert.equal(shadowPatternKey(observation(0, { v1Action: { kind: 'wait', detail } })), null);
  }
});

test('unmapped legacy inputs remain open even with reviewed patterns for the former fallbacks', t => {
  const store = fixture(t);
  const cases = [
    [fromLegacyClosureOwner({ owner: 'unmapped' }), 'wait-for-CI:snapshot-refresh'],
    [fromLegacyClosureOwner({ owner: 'repair-worker', reason: 'repair epoch X' }), 'wait-for-CI:snapshot-refresh'],
    [fromLegacyClosureOwner(null), 'wait-for-CI:snapshot-refresh'],
    [fromLegacyClosureOwner({ owner: 'wait', reason: 'unknown wait' }), 'wait-for-CI:snapshot-refresh'],
    [fromLegacyClosureOwner({ owner: 'wait' }), 'wait-for-CI:snapshot-refresh'],
    [fromLegacyClosureOwner({ owner: 'review', reason: 'unknown review' }), 'review:exact-head-review'],
    [fromLegacyClosureOwner({ owner: 'review' }), 'review:exact-head-review'],
    [fromLegacyPostedReviewOutcome({ prTerminal: true, terminalReason: 'unknown terminal' }), 'done:terminal-observed'],
    [fromLegacyPostedReviewOutcome({ outcome: 'pr-terminal', terminalReason: '' }), 'done:terminal-observed'],
  ];
  for (const detail of new Set(cases.map(([, detail]) => detail))) {
    const sample = store.append(observation(0, { v1Action: { kind: 'wait', detail } }));
    store.addPattern(record(sample));
  }
  for (const [legacy] of cases) {
    const v1Action = liveV1Action(legacy, 'synthetic-adapter');
    const input = observation(2, { v1Action });
    assert.equal(shadowPatternKey(input), null, v1Action.detail);
    const saved = store.append(input);
    assert.equal(saved.patternDisposition, undefined);
    assert.equal(effectiveDisposition(saved), 'open');
  }
});

test('known legacy mappings and exact pass-through literals stay keyable', () => {
  const cases = [
    [fromLegacyClosureOwner({ owner: 'review', reason: 'exact-head-review' }), 'review:exact-head-review'],
    [fromLegacyClosureOwner({ owner: 'review', reason: 'handed-to-review:synthetic-head' }), 'review:handed-to-review'],
    [fromLegacyClosureOwner({ owner: 'wait', reason: 'pending-required-checks' }), 'wait-for-CI:checks-pending'],
    [fromLegacyClosureOwner({ owner: 'page', reason: 'needs-operator' }), 'operator-hold:needs-operator'],
    [fromLegacyClosureOwner({ owner: 'hammer', reason: 'ci-red-final' }), 'hammer:ci-red-final'],
    [fromLegacyPostedReviewOutcome({ prTerminal: true }), 'done:terminal-observed'],
    [fromLegacyPostedReviewOutcome({ prTerminal: true, terminalReason: 'closed' }), 'done:closed'],
    [fromLegacyPostedReviewOutcome({ prTerminal: true, terminalReason: 'merged' }), 'done:merged'],
  ];
  for (const [legacy, detail] of cases) {
    const v1Action = liveV1Action(legacy, 'synthetic-adapter');
    assert.equal(v1Action.detail, detail);
    assert.notEqual(shadowPatternKey(observation(0, { v1Action })), null, detail);
  }
});

test('workflow default terminal recovery reason produces a keyable observation', () => {
  const v2Decision = workflowDecision({
    subjectKey: { domainId: 'code-pr', subjectExternalId: 'example/project#1' },
    currentRevision: 'synthetic-head', lastEventAt: at(0),
    remediation: { dispatched: [], concluded: [] }, operatorOverrides: [],
    terminal: { kind: 'halted' },
  }, { checksPatienceMs: 1000, verdictPatienceMs: 1000, attestationPatienceMs: 1000,
    deadlineCeilingMs: 1000, policyVersion: 1, codeVersion: 'synthetic' }, { observedAt: at(0) }, {});
  assert.equal(v2Decision.reason, 'automated stop requires relevant evidence');
  assert.equal(v2Decision.nextAction, 'recover-coverage');
  assert.notEqual(shadowPatternKey(observation(0, { v2Decision })), null);
});

test('expanded vocabulary re-keys old evidence and reports without backfilling dispositions', t => {
  const store = fixture(t);
  const sample = store.append(observation(0, {
    v1Action: { kind: 'halt', detail: 'operator-hold:needs-operator' },
    v2Decision: { kind: 'wait', reason: workflowReasons[0] },
  }));
  // Simulate the payload written before this vocabulary was recognized.
  const payload = JSON.parse(store.db.prepare('SELECT payload_json FROM finalization_shadow WHERE id=?').get(sample.id).payload_json);
  payload.patternKey = null;
  store.db.prepare('UPDATE finalization_shadow SET payload_json=? WHERE id=?').run(JSON.stringify(payload), sample.id);
  const historical = store.read()[0];
  const pattern = store.addPattern(record(historical));
  assert.equal(effectiveDisposition(historical), 'open');
  const match = store.append({ ...historical, observedAt: at(2) });
  assert.equal(match.patternDisposition.id, pattern.id);
  const error = store.append({ ...historical, observedAt: at(3), foldError: true });
  assert.equal(error.patternDisposition, undefined);
  assert.equal(effectiveDisposition(error), 'open');
  assert.throws(() => store.addPattern({ ...record(error), ...audit(4) }), /eligible divergence/);
  const model = buildShadowReport({ observations: [historical, match], now: at(10) });
  assert.deepEqual(model.patterns, [
    { key: shadowPatternKey(historical), total: 2, byPattern: 1, byPatternExisting: 0, byIndividualOverride: 0, open: 1, byClassifier: 0 },
  ]);
  assert.equal(JSON.parse(store.db.prepare('SELECT payload_json FROM finalization_shadow WHERE id=?').get(sample.id).payload_json).patternKey, null);
});

test('report groups each newly recognized producer class under its exact key', () => {
  const samples = [
    ...workflowReasons.map(reason => observation(0, { v2Decision: { kind: 'wait', reason } })),
    ...fixedDetails.map(detail => observation(0, { v1Action: { kind: 'wait', detail } })),
  ];
  const model = buildShadowReport({ observations: samples, now: at(10) });
  assert.equal(model.patterns.length, samples.length);
  assert.equal(model.patterns.some(p => p.key === null), false);
  assert.equal(model.patterns.reduce((n, p) => n + p.total, 0), samples.length);
  assert.equal(model.openDivergences, samples.length);
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
    { key: shadowPatternKey(sample), total: 3, byPattern: 1, byPatternExisting: 0, byIndividualOverride: 1, open: 1, byClassifier: 0 },
    { key: shadowPatternKey(other), total: 1, byPattern: 0, byPatternExisting: 0, byIndividualOverride: 0, open: 1, byClassifier: 0 },
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
