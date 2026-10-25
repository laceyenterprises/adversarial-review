// Read-only app-store/config projections. Never opens a writer, migrates schema,
// claims a lane, takes an issuance lock or contacts a remote mutation adapter.
import Database from 'better-sqlite3';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadEffectiveMergeAuthorityConfig } from '../ama/effective-policy.mjs';
import { loadConfigRuntime } from '../config-loader.mjs';
import { resolveLaneKey, QUEUE_ACTIONABLE_PHASES } from './ledger-events.mjs';
import { resolveQueueRoutingStore, resolveLaneRoute } from './queue-routing.mjs';
import { resolveQueueAdmissionAdapters } from './queue-admission.mjs';
import { buildQueueShadowMetrics } from './queue-shadow-metrics.mjs';
import { queueRuntimeBuild } from './queue-build.mjs';
import { queueWaitMs } from './queue-wait.mjs';

export function readRoutingConfig({ rootDir, configPath } = {}) {
  const configuredTop = configPath || process.env.AGENT_OS_CONFIG_PATH;
  if (!existsSync(join(rootDir, 'config.yaml')) || (configuredTop && !existsSync(configuredTop))) throw new Error('routing-config-unavailable');
  return loadEffectiveMergeAuthorityConfig({ rootDir,
    loadConfigImpl: options => loadConfigRuntime({ ...options, ...(configPath ? { topPath: configPath } : {}) }) });
}

export function verifyRoutingSchema(db) {
  const reference = new Database(':memory:');
  try {
    reference.exec(readFileSync(new URL('../../migrations/20261029_finalization_queue_routing.sql', import.meta.url), 'utf8'));
    const objects = reference.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
    const deployed = db.prepare(`SELECT type,name,sql FROM sqlite_master WHERE name IN (${objects.map(() => '?').join(',')}) ORDER BY name`).all(...objects.map(o => o.name));
    if (JSON.stringify(objects) !== JSON.stringify(deployed)) throw new Error('routing-schema-unavailable');
  } finally { reference.close(); }
}

