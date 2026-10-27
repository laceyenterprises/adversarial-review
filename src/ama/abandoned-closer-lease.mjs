import { isPreReceiptIntent } from './dispatch-record-read.mjs';
import { abandonedAmaCloserLeaseOutcome, readAmaCloserLease, updateAmaCloserLease } from './closer-lease.mjs';
import { readAmaCloserDispatchRecord } from './dispatch-closer.mjs';
import { reconcileAmaCloserLeaseIntent, tryAcquireCloserIntentLock } from './pre-receipt-intent.mjs';

export async function reconcileAndAbandonAmaCloserLease(rootDir, lease, { reconcileDispatched, ...options } = {}) {
  if (!lease) return null;
  await reconcileAmaCloserLeaseIntent(rootDir, lease, options);
  let current = readAmaCloserLease(rootDir, lease);
  if (current?.status === 'dispatched' && current.lrqId) {
    await reconcileDispatched(current);
    current = readAmaCloserLease(rootDir, current);
  }
  return await abandonAmaCloserLease(rootDir, current, { ...options, reconcileIntent: false }) || current;
}

// Keep the terminal receipt until ordinary dispatch reclaims it. Serialize with
// submissions as well as lease mutations: a launch-less file alone cannot prove
// that an interrupted keyed submission never reached the launch service.
export async function abandonAmaCloserLease(rootDir, lease, { logger = console, reconcileIntent = true, ...options } = {}) {
  if (!lease) return null;
  const recovery = reconcileIntent
    ? await reconcileAmaCloserLeaseIntent(rootDir, lease, { logger, ...options }) : { status: 'unchanged' };
  if (recovery.status === 'no-launch') {
    const current = readAmaCloserLease(rootDir, lease);
    return current?.status === 'terminal' && current.terminalOutcome === 'deferred'
      && current.acquiredAt === lease.acquiredAt ? current : null;
  }
  if (recovery.status !== 'unchanged') return null;
  const outcome = abandonedAmaCloserLeaseOutcome(lease, options);
  if (!outcome) return null;
  const release = tryAcquireCloserIntentLock(rootDir, lease);
  if (!release) return null;
  try {
    const record = readAmaCloserDispatchRecord(rootDir, { ...lease,
      headSha: lease.rekeyedFromHeadSha || lease.headSha });
    if (isPreReceiptIntent(record)) return null;
    const expectedLease = { ...lease };
    delete expectedLease._path;
    const result = updateAmaCloserLease({ rootDir, ...lease, expectedLease,
      status: 'terminal', terminalOutcome: outcome,
      now: new Date(options.now ?? Date.now()).toISOString() });
    logger?.warn?.(`[reaper] released abandoned closer lease repo=${lease.repo} pr=${lease.prNumber} outcome=${outcome}`);
    return result.lease;
  } catch (error) {
    if (['EBUSY', 'ESTALE'].includes(error.code)) return null;
    throw error;
  } finally { release(); }
}
