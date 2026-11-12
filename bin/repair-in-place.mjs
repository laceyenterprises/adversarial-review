// Local dispatch boundary. PR lifecycle/branch ownership remain enforced by hq;
// this helper only reserves the exhausted PR's audited review episode.
import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { reserveRepairEpoch, pageRepairCap, observeRepairOwner } from '../src/repair-epochs.mjs';
import { readRepairFacts } from '../src/repair-facts.mjs';
import { tryAcquireCloserIntentLock } from '../src/ama/pre-receipt-intent.mjs';
import { readAmaCloserLease, abandonedAmaCloserLeaseOutcome } from '../src/ama/closer-lease.mjs';
import { readLaunchRequestStatusFromLedgerAsync } from '../src/session-ledger-read-adapter.mjs';
import { listFollowUpJobsInDir } from '../src/follow-up-jobs.mjs';
import { launchRequestOwned } from '../src/ama/launch-request-status.mjs';

export async function main(args) {
  const [rootDir, repo, prRaw, headSha, ownerKey, conflicting] = args;
  const prNumber = Number(prRaw);
  if (!rootDir || !repo?.includes('/') || !(prNumber > 0) || !ownerKey) throw new Error('invalid repair request');
  const db = new Database(resolve(rootDir, 'data/reviews.db'), { readonly: true, fileMustExist: true });
  let facts;
  try {
    const row = db.prepare('SELECT * FROM reviewed_prs WHERE repo=? AND pr_number=?').get(repo, prNumber);
    if (row && row.pr_state !== 'open') return { ok: true, epoch: null, reason: 'no-open-review-row' };
    if (!row && conflicting !== 'true') return { ok: true, epoch: null, reason: 'no-open-review-row' };
    facts = readRepairFacts({ rootDir, db, repo, prNumber, headSha, row, conflicting: conflicting === 'true' });
  } finally { db.close(); }
  if (!facts.cause) return { ok: true, epoch: null, reason: 'budget-available' };
  const release = tryAcquireCloserIntentLock(rootDir, { repo, prNumber });
  if (!release) return { ok: false, reason: 'closer-submission-owned' };
  let result;
  try {
    const queued = ['pending', 'inProgress'].flatMap(status =>
      listFollowUpJobsInDir(rootDir, status, { repo, prNumber, caseInsensitiveRepo: true }));
    if (queued.length) return { ok: false, reason: 'remediation-owned', jobId: queued[0].job.jobId };
    const lease = readAmaCloserLease(rootDir, { repo, prNumber, headSha });
    if (lease?.status === 'pending' && !abandonedAmaCloserLeaseOutcome(lease)) {
      return { ok: false, reason: 'closer-submission-owned' };
    }
    if (lease?.lrqId && ['pending', 'dispatched'].includes(lease.status)) {
      const owned = launchRequestOwned(await readLaunchRequestStatusFromLedgerAsync({
        rootDir, launchRequestId: lease.lrqId, includeRetryChain: true }));
      if (owned !== false) return { ok: false, reason: 'closer-owned-or-unknown' };
    }
    const pending = facts.epochs.find(epoch => !epoch.reviewHead && !epoch.terminalAt);
    const terminalOwner = await observeRepairOwner({ rootDir, repo, epoch: pending });
    result = reserveRepairEpoch({ rootDir, repo, prNumber, headSha, ownerKey,
      cause: facts.cause, terminalOwner });
  } finally { release(); }
  if (result.reason === 'repair-epoch-cap') await pageRepairCap({ rootDir, repo, prNumber, epochs: result.epochs });
  return { ...result, refundedSpend: facts.refundedSpend };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await main(process.argv.slice(2));
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 75;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 75;
  }
}
