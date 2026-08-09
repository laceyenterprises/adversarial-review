import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
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

test('a noncanonical caller cannot first-create shared fallback debounce state', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-harness-fallback-alert-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const dataDir = join(rootDir, 'data');
  const stateDir = join(dataDir, 'ama-harness-fallback-alerts');
  mkdirSync(dataDir, { recursive: true });
  const alerts = [];
  const warnings = [];
  const result = await emitHarnessFallbackAlert({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 5059,
    harness: HARNESS,
    deliverAlertImpl: async (text, structured) => alerts.push({ text, structured }),
    logger: { warn: (message) => warnings.push(JSON.parse(message)) },
    ownerGuardOptions: {
      currentUid: () => 501,
      exists: existsSync,
      stat: (path) => (path === dataDir ? { uid: 502 } : { uid: 501 }),
    },
  });

  assert.equal(result.delivered, true, 'the merge alert itself remains fail-open');
  assert.equal(alerts.length, 1);
  assert.equal(existsSync(stateDir), false, 'a noncanonical caller must not create shared state');
  assert.equal(warnings[0]?.event, 'ama_closer.harness_fallback_alert_debounce_write_failed');
  assert.match(warnings[0]?.error || '', /refusing cross-user harness fallback debounce state write/);
});
