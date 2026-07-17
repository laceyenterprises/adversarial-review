// `runtime status` model + renderer (ARC-09, SPEC §1 Win 1). Builds the hybrid
// runtime status surface from DURABLE artifacts so the CLI works as a separate
// process from the watcher daemon that owns the live router:
//
//   - live mode / since / probe   ← the router status snapshot (best-effort);
//   - last failover / resume / reconcile ← the router transition audit trail;
//   - runs (24h) by mode          ← the runtime run-ledger;
//   - fallback canary status       ← the canary status file.
//
// The renderer reproduces the SPEC §1 mockup exactly and degrades gracefully:
// an absent snapshot shows "probe: unknown", no transitions shows "none", no
// canary shows "never run" — the surface never lies about what it doesn't know.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { routerAuditDir } from './adapters/agent-runtime/router/audit.mjs';
import { summarizeRuntimeRuns } from './adapters/agent-runtime/run-ledger.mjs';
import { readRuntimeStatusSnapshot } from './runtime-status-snapshot.mjs';
import { readCanaryStatus } from './adapters/agent-runtime/canary.mjs';

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

function readAuditRows(rootDir) {
  const dir = routerAuditDir(rootDir);
  if (!existsSync(dir)) return [];
  const rows = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.jsonl')) continue;
    let raw;
    try {
      raw = readFileSync(join(dir, name), 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        rows.push(JSON.parse(trimmed));
      } catch {
        // skip a torn line
      }
    }
  }
  // Stable chronological order (ties keep file order).
  return rows
    .map((row, index) => ({ row, index, atMs: Date.parse(row?.at ?? '') }))
    .sort((a, b) => {
      const am = Number.isFinite(a.atMs) ? a.atMs : 0;
      const bm = Number.isFinite(b.atMs) ? b.atMs : 0;
      return am - bm || a.index - b.index;
    })
    .map((entry) => entry.row);
}

function lastWhere(rows, predicate) {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (predicate(rows[i])) return rows[i];
  }
  return null;
}

// Assemble the full status model. Pure w.r.t. injected readers so it is unit
// testable without touching disk.
function buildRuntimeStatus(rootDir, {
  windowMs = DEFAULT_WINDOW_MS,
  now = () => new Date(),
  readSnapshotImpl = readRuntimeStatusSnapshot,
  readAuditRowsImpl = readAuditRows,
  summarizeRunsImpl = summarizeRuntimeRuns,
  readCanaryImpl = readCanaryStatus,
} = {}) {
  const snapshot = readSnapshotImpl(rootDir);
  const snapStatus = snapshot?.status || null;
  const rows = readAuditRowsImpl(rootDir);
  const lastTransition = rows.length ? rows[rows.length - 1] : null;
  const lastFailover = lastWhere(rows, (r) => r?.kind === 'failover');
  const lastResumeComplete = lastWhere(rows, (r) => r?.kind === 'resume-complete');
  // The state machine splits the resume: `resume-start` carries the hysteresis
  // facts (healthy probes / span), `resume-complete` carries the reconcile
  // summary. Merge the matching start's facts into the completed-resume view so
  // the "last resume" line reports both, regardless of which row holds them.
  const completeAtMs = lastResumeComplete ? Date.parse(lastResumeComplete.at ?? '') : NaN;
  const lastResumeStart = lastResumeComplete
    ? lastWhere(
      rows.filter((r) => {
        if (r?.kind !== 'resume-start') return false;
        const atMs = Date.parse(r?.at ?? '');
        return !Number.isFinite(completeAtMs) || !Number.isFinite(atMs) || atMs <= completeAtMs;
      }),
      () => true,
    )
    : null;
  const lastResume = lastResumeComplete
    ? {
      ...lastResumeComplete,
      healthy_probes: lastResumeComplete.healthy_probes ?? lastResumeStart?.healthy_probes ?? null,
      span_ms: lastResumeComplete.span_ms ?? lastResumeStart?.span_ms ?? null,
    }
    : null;

  // Mode/since prefer the live snapshot; fall back to the last audited
  // transition; default to a healthy OS baseline when nothing is recorded yet.
  const mode = snapStatus?.mode || lastTransition?.to_mode || 'os';
  const since = snapStatus?.since || lastTransition?.at || null;

  const runs = summarizeRunsImpl(rootDir, { windowMs, now });
  const canary = readCanaryImpl(rootDir);

  return {
    generatedAt: now().toISOString(),
    mode,
    since,
    snapshotPresent: Boolean(snapStatus),
    snapshotCapturedAt: snapshot?.capturedAt || null,
    probe: snapStatus?.probe || null,
    config: snapStatus?.config || null,
    pendingOsRuns: snapStatus?.pendingOsRuns ?? null,
    lastFailover: lastFailover || null,
    lastResume: lastResume || null,
    reconcile: lastResume?.reconcile || snapStatus?.reconciled || null,
    runs,
    canary: canary || null,
  };
}

