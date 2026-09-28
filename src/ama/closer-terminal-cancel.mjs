import { accessSync, constants } from 'node:fs';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { findLiveAmaCloserLease, updateAmaCloserLease } from './closer-lease.mjs';
import { updateAmaCloserDispatchRecord } from './dispatch-closer.mjs';
import { execHqDispatchCancel } from '../merge-agent-hq-exec.mjs';
import { resolveHqBin } from '../remediation-hq-dispatch.mjs';
import { resolveHqRoot } from '../remediation-reply-paths.mjs';

const execFileAsync = promisify(execFile);
const HQ_CANCEL_TIMEOUT_MS = 10_000;

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
  execFileImpl = execFileAsync, accessImpl = accessSync,
  retryDelaysMs, logger = console, now = new Date().toISOString(),
} = {}) {
  const held = findLiveAmaCloserLease(rootDir, { repo, prNumber });
  if (!held) return { cancelled: false, reason: 'no-live-closer' };
  const { lease, headSha } = held;

  if (transition === 'merged') {
    const mergedHead = String(live?.headRefOid || '');
    const ownedHeads = [headSha, ...(lease.supersededHeads || []), lease.rekeyedFromHeadSha];
    if (!mergedHead || !ownedHeads.includes(mergedHead)) {
      // The stale-window reaper decides foreign merges after the closer has had
      // time to finish its post-merge audit, signal, lease release and comment.
      return { cancelled: false, reason: 'merged-await-stale-reaper' };
    }
    updateAmaCloserLease({ rootDir, repo, prNumber, headSha, status: 'terminal', terminalOutcome: 'succeeded', now });
    updateAmaCloserDispatchRecord(rootDir, { repo, prNumber, headSha }, (record) => record && ({
      ...record, outcome: 'succeeded', lastObservedStatus: 'succeeded', lastObservedAt: now,
    }));
    return { cancelled: false, outcome: 'succeeded' };
  }
  if (transition !== 'closed') return { cancelled: false, reason: 'not-terminal' };

  if (!lease.lrqId) {
    return { cancelled: false, reason: 'cancel-unavailable', error: new Error('closer launch request id pending') };
  }
  let observedStatus = null;
  if (lease.lrqId) {
    try {
      if (isAbsolute(hqPath)) accessImpl(hqPath, constants.X_OK);
      const resolvedRoot = hqRoot || resolveHqRoot(process.env);
      const response = await execHqDispatchCancel({
        hqPath, launchRequestId: lease.lrqId,
        hqExecFileImpl: (bin, args, options) => execFileImpl(bin, args, {
          ...options, timeout: HQ_CANCEL_TIMEOUT_MS,
        }),
        env: { ...process.env, HQ_ROOT: resolvedRoot },
        retryDelaysMs,
      });
      let parsed = null;
      try { parsed = response?.stdout ? JSON.parse(String(response.stdout)) : null; } catch { /* Plain text success. */ }
      if (parsed?.ok === false && !cancelStatus(response)) {
        throw new Error(`HQ cancel refused: ${parsed.reason || 'unknown reason'}`);
      }
      observedStatus = cancelStatus(response) || 'cancelled';
    } catch (err) {
      // Only HQ's response can prove terminal state. An ENOENT from access or
      // exec means the binary is missing, not that the dispatch was cancelled.
      observedStatus = err?.stdout ? cancelStatus(err) : null;
      if (!observedStatus) {
        logger.warn?.(`[ama-closer] cancel unavailable for ${repo}#${prNumber} lrq=${lease.lrqId}: ${err?.message || err}`);
        return { cancelled: false, reason: 'cancel-unavailable', error: err };
      }
      logger.log?.(`[ama-closer] ${repo}#${prNumber} lrq=${lease.lrqId} already terminal at HQ`);
    }
  }
  updateAmaCloserLease({ rootDir, repo, prNumber, headSha, status: 'terminal', terminalOutcome: 'pr-closed-externally', now });
  updateAmaCloserDispatchRecord(rootDir, { repo, prNumber, headSha }, (record) => record && ({
    ...record, outcome: 'no-merge:pr-closed-externally',
    lastObservedStatus: observedStatus, lastObservedAt: now,
  }));
  logger.log?.(`[ama-closer] ${repo}#${prNumber} pr-closed-externally; cancelled lrq=${lease.lrqId || 'none'}`);
  return { cancelled: Boolean(lease.lrqId && observedStatus === 'cancelled'), outcome: 'pr-closed-externally' };
}
