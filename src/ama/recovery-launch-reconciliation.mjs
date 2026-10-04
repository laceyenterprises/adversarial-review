// AMAFIND-01 / AMACAP-01 seam: recover phantom ownership using the existing
// closer liveness predicates. Never reclaim on age alone or a failed ledger read.
import { readFileSync } from 'node:fs';
import { writeFileAtomic } from '../atomic-write.mjs';
import { readLatestWorkerRunStatusFromLedger } from '../session-ledger-read-adapter.mjs';
import { readAmaCloserLease, updateAmaCloserLease } from './closer-lease.mjs';

const TERMINAL = new Set(['succeeded', 'completed', 'failed', 'cancelled', 'canceled', 'superseded']);

export async function reconcileRecoveryLaunches({
  rootDir, logger = console, env = process.env,
  readStatusImpl = readLatestWorkerRunStatusFromLedger,
  listActiveImpl = null, isPhantomImpl = null,
}) {
  if (!listActiveImpl || !isPhantomImpl) {
    const closer = await import('./dispatch-closer.mjs');
    listActiveImpl ||= closer.listActiveAmaCloserDispatches;
    isPhantomImpl ||= closer.isPhantomActiveWorkerRun;
  }
  let reclaimed = 0;
  let active = 0;
  let uncertain = 0;
  for (const record of listActiveImpl(rootDir, { logger })) {
    const launchRequestId = record.launchRequestId || record.dispatchId;
    if (!launchRequestId) { uncertain += 1; continue; }
    let probe;
    try { probe = await readStatusImpl({ launchRequestId, rootDir, env }); }
    catch (err) {
      uncertain += 1;
      logger.warn?.(`[ama-recovery] launch lookup failed: ${err?.message || err}`);
      continue;
    }
    const status = String(probe?.row?.status || '').toLowerCase();
    const phantom = probe?.ok && isPhantomImpl(probe.row);
    if (!probe?.ok || !status) { uncertain += 1; continue; }
    if (!TERMINAL.has(status) && !phantom) { active += 1; continue; }
    // A concurrently replaced record belongs to a new launch. Do not touch it.
    const current = JSON.parse(readFileSync(record.dispatchPath, 'utf8'));
    if ((current.launchRequestId || current.dispatchId) !== launchRequestId) { active += 1; continue; }
    const identity = { repo: record.repo, prNumber: record.prNumber, headSha: record.headSha };
    const lease = readAmaCloserLease(rootDir, identity);
    if (lease && lease.status !== 'terminal' && (!lease.lrqId || lease.lrqId === launchRequestId)) {
      updateAmaCloserLease({ rootDir, ...identity, status: 'terminal',
        terminalOutcome: phantom || !['succeeded', 'completed'].includes(status) ? 'failed-without-merge' : 'succeeded' });
    }
    writeFileAtomic(record.dispatchPath, `${JSON.stringify({ ...current,
      lastObservedStatus: phantom ? 'failed' : status,
      lastObservedAt: new Date().toISOString(),
      ...(phantom ? { lastError: 'phantom-active-worker-run' } : {}),
    }, null, 2)}\n`);
    reclaimed += 1;
    logger.log?.(JSON.stringify({ event: 'ama.automated_recovery.launch_reclaimed',
      repo: record.repo, pr: record.prNumber, head: record.headSha, launchRequestId, status, phantom }));
  }
  return { reclaimed, active, uncertain };
}
