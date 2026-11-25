import { appendAmaAuditAttempt, readAmaAuditEntry } from './audit.mjs';

export const HAMMER_WRITER_HOLD = 'merge-writer-deferred';
const SHA = /^[a-f0-9]{40}$/i;
const WRITER_HOLD_PROBE_INTERVAL_MS = 300_000;
const observations = new Map();
// Longer than the legacy lane's maximum 900-second request lifetime.
export const WRITER_HOLD_DRAIN_MS = 960_000;
export function writerHoldDrainElapsed(hold, now) {
  const started = Date.parse(hold?.startedAt);
  return hold?.mergeWriter?.acknowledgement !== 'queued' && Number.isFinite(started)
    && Number.isFinite(now) && now - started >= WRITER_HOLD_DRAIN_MS;
}
export function writerHoldOpenUnchanged(hold, live) {
  return String(live?.state || live?.prState).toUpperCase() === 'OPEN'
    && String(live?.headRefOid || live?.headSha).toLowerCase() === hold.validatedHead.toLowerCase()
    && (live?.baseRefName || live?.baseBranch) === hold.mergeWriter.baseRef
    && SHA.test(live?.baseRefOid || live?.baseSha || '')
    && (live.baseRefOid || live.baseSha).toLowerCase() === hold.mergeWriter.baseSha.toLowerCase();
}

// Reconciliation ends uncertainty, never claims a merge or refunds a charge.
// A fresh exact-head/base observation and the same live lease are both needed.
export async function reconcileHammerWriterHold({ rootDir, hqRoot, repo, prNumber, hold,
  leaseId, now, readIdentityImpl, inspectLeaseImpl, appendAuditImpl = appendAmaAuditAttempt,
  readAuditImpl = readAmaAuditEntry }) {
  if (!writerHoldDrainElapsed(hold, now) || !leaseId) return false;
  inspectLeaseImpl ||= (await import('./merge-lease.mjs')).inspectMergeLease;
  const identity = { rootDir, repo, base: hold.mergeWriter.baseRef };
  const held = () => {
    const observation = inspectLeaseImpl(identity), lease = observation.lease;
    return observation.holderLiveness === 'live' && lease?.leaseId === leaseId
      && [process.pid, process.ppid].includes(Number(lease.holderPid))
      && lease.repo?.toLowerCase() === repo.toLowerCase() && lease.base === hold.mergeWriter.baseRef
      && Number(lease.holderPr) === Number(prNumber)
      && lease.holderHead?.toLowerCase() === hold.validatedHead.toLowerCase();
  };
  if (!held()) return false;
  const live = await readIdentityImpl();
  if (!writerHoldOpenUnchanged(hold, live) || !held()) return false;
  const current = readHammerWriterHold(hqRoot, repo, prNumber, hold.validatedHead, readAuditImpl);
  if (!current || JSON.stringify(hammerWriterHoldIdentity(current)) !== JSON.stringify(hammerWriterHoldIdentity(hold))) return false;
  const tail = readAuditImpl(hqRoot, repo, prNumber, hold.validatedHead)?.attempts?.at(-1);
  if (!Number.isSafeInteger(tail?.attemptNumber) || tail.attemptNumber < 1 || !held()) return false;
  appendAuditImpl({ hqRoot, repo, prNumber, headSha: hold.validatedHead,
    expectedLastAttemptNumber: tail.attemptNumber, now: new Date(now).toISOString(),
    attempt: { outcome: 'in_progress', path: 'hammer', attemptPhase: 'hammer-gh-pr-merge',
      reconcilesAttemptNumber: hold.attemptNumber,
      validatedHead: hold.validatedHead, reason: 'merge-writer-reconciled',
      mergeWriter: { ...hold.mergeWriter, write: 'unknown', readback: 'open',
        readbackHead: hold.validatedHead, readExit: 0 } } });
  return true;
}

export function hammerWriterHoldIdentity(hold) {
  return [hold.validatedHead, hold.attemptNumber, hold.startedAt, hold.reason,
    hold.mergeWriter.baseRef, hold.mergeWriter.baseSha];
}

// Cache held observations only. A changed input or terminal target must be
// observed afresh by any later invocation that wants to proceed.
export async function observeHammerWriterHold({ rootDir, hqRoot, repo, prNumber, hold, now, signal, reader, retain, scope, fresh = false }) {
  signal?.throwIfAborted();
  const key = JSON.stringify([scope, rootDir, hqRoot, repo.toLowerCase(), prNumber, ...hammerWriterHoldIdentity(hold)]);
  const previous = observations.get(key);
  if (!fresh && previous && now >= previous.observedAt && now - previous.observedAt < WRITER_HOLD_PROBE_INTERVAL_MS) return previous;
  const live = await Promise.resolve().then(reader).catch(() => null);
  signal?.throwIfAborted();
  const observation = { live, observedAt: now, paged: previous?.paged === true };
  observations.delete(key);
  if (retain(live)) {
    observations.set(key, observation);
    if (observations.size > 4096) observations.delete(observations.keys().next().value);
  }
  return observation;
}

// CI, packaging and wrapper audits do not settle a writer intent.
export function readHammerWriterHold(hqRoot, repo, prNumber, headSha, readAudit = readAmaAuditEntry) {
  const audit = readAudit(hqRoot, repo, prNumber, headSha);
  if (audit?.status === 'succeeded') return null;
  const attempt = audit?.attempts?.findLast(entry =>
    entry.attemptPhase === 'hammer-gh-pr-merge'
      && (entry.mergeWriter || ['merge-writer-intent', HAMMER_WRITER_HOLD].includes(entry.reason)));
  if (!['merge-writer-intent', HAMMER_WRITER_HOLD, 'merge-queue-pending'].includes(attempt?.reason)) return null;
  if (attempt.validatedHead !== headSha || !SHA.test(attempt.mergeWriter?.baseSha || '')) {
    throw new Error('merge writer audit identity unavailable');
  }
  return attempt;
}

export async function pageHammerWriterHold({ rootDir, repo, prNumber, hold, now, pageImpl }) {
  const { observeClosureWait } = await import('./closure-wait.mjs');
  const evidence = hold.mergeWriter;
  return observeClosureWait({ rootDir, repo, prNumber, headSha: hold.validatedHead, now,
    waitClass: HAMMER_WRITER_HOLD, immediate: true, pageImpl,
    reason: `reconcile GitHub merge state and inspect AMA audit attempt ${hold.attemptNumber}; base ${evidence.baseSha}, `
      + `writer ${evidence.reason || 'interrupted'} (${evidence.phase || 'unconfirmed'}, ${evidence.elapsedMs ?? 'unknown'}ms), `
      + `write ${evidence.write}, readback ${evidence.readback}` });
}

export function hammerWriterInputsChanged(hold, { headSha, state, baseSha, baseRef } = {}) {
  return state === 'OPEN' && headSha === hold.validatedHead && SHA.test(baseSha || '')
    && (baseSha.toLowerCase() !== hold.mergeWriter.baseSha.toLowerCase()
      || Boolean(baseRef && baseRef !== hold.mergeWriter.baseRef));
}
