import { buildMergeAgentDispatchJob } from '../src/follow-up-merge-agent.mjs';
import { attemptDaemonCleanMerge } from '../src/ama/daemon-merge.mjs';
import test, { mock } from 'node:test';
import os from 'node:os';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decideClosureOwner } from '../src/ama/closure-owner.mjs';
import classifyRescue from '../src/merge-agent-rescue-classifier.mjs';
import { closeoutRereview } from '../src/remediation-closeout.mjs';
import { requestEligibleHammerWake } from '../src/hammer-wake.mjs';
import { hasHammerDispatchIntent, revalidateClosurePr } from '../src/ama/closure-next-action.mjs';
import { recoverAmaAutomation } from '../src/ama/automated-recovery.mjs';
import { recoverOrphan } from '../src/ama/orphan-watchdog.mjs';
import { recordNoProgressLaneRun, readNoProgressLane } from '../src/watcher-no-progress-lane.mjs';
import { registerSharedNextAction, resolveSharedNextAction } from '../src/pr-next-action-shadow.mjs';

import { HEAD, AT, quiet, identity, cases, matrixPair } from './helpers/next-action-matrix.mjs';

// Simulated timestamps exercise the idle policy independently of fleet host load.
mock.method(os, 'loadavg', () => [0, 0, 0]);

for (const [name, observations, action, actor] of cases) {
  test(`one shared workflow across adapters: ${name}`, async t => {
    const rootDir = mkdtempSync(join(tmpdir(), 'nxa-adapters-'));
    t.after(() => rmSync(rootDir, { force: true, recursive: true }));
    const shared = matrixPair(observations);
    const { snapshot } = shared;
    const decision = shared.decision;
    assert.deepEqual([decision.action, decision.actor], [action, actor]);
    if (name === 'new exact-head review supersedes an automated stop') {
      assert.ok(decision.evidenceRefs.includes('stop-superseded-by-exact-head-review'));
      assert.equal(decision.queue.intent, 'daemon');
    }
    if (!['done', 'operator-hold'].includes(action)) {
      assert.equal(decision.deadline.anchoredAt, AT);
      assert.ok(decision.deadline.at.endsWith('Z'));
    }
    registerSharedNextAction(snapshot, shared);
    assert.equal(await resolveSharedNextAction({ passSnapshot: snapshot }), shared);
    assert.equal(decideClosureOwner(shared).decisionKey, decision.decisionKey);
    const rescue = classifyRescue({ sharedNextAction: shared, headSha: HEAD });
    assert.equal(rescue.closureOwner.actor, actor);
    assert.equal(rescue.closureOwner.decisionKey, decision.decisionKey);
    const job = buildMergeAgentDispatchJob(rootDir, { repo: identity.repo, prNumber: identity.prNumber,
      headSha: HEAD, prState: 'OPEN', labels: [] }, { passSnapshot: snapshot });
    assert.equal(job.mergeAgentRescueReason, decision.reason);
    assert.equal(job.mergeAgentRescueDecision, rescue.decision);
    assert.equal(closeoutRereview(shared).nextAction, decision);
    const dispatch = action === 'hammer' && actor === 'hammer';
    assert.equal(hasHammerDispatchIntent(shared, identity), dispatch);
    let wakes = 0;
    const wake = requestEligibleHammerWake({ rootDir, ...identity, shared, log: quiet,
      requestWatcherWakeImpl: () => { wakes++; return { requested: true }; } });
    const wantsWake = (dispatch || (action === 'daemon-merge' && actor === 'daemon')) && !decision.queue.deferredBy;
    assert.equal(wakes, Number(wantsWake));
    assert.equal(wake.nextAction, decision);
    recordNoProgressLaneRun(rootDir, identity, { headSha: HEAD, fingerprint: 'progress-07',
      nextAction: decision, now: AT, logger: quiet });
    assert.deepEqual(readNoProgressLane(rootDir, identity).nextAction, decision);

    let daemonMutations = 0;
    const liveGate = { candidateHead: HEAD, prState: 'OPEN', mergeable: 'MERGEABLE',
      labels: [], requiredChecks: [{ name: 'unit-07', conclusion: 'SUCCESS' }] };
    const daemonResult = await attemptDaemonCleanMerge({ repo: identity.repo, prNumber: identity.prNumber, base: 'base-07',
      validatedHead: HEAD, verdict: 'settled-success', prTitle: 'Synthetic change', reviewState: { verdict: 'approved', headSha: HEAD,
        blockingFindingState: 'known', blockingFindingCount: 0,
        nonBlockingFindingState: 'known', nonBlockingFindingCount: 0 },
      liveGate, branchProtectionRequired: false, flags: { autonomousMergeExecutionEnabled: true },
      getNextAction: () => decision, fetchLiveGateImpl: async () => liveGate,
      acquireLeaseImpl: () => ({ acquired: true, lease: { leaseId: 'lease-07' } }),
      releaseLeaseImpl() {}, runMergeImpl: async () => { daemonMutations++; return { exitCode: 0 }; },
      readAuditImpl: () => null, writeAuditImpl() {}, appendAuditImpl() {}, writeMergeActionImpl() {},
      logger: quiet, sleep: async () => {},
    });
    assert.equal(daemonMutations, Number(action === 'daemon-merge' && actor === 'daemon'), JSON.stringify(daemonResult));

    const effects = [];
    const result = { amaEnabled: true, nextAction: decision };
    const recover = await recoverAmaAutomation({ rootDir, ...identity, result, logger: quiet,
      now: () => Date.parse(AT), requestRereviewImpl: async () => { effects.push('review'); return { triggered: true }; },
      dispatchHammer: async () => { effects.push('hammer'); return { dispatched: true }; },
      pageImpl: async () => { effects.push('page'); } });
    const unownedDispatch = decision.queue.intent === 'dispatch' && !decision.queue.deferredBy;
    const missingSafetyRepair = decision.row === 'R05-structural' && actor === 'closure-recovery'
      && decision.reason === 'safety-refusal' && !decision.queue.deferredBy;
    assert.deepEqual(effects, missingSafetyRepair ? ['page']
      : unownedDispatch && ['review', 'hammer'].includes(action) ? [action] : []);
    if (missingSafetyRepair) {
      assert.equal(recover.outcome, 'recovery-exhausted');
      assert.equal(recover.recovery.event.detail, 'no-recorded-repair');
    }
    if (action === 'done') assert.equal(recover.outcome, 'pr-terminal');

    const orphanEffects = [];
    const orphanArgs = { rootDir, ...identity, result, candidate: { prState: 'open' }, logger: quiet,
      now: AT, hasOwnerImpl: async () => ({ owned: false }),
      requestRereviewImpl: async () => { orphanEffects.push('review'); return { triggered: true }; },
      dispatchHammer: async () => { orphanEffects.push('hammer'); return { dispatched: true }; },
      pageImpl: async () => { orphanEffects.push('page'); } };
    await recoverOrphan(orphanArgs);
    if (action !== 'review') await recoverOrphan({ ...orphanArgs, now: '2026-01-01T00:16:00.000Z' });
    assert.deepEqual(orphanEffects, unownedDispatch && ['review', 'hammer'].includes(action) ? [action] : []);
  });
}

