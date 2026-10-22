// LAC-2081: a dead caller is not proof that its dispatch child never enqueued.
import fsExt from 'fs-ext';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { hostname } from 'node:os';
import { writeFileAtomic } from '../atomic-write.mjs';
import { readLaunchRequestByIdempotencyKeyAsync } from '../session-ledger-read-adapter.mjs';
import { amaCloserDispatchFilePath } from './dispatch-record-read.mjs';
import { readAmaCloserLease, isAmaCloserPidAlive, updateAmaCloserLease } from './closer-lease.mjs';
import { recordHammerRetryDispatch } from './hammer-retry-cap.mjs';

const heldLocks = new WeakMap();
function lockPath(rootDir, identity) {
  return amaCloserDispatchFilePath(rootDir, { ...identity, headSha: 'intent' }) + '.lock';
}

export function tryAcquireCloserIntentLock(rootDir, identity) {
  // One PR, across dispatch heads. Never unlink a flock inode.
  const path = lockPath(rootDir, identity);
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'a', 0o640);
  try { fsExt.flockSync(fd, 'exnb'); }
  catch (error) {
    closeSync(fd);
    if (['EAGAIN', 'EWOULDBLOCK'].includes(error.code)) return null;
    throw error;
  }
  const release = () => { heldLocks.delete(release); closeSync(fd); };
  heldLocks.set(release, path);
  return release;
}

export function withCloserIntentWriteLock(rootDir, identity, token, write) {
  if (token && heldLocks.get(token) === lockPath(rootDir, identity)) return write();
  const release = tryAcquireCloserIntentLock(rootDir, identity);
  if (!release) throw Object.assign(new Error('closer intent is owned by another writer'), { code: 'EBUSY' });
  try { return write(); } finally { release(); }
}

