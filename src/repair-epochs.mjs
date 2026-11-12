import { randomUUID } from 'node:crypto';
import { mutateRepairEpochs, readHammerRetryCapLedger, evaluateHammerRetryCap } from './ama/hammer-retry-cap.mjs';
import { observeClosureWait } from './ama/closure-wait.mjs';
import { readDispatchLaunches, launchProbe } from './dispatch-read-client.mjs';
import { launchRequestOwned } from './ama/launch-request-status.mjs';

export const REPAIR_EPOCH_CAP = 2;
export const REPAIR_PROVISION_DEADLINE_MS = 10 * 60_000;
export const REPAIR_OWNER_OBSERVE_MS = 30_000;
const SHA = /^[a-f0-9]{40}$/i;
const sameHead = (left, right) => typeof left === 'string' && typeof right === 'string'
  && left.toLowerCase() === right.toLowerCase();
const EXHAUSTION = new Set(['closure-retry-exhausted', 'closure-lifetime-exhausted',
  'retry-exhausted', 'lifetime-exhausted', 'closer-self-error-budget-exhausted',
  'budget-exhausted-closure', 'system-budget-exhausted-closure',
  'remediation-round-budget-exhausted', 'review-cycle-cap-paused']);

export async function observeRepairOwner({ rootDir, epoch, now = Date.now(), readImpl = readDispatchLaunches }) {
  if (!epoch || epoch.reviewHead || epoch.terminalAt) return epoch;
  // Absence proofs require an exact-key selector without traversal options.
  const result = await readImpl({ idempotency_key: epoch.ownerKey },
    { rootDir, timeoutMs: 8000 });
  if (result.ok && result.roots?.length === 0 && result.absenceProof
    && now - Date.parse(epoch.reservedAt) >= REPAIR_PROVISION_DEADLINE_MS) {
    return { ...epoch, ownerState: 'terminal', ownerLaunch: null };
  }
  if (!result.ok || result.roots?.length !== 1) return { ...epoch, ownerState: 'unknown' };
  const chain = await readImpl({ launch_request_ids: [result.roots[0]], include_retry_chain: true },
    { rootDir, timeoutMs: 8000 });
  const probe = launchProbe(chain, result.roots[0], true);
  const owned = launchRequestOwned(probe);
  return { ...epoch, ownerState: owned === false ? 'terminal' : owned ? 'live' : 'unknown',
    ownerLaunch: result.roots[0] };
}

// Reconcile before watcher admission. Unknown evidence retains custody; only
// complete terminal retry evidence or proven absence after provisioning retires.
export async function reconcileRepairOwner({ rootDir, repo, prNumber, headSha, now = Date.now(),
  readImpl = readDispatchLaunches, includeReviewedHead = false }) {
  const ledger = readHammerRetryCapLedger(rootDir, { repo, prNumber });
  if (ledger?.__corrupt) throw new Error('repair ledger unreadable');
  const epoch = ledger?.repairEpochs?.findLast(entry => !entry.reviewHead && !entry.terminalAt);
  // The watcher can resolve historical admission from this same snapshot.
  if (!epoch) return includeReviewedHead
    ? ledger?.repairEpochs?.find(entry => sameHead(entry.reviewHead, headSha)) || null : null;
  // Publication may finish before this poll observes the new head. Admission
  // must bind that head before terminal worker observation can retire custody.
  if (headSha && !sameHead(epoch.baseHead, headSha)) return epoch;
  const age = now - Date.parse(epoch.ownerObservedAt);
  if (age >= 0 && age < REPAIR_OWNER_OBSERVE_MS) return epoch;
  const observed = await observeRepairOwner({ rootDir, epoch, now, readImpl });
  const reconciled = mutateRepairEpochs(rootDir, { repo, prNumber }, ledger => {
    const current = ledger.repairEpochs?.find(entry => entry.id === epoch.id && entry.ownerKey === epoch.ownerKey);
    if (!current || current.reviewHead || current.terminalAt) return null;
    current.ownerObservedAt = new Date(now).toISOString();
    current.ownerState = observed.ownerState;
    current.ownerLaunch = observed.ownerLaunch || null;
    if (observed.ownerState === 'terminal') {
      current.terminalAt = current.ownerObservedAt;
      current.terminalLaunch = current.ownerLaunch;
      return null;
    }
    return current;
  });
  return reconciled || (includeReviewedHead ? repairEpochForHead(rootDir, { repo, prNumber }, headSha) : null);
}

export function repairCause({ ledger, row, cycleExhausted = false, conflicting = false } = {}) {
  if (ledger?.__corrupt) throw new Error('repair ledger unreadable');
  const cap = evaluateHammerRetryCap(ledger, { jobKey: ledger?.jobKey, headSha: ledger?.targetRemediationSha });
  if (cap.lifetimeCapExhausted) return 'closure-lifetime-exhausted';
  if (cap.capExhausted) return 'closure-retry-exhausted';
  let action = row?.next_action_json;
  if (typeof action === 'string') {
    try { action = JSON.parse(action); }
    catch { action = null; }
  }
  const reason = action?.reason || row?.rereview_reason;
  if (EXHAUSTION.has(reason)) return reason;
  if (cycleExhausted) return 'review-cycle-exhausted';
  if (conflicting) return 'conflict-without-owner';
  return null;
}

