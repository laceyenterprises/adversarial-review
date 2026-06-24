import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  activateTel11ForC5Closure,
  buildActivationRecord,
  commandTel11Detector,
  enforceTel11StandingDetectionsAfterActivation,
} from '../src/c5-tel11-activation.mjs';

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'c5-tel11-activation-'));
}

test('TEL-11 activation returning not-live records non-live state and blocks C5 closure', async () => {
  const alerts = [];
  const result = await activateTel11ForC5Closure({
    rootDir: tempRoot(),
    c5RunId: 'c5-run-001',
    c5DeployId: 'deploy-abc',
    c5RemovalArtifact: 'artifact://c5/removal/001',
    runTel11StandingDetections: async () => ({
      live: false,
      reason: 'tel11-pack-not-live',
      detectorRef: 'tel-11@fixture',
    }),
    alert: async (text, options) => alerts.push({ text, options }),
  });

  assert.equal(result.accepted, false);
  assert.equal(result.holdClosure, true);
  assert.equal(result.rollbackRequired, true);
  assert.equal(result.record.live, false);
  assert.equal(result.record.rollback.required, true);
  assert.equal(result.record.rollback.holdClosure, true);
  assert.equal(result.record.tel11.reason, 'tel11-pack-not-live');
  assert.equal(alerts.length, 1);

  const persisted = JSON.parse(readFileSync(result.recordPath, 'utf8'));
  assert.equal(persisted.status, 'not-live');
  assert.equal(persisted.c5.runId, 'c5-run-001');
  assert.equal(persisted.c5.deployId, 'deploy-abc');
});

test('TEL-11 activation still returns blocked closure when alert delivery fails', async () => {
  const originalError = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args.join(' '));
  try {
    const result = await activateTel11ForC5Closure({
      rootDir: tempRoot(),
      c5RunId: 'c5-run-alert-failure',
      c5DeployId: 'deploy-alert-failure',
      runTel11StandingDetections: async () => ({
        live: false,
        reason: 'tel11-pack-not-live',
      }),
      alert: async () => {
        throw new Error('webhook unavailable');
      },
    });

    assert.equal(result.accepted, false);
    assert.equal(result.holdClosure, true);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /Failed to deliver blocked-closure alert: webhook unavailable/);
  } finally {
    console.error = originalError;
  }
});

test('live activation record includes the C5 run and deploy identity for RCD-G7A', async () => {
  const result = await activateTel11ForC5Closure({
    rootDir: tempRoot(),
    c5RunId: 'c5-run-live',
    c5DeployId: 'deploy-live',
    c5RemovalArtifact: 'artifact://c5/removal/live',
    rcdG7aPr: 'laceyenterprises/agent-os#1234',
    adversarialReviewPr: 'laceyenterprises/adversarial-review#pending',
    runTel11StandingDetections: async () => ({
      live: true,
      reason: 'tel11-standing-detections-live',
      detectorRef: 'tel-11@live',
    }),
    shouldAlert: false,
  });

  assert.equal(result.accepted, true);
  assert.equal(result.holdClosure, false);
  assert.equal(result.record.live, true);
  assert.deepEqual(result.record.c5, {
    runId: 'c5-run-live',
    deployId: 'deploy-live',
    removalArtifact: 'artifact://c5/removal/live',
  });
  assert.equal(result.record.acceptGate.consumer, 'agent-os RCD-G7A');
  assert.equal(result.record.acceptGate.requiredForClosureAcceptance, true);
  assert.equal(result.record.acceptGate.rcdG7aPr, 'laceyenterprises/agent-os#1234');
  assert.equal(result.record.acceptGate.adversarialReviewPr, 'laceyenterprises/adversarial-review#pending');
});

test('synthetic OpenClaw reintroduction after activation invokes standing detection and pages fail-loud', async () => {
  const record = buildActivationRecord({
    c5RunId: 'c5-run-reintro',
    c5DeployId: 'deploy-reintro',
    activation: {
      live: true,
      status: 'live',
      reason: 'tel11-live',
      detectorRef: 'tel-11@fixture',
      checkedAt: '2026-06-24T22:00:00Z',
      findings: [],
    },
  });
  const phases = [];
  const alerts = [];

  const result = await enforceTel11StandingDetectionsAfterActivation({
    activationRecord: record,
    runTel11StandingDetections: async ({ phase }) => {
      phases.push(phase);
      return {
        live: true,
        reason: 'openclaw-config-dependency-found',
        detectorRef: 'tel-11@fixture',
        findings: [{ kind: 'config-dependency', path: 'config.yaml', package: 'openclaw' }],
      };
    },
    alert: async (text, options) => alerts.push({ text, options }),
  });

  assert.deepEqual(phases, ['post-activation-openclaw-reintroduction-check']);
  assert.equal(result.ok, false);
  assert.equal(result.failLoud, true);
  assert.equal(result.detection.findings.length, 1);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].options.event, 'runtime_cutover.tel11_openclaw_reintroduction');
  assert.equal(alerts[0].options.payload.findingsCount, 1);
});

