// LAC-2081: a dead caller is not proof that its dispatch child never enqueued.
import fsExt from 'fs-ext';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveHqRoot } from '../hq-root.mjs';
import { loadAwareTimeoutMs } from '../load-aware-timeout.mjs';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { hostname } from 'node:os';
import { writeFileAtomic } from '../atomic-write.mjs';
import { readLaunchRequestByIdempotencyKeyAsync, readLaunchRequestsForTicketSinceAsync, readLaunchRequestSnapshotFromLedgerAsync } from '../session-ledger-read-adapter.mjs';
import { isTerminalLaunchRequestStatus, launchRequestOwned } from './launch-request-status.mjs';
import { amaCloserDispatchFilePath, readAmaCloserDispatchRecord, isPreReceiptIntent } from './dispatch-record-read.mjs';
import { abandonedAmaCloserLeaseOutcome, readAmaCloserLease, isAmaCloserPidAlive, updateAmaCloserLease, deleteAmaCloserLeaseIfCurrent } from './closer-lease.mjs';
import { recordHammerRetryDispatch } from './hammer-retry-cap.mjs';
import { deliverAlert } from '../alert-delivery.mjs';
import { execGhWithRetry } from '../gh-cli.mjs';
import { probeCloserSubmitter } from './dispatch-submitter.mjs';
import { isHammerWorkerClass } from './hammer-worker-class.mjs';
import { releaseMergedPrMergeLeases } from './merge-lease.mjs';
import { writeAmaAuditEntry } from './audit.mjs';

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
export { isPreReceiptIntent } from './dispatch-record-read.mjs';
// Accept PR metadata only: dispatch lifecycle state is a separate contract.
export const isTerminalCloserPullRequest = pr => pr?.isOpen === false
  || pr?.isMerged === true || pr?.merged === true
  || ['CLOSED', 'MERGED'].includes(String(pr?.prState || pr?.state || '').toUpperCase());

async function readPullRequestState({ repo, prNumber }, options) {
  const { stdout } = await execGhWithRetry({
    args: ['api', `repos/${repo}/pulls/${prNumber}`, '--jq', '{state, merged, headSha: .head.sha}'],
    execFileImpl: options.execFileImpl, env: options.env || process.env,
    signal: options.signal, retries: 1, timeoutMs: 3000, totalTimeoutMs: 5000,
  });
  return JSON.parse(stdout);
}

function intentSnapshotMatches(path, bytes, rootDir, identity, lease) {
  try { return readBytes(path) === bytes && same(readAmaCloserLease(rootDir, identity), lease); }
  catch { return false; }
}

// A missing ticket is acceptable only under this intent's unique key. The
// caller also requires exactly one returned row before adopting any receipt.
export function closerLaunchMatches(record, row, { uniqueKeyReceipt = false } = {}) {
  const ownKey = uniqueKeyReceipt && Boolean(record.dispatchIdempotencyKey)
    && row?.idempotency_key === record.dispatchIdempotencyKey;
  return row?.identity_ambiguous !== true
    && (row?.ticket_ref === `AMA-PR-${record.prNumber}`
      || (ownKey && isHammerWorkerClass(row?.worker_class)
        && row.ticket_identity?.version === 1 && row.ticket_identity.state === 'absent'
        && typeof row.target_repo === 'string' && row.target_repo.toLowerCase() === record.repo.toLowerCase()
        && row.head_sha === (record.targetRemediationSha || record.headSha)
        && (row?.ticket_ref == null || row.ticket_ref === '')))
    && (row.target_repo == null || (typeof row.target_repo === 'string' && [record.repo, record.repo.split('/').at(-1)].map(value => value.toLowerCase()).includes(row.target_repo.toLowerCase())))
    && (!row.head_sha || row.head_sha === (record.targetRemediationSha || record.headSha));
}

async function lookupReceipt(read, args, options) {
  const attempts = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    options.signal?.throwIfAborted();
    let result;
    try { result = await read(args); }
    catch (error) {
      options.signal?.throwIfAborted();
      result = { ok: false, reason: 'ledger-read-failed', detail: error.message || String(error),
        transient: ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EIO'].includes(error.code) };
    }
    attempts.push({ ok: result?.ok === true && Array.isArray(result.rows),
      reason: result?.reason || null, detail: result?.detail || null });
    if (attempts.at(-1).ok || !result?.transient || attempt === 2) return { ...result, attempts };
    await (options.delayAsyncImpl || ((ms) => delay(ms, undefined, { signal: options.signal })))(100 * (attempt + 1));
  }
}

