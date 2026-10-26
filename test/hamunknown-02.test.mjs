import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderHammerProcedure } from '../src/hammer-procedure.mjs';
import { loadAwareTimeoutMs } from '../src/load-aware-timeout.mjs';
import { evaluateHammerStopHold, hammerStopInputs, readHammerStopForHead, _resetHammerStopHoldPageDebounceForTests } from '../src/ama/hammer-stop-hold.mjs';

const head = 'a'.repeat(40);
const subprocessTimeout = loadAwareTimeoutMs(30_000);
const green = { ok: true, state: 'OPEN', headMatches: true, expectedHead: head, liveHead: head,
  mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', checksConclusion: 'SUCCESS', reasons: [] };
const unknown = { ...green, ok: false, mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN', reasons: ['pr-mergeability-unknown'] };

// Run the complete rendered merge procedure. Only external reads/writes are
// stubbed; gate sampling, both gate callers, merge and audit branching are real.
function runMerge(t, gates, { laneRefusal = null, laneExit = 75, leaseWaitSeconds = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hamunknown-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const path of ['modules/worker-pool/lib/python', 'platform/session-ledger/src']) mkdirSync(join(dir, path), { recursive: true });
  writeFileSync(join(dir, 'clock'), '1000');
  writeFileSync(join(dir, 'gates.json'), JSON.stringify(gates));
  writeFileSync(join(dir, 'verdict.json'), JSON.stringify({ eligible: true,
    trace: { headMatch: { current: head }, branchProtection: { required: true } } }));
  const nodeStub = join(dir, 'fixture-node.cjs');
  writeFileSync(nodeStub, `#!${process.execPath}
const fs = require('node:fs');
const dir = process.env.TMPDIR;
const args = process.argv.slice(2);
const log = value => fs.appendFileSync(dir + '/events', JSON.stringify(value) + '\\n');
if (args[0].endsWith('/bin/legacy-lane-write.mjs')) {
  const deadline = Number(args[args.indexOf('--deadline-ms') + 1]);
  const now = Number(fs.readFileSync(dir + '/clock')) * 1000;
  log({ laneDeadline: deadline, at: now / 1000 });
  if (deadline <= now) { console.error('legacy writer deadline expired'); process.exit(75); }
  if (${JSON.stringify(laneRefusal)} !== null) {
    console.error(${JSON.stringify(laneRefusal)}); process.exit(${laneExit});
  }
  const {spawnSync} = require('node:child_process');
  const separator = args.indexOf('--');
  const child = spawnSync(args[separator + 1], args.slice(separator + 2), {stdio:'inherit'});
  process.exit(child.status ?? 1);
}
if (args[0] === '--input-type=module') {
  const code = fs.readFileSync(0, 'utf8');
  if (code.includes('const rollup = await fetchHammerPr')) {
    let index = 0;
    try { index = Number(fs.readFileSync(dir + '/gate-index')); } catch {}
    const gates = JSON.parse(fs.readFileSync(dir + '/gates.json'));
    const gate = gates[Math.min(index, gates.length - 1)];
    fs.writeFileSync(dir + '/gate-index', String(index + 1));
    log({ gate, at: Number(fs.readFileSync(dir + '/clock')) });
    console.log(JSON.stringify(gate));
  }
} else if (args[0].endsWith('/ama-audit.mjs')) {
  const value = key => args[args.indexOf(key) + 1];
  log({ outcome: value('--outcome'), attempt: JSON.parse(fs.readFileSync(value('--attempt-json'))),
    at: Number(fs.readFileSync(dir + '/clock')) });
} else if (args[0].endsWith('/metered-gh.mjs')) {
  log({ merge: args });
} else if (args[0].endsWith('/hammer-pr-read.mjs')) {
  if (args.includes('title')) console.log('Repair synthetic fixture');
  else if (args.includes('body')) console.log('Synthetic change');
  else console.log(JSON.stringify({state:'MERGED',headRefOid:'${head}',mergeCommit:{oid:'${'b'.repeat(40)}'},mergedAt:'2026-01-01T00:00:00Z'}));
} else if (args[0].endsWith('/merge-commit-body.mjs')) {
  console.log(JSON.stringify({text:'Synthetic change',subject:'Repair synthetic fixture',rewrites:[]}));
}
`, { mode: 0o755 });
  const pythonStub = join(dir, 'fixture-python');
  writeFileSync(pythonStub, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const script = join(dir, 'merge.sh');
  writeFileSync(script, renderHammerProcedure('hammer-merge', {
    ROOT_DIR: dir, RUN_DIR: dir, HQ_ROOT: dir, REPO: 'fixture/repo', PR_NUMBER: '1',
    PR_URL: 'https://github.com/fixture/repo/pull/1', REVIEWED_SHA: head, TARGET_REMEDIATION_SHA: head,
    MERGE_METHOD: 'squash', REVIEWER: 'synthetic-reviewer', RISK_CLASS: 'low',
  }));
  const result = spawnSync('/bin/bash', ['-c', `
HAM_MERGE_LEASE_HELD=1 HAM_MERGE_LEASE_ID=fixture
POST_REMEDIATION_SHA=${head} HAM_PUBLISHED_AUDIT_HEAD=${head}
HAM_VERDICT_FILE="$TMPDIR/verdict.json" HAM_VERDICT_READY_FILE="$TMPDIR/verdict.json"
HAM_NODE_BIN="$TMPDIR/fixture-node.cjs"
ham_release_merge_lease() { echo "release:$HAM_MERGE_LEASE_RETRYABLE_ABORT_REASON" >> "$TMPDIR/release"; HAM_MERGE_LEASE_HELD=0; }
ham_acquire_merge_lease() { HAM_MERGE_LEASE_HELD=1; echo $(( $(cat "$TMPDIR/clock") + ${leaseWaitSeconds} )) > "$TMPDIR/clock"; }
ham_base_touches_pr_files() { return 1; }
ham_mark_merge_lease_retryable_abort() { HAM_MERGE_LEASE_RETRYABLE_ABORT_REASON="$1"; }
date() { if [ "$1" = +%s ]; then cat "$TMPDIR/clock"; else /bin/date "$@"; fi; }
sleep() { echo $(( $(cat "$TMPDIR/clock") + $1 )) > "$TMPDIR/clock"; }
source "$1"
exit "$?"
`, '_', script], { encoding: 'utf8', timeout: subprocessTimeout, env: {
    PATH: process.env.PATH, TMPDIR: dir, AGENT_OS_ROOT: dir, HAM_PYTHON_BIN: pythonStub,
  } });
  assert.equal(result.error, undefined);
  assert.ok(existsSync(join(dir, 'events')), result.stderr);
  const events = readFileSync(join(dir, 'events'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  return { ...result, events, release: readFileSync(join(dir, 'release'), 'utf8') };
}

test('HAMUNKNOWN-02: UNKNOWN at final merge read resolves to MERGEABLE and merges the validated head', t => {
  const result = runMerge(t, [green, unknown, unknown, green]);
  assert.equal(result.status, 0, result.stderr);
  const samples = result.events.filter(event => event.gate);
  assert.equal(samples.length, 4);
  assert.ok(samples[3].at - samples[1].at >= 60, 're-reads retain the shared check polling cadence');
  const merge = result.events.find(event => event.merge);
  assert.ok(merge, result.stderr);
  assert.equal(merge.merge[merge.merge.indexOf('--match-head-commit') + 1], head);
  assert.ok(result.events.some(event => event.outcome === 'succeeded'));
  assert.ok(!result.events.some(event => event.outcome === 'failed-without-merge'));
});

for (const phase of ['final', 'preflight']) {
  test(`HAMUNKNOWN-02: persistent UNKNOWN in ${phase} gate aborts retryably within a bounded window`, t => {
    const result = runMerge(t, phase === 'final' ? [green, unknown] : [unknown]);
    assert.equal(result.status, 20, result.stderr);
    const samples = result.events.filter(event => event.gate);
    assert.equal(samples.length, phase === 'final' ? 4 : 3);
    assert.ok(samples.at(-1).at - samples[phase === 'final' ? 1 : 0].at <= 60);
    assert.ok(!result.events.some(event => event.merge));
    assert.ok(result.events.some(event => event.outcome === 'deferred' && event.attempt.reason === 'pr-mergeability-unknown'));
    assert.ok(result.events.some(event => event.outcome === 'deferred' && event.attempt.remoteCiStatus === 'mergeability-unknown'));
    assert.ok(!result.events.some(event => event.outcome === 'failed-without-merge'));
    assert.match(result.release, /release:pr-mergeability-unknown/);
  });
}

test('HAMUNKNOWN-02: red CI with UNKNOWN mergeability fails without extra sampling', t => {
  const result = runMerge(t, [{ ...unknown, checksConclusion: 'FAILURE', reasons: ['ci-not-green', 'pr-mergeability-unknown'] }]);
  assert.equal(result.status, 20, result.stderr);
  assert.equal(result.events.filter(event => event.gate).length, 1);
  assert.ok(result.events.some(event => event.outcome === 'failed-without-merge' && event.attempt.reason === 'github-gate-red'));
  assert.ok(!result.events.some(event => event.merge));
});

test('HAMUNKNOWN-02: pending CI outlives UNKNOWN sampling and merges only after both recover', t => {
  const pending = { ...unknown, checksConclusion: 'PENDING', reasons: ['ci-not-green', 'pr-mergeability-unknown'] };
  const result = runMerge(t, [pending, pending, pending, pending, green, green]);
  assert.equal(result.status, 0, result.stderr);
  const samples = result.events.filter(event => event.gate);
  assert.ok(samples[4].at - samples[0].at > 60);
  assert.ok(result.events.some(event => event.merge));
  assert.ok(!result.events.some(event => event.outcome === 'deferred'));
});

test('HAMUNKNOWN-02: pending CI with persistent UNKNOWN waits for the CI deadline before deferring', t => {
  const result = runMerge(t, [{ ...unknown, checksConclusion: 'PENDING', reasons: ['ci-not-green', 'pr-mergeability-unknown'] }]);
  assert.equal(result.status, 20, result.stderr);
  const samples = result.events.filter(event => event.gate);
  const waited = samples.at(-1).at - samples[0].at;
  // Stop before reading another gate at the deadline; the last poll is one
  // cadence earlier, while the deferral itself must consume the full budget.
  assert.equal(waited, 870, 'no gate read starts at or after the 900s deadline');
  const deferred = result.events.find(event => event.outcome === 'deferred');
  assert.equal(deferred.at - samples[0].at, 900, 'deferral occurs at the CI deadline');
  assert.equal(deferred.attempt.reason, 'pr-mergeability-unknown');
  assert.equal(deferred.attempt.remoteCiStatus, 'mergeability-unknown-ci-timeout');
  assert.equal(deferred.attempt.githubGate.checksConclusion, 'PENDING');
  assert.ok(!result.events.some(event => event.merge || event.outcome === 'failed-without-merge'));
});

for (const [name, gate, reason] of [
  ['moved head', { ...unknown, headMatches: false, liveHead: 'c'.repeat(40), reasons: ['stale-head', 'pr-mergeability-unknown'] }, 'live-head-moved-before-merge'],
  ['closed PR', { ...unknown, state: 'CLOSED' }, 'github-gate-not-green'],
]) {
  test(`HAMUNKNOWN-02: final UNKNOWN with ${name} terminates without retryable deferral`, t => {
    const result = runMerge(t, [green, gate]);
    assert.equal(result.status, 20, result.stderr);
    assert.equal(result.events.filter(event => event.gate).length, 2);
    assert.ok(result.events.some(event => event.attempt?.reason === reason));
    assert.ok(!result.events.some(event => event.merge || event.outcome === 'deferred'));
    assert.doesNotMatch(result.release, /release:pr-mergeability-unknown/);
  });
}

for (const [name, gate] of [
  ['red CI', { ...green, ok: false, checksConclusion: 'FAILURE', reasons: ['ci-not-green'] }],
  ['pending CI', { ...green, ok: false, checksConclusion: 'PENDING', reasons: ['ci-not-green'] }],
  ['moved head', { ...green, ok: false, headMatches: false, liveHead: 'c'.repeat(40), reasons: ['stale-head'] }],
  ['conflict', { ...green, ok: false, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', reasons: ['pr-not-mergeable'] }],
  ['closed PR', { ...green, ok: false, state: 'CLOSED', reasons: ['pr-not-mergeable'] }],
]) {
  test(`HAMUNKNOWN-02: UNKNOWN resolving to ${name} never merges`, t => {
    const result = runMerge(t, [green, unknown, gate]);
    assert.equal(result.status, 20, result.stderr);
    assert.ok(!result.events.some(event => event.merge));
    assert.equal(result.events.filter(event => event.gate).length, 3);
  });
}

function heldFixture(t, { predicate = 'github-gate-not-green', reasons = ['pr-mergeability-unknown'], metadata = {}, excludeContexts = [] } = {}) {
  _resetHammerStopHoldPageDebounceForTests();
  const rootDir = mkdtempSync(join(tmpdir(), 'hamunknown-hold-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const prMetadata = { headSha: head, baseSha: 'b'.repeat(40), isOpen: true, state: 'OPEN',
    mergeable: 'MERGEABLE', mergeableState: 'MERGEABLE', mergeStateStatus: 'CLEAN',
    statusCheckRollup: [{ name: 'unit', conclusion: 'SUCCESS' }], ...metadata };
  const recordedAt = '2026-01-01T00:00:00Z';
  const stopKey = `${head}:0:${recordedAt}`;
  const inputs = hammerStopInputs(prMetadata, { excludeContexts });
  const statePath = join(rootDir, 'data/follow-up-jobs/hammer-stop-hold/fixture-repo-pr-1.json');
  mkdirSync(join(rootDir, 'data/follow-up-jobs/hammer-stop-hold'), { recursive: true });
  writeFileSync(statePath, JSON.stringify({ currentHead: head, heads: {
    [head]: { stopKey, predicate, firstObservedAt: recordedAt, inputs, pagedAt: recordedAt,
      mode: 'transient', retryAfter: '2026-01-01T00:05:00Z' },
  } }));
  const args = { rootDir, hqRoot: rootDir, repo: 'fixture/repo', prNumber: 1, headSha: head, prMetadata, excludeContexts,
    readAuditImpl: () => ({ attempts: [{ head, outcome: 'failed-without-merge', reason: predicate,
      startedAt: recordedAt, path: 'hammer', githubGate: { reasons } }] }),
    logger: { log() {}, warn() {}, error() {} }, now: '2026-01-01T00:01:00Z',
    deliverAlertImpl: () => assert.fail('an already paged or released hold must not page again'),
    fetchPrimaryChangeImpl: async () => { throw new Error('Synthetic unavailable evidence'); },
  };
  return { args, statePath, inputs };
}

test('HAMUNKNOWN-02: existing GitHub gate hold with already-green recorded and fresh inputs releases on the next pass', async t => {
  const { args, statePath, inputs } = heldFixture(t);
  assert.deepEqual(hammerStopInputs(args.prMetadata), inputs, 'all recorded inputs are unchanged');
  const result = await evaluateHammerStopHold(args);
  assert.equal(result.action, 'release');
  assert.deepEqual(result.changed, ['github-gate-cleared']);
  const entry = JSON.parse(readFileSync(statePath, 'utf8')).heads[head];
  assert.equal(entry.releasedAt, args.now);
  assert.deepEqual(entry.releasedInputs, inputs);
  _resetHammerStopHoldPageDebounceForTests();
  assert.equal((await evaluateHammerStopHold(args)).action, 'release', 'release survives restart');
});

test('HAMUNKNOWN-02: canonical OPEN metadata releases without a synthetic isOpen field', async t => {
  const { args } = heldFixture(t, { metadata: { isOpen: undefined } });
  delete args.prMetadata.isOpen;
  const result = await evaluateHammerStopHold(args);
  assert.equal(result.action, 'release');
  assert.deepEqual(result.changed, ['github-gate-cleared']);
});

test('HAMUNKNOWN-02: empty and nullish audit attempts are ignored without crashing', () => {
  const args = { hqRoot: '/synthetic', repo: 'fixture/repo', prNumber: 1, headSha: head };
  assert.equal(readHammerStopForHead({ ...args, readAuditImpl: () => ({ attempts: [] }) }), null);
  assert.equal(readHammerStopForHead({ ...args, readAuditImpl: () => ({ attempts: [null, undefined] }) }), null);
  const stop = { head, outcome: 'failed-without-merge', reason: 'github-gate-not-green', path: 'hammer' };
  assert.deepEqual(readHammerStopForHead({ ...args,
    readAuditImpl: () => ({ attempts: [null, stop, undefined] }),
  }).reasons, []);
});

for (const reasons of [[], ['ci-not-green'], ['pr-not-mergeable']]) {
  test(`HAMUNKNOWN-02: green GitHub gate releases legacy or deterministic gate-only stop ${JSON.stringify(reasons)}`, async t => {
    const { args } = heldFixture(t, { reasons });
    // A structured refusal gets its own generation on first observation.
    const result = await evaluateHammerStopHold({ ...args, deliverAlertImpl: () => assert.fail('cleared gate must not page') });
    assert.equal(result.action, 'release');
  });
}

for (const [name, metadata, extra] of [
  ['UNKNOWN', { mergeable: 'UNKNOWN', mergeableState: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }],
  ['UNKNOWN beside CLEAN', { mergeable: 'UNKNOWN', mergeableState: 'MERGEABLE' }],
  ['red', { statusCheckRollup: [{ name: 'unit', conclusion: 'FAILURE' }] }],
  ['pending', { statusCheckRollup: [{ name: 'unit', conclusion: 'PENDING' }] }],
  ['empty checks', { statusCheckRollup: [] }],
  ['unreadable checks', { statusCheckRollup: null }],
  ['missing required context', {}, { requiredCheckContexts: ['unit', 'integration'] }],
  ['moved head', { headSha: 'c'.repeat(40) }],
  ['closed', { isOpen: false, state: 'CLOSED' }],
  ['canonical closed', { isOpen: undefined, state: 'CLOSED' }],
  ['contradictory open flag', { isOpen: true, state: 'CLOSED' }],
  ['contradictory closed flag', { isOpen: false, state: 'OPEN' }],
]) {
  test(`HAMUNKNOWN-02: unchanged ${name} cannot clear a GitHub gate hold`, async t => {
    const { args } = heldFixture(t, { metadata });
    assert.equal((await evaluateHammerStopHold({ ...args, ...extra })).action, 'hold');
  });
}

for (const [predicate, reasons] of [
  ['primary-change-reverted', ['primary-change-reverted']],
  ['predicate-not-eligible', ['blocking-findings-present']],
  ['github-gate-not-green', ['primary-change-reverted']],
  ['github-gate-not-green', ['pr-mergeability-unknown', 'primary-change-reverted']],
  ['github-gate-not-green', ['pr-mergeability-unknown', 'blocking-findings-present']],
]) {
  test(`HAMUNKNOWN-02: green GitHub reads preserve real refusal ${predicate}/${reasons[0]}`, async t => {
    const { args } = heldFixture(t, { predicate, reasons });
    assert.equal((await evaluateHammerStopHold({ ...args, deliverAlertImpl: async () => {} })).action, 'hold');
  });
}

test('HAMUNKNOWN-02: recovered gate uses latest-run classification and excludes only own status contexts', async t => {
  const context = 'synthetic/gate';
  const own = { __typename: 'StatusContext', context, state: 'FAILURE' };
  const rerun = [
    { name: 'unit', conclusion: 'FAILURE', createdAt: '2026-01-01T00:00:00Z' },
    { name: 'unit', conclusion: 'SUCCESS', createdAt: '2026-01-01T00:01:00Z' }, own,
  ];
  const cleared = heldFixture(t, { excludeContexts: [context], metadata: { statusCheckRollup: rerun } });
  assert.equal((await evaluateHammerStopHold({ ...cleared.args, excludeContexts: [context] })).action, 'release');
  const externalRed = heldFixture(t, { excludeContexts: [context], metadata: { statusCheckRollup: [
    ...rerun, { __typename: 'CheckRun', name: context, conclusion: 'FAILURE' },
  ] } });
  assert.equal((await evaluateHammerStopHold({ ...externalRed.args, excludeContexts: [context] })).action, 'hold');
});

for (const [reason, exitCode, outcome] of [
  ['owner-operation-in-flight; lane-busy; waited 3000ms', 75, 'deferred'],
  ['lane-transfer-required', 75, 'failed-without-merge'],
  ['owner-operation-in-flight', 75, 'failed-without-merge'],
  ['owner-operation-in-flight; lane-busy; waited 3000ms', 17, 'failed-without-merge'],
]) test(`HAMLANEWAIT-01: rendered closer classifies ${reason}, exit ${exitCode}`, t => {
  const result = runMerge(t, [green], { laneRefusal: `legacy lane write refused: ${reason}`, laneExit: exitCode });
  assert.equal(result.status, outcome === 'deferred' ? 75 : 1, result.stderr);
  const audit = result.events.findLast(event => event.outcome);
  assert.equal(audit.outcome, outcome);
  assert.equal(audit.attempt.reason, outcome === 'deferred' ? 'lane-busy' : 'unclassified-merge-failure');
  assert.ok(!result.events.some(event => event.merge));
  if (outcome === 'deferred') {
    assert.match(result.stderr, /waited 3000ms/);
    assert.match(result.release, /release:lane-busy/);
    assert.ok(!result.events.some(event => event.outcome === 'failed-without-merge'));
  }
});


test('HAMLANEWAIT-01: spent CI deadline after lease wait leaves a fresh 60s merge budget', t => {
  const result = runMerge(t, [{ ...green, ok: false, checksConclusion: 'PENDING', reasons: ['ci-not-green'] }, green], { leaseWaitSeconds: 1000 });
  assert.equal(result.status, 0, result.stderr);
  const write = result.events.find(event => event.laneDeadline);
  assert.equal(write.at, 2030, 'lease wait outlasted the original CI deadline at 1900');
  assert.equal(write.laneDeadline, (write.at + 60) * 1000);
  assert.ok(result.events.some(event => event.merge));
  assert.ok(result.events.some(event => event.outcome === 'succeeded'));
});
