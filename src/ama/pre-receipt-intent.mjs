// LAC-2081: a dead caller is not proof that its dispatch child never enqueued.
import fsExt from 'fs-ext';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { hostname } from 'node:os';
import { writeFileAtomic } from '../atomic-write.mjs';
import { readLaunchRequestByIdempotencyKeyAsync, readLaunchRequestsForTicketSinceAsync } from '../session-ledger-read-adapter.mjs';
import { amaCloserDispatchFilePath } from './dispatch-record-read.mjs';
import { readAmaCloserLease, isAmaCloserPidAlive, updateAmaCloserLease } from './closer-lease.mjs';
import { recordHammerRetryDispatch } from './hammer-retry-cap.mjs';
import { deliverAlert } from '../alert-delivery.mjs';
import { execGhWithRetry } from '../gh-cli.mjs';

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
  const release = () => {
    if (!heldLocks.delete(release)) return;
    closeSync(fd);
  };
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
// Accept PR metadata only: dispatch lifecycle state is a separate contract.
export const isTerminalCloserPullRequest = pr => pr?.isOpen === false
  || pr?.isMerged === true || pr?.merged === true
  || ['CLOSED', 'MERGED'].includes(String(pr?.prState || pr?.state || '').toUpperCase());

async function readPullRequestState({ repo, prNumber }, options) {
  const { stdout } = await execGhWithRetry({
    args: ['api', `repos/${repo}/pulls/${prNumber}`, '--jq', '{state, merged}'],
    execFileImpl: options.execFileImpl, env: options.env || process.env,
    signal: options.signal, retries: 0, timeoutMs: 1000, totalTimeoutMs: 1000,
  });
  return JSON.parse(stdout);
}

function intentSnapshotMatches(path, bytes, rootDir, identity, lease) {
  try { return readBytes(path) === bytes && same(readAmaCloserLease(rootDir, identity), lease); }
  catch { return false; }
}

