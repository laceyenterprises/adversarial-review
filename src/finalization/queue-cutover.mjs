// Read-only expansion projection. Operator observations supply process/resource
// facts; actual route, admission, CI history and merge receipts come from SQLite.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { resolveQueueCanaryAdapter } from './queue-canary.mjs';
import { resolveQueueAdmissionAdapters } from './queue-admission.mjs';
import { classifyQueueChecks } from './queue-check-reader.mjs';
import { handoffDigest } from './queue-handoff.mjs';

const text = v => typeof v === 'string' && v.trim().length > 0;
const time = v => typeof v === 'string' ? Date.parse(v) : NaN;
const fresh = (v, now) => text(v?.sourceRef) && time(v.observedAt) <= time(now)
  && time(v.observedAt) >= time(now) - 300_000 && time(v.validUntil) > time(now)
  && time(v.validUntil) <= time(v.observedAt) + 300_000;
export function readCutoverEvidence(rootDir) {
  const path = join(rootDir, 'data/finalization-queue-cutover.json');
  if (statSync(path).size > 1_048_576) throw new Error('cutover-evidence-too-large');
  const evidence = JSON.parse(readFileSync(path, 'utf8'));
  if (evidence?.schemaVersion !== 1) throw new Error('cutover-evidence-version');
  return evidence;
}
export function resolveQueueCutoverAdapter({ db }) {
  const canary = resolveQueueCanaryAdapter({ db });
  const admissions = resolveQueueAdmissionAdapters({ db });
  const entryStmt = db.prepare('SELECT payload_json FROM finalization_queue_entry WHERE entry_id=?');
  const receiptStmt = db.prepare('SELECT * FROM finalization_queue_merge_receipt WHERE entry_id=?');
  const ciStmt = db.prepare(`SELECT MIN(at) AS at FROM finalization_queue_event
    WHERE repository=? AND base=? AND event_type='progress'
    AND json_extract(payload_json,'$.entryId')=? AND json_extract(payload_json,'$.patch.phase')='waiting-checks'`);
  return { name: 'app-store-cutover-observer-v1', read({ evidence, cfg, build, now }) {
    return db.transaction(() => {
      if (!evidence) return { status: 'pending', route: null, legacyWriters: null,
        confirmedReceipts: 0, closersReleasedBeforeCi: false, pending: ['operator-evidence-unavailable'] };
      const c = canary.read({ evidence, cfg, build, now });
      const pending = [...c.preflight.issues];
      // Reuse existing preflight and rehearsal rules without imposing the
      // canary's twenty-entry count as a new expansion promotion gate.
      for (const reason of c.pending) if (reason.startsWith('operator-evidence-malformed:')) pending.push(reason);
      if (c.rejected.length) pending.push('entry-evidence-rejected');
      const route = c.preflight.route;
      const owner = c.preflight.owner, observedOwner = evidence.deployment?.queueOwner;
      const ownerKnown = owner && ['active', 'idle'].includes(owner.owner_state)
        && fresh(observedOwner, now) && observedOwner.build === build
        && observedOwner.configGeneration === route.configGeneration
        && observedOwner.ownerId === owner.owner_id && observedOwner.generation === owner.generation
        && observedOwner.routeGeneration === owner.route_generation
        && c.preflight.writers.some(w => w.service === observedOwner.service && w.pid === observedOwner.pid);
      if (!ownerKnown) pending.push('running-queue-owner-unverified');
      const approval = evidence.canaryApproval;
      if (approval?.result !== 'approved' || !text(approval.principal) || !text(approval.sourceRef)
        || !(time(approval.observedAt) <= time(evidence.window.from))) pending.push('prior-canary-approval-unavailable');
      if (!c.rollbackRehearsed) pending.push('rollback-rehearsal-incomplete');
      if (c.pendingDeliveries) pending.push('receipt-deliveries-pending');
      const releases = Array.isArray(evidence.closerReleases) ? evidence.closerReleases : [];
      if (!Array.isArray(evidence.closerReleases)) pending.push('closer-release-evidence-unavailable');
      const receipts = [], rejectedReceipts = [], closerObservations = [];
      for (const sample of c.sample) {
        const entry = JSON.parse(entryStmt.get(sample.entryId).payload_json);
        const admission = admissions.receipt(entry);
        const row = receiptStmt.get(entry.entryId);
        if (row) {
          let valid = false;
          try {
            const { digest, ...body } = JSON.parse(row.receipt_json);
            valid = body.schemaVersion === 1 && digest === row.receipt_digest && digest === handoffDigest(body)
              && row.repository === entry.lane.repository && row.base === entry.lane.base && row.pr_number === entry.prNumber
              && body.handoffId === entry.handoffId && body.expectedOldHead === entry.expectedOldHead
              && body.entryId === entry.entryId && body.ackId === entry.ackId
              && isDeepStrictEqual(body.lane, entry.lane) && body.prNumber === entry.prNumber
              && body.oldHead === entry.head && body.newHead === entry.candidate && row.candidate === entry.candidate
              && body.base === entry.exactBase && body.merge?.mergeSha === row.merge_sha
              && body.merge?.operationId === row.operation_id && text(body.merge?.sourceRef)
              && time(body.merge.mergedAt) <= time(now) && time(body.merge.mergedAt) >= time(entry.acknowledgedAt)
              && body.merge.method === 'squash' && entry.phase === 'merged'
              && isDeepStrictEqual(body.merge, entry.merge) && isDeepStrictEqual(body.checks, entry.checks)
              && isDeepStrictEqual(body.decision, entry.decision) && body.decision?.kind === 'eligible'
              && body.decision?.head === entry.candidate && body.checks?.head === entry.candidate
              && body.checks?.base === entry.exactBase && classifyQueueChecks(body.checks).kind === 'green'
              && body.rebase?.sourceReceiptDigest === handoffDigest(admission.input ?? admission.handoff)
              && body.rebase.sourceReceiptDigest === entry.rebase?.sourceReceiptDigest
              && isDeepStrictEqual(body.rebase.publication, entry.rebase?.publication)
              && body.rebase.proof?.digest === entry.proof?.digest
              && body.owner?.routeGeneration === owner?.route_generation
              && Number.isSafeInteger(body.owner?.generation) && body.owner.generation <= owner?.generation
              && text(body.attribution?.bot?.login) && body.attribution.bot.login === body.merge.mergedBy;
          } catch { /* Unknown/corrupt receipt is excluded, never success. */ }
          if (valid) receipts.push({ entryId: entry.entryId, head: row.candidate, base: entry.exactBase, mergeSha: row.merge_sha });
          else rejectedReceipts.push(entry.entryId);
        }
        if (admission.kind !== 'remediated') continue;
        const firstCiAt = ciStmt.get(entry.lane.repository, entry.lane.base, entry.entryId).at;
        const rows = releases.filter(r => r?.entryId === entry.entryId);
        const r = rows[0];
        const released = rows.length === 1 && r.ackId === entry.ackId
          && r.launchRequestId === admission.handoff.closer.launchRequestId && r.build === build
          && r.workerReleased === true && r.closerLeaseReleased === true && text(r.sourceRef)
          && time(r.releasedAt) >= time(entry.acknowledgedAt) && time(r.releasedAt) < time(firstCiAt)
          && time(r.observedAt) >= time(r.releasedAt) && time(r.observedAt) <= time(now);
        closerObservations.push({ entryId: entry.entryId, ackId: entry.ackId, firstCiAt,
          releasedAt: r?.releasedAt ?? null, released, sourceRef: r?.sourceRef ?? null });
      }
      const closersReleasedBeforeCi = closerObservations.length > 0 && closerObservations.every(r => r.released);
      if (!closersReleasedBeforeCi) pending.push('closer-release-before-ci-unproven');
      if (!receipts.length) pending.push('confirmed-merge-receipts-unavailable');
      if (rejectedReceipts.length) pending.push('merge-receipt-evidence-rejected');
      if (route.executor !== 'queue-v2' || c.pending.includes('canary-route-inactive')) pending.push('expansion-route-inactive');
      if (c.pending.includes('rollback-returns-pending')) pending.push('rollback-returns-pending');
      const inventoryKnown = !c.preflight.issues.includes('legacy-writers-live-or-unknown');
      return { status: pending.length ? 'pending' : 'complete', lane: c.lane, window: c.window,
        route: c.preflight.ready && route.executor === 'queue-v2' && ownerKnown ? 'queue-v2' : null,
        legacyWriters: inventoryKnown ? c.preflight.registeredLegacyWriters : null,
        confirmedReceipts: receipts.length, receipts, rejectedReceipts,
        closersReleasedBeforeCi, closerObservations, pending: [...new Set(pending)],
        preflight: c.preflight, entries: c.entries, clean: c.clean, remediated: c.remediated,
        metrics: c.metrics, rollbackRehearsed: c.rollbackRehearsed,
        denominator: c.denominator, authority: c.authority };
    })();
  } };
}