function queryEvidence(query, probe) {
  const rows = probe?.ok && Array.isArray(probe.rows) ? probe.rows : null;
  return { ...query, ok: rows !== null, rowCount: rows?.length ?? null,
    backend: probe?.target?.backend || null, source: probe?.target?.source || null,
    reason: rows === null ? probe?.reason || 'ledger-lookup-unreadable' : null,
    detail: rows === null ? probe?.detail || null : null,
    timeoutMs: query.timeoutMs, attempts: probe?.attempts || [],
    ...(probe?.absenceProof ? { absenceProof: probe.absenceProof } : {}),
    launchRequestIds: rows?.map(row => row?.launch_request_id).filter(id => typeof id === 'string') || [] };
}

function intentDeadline(record, now) {
  const prior = record.preReceiptReconciliation;
  const firstObservedAt = Number.isFinite(Date.parse(prior?.firstObservedAt)) ? prior.firstObservedAt : now;
  const started = Date.parse(record.lastAttemptedAt);
  const timeout = Number(record.dispatchTimeoutMs);
  const deadlineAt = (Number.isFinite(Date.parse(prior?.deadlineAt)) && prior.deadlineAt) || new Date(Number.isFinite(started) && timeout > 0
    ? started + Math.min(timeout, 2 ** 31 - 1) : Date.parse(firstObservedAt) + 30 * 60_000).toISOString();
  return { firstObservedAt, deadlineAt, deadlinePassed: Date.parse(now) >= Date.parse(deadlineAt) };
}

