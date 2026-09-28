import { accessSync, constants } from 'node:fs';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { findLiveAmaCloserLease, updateAmaCloserLease } from './closer-lease.mjs';
import { updateAmaCloserDispatchRecord } from './dispatch-closer.mjs';

const execFileAsync = promisify(execFile);

function alreadyTerminalCancel(response) {
  const detail = String(response?.stdout || response?.message || response || '');
  try {
    const parsed = JSON.parse(detail);
    if (parsed?.ok === false) {
      return /already (terminal|terminated|cancelled|canceled)/i.test(String(parsed.reason || ''))
        || /^(failed|succeeded|cancelled|canceled|superseded)$/.test(String(parsed.currentStatus || ''));
    }
  } catch {
    // CLI errors can be plain text; classify the same terminal words there.
  }
  return /already (terminal|terminated|cancelled|canceled)/i.test(detail);
}

/** Cancel live closer ownership when GitHub's live PR state becomes terminal. */
export async function cancelCloserForTerminalPr({
  rootDir, repo, prNumber, transition, hqPath = process.env.HQ_BIN || '/Users/airlock/.local/bin/hq',
  hqRoot = process.env.HQ_ROOT || '/Users/airlock/agent-os-hq',
  execFileImpl = execFileAsync, accessImpl = accessSync,
  logger = console, now = new Date().toISOString(),
} = {}) {
  const held = findLiveAmaCloserLease(rootDir, { repo, prNumber });
  if (!held) return { cancelled: false, reason: 'no-live-closer' };
  const { lease, headSha } = held;
  if (lease.lrqId) {
    try {
      accessImpl(hqPath, constants.X_OK);
      const response = await execFileImpl(hqPath, ['dispatch', 'cancel', lease.lrqId], {
        env: { ...process.env, HQ_ROOT: hqRoot },
      });
      if (response?.stdout) {
        try {
          const parsed = JSON.parse(String(response.stdout));
          if (parsed?.ok === false && !alreadyTerminalCancel(response)) {
            throw new Error(`HQ cancel refused: ${parsed.reason || 'unknown reason'}`);
          }
        } catch (err) {
          if (err?.message?.startsWith('HQ cancel refused:')) throw err;
        }
      }
    } catch (err) {
      if (alreadyTerminalCancel(err?.stdout || err)) {
        logger.log?.(`[ama-closer] ${repo}#${prNumber} lrq=${lease.lrqId} already terminal at HQ`);
      } else {
        logger.warn?.(`[ama-closer] cancel unavailable for ${repo}#${prNumber} lrq=${lease.lrqId}: ${err?.message || err}`);
        return { cancelled: false, reason: 'cancel-unavailable', error: err };
      }
    }
  }
  const outcome = transition === 'merged' ? 'pr-merged-externally' : 'pr-closed-externally';
  updateAmaCloserLease({ rootDir, repo, prNumber, headSha, status: 'terminal', terminalOutcome: outcome, now });
  updateAmaCloserDispatchRecord(rootDir, { repo, prNumber, headSha }, (record) => record && ({
    ...record,
    outcome: transition === 'merged' ? 'no-merge:pr-merged-externally' : 'no-merge:pr-closed-externally',
    lastObservedStatus: 'cancelled',
    lastObservedAt: now,
  }));
  logger.log?.(`[ama-closer] ${repo}#${prNumber} ${outcome}; cancelled lrq=${lease.lrqId || 'none'}`);
  return { cancelled: Boolean(lease.lrqId), outcome };
}
