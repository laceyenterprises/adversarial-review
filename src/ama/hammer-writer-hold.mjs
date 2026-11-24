import { readAmaAuditEntry } from './audit.mjs';

export const HAMMER_WRITER_HOLD = 'merge-writer-deferred';
const SHA = /^[a-f0-9]{40}$/i;

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