export function openQueueStatus({ rootDir = process.cwd(), configPath, now = new Date().toISOString(), load,
  readConfig = readRoutingConfig } = {}) {
  rootDir = realpathSync(resolve(rootDir));
  if (!Number.isFinite(Date.parse(now))) throw new Error('invalid queue observation time');
  const cfg = readConfig({ rootDir, configPath });
  // Resolve and validate even with no observed lane, so bad config cannot look idle.
  resolveLaneRoute(cfg, { repository: 'example/review', base: 'main' });
  const db = new Database(join(rootDir, 'data', 'reviews.db'), { readonly: true, fileMustExist: true });
  try {
    db.pragma(`busy_timeout = ${queueWaitMs(1_000, { ceilingMs: 5_000,
      deadline: new Date(Date.parse(now) + 5_000).toISOString(), now, load })}`);
    verifyRoutingSchema(db);
    const routing = resolveQueueRoutingStore({ db });
    const entries = lane => db.prepare('SELECT payload_json FROM finalization_queue_entry WHERE repository=? AND base=? ORDER BY readiness_seq,entry_id')
      .all(lane.repository, lane.base).map(r => JSON.parse(r.payload_json));
    const admissions = resolveQueueAdmissionAdapters({ db, entries });
    const runtime = { build: queueRuntimeBuild(), pid: process.pid, observedAt: now, role: 'read-only-observer' };
    return { name: 'app-store-queue-status-v1', runtime, cfg,
      status(input) { return db.transaction(() => {
        const lane = resolveLaneKey(input), route = resolveLaneRoute(cfg, lane), observed = routing.read(lane);
        const owner = db.prepare('SELECT * FROM finalization_queue_lane WHERE repository=? AND base=?').get(lane.repository, lane.base) ?? null;
        const all = entries(lane), actionable = all.filter(e => QUEUE_ACTIONABLE_PHASES.includes(e.phase));
        const events = db.prepare('SELECT payload_json FROM finalization_queue_event WHERE repository=? AND base=? ORDER BY seq')
          .all(lane.repository, lane.base).map(r => JSON.parse(r.payload_json));
        const from = new Date(Date.parse(now) - 3_600_000).toISOString();
        const metrics = buildQueueShadowMetrics([{ observedAt: now, queue: { source: 'organic', lifecycle: events.filter(e => ['acknowledged', 'progress'].includes(e.type)) } }], { from, to: now, source: 'organic' });
        const readyAt = new Map(), parkedSince = new Map();
        for (const event of events) {
          if (event.type === 'acknowledged') readyAt.set(event.entry.entryId, event.at);
          if (event.type === 'progress' && event.patch.readinessSeq !== undefined) readyAt.set(event.entryId, event.at);
          if (event.type === 'progress' && event.patch.phase?.startsWith('parked-')
            && event.priorPhase !== event.patch.phase) parkedSince.set(event.entryId, event.at);
        }
        const project = (entry, position = null) => ({ ...entry, position, readyAt: readyAt.get(entry.entryId) ?? null,
          parkedSince: entry.phase.startsWith('parked-') ? parkedSince.get(entry.entryId) ?? null : null,
          reason: entry.reason ?? (position > 1 ? 'predecessor-active' : null) });
        return { lane, route, runtime, running: observed.route?.runtime ?? null, owner,
          effectiveExecutor: observed.route?.executor ?? 'legacy', transition: observed.route?.transition ?? null,
          mode: observed.route?.transition || route.executor !== (observed.route?.executor ?? 'legacy') ? 'transfer-pending' : route.executor === 'legacy' ? 'legacy' : 'live',
          configGeneration: route.configGeneration, persistedConfigGeneration: observed.route?.config_generation ?? null,
          inFlightLegacyWriterCount: observed.legacyWriters.length, legacyWriterObservation: 'registered-boundaries; older/external-writers-require-drain-inventory',
          unresolvedOperations: db.prepare('SELECT operation_id,entry_id,kind,generation,route_generation,intent_json FROM finalization_queue_operation WHERE repository=? AND base=? AND result_json IS NULL')
            .all(lane.repository, lane.base).map(r => ({ ...r, intent: JSON.parse(r.intent_json) })),
          pendingReturns: observed.pendingReturns,
          head: actionable[0] ? project(actionable[0], 1) : null,
          waiting: actionable.slice(1).map((entry, i) => project(entry, i + 2)),
          parked: all.filter(e => e.phase.startsWith('parked-')).map(e => project(e)),
          terminal: all.filter(e => !QUEUE_ACTIONABLE_PHASES.includes(e.phase) && !e.phase.startsWith('parked-')).map(e => project(e)),
          metrics: metrics.lanes[0] ?? null,
          organicEvidence: observed.route?.runtime ? 'observed' : 'pending' };
      })(); },
      receipt({ repository, prNumber, base }) { return db.transaction(() => {
        repository = resolveLaneKey({ repository, base: base ?? 'main' }).repository;
        if (!Number.isSafeInteger(prNumber) || prNumber <= 0) throw new Error('invalid PR number');
        const matches = db.prepare('SELECT payload_json FROM finalization_queue_entry WHERE repository=? AND pr_number=? ORDER BY rowid DESC')
          .all(repository, prNumber).map(r => JSON.parse(r.payload_json)).filter(e => !base || e.lane.base === base);
        if (!matches.length) throw new Error('queue receipt unavailable');
        if (new Set(matches.map(e => e.lane.base)).size > 1) throw new Error('ambiguous receipt lane; supply --base');
        const entry = matches[0];
        const merge = db.prepare('SELECT receipt_json FROM finalization_queue_merge_receipt WHERE entry_id=?').get(entry.entryId);
        const deliveries = db.prepare('SELECT delivery_key,kind,attempts,last_error,receipt_json FROM finalization_queue_delivery WHERE entry_id=? ORDER BY delivery_key')
          .all(entry.entryId).map(r => ({ ...r, receipt: r.receipt_json ? JSON.parse(r.receipt_json) : null }));
        return { runtime, route: resolveLaneRoute(cfg, entry.lane), owner: routing.read(entry.lane).route,
          entry, admission: admissions.receipt(entry), merge: merge ? JSON.parse(merge.receipt_json) : null, deliveries };
      })(); },
      close() { db.close(); },
    };
  } catch (error) { db.close(); throw error; }
}

export function renderQueueStatus(model) {
  const { lane, head } = model;
  const lines = [`lane ${lane.repository}/${lane.base}  route ${model.route.executor}  mode ${model.mode}`,
    `config ${model.configGeneration}  running build ${model.running?.build ?? 'pending'}  observer build ${model.runtime.build}`,
    `owner ${model.owner?.owner_id ?? 'none'}  fence ${model.owner?.generation ?? 'none'}  route generation ${model.owner?.route_generation ?? 0}  legacy writers ${model.inFlightLegacyWriterCount}`];
  if (model.transition) lines.push(`transfer ${JSON.stringify(model.transition)}`);
  if (head) lines.push(`head PR ${head.prNumber}  phase ${head.phase}  old ${head.expectedOldHead}  new ${head.candidate ?? 'pending'}  base ${head.exactBase ?? 'pending'}`,
    `  checks ${JSON.stringify(head.checks)}  deadline ${head.patience.deadline}  reason ${head.reason ?? 'none'}`);
  for (const e of model.waiting) lines.push(`waiting ${e.position} PR ${e.prNumber} ready-at ${e.readyAt} reason ${e.reason ?? 'none'}`);
  for (const e of model.parked) lines.push(`parked PR ${e.prNumber} ${e.reason} since ${e.parkedSince} reprobe ${e.infrastructure?.reprobeAt ?? e.infrastructure?.nextProbeAt ?? 'pending'}`);
  lines.push(`metrics ${JSON.stringify(model.metrics)}`, `unresolved ${model.unresolvedOperations.length} pending-returns ${model.pendingReturns.length}`);
  return lines.join('\n');
}