// Lease owners must invoke the proof owner before deferring to it. Read only
// the named intent; callers bound this to one attempt per PR/head per pass.
export async function reconcileAmaCloserLeaseIntent(rootDir, lease, options = {}) {
  if (!lease || !['pending', 'dispatched'].includes(lease.status)) return { status: 'unchanged' };
  const identity = { ...lease, headSha: lease.rekeyedFromHeadSha || lease.headSha };
  const record = readAmaCloserDispatchRecord(rootDir, identity);
  if (!isPreReceiptIntent(record)) return { status: 'unchanged' };
  const now = new Date(options.now ?? Date.now()).toISOString();
  if (!intentDeadline(record, now).deadlinePassed && !abandonedAmaCloserLeaseOutcome(lease, { ...options,
    isProcessAlive: options.isProcessAlive || (pid => isAmaCloserPidAlive(pid, options.processKillImpl)),
  })) {
    return { status: 'held', reason: 'submitter-within-deadline' };
  }
  return reconcilePreReceiptIntent(rootDir, identity, { ...options, now, leaseHeadSha: lease.headSha });
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
    const legacy = !record.dispatchIdempotencyKey;
    const leaseIdentity = { ...record, headSha: options.leaseHeadSha || record.targetRemediationSha || record.headSha };
    let lease;
    try { lease = readAmaCloserLease(rootDir, leaseIdentity); }
    catch { return { status: 'held', reason: 'lease-unreadable' }; }
    if (options.leaseHeadSha && options.leaseHeadSha !== (record.targetRemediationSha || record.headSha)
      && (!lease || lease.rekeyedFromHeadSha !== record.headSha)) {
      return { status: 'held', reason: 'lease-identity-mismatch' };
    }
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
      if (options.operatorSettlement) return { status: 'held', reason: 'pr-terminal' };
      const merged = pr?.isMerged === true || pr?.merged === true
        || String(pr?.prState || pr?.state || '').toUpperCase() === 'MERGED';
      if (merged && !options.dryRun) {
        writeAmaAuditEntry({ hqRoot: options.hqRoot || record.hqRoot || rootDir,
          ...leaseIdentity, now, attempt: { outcome: 'succeeded', reason: 'confirmed-merged-closeout' } });
        if (!releaseMergedPrMergeLeases({ rootDir, repo: record.repo, prNumber: record.prNumber, now })) {
          return { status: 'held', reason: 'merge-closeout-raced' };
        }
        if (lease && lease.status !== 'terminal') updateAmaCloserLease({ rootDir, ...leaseIdentity,
          expectedLease: lease, status: 'terminal', terminalOutcome: 'pr-merged-externally', now });
      }
      // A merely closed PR proves no submission/worker death: retain its custody.
      // Confirmed merge settles custody above; neither path dispatches or pages.
      const next = { ...record, state: 'completed', reason: 'pr-terminal',
        preReceiptReconciliation: { status: 'pr-terminal', observedAt: now } };
      if (!options.dryRun) writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
      return { status: 'pr-terminal', changed: true, record: next };
    }
    const localDead = lease?.status === 'pending' && !lease.lrqId
      && (!lease.holderHost || lease.holderHost === hostname())
      && isAmaCloserPidAlive(lease.watcherPid, options.processKillImpl) === false;
    const matchingLease = lease?.acquiredAt === record.lastAttemptedAt;
    // New dispatchers hold this lock for their whole launch. Also honor legacy
    // or independently renewed leases; neither age nor a missing receipt wins.
    const settledNoLaunch = matchingLease && lease?.status === 'terminal'
      && lease.terminalOutcome === 'deferred' && !lease.lrqId;
    const promotedLease = !legacy && matchingLease && lease?.status === 'dispatched' && lease.lrqId;
    // Legacy watcher PIDs may still be alive long after their old dispatch call
    // returned. Ticket/time ledger evidence, not caller death, proves absence.
    const matchingPendingLease = (legacy || !lease?.holderHost || lease.holderHost === hostname()) && matchingLease && lease?.status === 'pending' && !lease.lrqId;
    const foreignLease = lease && !matchingPendingLease && !(matchingLease && localDead)
      && !settledNoLaunch && !promotedLease;
    const prior = record.preReceiptReconciliation;
    const { firstObservedAt, deadlineAt, deadlinePassed } = intentDeadline(record, now);
    const started = Date.parse(record.lastAttemptedAt);
    // Re-prove absence after a crash between lease deferral and intent write.
    const canProbeSubmitter = matchingPendingLease || (options.operatorSettlement && promotedLease) || (settledNoLaunch
      && (!lease.holderHost || lease.holderHost === hostname()));
    const processes = !legacy && canProbeSubmitter
      ? probeCloserSubmitter(record, lease, options) : null;
    const deadSubmitter = processes?.watcher.status === 'gone'
      && processes.submitter.status === 'gone' && processes.key.status === 'absent';
    // Use the adapter's normal 30s ledger budget, scaled once for host load.
    const timeoutMs = loadAwareTimeoutMs(30_000, options.loadAwareTimeoutOptions);
    const scope = { projectRef: record.hqProject || 'adversarial-merge-authority', repo: record.repo };
    const ticketQuery = { ...scope, kind: 'launch-requests-for-ticket-since',
      ticketRef: `AMA-PR-${record.prNumber}`, requestedAtOrAfter: record.lastAttemptedAt, limit: 1, timeoutMs };
    const query = legacy ? ticketQuery : { ...scope, kind: 'launch-request-by-idempotency-key',
      idempotencyKey: record.dispatchIdempotencyKey, limit: 2, timeoutMs };
    const read = legacy ? options.readLegacyIntentLaunchesImpl || readLaunchRequestsForTicketSinceAsync
      : options.readIntentReceiptImpl || readLaunchRequestByIdempotencyKeyAsync;
    const args = { ...options, rootDir, hqRoot: options.hqRoot || record.hqRoot, ...query };
    const probe = !foreignLease ? await lookupReceipt(read, args, options) : null;
    let evidence = queryEvidence(query, foreignLease ? { reason: 'lookup-skipped-foreign-lease' } : probe);
    // Operator recovery also supports keyed historical records: prove absence
    // across the entire closer ticket, never only the misattributed launch ID.
    let operatorAbsence = false;
    if (!legacy && !foreignLease && options.operatorSettlement && deadlinePassed) {
      const ticketProbe = await lookupReceipt(options.readLegacyIntentLaunchesImpl || readLaunchRequestsForTicketSinceAsync,
        { ...args, ...ticketQuery }, options);
      const ticketEvidence = queryEvidence(ticketQuery, ticketProbe);
      evidence = { ...evidence, ticketQuery: ticketEvidence, recordedLaunchRequestId: record.launchRequestId || null };
      operatorAbsence = ticketEvidence.ok && ticketEvidence.rowCount === 0;
    }
    // Evidence reads yield. Preserve replacement records and leases.
    if (!intentSnapshotMatches(path, bytes, rootDir, leaseIdentity, lease)) {
      return { status: 'held', reason: 'intent-or-lease-changed' };
    }
    const rows = probe?.ok && Array.isArray(probe.rows) ? probe.rows : null;
    const receipt = rows?.length === 1 ? rows[0] : null;
    options.signal?.throwIfAborted();
    // CLOSERRECEIPTIDENTITY-01: explicit owner recovery may bind a genuinely
    // ticketless historical receipt. Never reinterpret it as launch absence.
    // All identity/progress uncertainty continues to hold ordinary admission.
    let legacyReceipt = false;
    if (options.operatorSettlement && !legacy && !foreignLease && deadlinePassed && deadSubmitter
      && (matchingPendingLease || promotedLease)
      && (!lease.holderHost || lease.holderHost === hostname())
      && receipt?.idempotency_key === record.dispatchIdempotencyKey
      && /^lrq_.+/.test(receipt?.launch_request_id || '')
      && (!lease.lrqId || lease.lrqId === receipt.launch_request_id)
      && isHammerWorkerClass(receipt.worker_class)
      && receipt.ticket_ref === null && receipt.identity_ambiguous === false
      && receipt.ticket_identity?.version === 1 && receipt.ticket_identity.state === 'absent'
      && typeof receipt.target_repo === 'string' && receipt.target_repo.toLowerCase() === record.repo.toLowerCase()
      && receipt.head_sha === (record.targetRemediationSha || record.headSha)
      && pr?.merged === false && pr?.headSha === receipt.head_sha
      && String(pr?.state || pr?.prState || '').toUpperCase() === 'OPEN') {
      const snapshot = await lookupReceipt(
        options.readLegacyReceiptSnapshotImpl || readLaunchRequestSnapshotFromLedgerAsync,
        { ...args, launchRequestIds: [receipt.launch_request_id] }, options);
      const root = snapshot?.ok && snapshot.rows?.find(row => row.launch_request_id === receipt.launch_request_id);
      legacyReceipt = !!root && root.idempotency_key === receipt.idempotency_key
        && isHammerWorkerClass(root.worker_class)
        && root.ticket_ref === null && root.identity_ambiguous === false
        && root.ticket_identity?.version === 1 && root.ticket_identity.state === 'absent'
        && root.target_repo === receipt.target_repo && root.head_sha === receipt.head_sha
        && snapshot.rows.every(row => isTerminalLaunchRequestStatus(row))
        && launchRequestOwned({ ...snapshot, row: root,
          retryChain: snapshot.rows.filter(row => row !== root) }) === false;
      evidence = { ...evidence, legacyReceipt: { authorized: legacyReceipt,
        launchRequestId: receipt.launch_request_id, ticketIdentity: receipt.ticket_identity,
        query: queryEvidence({ kind: 'launch-request-retry-chain',
          launchRequestIds: [receipt.launch_request_id], includeRetryChain: true, timeoutMs }, snapshot),
        terminalRows: snapshot?.ok ? snapshot.rows.map(row => ({
          launchRequestId: row.launch_request_id, status: row.status,
        })) : null }, processes };
      if (!intentSnapshotMatches(path, bytes, rootDir, leaseIdentity, lease)) {
        return { status: 'held', reason: 'intent-or-lease-changed' };
      }
    }
    const matchingReceipt = !legacy && receipt && receipt.idempotency_key === record.dispatchIdempotencyKey
      && typeof receipt.launch_request_id === 'string' && receipt.launch_request_id.startsWith('lrq_')
      && closerLaunchMatches(record, receipt, { uniqueKeyReceipt: true });
    if (!legacy && receipt && !matchingReceipt) {
      evidence = { ...evidence, receiptIdentityMismatch: {
        ticketRef: receipt.ticket_ref || null, targetRepo: receipt.target_repo || null,
        headSha: receipt.head_sha || null,
      } };
    }
    const foreignReceipt = receipt?.identity_ambiguous !== true
      && typeof receipt?.ticket_ref === 'string' && receipt.ticket_ref.length > 0
      && receipt.ticket_ref !== `AMA-PR-${record.prNumber}`;
    // The operator's broader recovery contract requires its ticket-wide proof.
    // Empty keys cannot bypass a failed supplemental read, and a terminal but
    // unidentified/multiply identified receipt is never negative evidence.
    const keyedAbsenceAllowed = !options.operatorSettlement || (deadlinePassed && operatorAbsence
      && (rows == null || rows.length === 0 || foreignReceipt));
    const misattributedLease = options.operatorSettlement && operatorAbsence && promotedLease
      && record.launchRequestId === lease.lrqId && receipt?.launch_request_id === lease.lrqId
      && foreignReceipt;
    if (misattributedLease) evidence = { ...evidence, misattributedLeaseLaunchRequestId: lease.lrqId };
    let budgetUnreadable = false;
    const recoverableReceipt = !foreignLease && matchingReceipt
      && (!lease?.lrqId || lease.lrqId === receipt.launch_request_id) && !settledNoLaunch;
    if (options.operatorSettlement && recoverableReceipt && !isTerminalLaunchRequestStatus(receipt)) {
      return { status: 'held', reason: 'closer-receipt-exists', evidence };
    }
    if (options.operatorSettlement && recoverableReceipt
      && receipt.ticket_ref !== `AMA-PR-${record.prNumber}` && !legacyReceipt) {
      return { status: 'held', reason: 'legacy-receipt-proof-unavailable', evidence };
    }
    if (options.operatorSettlement && recoverableReceipt && !options.dryRun) {
      options.beforeSettlement?.({ ...record, preReceiptReconciliation: { query: evidence } });
    }
    if (recoverableReceipt && !options.dryRun && String(record.workerClass).startsWith('hammer')) {
      // Charge before receipt persistence, keyed across a crash on either side.
      try {
        recordHammerRetryDispatch(rootDir, record, { jobKey: record.reviewedSha || record.headSha,
          headSha: record.targetRemediationSha || record.headSha,
          dispatchKey: record.dispatchIdempotencyKey, launchRequestId: receipt.launch_request_id, preserveSuppression: true, now });
      } catch { budgetUnreadable = true; }
    }
    // Canonical receipt recovery is local evidence, independent of GitHub
    // availability. Unreadable PR state still cannot authorize absence or paging.
    if ((!recoverableReceipt || budgetUnreadable)
      && !(pr?.isOpen === true || String(pr?.prState || pr?.state || '').toUpperCase() === 'OPEN')) {
      return { status: 'held', reason: 'pr-state-unreadable' };
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
        preReceiptReconciliation: { status, observedAt: now, query: evidence } };
    } else if (!foreignLease && ![processes?.watcher.status, processes?.submitter.status, processes?.key.status].includes('live') && ((legacy && rows?.length === 0 && Number.isFinite(started))
      || (!legacy && keyedAbsenceAllowed && (!promotedLease || misattributedLease) && deadlinePassed
        && (rows?.length === 0 || operatorAbsence))
      || (!legacy && keyedAbsenceAllowed && deadSubmitter && rows?.length === 0)
      || (!legacy && keyedAbsenceAllowed && matchingLease && (localDead || settledNoLaunch)
        && record.dispatchPhase === 'prepared' && rows?.length === 0))) {
      status = 'no-launch';
      const reason = legacy ? 'legacy-no-launch-proven' : operatorAbsence ? 'closer-ticket-no-launch-proven'
        : deadlinePassed ? 'keyed-no-launch-proven' : deadSubmitter ? 'dead-submitter-no-launch-proven' : 'interrupted-before-submission';
      next = { ...record, state: 'no-dispatch', reason,
        retryCount: Math.max(0, Number(record.retryCount || 0) - 1),
        launchRequestId: null, dispatchId: null,
        preReceiptReconciliation: { status, reason, observedAt: now, query: evidence,
          ...(processes ? { processes } : {}) } };
      if (!options.dryRun) {
        options.beforeSettlement?.(next);
        if (misattributedLease) {
          // This lease carries the very foreign receipt proven above. Remove
          // only that unchanged local attribution; never act on its worker.
          if (!deleteAmaCloserLeaseIfCurrent(rootDir, lease)) {
            return { status: 'held', reason: 'lease-mutation-raced', evidence };
          }
        } else if (lease) {
          try { updateAmaCloserLease({ rootDir, ...leaseIdentity, expectedLease: lease,
            status: 'terminal', terminalOutcome: 'deferred', now }); }
          catch (error) {
            if (!['EBUSY', 'ESTALE'].includes(error.code)) throw error;
            return { status: 'held', reason: 'lease-mutation-raced', evidence };
          }
        }
      }
    } else {
      status = 'unknown';
      const diagnosticStatus = Date.parse(now) >= Date.parse(deadlineAt) ? 'inspection-required' : 'unknown';
      const reason = foreignLease ? 'lease-ownership-unresolved'
        : budgetUnreadable ? 'receipt-budget-unreadable'
        : legacy ? (!rows ? 'legacy-intent-without-key' : rows.length
          ? 'legacy-launch-in-range' : 'legacy-intent-without-key')
        : !rows ? 'receipt-lookup-unreadable' : rows.length ? 'receipt-identity-ambiguous' : 'submission-absence-unproven';
      next = { ...record, preReceiptReconciliation: { status: diagnosticStatus,
        firstObservedAt, deadlineAt, observedAt: now, reason,
        ...(processes ? { processes } : {}),
        ...(evidence ? { query: evidence } : {}),
        ...(prior?.alertedAt ? { alertedAt: prior.alertedAt } : {}) } };
      // Bounded diagnostics: no launch timestamp refresh, no unbounded history,
      // no polling write/log storm. Only successful ledger proof clears ownership.
      if (prior?.status === diagnosticStatus && prior?.reason === reason && same(prior?.query, evidence)
        && same(prior?.processes, processes || undefined)
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
      if (next.reason === 'dead-submitter-no-launch-proven') {
        options.logger?.warn?.(JSON.stringify({ event: 'ama_closer.pre_receipt_dead_submitter_reclaimed',
          repo: record.repo, prNumber: record.prNumber, headSha: record.headSha,
          dispatchIdempotencyKey: record.dispatchIdempotencyKey, processes, query: evidence }));
      }
      if (record.preReceiptReconciliation?.status !== next.preReceiptReconciliation.status
        || record.preReceiptReconciliation?.reason !== next.preReceiptReconciliation.reason
        || !same(record.preReceiptReconciliation?.query, next.preReceiptReconciliation.query)) {
        options.logger?.warn?.(JSON.stringify({ event: 'ama_closer.pre_receipt_reconciled',
          repo: record.repo, prNumber: record.prNumber, headSha: record.headSha,
          ...next.preReceiptReconciliation }));
      }
    }
    let reconciledRecord = next;
    if (status === 'receipt-recovered' && isTerminalLaunchRequestStatus(receipt) && !options.dryRun) {
      // The ordinary observer owns retry traversal, merge proof, success grace
      // and lease outcomes. It takes the intent lock itself, after persistence.
      release();
      const { reconcileAmaCloserLeaseAsync } = await import('./dispatch-closer.mjs');
      const observerOptions = Object.fromEntries(Object.entries({
        env: options.env, signal: options.signal, logger: options.logger,
        cleanupScratchImpl: options.cleanupScratchImpl,
        readLaunchRequestStatusImpl: options.readLaunchRequestStatusImpl,
        readMergedSignalImpl: options.readMergedSignalImpl,
        readBuildCompletionSignalForPrImpl: options.readBuildCompletionSignalForPrImpl,
        readBuildCompletionProducerEvidenceImpl: options.readBuildCompletionProducerEvidenceImpl,
        // The intent PR reader has a different input and output contract.
        readPullRequestStateImpl: options.readCloserPullRequestStateImpl,
      }).filter(([, value]) => value !== undefined));
      await reconcileAmaCloserLeaseAsync({ ...observerOptions, rootDir, repo: record.repo,
        hqRoot: options.hqRoot || record.hqRoot || resolveHqRoot(options.env),
        prNumber: record.prNumber, probedLaunchRequestId: receipt.launch_request_id, now });
      reconciledRecord = readAmaCloserDispatchRecord(rootDir, identity) || next;
    }
    return { status, changed: next !== record, record: reconciledRecord,
      ...(evidence ? { evidence } : {}) };
  } finally { release(); }
}
