// Router transition audit (v2 app architecture §6.5). Every mode transition
// emits three things, in this order of durability:
//   1. a structured audit row in the app store (durable — logged if it fails);
//   2. an operator notice through the operator surface;
//   3. a best-effort app-contract telemetry event (never throws upward).
// Each recorded agent run carries `runtimeMode` elsewhere; this module records
// the transitions themselves so failover/resume provenance is inspectable.

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { deliverAlert } from '../../../alert-delivery.mjs';
import { assertCanonicalAppendOwner } from '../append-only-owner.mjs';
import { TRANSITION_KINDS } from './state-machine.mjs';

const AUDIT_SCHEMA_VERSION = 1;

// Transition kind → operator-facing event name (audit row + telemetry topic).
const EVENT_BY_KIND = Object.freeze({
  [TRANSITION_KINDS.FAILOVER]: 'runtime.router.failover',
  [TRANSITION_KINDS.RESUME_START]: 'runtime.router.resume_start',
  [TRANSITION_KINDS.RESUME_COMPLETE]: 'runtime.router.resume',
  [TRANSITION_KINDS.RESUME_ABORTED]: 'runtime.router.resume_aborted',
});

function routerAuditDir(rootDir) {
  return join(rootDir, 'data', 'runtime-router-audit');
}

function monthFilePath(rootDir, iso) {
  const stamp = String(iso ?? '');
  if (!/^\d{4}-(0[1-9]|1[0-2])/.test(stamp)) {
    throw new Error(`invalid router audit timestamp: ${iso}`);
  }
  return join(routerAuditDir(rootDir), `${stamp.slice(0, 7)}.jsonl`);
}

function eventFor(transition) {
  return EVENT_BY_KIND[transition?.kind] ?? 'runtime.router.transition';
}

function buildAuditRow(transition, at) {
  const reconcile = transition.reconcile
    ? {
      adopted: transition.reconcile.adoptedCount ?? 0,
      not_found: transition.reconcile.notFoundCount ?? 0,
      unknown: transition.reconcile.unknownCount ?? 0,
      duplicated: transition.reconcile.duplicatedCount ?? 0,
    }
    : null;
  return {
    schema_version: AUDIT_SCHEMA_VERSION,
    event: eventFor(transition),
    kind: transition.kind ?? null,
    reason: transition.reason ?? null,
    at,
    from_state: transition.from ?? null,
    to_state: transition.to ?? null,
    from_mode: transition.fromMode ?? null,
    to_mode: transition.toMode ?? null,
    probe_failures: transition.probeFailures ?? null,
    healthy_probes: transition.healthyProbes ?? null,
    span_ms: transition.spanMs ?? null,
    request_id: transition.requestId ?? null,
    detail: transition.detail ?? null,
    reconcile,
  };
}

function buildNoticeText(row) {
  const lines = [
    `Adversarial runtime router: ${row.event}`,
    `Mode: ${row.from_mode} -> ${row.to_mode} (${row.reason})`,
  ];
  if (row.probe_failures != null) lines.push(`Consecutive probe failures: ${row.probe_failures}`);
  if (row.healthy_probes != null) {
    lines.push(`Healthy probes: ${row.healthy_probes} over ${Math.round((row.span_ms ?? 0) / 1000)}s`);
  }
  if (row.reconcile) {
    lines.push(
      `Reconciled: ${row.reconcile.adopted} adopted, ${row.reconcile.duplicated} duplicated, `
      + `${row.reconcile.not_found} not-found, ${row.reconcile.unknown} unknown`,
    );
  }
  if (row.detail) lines.push(`Detail: ${row.detail}`);
  lines.push(`At: ${row.at}`);
  return lines.join('\n');
}

// Atomic-enough append: O_APPEND writes of a single JSON line are atomic for
// sizes well under PIPE_BUF, and we fsync the fd so a crash can't lose an
// acknowledged transition. Mirrors the operator-mutation-audit durability shape.
function defaultAppendRow(rootDir, row, { fileMode = 0o640, ownerGuardOptions } = {}) {
  const dir = routerAuditDir(rootDir);
  const filePath = monthFilePath(rootDir, row.at);
  assertCanonicalAppendOwner(rootDir, dir, filePath, ownerGuardOptions);
  mkdirSync(dir, { recursive: true });
  const line = `${JSON.stringify(row)}\n`;
  const fd = openSync(filePath, 'a', fileMode);
  try {
    writeFileSync(fd, line);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return filePath;
}

async function defaultDeliverNotice(text, { event, payload } = {}) {
  return deliverAlert(text, { event, payload });
}

function createRouterAuditSink({
  rootDir,
  now = () => new Date(),
  appendRowFn = defaultAppendRow,
  deliverNoticeFn = defaultDeliverNotice,
  emitTelemetryFn = null,
  logger = console,
} = {}) {
  if (!rootDir && appendRowFn === defaultAppendRow) {
    throw new TypeError('createRouterAuditSink requires rootDir (or a custom appendRowFn)');
  }

  async function recordTransition(transition) {
    const at = transition?.at || now().toISOString();
    const row = buildAuditRow(transition || {}, at);
    const event = row.event;

    // 1. Durable audit row.
    let auditPath = null;
    let auditWritten = false;
    try {
      auditPath = appendRowFn(rootDir, row);
      auditWritten = true;
    } catch (err) {
      logger?.error?.('[router-audit] failed to persist transition audit row', {
        event,
        error: err?.message || String(err),
      });
    }

    // 2. Operator notice.
    let noticeDelivered = false;
    try {
      await deliverNoticeFn(buildNoticeText(row), { event, payload: row });
      noticeDelivered = true;
    } catch (err) {
      logger?.error?.('[router-audit] operator notice delivery failed', {
        event,
        error: err?.message || String(err),
      });
    }

    // 3. Best-effort telemetry — must never throw upward.
    let telemetryEmitted = false;
    if (typeof emitTelemetryFn === 'function') {
      try {
        await emitTelemetryFn({ event, payload: row });
        telemetryEmitted = true;
      } catch (err) {
        logger?.warn?.('[router-audit] telemetry emission failed (best-effort)', {
          event,
          error: err?.message || String(err),
        });
      }
    }

    return { row, event, auditPath, auditWritten, noticeDelivered, telemetryEmitted };
  }

  return {
    recordTransition,
    auditDir: () => routerAuditDir(rootDir),
  };
}

export {
  AUDIT_SCHEMA_VERSION,
  buildAuditRow,
  buildNoticeText,
  createRouterAuditSink,
  defaultAppendRow,
  eventFor,
  routerAuditDir,
};
