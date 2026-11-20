// Local dispatch boundary. PR lifecycle/branch ownership remain enforced by hq;
// this helper only reserves the exhausted PR's audited review episode.
import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { reserveRepairEpoch, pageRepairCap, observeRepairOwner } from '../src/repair-epochs.mjs';
import { readRepairFacts } from '../src/repair-facts.mjs';
import { tryAcquireCloserIntentLock } from '../src/ama/pre-receipt-intent.mjs';
import { readAmaCloserLease, abandonedAmaCloserLeaseOutcome, findLiveAmaCloserLease } from '../src/ama/closer-lease.mjs';
import { readLaunchRequestStatusFromLedgerAsync } from '../src/session-ledger-read-adapter.mjs';
import { readRepairFollowUpClaim } from '../src/repair-follow-up-claim.mjs';
import { launchRequestOwned } from '../src/ama/launch-request-status.mjs';
import { prepareDispatchReadContext, readDispatchLaunches } from '../src/dispatch-read-client.mjs';

// REPAIRDISPATCHREAD-01: this cold CLI is a composition root. Dispatch reads
// stay disabled until it prepares the read context, and an unprepared read
// returns "unknown" for every launch. Prepare once, lazily, before the first
// read; a failed preparation is its own refusal, never closer ownership.
function dispatchReadContext(env, prepare) {
  let ready;
  return () => (ready ??= (async () => {
    let prepared;
    try { prepared = await prepare({ env }); } catch { prepared = null; }
    if (!prepared?.ok) return { ok: false, detail: prepared?.detail ?? 'session-bootstrap-failed' };
    // The read gate is the env switch itself: a context that leaves it off
    // would make every lookup "dispatch lookup disabled" again.
    return env.ADVERSARIAL_DISPATCH_READS_ENABLED === '1' ? prepared
      : { ok: false, detail: 'dispatch-reads-disabled' };
  })());
}
function contextUnavailable(ready) {
  return { ok: false, reason: 'dispatch-read-context-unavailable', detail: ready.detail };
}

export async function main(args, {
  env = process.env, prepareDispatchReadContextImpl = prepareDispatchReadContext,
} = {}) {
  const [rootDir, repo, prRaw, headSha, ownerKey, conflicting, ticket, launcherPidRaw, dispatchProjectRaw] = args;
  const dispatchProjectRef = dispatchProjectRaw === '' ? undefined : dispatchProjectRaw;
  const prNumber = Number(prRaw);
  if (!rootDir || !repo?.includes('/') || !(prNumber > 0) || !ownerKey
    || !/^[0-9a-f]{40}$/i.test(headSha)
    || (dispatchProjectRef !== undefined && (typeof dispatchProjectRef !== 'string'
      || dispatchProjectRef.length > 256 || /\s/.test(dispatchProjectRef)))) throw new Error('invalid repair request');
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
  const readContext = dispatchReadContext(env, prepareDispatchReadContextImpl);
  const readImpl = (selector, readArgs) => readDispatchLaunches(selector, { ...readArgs, env });
  let result;
  try {
    const checkClaim = () => readRepairFollowUpClaim(rootDir, {
      repo, prNumber, headSha, ticket,
      launcherPid: /^[1-9]\d*$/.test(launcherPidRaw) ? Number(launcherPidRaw) : null,
    });
    const claim = checkClaim();
    if (!claim.ok) return claim;
    const prLease = claim.claimedAt && findLiveAmaCloserLease(rootDir, { repo, prNumber });
    if (prLease && (prLease.headSha.toLowerCase() !== headSha.toLowerCase()
      || !['pending', 'dispatched'].includes(prLease.lease.status)
      || (prLease.lease.status === 'dispatched' && !prLease.lease.lrqId))) {
      return { ok: false, reason: 'closer-owned-or-unknown' };
    }
    const lease = prLease?.lease ?? readAmaCloserLease(rootDir, { repo, prNumber, headSha });
    if (lease?.status === 'pending' && !abandonedAmaCloserLeaseOutcome(lease)) {
      return { ok: false, reason: 'closer-submission-owned' };
    }
    if (lease?.lrqId && ['pending', 'dispatched'].includes(lease.status)) {
      const ready = await readContext();
      if (!ready.ok) return contextUnavailable(ready);
      // Only a correctly read terminal launch with no live retry is unowned;
      // transient, timed-out or unproven reads keep the closer's custody.
      const owned = launchRequestOwned(await readLaunchRequestStatusFromLedgerAsync({
        rootDir, env, launchRequestId: lease.lrqId, includeRetryChain: true }));
      if (owned !== false) return { ok: false, reason: 'closer-owned-or-unknown' };
    }
    const pending = facts.epochs.find(epoch => !epoch.reviewHead && !epoch.terminalAt);
    const atReservationHead = typeof pending?.baseHead === 'string'
      && pending.baseHead.toLowerCase() === headSha.toLowerCase();
    if (atReservationHead) {
      const ready = await readContext();
      if (!ready.ok) return contextUnavailable(ready);
    }
    const terminalOwner = await observeRepairOwner({ rootDir, repo,
      epoch: atReservationHead ? pending : null, readImpl });
    if (claim.claimedAt) {
      const current = checkClaim();
      if (!current.ok) return current;
      if (current.claimedAt !== claim.claimedAt) return { ok: false, reason: 'remediation-ownership-unknown' };
    }
    result = reserveRepairEpoch({ rootDir, repo, prNumber, headSha, ownerKey,
      cause: facts.cause, dispatchProjectRef, terminalOwner, ownerSnapshot: pending });
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
