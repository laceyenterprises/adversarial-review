import { accessSync, constants, readdirSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { isAbsolute, join, dirname } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { amaCloserPendingLeaseExpiryMs, deleteAmaCloserLease, findLiveAmaCloserLease, updateAmaCloserLease } from './closer-lease.mjs';
import { readAmaCloserDispatchRecord, updateAmaCloserDispatchRecord } from './dispatch-closer.mjs';
import { writeFileAtomic } from '../atomic-write.mjs';
import { deliverAlert } from '../alert-delivery.mjs';
import { execHqDispatchCancel } from '../merge-agent-hq-exec.mjs';
import { resolveHqBin } from '../remediation-hq-dispatch.mjs';
import { resolveHqRoot } from '../remediation-reply-paths.mjs';
import { fetchPullRequestHeadAndState } from '../github-api.mjs';
import { readAmaAuditEntry } from './audit.mjs';

const execFileAsync = promisify(execFile);
const HQ_CANCEL_TIMEOUT_MS = 10_000;
const CANCEL_RETRY_MS = 60_000;
const CANCEL_MAX_ATTEMPTS = 5;
const CANCEL_PER_TICK = 3;

function cancelQueuePath(rootDir, repo, prNumber) {
  return join(rootDir, 'data', 'ama-closer-cancels', `${repo.replace(/\//g, '__').replace(/[^A-Za-z0-9._-]/g, '-')}-pr-${Number(prNumber)}.json`);
}

function dispatchHeads(lease, headSha) {
  return [...new Set([headSha, lease.rekeyedFromHeadSha, ...(lease.supersededHeads || [])].filter(Boolean))];
}

function matchingDispatchRecord(rootDir, repo, prNumber, lease, headSha) {
  for (const candidateHead of dispatchHeads(lease, headSha)) {
    const record = readAmaCloserDispatchRecord(rootDir, { repo, prNumber, headSha: candidateHead });
    if (record && (!lease.lrqId || record.launchRequestId === lease.lrqId || candidateHead === headSha)) {
      return { record, headSha: candidateHead };
    }
  }
  return null;
}

/** Persist the close obligation before the PR leaves the open-row scan. */
export function queueCloserCancelForClosedPr({ rootDir, repo, prNumber, now = new Date().toISOString() }) {
  let held;
  try { held = findLiveAmaCloserLease(rootDir, { repo, prNumber }); }
  catch { held = true; } // Preserve the owed check when a lease file is corrupt.
  if (!held) return null;
  const path = cancelQueuePath(rootDir, repo, prNumber);
  let existing;
  try { existing = JSON.parse(readFileSync(path, 'utf8')); } catch (err) { if (err?.code !== 'ENOENT') throw err; }
  if (existing && (existing.state !== 'exhausted' || existing.targetHeadSha === held.headSha)) return existing;
  const record = { schemaVersion: 1, repo, prNumber, targetHeadSha: held.headSha, queuedAt: now, attempts: 0, lastAttemptAt: null, state: 'pending' };
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

/** Bounded, per-tick drain. Terminal failures remain visible and alert once. */
export async function retryPendingCloserCancels({ rootDir, now = new Date().toISOString(),
  cancelImpl = cancelCloserForTerminalPr, alertImpl = deliverAlert, logger = console,
  liveStateImpl = fetchPullRequestHeadAndState,
  retryMs = CANCEL_RETRY_MS, maxAttempts = CANCEL_MAX_ATTEMPTS, maxPerTick = CANCEL_PER_TICK,
} = {}) {
  const dir = join(rootDir, 'data', 'ama-closer-cancels');
  let names;
  try { names = readdirSync(dir).filter((name) => name.endsWith('.json')); }
  catch (err) { if (err?.code === 'ENOENT') return { attempted: 0 }; throw err; }
  let attempted = 0;
  for (const name of names) {
    if (attempted >= maxPerTick) break;
    const path = join(dir, name);
    let record;
    try { record = JSON.parse(readFileSync(path, 'utf8')); }
    catch (err) { logger.error?.(`[ama-closer] unreadable cancel obligation ${path}: ${err?.message || err}`); continue; }
    if (!record || typeof record !== 'object' || !record.repo || !record.prNumber) {
      logger.error?.(`[ama-closer] invalid cancel obligation ${path}`);
      continue;
    }
    if (record.state !== 'pending' && record.state !== 'exhausted') continue;
    // The queued CLOSED observation can be stale after a close/reopen. Never
    // cancel a worker or settle a lease without checking the live PR again.
    let live;
    try { live = await liveStateImpl(record.repo, record.prNumber); }
    catch (err) { logger.warn?.(`[ama-closer] live PR state unavailable for ${record.repo}#${record.prNumber}: ${err?.message || err}`); continue; }
    if (String(live?.state || '').toUpperCase() === 'OPEN' || String(live?.state || '').toUpperCase() === 'MERGED') {
      rmSync(path, { force: true });
      continue;
    }
    if (String(live?.state || '').toUpperCase() !== 'CLOSED') continue;
    if (record.state === 'exhausted' && !record.alerted) {
      attempted += 1;
      try {
        await alertImpl(`AMA closer cancel exhausted for ${record.repo}#${record.prNumber}: ${record.lastError}`);
        record.alerted = true;
        writeFileAtomic(path, `${JSON.stringify(record, null, 2)}\n`);
      } catch (err) { logger.error?.('[ama-closer] cancel alert delivery failed:', err?.message || err); }
      continue;
    }
    if (record.state !== 'pending' || (record.lastAttemptAt && Date.parse(now) - Date.parse(record.lastAttemptAt) < retryMs)) continue;
    attempted += 1;
    let result;
    try { result = await cancelImpl({ rootDir, repo: record.repo, prNumber: record.prNumber, transition: 'closed', now, logger, retryDelaysMs: [] }); }
    catch (err) { result = { reason: 'cancel-unavailable', error: err }; }
    if (result.reason === 'launch-pending') {
      record.lastAttemptAt = now;
      writeFileAtomic(path, `${JSON.stringify(record, null, 2)}\n`);
      continue;
    }
    if (result.reason !== 'cancel-unavailable') { rmSync(path, { force: true }); continue; }
    record.attempts += 1;
    record.lastAttemptAt = now;
    record.lastError = String(result.error?.message || result.reason).slice(0, 500);
    if (record.attempts >= maxAttempts) {
      record.state = 'exhausted';
      writeFileAtomic(path, `${JSON.stringify(record, null, 2)}\n`);
      logger.error?.(`[ama-closer] cancel exhausted for ${record.repo}#${record.prNumber}: ${record.lastError}`);
      try {
        await alertImpl(`AMA closer cancel exhausted for ${record.repo}#${record.prNumber}: ${record.lastError}`);
        record.alerted = true;
        writeFileAtomic(path, `${JSON.stringify(record, null, 2)}\n`);
      }
      catch (err) { logger.error?.('[ama-closer] cancel alert delivery failed:', err?.message || err); }
      continue;
    }
    writeFileAtomic(path, `${JSON.stringify(record, null, 2)}\n`);
  }
  return { attempted };
}

function cancelStatus(response) {
  const detail = String(response?.stdout || response?.message || response || '');
  let parsed;
  try { parsed = JSON.parse(detail); } catch { /* HQ can return plain text. */ }
  const status = String(parsed?.currentStatus || parsed?.status || '').toLowerCase();
  if (['failed', 'succeeded', 'cancelled', 'canceled', 'superseded'].includes(status)) return status;
  if (status) return null;
  if (/already (terminal|terminated|cancelled|canceled)/i.test(String(parsed?.reason || detail))) {
    const namedStatus = String(parsed?.reason || detail).match(/status[=: ]+(failed|succeeded|cancelled|canceled|superseded)/i);
    return namedStatus?.[1]?.toLowerCase() || 'terminal';
  }
  return null;
}

/** Settle a live closer when GitHub's live PR state becomes terminal. */
export async function cancelCloserForTerminalPr({
  rootDir, repo, prNumber, transition, live,
  hqPath = resolveHqBin(process.env), hqRoot = process.env.HQ_ROOT,
  readAuditImpl = readAmaAuditEntry,
  execFileImpl = execFileAsync, accessImpl = accessSync,
  retryDelaysMs, logger = console, now = new Date().toISOString(),
} = {}) {
  const held = findLiveAmaCloserLease(rootDir, { repo, prNumber });
  if (!held) return { cancelled: false, reason: 'no-live-closer' };
  const { lease, headSha } = held;
  const dispatch = matchingDispatchRecord(rootDir, repo, prNumber, lease, headSha);

  if (transition === 'merged') {
    const mergedHead = String(live?.headRefOid || '');
    const ownedHeads = [headSha, ...(lease.supersededHeads || []), lease.rekeyedFromHeadSha];
    if (!mergedHead || !ownedHeads.includes(mergedHead)) {
      // The stale-window reaper decides foreign merges after the closer has had
      // time to finish its post-merge audit, signal, lease release and comment.
      return { cancelled: false, reason: 'merged-await-stale-reaper' };
    }
    let resolvedRoot = hqRoot;
    if (!resolvedRoot) {
      try { resolvedRoot = resolveHqRoot(process.env); } catch { /* Standalone has no HQ audit. */ }
    }
    const audit = resolvedRoot ? readAuditImpl(resolvedRoot, repo, prNumber, mergedHead) : null;
    if (audit?.status !== 'succeeded') return { cancelled: false, reason: 'merged-await-stale-reaper' };
    if (dispatch) updateAmaCloserDispatchRecord(rootDir, { repo, prNumber, headSha: dispatch.headSha }, (record) => record && ({
      ...record, outcome: 'succeeded', lastObservedStatus: record.lastObservedStatus || null, lastObservedAt: now,
    }));
    updateAmaCloserLease({ rootDir, repo, prNumber, headSha, status: 'terminal', terminalOutcome: 'succeeded', now });
    return { cancelled: false, outcome: 'succeeded' };
  }
  if (transition !== 'closed') return { cancelled: false, reason: 'not-terminal' };

  const launchRequestId = lease.lrqId && lease.lrqId !== 'unknown'
    ? lease.lrqId : dispatch?.record?.launchRequestId || lease.lrqId;
  const pendingAgeMs = Date.parse(now) - Date.parse(lease.acquiredAt || lease.updatedAt);
  let observedStatus = null;
  if (!launchRequestId && lease.status === 'pending' && pendingAgeMs >= amaCloserPendingLeaseExpiryMs(lease.dispatchTimeoutMs)) {
    deleteAmaCloserLease(rootDir, { repo, prNumber, headSha });
    return { cancelled: false, outcome: 'pr-closed-externally', reason: 'orphaned-pending-lease-deleted' };
  } else if (!launchRequestId) {
    return { cancelled: false, reason: 'launch-pending' };
  } else if (launchRequestId === 'unknown') {
    observedStatus = 'not-found';
  }
  if (!observedStatus) {
    try {
      if (isAbsolute(hqPath)) accessImpl(hqPath, constants.X_OK);
      const resolvedRoot = hqRoot || resolveHqRoot(process.env);
      const response = await execHqDispatchCancel({
        hqPath, launchRequestId,
        hqExecFileImpl: (bin, args, options) => execFileImpl(bin, args, {
          ...options, timeout: HQ_CANCEL_TIMEOUT_MS,
        }),
        env: { ...process.env, HQ_ROOT: resolvedRoot },
        retryDelaysMs,
      });
      let parsed = null;
      try { parsed = response?.stdout ? JSON.parse(String(response.stdout)) : null; } catch { /* Plain text success. */ }
      if (parsed?.ok === false && /unknown dispatch_id/i.test(String(parsed.reason || ''))) {
        observedStatus = 'not-found';
      } else if (parsed?.ok === false && !cancelStatus(response)) {
        throw new Error(`HQ cancel refused: ${parsed.reason || 'unknown reason'}`);
      }
      observedStatus ||= cancelStatus(response) || 'cancelled';
    } catch (err) {
      // Only HQ's response can prove terminal state. An ENOENT from access or
      // exec means the binary is missing, not that the dispatch was cancelled.
      observedStatus = err?.stdout && /unknown dispatch_id/i.test(String(err.stdout))
        ? 'not-found' : err?.stdout ? cancelStatus(err) : null;
      if (!observedStatus) {
        logger.warn?.(`[ama-closer] cancel unavailable for ${repo}#${prNumber} lrq=${launchRequestId}: ${err?.message || err}`);
        return { cancelled: false, reason: 'cancel-unavailable', error: err };
      }
      logger.log?.(`[ama-closer] ${repo}#${prNumber} lrq=${launchRequestId} already terminal at HQ`);
    }
  }
  if (dispatch) updateAmaCloserDispatchRecord(rootDir, { repo, prNumber, headSha: dispatch.headSha }, (record) => record && ({
    ...record, outcome: 'no-merge:pr-closed-externally',
    lastObservedStatus: observedStatus, lastObservedAt: now,
  }));
  updateAmaCloserLease({ rootDir, repo, prNumber, headSha, status: 'terminal', terminalOutcome: 'pr-closed-externally', now });
  logger.log?.(`[ama-closer] ${repo}#${prNumber} pr-closed-externally; cancelled lrq=${launchRequestId || 'none'}`);
  return { cancelled: observedStatus === 'cancelled', outcome: 'pr-closed-externally' };
}
