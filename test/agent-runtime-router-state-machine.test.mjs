import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ROUTER_STATES,
  TRANSITION_KINDS,
  createRouterStateMachine,
  modeForState,
} from '../src/adapters/agent-runtime/router/state-machine.mjs';
import { resolveRouterConfig } from '../src/adapters/agent-runtime/router/config.mjs';

function machineWith(overrides = {}, { startMs = 1_000 } = {}) {
  const config = resolveRouterConfig({}, {
    probeFailureThreshold: 3,
    resumeHealthyProbes: 6,
    resumeWindowMs: 300_000,
    ...overrides,
  });
  let clockMs = startMs;
  const now = () => clockMs;
  const machine = createRouterStateMachine({ config, now });
  return {
    machine,
    config,
    advance(ms) { clockMs += ms; return clockMs; },
    setClock(ms) { clockMs = ms; return clockMs; },
    clock: () => clockMs,
  };
}

test('modeForState maps only OS-HEALTHY to os; resuming stays local', () => {
  assert.equal(modeForState(ROUTER_STATES.OS_HEALTHY), 'os');
  assert.equal(modeForState(ROUTER_STATES.LOCAL_FALLBACK), 'local');
  assert.equal(modeForState(ROUTER_STATES.OS_RESUMING), 'local');
});

test('k-1 probe failures then a healthy probe does NOT fail over (flap resistance)', () => {
  const { machine } = machineWith();
  assert.equal(machine.recordProbe({ healthy: false }), null);
  assert.equal(machine.recordProbe({ healthy: false }), null); // 2 == k-1
  // A single healthy probe resets the failure streak.
  assert.equal(machine.recordProbe({ healthy: true }), null);
  assert.equal(machine.getState(), ROUTER_STATES.OS_HEALTHY);
  // Now it takes a fresh run of k failures.
  assert.equal(machine.recordProbe({ healthy: false }), null);
  assert.equal(machine.recordProbe({ healthy: false }), null);
  const t = machine.recordProbe({ healthy: false });
  assert.ok(t, 'third consecutive failure should trip failover');
  assert.equal(t.kind, TRANSITION_KINDS.FAILOVER);
  assert.equal(t.reason, 'probe-failures');
  assert.equal(t.probeFailures, 3);
  assert.equal(t.from, ROUTER_STATES.OS_HEALTHY);
  assert.equal(t.to, ROUTER_STATES.LOCAL_FALLBACK);
  assert.equal(t.toMode, 'local');
  assert.equal(machine.getMode(), 'local');
});

test('exactly k consecutive failures trips failover; not k-1', () => {
  const { machine } = machineWith({ probeFailureThreshold: 3 });
  assert.equal(machine.recordProbe({ healthy: false }), null);
  assert.equal(machine.recordProbe({ healthy: false }), null);
  assert.ok(machine.recordProbe({ healthy: false }));
  assert.equal(machine.getState(), ROUTER_STATES.LOCAL_FALLBACK);
});

test('hard contract error fails over immediately, bypassing the failure counter', () => {
  const { machine } = machineWith();
  const t = machine.recordHardError({ detail: '503 upstream down', requestId: 'k1' });
  assert.ok(t);
  assert.equal(t.kind, TRANSITION_KINDS.FAILOVER);
  assert.equal(t.reason, 'hard-contract-error');
  assert.equal(t.detail, '503 upstream down');
  assert.equal(t.requestId, 'k1');
  assert.equal(machine.getMode(), 'local');
  // A second hard error while already local is a no-op.
  assert.equal(machine.recordHardError({ detail: 'again' }), null);
});

test('resume requires m healthy probes AND a >= w span (hysteresis)', () => {
  const h = machineWith({ probeFailureThreshold: 1, resumeHealthyProbes: 6, resumeWindowMs: 300_000 });
  // Trip to local.
  assert.ok(h.machine.recordProbe({ healthy: false, at: h.clock() }));
  assert.equal(h.machine.getState(), ROUTER_STATES.LOCAL_FALLBACK);

  // Six healthy probes but packed into < w: no resume.
  for (let i = 0; i < 6; i += 1) {
    h.advance(1_000); // 6 * 1s = 6s span, well under 5 minutes
    const t = h.machine.recordProbe({ healthy: true, at: h.clock() });
    assert.equal(t, null, `probe ${i} inside the window must not resume`);
  }
  assert.equal(h.machine.getState(), ROUTER_STATES.LOCAL_FALLBACK);
});

test('resume fires once m healthy probes span >= w minutes', () => {
  const h = machineWith({ probeFailureThreshold: 1, resumeHealthyProbes: 6, resumeWindowMs: 300_000 });
  assert.ok(h.machine.recordProbe({ healthy: false, at: h.clock() }));

  let transition = null;
  for (let i = 0; i < 6; i += 1) {
    h.advance(60_000); // 1 minute apart → 6th probe spans 5 minutes
    transition = h.machine.recordProbe({ healthy: true, at: h.clock() });
  }
  assert.ok(transition, 'the 6th healthy probe spanning 5m should start resume');
  assert.equal(transition.kind, TRANSITION_KINDS.RESUME_START);
  assert.equal(transition.requiresReconcile, true);
  assert.equal(transition.healthyProbes, 6);
  assert.ok(transition.spanMs >= 300_000);
  assert.equal(h.machine.getState(), ROUTER_STATES.OS_RESUMING);
  assert.equal(h.machine.getMode(), 'local', 'resuming still routes new work to local until reconcile completes');
});

