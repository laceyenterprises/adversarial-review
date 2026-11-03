import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyHammerExit, hammerNoMergeDetails, recordVerifiedHammerMerge, recordHammerPhase } from '../src/ama/hammer-outcome.mjs';
import { recordHammerProgress } from '../src/ama/hammer-progress.mjs';

test('only recent exact-head merge execution writes a run-bound immutable receipt', () => {
  const root = mkdtempSync(join(tmpdir(), 'hammer-outcome-'));
  try {
    const env = { HAM_HQ_ROOT: root, HQ_LAUNCH_REQUEST_ID: 'lrq_test', HQ_WORKER_RUN_ID: 'wrun_test' };
    const headSha = 'a'.repeat(40);
    const executedAt = '2026-11-03T12:00:00Z';
    const live = { state: 'MERGED', headRefOid: headSha, mergedAt: executedAt, mergeCommit: { oid: 'b'.repeat(40) } };
    for (const bad of [{ ...live, state: 'OPEN' }, { ...live, headRefOid: 'c'.repeat(40) }, { ...live, mergedAt: 'invalid' }, { ...live, mergedAt: '2026-11-02T12:00:00Z' }, { ...live, mergeCommit: null }]) {
      assert.throws(() => recordVerifiedHammerMerge({ live: bad, headSha, executedAt, env }));
    }
    const receipt = recordVerifiedHammerMerge({ live, headSha, executedAt, env });
    assert.equal(receipt.outcome, 'merged');
    assert.equal(receipt.mergeCommitSha, live.mergeCommit.oid);
    assert.deepEqual(recordVerifiedHammerMerge({ live, headSha, executedAt, env }), receipt);
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'dispatch/lrq_test/hammer-progress/wrun_test/outcome.json'))), receipt);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('all synthetic no-merge exits have a closed reason and raw phase', () => {
  for (const [raw, reason] of [['remediated-and-pushed', 'remediated-and-pushed'], ['hammer-token-ceiling-exceeded', 'token-ceiling'], ['worker_crashed', 'crashed'], ['new-exit', 'unclassified'], ['github-gate-read-failed', 'read-failed']]) {
    assert.equal(classifyHammerExit(raw), reason);
    assert.deepEqual(hammerNoMergeDetails({ raw }), { phaseOutcome: reason, lastPhase: raw });
  }
});

test('no-merge event uses the final run reason or verified pushed head', () => {
  const root = mkdtempSync(join(tmpdir(), 'hammer-outcome-'));
  const env = { HAM_HQ_ROOT: root, HQ_LAUNCH_REQUEST_ID: 'lrq_test', HQ_WORKER_RUN_ID: 'wrun_test' };
  const args = { hqRoot: root, launchRequestId: 'lrq_test', runId: 'wrun_test', raw: 'succeeded' };
  try {
    const headSha = 'a'.repeat(40);
    recordHammerPhase('github-gate-red', { env });
    assert.equal(hammerNoMergeDetails(args).phaseOutcome, 'ci-red');
    recordHammerPhase('new-exit', { env });
    recordHammerProgress('remediation-pushed', { env, headSha });
    assert.equal(hammerNoMergeDetails(args).phaseOutcome, 'remediated-and-pushed');
    recordHammerProgress('terminal-stop', { env, final: true, reason: 'hammer-token-ceiling-exceeded' });
    assert.equal(hammerNoMergeDetails(args).phaseOutcome, 'token-ceiling');
    assert.equal(hammerNoMergeDetails({ ...args, runId: 'wrun_other' }).phaseOutcome, 'unclassified');
    const directory = join(root, 'dispatch/lrq_test/hammer-progress/wrun_other');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'terminal-stop.json'), JSON.stringify({ schemaVersion: 1, runId: 'wrun_test', launchRequestId: 'lrq_test', milestone: 'terminal-stop', reason: 'ci-red' }));
    assert.equal(hammerNoMergeDetails({ ...args, runId: 'wrun_other' }).phaseOutcome, 'unclassified');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
