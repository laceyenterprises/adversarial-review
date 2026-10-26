import { loadEffectiveMergeAuthorityConfig } from '../ama/effective-policy.mjs';
import { createCloserQueueHandoffBoundary } from '../ama/closer-queue-handoff.mjs';
// Route-scoped closer retirement. Live composition supplies the sanctioned
// handoff surface; no new transport, credential source or routing configuration.
import Database from 'better-sqlite3';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { openFinalizationQueueStore } from './queue-store.mjs';
import { resolveLaneRoute, resolveQueueRoutingStore } from './queue-routing.mjs';
import { queueWaitMs } from './queue-wait.mjs';
import { resolveQueueAdmissionAdapters } from './queue-admission.mjs';
import { resolveQueueHandoffStore } from './queue-handoff-store.mjs';
import { routeFinalizationWriter } from './queue-routing-boundary.mjs';

export function readCompletedQueueHandoff(store, { lane, prNumber, head }) {
  const receipts = resolveQueueHandoffStore(store);
  const admissions = resolveQueueAdmissionAdapters(store);
  const rows = store.db.prepare(`SELECT payload_json FROM finalization_queue_entry
    WHERE repository=? AND base=? AND pr_number=? ORDER BY rowid DESC`).all(lane.repository, lane.base, prNumber);
  for (const row of rows) {
    const entry = JSON.parse(row.payload_json);
    if (entry.head !== head && entry.candidate !== head) continue;
    // A returned entry owes fresh remediation/admission, including same-head
    // returns. Never let an older acknowledgement hide that obligation.
    if (entry.phase === 'returned-to-closer') return null;
    const ack = receipts.read({ lane, prNumber, head: entry.head, admissionGeneration: entry.admissionGeneration })?.ack;
    if (ack) { admissions.receipt(entry); return ack; }
  }
  return null;
}

export async function prepareQueueCloserDispatch({ rootDir, cfg, lane, prNumber, head, composition }) {
  // Dispatch preparation is not a finalization write. Legacy evaluations must
  // not acquire the lane flock, converge schema or record legacy writer intents.
  // Durable queue ownership still wins over a stale/removed config selector.
  if (lane?.repository && lane?.base && resolveLaneRoute(cfg, lane).executor === 'legacy') {
    let db;
    try {
      const path = join(rootDir, 'data', 'reviews.db');
      let exists = true;
      try { statSync(path); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        exists = false;
      }
      if (!exists) return { executor: 'legacy' };
      db = new Database(path, { readonly: true, fileMustExist: true });
      db.pragma(`busy_timeout = ${queueWaitMs(1_000, { ceilingMs: 5_000 })}`);
      const installed = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='finalization_queue_route'").get();
      if (!installed) return { executor: 'legacy' };
      const { route } = resolveQueueRoutingStore({ db }).read(lane);
      if (!route || (route.executor === 'legacy' && !route.transition)) return { executor: 'legacy' };
    } catch {
      // Unreadable durable ownership cannot safely be treated as legacy.
      return { ok: false, dispatched: false, skipMergeAgent: true, reason: 'queue-closer-route-unavailable' };
    } finally { db?.close(); }
  }
  return routeFinalizationWriter({ rootDir, cfg, lane, kind: 'closer', subject: { prNumber, head },
    legacy: () => ({ executor: 'legacy' }), queue: route => {
      const store = openFinalizationQueueStore({ rootDir });
      try {
        const ack = readCompletedQueueHandoff(store, { lane: route.lane, prNumber, head });
        if (ack) return { dispatched: false, skipMergeAgent: true, queued: true,
          reason: 'queue-handoff-acknowledged', acknowledgement: ack };
        if (typeof composition?.handoffInstructions !== 'string' || !composition.handoffInstructions.trim()
          || typeof composition.handoff !== 'function') return { ok: false, reason: 'queue-closer-composition-unavailable' };
        return { executor: 'queue-v2', route, handoffInstructions: composition.handoffInstructions };
      } finally { store.close(); }
    } });
}

