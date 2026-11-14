import fsExt from 'fs-ext';
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeFileAtomic } from '../atomic-write.mjs';
import { observeClosureWait } from './closure-wait.mjs';

export const closerSuccessorPath = (rootDir, { repo, prNumber, headSha }) => join(rootDir, 'data', 'closer-successors',
  `${createHash('sha256').update(`${repo.toLowerCase()}#${Number(prNumber)}@${String(headSha).toLowerCase()}`).digest('hex')}.json`);
export function readCloserSuccessor(rootDir, identity) {
  try { return JSON.parse(readFileSync(closerSuccessorPath(rootDir, identity), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Synchronous enrollment lets the pre-claim cap stop transfer custody durably
// before returning. The watcher executes it using fresh admission evidence.
export function requestCloserSuccessor({ rootDir, repo, prNumber, headSha, reviewBody, refusingReasons = [],
  source, now = new Date().toISOString() }) {
  if (!headSha) return null;
  headSha = String(headSha).toLowerCase();
  const identity = { repo, prNumber, headSha };
  const path = closerSuccessorPath(rootDir, identity);
  mkdirSync(dirname(path), { recursive: true });
  const record = { schemaVersion: 1, ...identity, status: 'successor-pending', source,
    reviewBody, refusingReasons, requestedAt: now };
  try { writeFileAtomic(path, `${JSON.stringify(record)}\n`, { overwrite: false }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const fd = openSync(`${path}.lock`, 'a', 0o640);
  try { fsExt.flockSync(fd, 'exnb'); }
  catch (error) {
    closeSync(fd);
    if (['EAGAIN', 'EWOULDBLOCK'].includes(error.code)) return readCloserSuccessor(rootDir, identity);
    throw error;
  }
  try {
    const current = readCloserSuccessor(rootDir, identity);
    // A pre-claim cap can precede a later refusing predicate on the same head.
    // Refresh its input without resetting custody or enrolling another job.
    if (current.status !== 'successor-enrolled' && String(reviewBody || '').trim()
      && (current.reviewBody !== reviewBody || JSON.stringify(current.refusingReasons) !== JSON.stringify(refusingReasons))) {
      const refreshed = { ...current, reviewBody, refusingReasons, reviewObservedAt: now };
      writeFileAtomic(path, `${JSON.stringify(refreshed)}\n`);
      return refreshed;
    }
    return current;
  } finally { closeSync(fd); }
}

export async function settleCloserSuccessor({ rootDir, repo, prNumber, headSha, enabled = true,
  admitted = true, now = new Date().toISOString(), riskClass, handoffImpl, observeWaitImpl = observeClosureWait }) {
  headSha = String(headSha).toLowerCase();
  const identity = { repo, prNumber, headSha };
  const path = closerSuccessorPath(rootDir, identity);
  const initial = readCloserSuccessor(rootDir, identity);
  if (!initial) return null;
  const fd = openSync(`${path}.lock`, 'a', 0o640);
  try { fsExt.flockSync(fd, 'exnb'); }
  catch (error) { closeSync(fd); if (['EAGAIN', 'EWOULDBLOCK'].includes(error.code)) return { status: 'successor-pending' }; throw error; }
  try {
    let record = readCloserSuccessor(rootDir, identity);
    if (record.status === 'successor-enrolled') return record;
    let result;
    try {
      const handoff = handoffImpl || (await import('./final-fix-all.mjs')).handoffFinalFixAll;
      result = !enabled ? { reason: 'successor-path-disabled' } : !admitted ? { reason: 'successor-admission-refused' }
        : await handoff({ rootDir, repo, prNumber, headSha, reviewBody: record.reviewBody, now, riskClass });
    } catch (error) { result = { reason: 'successor-dispatch-failed', detail: String(error?.message ?? error).slice(0, 300) }; }
    record = { ...record, updatedAt: now, status: result?.remediation?.jobId ? 'successor-enrolled' : 'ownerless-closer-no-merge',
      successorJobId: result?.remediation?.jobId || null, reason: result?.reason || result?.action || 'successor-dispatch-refused' };
    writeFileAtomic(path, `${JSON.stringify(record)}\n`);
    if (record.status === 'ownerless-closer-no-merge') {
      await observeWaitImpl({ rootDir, repo, prNumber, headSha, reason: `${record.status}:${record.reason}`,
        now: Date.parse(now), immediate: true, waitClass: 'closer-successor' });
    }
    return record;
  } finally { closeSync(fd); }
}
