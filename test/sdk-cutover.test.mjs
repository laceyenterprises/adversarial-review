import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSdkCutoverReport,
  createRereviewRecoveryFixture,
  sdkCutoverCheckMain,
} from '../src/sdk-cutover.mjs';
import { main as cliMain } from '../src/cli.mjs';

const NOW = '2026-08-03T06:30:00.000Z';

function readyObservations() {
  return {
    runtime: {
      mode: 'os',
      probe: {
        healthy: true,
        components: {
          dispatchP95Ms: 1_200,
          dispatchP95Ok: true,
        },
      },
      config: { dispatchP95ThresholdMs: 5_000 },
      canary: { status: 'pass', at: NOW },
      settleSmoke: { ok: true, reason: 'pass' },
      reviewerCutover: {
        ready: true,
        selectedRuntime: 'agent-runtime',
      },
    },
    remediation: {
      ready: true,
      orchestrationMode: 'agentos',
      runtimeMode: 'os',
      selectedRuntime: 'agent-runtime',
      completionShape: 'branch-push',
      directSpawnReferences: 0,
    },
    drill: {
      ok: true,
      metrics: { duplicated: 0 },
    },
    alerts: {
      ready: true,
      lastDeliveredAt: '2026-08-03T06:20:00.000Z',
      pendingCount: 0,
      inflightCount: 0,
      quarantineCount: 0,
      deadLetterCount: 0,
    },
    branchProtection: {
      ok: true,
      context: 'agent-os/adversarial-gate',
      reason: 'required-context-present',
      requiredContexts: ['agent-os/adversarial-gate'],
    },
    pipeline: {
      mergeStalls: { candidates: [] },
      findings: [],
    },
    fidelity: {
      ready: true,
      livePrState: 'merged',
      liveHead: 'abc123',
      reviewedHead: 'abc123',
      jobHead: 'abc123',
      headMatches: true,
      reviewStatus: 'posted',
      verdict: 'comment-only',
      criticalFollowUps: 0,
      blockingFindings: 0,
      blockingFindingState: 'known',
      followUpState: 'stopped',
    },
    rereviewRecovery: {
      ready: true,
      triggered: true,
      status: 'pending',
      reason: 'review-status-reset',
    },
  };
}

async function reportFor(observations) {
  return buildSdkCutoverReport({
    repo: 'laceyenterprises/agent-os',
    prNumber: 4562,
    now: () => new Date(NOW),
    observations,
  });
}

function gate(report, id) {
  return report.gates.find((entry) => entry.id === id);
}

test('createRereviewRecoveryFixture proves the operator re-review recovery path in a sandbox', () => {
  const result = createRereviewRecoveryFixture({ now: () => new Date(NOW) });
  assert.equal(result.ready, true);
  assert.equal(result.triggered, true);
  assert.equal(result.status, 'pending');
});

test('buildSdkCutoverReport returns READY when every ARC-25..31 gate passes', async () => {
  const report = await reportFor(readyObservations());
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.kind, 'sdk-cutover-readiness');
  assert.equal(report.ready, true);
  assert.equal(report.cutover, 'READY');
  assert.equal(report.gates.length, 7);
  assert.deepEqual(report.blockers, []);
});

test('buildSdkCutoverReport returns NOT_READY for ARC-25 reviewer cutover blocker', async () => {
  const observations = readyObservations();
  observations.runtime.reviewerCutover.ready = false;
  observations.runtime.reviewerCutover.selectedRuntime = 'agent-os-hq';
  const report = await reportFor(observations);
  assert.equal(report.cutover, 'NOT_READY');
  assert.equal(gate(report, 'ARC-25').ready, false);
  assert.equal(gate(report, 'ARC-25').reasons[0].code, 'reviewer-runtime-not-ready');
});

test('buildSdkCutoverReport returns NOT_READY for ARC-26 remediation mode blocker', async () => {
  const observations = readyObservations();
  observations.remediation.runtimeMode = 'local';
  observations.remediation.selectedRuntime = 'local';
  const report = await reportFor(observations);
  assert.equal(report.cutover, 'NOT_READY');
  assert.equal(gate(report, 'ARC-26').ready, false);
  assert.equal(gate(report, 'ARC-26').reasons[0].code, 'remediation-runtime-not-os');
});

