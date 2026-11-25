import { readAmaAuditEntry } from './audit.mjs';

export const HAMMER_WRITER_HOLD = 'merge-writer-deferred';
const SHA = /^[a-f0-9]{40}$/i;
const WRITER_HOLD_PROBE_INTERVAL_MS = 300_000;
const observations = new Map();

export function hammerWriterHoldIdentity(hold) {
  return [hold.validatedHead, hold.attemptNumber, hold.startedAt, hold.reason,
    hold.mergeWriter.baseRef, hold.mergeWriter.baseSha];
}

// Cache held observations only. A changed input or terminal target must be
// observed afresh by any later invocation that wants to proceed.
export async function observeHammerWriterHold({ rootDir, hqRoot, repo, prNumber, hold, now, signal, reader, retain, scope }) {
  signal?.throwIfAborted();
  const key = JSON.stringify([scope, rootDir, hqRoot, repo.toLowerCase(), prNumber, ...hammerWriterHoldIdentity(hold)]);
  const previous = observations.get(key);
  if (previous && now >= previous.observedAt && now - previous.observedAt < WRITER_HOLD_PROBE_INTERVAL_MS) return previous;
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
  if (!['merge-writer-intent', HAMMER_WRITER_HOLD].includes(attempt?.reason)) return null;
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
