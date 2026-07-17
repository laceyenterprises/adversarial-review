import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildAuditRow,
  buildNoticeText,
  createRouterAuditSink,
  routerAuditDir,
} from '../src/adapters/agent-runtime/router/audit.mjs';
import { TRANSITION_KINDS } from '../src/adapters/agent-runtime/router/state-machine.mjs';

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), 'router-audit-'));
}

function failoverTransition(overrides = {}) {
  return {
    kind: TRANSITION_KINDS.FAILOVER,
    reason: 'probe-failures',
    from: 'os-healthy',
    to: 'local-fallback',
    fromMode: 'os',
    toMode: 'local',
    at: '2026-07-17T09:00:00.000Z',
    probeFailures: 3,
    detail: 'healthz failed',
    ...overrides,
  };
}

function resumeTransition() {
  return {
    kind: TRANSITION_KINDS.RESUME_COMPLETE,
    reason: 'resume-complete',
    from: 'os-resuming',
    to: 'os-healthy',
    fromMode: 'local',
    toMode: 'os',
    at: '2026-07-17T09:12:04.000Z',
    reconcile: { adoptedCount: 2, duplicatedCount: 0, notFoundCount: 1, unknownCount: 0 },
  };
}

test('buildAuditRow maps a failover transition to a structured event row', () => {
  const row = buildAuditRow(failoverTransition(), '2026-07-17T09:00:00.000Z');
  assert.equal(row.event, 'runtime.router.failover');
  assert.equal(row.schema_version, 1);
  assert.equal(row.from_mode, 'os');
  assert.equal(row.to_mode, 'local');
  assert.equal(row.probe_failures, 3);
  assert.equal(row.reconcile, null);
});

test('buildAuditRow flattens the reconcile summary on a resume row', () => {
  const row = buildAuditRow(resumeTransition(), '2026-07-17T09:12:04.000Z');
  assert.equal(row.event, 'runtime.router.resume');
  assert.deepEqual(row.reconcile, { adopted: 2, not_found: 1, unknown: 0, duplicated: 0 });
});

test('buildNoticeText surfaces the reconcile tally for operators', () => {
  const row = buildAuditRow(resumeTransition(), '2026-07-17T09:12:04.000Z');
  const text = buildNoticeText(row);
  assert.match(text, /runtime\.router\.resume/);
  assert.match(text, /local -> os/);
  assert.match(text, /2 adopted, 0 duplicated/);
});

test('recordTransition writes a durable audit row, delivers a notice, emits telemetry', async () => {
  const rootDir = tmpRoot();
  try {
    const notices = [];
    const telemetry = [];
    const sink = createRouterAuditSink({
      rootDir,
      deliverNoticeFn: async (text, meta) => { notices.push({ text, meta }); },
      emitTelemetryFn: async (evt) => { telemetry.push(evt); },
    });

    const outcome = await sink.recordTransition(failoverTransition());

    assert.equal(outcome.auditWritten, true);
    assert.equal(outcome.noticeDelivered, true);
    assert.equal(outcome.telemetryEmitted, true);

    // Audit row is on disk under the app store.
    const filePath = join(routerAuditDir(rootDir), '2026-07.jsonl');
    assert.ok(existsSync(filePath), 'audit jsonl file should exist');
    const lines = readFileSync(filePath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.event, 'runtime.router.failover');
    assert.equal(parsed.to_mode, 'local');

    // Operator notice carried the event + structured payload.
    assert.equal(notices.length, 1);
    assert.equal(notices[0].meta.event, 'runtime.router.failover');
    assert.match(notices[0].text, /Adversarial runtime router/);

    // Telemetry event fired.
    assert.equal(telemetry.length, 1);
    assert.equal(telemetry[0].event, 'runtime.router.failover');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('a notice-delivery failure does not block the durable audit row', async () => {
  const rootDir = tmpRoot();
  try {
    const errors = [];
    const sink = createRouterAuditSink({
      rootDir,
      deliverNoticeFn: async () => { throw new Error('hooks unreachable'); },
      emitTelemetryFn: null,
      logger: { error: (...a) => errors.push(a), warn() {} },
    });
    const outcome = await sink.recordTransition(failoverTransition());
    assert.equal(outcome.auditWritten, true, 'row must persist even when the notice fails');
    assert.equal(outcome.noticeDelivered, false);
    assert.ok(existsSync(join(routerAuditDir(rootDir), '2026-07.jsonl')));
    assert.ok(errors.length >= 1, 'the notice failure should be logged');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('best-effort telemetry failure never throws upward', async () => {
  const rootDir = tmpRoot();
  try {
    const sink = createRouterAuditSink({
      rootDir,
      deliverNoticeFn: async () => {},
      emitTelemetryFn: async () => { throw new Error('telemetry down'); },
      logger: { warn() {}, error() {} },
    });
    const outcome = await sink.recordTransition(resumeTransition());
    assert.equal(outcome.auditWritten, true);
    assert.equal(outcome.noticeDelivered, true);
    assert.equal(outcome.telemetryEmitted, false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