test('new diagnostic reason text cannot register or revoke a selected workflow', () => {
  const decision = { action: 'hammer', actor: 'hammer', head: HEAD,
    queue: { intent: 'dispatch', deferredBy: null }, reason: 'unregistered-evidence-07' };
  const shared = { snapshot: { subjectKey: 'subject-07#7', head: HEAD }, decision };
  assert.equal(hasHammerDispatchIntent(shared, identity), true);
  assert.equal(classifyRescue({ sharedNextAction: shared, headSha: HEAD }).decision, 'hammer-eligible');
  assert.equal(decideClosureOwner(shared).reason, decision.reason);
});


test('a background live read cannot borrow stale CLEAN mergeability', () => {
  const seed = matrixPair();
  const initial = revalidateClosurePr(seed, { state: 'OPEN', headSha: HEAD,
    mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' });
  const refreshed = revalidateClosurePr(initial, { state: 'OPEN', headSha: HEAD, mergeable: '' });
  assert.equal(initial.snapshot.observations.pr.value.mergeStateStatus, 'CLEAN');
  assert.equal(refreshed.snapshot.observations.pr.value.mergeStateStatus, null);
  assert.equal(refreshed.decision.queue.intent, 'observe');
  assert.equal(hasHammerDispatchIntent(refreshed, identity), false);
});
