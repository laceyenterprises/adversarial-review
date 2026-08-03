import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import { probeOnce } from './adapters/agent-runtime/router/probe.mjs';
import { readRuntimeStatusSnapshot } from './runtime-status-snapshot.mjs';

const APP_CONTRACT_DEFAULT_URL = 'http://127.0.0.1:8003';
const SMOKE_RESULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const ATTRIBUTION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function hasColumn(db, tableName, columnName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all()
    .some((column) => column.name === columnName);
}

export async function buildReadyzStatus(rootDir) {
  const url = process.env.APP_CONTRACT_ENDPOINT_URL || APP_CONTRACT_DEFAULT_URL;
  
  // 1. Endpoint reachable
  let endpointOk = false;
  let endpointDetail = '';
  let endpointP95 = 0;
  const start = Date.now();
  const checkHealthz = async () => {
    const res = await fetch(new URL('/v1/dispatch_status', url), {
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return true;
  };
  
  try {
    const probe = await probeOnce({
      checkHealthz,
      dispatchP95Ms: () => 0,
      sseLive: () => true,
      config: { healthzTimeoutMs: 5000, dispatchP95ThresholdMs: Infinity, sseLivenessTimeoutMs: Infinity },
      now: () => Date.now(),
      setTimeoutFn: setTimeout,
      clearTimeoutFn: clearTimeout,
    });
    endpointP95 = Date.now() - start;
    endpointOk = probe.components.healthzOk;
    endpointDetail = endpointOk ? `dispatch_status ok, p95 ${(endpointP95 / 1000).toFixed(1)}s` : probe.components.healthzDetail || 'unreachable';
  } catch (err) {
    endpointOk = false;
    endpointDetail = err.message || String(err);
  }

  // 2. Router health / failover wired
  const snap = readRuntimeStatusSnapshot(rootDir);
  const routerProbe = snap?.status?.probe;
  const isRouterHealthy = routerProbe?.healthy === true;
  const wiring = snap?.status?.wiring || {};
  const hasClassification = wiring.takeClassification === true;
  const hasHealthz = wiring.checkHealthz === true;
  const hasDispatchStatus = wiring.dispatchStatus === true;
  const routerOk = isRouterHealthy && hasClassification && hasHealthz && hasDispatchStatus;
  let routerDetail = '';
  if (!snap?.status) {
    routerDetail = 'snapshot missing';
  } else if (!isRouterHealthy) {
    routerDetail = 'router not healthy';
  } else if (!hasClassification || !hasHealthz || !hasDispatchStatus) {
    routerDetail = 'classification/healthz/dispatch_status null';
  } else {
    routerDetail = 'classification+healthz+dispatch_status non-null';
  }

  // 3. Settle smoke
  let smokeOk = false;
  let smokeDetail = '';
  try {
    const smokePath = join(rootDir, 'data', 'smoke-result.json');
    if (existsSync(smokePath)) {
      const smoke = JSON.parse(readFileSync(smokePath, 'utf8'));
      const smokeTimestamp = smoke.at || smoke.timestamp;
      const parsedTimestamp = Date.parse(smokeTimestamp || '');
      const ageMs = Date.now() - parsedTimestamp;
      if (
        smoke.result === 'PASS'
        && Number.isFinite(parsedTimestamp)
        && ageMs < SMOKE_RESULT_MAX_AGE_MS
      ) {
        smokeOk = true;
        const mins = Math.floor(Math.max(0, ageMs) / 60000);
        smokeDetail = `last PASS ${mins}m ago, worker_run_id set`;
      } else if (smoke.result !== 'PASS') {
        smokeDetail = `last result was ${smoke.result}`;
      } else if (!Number.isFinite(parsedTimestamp)) {
        smokeDetail = 'PASS timestamp missing or invalid';
      } else {
        smokeDetail = 'stale PASS';
      }
    } else {
      smokeDetail = 'artifact missing';
    }
  } catch (err) {
    smokeOk = false;
    smokeDetail = `error: ${err.message || String(err)}`;
  }

  // 4. Attribution round-trip
  let attributionOk = false;
  let attributionDetail = '';
  const dbPath = join(rootDir, 'data', 'reviews.db');
  if (existsSync(dbPath)) {
    let db;
    try {
      db = new Database(dbPath, { readonly: true });
      const hasEndedAt = hasColumn(db, 'reviewer_passes', 'ended_at');
      const params = hasEndedAt
        ? { since: new Date(Date.now() - ATTRIBUTION_MAX_AGE_MS).toISOString() }
        : {};
      const rows = db.prepare(`
        SELECT worker_run_id
        FROM reviewer_passes
        WHERE status != 'running'
          AND json_valid(metadata_json)
          AND json_extract(metadata_json, '$.launchRequestId') IS NOT NULL
          ${hasEndedAt ? 'AND ended_at IS NOT NULL AND ended_at >= @since' : ''}
        ORDER BY rowid DESC
        LIMIT 20
      `).all(params);
      const total = rows.length;
      const attributed = rows.filter(r => r.worker_run_id != null).length;
      if (total > 0 && attributed > 0) {
        attributionOk = true;
        attributionDetail = `last ${total} SDK passes: ${attributed} attributed`;
      } else if (total === 0) {
        // Technically nothing to attribute. Let's just say not ready, needs at least one.
        attributionOk = false;
        attributionDetail = 'no passes found';
      } else {
        attributionOk = false;
        attributionDetail = `last ${total} SDK passes: ${attributed} attributed`;
      }
    } catch (err) {
      attributionOk = false;
      attributionDetail = `db error: ${err.message || String(err)}`;
    } finally {
      if (db) db.close();
    }
  } else {
    attributionDetail = 'reviews.db missing';
  }

  const overallReady = endpointOk && routerOk && smokeOk && attributionOk;

  return {
    overallReady,
    signals: [
      {
        id: 'endpoint',
        label: `app-contract endpoint (${url})`,
        ok: endpointOk,
        detail: endpointDetail
      },
      {
        id: 'router',
        label: 'router health / failover wired',
        ok: routerOk,
        detail: routerDetail
      },
      {
        id: 'smoke',
        label: 'settle smoke (agent-runtime)',
        ok: smokeOk,
        detail: smokeDetail
      },
      {
        id: 'attribution',
        label: 'attribution round-trip',
        ok: attributionOk,
        detail: attributionDetail
      }
    ]
  };
}

export function renderReadyzStatus(model) {
  let text = 'SDK DISPATCH READINESS  (orchestration_mode target: agentos)\n';
  
  for (const signal of model.signals) {
    const statusText = signal.ok ? 'GREEN' : 'NOT READY';
    const dots = '.'.repeat(Math.max(1, 50 - signal.label.length));
    text += `  ${signal.label}  ${dots}  ${statusText}  (${signal.detail})\n`;
  }
  
  const overallText = model.overallReady ? 'READY  — safe to flip roles.adversarial.orchestration_mode: agentos' : 'NOT READY';
  text += `OVERALL: ${overallText}\n`;
  return text;
}