test('OpenClaw reintroduction enforcement still returns fail-loud when alert delivery fails', async () => {
  const record = buildActivationRecord({
    c5RunId: 'c5-run-reintro-alert-failure',
    c5DeployId: 'deploy-reintro-alert-failure',
    activation: {
      live: true,
      status: 'live',
      reason: 'tel11-live',
      detectorRef: 'tel-11@fixture',
      checkedAt: '2026-06-24T22:00:00Z',
      findings: [],
    },
  });
  const originalError = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args.join(' '));
  try {
    const result = await enforceTel11StandingDetectionsAfterActivation({
      activationRecord: record,
      runTel11StandingDetections: async () => ({
        live: true,
        reason: 'openclaw-config-dependency-found',
        findings: [{ kind: 'config-dependency', path: 'config.yaml', package: 'openclaw' }],
      }),
      alert: async () => {
        throw new Error('pager unavailable');
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.failLoud, true);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /Failed to deliver openclaw-reintroduction alert: pager unavailable/);
  } finally {
    console.error = originalError;
  }
});

test('activation handshake is synchronous before closure acceptance is returned', async () => {
  const events = [];
  const resultPromise = activateTel11ForC5Closure({
    rootDir: tempRoot(),
    c5RunId: 'c5-run-sync',
    c5DeployId: 'deploy-sync',
    runTel11StandingDetections: async () => {
      events.push('detector-start');
      await new Promise((resolve) => setTimeout(resolve, 10));
      events.push('detector-finish');
      return { live: true, reason: 'tel11-live' };
    },
    shouldAlert: false,
  }).then((result) => {
    events.push('closure-returned');
    return result;
  });

  assert.deepEqual(events, ['detector-start']);
  const result = await resultPromise;
  assert.equal(result.accepted, true);
  assert.deepEqual(events, ['detector-start', 'detector-finish', 'closure-returned']);
});

test('command TEL-11 detector returns not-live when no command is configured', async () => {
  const detector = commandTel11Detector({ env: {} });
  assert.deepEqual(await detector({}), {
    live: false,
    reason: 'tel11-standing-detections-command-not-configured',
  });
});

test('command TEL-11 detector forwards the requested verification phase', async () => {
  const calls = [];
  const detector = commandTel11Detector({
    command: ['tel11-detector', '--mode', 'standing'],
    execFileImpl: async (bin, args, options) => {
      calls.push({ bin, args, options });
      return { stdout: JSON.stringify({ live: true, reason: 'tel11-live' }) };
    },
    env: {},
  });

  const result = await detector({
    phase: 'post-activation-openclaw-reintroduction-check',
    c5RunId: 'c5-run-phase',
    c5DeployId: 'deploy-phase',
    c5RemovalArtifact: 'artifact://removal/phase',
  });

  assert.equal(result.live, true);
  assert.equal(calls[0].bin, 'tel11-detector');
  assert.deepEqual(calls[0].args, [
    '--mode',
    'standing',
    '--phase',
    'post-activation-openclaw-reintroduction-check',
    '--c5-run-id',
    'c5-run-phase',
    '--c5-deploy-id',
    'deploy-phase',
    '--c5-removal-artifact',
    'artifact://removal/phase',
    '--json',
  ]);
  assert.equal(calls[0].options.timeout, 30000);
});

test('command TEL-11 detector parses JSON stdout from non-zero verification exits', async () => {
  const detector = commandTel11Detector({
    command: ['tel11-detector'],
    execFileImpl: async () => {
      const err = new Error('Command failed: tel11-detector');
      err.code = 1;
      err.stdout = Buffer.from(JSON.stringify({
        live: false,
        reason: 'openclaw-config-dependency-found',
        findings: [{ path: 'config.yaml', package: 'openclaw' }],
      }));
      throw err;
    },
    env: {},
  });

  const result = await detector({ c5RunId: 'c5-run-exit', c5DeployId: 'deploy-exit' });

  assert.equal(result.live, false);
  assert.equal(result.reason, 'openclaw-config-dependency-found');
  assert.equal(result.findings.length, 1);
});

test('command TEL-11 detector retries transient child-process failures before failing closed', async () => {
  let attempts = 0;
  const detector = commandTel11Detector({
    command: ['tel11-detector'],
    retryDelayMs: 0,
    execFileImpl: async () => {
      attempts += 1;
      if (attempts < 3) {
        const err = new Error('Command failed: tel11-detector\nstderr: temporary EIO while launchd settled');
        err.code = 1;
        throw err;
      }
      return { stdout: JSON.stringify({ live: true, reason: 'tel11-live-after-retry' }) };
    },
    env: {},
  });

  const result = await detector({ c5RunId: 'c5-run-retry', c5DeployId: 'deploy-retry' });

  assert.equal(attempts, 3);
  assert.equal(result.live, true);
  assert.equal(result.reason, 'tel11-live-after-retry');
});

test('command TEL-11 detector splits single quotes and escaped spaces in configured command', async () => {
  const calls = [];
  const detector = commandTel11Detector({
    command: "tel11-detector --label 'quoted value' --path escaped\\ value",
    execFileImpl: async (bin, args) => {
      calls.push({ bin, args });
      return { stdout: JSON.stringify({ live: true }) };
    },
    env: {},
  });

  await detector({ c5RunId: 'c5-run-quoted', c5DeployId: 'deploy-quoted' });

  assert.equal(calls[0].bin, 'tel11-detector');
  assert.deepEqual(calls[0].args.slice(0, 4), ['--label', 'quoted value', '--path', 'escaped value']);
});
