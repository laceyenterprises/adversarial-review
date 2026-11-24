// Local dispatch boundary. PR lifecycle/branch ownership remain enforced by hq;
// this helper only reserves the exhausted PR's audited review episode.
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  reserveRepairEpoch, pageRepairCap, observeRepairOwner, replayUnenqueuedFinalFixEpoch,
  REPAIR_READ_PREFLIGHT_REQUIRED,
} from '../src/repair-epochs.mjs';
import { automaticRemediationBudgetExhausted, readRepairFacts } from '../src/repair-facts.mjs';
import { readHammerRetryCapLedger } from '../src/ama/hammer-retry-cap.mjs';
import { tryAcquireCloserIntentLock } from '../src/ama/pre-receipt-intent.mjs';
import { readAmaCloserLease, abandonedAmaCloserLeaseOutcome, findLiveAmaCloserLease } from '../src/ama/closer-lease.mjs';
import { readLaunchRequestStatusFromLedgerAsync } from '../src/session-ledger-read-adapter.mjs';
import { readRepairFollowUpClaim } from '../src/repair-follow-up-claim.mjs';
import { launchRequestOwned } from '../src/ama/launch-request-status.mjs';
import { prepareDispatchReadContext, readDispatchLaunches } from '../src/dispatch-read-client.mjs';
import { findReceiptedCloserAlias, recoverReceiptedCloserAlias } from '../src/ama/receipted-closer-alias.mjs';
import { readLivePullRequestIdentity } from '../src/github-pr-identity.mjs';

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

function projectRequired(repo) {
  return { ok: false, reason: 'repair-dispatch-project-required',
    detail: 'supply-exact-dispatch-project',
    scope: { appId: 'adversarial-review', repo, projectRef: null } };
}

async function verifyRepairDispatchScope({ repo, dispatchProjectRef, readContext, readImpl }) {
  const scope = { appId: 'adversarial-review', repo, projectRef: dispatchProjectRef ?? null };
  if (!dispatchProjectRef) return projectRequired(repo);
  const ready = await readContext();
  if (!ready.ok) return { ...contextUnavailable(ready), scope };
  // A fresh probe isolates visibility from the actual dispatch key's current
  // launch state. Its reply has no role in owner reconciliation or enqueue.
  const selector = { idempotency_key: `repair-read-preflight-${randomUUID()}`,
    project_ref: dispatchProjectRef, repo };
  const result = await readImpl(selector);
  if (result.ok && result.absenceProof?.grant_id === 'project-repository-dispatch-read') return { ok: true };
  if (result.scopeDenied) return { ok: false, reason: 'repair-dispatch-read-scope-denied',
    detail: 'inspect-adversarial-review-dispatch_reads', scope };
  return { ok: false, reason: 'repair-dispatch-read-scope-unproven',
    detail: 'retry-after-dispatch-read-verification', scope };
}

