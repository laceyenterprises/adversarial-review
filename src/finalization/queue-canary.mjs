// Operator observations joined to the real app store. No execution ports,
// schema convergence, route changes, network clients or evidence writer.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { resolveLaneKey, QUEUE_ACTIONABLE_PHASES } from './ledger-events.mjs';
import { resolveLaneRoute, resolveQueueRoutingStore } from './queue-routing.mjs';
import { resolveQueueAdmissionAdapters } from './queue-admission.mjs';
import { buildQueueShadowMetrics } from './queue-shadow-metrics.mjs';
import { buildShadowReport } from './shadow-report.mjs';
import { openReadOnlyFinalizationShadowStore } from './shadow-store.mjs';

export const CANARY_RECOVERIES = Object.freeze([
  'owner-restart', 'terminal-lease', 'duplicate-wake', 'lost-ack',
  'external-push', 'base-advance', 'live-hold', 'unknown-labels', 'permission-denied',
  'conflict', 'proof-failure', 'red-checks', 'missing-checks', 'hung-checks',
  'unreadable-checks', 'token-expiry', 'refresh-outage', 'ambiguous-push',
  'ambiguous-merge', 'action-retry',
]);
export const CANARY_PRODUCERS = Object.freeze([
  'clean-admission', 'closer-handoff', 'queue-consumer', 'checks-policy',
  'credentials', 'identity-attestation', 'merge', 'delivery', 'shadow', 'drain-reconciliation',
]);
export const CANARY_ROLLBACK_STEPS = Object.freeze([
  'fence', 'drain', 'reconcile', 'return-ack', 'transfer-legacy',
  'reverse-selector', 'bounce', 'verify-legacy',
  'reactivation-drain', 'transfer-queue', 'forward-selector', 'reactivation-bounce', 'verify-queue',
]);
export const CANARY_WRITER_SERVICES = Object.freeze(['watcher', 'follow-up']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = s => typeof s === 'string' && s.trim().length > 0;
const time = s => typeof s === 'string' ? Date.parse(s) : NaN;
const fresh = (record, now) => text(record?.sourceRef) && time(record.observedAt) <= time(now)
  && time(record.observedAt) >= time(now) - 300_000 && time(record.validUntil) > time(now)
  && time(record.validUntil) <= time(record.observedAt) + 300_000;
const passed = (record, now, build) => record?.environment === 'isolated' && record.result === 'passed'
  && record.build === build && text(record.sourceRef) && time(record.observedAt) <= time(now);

export function readCanaryEvidence(rootDir) {
  const path = join(rootDir, 'data/finalization-queue-canary.json');
  // A bounded local observation artifact, never a project policy/config input.
  if (statSync(path).size > 1_048_576) throw new Error('canary-evidence-too-large');
  const evidence = JSON.parse(readFileSync(path, 'utf8'));
  if (!object(evidence) || evidence.schemaVersion !== 1) throw new Error('canary-evidence-version');
  return evidence;
}

export function resolveQueueCanaryAdapter({ db }) {
  const routing = resolveQueueRoutingStore({ db });
  const admissions = resolveQueueAdmissionAdapters({ db });
  // Resolve actual statements even when the operator has not supplied evidence.
  const entries = db.prepare('SELECT payload_json FROM finalization_queue_entry WHERE repository=? AND base=? ORDER BY readiness_seq,entry_id');
  const events = db.prepare(`SELECT payload_json FROM finalization_queue_event
    WHERE repository=? AND base=? AND event_type IN ('acknowledged','progress') AND at <= ?
      AND COALESCE(json_extract(payload_json,'$.entry.entryId'),json_extract(payload_json,'$.entryId'))
        IN (SELECT value FROM json_each(?)) ORDER BY seq`);
  const operations = db.prepare('SELECT COUNT(*) AS n FROM finalization_queue_operation WHERE repository=? AND base=? AND result_json IS NULL');
  const deliveries = db.prepare(`SELECT COUNT(*) AS n FROM finalization_queue_delivery d JOIN finalization_queue_entry e USING(entry_id)
    WHERE e.repository=? AND e.base=? AND d.receipt_json IS NULL`);
  const shadow = openReadOnlyFinalizationShadowStore({ db });
  return { name: 'app-store-canary-observer-v1', read({ evidence, cfg, build, now }) {
    return db.transaction(() => {
      if (!evidence) return { status: 'pending', entries: 0, clean: 0, remediated: 0,
        recoveryComplete: false, rollbackRehearsed: false, pending: ['operator-evidence-unavailable'],
        preflight: { ready: false, issues: ['operator-evidence-unavailable'] } };
      const malformed = [];
      const records = (value, path) => {
        if (value == null) return [];
        if (!Array.isArray(value)) { malformed.push(path); return []; }
        return value.map((item, i) => {
          if (object(item)) return item;
          malformed.push(`${path}[${i}]`); return {};
        });
      };
      const entryEvidence = records(evidence.entries, 'entries');
      const recoveryEvidence = records(evidence.recoveries, 'recoveries');
      const producers = records(evidence.deployment?.producers, 'deployment.producers');
      const writers = records(evidence.deployment?.writers, 'deployment.writers');
      const lane = resolveLaneKey(evidence.lane), args = [lane.repository, lane.base];
      const { from, to } = evidence.window ?? {};
      if (!(time(from) < time(to) && time(to) <= time(now))) throw new Error('invalid canary window');
      const route = resolveLaneRoute(cfg, lane), observed = routing.read(lane);
      const owner = db.prepare('SELECT * FROM finalization_queue_lane WHERE repository=? AND base=?').get(...args) ?? null;
      const all = entries.all(...args).map(r => JSON.parse(r.payload_json));
      const byId = new Map(all.map(e => [e.entryId, e]));
      const selected = new Map(), rejected = [];
      for (const observation of entryEvidence) {
        const entry = byId.get(observation.entryId);
        const inWindow = at => time(at) >= time(from) && time(at) <= time(to);
        let receipt;
        try { if (entry) receipt = admissions.receipt(entry); } catch { /* Unknown remains excluded. */ }
        if (observation.source !== 'organic' || !text(observation.sourceRef) || !entry
          || !inWindow(entry.acknowledgedAt) || !inWindow(entry.admission?.observedAt)
          || !text(entry.admission?.subject?.sourceRef) || !['clean', 'remediated'].includes(receipt?.kind)
          || receipt.kind !== entry.admission.kind) { rejected.push(observation.entryId ?? null); continue; }
        selected.set(entry.entryId, { entry, kind: receipt.kind, sourceRef: observation.sourceRef });
      }
      const sample = [...selected.values()], outcomes = {};
      for (const { entry } of sample) outcomes[entry.phase] = (outcomes[entry.phase] ?? 0) + 1;
      const recoveries = CANARY_RECOVERIES.map(id => {
        const rows = recoveryEvidence.filter(r => r.id === id);
        return { id, result: rows.length === 1 && passed(rows[0], now, build) ? 'passed'
          : rows.some(r => r.result === 'failed') ? 'failed' : 'unknown', sourceRef: rows.length === 1 ? rows[0].sourceRef ?? null : null };
      });
      const rollback = evidence.rollback;
      const steps = records(rollback?.steps, 'rollback.steps');
      const rollbackRehearsed = passed(rollback, now, build) && rollback.noOverlap === true
        && rollback.lostHandoffs === 0 && rollback.duplicateHandoffs === 0 && rollback.pendingReturns === 0
        && steps.length === CANARY_ROLLBACK_STEPS.length && steps.every((step, i) =>
          step.id === CANARY_ROLLBACK_STEPS[i] && passed(step, now, build)
          && (i === 0 || time(step.observedAt) >= time(steps[i - 1].observedAt)));
      const shadowFrom = new Date(time(now) - 7 * 86_400_000).toISOString();
      const report = buildShadowReport({ observations: shadow.read({ from: shadowFrom, to: now }),
        coverage: shadow.readCoverage(), now });
      const issues = [], deployment = evidence.deployment;
      if (!fresh(deployment, now)) issues.push('running-observation-stale-or-missing');
      // Every deployed service is observed independently. runtime_json is only
      // the last routed writer (possibly an exited CLI), never a process census.
      const missingWriterServices = CANARY_WRITER_SERVICES.filter(service => !writers.some(w => w.service === service));
      if (missingWriterServices.length || !writers.length || writers.some(w => !text(w.service)
        || !Number.isSafeInteger(w.pid) || w.pid <= 0 || !fresh(w, now))) issues.push('running-writer-inventory-incomplete');
      if (writers.some(w => w.build !== build)) issues.push('running-build-mismatch');
      if (writers.some(w => w.configGeneration !== route.configGeneration)
        || observed.route?.config_generation !== route.configGeneration) issues.push('running-config-mismatch');
      if (observed.route?.runtime && (observed.route.runtime.build !== build
        || writers.some(w => w.pid === observed.route.runtime.pid && w.build !== observed.route.runtime.build))) {
        issues.push('last-writer-build-mismatch');
      }
      if (owner?.owner_state === 'active' && !(time(owner.expires_at) > time(now))) issues.push('owner-expired');
      if (!fresh(deployment?.inventory, now) || deployment.inventory.legacyWriters !== 0 || observed.legacyWriters.length) issues.push('legacy-writers-live-or-unknown');
      const missingProducers = CANARY_PRODUCERS.filter(kind => !producers.some(p => p.kind === kind && text(p.adapter) && fresh(p, now)));
      if (missingProducers.length) issues.push('producer-unavailable');
      if (!fresh(deployment?.identity, now) || deployment.identity.result !== 'verified') issues.push('identity-unverified');
      if (!report.promotable) issues.push('shadow-readiness-pending');
      if (observed.route?.transition || observed.route?.executor !== route.executor) issues.push('route-transfer-pending');
      const unresolvedOperations = operations.get(...args).n;
      if (unresolvedOperations) issues.push('unresolved-operations');
      const staleDeadlines = all.filter(e => QUEUE_ACTIONABLE_PHASES.includes(e.phase)
        && !(time(e.patience?.deadline) > time(now))).map(e => e.entryId);
      if (staleDeadlines.length) issues.push('entry-deadline-stale-or-missing');
      const recoveryComplete = recoveries.every(r => r.result === 'passed');
      const clean = sample.filter(r => r.kind === 'clean').length, remediated = sample.length - clean;
      const pending = [...issues, ...malformed.map(path => `operator-evidence-malformed:${path}`)];
      if (route.executor !== 'queue-v2') pending.push('canary-route-inactive');
      if (observed.pendingReturns.length) pending.push('rollback-returns-pending');
      if (sample.length < 20) pending.push('fewer-than-20-organic-entries');
      if (!clean || !remediated) pending.push('missing-admission-type');
      if (rejected.length) pending.push('entry-evidence-rejected');
      if (!recoveryComplete) pending.push('recovery-incomplete');
      if (!rollbackRehearsed) pending.push('rollback-rehearsal-incomplete');
      return { lane, window: { from, to }, status: pending.length ? 'pending' : 'complete', pending,
        entries: sample.length, clean, remediated, outcomes, rejected,
        sample: sample.map(({ entry, kind, sourceRef }) => ({ entryId: entry.entryId, kind, phase: entry.phase,
          acknowledgedAt: entry.acknowledgedAt, admittedAt: entry.admission.observedAt,
          deadline: entry.patience?.deadline ?? null, sourceRef })),
        denominator: 'unique operator-observed organic entry IDs with stored receipt and live admission in the window',
        recoveryComplete, recoveries, rollbackRehearsed,
        rollback: { result: rollbackRehearsed ? 'passed' : rollback?.result === 'failed' ? 'failed' : 'unknown',
          sourceRef: rollback?.sourceRef ?? null, lostHandoffs: rollback?.lostHandoffs ?? null,
          duplicateHandoffs: rollback?.duplicateHandoffs ?? null, pendingReturns: rollback?.pendingReturns ?? null,
          steps: steps.map(step => ({ id: step.id, result: passed(step, now, build) ? 'passed' : step.result === 'failed' ? 'failed' : 'unknown',
            observedAt: step.observedAt ?? null, sourceRef: step.sourceRef ?? null })) },
        preflight: { ready: issues.length === 0, issues, missingProducers, staleDeadlines,
          route, running: observed.route?.runtime ?? null, writers, missingWriterServices, owner,
          registeredLegacyWriters: observed.legacyWriters.length, unresolvedOperations,
          shadow: { promotable: report.promotable, blockers: report.blockers } },
        pendingDeliveries: deliveries.get(...args).n,
        metrics: buildQueueShadowMetrics([{ observedAt: now, queue: { source: 'organic',
          lifecycle: events.all(...args, now, JSON.stringify([...selected.keys()])).map(r => JSON.parse(r.payload_json)) } }], { from, to, source: 'organic' }),
        authority: 'observation-only; explicit operator approval remains required' };
    })();
  } };
}