function pad(text, width) {
  const value = String(text);
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

function formatDurationMs(ms) {
  if (!Number.isFinite(ms)) return '?';
  if (ms >= 60_000) {
    const minutes = ms / 60_000;
    return Number.isInteger(minutes) ? `${minutes}m` : `${Math.round(minutes)}m`;
  }
  if (ms >= 1_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms)}ms`;
}

function renderProbeLine(probe, snapshotPresent) {
  if (!snapshotPresent || !probe) {
    return `probe: ${pad('unknown', 12)}(no live router snapshot)`;
  }
  const components = probe.components || {};
  const parts = [];
  parts.push(components.healthzOk === false ? 'healthz failed' : 'healthz ok');
  const p95 = components.dispatchP95Ms;
  parts.push(p95 == null ? 'dispatch p95 no samples' : `dispatch p95 ${p95}ms`);
  parts.push(components.sseLive === false ? 'sse stale' : 'sse live');
  const label = probe.healthy ? 'healthy' : 'degraded';
  return `probe: ${pad(label, 12)}(${parts.join(', ')})`;
}

function renderFailoverLine(row) {
  if (!row) return 'last failover: none';
  const to = row.to_mode || 'local';
  let cause;
  if (row.reason === 'hard-contract-error') cause = 'hard contract error';
  else if (row.probe_failures != null) cause = `${row.probe_failures} probe failures`;
  else cause = row.reason || 'unknown';
  return `last failover: ${row.at} -> ${pad(to, 6)} (${cause})`;
}

function renderResumeLine(row) {
  if (!row) return 'last resume:   none';
  const to = row.to_mode || 'os';
  const probes = row.healthy_probes != null ? `${row.healthy_probes} healthy probes` : 'resumed';
  const span = row.span_ms != null ? ` / ${formatDurationMs(row.span_ms)}` : '';
  return `last resume:   ${row.at} -> ${pad(to, 6)} (${probes}${span})`;
}

function renderRunsLine(runs, reconcile) {
  const os = runs?.os ?? 0;
  const local = runs?.local ?? 0;
  let reconcileText;
  if (reconcile) {
    const adopted = reconcile.adopted ?? 0;
    const duplicated = reconcile.duplicated ?? 0;
    reconcileText = `reconciled-on-resume: ${adopted} adopted, ${duplicated} duplicated`;
  } else {
    reconcileText = 'reconciled-on-resume: n/a';
  }
  return `runs (24h): os=${os} local=${local}   ${reconcileText}`;
}

function renderCanaryLine(canary) {
  if (!canary) return 'fallback canary: never run';
  const verdict = String(canary.status || 'unknown').toUpperCase();
  const detail = canary.detail || 'local fixture review';
  const durationS = Number.isFinite(canary.durationMs) ? `${Math.round(canary.durationMs / 1000)}s` : '?s';
  return `fallback canary: ${verdict} ${canary.at} (${detail}, ${durationS})`;
}

// Render the model to the SPEC §1 Win 1 text block.
function renderRuntimeStatus(model) {
  const lines = [];
  lines.push(`mode: ${pad(model.mode, 12)}since: ${model.since || 'n/a'}`);
  lines.push(renderProbeLine(model.probe, model.snapshotPresent));
  lines.push(renderFailoverLine(model.lastFailover));
  lines.push(renderResumeLine(model.lastResume));
  lines.push(renderRunsLine(model.runs, model.reconcile));
  lines.push(renderCanaryLine(model.canary));
  return lines.join('\n');
}

export {
  DEFAULT_WINDOW_MS,
  buildRuntimeStatus,
  readAuditRows,
  renderRuntimeStatus,
};
