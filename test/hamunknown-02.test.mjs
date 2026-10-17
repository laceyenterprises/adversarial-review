import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderHammerProcedure } from '../src/hammer-procedure.mjs';

const head = 'a'.repeat(40);
const green = { ok: true, state: 'OPEN', headMatches: true, expectedHead: head, liveHead: head,
  mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', checksConclusion: 'SUCCESS', reasons: [] };
const unknown = { ...green, ok: false, mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN', reasons: ['pr-mergeability-unknown'] };

// Run the complete rendered merge procedure. Only external reads/writes are
// stubbed; gate sampling, both gate callers, merge and audit branching are real.
function runMerge(t, gates) {
  const dir = mkdtempSync(join(tmpdir(), 'hamunknown-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const path of ['modules/worker-pool/lib/python', 'platform/session-ledger/src']) mkdirSync(join(dir, path), { recursive: true });
  writeFileSync(join(dir, 'clock'), '1000');
  writeFileSync(join(dir, 'gates.json'), JSON.stringify(gates));
  writeFileSync(join(dir, 'verdict.json'), JSON.stringify({ eligible: true,
    trace: { headMatch: { current: head }, branchProtection: { required: true } } }));
  const nodeStub = join(dir, 'fixture-node');
  writeFileSync(nodeStub, `#!${process.execPath}
const fs = require('node:fs');
const dir = process.env.TMPDIR;
const args = process.argv.slice(2);
const log = value => fs.appendFileSync(dir + '/events', JSON.stringify(value) + '\\n');
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
  log({ outcome: value('--outcome'), attempt: JSON.parse(fs.readFileSync(value('--attempt-json'))) });
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
HAM_NODE_BIN="$TMPDIR/fixture-node"
ham_release_merge_lease() { echo "release:$HAM_MERGE_LEASE_RETRYABLE_ABORT_REASON" >> "$TMPDIR/release"; HAM_MERGE_LEASE_HELD=0; }
ham_mark_merge_lease_retryable_abort() { HAM_MERGE_LEASE_RETRYABLE_ABORT_REASON="$1"; }
date() { if [ "$1" = +%s ]; then cat "$TMPDIR/clock"; else /bin/date "$@"; fi; }
sleep() { echo $(( $(cat "$TMPDIR/clock") + $1 )) > "$TMPDIR/clock"; }
source "$1"
exit "$?"
`, '_', script], { encoding: 'utf8', timeout: 15_000, env: {
    PATH: process.env.PATH, TMPDIR: dir, AGENT_OS_ROOT: dir, HAM_PYTHON_BIN: pythonStub,
  } });
  assert.equal(result.error, undefined);
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
    assert.ok(!result.events.some(event => event.outcome === 'failed-without-merge'));
    assert.match(result.release, /release:pr-mergeability-unknown/);
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
