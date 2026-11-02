import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ownershipReadBudgets, readOwnershipObservation } from '../src/ownership-read.mjs';
import { closerScanBudgets } from '../src/ama/dispatch-closer.mjs';
import { readLaunchRequestObservationFromLedgerAsync } from '../src/session-ledger-read-adapter.mjs';
import { deriveNextActionSnapshot, nextAction } from '../src/pr-next-action.mjs';
import { resolveSharedNextAction } from '../src/pr-next-action-shadow.mjs';
import { launchSource } from '../src/pr-next-action-consumer.mjs';
import { hammerDispatchMismatch, hasHammerDispatchIntent } from '../src/ama/closure-next-action.mjs';
import { observeClosureDecisionMismatch } from '../src/ama/closure-refresh-loop.mjs';

const headSha = 'a'.repeat(40);
const identity = { repo: 'synthetic/subject', prNumber: 1, headSha };
const pair = snapshot => ({ snapshot, decision: nextAction(snapshot) });
function selected() {
  return pair(deriveNextActionSnapshot({ subjectKey: `${identity.repo}#1`, head: headSha,
    observedAt: '2026-01-01T00:00:00Z', observations: {
      pr: { headSha, state: 'OPEN', mergeable: 'MERGEABLE', labels: [] },
      reviews: { headSha, verdict: 'approved', blockingFindingState: 'known', blockingFindingCount: 0,
        nonBlockingFindingState: 'known', nonBlockingFindingCount: 0 },
      checks: { conclusion: 'SUCCESS' }, remediation: { roundsLeft: false },
      leases: { closer: null }, policy: { autonomousMergeExecutionEnabled: true },
      launches: { closer: { launchRequestId: 'synthetic-launch', headSha, row: { status: 'failed' },
        retryChain: [], outcome: 'no-merge', retryable: true } },
    } }));
}

for (const reason of ['scan-read-timeout', 'dispatch_read_unavailable', '503', 'ownership-read-deferred']) {
  test(`NXAOWNERREAD-01: ${reason} defers launch without a mismatch cycle or second owner`, async t => {
    const rootDir = mkdtempSync(join(tmpdir(), 'nxa-owner-'));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const prior = selected();
    assert.equal(hasHammerDispatchIntent(prior, identity), true);
    const reference = { state: 'complete', value: { closer: { launchRequestId: 'synthetic-launch', headSha,
      retryChainUnreadable: true, retryChainReadState: 'unresolved' } } };
    const fresh = await resolveSharedNextAction({ passSnapshot: prior.snapshot, evidence: {
      observations: { launches: reference }, readLaunches: async () => ({ state: 'unknown', value: null,
        provenance: { reason } }),
    } });
    assert.equal(fresh.decision.reason, 'ownership-unreadable');
    const events = [];
    const result = hammerDispatchMismatch(prior, fresh, identity, { logger: { log: line => events.push(JSON.parse(line)) } });
    assert.equal(result.reason, 'ownership-read-deferred');
    assert.equal(result.dispatched, false);
    assert.equal(result.skipMergeAgent, true);
    assert.equal(result.decisionMismatch, undefined);
    assert.equal(events.length, 1);
    assert.equal(events[0].count, 1);
    assert.equal(events[0].reason, reason);
    for (let i = 0; i < 3; i++) {
      assert.equal(await observeClosureDecisionMismatch({ rootDir, ...identity, result }), result);
    }
    assert.equal(existsSync(join(rootDir, 'data', 'ama-closure-waits')), false);
  });
}

test('NXAOWNERREAD-01: live owner and unrelated gate changes still invalidate selected intent', () => {
  const prior = selected();
  const live = pair(deriveNextActionSnapshot({ base: prior.snapshot, observations: {
    launches: { closer: { launchRequestId: 'new-launch', headSha, row: { status: 'running' }, retryChain: [] } },
  } }));
  assert.equal(live.decision.reason, 'live-owner');
  assert.equal(hammerDispatchMismatch(prior, live, identity).reason, 'closure-decision-mismatch');
  const unknown = { state: 'unknown', value: null };
  const changed = pair(deriveNextActionSnapshot({ base: prior.snapshot, observations: {
    launches: unknown, leases: unknown, progress: { primaryChange: { ok: false, headSha, reason: 'primary-change-unknown' } },
  } }));
  assert.equal(changed.decision.reason, 'ownership-unreadable');
  assert.equal(hammerDispatchMismatch(prior, changed, identity).reason, 'closure-decision-mismatch');
  const newLease = pair(deriveNextActionSnapshot({ base: prior.snapshot, observations: {
    launches: unknown, leases: { closer: { status: 'dispatched', headSha, lrqId: 'new-launch' } },
  } }));
  assert.equal(hammerDispatchMismatch(prior, newLease, identity).reason, 'closure-decision-mismatch');
});

test('NXAOWNERREAD-01: census, NXA observation and wake share bounded load-aware reads', async () => {
  assert.equal(closerScanBudgets, ownershipReadBudgets);
  const idle = ownershipReadBudgets({ loadOptions: { loadAvg1m: 0, cpuCount: 1, cpuBusyPercent: 100 } });
  const busyOptions = { loadOptions: { loadAvg1m: 7, cpuCount: 1, cpuBusyPercent: 100 } };
  const busy = ownershipReadBudgets(busyOptions);
  for (const name of Object.keys(idle)) assert.equal(busy[name], idle[name] * 6);
  let effective;
  await readOwnershipObservation(async ({ timeoutMs, signal }) => {
    effective = timeoutMs;
    assert.equal(signal.aborted, false);
    return { state: 'complete', value: {} };
  }, busyOptions);
  assert.equal(effective, busy.launch);
  let calls = 0;
  const observation = await readLaunchRequestObservationFromLedgerAsync({ launchRequestId: 'synthetic-launch',
    ...busyOptions, readLaunchRequestStatusImpl: async ({ timeoutMs }) => {
      assert.equal(timeoutMs, busy.launch);
      calls++;
      return { ok: false, reason: 'dispatch_read_unavailable' };
    } });
  assert.equal(calls, 1);
  assert.equal(observation.state, 'unknown');
  assert.equal(launchSource(observation, {}, {}).state, 'unknown');
  const consumer = readFileSync(new URL('../src/pr-next-action-consumer.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(consumer, /NEXT_ACTION_SHADOW_LAUNCH_READ_MS|setTimeout|timeoutMs\s*=\s*\d/);
});

test('NXAOWNERREAD-01: slow read aborts and recovers through the common reader', async () => {
  const signals = [];
  const result = await readOwnershipObservation(async ({ signal }) => {
    signals.push(signal);
    if (signals.length === 1) return new Promise(() => {});
    return { state: 'complete', value: { closer: null } };
  }, { launchReadTimeoutMs: 1 });
  assert.equal(result.state, 'complete');
  assert.equal(signals.length, 2);
  assert.ok(signals.every(signal => signal.aborted));
});