test('a failed probe mid-streak resets the resume hysteresis', () => {
  // Span is measured from the first healthy probe of the current streak, so 3
  // probes 40s apart span 80s (>= 60s window) at the 3rd.
  const h = machineWith({ probeFailureThreshold: 1, resumeHealthyProbes: 3, resumeWindowMs: 60_000 });
  assert.ok(h.machine.recordProbe({ healthy: false, at: h.clock() }));

  // Two healthy, then a failure wipes the streak.
  h.advance(40_000); h.machine.recordProbe({ healthy: true, at: h.clock() });
  h.advance(40_000); h.machine.recordProbe({ healthy: true, at: h.clock() });
  h.advance(1_000); assert.equal(h.machine.recordProbe({ healthy: false, at: h.clock() }), null);

  // Now a fresh streak of 3 healthy probes spanning >= 60s is required.
  h.advance(40_000); assert.equal(h.machine.recordProbe({ healthy: true, at: h.clock() }), null); // span 0
  h.advance(40_000); assert.equal(h.machine.recordProbe({ healthy: true, at: h.clock() }), null); // span 40s
  h.advance(40_000);
  const t = h.machine.recordProbe({ healthy: true, at: h.clock() }); // count 3, span 80s
  assert.ok(t);
  assert.equal(t.kind, TRANSITION_KINDS.RESUME_START);
});

// Drive a fresh machine to OS-RESUMING (failover, then two healthy probes 10ms
// apart clearing an m=2/w=1 hysteresis).
function driveToResuming() {
  const h = machineWith({ probeFailureThreshold: 1, resumeHealthyProbes: 2, resumeWindowMs: 1 });
  assert.ok(h.machine.recordProbe({ healthy: false, at: h.clock() }));
  h.advance(10);
  assert.equal(h.machine.recordProbe({ healthy: true, at: h.clock() }), null);
  h.advance(10);
  assert.ok(h.machine.recordProbe({ healthy: true, at: h.clock() }));
  assert.equal(h.machine.getState(), ROUTER_STATES.OS_RESUMING);
  return h;
}

test('completeResume advances OS-RESUMING -> OS-HEALTHY carrying the reconcile summary', () => {
  const h = driveToResuming();

  const summary = { adoptedCount: 2, duplicatedCount: 0, notFoundCount: 1, unknownCount: 0 };
  const done = h.machine.completeResume(summary);
  assert.ok(done);
  assert.equal(done.kind, TRANSITION_KINDS.RESUME_COMPLETE);
  assert.equal(done.from, ROUTER_STATES.OS_RESUMING);
  assert.equal(done.to, ROUTER_STATES.OS_HEALTHY);
  assert.deepEqual(done.reconcile, summary);
  assert.equal(h.machine.getMode(), 'os');
  // completeResume is only valid from OS-RESUMING.
  assert.equal(h.machine.completeResume(summary), null);
});

test('a probe failure during OS-RESUMING aborts back to LOCAL-FALLBACK', () => {
  const h = driveToResuming();
  const t = h.machine.recordProbe({ healthy: false, at: h.clock() });
  assert.ok(t);
  assert.equal(t.kind, TRANSITION_KINDS.RESUME_ABORTED);
  assert.equal(t.to, ROUTER_STATES.LOCAL_FALLBACK);
  assert.equal(h.machine.getMode(), 'local');
});

test('hard error during OS-RESUMING also aborts to LOCAL-FALLBACK', () => {
  const h = driveToResuming();
  const t = h.machine.recordHardError({ detail: 'transport reset' });
  assert.ok(t);
  assert.equal(t.to, ROUTER_STATES.LOCAL_FALLBACK);
});

test('transition history retains only the most recent 100 entries', () => {
  const h = machineWith({ probeFailureThreshold: 1, resumeHealthyProbes: 2, resumeWindowMs: 1 });
  for (let cycle = 0; cycle < 40; cycle += 1) {
    h.machine.recordProbe({ healthy: false, at: h.clock() });
    h.advance(1);
    h.machine.recordProbe({ healthy: true, at: h.clock() });
    h.advance(1);
    h.machine.recordProbe({ healthy: true, at: h.clock() });
    h.machine.completeResume();
  }

  const history = h.machine.getHistory();
  assert.equal(history.length, 100);
  assert.equal(history.at(-1).kind, TRANSITION_KINDS.RESUME_COMPLETE);
  assert.ok(history[0].atMs > 1_000, 'oldest transitions are pruned');
});