export async function reconcilePreReceiptIntent(rootDir, identity, options = {}) {
  const release = tryAcquireCloserIntentLock(rootDir, identity);
  if (!release) return { status: 'held', reason: 'intent-lock-held' };
  try {
    const path = amaCloserDispatchFilePath(rootDir, identity);
    const bytes = readBytes(path);
    const record = bytes && JSON.parse(bytes);
    if (!isPreReceiptIntent(record)) return { status: 'unchanged' };
    if (record.repo !== identity.repo || Number(record.prNumber) !== Number(identity.prNumber)
      || record.headSha !== identity.headSha) return { status: 'held', reason: 'intent-identity-mismatch' };
    if (options.legacyOnly && record.dispatchIdempotencyKey) return { status: 'held', reason: 'keyed-intent' };
    const legacy = !record.dispatchIdempotencyKey;
    const leaseIdentity = { ...record, headSha: record.targetRemediationSha || record.headSha };
    let lease;
    try { lease = readAmaCloserLease(rootDir, leaseIdentity); }
    catch { return { status: 'held', reason: 'lease-unreadable' }; }
    const now = options.now || new Date().toISOString();
    let pr;
    try {
      pr = options.prMetadata || await (options.readPullRequestStateImpl || readPullRequestState)(record, options);
    } catch { /* Missing or unreadable PR state cannot authorize retirement or a page. */ }
    options.signal?.throwIfAborted();
    if (!intentSnapshotMatches(path, bytes, rootDir, leaseIdentity, lease)) {
      return { status: 'held', reason: 'intent-or-lease-changed' };
    }
    if (isTerminalCloserPullRequest(pr)) {
      // PR retirement says nothing about submission or worker liveness. Preserve
      // lease, launch evidence and budgets; only end this intent's PR hold/page.
      const next = { ...record, state: 'completed', reason: 'pr-terminal',
        preReceiptReconciliation: { status: 'pr-terminal', observedAt: now } };
      if (!options.dryRun) writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
      return { status: 'pr-terminal', changed: true, record: next };
    }
    if (!(pr?.isOpen === true || String(pr?.prState || pr?.state || '').toUpperCase() === 'OPEN')) {
      return { status: 'held', reason: 'pr-state-unreadable' };
    }
    const localDead = lease?.status === 'pending' && !lease.lrqId
      && (!lease.holderHost || lease.holderHost === hostname())
      && isAmaCloserPidAlive(lease.watcherPid, options.processKillImpl) === false;
    const matchingLease = lease?.acquiredAt === record.lastAttemptedAt;
    // New dispatchers hold this lock for their whole launch. Also honor legacy
    // or independently renewed leases; neither age nor a missing receipt wins.
    const settledNoLaunch = matchingLease && lease?.status === 'terminal'
      && lease.terminalOutcome === 'deferred' && !lease.lrqId && (legacy || record.dispatchPhase === 'prepared');
    const promotedLease = !legacy && matchingLease && lease?.status === 'dispatched' && lease.lrqId;
    // Legacy watcher PIDs may still be alive long after their old dispatch call
    // returned. Ticket/time ledger evidence, not caller death, proves absence.
    const legacyPendingLease = legacy && matchingLease && lease?.status === 'pending' && !lease.lrqId;
    const foreignLease = lease && !legacyPendingLease && !(matchingLease && localDead)
      && !settledNoLaunch && !promotedLease;
    let probe;
    if (!foreignLease && record.dispatchIdempotencyKey) {
      try {
        probe = await (options.readIntentReceiptImpl || readLaunchRequestByIdempotencyKeyAsync)({
          ...options, rootDir, hqRoot: options.hqRoot || record.hqRoot,
          idempotencyKey: record.dispatchIdempotencyKey, timeoutMs: 1000,
        });
      } catch { probe = { ok: false }; }
    }
    const query = legacy ? { kind: 'launch-requests-for-ticket-since',
      ticketRef: `AMA-PR-${record.prNumber}`, requestedAtOrAfter: record.lastAttemptedAt,
      limit: 1 } : null;
    if (!foreignLease && legacy) {
      try {
        probe = await (options.readLegacyIntentLaunchesImpl || readLaunchRequestsForTicketSinceAsync)({
          ...options, rootDir, hqRoot: options.hqRoot || record.hqRoot,
          ticketRef: query.ticketRef, requestedAtOrAfter: query.requestedAtOrAfter, timeoutMs: 1000,
        });
      } catch { probe = { ok: false, reason: 'ledger-read-failed' }; }
    }
    // Evidence reads yield. Re-read the entire record and lease, preserving even
    // unrelated annotations or a same-timestamp replacement owner.
    if (!intentSnapshotMatches(path, bytes, rootDir, leaseIdentity, lease)) {
      return { status: 'held', reason: 'intent-or-lease-changed' };
    }
    const rows = probe?.ok && Array.isArray(probe.rows) ? probe.rows : null;
    const evidence = query ? { ...query, ok: rows !== null,
      rowCount: rows?.length ?? null,
      backend: probe?.target?.backend || null, source: probe?.target?.source || null,
      reason: rows === null ? probe?.reason || 'ledger-lookup-unreadable' : null,
      launchRequestIds: rows?.map(row => row?.launch_request_id).filter(id => typeof id === 'string') || [],
    } : null;
    const receipt = rows?.length === 1 ? rows[0] : null;
    options.signal?.throwIfAborted();
    const matchingReceipt = !legacy && receipt && receipt.idempotency_key === record.dispatchIdempotencyKey
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
    } else if (legacy && !foreignLease && rows?.length === 0
      && Number.isFinite(Date.parse(record.lastAttemptedAt))) {
      status = 'no-launch';
      next = { ...record, state: 'no-dispatch', reason: 'legacy-no-launch-proven',
        retryCount: Math.max(0, Number(record.retryCount || 0) - 1),
        launchRequestId: null, dispatchId: null,
        preReceiptReconciliation: { status, reason: 'legacy-no-launch-proven', observedAt: now, query: evidence } };
      if (!options.dryRun) {
        // The operator CLI fsyncs its authorization audit before any mutation.
        options.beforeLegacySettlement?.(next);
        if (lease) {
          try { updateAmaCloserLease({ rootDir, ...leaseIdentity, expectedLease: lease,
            status: 'terminal', terminalOutcome: 'deferred', now }); }
          catch (error) {
            if (!['EBUSY', 'ESTALE'].includes(error.code)) throw error;
            return { status: 'held', reason: 'lease-mutation-raced', evidence };
          }
        }
      }
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
        : legacy ? (!rows ? 'legacy-intent-without-key' : rows.length
          ? 'legacy-launch-in-range' : 'legacy-intent-without-key')
        : !rows ? 'receipt-lookup-unreadable' : rows.length ? 'receipt-identity-ambiguous' : 'submission-absence-unproven';
      next = { ...record, preReceiptReconciliation: { status: diagnosticStatus,
        firstObservedAt, deadlineAt, observedAt: now, reason,
        ...(evidence ? { query: evidence } : {}),
        ...(prior?.alertedAt ? { alertedAt: prior.alertedAt } : {}) } };
      // Bounded diagnostics: no launch timestamp refresh, no unbounded history,
      // no polling write/log storm. The deadline never clears ownership.
      if (prior?.status === diagnosticStatus && prior?.reason === reason
        && Date.parse(now) - Date.parse(prior.observedAt) < 60_000) next = record;
    }
    if (!options.dryRun && next.preReceiptReconciliation?.status === 'inspection-required'
      && !next.preReceiptReconciliation.alertedAt) {
      try {
        await (options.deliverAlertImpl || deliverAlert)(
          `Closer intent requires inspection for ${record.repo}#${record.prNumber}, head ${record.headSha}: `
          + `${next.preReceiptReconciliation.reason}. This PR/head is held; other closers may proceed.`,
          { event: 'ama_closer.pre_receipt_inspection_required', env: options.env || process.env,
            now: new Date(now), payload: { repo: record.repo, prNumber: record.prNumber,
              headSha: record.headSha, reason: next.preReceiptReconciliation.reason,
              dispatchIdempotencyKey: record.dispatchIdempotencyKey || null,
              lastAttemptedAt: record.lastAttemptedAt || null } });
        next = { ...next, preReceiptReconciliation: { ...next.preReceiptReconciliation, alertedAt: now } };
      } catch (error) {
        options.logger?.warn?.(JSON.stringify({ event: 'ama_closer.pre_receipt_alert_failed',
          repo: record.repo, prNumber: record.prNumber, headSha: record.headSha,
          error: error.message }));
      }
      // Alert enqueue can yield too. Never overwrite a replacement owner.
      if (!intentSnapshotMatches(path, bytes, rootDir, leaseIdentity, lease)) {
        return { status: 'held', reason: 'intent-or-lease-changed' };
      }
    }
    if (!options.dryRun && next !== record) {
      writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
      if (record.preReceiptReconciliation?.status !== next.preReceiptReconciliation.status) {
        options.logger?.warn?.(JSON.stringify({ event: 'ama_closer.pre_receipt_reconciled',
          repo: record.repo, prNumber: record.prNumber, headSha: record.headSha,
          ...next.preReceiptReconciliation }));
      }
    }
    return { status, changed: next !== record, record: next, ...(evidence ? { evidence } : {}) };
  } finally { release(); }
}