export async function main(args, {
  env = process.env, prepareDispatchReadContextImpl = prepareDispatchReadContext,
  pageRepairCapImpl = pageRepairCap,
  readLivePrImpl = readLivePullRequestIdentity,
} = {}) {
  if (args.length === 1 && args[0] === '--final-fix-recovery-protocol') {
    return { ok: true, protocol: 'final-fix-recovery-v1' };
  }
  const [rootDir, repo, prRaw, headSha, ownerKey, conflicting, ticket, launcherPidRaw, dispatchProjectRaw, recoveryEpochId] = args;
  const operatorPrUpdate = !recoveryEpochId && env.HQ_REPAIR_REQUEST_KIND === 'operator-pr-update';
  const dispatchProjectRef = dispatchProjectRaw === '' ? undefined : dispatchProjectRaw;
  const prNumber = Number(prRaw);
  if (!rootDir || !/^[^/\s]+\/[^/\s]+$/.test(repo ?? '') || !(prNumber > 0) || !ownerKey
    || !/^[0-9a-f]{40}$/i.test(headSha)
    || (recoveryEpochId !== undefined && (ticket || launcherPidRaw || conflicting !== 'false'
      || !/^repair-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(recoveryEpochId)
      || !/^ffa-[0-9a-f]{64}$/.test(ownerKey) || !dispatchProjectRef))
    || (dispatchProjectRef !== undefined && (typeof dispatchProjectRef !== 'string'
      || dispatchProjectRef.length > 256 || /\s/.test(dispatchProjectRef)))) throw new Error('invalid repair request');
  const db = new Database(resolve(rootDir, 'data/reviews.db'), { readonly: true, fileMustExist: true });
  let facts;
  try {
    const row = db.prepare('SELECT * FROM reviewed_prs WHERE repo=? AND pr_number=?').get(repo, prNumber);
    if (recoveryEpochId) {
      if (row?.pr_state !== 'open') return { ok: false, reason: 'final-fix-pr-not-open' };
    }
    if (row && row.pr_state !== 'open') return { ok: true, epoch: null, reason: 'no-open-review-row' };
    if (!row && conflicting !== 'true') return { ok: true, epoch: null, reason: 'no-open-review-row' };
    facts = readRepairFacts({ rootDir, db, repo, prNumber, headSha, row, conflicting: conflicting === 'true' });
  } finally { db.close(); }
  const identity = { repo, prNumber };
  // Review revisions describe delivered reviews, not later final publications.
  // Use the shared repository-scoped live identity read without rewriting them.
  const verifyRecoveryHead = async () => {
    let live;
    try { live = await readLivePrImpl(repo, prNumber, { env, timeoutMs: 15000 }); }
    catch { return { ok: false, reason: 'final-fix-pr-unavailable' }; }
    if (!live || !['open', 'closed', 'merged'].includes(live.prState)
      || typeof live.headSha !== 'string' || !/^[0-9a-f]{40}$/i.test(live.headSha)) {
      return { ok: false, reason: 'final-fix-pr-unavailable' };
    }
    if (live.prState !== 'open') return { ok: false, reason: 'final-fix-pr-not-open' };
    if (live.headSha.toLowerCase() !== headSha.toLowerCase()) {
      return { ok: false, reason: 'final-fix-head-mismatch' };
    }
    return { ok: true };
  };
  const pending = facts.epochs.find(epoch => !epoch.reviewHead && !epoch.terminalAt);
  const operatorCandidate = operatorPrUpdate && pending?.ownerState === 'absent-unfenced'
    && pending.ownerKey !== ownerKey;
  const supersede = operatorCandidate && automaticRemediationBudgetExhausted(rootDir, identity);
  const cause = facts.cause || (supersede ? 'remediation-round-budget-exhausted' : null);
  if (!cause && !recoveryEpochId) return { ok: true, epoch: null, reason: 'budget-available' };
  let release = tryAcquireCloserIntentLock(rootDir, identity);
  if (!release) return { ok: false, reason: 'closer-submission-owned' };
  const readContext = dispatchReadContext(env, prepareDispatchReadContextImpl);
  const readImpl = (selector, readArgs) => readDispatchLaunches(selector, { ...readArgs, env });
  let result;
  try {
    const checkClaim = () => readRepairFollowUpClaim(rootDir, {
      repo, prNumber, headSha, ticket,
      launcherPid: /^[1-9]\d*$/.test(launcherPidRaw) ? Number(launcherPidRaw) : null,
      requireUnowned: Boolean(recoveryEpochId || supersede),
    });
    const claim = checkClaim();
    if (!claim.ok) return claim;
    // This read-only snapshot can reject an impossible new request before any
    // alias settlement or owner observation. Pending owners, replays and caps
    // still require ordinary admission; the flock remains the reservation fence.
    if (!dispatchProjectRef && facts.epochs.length < facts.epochCap
      && !facts.epochs.some(epoch => epoch.ownerKey === ownerKey || !epoch.reviewHead && !epoch.terminalAt)) {
      return projectRequired(repo);
    }
    const prLease = (claim.claimedAt || recoveryEpochId || supersede)
      && findLiveAmaCloserLease(rootDir, { repo, prNumber, strict: Boolean(recoveryEpochId || supersede) });
    if (prLease && (prLease.headSha.toLowerCase() !== headSha.toLowerCase()
      || !['pending', 'dispatched'].includes(prLease.lease.status)
      || (prLease.lease.status === 'dispatched' && !prLease.lease.lrqId))) {
      return { ok: false, reason: 'closer-owned-or-unknown' };
    }
    const lease = prLease?.lease ?? readAmaCloserLease(rootDir, { repo, prNumber, headSha });
    if (lease?.status === 'pending' && !abandonedAmaCloserLeaseOutcome(lease)) {
      return { ok: false, reason: 'closer-submission-owned' };
    }
    const atReservationHead = typeof pending?.baseHead === 'string'
      && pending.baseHead.toLowerCase() === headSha.toLowerCase();
    if (recoveryEpochId && (!atReservationHead || pending.id !== recoveryEpochId
      || pending.ownerKey !== ownerKey || pending.dispatchProjectRef !== dispatchProjectRef
      || pending.ownerLaunch != null || pending.publicationHead != null
      || ![undefined, null, 'unknown', 'absent', 'absent-unfenced'].includes(pending.ownerState))) {
      return { ok: false, reason: 'final-fix-reservation-changed' };
    }
    if (recoveryEpochId) {
      const live = await verifyRecoveryHead();
      if (!live.ok) return live;
    }
    let aliasReleased = false;
    if (lease?.lrqId && ['pending', 'dispatched'].includes(lease.status)) {
      const alias = findReceiptedCloserAlias(rootDir, lease);
      if (alias) release();
      const ready = await readContext();
      if (!ready.ok) return contextUnavailable(ready);
      // Only a correctly read terminal launch with no live retry is unowned;
      // transient, timed-out or unproven reads keep the closer's custody.
      if (alias) {
        const settlement = await recoverReceiptedCloserAlias({ rootDir, lease, record: alias,
          env, hqRoot: env.HQ_ROOT });
        if (!settlement.released) return { ok: false, reason: 'closer-owned-or-unknown', closer: settlement };
        // Settlement reacquires its own lock. Reacquire for reservation and
        // check for a successor before proceeding.
        release = tryAcquireCloserIntentLock(rootDir, { repo, prNumber });
        if (!release) return { ok: false, reason: 'closer-submission-owned' };
        aliasReleased = true;
      } else {
        const owned = launchRequestOwned(await readLaunchRequestStatusFromLedgerAsync({
          rootDir, env, launchRequestId: lease.lrqId, includeRetryChain: true }));
        if (owned !== false) return { ok: false, reason: 'closer-owned-or-unknown' };
      }
    }
    if (atReservationHead || supersede) {
      const ready = await readContext();
      if (!ready.ok) return contextUnavailable(ready);
    }
    const recheckCustody = () => {
      const current = checkClaim();
      if (!current.ok) return current;
      if (current.claimedAt !== claim.claimedAt) return { ok: false, reason: 'remediation-ownership-unknown' };
      if (aliasReleased && findLiveAmaCloserLease(rootDir, { repo, prNumber, strict: true })) {
        return { ok: false, reason: 'closer-owned-or-unknown' };
      }
      return current;
    };
    if (recoveryEpochId) {
      const selector = { idempotency_key: ownerKey, project_ref: dispatchProjectRef, repo };
      const read = await readImpl(selector, { rootDir, timeoutMs: 8000 });
      if (!read.ok || read.roots?.length !== 0
        || read.absenceProof?.grant_id !== 'project-repository-dispatch-read') {
        return { ok: false, reason: 'final-fix-owner-absence-unproven' };
      }
      const live = await verifyRecoveryHead();
      if (!live.ok) return live;
      const custody = recheckCustody();
      if (!custody.ok) return custody;
      const replay = replayUnenqueuedFinalFixEpoch({ rootDir, repo, prNumber, headSha,
        ownerKey, dispatchProjectRef, recoveryEpochId, ownerSnapshot: pending });
      return { ...replay, protocol: 'final-fix-recovery-v1' };
    }
    const observeOwner = () => observeRepairOwner({ rootDir, ...identity,
      epoch: atReservationHead || supersede ? pending : null, readImpl, closerIntentToken: release });
    const observed = await observeOwner();
    const custody = recheckCustody();
    if (!custody.ok) return custody;
    const reservation = { rootDir, ...identity, headSha, ownerKey, cause, dispatchProjectRef,
      terminalOwner: atReservationHead ? observed : null, ownerSnapshot: pending,
      operatorAbsence: supersede ? observed : null };
    result = reserveRepairEpoch({ ...reservation, requireReadPreflight: true });
    if (result.reason === REPAIR_READ_PREFLIGHT_REQUIRED) {
      const scope = await verifyRepairDispatchScope({ repo, dispatchProjectRef, readContext, readImpl });
      if (!scope.ok) return scope;
      // Scope verification can take time. Repeat the old owner's read before
      // committing a supersession, then CAS the persisted reservation.
      if (reservation.operatorAbsence?.ownerState === 'absent') {
        const refreshed = await observeOwner();
        reservation.operatorAbsence = automaticRemediationBudgetExhausted(rootDir, identity) ? refreshed : null;
      }
      const current = recheckCustody();
      if (!current.ok) return current;
      result = reserveRepairEpoch(reservation);
    }
  } finally { release?.(); }
  // Replays retry a failed alert too; the existing per-PR latch deduplicates
  // successful delivery across replacement chains, heads and process restarts.
  const history = result.ok && result.epoch?.supersedesEpochId
    ? readHammerRetryCapLedger(rootDir, identity)?.repairEpochs : null;
  if (result.reason === 'repair-epoch-cap' || history?.length > facts.epochCap) {
    await pageRepairCapImpl({ rootDir, repo, prNumber, epochs: history || result.epochs });
  }
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
