import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readReviewServiceRevision, REVIEW_SERVICE_REVISION } from '../src/review-service-revision.mjs';
import { writeAmaAuditEntry } from '../src/ama/audit.mjs';
import { evaluateHammerStopHold, _resetHammerStopHoldPageDebounceForTests } from '../src/ama/hammer-stop-hold.mjs';
import { evaluateCloserHoldsForPoll } from '../src/ama/closer-hold-records.mjs';
import { evaluateHoldRecord, withHoldRecordPoll } from '../src/ama/hold-record.mjs';

const head = 'a'.repeat(40);
const now = '2026-01-01T00:00:00.000Z';
const later = '2026-01-01T00:01:00.000Z';
const revisionA = 'git:' + 'b'.repeat(40), revisionB = 'git:' + 'c'.repeat(40);

function fixture(t, reason = 'primary-change-reverted', revision = revisionA) {
  const rootDir = mkdtempSync(join(tmpdir(), 'gate-revision-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const events = [];
  const identity = { repo: 'example/widget', prNumber: 1, headSha: head };
  const record = (at = now, overrides = {}) => writeAmaAuditEntry({ ...identity, hqRoot: rootDir, now: at,
    attempt: { outcome: 'failed-without-merge', reason, head, path: 'hammer',
      reviewServiceRevision: revision, ...overrides } });
  record();
  const args = { ...identity, rootDir, hqRoot: rootDir, now, reviewServiceRevision: revisionA,
    prMetadata: { headSha: head, baseSha: 'd'.repeat(40), isOpen: true, mergeableState: 'MERGEABLE',
      statusCheckRollup: [{ name: 'synthetic-unit', conclusion: 'SUCCESS' }] },
    fetchPrimaryChangeImpl: async () => { throw new Error('synthetic evidence unavailable'); },
    logger: { log: text => events.push(JSON.parse(text)), warn() {}, error() {} } };
  const path = join(rootDir, 'data/follow-up-jobs/hammer-stop-hold/example-widget-pr-1.json');
  const entry = () => JSON.parse(readFileSync(path)).heads[head];
  return { args, path, entry, record, events };
}

test('HOLDGATEVERSION-01: same-head deploy releases once durably; a new refusal under B holds again', async t => {
  const f = fixture(t);
  assert.equal((await evaluateHammerStopHold(f.args)).action, 'hold');
  assert.deepEqual(f.entry().gateRevision, { serviceRevision: revisionA, predicateVersion: null });
  assert.ok(f.entry().awaits.some(p => p.kind === 'gate-revision-change'));
  assert.equal((await evaluateHammerStopHold({ ...f.args, now: later })).action, 'hold');
  const deployed = { ...f.args, now: later, reviewServiceRevision: revisionB };
  assert.deepEqual((await evaluateHammerStopHold(deployed)).changed, ['gate-revision-change']);
  const released = readFileSync(f.path, 'utf8');
  _resetHammerStopHoldPageDebounceForTests();
  assert.equal((await evaluateHammerStopHold(deployed)).action, 'release');
  assert.equal(readFileSync(f.path, 'utf8'), released, 'poll/restart does not create another release');
  assert.equal(f.events.filter(e => e.event === 'ama_closer.hammer_stop_hold_released').length, 1);
  assert.equal(f.entry().releasedGateRevision.serviceRevision, revisionB);
  f.record(later, { reviewServiceRevision: revisionB });
  assert.equal((await evaluateHammerStopHold(deployed)).action, 'hold');
  assert.equal(f.entry().gateRevision.serviceRevision, revisionB);
});

test('HOLDGATEVERSION-01: audit provenance releases even if first observed after deployment', async t => {
  const f = fixture(t);
  assert.deepEqual((await evaluateHammerStopHold({ ...f.args, reviewServiceRevision: revisionB })).changed,
    ['gate-revision-change']);
});

test('HOLDGATEVERSION-01: legacy holds anchor once; unknown observations cannot release', async t => {
  const f = fixture(t, 'verdict-not-eligible', null);
  await evaluateHammerStopHold(f.args);
  const doc = JSON.parse(readFileSync(f.path));
  delete doc.heads[head].gateRevision;
  doc.heads[head].awaits = doc.heads[head].awaits.filter(p => p.kind !== 'gate-revision-change');
  writeFileSync(f.path, JSON.stringify(doc));
  assert.equal((await evaluateHammerStopHold(f.args)).action, 'hold');
  assert.equal((await evaluateHammerStopHold({ ...f.args, reviewServiceRevision: null })).action, 'hold');
  assert.equal((await evaluateHammerStopHold({ ...f.args, reviewServiceRevision: revisionB })).action, 'release');
});

test('HOLDGATEVERSION-01: transient and mixed stops retain their original backoff across deploys', async t => {
  for (const reason of ['ci-not-green', 'unclassified-merge-failure']) {
    const f = fixture(t, reason);
    f.record(now, { reasons: ['primary-change-reverted', reason] });
    await evaluateHammerStopHold(f.args);
    assert.equal((await evaluateHammerStopHold({ ...f.args, now: later, reviewServiceRevision: revisionB })).action, 'hold');
    assert.equal(f.entry().gateRevision, undefined);
    assert.ok(!f.entry().awaits.some(p => p.kind === 'gate-revision-change'));
    assert.deepEqual((await evaluateHammerStopHold({ ...f.args, reviewServiceRevision: revisionB,
      now: '2026-01-01T00:05:00.000Z' })).changed, ['transient-stop-backoff']);
  }
});

test('HOLDGATEVERSION-01: predicate version changes release, missing versions and identical versions do not', async t => {
  const f = fixture(t, 'verdict-not-eligible');
  f.record(now, { gatePredicateVersion: 'predicate-A' });
  await evaluateHammerStopHold({ ...f.args, gatePredicateVersion: 'predicate-A' });
  const hold = f.entry();
  await withHoldRecordPoll(async () => {
    for (const predicateVersion of [null, '', 'predicate-A']) assert.equal(evaluateHoldRecord(hold, {
      now, inputs: hold.inputs, gateRevision: { serviceRevision: revisionA, predicateVersion } }).action, 'hold');
    assert.deepEqual(evaluateHoldRecord(hold, { now, inputs: hold.inputs,
      gateRevision: { serviceRevision: revisionA, predicateVersion: 'predicate-B' } }).changed, ['gate-revision-change']);
  });
});

test('HOLDGATEVERSION-01: skipped open subjects release on deploy; terminal subjects do not', async t => {
  for (const terminal of [true, false]) {
    const f = fixture(t, 'verdict-not-eligible');
    await evaluateHammerStopHold(f.args);
    await evaluateCloserHoldsForPoll({ ...f.args, reviewServiceRevision: revisionB, now: later,
      subjects: [{ repo: f.args.repo, prNumber: 1, headSha: head,
        holdMetadata: { ...f.args.prMetadata, terminal } }] });
    assert.deepEqual(f.entry().releasedBy, terminal ? undefined : ['gate-revision-change']);
  }
});

test('HOLDGATEVERSION-01: audit writers stamp service provenance and retain supplied gate versions', t => {
  const f = fixture(t, 'verdict-not-eligible', undefined);
  const { doc } = writeAmaAuditEntry({ hqRoot: f.args.rootDir, repo: f.args.repo, prNumber: 1, headSha: head, now: later,
    attempt: { outcome: 'failed-without-merge', reason: 'verdict-not-eligible', gatePredicateVersion: 'predicate-A' } });
  assert.equal(doc.attempts.at(-1).reviewServiceRevision, REVIEW_SERVICE_REVISION);
  assert.equal(doc.attempts.at(-1).gatePredicateVersion, 'predicate-A');
});

test('HOLDGATEVERSION-01: revision comes from the service checkout or package, never a parent checkout', () => {
  const serviceRoot = '/synthetic/review-service';
  const readFileSyncImpl = path => { assert.equal(path, serviceRoot + '/package.json'); return '{"version":"2.0.0"}'; };
  const execFileSyncImpl = (_cmd, args) => {
    assert.equal(args[2], serviceRoot);
    return `${serviceRoot}\n${'e'.repeat(40)}\n`;
  };
  assert.equal(readReviewServiceRevision({ serviceRoot, execFileSyncImpl, readFileSyncImpl }), 'git:' + 'e'.repeat(40));
  assert.equal(readReviewServiceRevision({ serviceRoot, execFileSyncImpl: () => '/synthetic\n' + 'f'.repeat(40),
    readFileSyncImpl }), 'package:2.0.0');
  const unavailable = () => { throw new Error('synthetic missing metadata'); };
  assert.equal(readReviewServiceRevision({ serviceRoot, execFileSyncImpl: unavailable, readFileSyncImpl }), 'package:2.0.0');
  assert.equal(readReviewServiceRevision({ serviceRoot, execFileSyncImpl: unavailable, readFileSyncImpl: unavailable }), null);
});
