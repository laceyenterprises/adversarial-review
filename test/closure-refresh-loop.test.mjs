import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveNextActionSnapshot, nextAction } from '../src/pr-next-action.mjs';
import { observeClosureDecisionMismatch, observeClosureRefreshLoop } from '../src/ama/closure-refresh-loop.mjs';
import { observeClosureWait } from '../src/ama/closure-wait.mjs';
import { closureGateFactsKey } from '../src/ama/closure-gate-facts.mjs';

const HEAD = 'a'.repeat(40), OLD = 'b'.repeat(40);
function pair({ execution, labels = [], checks = { conclusion: 'SUCCESS' }, mergeable = 'MERGEABLE' }) {
  const snapshot = deriveNextActionSnapshot({ subjectKey: 'fixture/repo#17', head: HEAD, observations: {
    pr: { state: 'OPEN', headSha: HEAD, mergeable, labels }, checks,
    reviews: { headSha: HEAD, verdict: 'approved', blockingFindingState: 'known', blockingFindingCount: 0,
      nonBlockingFindingState: 'known', nonBlockingFindingCount: 0 },
    leases: { closer: null }, launches: { closer: null },
    policy: { autonomousMergeExecutionEnabled: true }, progress: { daemonExecution: execution },
  } });
  const shared = { snapshot, decision: nextAction(snapshot) };
  assert.equal(shared.decision.reason, 'snapshot-refresh');
  return shared;
}
function observer(t) {
  const rootDir = mkdtempSync(join(tmpdir(), 'closure-refresh-facts-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const pages = [];
  return { pages, observe: shared => observeClosureRefreshLoop({ rootDir, repo: 'fixture/repo', prNumber: 17,
    shared, result: { dispatched: false, reason: 'snapshot-refresh' },
    observeWaitImpl: async options => { pages.push(options.reason); return { exhausted: true }; },
  }) };
}

test('unchanged transient declines exhaust even when GitHub collections and detail reasons reorder', async t => {
  const { observe, pages } = observer(t);
  const labels = [{ name: 'one' }, { name: 'two' }];
  const rollup = [{ name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' }, { context: 'legacy', state: 'SUCCESS' }];
  const reasons = ['history-read-failed', 'primary-change-read-failed'];
  for (let cycle = 1; cycle <= 3; cycle++) {
    const reorder = values => cycle % 2 ? values : [...values].reverse();
    const result = await observe(pair({ labels: reorder(labels),
      checks: { rollup: reorder(rollup), statusCheckRollup: reorder(rollup), requiredContexts: reorder(['unit', 'legacy']) },
      execution: { headSha: HEAD, reason: 'gate-read-failed', reasons: reorder(reasons) },
    }));
    if (cycle < 3) assert.equal(result.closureBlocker, undefined);
    else assert.match(result.closureBlocker, /snapshot-refresh-no-progress: daemon:gate-read-failed cycles=3/);
  }
  assert.equal(pages.length, 1);
  // A real change to a check, label or current-head detail must still reset debt.
  assert.equal((await observe(pair({ labels, checks: { rollup },
    execution: { headSha: HEAD, reason: 'gate-read-failed', reasons: ['history-read-failed'] },
  }))).closureBlocker, undefined);
});

test('older-head decline details do not reset the current-head cycle when changed or removed', async t => {
  const { observe, pages } = observer(t);
  const executions = [
    { headSha: OLD, reason: 'gate-read-failed', reasons: ['history-read-failed'] },
    { headSha: OLD, reason: 'worker-identity-unresolved', reasons: ['missing-produced-head-attestation'] },
    null,
  ];
  for (let i = 0; i < executions.length; i++) {
    const result = await observe(pair({ execution: executions[i], mergeable: null }));
    if (i < 2) assert.equal(result.closureBlocker, undefined);
    else assert.match(result.closureBlocker, /snapshot-refresh-no-progress: daemon:unknown cycles=3/);
  }
  assert.equal(pages.length, 1);
});

test('gate canonicalization preserves ordered arrays and every collection entry field', () => {
  assert.equal(closureGateFactsKey({ labels: [{ name: 'one', id: 1 }, { name: 'two', id: 2 }] }),
    closureGateFactsKey({ labels: [{ id: 2, name: 'two' }, { id: 1, name: 'one' }] }));
  assert.notEqual(closureGateFactsKey({ labels: [{ name: 'one', id: 1 }] }),
    closureGateFactsKey({ labels: [{ name: 'one', id: 2 }] }));
  assert.notEqual(closureGateFactsKey({ chain: ['one', 'two'] }), closureGateFactsKey({ chain: ['two', 'one'] }));
});

test('same-head mismatch debt survives reopen and failed delivery; a new head gets one re-resolution', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'closure-mismatch-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  let attempts = 0;
  const observe = (headSha = HEAD) => {
    const base = pair({ mergeable: null }).snapshot;
    const snapshot = deriveNextActionSnapshot({ base, head: headSha, observations: {
      pr: { ...base.observations.pr.value, headSha },
      reviews: { ...base.observations.reviews.value, headSha },
    } });
    return observeClosureDecisionMismatch({ rootDir, repo: 'fixture/repo', prNumber: 17,
      result: { dispatched: false, reason: 'closure-decision-mismatch',
        nextActionShared: { snapshot, decision: nextAction(snapshot) } },
      observeWaitImpl: options => observeClosureWait({ ...options, pageImpl: async () => {
        attempts++;
        if (attempts === 1) throw new Error('synthetic page delivery failure');
      } }),
    });
  };
  assert.equal((await observe()).reason, 'closure-decision-mismatch');
  assert.equal(attempts, 0);
  await assert.rejects(observe(), /synthetic page delivery failure/);
  assert.equal((await observe()).reason, 'closure-decision-mismatch-escalated');
  assert.equal(attempts, 2, 'a fresh connection retains saturated debt and retries delivery');
  await observe();
  assert.equal(attempts, 2, 'successful page receipt dedupes across reopen');
  assert.equal((await observe(OLD)).reason, 'closure-decision-mismatch');
  assert.equal(attempts, 2, 'new head gets one re-resolution');
  assert.equal((await observe(OLD)).reason, 'closure-decision-mismatch-escalated');
  assert.equal(attempts, 3);
});