// ownerKey is the dispatch idempotency key. An uncertain submission keeps its
// reservation; another request cannot mint a second writer on the same head.
export function reserveRepairEpoch({ rootDir, repo, prNumber, headSha, ownerKey, cause,
  now = new Date().toISOString(), terminalOwner = null }) {
  if (!SHA.test(headSha) || !ownerKey || !cause) throw new Error('invalid repair identity');
  return mutateRepairEpochs(rootDir, { repo, prNumber }, ledger => {
    const epochs = ledger.repairEpochs ||= [];
    const ended = terminalOwner?.ownerState === 'terminal'
      && epochs.find(epoch => epoch.id === terminalOwner.id && epoch.ownerKey === terminalOwner.ownerKey
        && !epoch.reviewHead && !epoch.terminalAt);
    if (ended) {
      ended.terminalAt = now;
      ended.terminalLaunch = terminalOwner.ownerLaunch;
    }
    const replay = epochs.find(epoch => epoch.ownerKey === ownerKey);
    if (replay) return replay.terminalAt
      ? { ok: false, reason: 'repair-worker-terminal', epoch: replay }
      : { ok: true, epoch: replay, replayed: true };
    const pending = epochs.find(epoch => !epoch.reviewHead && !epoch.terminalAt);
    if (pending) return { ok: false, reason: 'repair-owned', epoch: pending };
    if (epochs.length >= REPAIR_EPOCH_CAP) return { ok: false, reason: 'repair-epoch-cap', epochs };
    const epoch = { id: `repair-${randomUUID()}`, ownerKey, baseHead: headSha, cause,
      reservedAt: now, reviewHead: null,
      priorSpend: { series: ledger.attemptCount || 0, head: ledger.targetAttemptCount || 0,
        lifetime: ledger.lifetimeAttemptCount || 0 },
      refundedSpend: ledger.selfErrorRefunds || {} };
    epochs.push(epoch);
    return { ok: true, epoch };
  });
}

export function pendingRepairEpoch(rootDir, identity) {
  const ledger = readHammerRetryCapLedger(rootDir, identity);
  if (ledger?.__corrupt) throw new Error('repair ledger unreadable');
  return ledger?.repairEpochs?.findLast(epoch => !epoch.reviewHead && !epoch.terminalAt) || null;
}

// Read-only projections retain the normal corrupt-cap recovery path. A
// reservation/admission still calls the strict reader and refuses corruption.
export function repairEpochObservation(rootDir, identity) {
  try { return { repairEpoch: pendingRepairEpoch(rootDir, identity) }; }
  catch (error) {
    if (error.message !== 'repair ledger unreadable') throw error;
    return { repairEpoch: null, repairEpochUnreadable: true };
  }
}

// Only a changed builder head can consume the reservation. Bind before the
// request CAS so a crash can retry that same head, never a later head.
export function bindRepairHead({ rootDir, repo, prNumber, headSha, epochId, now = new Date().toISOString() }) {
  return mutateRepairEpochs(rootDir, { repo, prNumber }, ledger => {
    const epoch = ledger.repairEpochs?.find(entry => entry.id === epochId);
    if (!epoch || epoch.terminalAt || sameHead(epoch.baseHead, headSha) || !SHA.test(headSha)
      || (epoch.reviewHead && !sameHead(epoch.reviewHead, headSha))) return null;
    if (!epoch.reviewHead) {
      epoch.reviewHead = headSha;
      epoch.boundAt = now;
      // This is a new adjudication episode, not a refund of real work.
      ledger.attemptCount = 0;
      ledger.targetAttemptCount = 0;
      ledger.lifetimeAttemptCount = 0;
      ledger.suppressed = false;
      ledger.targetSuppressed = false;
      ledger.lifetimeSuppressed = false;
      ledger.targetRemediationSha = headSha;
      ledger.targetChargeEpoch = randomUUID();
      ledger.jobKey = headSha;
    }
    return epoch;
  });
}

export function repairEpochForHead(rootDir, identity, headSha) {
  const ledger = readHammerRetryCapLedger(rootDir, identity);
  if (ledger?.__corrupt) throw new Error('repair ledger unreadable');
  return ledger?.repairEpochs?.find(epoch => sameHead(epoch.reviewHead, headSha)) || null;
}

export async function pageRepairCap({ rootDir, repo, prNumber, epochs, observeImpl = observeClosureWait }) {
  return observeImpl({ rootDir, repo, prNumber, headSha: 'repair-epoch-cap',
    waitClass: 'repair-epoch-cap', immediate: true,
    reason: `Repair epoch cap; operator owns this PR. History: ${JSON.stringify(epochs)}` });
}
