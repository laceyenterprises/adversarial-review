import { accessSync, constants } from 'node:fs';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { findLiveAmaCloserLease, updateAmaCloserLease } from './closer-lease.mjs';

const execFileAsync = promisify(execFile);

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
      await execFileImpl(hqPath, ['dispatch', 'cancel', lease.lrqId], { env: { ...process.env, HQ_ROOT: hqRoot } });
    } catch (err) {
      logger.warn?.(`[ama-closer] cancel unavailable for ${repo}#${prNumber} lrq=${lease.lrqId}: ${err?.message || err}`);
      return { cancelled: false, reason: 'cancel-unavailable', error: err };
    }
  }
  const outcome = transition === 'merged' ? 'pr-merged-externally' : 'pr-closed-externally';
  updateAmaCloserLease({ rootDir, repo, prNumber, headSha, status: 'terminal', terminalOutcome: outcome, now });
  logger.log?.(`[ama-closer] ${repo}#${prNumber} ${outcome}; cancelled lrq=${lease.lrqId || 'none'}`);
  return { cancelled: Boolean(lease.lrqId), outcome };
}
