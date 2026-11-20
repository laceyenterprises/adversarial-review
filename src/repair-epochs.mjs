import { resolveHqRoot } from './hq-root.mjs';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { mutateRepairEpochs, readHammerRetryCapLedger, evaluateHammerRetryCap } from './ama/hammer-retry-cap.mjs';
import { observeClosureWait } from './ama/closure-wait.mjs';
import { readDispatchLaunches, launchProbe } from './dispatch-read-client.mjs';
import { launchRequestOwned } from './ama/launch-request-status.mjs';
import { readHeadAttestationChainForPr, resolveDaemonWorkerIdentityFromHeadAttestation } from './daemon-worker-identity.mjs';

export const REPAIR_EPOCH_CAP = 2;
export const REPAIR_OWNER_OBSERVE_MS = 30_000;
export const REPAIR_ABSENCE_ESCALATE_MS = 10 * 60_000;
const SHA = /^[a-f0-9]{40}$/i;
const REPO = /^[^/\s]+\/[^/\s]+$/;
const validProject = value => typeof value === 'string' && value.length > 0
  && value.length <= 256 && !/\s/.test(value);
const sameIdentity = (left, right) => typeof left === 'string' && typeof right === 'string'
  && left.toLowerCase() === right.toLowerCase();
const readRepairPublisher = ({ execFileImpl, ...args }) => resolveDaemonWorkerIdentityFromHeadAttestation({
  ...args, readHeadAttestationChainForPrImpl: options => readHeadAttestationChainForPr({
    ...options, execFileImpl, retryDelaysMs: [], timeoutMs: 8000,
  }),
});
const EXHAUSTION = new Set(['closure-retry-exhausted', 'closure-lifetime-exhausted',
  'retry-exhausted', 'lifetime-exhausted', 'closer-self-error-budget-exhausted',
  'budget-exhausted-closure', 'system-budget-exhausted-closure',
  'remediation-round-budget-exhausted', 'review-cycle-cap-paused']);

export async function observeRepairOwner({ rootDir, repo, epoch, readImpl = readDispatchLaunches }) {
  if (!epoch || epoch.reviewHead || epoch.terminalAt) return epoch;
  const unknown = { ...epoch, ownerState: 'unknown' };
  if (typeof repo !== 'string' || !REPO.test(repo) || repo !== repo.trim()
    || !SHA.test(epoch.baseHead) || typeof epoch.ownerKey !== 'string' || !epoch.ownerKey) return unknown;
  const selector = { idempotency_key: epoch.ownerKey };
  if (Object.hasOwn(epoch, 'dispatchProjectRef')) {
    if (!validProject(epoch.dispatchProjectRef)) return unknown;
    Object.assign(selector, { project_ref: epoch.dispatchProjectRef, repo });
  }
  const readArgs = { rootDir, timeoutMs: 8000 };
  const result = await readImpl(selector, readArgs);
  // Pre-enqueue reservation and enqueue run in separate critical sections.
  // Even canonical point-in-time absence cannot fence a delayed submitter.
  if (!result.ok) return unknown;
  if (result.roots?.length === 0 && result.absenceProof?.version === 1
    && result.absenceProof.kind === 'canonical-exact-selector-absence') {
    return { ...epoch, ownerState: 'absent', absentObservations: (epoch.absentObservations || 0) + 1 };
  }
  if (result.roots?.length !== 1) return unknown;
  const [ownerLaunch] = result.roots;
  if (epoch.ownerLaunch && epoch.ownerLaunch !== ownerLaunch) return unknown;
  const matchesOwner = row => row?.launch_request_id === ownerLaunch
    && row.idempotency_key === epoch.ownerKey && row.identity_ambiguous !== true
    && (row.target_repo == null || [repo, repo.split('/').at(-1)].some(name => sameIdentity(row.target_repo, name)))
    && (!row.head_sha || sameIdentity(row.head_sha, epoch.baseHead));
  if (!result.rows?.some(matchesOwner)) return unknown;
  const chain = await readImpl({ launch_request_ids: [ownerLaunch], include_retry_chain: true }, readArgs);
  const probe = launchProbe(chain, ownerLaunch, true);
  if (chain.roots?.length !== 1 || chain.roots[0] !== ownerLaunch || !matchesOwner(probe.row)) {
    return { ...unknown, ownerLaunch };
  }
  const owned = launchRequestOwned(probe);
  return { ...epoch, ownerState: owned === false ? 'terminal' : owned ? 'live' : 'unknown',
    ownerLaunch, retryLaunches: probe.retryChain.map(row => row.launch_request_id) };
}

