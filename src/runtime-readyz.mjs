import { join } from 'node:path';
import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';

import { evaluateSettleSmokeResult } from './adapters/agent-runtime/settle-smoke.mjs';
import { readRuntimeStatusSnapshot } from './runtime-status-snapshot.mjs';
import { resolveAppContractRegistration } from './app-registration.mjs';

const APP_CONTRACT_DEFAULT_URL = 'http://127.0.0.1:8003';
const ATTRIBUTION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const ATTRIBUTION_SAMPLE_SIZE = 20;

function quoteSqlIdentifier(identifier) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`unsafe SQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

function hasColumn(db, tableName, columnName) {
  return db.prepare(`PRAGMA table_info(${quoteSqlIdentifier(tableName)})`).all()
    .some((column) => column.name === columnName);
}

function readAttributionRows(db, { since = null } = {}) {
  return db.prepare(`
    SELECT worker_run_id
    FROM reviewer_passes
    WHERE status != 'running'
      AND CASE
        WHEN json_valid(metadata_json)
          THEN json_extract(metadata_json, '$.launchRequestId') IS NOT NULL
        ELSE 0
      END
      ${since ? 'AND ended_at IS NOT NULL AND ended_at >= @since' : ''}
    ORDER BY rowid DESC
    LIMIT ${ATTRIBUTION_SAMPLE_SIZE}
  `).all(since ? { since } : {});
}

function settleSmokeSignal(rootDir, { now = () => new Date() } = {}) {
  const settled = evaluateSettleSmokeResult(rootDir, {
    runtime: 'agent-runtime',
    now,
  });
  const result = settled?.result || null;

  if (settled?.ok && result?.attributed === true && result?.workerRunId) {
    const ageMs = Number.isFinite(settled.ageMs) ? settled.ageMs : 0;
    const mins = Math.floor(Math.max(0, ageMs) / 60000);
    return {
      id: 'smoke',
      label: 'settle smoke (agent-runtime)',
      ok: true,
      detail: `settled + attributed ${mins}m ago`,
    };
  }

  let detail = 'artifact missing';
  if (settled?.reason === 'stale') {
    detail = 'stale PASS';
  } else if (settled?.reason === 'fail') {
    detail = result?.detail || 'last result was FAIL';
  } else if (settled?.reason === 'invalid-at') {
    detail = 'PASS timestamp missing or invalid';
  } else if (settled?.reason === 'invalid-status') {
    detail = `invalid settle-smoke status: ${JSON.stringify(result?.status ?? null)}`;
  } else if (settled?.reason === 'unsupported-schema-version') {
    detail = `unsupported settle-smoke schema_version: ${JSON.stringify(result?.schema_version ?? null)}`;
  } else if (settled?.reason === 'invalid-json' || settled?.reason === 'unreadable') {
    detail = `artifact ${settled.reason}`;
  }

  if (settled?.ok && !result?.workerRunId) {
    detail = 'PASS workerRunId missing';
  } else if (settled?.ok && result?.attributed !== true) {
    detail = 'PASS attributed flag missing';
  }

  return {
    id: 'smoke',
    label: 'settle smoke (agent-runtime)',
    ok: false,
    detail,
  };
}

async function endpointSignal(baseUrl) {
  const healthzUrl = new URL('healthz', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  try {
    const res = await fetch(healthzUrl, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      return {
        id: 'endpoint',
        label: `app-contract endpoint (${baseUrl})`,
        ok: false,
        detail: `HTTP ${res.status}`,
      };
    }
    const payload = await res.json();
    const supervisor = payload?.supervisor && typeof payload.supervisor === 'object'
      ? payload.supervisor
      : {};
    if (payload?.ok !== true) {
      return {
        id: 'endpoint',
        label: `app-contract endpoint (${baseUrl})`,
        ok: false,
        detail: 'healthz ok=false',
      };
    }
    if (supervisor.duplicate_detected === true) {
      return {
        id: 'endpoint',
        label: `app-contract endpoint (${baseUrl})`,
        ok: false,
        detail: 'supervisor duplicate_detected=true',
      };
    }
    if (supervisor.stale_bind_detected === true) {
      return {
        id: 'endpoint',
        label: `app-contract endpoint (${baseUrl})`,
        ok: false,
        detail: 'supervisor stale_bind_detected=true',
      };
    }
    return {
      id: 'endpoint',
      label: `app-contract endpoint (${baseUrl})`,
      ok: true,
      detail: 'single instance, healthy',
    };
  } catch (err) {
    return {
      id: 'endpoint',
      label: `app-contract endpoint (${baseUrl})`,
      ok: false,
      detail: err?.message || String(err),
    };
  }
}

function routerSignal(rootDir) {
  const snap = readRuntimeStatusSnapshot(rootDir);
  const routerProbe = snap?.status?.probe;
  const isRouterHealthy = routerProbe?.healthy === true;
  const wiring = snap?.status?.wiring || {};
  const hasClassification = wiring.takeClassification === true;
  const hasHealthz = wiring.checkHealthz === true;
  const hasDispatchStatus = wiring.dispatchStatus === true;
  const ok = isRouterHealthy && hasClassification && hasHealthz && hasDispatchStatus;
  let detail = '';
  if (!snap?.status) {
    detail = 'snapshot missing';
  } else if (!isRouterHealthy) {
    detail = 'router not healthy';
  } else if (!hasClassification || !hasHealthz || !hasDispatchStatus) {
    detail = 'classification/healthz/dispatch_status null';
  } else {
    detail = 'classification+healthz+dispatch_status non-null';
  }
  return {
    id: 'router',
    label: 'router health / failover wired',
    ok,
    detail,
  };
}

function attributionSignal(rootDir, { now = () => new Date() } = {}) {
  const dbPath = join(rootDir, 'data', 'reviews.db');
  if (!existsSync(dbPath)) {
    return {
      id: 'attribution',
      label: 'attribution round-trip',
      ok: false,
      detail: 'reviews.db missing',
    };
  }

  let db;
  try {
    db = new Database(dbPath, { readonly: true });
    const hasEndedAt = hasColumn(db, 'reviewer_passes', 'ended_at');
    const since = hasEndedAt
      ? new Date(now().getTime() - ATTRIBUTION_MAX_AGE_MS).toISOString()
      : null;
    const rows = readAttributionRows(db, { since });
    const total = rows.length;
    const attributed = rows.filter((row) => row.worker_run_id != null).length;
    return {
      id: 'attribution',
      label: 'attribution round-trip',
      ok: total > 0 && attributed === total,
      detail: total === 0
        ? 'no recent SDK passes found'
        : `last ${total} SDK passes: ${attributed} attributed`,
    };
  } catch (err) {
    return {
      id: 'attribution',
      label: 'attribution round-trip',
      ok: false,
      detail: `db error: ${err.message || String(err)}`,
    };
  } finally {
    if (db) db.close();
  }
}

function appRegistrationSignal(rootDir, appRegistrationOptions = {}) {
  const resolvedAppRegistrationOptions = {
    topPath: join(rootDir, '..', '..', 'config.yaml'),
    modulePaths: [join(rootDir, 'config.yaml')],
    ...appRegistrationOptions,
  };
  const appRegistration = resolveAppContractRegistration(resolvedAppRegistrationOptions);
  return {
    appRegistration,
    signal: {
      id: 'app-registration',
      label: 'app registration',
      ok: appRegistration.registered === true,
      detail: appRegistration.registered === true
        ? `${appRegistration.source}, first-class`
        : `${appRegistration.source}, fallback default`,
    },
  };
}

export async function buildReadyzStatus(rootDir, {
  appRegistrationOptions = {},
  now = () => new Date(),
} = {}) {
  const url = process.env.APP_CONTRACT_ENDPOINT_URL || APP_CONTRACT_DEFAULT_URL;
  const endpoint = await endpointSignal(url);
  const router = routerSignal(rootDir);
  const smoke = settleSmokeSignal(rootDir, { now });
  const attribution = attributionSignal(rootDir, { now });
  const { appRegistration, signal: appRegistrationSignalModel } = appRegistrationSignal(
    rootDir,
    appRegistrationOptions,
  );

  const signals = [endpoint, router, smoke, attribution, appRegistrationSignalModel];
  const failingSignals = signals.filter((signal) => !signal.ok).map((signal) => signal.id);

  return {
    overallReady: failingSignals.length === 0,
    failingSignals,
    app_registration: appRegistration,
    signals,
  };
}

export function renderReadyzStatus(model) {
  let text = 'SDK DISPATCH READINESS  (orchestration_mode target: agentos)\n';

  for (const signal of model.signals) {
    const statusText = signal.ok ? 'GREEN' : 'NOT READY';
    const dots = '.'.repeat(Math.max(1, 50 - signal.label.length));
    text += `  ${signal.label}  ${dots}  ${statusText}  (${signal.detail})\n`;
  }

  if (model.overallReady) {
    text += 'OVERALL: READY  - safe to flip roles.adversarial.orchestration_mode: agentos\n';
  } else {
    text += `OVERALL: NOT READY  (failing: ${model.failingSignals.join(', ')})\n`;
  }
  return text;
}
