import './helpers/rate-limit-state-isolation.mjs';
import { writeAmaAuditEntry } from '../src/ama/audit.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHoldRecord, normalizeHoldRecord, evaluateHoldRecord, writeHoldRecord, withHoldRecordPoll, assertHoldRecord } from '../src/ama/hold-record.mjs';
import { evaluateHammerStopHold, normalizeHammerStopHold } from '../src/ama/hammer-stop-hold.mjs';
import { holdForOperatorLabels, normalizeOperatorLabelHold } from '../src/ama/operator-label-gates.mjs';
import { holdStackedBase, normalizeStackedBaseHold } from '../src/ama/stacked-base.mjs';
import { evaluateCloserHoldsForPoll, readCloserHoldRecords } from '../src/ama/closer-hold-records.mjs';

const now = '2026-01-01T00:00:00.000Z';
const later = '2026-01-01T00:05:00.000Z';
const head = 'a'.repeat(40);
const repo = 'example/widget';
const logger = { warn() {}, log() {}, error() {} };
const record = (awaits, extra = {}) => createHoldRecord({ owner: 'closure-recovery', deadline: now,
  onDeadline: 'ama_closer.hammer_stop_hold', reason: 'synthetic-wait', awaits, ...extra });
function root(t) {
  const path = mkdtempSync(join(tmpdir(), 'hold-contract-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

test('HOLDCONTRACT-01 refuses ownerless/deadlineless writes before persistence', t => {
  const path = join(root(t), 'refused.json');
  for (const field of ['owner', 'deadline', 'onDeadline', 'reason', 'awaits']) {
    const invalid = { ...record([{ kind: 'retry-at', at: later }]), [field]: undefined };
    assert.throws(() => writeHoldRecord(path, invalid), TypeError);
    assert.equal(existsSync(path), false);
  }
  assert.throws(() => record([{ kind: 'unknown' }]), /predicate/);
  assert.throws(() => record([{ kind: 'retry-at', at: 'never' }]), /ISO/);
  assert.throws(() => normalizeHoldRecord({ holdVersion: 1 }, {}), /owner/);
});

test('HOLDCONTRACT-01 each predicate releases on proof and fails closed without it', () => {
  for (const [kind, field, from, value] of [['head-change', 'headSha', null, head], ['base-change', 'baseSha', 'old', 'new'],
    ['mergeability-change', 'mergeability', null, 'MERGEABLE'], ['checks-change', 'checks', 'red', 'green'], ['review-change', 'review', 'old', 'new']]) {
    const hold = record([{ kind, from }]);
    assert.equal(evaluateHoldRecord(hold, { now }).action, 'hold', kind);
    assert.equal(evaluateHoldRecord(hold, { now, inputs: { [field]: from } }).action, 'hold', kind);
    assert.equal(evaluateHoldRecord(hold, { now, inputs: { [field]: value } }).action, 'release', kind);
  }
  assert.equal(evaluateHoldRecord(record([{ kind: 'retry-at', at: later }]), { now }).action, 'hold');
  assert.equal(evaluateHoldRecord(record([{ kind: 'retry-at', at: later }]), { now: later }).action, 'release');
  const event = record([{ kind: 'event', name: 'primary-change-evidence' }]);
  assert.equal(evaluateHoldRecord(event, { now, events: { 'primary-change-evidence': 'unknown' } }).action, 'hold');
  assert.equal(evaluateHoldRecord(event, { now, events: { 'primary-change-evidence': true } }).action, 'release');
  const companionWait = { repo, prNumber: 2, submodulePath: 'tools/component', state: 'merged', mergeCommit: head, containsMerge: true };
  for (const kind of ['companion-merged', 'gitlink-contains-commit']) {
    const hold = record([{ kind, repo, prNumber: 2, submodulePath: 'tools/component', commit: head }]);
    assert.equal(evaluateHoldRecord(hold, { now }).action, 'hold');
    assert.equal(evaluateHoldRecord(hold, { now, companionWait, evidenceUnreadable: true }).action, 'hold');
    assert.equal(evaluateHoldRecord(hold, { now, companionWait: { ...companionWait, repo: 'example/foreign' } }).action, 'hold');
    assert.equal(evaluateHoldRecord(hold, { now, companionWait }).action, 'release');
  }
  assert.equal(evaluateHoldRecord(record([{ kind: 'event', name: 'ready' }, { kind: 'retry-at', at: later }]),
    { now, events: { ready: true } }).escalate, false, 'release wins over deadline');
});

test('HOLDCONTRACT-01 legacy readers retain receipts and use existing paging horizons', () => {
  const id = { repo, prNumber: 1, headSha: head, now };
  const legacy = { stopKey: 'synthetic', predicate: 'primary-change-unknown', firstObservedAt: now, inputs: { headSha: head }, pagedAt: now };
  const normalized = normalizeHammerStopHold(legacy, id);
  assert.equal(normalized.deadline, now);
  assert.equal(normalized.pagedAt, now);
  assert.equal(evaluateHoldRecord(normalized, { now: later }).escalate, false);
  assert.equal(normalizeHammerStopHold({ ...legacy, predicate: 'history-read-failed' }, id).deadline, '2026-01-01T00:10:00.000Z');
  assert.equal(normalizeHammerStopHold({ ...legacy, mode: 'companion' }, id).deadline, '2026-01-02T01:00:00.000Z');
  assert.equal(normalizeHammerStopHold({ ...legacy, mode: 'companion', companionWait: { mergedAt: later } }, id).deadline, '2026-01-02T01:05:00.000Z');
  assert.equal(normalizeOperatorLabelHold({ repo, prNumber: 1, headSha: head, reason: 'label', alertedAt: now }, later).deadline, now);
  assert.equal(normalizeStackedBaseHold({ reason: 'stacked-base-read-failed', firstObservedAt: now }).deadline, '2026-01-01T00:01:00.000Z');
});

test('HOLDCONTRACT-01 all closer hold writers round trip the shared shape', async t => {
  const rootDir = root(t);
  const identity = { rootDir, repo, prNumber: 1, headSha: head };
  await evaluateHammerStopHold({ ...identity, hqRoot: rootDir, now, logger,
    prMetadata: { headSha: head }, readAuditImpl: () => ({ attempts: [{ head, path: 'hammer',
      outcome: 'failed-without-merge', reason: 'primary-change-unknown', startedAt: now }] }),
    fetchPrimaryChangeImpl: async () => ({ historyReadFailed: true }) });
  await holdForOperatorLabels({ ...identity, now, logger, gates: [{ check: 'synthetic', label: 'synthetic', reason: 'operator-label-required:synthetic' }], deliverAlertImpl: async () => {} });
  await holdStackedBase({ ...identity, logger, state: { ok: false, reason: 'stacked-base-read-failed' } });
  const holds = readCloserHoldRecords(identity);
  assert.equal(holds.length, 3);
  for (const stored of holds) {
    assert.ifError(stored.error);
    assertHoldRecord(stored.record);
    const persisted = JSON.parse(readFileSync(stored.path, 'utf8'));
    assert.equal((stored.type === 'hammer-stop' ? persisted.heads[head] : persisted).holdVersion, 1);
  }
});

test('HOLDCONTRACT-01 backed-off poll deadlines escalate once per head across restart; delivery failure retries', async t => {
  const rootDir = root(t);
  const identity = { rootDir, repo, prNumber: 1, headSha: head };
  const dir = join(rootDir, 'data', 'operator-label-holds');
  await holdForOperatorLabels({ ...identity, now, logger, gates: [{ reason: 'synthetic' }], deliverAlertImpl: async () => { throw new Error('offline'); } });
  const subjects = [{ repoPath: repo, prNumber: 1, headSha: head }];
  let attempts = 0;
  const poll = async (fail = false) => withHoldRecordPoll(() => evaluateCloserHoldsForPoll({ rootDir, subjects, now: later, logger,
    deliverAlertImpl: async () => { attempts++; if (fail) throw new Error('offline'); } }));
  await poll(true);
  await poll();
  await poll();
  assert.equal(attempts, 2);
  const receipt = JSON.parse(readFileSync(join(dir, readdirSync(dir)[0]), 'utf8'));
  assert.equal(receipt.escalatedAt, later);
  await holdForOperatorLabels({ ...identity, headSha: 'b'.repeat(40), now, logger,
    gates: [{ reason: 'synthetic' }], deliverAlertImpl: async () => { throw new Error('offline'); } });
  await withHoldRecordPoll(() => evaluateCloserHoldsForPoll({ rootDir, subjects: [{ ...subjects[0], headSha: 'b'.repeat(40) }], now: later, logger,
    deliverAlertImpl: async () => { attempts++; } }));
  assert.equal(attempts, 3);
});

test('HOLDCONTRACT-01 one evaluation per poll; terminal subjects cannot page', async t => {
  const hold = record([{ kind: 'retry-at', at: later }]);
  await withHoldRecordPoll(async () => {
    const first = evaluateHoldRecord(hold, { now });
    assert.strictEqual(evaluateHoldRecord(hold, { now: later }), first);
  });
  assert.equal(evaluateHoldRecord(hold, { now: later }).action, 'release');
  const rootDir = root(t);
  const identity = { rootDir, repo, prNumber: 1, headSha: head };
  await holdForOperatorLabels({ ...identity, now, logger, gates: [{ reason: 'synthetic' }], deliverAlertImpl: async () => { throw new Error('offline'); } });
  await evaluateCloserHoldsForPoll({ rootDir, subjects: [{ ...identity, holdMetadata: { lifecycle: 'terminal', terminal: true } }], now: later, logger,
    deliverAlertImpl: async () => assert.fail('terminal subject paged') });
});


test('HOLDCONTRACT-01 green CI cannot release operator review findings; observed check movement releases CI waits', async t => {
  const rootDir = root(t);
  const identity = { rootDir, repo, prNumber: 1, headSha: head };
  const gates = [{ check: 'synthetic', reason: 'synthetic-label' }];
  const green = { headSha: head, state: 'open', statusCheckRollup: [{ name: 'synthetic', conclusion: 'SUCCESS' }] };
  await holdForOperatorLabels({ ...identity, now, logger, gates, deliverAlertImpl: async () => {},
    postCommentImpl: async () => ({ posted: true }) });
  await withHoldRecordPoll(() => evaluateCloserHoldsForPoll({ rootDir,
    subjects: [{ ...identity, holdMetadata: green }], now: later, logger,
    deliverAlertImpl: async () => assert.fail('already delivered') }));
  assert.equal(readCloserHoldRecords(identity).length, 1, 'review findings remain owned');
  const ci = { ...identity, prNumber: 2 };
  await holdForOperatorLabels({ ...ci, now, logger, gates, deliverAlertImpl: async () => {},
    prMetadata: { ...green, statusCheckRollup: [{ name: 'synthetic', conclusion: 'FAILURE' }] } });
  await withHoldRecordPoll(() => evaluateCloserHoldsForPoll({ rootDir,
    subjects: [{ ...ci, holdMetadata: green }], now: later, logger }));
  assert.equal(readCloserHoldRecords(ci).length, 0);
});

test('HOLDCONTRACT-01 a changed receipt during alert delivery survives and does not page again', async t => {
  const rootDir = root(t);
  const identity = { rootDir, repo, prNumber: 1, headSha: head };
  await holdForOperatorLabels({ ...identity, now, logger, gates: [{ reason: 'synthetic' }],
    deliverAlertImpl: async () => { throw new Error('offline'); } });
  const stored = readCloserHoldRecords(identity)[0];
  let pages = 0;
  const subjects = [{ ...identity }];
  await withHoldRecordPoll(() => evaluateCloserHoldsForPoll({ rootDir, subjects, now: later, logger,
    deliverAlertImpl: async () => {
      pages++;
      writeFileSync(stored.path, JSON.stringify({ ...stored.record, reason: 'newer-observation' }));
    } }));
  assert.equal(JSON.parse(readFileSync(stored.path, 'utf8')).reason, 'newer-observation');
  await withHoldRecordPoll(() => evaluateCloserHoldsForPoll({ rootDir, subjects, now: later, logger,
    deliverAlertImpl: async () => { pages++; } }));
  assert.equal(pages, 1);
});

test('HOLDCONTRACT-01 absent review/check evidence cannot fabricate a release on a backed-off poll', async t => {
  const rootDir = root(t);
  const identity = { rootDir, repo, prNumber: 1, headSha: head };
  await evaluateHammerStopHold({ ...identity, hqRoot: rootDir, now, logger,
    prMetadata: { headSha: head }, reviewState: { headSha: head, verdict: 'request-changes' },
    readAuditImpl: () => ({ attempts: [{ head, path: 'hammer', outcome: 'failed-without-merge',
      reason: 'blocking-findings-present', startedAt: now }] }) });
  writeAmaAuditEntry({ hqRoot: rootDir, repo, prNumber: 1, headSha: head, now,
    attempt: { head, path: 'hammer', outcome: 'failed-without-merge', reason: 'blocking-findings-present', startedAt: now } });
  const subjects = [{ ...identity, holdMetadata: { headSha: head, state: 'open' } }];
  await withHoldRecordPoll(() => evaluateCloserHoldsForPoll({ rootDir, subjects, now: later, logger,
    deliverAlertImpl: async () => {} }));
  const [stored] = readCloserHoldRecords(identity);
  assert.equal(stored.record.releasedAt, undefined);
  assert.equal(stored.record.pagedAt, later);
});


test('HOLDCONTRACT-01 a leftover hold receipt without a current hammer stop cannot page or release', async t => {
  const rootDir = root(t);
  const identity = { rootDir, repo, prNumber: 1, headSha: head };
  await evaluateHammerStopHold({ ...identity, hqRoot: rootDir, now, logger,
    prMetadata: { headSha: head }, readAuditImpl: () => ({ attempts: [{ head, path: 'hammer',
      outcome: 'failed-without-merge', reason: 'blocking-findings-present', startedAt: now }] }) });
  const before = readCloserHoldRecords(identity)[0].raw;
  await withHoldRecordPoll(() => evaluateCloserHoldsForPoll({ rootDir, now: later, logger,
    subjects: [{ ...identity, holdMetadata: { headSha: head, baseSha: 'b'.repeat(40), state: 'open' } }],
    deliverAlertImpl: async () => assert.fail('receipt cannot recreate an audit stop') }));
  assert.equal(readCloserHoldRecords(identity)[0].raw, before);
});