const readBytes = path => {
  try { return readFileSync(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const isPreReceiptIntent = record => record?.state === 'dispatching';

export async function reconcilePreReceiptIntent(rootDir, identity, options = {}) {
  const release = tryAcquireCloserIntentLock(rootDir, identity);
  if (!release) return { status: 'held', reason: 'intent-lock-held' };
  try {
    const path = amaCloserDispatchFilePath(rootDir, identity);
    const bytes = readBytes(path);
    const record = bytes && JSON.parse(bytes);
    if (!isPreReceiptIntent(record)) return { status: 'unchanged' };
    const leaseIdentity = { ...record, headSha: record.targetRemediationSha || record.headSha };
    let lease;
    try { lease = readAmaCloserLease(rootDir, leaseIdentity); }
    catch { return { status: 'held', reason: 'lease-unreadable' }; }
    const now = options.now || new Date().toISOString();
    const localDead = lease?.status === 'pending' && !lease.lrqId
      && (!lease.holderHost || lease.holderHost === hostname())
      && isAmaCloserPidAlive(lease.watcherPid, options.processKillImpl) === false;
    const matchingLease = lease?.acquiredAt === record.lastAttemptedAt;
    // New dispatchers hold this lock for their whole launch. Also honor legacy
    // or independently renewed leases; neither age nor a missing receipt wins.
    const settledNoLaunch = matchingLease && lease?.status === 'terminal'
      && lease.terminalOutcome === 'deferred' && !lease.lrqId && record.dispatchPhase === 'prepared';
    const promotedLease = matchingLease && lease?.status === 'dispatched' && lease.lrqId;
    const foreignLease = lease && !(matchingLease && localDead) && !settledNoLaunch && !promotedLease;
    let probe;
    if (!foreignLease && record.dispatchIdempotencyKey) {
      try {
        probe = await (options.readIntentReceiptImpl || readLaunchRequestByIdempotencyKeyAsync)({
          ...options, rootDir, hqRoot: options.hqRoot || record.hqRoot,
          idempotencyKey: record.dispatchIdempotencyKey, timeoutMs: 1000,
        });
      } catch { probe = { ok: false }; }
    }
    // Evidence reads yield. Re-read the entire record and lease, preserving even
    // unrelated annotations or a same-timestamp replacement owner.
    if (readBytes(path) !== bytes || !same(readAmaCloserLease(rootDir, leaseIdentity), lease)) {
      return { status: 'held', reason: 'intent-or-lease-changed' };
    }
    const rows = probe?.ok && Array.isArray(probe.rows) ? probe.rows : null;
    const receipt = rows?.length === 1 ? rows[0] : null;
    options.signal?.throwIfAborted();
    const matchingReceipt = receipt && receipt.idempotency_key === record.dispatchIdempotencyKey
      && typeof receipt.launch_request_id === 'string' && receipt.launch_request_id.startsWith('lrq_')
      && receipt.ticket_ref === `AMA-PR-${record.prNumber}`
      && [record.repo, record.repo.split('/').at(-1)].includes(receipt.target_repo);
    let budgetUnreadable = false;
    const recoverableReceipt = !foreignLease && matchingReceipt
      && (!lease?.lrqId || lease.lrqId === receipt.launch_request_id) && !settledNoLaunch;
    if (recoverableReceipt && !options.dryRun && String(record.workerClass).startsWith('hammer')) {
      // Charge before receipt persistence, keyed across a crash on either side.
      try {
        recordHammerRetryDispatch(rootDir, record, { jobKey: record.reviewedSha || record.headSha,
          headSha: record.targetRemediationSha || record.headSha,
          dispatchKey: record.dispatchIdempotencyKey, preserveSuppression: true, now });
      } catch { budgetUnreadable = true; }
    }
    let next;
    let status;
    if (recoverableReceipt && !budgetUnreadable) {
      status = 'receipt-recovered';
      if (!options.dryRun && lease && !promotedLease) {
        try { updateAmaCloserLease({ rootDir, ...leaseIdentity, expectedLease: lease,
          status: 'dispatched', lrqId: receipt.launch_request_id, now }); }
        catch (error) {
          if (!['EBUSY', 'ESTALE'].includes(error.code)) throw error;
          return { status: 'held', reason: 'lease-mutation-raced' };
        }
      }
      next = { ...record, state: 'dispatched', launchRequestId: receipt.launch_request_id,
        dispatchId: receipt.launch_request_id, dispatchedAt: receipt.requested_at || record.lastAttemptedAt,
        // Let ordinary reconciliation resolve live retries and terminal status.
        lastObservedStatus: 'unknown', lastObservedAt: now, lastError: null,
        preReceiptReconciliation: { status, observedAt: now } };
    } else if (!foreignLease && (localDead || settledNoLaunch) && matchingLease
      && record.dispatchPhase === 'prepared' && record.dispatchIdempotencyKey
      && rows?.length === 0) {
      // prepared is persisted before submission; submitting is persisted before
      // exec. Only the former plus a dead fenced owner proves no launch.
      status = 'no-launch';
      next = { ...record, state: 'no-dispatch', reason: 'interrupted-before-submission',
        retryCount: Math.max(0, Number(record.retryCount || 0) - 1),
        launchRequestId: null, dispatchId: null,
        preReceiptReconciliation: { status, observedAt: now } };
      if (!options.dryRun) {
        try { updateAmaCloserLease({ rootDir, ...leaseIdentity, expectedLease: lease,
          status: 'terminal', terminalOutcome: 'deferred', now }); }
        catch (error) {
          if (!['EBUSY', 'ESTALE'].includes(error.code)) throw error;
          return { status: 'held', reason: 'lease-mutation-raced' };
        }
      }
    } else {
      status = 'unknown';
      const prior = record.preReceiptReconciliation;
      const firstObservedAt = Number.isFinite(Date.parse(prior?.firstObservedAt)) ? prior.firstObservedAt : now;
      const started = Date.parse(record.lastAttemptedAt);
      const timeout = Number(record.dispatchTimeoutMs);
      const deadlineAt = (Number.isFinite(Date.parse(prior?.deadlineAt)) && prior.deadlineAt) || new Date(Number.isFinite(started) && timeout > 0
        ? started + Math.min(timeout, 2 ** 31 - 1) : Date.parse(firstObservedAt) + 30 * 60_000).toISOString();
      const diagnosticStatus = Date.parse(now) >= Date.parse(deadlineAt) ? 'inspection-required' : 'unknown';
      const reason = foreignLease ? 'lease-ownership-unresolved'
        : budgetUnreadable ? 'receipt-budget-unreadable'
        : !record.dispatchIdempotencyKey ? 'legacy-intent-without-key'
        : !rows ? 'receipt-lookup-unreadable' : rows.length ? 'receipt-identity-ambiguous' : 'submission-absence-unproven';
      next = { ...record, preReceiptReconciliation: { status: diagnosticStatus,
        firstObservedAt, deadlineAt, observedAt: now, reason } };
      // Bounded diagnostics: no launch timestamp refresh, no unbounded history,
      // no polling write/log storm. The deadline never clears ownership.
      if (prior?.status === diagnosticStatus && prior?.reason === reason
        && Date.parse(now) - Date.parse(prior.observedAt) < 60_000) next = record;
    }
    if (!options.dryRun && next !== record) {
      writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
      if (record.preReceiptReconciliation?.status !== next.preReceiptReconciliation.status) {
        options.logger?.warn?.(JSON.stringify({ event: 'ama_closer.pre_receipt_reconciled',
          repo: record.repo, prNumber: record.prNumber, headSha: record.headSha,
          ...next.preReceiptReconciliation }));
      }
    }
    return { status, changed: next !== record, record: next };
  } finally { release(); }
}