// At the base head, only a positively identified terminal launch and its
// complete retry chain can retire custody. A moved head binds with publication
// proof, or retires after a successful negative read and terminal owner proof.
export async function reconcileRepairOwner({ rootDir, repo, prNumber, headSha, now = Date.now(),
  readImpl = readDispatchLaunches, includeReviewedHead = false,
  hqRoot = resolveHqRoot(), execFileImpl, readPublisher = readRepairPublisher,
  observeWait = observeClosureWait }) {
  const ledger = readHammerRetryCapLedger(rootDir, { repo, prNumber });
  if (ledger?.__corrupt) throw new Error('repair ledger unreadable');
  const epoch = ledger?.repairEpochs?.findLast(entry => !entry.reviewHead && !entry.terminalAt);
  // The watcher can resolve historical admission from this same snapshot.
  if (!epoch) return includeReviewedHead
    ? ledger?.repairEpochs?.find(entry => sameIdentity(entry.reviewHead, headSha)) || null : null;
  const atBase = sameIdentity(epoch.baseHead, headSha);
  const age = now - Date.parse(epoch.ownerObservedAt);
  if (sameIdentity(epoch.publicationHead, headSha)
    || (age >= 0 && age < REPAIR_OWNER_OBSERVE_MS)) return epoch;
  const observed = await observeRepairOwner({ rootDir, repo, epoch, readImpl });
  let publicationHead, publicationLaunch, foreignHead = false;
  if (!atBase && typeof headSha === 'string' && SHA.test(headSha)
    && observed.ownerState !== 'unknown' && observed.retryLaunches) {
    const publisher = await readPublisher({ rootDir, hqRoot, execFileImpl, repo, prNumber, currentHeadSha: headSha.toLowerCase() });
    if (publisher?.ok && sameIdentity(publisher.rowHeadSha, headSha)
      && [observed.ownerLaunch, ...observed.retryLaunches].includes(publisher.launchRequestId)) {
      publicationHead = headSha;
      publicationLaunch = publisher.launchRequestId;
    }
    foreignHead = !publicationHead && (publisher?.ok === true
      || publisher?.reason === 'missing-produced-head-attestation');
  }
  const reconciled = mutateRepairEpochs(rootDir, { repo, prNumber }, ledger => {
    const current = ledger.repairEpochs?.findLast(entry => !entry.reviewHead && !entry.terminalAt);
    if (!current) return null;
    if (!isDeepStrictEqual(current, epoch)) return current;
    current.ownerObservedAt = new Date(now).toISOString();
    current.ownerState = current.ownerState === 'absent-unfenced' && observed.ownerState === 'unknown'
      ? 'absent-unfenced' : observed.ownerState;
    current.ownerLaunch = observed.ownerLaunch || null;
    if (observed.ownerState === 'absent') {
      current.absentObservations = observed.absentObservations;
      if (now - Date.parse(current.reservedAt) >= REPAIR_ABSENCE_ESCALATE_MS
        && current.absentObservations >= 2) current.ownerState = 'absent-unfenced';
    } else if (current.ownerState !== 'absent-unfenced') {
      delete current.absentObservations;
    }
    if (observed.ownerState === 'terminal' && (atBase || foreignHead)) {
      current.terminalAt = current.ownerObservedAt;
      current.terminalLaunch = current.ownerLaunch;
      current.terminalReason = atBase ? 'owner-terminal-at-base' : 'foreign-head-after-terminal';
      return null;
    }
    if (publicationHead) {
      current.publicationHead = publicationHead;
      current.publicationLaunch = publicationLaunch;
    }
    return current;
  });
  if (reconciled?.ownerState === 'absent-unfenced') {
    await observeWait({ rootDir, repo, prNumber, headSha: `${reconciled.baseHead}:${reconciled.id}`,
      waitClass: 'repair-absent-unfenced', immediate: true, now,
      reason: `Repair reservation ${reconciled.id} has repeated dispatch absence without an enqueue fence; operator must inspect the submitter and key before releasing custody.` });
  }
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
  now = new Date().toISOString(), dispatchProjectRef, terminalOwner = null, ownerSnapshot = null }) {
  if (!SHA.test(headSha) || !ownerKey || !cause
    || (dispatchProjectRef !== undefined && !validProject(dispatchProjectRef))) throw new Error('invalid repair identity');
  return mutateRepairEpochs(rootDir, { repo, prNumber }, ledger => {
    const epochs = ledger.repairEpochs ||= [];
    const replay = epochs.find(epoch => epoch.ownerKey === ownerKey);
    if (replay?.dispatchProjectRef !== undefined && dispatchProjectRef !== undefined
      && replay.dispatchProjectRef !== dispatchProjectRef) return { ok: false, reason: 'repair-project-mismatch' };
    const ended = terminalOwner?.ownerState === 'terminal' && terminalOwner.ownerLaunch
      && sameIdentity(headSha, terminalOwner.baseHead)
      && epochs.find(epoch => epoch.id === terminalOwner.id && epoch.ownerKey === terminalOwner.ownerKey
        && !epoch.reviewHead && !epoch.terminalAt && isDeepStrictEqual(epoch, ownerSnapshot));
    if (ended) {
      ended.terminalAt = now;
      ended.terminalLaunch = terminalOwner.ownerLaunch;
    }
    if (replay && !sameIdentity(replay.baseHead, headSha)) return { ok: false, reason: 'repair-head-mismatch' };
    if (replay) return replay.terminalAt
      ? { ok: false, reason: 'repair-worker-terminal', epoch: replay }
      : { ok: true, epoch: replay, replayed: true };
    const pending = epochs.find(epoch => !epoch.reviewHead && !epoch.terminalAt);
    if (pending) return { ok: false, reason: 'repair-owned', epoch: pending };
    if (epochs.length >= REPAIR_EPOCH_CAP) return { ok: false, reason: 'repair-epoch-cap', epochs };
    const epoch = { id: `repair-${randomUUID()}`, ownerKey, baseHead: headSha, cause,
      reservedAt: now, reviewHead: null,
      ...(dispatchProjectRef === undefined ? {} : { dispatchProjectRef }),
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
    if (!epoch || epoch.terminalAt || sameIdentity(epoch.baseHead, headSha) || !SHA.test(headSha)
      || (epoch.reviewHead && !sameIdentity(epoch.reviewHead, headSha))) return null;
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
  return ledger?.repairEpochs?.find(epoch => sameIdentity(epoch.reviewHead, headSha)) || null;
}

export async function pageRepairCap({ rootDir, repo, prNumber, epochs, observeImpl = observeClosureWait }) {
  return observeImpl({ rootDir, repo, prNumber, headSha: 'repair-epoch-cap',
    waitClass: 'repair-epoch-cap', immediate: true,
    reason: `Repair epoch cap; operator owns this PR. History: ${JSON.stringify(epochs)}` });
}
