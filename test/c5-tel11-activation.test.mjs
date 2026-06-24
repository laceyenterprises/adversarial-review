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