test('buildSdkCutoverReport returns NOT_READY for ARC-27 fidelity blocker', async () => {
  const observations = readyObservations();
  observations.fidelity.verdict = 'request-changes';
  observations.fidelity.criticalFollowUps = 1;
  observations.fidelity.blockingFindings = 2;
  const report = await reportFor(observations);
  assert.equal(report.cutover, 'NOT_READY');
  assert.equal(gate(report, 'ARC-27').ready, false);
  assert.ok(gate(report, 'ARC-27').reasons.some(
    (entry) => entry.code === 'clean-verdict-followup-fidelity-failed',
  ));
});

test('buildSdkCutoverReport returns NOT_READY for ARC-28 alert sink blocker', async () => {
  const observations = readyObservations();
  observations.alerts.ready = false;
  observations.alerts.lastFailureReason = 'agent-gateway unavailable';
  const report = await reportFor(observations);
  assert.equal(report.cutover, 'NOT_READY');
  assert.equal(gate(report, 'ARC-28').ready, false);
  assert.equal(gate(report, 'ARC-28').reasons[0].code, 'alert-sink-not-ready');
});

test('buildSdkCutoverReport returns NOT_READY for ARC-29 branch protection blocker', async () => {
  const observations = readyObservations();
  observations.branchProtection.ok = false;
  observations.branchProtection.reason = 'required-context-missing';
  const report = await reportFor(observations);
  assert.equal(report.cutover, 'NOT_READY');
  assert.equal(gate(report, 'ARC-29').ready, false);
  assert.equal(gate(report, 'ARC-29').reasons[0].code, 'branch-protection-gate-missing');
});

test('buildSdkCutoverReport returns NOT_READY for ARC-30 dispatch SLO blocker', async () => {
  const observations = readyObservations();
  observations.runtime.probe.components.dispatchP95Ms = 7_000;
  observations.runtime.probe.components.dispatchP95Ok = false;
  observations.pipeline.mergeStalls.candidates.push({ repo: 'laceyenterprises/agent-os', prNumber: 99 });
  const report = await reportFor(observations);
  assert.equal(report.cutover, 'NOT_READY');
  assert.equal(gate(report, 'ARC-30').ready, false);
  assert.deepEqual(
    gate(report, 'ARC-30').reasons.map((entry) => entry.code),
    ['dispatch-p95-not-ready', 'no-progress-stale-prs'],
  );
});

test('buildSdkCutoverReport returns NOT_READY for ARC-31 rereview recovery blocker', async () => {
  const observations = readyObservations();
  observations.rereviewRecovery.ready = false;
  observations.rereviewRecovery.status = 'blocked';
  const report = await reportFor(observations);
  assert.equal(report.cutover, 'NOT_READY');
  assert.equal(gate(report, 'ARC-31').ready, false);
  assert.equal(gate(report, 'ARC-31').reasons[0].code, 'rereview-recovery-fixture-failed');
});

test('sdkCutoverCheckMain emits JSON and exits 0 when report is READY', async () => {
  let output = '';
  let error = '';
  const code = await sdkCutoverCheckMain([
    'check',
    '--repo',
    'laceyenterprises/agent-os',
    '--pr',
    '4562',
    '--json',
  ], {
    stdout: { write: (value) => { output += value; } },
    stderr: { write: (value) => { error += value; } },
    buildReportImpl: async (options) => reportFor({
      ...readyObservations(),
      targetOptions: options,
    }),
  });
  assert.equal(code, 0);
  assert.equal(error, '');
  assert.equal(JSON.parse(output).cutover, 'READY');
});

test('sdkCutoverCheckMain accepts top-level sdk-cutover help without the check subcommand', async () => {
  let output = '';
  let error = '';
  const code = await sdkCutoverCheckMain(['--help'], {
    stdout: { write: (value) => { output += value; } },
    stderr: { write: (value) => { error += value; } },
  });
  assert.equal(code, 0);
  assert.match(output, /sdk-cutover check/u);
  assert.equal(error, '');
});

test('general CLI lazily loads sdk-cutover and routes its help command', async () => {
  let output = '';
  let error = '';
  const code = await cliMain(['sdk-cutover', '--help'], {
    stdout: { write: (value) => { output += value; } },
    stderr: { write: (value) => { error += value; } },
  });
  assert.equal(code, 0);
  assert.match(output, /sdk-cutover check/u);
  assert.equal(error, '');
});
