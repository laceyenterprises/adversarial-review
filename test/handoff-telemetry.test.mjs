import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { handoffMain } from '../src/cli.mjs';
import { createHandoffRateLimiter } from '../src/handoff-rate-cap.mjs';
import {
  HANDOFF_EVENTS,
  buildHandoffEvent,
  collectHandoffStatus,
  collectHandoffTrace,
  handoffEventLogPath,
  recordHandoffEvent,
  recordHandoffWakeEvents,
  renderHandoffStatus,
  renderHandoffTrace,
} from '../src/handoff-telemetry.mjs';

function makeRoot(t) {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'handoff-telemetry-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  return rootDir;
}

function readJsonl(filePath) {
  return readFileSync(filePath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

test('handoff event shapes validate and rotate by UTC day', (t) => {
  const rootDir = makeRoot(t);
  const row = buildHandoffEvent({
    event: HANDOFF_EVENTS.latency,
    at: '2026-07-09T23:59:59.900Z',
    step: 'review_to_remediation',
    repo: 'agent-os',
    prNumber: 3312,
    headSha: 'abc123',
    latencySeconds: 1.2345,
  });

  assert.deepEqual(row, {
    schema_version: 1,
    event: 'handoff_latency_seconds',
    at: '2026-07-09T23:59:59.900Z',
    step: 'review-to-remediation',
    repo: 'agent-os',
    pr_number: 3312,
    head_sha: 'abc123',
    latency_seconds: 1.235,
  });
  assert.throws(() => buildHandoffEvent({ event: 'not-a-handoff' }), /unsupported/);

  const written = recordHandoffEvent({ rootDir, ...row });
  assert.match(written.filePath, /2026-07-09\.jsonl$/);
  assert.deepEqual(readJsonl(handoffEventLogPath(rootDir, row.at)), [row]);
});

test('handoff status and trace match fired handoffs', (t) => {
  const rootDir = makeRoot(t);
  const loadConfigImpl = () => ({
    getHandoffConfig: () => ({
      enabled: true,
      reviewToRemediation: true,
      remediationToRereview: true,
      finalToHammer: false,
    }),
  });

  recordHandoffWakeEvents({
    rootDir,
    target: 'follow-up daemon',
    wokeAt: '2026-07-09T15:22:02.200Z',
    payload: {
      requested_at: '2026-07-09T15:22:01.000Z',
      reason: 'review-to-remediation',
      repo: 'agent-os',
      pr_number: 3312,
      head_sha: 'a',
    },
  });
  recordHandoffWakeEvents({
    rootDir,
    target: 'watcher',
    wokeAt: '2026-07-09T15:24:39.900Z',
    payload: {
      requested_at: '2026-07-09T15:24:39.000Z',
      reason: 'remediation-to-rereview',
      repo: 'agent-os',
      pr_number: 3312,
      head_sha: 'b',
    },
  });
  recordHandoffEvent({
    rootDir,
    event: HANDOFF_EVENTS.fallbackTickCatch,
    at: '2026-07-09T15:25:00.000Z',
    step: 'remediation-to-rereview',
    repo: 'agent-os',
    prNumber: 3312,
    headSha: 'b',
  });

  const status = collectHandoffStatus({
    rootDir,
    repo: 'agent-os',
    window: '24h',
    now: () => new Date('2026-07-09T16:00:00.000Z'),
    loadConfigImpl,
  });
  assert.equal(status.handoffsFired, 2);
  assert.equal(status.medianLatencySeconds, 0.9);
  assert.equal(status.p95LatencySeconds, 1.2);
  assert.equal(status.fallbackTickCatches, 1);

  const statusText = renderHandoffStatus(status);
  assert.match(statusText, /HANDOFF MODE/);
  assert.match(statusText, /handoffs fired \.+ 2/);
  assert.match(statusText, /median step latency \.+ 0\.9s/);
  assert.match(statusText, /fallback-tick catches \.+ 1/);

  const trace = collectHandoffTrace({ rootDir, target: 'agent-os#3312' });
  const traceText = renderHandoffTrace(trace);
  assert.match(traceText, /15:22:02  \|- handoff① -> follow-up daemon woke \(\+1\.2s, not \+120s\)/);
  assert.match(traceText, /15:24:39  \|- handoff② -> watcher woke \(\+0\.9s, not \+300s\)/);
  assert.match(traceText, /fallback tick caught missed remediation->re-review/);
});

test('handoff CLI status and trace render from the event log', (t) => {
  const rootDir = makeRoot(t);
  recordHandoffWakeEvents({
    rootDir,
    target: 'watcher',
    wokeAt: '2026-07-09T15:24:39.900Z',
    payload: {
      requested_at: '2026-07-09T15:24:39.000Z',
      reason: 'remediation-to-rereview',
      repo: 'agent-os',
      pr_number: 3312,
    },
  });

  let out = '';
  let err = '';
  assert.equal(handoffMain(['status', '--root', rootDir, '--repo', 'agent-os', '--window', '365d'], {
    stdout: { write: (chunk) => { out += chunk; } },
    stderr: { write: (chunk) => { err += chunk; } },
  }), 0);
  assert.equal(err, '');
  assert.match(out, /handoffs fired \.+ 1/);

  out = '';
  assert.equal(handoffMain(['trace', 'agent-os#3312', '--root', rootDir], {
    stdout: { write: (chunk) => { out += chunk; } },
    stderr: { write: (chunk) => { err += chunk; } },
  }), 0);
  assert.match(out, /handoff② -> watcher woke/);
});

test('handoff rate cap hit emits unified telemetry', (t) => {
  const rootDir = makeRoot(t);
  const limiter = createHandoffRateLimiter({
    rootDir,
    maxPerPrHead: 1,
    now: () => '2026-07-09T15:00:00.000Z',
    logger: { warn() {} },
  });
  const payload = {
    reason: 'remediation-to-rereview',
    repo: 'agent-os',
    pr_number: 3312,
    head_sha: 'head-a',
  };

  assert.equal(limiter.inspect(payload).accepted, true);
  assert.equal(limiter.inspect(payload).accepted, false);

  const status = collectHandoffStatus({
    rootDir,
    repo: 'agent-os',
    window: '24h',
    now: () => new Date('2026-07-09T16:00:00.000Z'),
    loadConfigImpl: () => ({ getHandoffConfig: () => ({ enabled: false }) }),
  });
  assert.equal(status.rateCapsHit, 1);
});

test('simulated handoff e2e chain records seconds-per-step and mid-flight fallback', (t) => {
  const rootDir = makeRoot(t);
  for (const [step, target, requested, woke] of [
    ['review-to-remediation', 'follow-up daemon', '2026-07-09T15:22:01.000Z', '2026-07-09T15:22:02.200Z'],
    ['remediation-to-rereview', 'watcher', '2026-07-09T15:24:39.000Z', '2026-07-09T15:24:39.900Z'],
    ['final-to-hammer', 'hammer', '2026-07-09T15:24:41.000Z', '2026-07-09T15:24:41.100Z'],
  ]) {
    recordHandoffWakeEvents({
      rootDir,
      target,
      wokeAt: woke,
      payload: {
        requested_at: requested,
        reason: step,
        repo: 'agent-os',
        pr_number: 3312,
        head_sha: 'head-a',
      },
    });
  }
  recordHandoffEvent({
    rootDir,
    event: HANDOFF_EVENTS.fallbackTickCatch,
    at: '2026-07-09T15:25:00.000Z',
    step: 'remediation-to-rereview',
    repo: 'agent-os',
    prNumber: 3312,
    headSha: 'head-a',
    reason: 'kill-switch-disabled-mid-flight',
  });

  const status = collectHandoffStatus({
    rootDir,
    repo: 'agent-os',
    window: '24h',
    now: () => new Date('2026-07-09T16:00:00.000Z'),
    loadConfigImpl: () => ({ getHandoffConfig: () => ({ enabled: true, reviewToRemediation: true, remediationToRereview: true, finalToHammer: true }) }),
  });
  const latencies = status.events
    .filter((event) => event.event === HANDOFF_EVENTS.latency)
    .map((event) => event.latency_seconds);

  assert.equal(status.handoffsFired, 3);
  assert.ok(latencies.every((latency) => latency < 5), `latencies should be seconds-per-step: ${latencies.join(',')}`);
  assert.equal(status.fallbackTickCatches, 1);
  assert.match(renderHandoffTrace(collectHandoffTrace({ rootDir, target: 'agent-os#3312' })), /handoff③ -> hammer woke/);
});
