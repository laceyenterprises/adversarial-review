import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  HARNESS_FALLBACK_ALERT_DEBOUNCE_MS,
  emitHarnessFallbackAlert,
} from '../src/ama/dispatch-closer.mjs';

const HARNESS = {
  provider: 'openai',
  from: 'hammer',
  to: 'hammer-claude',
  primaryState: 'unknown',
  groundedBy: 'soft',
  softGrounding: { reason: 'suspended_lrq_depth', signals: 10, threshold: 3 },
};

test('harness fallback alert is debounced fleet-wide across PRs for the same condition', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-harness-fallback-alert-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const alerts = [];
  const deliverAlertImpl = async (text, structured) => alerts.push({ text, structured });
  const firstAt = Date.parse('2026-08-09T05:00:00.000Z');

  const first = await emitHarnessFallbackAlert({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 5059,
    harness: HARNESS,
    deliverAlertImpl,
    now: firstAt,
  });
  const repeated = await emitHarnessFallbackAlert({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 5060,
    harness: HARNESS,
    deliverAlertImpl,
    now: firstAt + 60_000,
  });

  assert.equal(first.delivered, true);
  assert.deepEqual(repeated, { delivered: false, reason: 'alert-debounced' });
  assert.equal(alerts.length, 1, 'the busy queue must not page once per PR');
  assert.equal(
    readdirSync(join(rootDir, 'data', 'ama-harness-fallback-alerts')).length,
    1,
    'one durable condition-level debounce record is written',
  );
});

test('a changed fallback condition bypasses the debounce as a material escalation', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-harness-fallback-alert-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const alerts = [];
  const deliverAlertImpl = async (text, structured) => alerts.push({ text, structured });
  const firstAt = Date.parse('2026-08-09T05:00:00.000Z');

  await emitHarnessFallbackAlert({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 5059,
    harness: HARNESS,
    deliverAlertImpl,
    now: firstAt,
  });
  const escalated = await emitHarnessFallbackAlert({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 5060,
    harness: { ...HARNESS, groundedBy: 'hard', primaryState: 'exhausted', softGrounding: null },
    deliverAlertImpl,
    now: firstAt + 60_000,
  });

  assert.equal(escalated.delivered, true);
  assert.equal(alerts.length, 2, 'soft-to-hard grounding is an alert-worthy escalation');
});

test('a failed fallback-alert delivery does not create a suppressing debounce record', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-harness-fallback-alert-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const firstAt = Date.parse('2026-08-09T05:00:00.000Z');
  let attempts = 0;
  const deliverAlertImpl = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('alert transport unavailable');
  };

  const failed = await emitHarnessFallbackAlert({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 5059,
    harness: HARNESS,
    deliverAlertImpl,
    now: firstAt,
  });
  const retried = await emitHarnessFallbackAlert({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 5060,
    harness: HARNESS,
    deliverAlertImpl,
    now: firstAt + 60_000,
  });

  assert.equal(failed.delivered, false);
  assert.equal(retried.delivered, true);
  assert.equal(attempts, 2, 'failed alerts remain retryable instead of being suppressed');
  assert.ok(HARNESS_FALLBACK_ALERT_DEBOUNCE_MS > 60_000);
});

test('harness fallback alert state is created with shared group permissions by canonical owner', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-harness-fallback-alert-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const ownerUid = statSync(rootDir).uid;

  await emitHarnessFallbackAlert({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 5059,
    harness: HARNESS,
    deliverAlertImpl: async () => {},
    now: Date.parse('2026-08-09T05:00:00.000Z'),
    currentUidImpl: () => ownerUid,
  });

  const stateDir = join(rootDir, 'data', 'ama-harness-fallback-alerts');
  const [stateFile] = readdirSync(stateDir);
  assert.equal(statSync(stateDir).mode & 0o777, 0o775);
  assert.equal(statSync(join(stateDir, stateFile)).mode & 0o777, 0o664);
});

test('harness fallback alert state delegates cross-user directory creation to canonical owner', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-harness-fallback-alert-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const ownerUid = statSync(rootDir).uid;
  const calls = [];
  const spawnSyncImpl = (command, args) => {
    calls.push({ command, args });
    if (command === 'id') return { status: 0, stdout: 'airlock\n', stderr: '' };
    if (command === 'sudo') return { status: 0, stdout: '/tmp/state.json', stderr: '' };
    return { status: 1, stdout: '', stderr: `unexpected command ${command}` };
  };

  const result = await emitHarnessFallbackAlert({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 5059,
    harness: HARNESS,
    deliverAlertImpl: async () => {},
    now: Date.parse('2026-08-09T05:00:00.000Z'),
    currentUidImpl: () => ownerUid + 1,
    spawnSyncImpl,
  });

  assert.deepEqual(result, { delivered: true });
  assert.equal(existsSync(join(rootDir, 'data', 'ama-harness-fallback-alerts')), false);
  assert.equal(calls[0].command, 'id');
  assert.deepEqual(calls[0].args, ['-un', String(ownerUid)]);
  assert.equal(calls[1].command, 'sudo');
  assert.deepEqual(calls[1].args.slice(0, 5), ['-A', '-H', '-u', 'airlock', process.execPath]);
  assert.ok(calls[1].args.includes('--input-type=module'));
});
