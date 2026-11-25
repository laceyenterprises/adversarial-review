import fsExt from 'fs-ext';
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { opendir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { writeFileAtomic } from '../atomic-write.mjs';
import { readLaunchRequestStatusFromLedgerAsync } from '../session-ledger-read-adapter.mjs';
import { isCurrentAmaCloserLease, readAmaCloserLease } from './closer-lease.mjs';
import { launchRequestInFlight } from './launch-request-status.mjs';
import { observeClosureWait } from './closure-wait.mjs';
import { readCloserInconclusiveRetries } from './closer-inconclusive-retry.mjs';
import { DEFERRED_SOURCE_HOLD, continueDeferredSourceCustody, deferredProcessInspectionUnavailable,
  deferredSourceNeedsDecision, deferredSourceNotice, deferredSourcePublishedCiAuthoritative,
  readDeferredSourceHold } from './deferred-source-custody.mjs';

const SUCCESSOR_DEADLINE_MS = 30 * 60_000;
const DEADLINE_PROBE_BACKOFF_MS = 5 * 60_000;
const RETIREMENT_PROBE_INTERVAL_MS = 24 * 60 * 60_000;
const RETIRED_TTL_MS = 7 * 24 * 60 * 60_000;
const waitClass = 'closer-successor';

export const closerSuccessorPath = (rootDir, { repo, prNumber, headSha }) => join(rootDir, 'data', 'closer-successors',
  `${createHash('sha256').update(`${repo.toLowerCase()}#${Number(prNumber)}@${String(headSha).toLowerCase()}`).digest('hex')}.json`);
export function readCloserSuccessor(rootDir, identity) {
  try { return JSON.parse(readFileSync(closerSuccessorPath(rootDir, identity), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Pruning can unlink a lock while another process has already opened it.
// Only enter the critical section on an inode still reachable by new openers.
function lockReceipt(path) {
  const fd = openSync(`${path}.lock`, 'a', 0o640);
  try {
    fsExt.flockSync(fd, 'exnb');
    if (fstatSync(fd).nlink === 0) {
      throw Object.assign(new Error('receipt lock was pruned'), { code: 'EAGAIN' });
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

export async function observeDeferredSourceDecision({ rootDir, hqRoot, repo, prNumber, headSha, now,
  requiredContexts = [], observeWaitImpl = observeClosureWait, pageImpl, logger = console }) {
  const identity = { repo, prNumber, headSha };
  let hold = readDeferredSourceHold(hqRoot, identity, { includeContinued: true });
  const inspectionUnavailable = deferredProcessInspectionUnavailable(hold);
  // HAMCIAUTH-01: a published head whose UNKNOWN defers to CI resumes through
  // the ordinary closer re-drive; exact-head CI decides, not an operator.
  const publishedHead = hold && !hold.continuedAt
    && deferredSourcePublishedCiAuthoritative(hold, { liveHead: headSha, requiredContexts }) ? hold.sourceHead : undefined;
  if (hold && (publishedHead || !deferredSourceNeedsDecision(hold, inspectionUnavailable))) {
    if (!hold.continuedAt) {
      try { if (continueDeferredSourceCustody(hold, { publishedHead, waitMs: 0 })) return null; }
      catch { /* Retry continuation on the next watcher pass. */ }
      return { status: DEFERRED_SOURCE_HOLD, reason: DEFERRED_SOURCE_HOLD, recoveryWait: true };
    }
    return null;
  }
  if (!hold) {
    const retries = readCloserInconclusiveRetries(rootDir, identity);
    const entry = retries.heads[headSha];
    // Legacy deferrals alone do not prove unpublished source or unsafe cleanup.
    // New observations explicitly record custody when those facts are known.
    hold = entry?.launches?.findLast(launch => launch?.reason === 'canonical-validation-deferred'
      && launch.custodyRequired === true);
  }
  if (!hold) return null;
  try {
    await observeWaitImpl({ rootDir, ...identity, reason: deferredSourceNotice(hold, inspectionUnavailable),
      waitClass: DEFERRED_SOURCE_HOLD, immediate: true, refreshOnReasonChange: true, now: Date.parse(now), pageImpl });
  } catch (error) {
    logger?.warn?.(`[ama-closer] deferred source decision delivery failed for ${repo}#${prNumber}: ${error.message}`);
  }
  return { status: DEFERRED_SOURCE_HOLD, reason: DEFERRED_SOURCE_HOLD, needsOperator: true,
    launchRequestId: hold.launchRequestId, custodyPath: hold.path };
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
  let fd;
  try { fd = lockReceipt(path); }
  catch (error) {
    if (['EAGAIN', 'EWOULDBLOCK'].includes(error.code)) return readCloserSuccessor(rootDir, identity);
    throw error;
  }
  try {
    const current = readCloserSuccessor(rootDir, identity);
    // Cleanup may remove the receipt before we acquire its persistent lock.
    if (!current) {
      writeFileAtomic(path, `${JSON.stringify(record)}\n`);
      return record;
    }
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

export async function settleCloserSuccessor({ rootDir, hqRoot, repo, prNumber, headSha, enabled = true,
  admitted = true, allowHammerFallback = false, now = new Date().toISOString(), riskClass, handoffImpl,
  requiredContexts = [], observeWaitImpl = observeClosureWait }) {
  headSha = String(headSha).toLowerCase();
  const identity = { repo, prNumber, headSha };
  const path = closerSuccessorPath(rootDir, identity);
  const initial = readCloserSuccessor(rootDir, identity);
  if (!initial) return null;
  let fd;
  try { fd = lockReceipt(path); }
  catch (error) { if (['EAGAIN', 'EWOULDBLOCK'].includes(error.code)) return { status: 'successor-pending' }; throw error; }
  try {
    let record = readCloserSuccessor(rootDir, identity);
    if (!record) return { status: 'successor-pending' };
    if (record.status === 'successor-enrolled') return record;
    const held = await observeDeferredSourceDecision({ rootDir, hqRoot, ...identity, now, requiredContexts, observeWaitImpl });
    if (held) return held;
    // Fresh admission can revisit a retired head if the PR was reopened or moved back.
    if (record.retiredAt) {
      delete record.retiredAt;
      delete record.escalatedAt;
      delete record.lastProbedAt;
      writeFileAtomic(path, `${JSON.stringify(record)}\n`);
    }
    if (enabled && admitted && allowHammerFallback && record.fallbackAt) return { ...record, action: 'fallback' };
    let result;
    try {
      const handoff = handoffImpl || (await import('./final-fix-all.mjs')).handoffFinalFixAll;
      result = !enabled ? { reason: 'successor-path-disabled' } : !admitted ? { reason: 'successor-admission-refused' }
        : await handoff({ rootDir, repo, prNumber, headSha, reviewBody: record.reviewBody, now, riskClass });
    } catch (error) { result = { reason: 'successor-dispatch-failed', detail: String(error?.message ?? error).slice(0, 300) }; }
    if (allowHammerFallback && result?.action === 'fallback') {
      record.fallbackAt ||= now;
      writeFileAtomic(path, `${JSON.stringify(record)}\n`);
      return { ...record, action: 'fallback' };
    }
    delete record.fallbackAt;
    record = { ...record, updatedAt: now, status: result?.remediation?.jobId ? 'successor-enrolled' : 'needs-closer',
      successorJobId: result?.remediation?.jobId || null, reason: result?.reason || result?.action || 'successor-dispatch-refused' };
    writeFileAtomic(path, `${JSON.stringify(record)}\n`);
    if (record.status === 'needs-closer' && !record.escalatedAt) {
      await observeWaitImpl({ rootDir, repo, prNumber, headSha, reason: `${record.status}:${record.reason}`,
        now: Date.parse(now), immediate: true, waitClass });
      record.escalatedAt = now;
      writeFileAtomic(path, `${JSON.stringify(record)}\n`);
    }
    return record;
  } finally { closeSync(fd); }
}

async function hasLiveCloser(rootDir, identity) {
  const lease = readAmaCloserLease(rootDir, identity);
  if (!lease) return false;
  if (lease.status === 'pending' || (lease.status === 'dispatched' && !lease.lrqId)) return null;
  if (lease.status !== 'dispatched') return false;
  const probe = await readLaunchRequestStatusFromLedgerAsync({ rootDir, launchRequestId: lease.lrqId,
    includeRetryChain: true });
  return isCurrentAmaCloserLease(rootDir, lease) ? launchRequestInFlight(probe) : null;
}

// Scan independently of dispatch selection. An old receipt only warrants a
// page if GitHub still confirms the same open head.
export function createCloserSuccessorDeadlineSweep({ rootDir, readLive, now = Date.now,
  hasLiveCloserImpl = hasLiveCloser, observeWaitImpl = observeClosureWait, logger = console }) {
  const directory = join(rootDir, 'data', 'closer-successors');
  let cursor;
  let running = false;
  let stopped = false;
  const owesDeadline = record => record.status !== 'successor-enrolled' && !record.fallbackAt && !record.escalatedAt;
  const probeDue = (record, observedAt) => {
    if (record?.schemaVersion !== 1 || record.retiredAt
      || !(observedAt - Date.parse(record.requestedAt) >= SUCCESSOR_DEADLINE_MS)) return false;
    const lastProbe = Math.max(Date.parse(record.lastProbedAt) || 0, Date.parse(record.escalatedAt) || 0);
    return observedAt - lastProbe >= (owesDeadline(record) ? DEADLINE_PROBE_BACKOFF_MS : RETIREMENT_PROBE_INTERVAL_MS);
  };
  const expired = (record, observedAt) => record?.schemaVersion === 1
    && observedAt - Date.parse(record.retiredAt) >= RETIRED_TTL_MS;

  async function closeCursor() {
    const current = cursor;
    cursor = null;
    await current?.close();
  }

  async function check(entry) {
    const path = join(directory, entry.name);
    const receipt = JSON.parse(await readFile(path, 'utf8'));
    if ((!probeDue(receipt, now()) && !expired(receipt, now())) || !/^[\w.-]+\/[\w.-]+$/.test(receipt.repo)
      || !Number.isSafeInteger(receipt.prNumber) || receipt.prNumber < 1
      || !/^[0-9a-f]{40}$/i.test(receipt.headSha)
      || closerSuccessorPath(rootDir, receipt) !== path) return false;
    const { repo, prNumber, headSha } = receipt;
    if (expired(receipt, now())) {
      const fd = lockReceipt(path);
      try {
        if (expired(readCloserSuccessor(rootDir, receipt), now())) {
          unlinkSync(path);
          unlinkSync(`${path}.lock`);
        }
      } finally { closeSync(fd); }
      return false;
    }
    let live;
    try {
      live = await readLive(repo, prNumber);
    } catch (error) {
      logger.warn?.(`[closer-successor] live PR read failed for ${entry.name}: ${error.message}`);
    }
    if (stopped) return true;
    const liveHead = /^[0-9a-f]{40}$/i.test(live?.headRefOid) ? live.headRefOid.toLowerCase() : null;
    const retire = ['closed', 'merged'].includes(live?.state) || live?.mergedAt || live?.closedAt
      || (live?.state === 'open' && liveHead && liveHead !== headSha);
    let closerLive = null;
    if (!retire && owesDeadline(receipt) && live?.state === 'open' && liveHead === headSha) {
      try {
        closerLive = await hasLiveCloserImpl(rootDir, { repo, prNumber, headSha });
      } catch (error) {
        logger.warn?.(`[closer-successor] closer liveness read failed for ${entry.name}: ${error.message}`);
      }
    }
    if (stopped) return true;
    const fd = lockReceipt(path);
    try {
      const current = readCloserSuccessor(rootDir, receipt);
      const observedAt = now();
      if (current?.requestedAt !== receipt.requestedAt || !probeDue(current, observedAt)) return true;
      const timestamp = new Date(observedAt).toISOString();
      if (retire) {
        current.retiredAt = timestamp;
      } else if (closerLive === false && owesDeadline(current)) {
        await observeWaitImpl({ rootDir, repo, prNumber, headSha, now: observedAt,
          reason: 'closer-successor-overdue', immediate: true, waitClass });
        current.escalatedAt = timestamp;
      } else if (!owesDeadline(current) || owesDeadline(receipt)) {
        // A retirement-only probe cannot defer a newly reinstated deadline.
        current.lastProbedAt = timestamp;
      } else {
        return true;
      }
      writeFileAtomic(path, `${JSON.stringify(current)}\n`);
    } finally { closeSync(fd); }
    return true;
  }

  return {
    async tick() {
      if (running || stopped) return;
      running = true;
      try {
        cursor ||= await opendir(directory);
        for (let scanned = 0, probes = 0; !stopped && scanned < 100 && probes < 4; scanned++) {
          const entry = await cursor.read();
          if (!entry) { await closeCursor(); break; }
          if (!entry.isFile() || !/^[0-9a-f]{64}\.json(?:\.lock)?$/.test(entry.name)) continue;
          try {
            if (entry.name.endsWith('.lock')) {
              const path = join(directory, entry.name.slice(0, -5));
              try { await stat(path); }
              catch (error) {
                if (error.code !== 'ENOENT') throw error;
                const fd = lockReceipt(path);
                try {
                  if (!statSync(path, { throwIfNoEntry: false })) unlinkSync(`${path}.lock`);
                } finally { closeSync(fd); }
              }
            } else if (await check(entry)) probes++;
          }
          catch (error) {
            probes++;
            if (!['ENOENT', 'EAGAIN', 'EWOULDBLOCK'].includes(error.code)) {
              logger.warn?.(`[closer-successor] deadline check failed for ${entry.name}: ${error.message}`);
            }
          }
        }
      } catch (error) {
        if (error.code !== 'ENOENT') logger.warn?.(`[closer-successor] deadline scan failed: ${error.message}`);
        await closeCursor().catch(() => {});
      } finally {
        running = false;
        if (stopped) await closeCursor().catch(() => {});
      }
    },
    async stop() {
      stopped = true;
      if (!running) await closeCursor().catch(() => {});
    },
  };
}