export function renderQueueCloserPrompt(values, prepared) {
  if (prepared?.executor !== 'queue-v2') throw new Error('queue closer route required');
  const source = readFileSync(new URL('../../templates/queue-closer-prompt.md', import.meta.url), 'utf8');
  // One substitution pass: operator-composed instructions are never recursively
  // interpreted as template variables or shell code by this renderer.
  return source.replace(/<<([A-Z_]+)>>/g, (_match, key) => {
    const value = { ...values, QUEUE_HANDOFF_INSTRUCTIONS: prepared.handoffInstructions,
      QUEUE_ROUTE_GENERATION: prepared.route.routeGeneration }[key];
    if (value == null || value === '') throw Object.assign(new Error(`missing queue closer input: ${key}`),
      { code: 'QUEUE_CLOSER_INPUT_MISSING' });
    return String(value);
  });
}

// A queue callback reply is not durable admission evidence. Confirm the actual
// immutable receipt and entry before reporting an enqueue to the scheduler.
export function confirmQueueAdmission({ rootDir, lane, prNumber, head, acknowledgement }) {
  const ack = acknowledgement?.ack ?? acknowledgement;
  if (!ack?.entryId || !ack?.ackId) throw new Error('queue admission unacknowledged');
  const store = openFinalizationQueueStore({ rootDir });
  try {
    const entry = store.readEntry(ack.entryId);
    if (!entry || entry.ackId !== ack.ackId || entry.head !== head || ack.head !== head
      || ack.prNumber !== prNumber || ack.lane?.repository !== lane.repository || ack.lane?.base !== lane.base || entry.prNumber !== prNumber
      || entry.lane.repository !== lane.repository || entry.lane.base !== lane.base
      || entry.phase === 'returned-to-closer') throw new Error('queue admission acknowledgement foreign or returned');
    const receipt = resolveQueueAdmissionAdapters(store).receipt(entry);
    if (!receipt) throw new Error('queue admission receipt unavailable');
    return { ok: true, taken: true, dispatched: false, skipMergeAgent: true, queued: true,
      reason: 'queue-handoff-acknowledged', acknowledgement: ack };
  } finally { store.close(); }
}

export function queueAdmissionCallback({ rootDir, lane, prNumber, head, admit }) {
  if (typeof admit !== 'function') return undefined;
  return async route => confirmQueueAdmission({ rootDir, lane: route.lane ?? lane, prNumber, head,
    acknowledgement: await admit(route) });
}

// Resource release is mandatory for this migrated-lane composition. Failure
// propagates, so a caller cannot report successful exit while retaining a slot.
export function createQueueCloserComposition({ rootDir, readConfig = loadEffectiveMergeAuthorityConfig,
  handoffService, handoffInstructions, releaseResources }) {
  if (!rootDir || typeof releaseResources !== 'function' || typeof handoffInstructions !== 'string'
    || !handoffInstructions.trim()) throw new Error('queue closer handoff and resource release required');
  const boundary = createCloserQueueHandoffBoundary({ handoffService });
  return { handoffInstructions, async handoff(input, { routeGeneration, deadline } = {}) {
    if (!Number.isSafeInteger(routeGeneration) || routeGeneration < 0) throw new Error('dispatch route generation required');
    const cfg = readConfig({ rootDir });
    const result = await routeFinalizationWriter({ rootDir, cfg, lane: input?.lane, kind: 'closer',
      subject: { prNumber: input?.prNumber, head: input?.head },
      legacy: () => ({ ok: false, reason: 'queue-route-not-owned' }),
      queue: route => route.routeGeneration === routeGeneration
        ? boundary.handoff(input, { deadline, releaseResources })
        : { ok: false, reason: 'route-generation-mismatch' } });
    if (result?.ok === false) throw new Error(result.reason);
    return result;
  } };
}
