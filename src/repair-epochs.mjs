import { resolveHqRoot } from './hq-root.mjs';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { mutateRepairEpochs, readHammerRetryCapLedger, evaluateHammerRetryCap } from './ama/hammer-retry-cap.mjs';
import { observeClosureWait } from './ama/closure-wait.mjs';
import { readDispatchLaunches, launchProbe } from './dispatch-read-client.mjs';
import { closureOwnerOverdue, closureOwnerStopped } from './ama/closure-owner-expiry.mjs';
import { AMA_CLOSER_DISPATCHED_LEASE_RECLAIM_AGE_MS } from './ama/closer-lease.mjs';
import { launchRequestOwned } from './ama/launch-request-status.mjs';
import { readHeadAttestationChainForPr, resolveDaemonWorkerIdentityFromHeadAttestation } from './daemon-worker-identity.mjs';
import { hasUnsettledAmaCloserDispatch } from './ama/dispatch-record-read.mjs';
import { tryAcquireCloserIntentLock, withCloserIntentWriteLock } from './ama/pre-receipt-intent.mjs';

export const REPAIR_EPOCH_CAP = 2;
export const REPAIR_READ_PREFLIGHT_REQUIRED = 'repair-dispatch-read-preflight-required';
export const REPAIR_OWNER_OBSERVE_MS = 30_000;
export const REPAIR_ABSENCE_ESCALATE_MS = 10 * 60_000;
const PUBLISHER_MISSING_CACHE_MS = 2 * 60_000;
const SHA = /^[a-f0-9]{40}$/i;
const REPO = /^[^/\s]+\/[^/\s]+$/;
const isUnscopedCwp = epoch => /^cwp-[0-9a-f]{24}$/.test(epoch.ownerKey)
  && epoch.cause === 'conflict-without-owner' && !Object.hasOwn(epoch, 'dispatchProjectRef');
const validProject = value => typeof value === 'string' && value.length > 0
  && value.length <= 256 && !/\s/.test(value);
const sameIdentity = (left, right) => typeof left === 'string' && typeof right === 'string'
  && left.toLowerCase() === right.toLowerCase();

// Use a durable observation beyond the grace period. An old reservation alone
// cannot establish that the dispatch lookup still lacks ownership proof.
export function repairOwnerProofOverdue(epoch) {
  return Boolean(epoch?.id && !epoch.reviewHead && !epoch.terminalAt && !epoch.publicationHead
    && epoch.ownerState === 'unknown'
    && Date.parse(epoch.ownerObservedAt) - Date.parse(epoch.reservedAt) >= REPAIR_ABSENCE_ESCALATE_MS);
}

// REPAIROWNERSCOPE-02: an overdue unknown owner names what releases it. A
// recorded scope names the exact (project, repository) read the app lacks. An
// unrecorded scope means the owner launch is unreadable under any granted
// project, so the operator must find that launch's project. A scope is never
// taken from any field other than the owner record's own project: the producer
// authorizes a scoped read only on that value, so any other source would move
// the reservation onto a read that can never match.
export function repairOwnerOperatorAction(epoch) {
  if (!repairOwnerProofOverdue(epoch)) return null;
  return Object.hasOwn(epoch, 'dispatchProjectRef') && validProject(epoch.dispatchProjectRef)
    ? { action: 'grant-owner-dispatch-read', scope: 'recorded', project: epoch.dispatchProjectRef }
    : { action: 'establish-owner-dispatch-scope', scope: 'unrecorded' };
}

function repairOwnerOperatorText(epoch, repo) {
  const action = repairOwnerOperatorAction(epoch);
  if (action?.scope === 'recorded') {
    return `Operator action: grant the review app a dispatch read for project ${action.project} `
      + `and repository ${repo}; the owner then resolves on the next pass and a terminal owner releases review.`;
  }
  return 'Operator action: the reservation records no dispatch scope and the owner launch is not readable. '
    + 'Find the owner launch by its idempotency key and grant the review app a dispatch read for that '
    + "launch's project and repository; the scope is then recorded once. A fenced legacy or CWP conflict "
    + 'reservation can instead be retired with bin/retire-legacy-repair.mjs.';
}

export function repairOperatorHoldReason(epoch) {
  if (!epoch?.id || epoch.reviewHead || epoch.terminalAt) return null;
  if (epoch.ownerState === 'absent-unfenced') return 'repair-absent-unfenced';
  if (epoch.publisherObservation?.operatorRequired) return 'repair-publication-unproven';
  return repairOwnerProofOverdue(epoch) ? 'repair-owner-unproven' : null;
}

function canObserveCwpAbsence(rootDir, identity, epoch, now, logger, closerIntentToken) {
  if (!Number.isSafeInteger(identity.prNumber) || identity.prNumber <= 0
    || epoch.ownerLaunch != null || epoch.retryLaunches?.length || epoch.publicationHead || epoch.publicationLaunch
    || !(now - Date.parse(epoch.reservedAt) >= REPAIR_ABSENCE_ESCALATE_MS)) return false;
  try {
    if (closerIntentToken) return withCloserIntentWriteLock(rootDir, identity, closerIntentToken,
      () => !hasUnsettledAmaCloserDispatch(rootDir, identity));
    const unlock = tryAcquireCloserIntentLock(rootDir, identity);
    // Contention supplies no new observation. Let the caller skip persistence
    // so a concurrent readiness probe cannot invalidate committed evidence.
    if (!unlock) return null;
    try { return !hasUnsettledAmaCloserDispatch(rootDir, identity); }
    finally { unlock(); }
  } catch (error) {
    // Reconciliation's persisted observation cadence bounds this diagnostic
    // to one per reservation per thirty seconds, including after restart.
    logger.warn(JSON.stringify({ event: 'repair.cwp_absence_check_failed',
      ...identity, reservationId: epoch.id, errorClass: error.name,
      code: error.code || null, message: error.message }));
    return false;
  }
}

function sameReservationSnapshot(left, right) {
  // A timestamp refresh does not change a terminal proof's reservation. Keep
  // every identity, owner state, publication and spend field in this CAS.
  const withoutObservationTime = epoch => {
    const value = { ...epoch };
    delete value.ownerObservedAt;
    return value;
  };
  return isDeepStrictEqual(withoutObservationTime(left), withoutObservationTime(right));
}

function sameSupersessionSnapshot(current, snapshot) {
  // The watcher keeps counting canonical absence after absent-unfenced. Growth
  // alone cannot invalidate a fresh absence proof; resets and all other fields
  // still fence supersession. Other reservation CAS callers remain strict.
  return Number.isSafeInteger(snapshot?.absentObservations) && snapshot.absentObservations >= 2
    && Number.isSafeInteger(current.absentObservations)
    && current.absentObservations >= snapshot.absentObservations
    && sameReservationSnapshot(current, { ...snapshot, absentObservations: current.absentObservations });
}
const readRepairPublisher = ({ execFileImpl, ...args }) => resolveDaemonWorkerIdentityFromHeadAttestation({
  ...args, readHeadAttestationChainForPrImpl: options => readHeadAttestationChainForPr({
    ...options, execFileImpl, retryDelaysMs: [], timeoutMs: 8000,
  }),
});
const EXHAUSTION = new Set(['closure-retry-exhausted', 'closure-lifetime-exhausted',
  'retry-exhausted', 'lifetime-exhausted', 'closer-self-error-budget-exhausted',
  'budget-exhausted-closure', 'system-budget-exhausted-closure',
  'remediation-round-budget-exhausted', 'review-cycle-cap-paused']);

export async function observeRepairOwner({ rootDir, repo, prNumber, epoch, now = Date.now(),
  readImpl = readDispatchLaunches, logger = console, closerIntentToken, expiry = false, ...expiryOptions }) {
  if (!epoch || epoch.reviewHead || epoch.terminalAt) return epoch;
  const unknown = { ...epoch, ownerState: 'unknown' };
  if (typeof repo !== 'string' || !REPO.test(repo) || repo !== repo.trim()
    || !SHA.test(epoch.baseHead) || typeof epoch.ownerKey !== 'string' || !epoch.ownerKey) return unknown;
  const selector = { idempotency_key: epoch.ownerKey };
  const unscopedCwp = isUnscopedCwp(epoch);
  if (Object.hasOwn(epoch, 'dispatchProjectRef')) {
    if (!validProject(epoch.dispatchProjectRef)) return unknown;
    Object.assign(selector, { project_ref: epoch.dispatchProjectRef, repo });
  } else if (unscopedCwp) {
    selector.repo = repo;
  }
  const readArgs = { rootDir, timeoutMs: 8000, env: expiryOptions.env, signal: expiryOptions.signal };
  let result = await readImpl(selector, readArgs);
  if (unscopedCwp && !result.ok && (result.selectorRefused === true
    || result.detail === 'dispatch absence scope unproven')) {
    // Older producers may refuse the repository-only selector. Preserve their
    // key-only positive ownership read, but skip it on transport faults and
    // never use fallback results to certify absence.
    result = await readImpl({ idempotency_key: epoch.ownerKey }, readArgs);
    if (!result.ok || result.roots?.length !== 1) return unknown;
  }
  // Pre-enqueue reservation and enqueue run in separate critical sections.
  // Even canonical point-in-time absence cannot fence a delayed submitter.
  if (!result.ok) return unknown;
  if (result.roots?.length === 0 && result.absenceProof?.version === 1
    && result.absenceProof.kind === 'canonical-exact-selector-absence') {
    if (unscopedCwp) {
      const clear = canObserveCwpAbsence(rootDir, { repo, prNumber }, epoch, now, logger, closerIntentToken);
      // Returning the original snapshot signals a deferred observation.
      if (clear === null) return epoch;
      if (!clear) return unknown;
    }
    return { ...epoch, ownerState: 'absent', absentObservations: (epoch.absentObservations || 0) + 1 };
  }
  if (result.roots?.length !== 1) return unknown;
  const [ownerLaunch] = result.roots;
  if (epoch.ownerLaunch && epoch.ownerLaunch !== ownerLaunch) return unknown;
  const matchesOwner = row => row?.launch_request_id === ownerLaunch
    && row.idempotency_key === epoch.ownerKey && row.identity_ambiguous !== true
    && (row.target_repo == null || [repo, repo.split('/').at(-1)].some(name => sameIdentity(row.target_repo, name)))
    && (!row.head_sha || sameIdentity(row.head_sha, epoch.baseHead))
    // A bound scope that the launch's own record contradicts proves nothing.
    && (row.project_ref == null || epoch.dispatchProjectRef === undefined
      || row.project_ref === epoch.dispatchProjectRef);
  if (!result.rows?.some(matchesOwner)) return unknown;
  const chain = await readImpl({ launch_request_ids: [ownerLaunch], include_retry_chain: true }, readArgs);
  const probe = launchProbe(chain, ownerLaunch, true);
  if (chain.roots?.length !== 1 || chain.roots[0] !== ownerLaunch || !matchesOwner(probe.row)) {
    return { ...unknown, ownerLaunch };
  }
  const owned = launchRequestOwned(probe);
  const ownerStopped = expiry && await closureOwnerStopped(probe, { rootDir, ...expiryOptions });
  // The owner launch's own record is durable evidence of its dispatch scope.
  // Offer it only from the matched row, and only in a valid form; never infer it.
  const ownerProjectRef = validProject(probe.row.project_ref) ? probe.row.project_ref : undefined;
  return { ...epoch, ownerState: owned === false ? 'terminal' : owned ? 'live' : 'unknown',
    ownerLaunch, retryLaunches: probe.retryChain?.map(row => row.launch_request_id) ?? [],
    ...(expiry && { ownerStopped }),
    ...(ownerProjectRef === undefined ? {} : { ownerProjectRef }) };
}

// A reservation owns the PR through publication. On a moved head, only a
// publication attested by the owner launch or its retry releases the review gate.
export function repairReservationOwnsPr(epoch, headSha) {
  return Boolean(epoch && !epoch.reviewHead
    && (!epoch.publicationHead || epoch.publicationHead.toLowerCase() !== headSha?.toLowerCase()));
}

// At the base head, only a positively identified terminal launch and its
// complete retry chain can retire custody. A moved head binds with publication
// proof, or retires after a successful negative read and terminal owner proof.
export async function reconcileRepairOwner({ rootDir, repo, prNumber, headSha, now = Date.now(),
  readImpl = readDispatchLaunches, includeReviewedHead = false,
  hqRoot = resolveHqRoot(), execFileImpl, readPublisher = readRepairPublisher,
  observeWait = observeClosureWait, logger = console }) {
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
  const observed = await observeRepairOwner({ rootDir, repo, prNumber, epoch, now, readImpl, logger });
  if (observed === epoch) return epoch;
  let publicationHead, publicationLaunch, publisherObservation, foreignHead = false;
  if (!atBase && typeof headSha === 'string' && SHA.test(headSha)
    && observed.ownerState !== 'unknown' && observed.retryLaunches) {
    const previous = epoch.publisherObservation;
    const samePublisher = sameIdentity(previous?.headSha, headSha)
      && previous.ownerLaunch === observed.ownerLaunch
      && previous.ownerState === observed.ownerState
      && isDeepStrictEqual(previous.retryLaunches, observed.retryLaunches);
    const cacheAge = now - Date.parse(previous?.observedAt);
    // Ownership is always read above. Missing publication is only cached for
    // a live unchanged owner/head/retry chain, and expires even if it stays live.
    const cachedMissing = samePublisher && observed.ownerState === 'live'
      && previous.reason === 'missing-produced-head-attestation'
      && cacheAge >= 0 && cacheAge < PUBLISHER_MISSING_CACHE_MS;
    const publisher = cachedMissing ? { ok: false, reason: previous.reason }
      : await readPublisher({ rootDir, hqRoot, execFileImpl, repo, prNumber, currentHeadSha: headSha.toLowerCase() });
    if (publisher?.ok && sameIdentity(publisher.rowHeadSha, headSha)
      && [observed.ownerLaunch, ...observed.retryLaunches].includes(publisher.launchRequestId)) {
      publicationHead = headSha;
      publicationLaunch = publisher.launchRequestId;
    }
    foreignHead = !publicationHead && (publisher?.ok === true
      || publisher?.reason === 'missing-produced-head-attestation');
    if ((!publicationHead && !foreignHead) || cachedMissing
      || observed.ownerState === 'live' && publisher?.reason === 'missing-produced-head-attestation') {
      publisherObservation = cachedMissing ? previous : {
        headSha: headSha.toLowerCase(), ownerLaunch: observed.ownerLaunch,
        ownerState: observed.ownerState, retryLaunches: observed.retryLaunches,
        reason: publisher?.reason || 'publisher-evidence-unavailable',
        firstObservedAt: samePublisher ? previous.firstObservedAt : new Date(now).toISOString(),
        observedAt: new Date(now).toISOString(),
        observations: (samePublisher ? previous.observations || 0 : 0) + 1,
      };
      publisherObservation.operatorRequired = observed.ownerState === 'terminal'
        && publisherObservation.observations >= 2
        && now - Date.parse(publisherObservation.firstObservedAt) >= REPAIR_ABSENCE_ESCALATE_MS;
    }
  }
  const reconciled = mutateRepairEpochs(rootDir, { repo, prNumber }, ledger => {
    const current = ledger.repairEpochs?.findLast(entry => !entry.reviewHead && !entry.terminalAt);
    if (!current) return null;
    if (!isDeepStrictEqual(current, epoch)) return current;
    current.ownerObservedAt = new Date(now).toISOString();
    current.ownerState = !isUnscopedCwp(current)
      && current.ownerState === 'absent-unfenced' && observed.ownerState === 'unknown'
      ? 'absent-unfenced' : observed.ownerState;
    current.ownerLaunch = observed.ownerLaunch || null;
    // REPAIROWNERSCOPE-01: a legacy reservation has no dispatch scope. Once its
    // owner resolves, record the scope the owner's own launch record names, once.
    // An unresolved owner derives nothing and stays on the overdue escalation path.
    if (observed.ownerProjectRef && ['live', 'terminal'].includes(observed.ownerState)
      && !Object.hasOwn(current, 'dispatchProjectRef')) {
      current.dispatchProjectRef = observed.ownerProjectRef;
      current.dispatchProjectDerivedAt = current.ownerObservedAt;
    }
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
    if (publisherObservation) current.publisherObservation = publisherObservation;
    else if (publicationHead || observed.ownerState === 'live') delete current.publisherObservation;
    return current;
  });
  if (reconciled?.ownerState === 'absent-unfenced') {
    const action = isUnscopedCwp(reconciled)
      ? 'Operator must verify custody and use the CWP enqueue fence and retirement procedure; an operator PR update cannot supersede this unscoped reservation. Use --ledger-absence when the original boot evidence is unavailable.'
      : 'Operator must inspect the submitter and key before releasing custody.';
    await observeWait({ rootDir, repo, prNumber, headSha: `${reconciled.baseHead}:${reconciled.id}`,
      waitClass: 'repair-absent-unfenced', immediate: true, now,
      reason: `Repair reservation ${reconciled.id} has repeated dispatch absence without an enqueue fence. ${action}` });
  }
  if (reconciled?.publisherObservation?.operatorRequired) {
    await observeWait({ rootDir, repo, prNumber,
      headSha: `${reconciled.publisherObservation.headSha}:${reconciled.id}`,
      waitClass: 'repair-publication-unproven', immediate: true, now,
      reason: `Terminal repair ${reconciled.id} has unproven publication identity; operator must inspect the attestation before releasing custody.` });
  } else if (repairOwnerProofOverdue(reconciled) && SHA.test(headSha)) {
    await observeWait({ rootDir, repo, prNumber, headSha: `${reconciled.baseHead || headSha}:${reconciled.id}`,
      waitClass: 'repair-owner-unproven', immediate: true, now,
      reason: `Repair reservation ${reconciled.id} blocks review of ${headSha.toLowerCase()}. ` +
        'Dispatch ownership is unproven. Establish launch and retry evidence or fence the original submitter through authorized recovery. '
        + repairOwnerOperatorText(reconciled, repo) });
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
  now = new Date().toISOString(), dispatchProjectRef, terminalOwner = null, ownerSnapshot = null,
  operatorAbsence = null, requireReadPreflight = false }) {
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
        && !epoch.reviewHead && !epoch.terminalAt && sameReservationSnapshot(epoch, ownerSnapshot));
    const pending = epochs.find(epoch => epoch !== ended && !epoch.reviewHead && !epoch.terminalAt);
    const superseded = !replay && pending && operatorAbsence?.ownerState === 'absent'
      && pending.ownerState === 'absent-unfenced' && pending.absentObservations >= 2
      && Date.parse(pending.ownerObservedAt) - Date.parse(pending.reservedAt) >= REPAIR_ABSENCE_ESCALATE_MS
      && !pending.publicationHead && !pending.publicationLaunch
      && operatorAbsence.id === pending.id && sameSupersessionSnapshot(pending, ownerSnapshot);
    // A legacy CWP submitter may already have passed its reservation check.
    // Canonical absence cannot replace the committed enqueue-fence procedure.
    if (superseded && isUnscopedCwp(pending)) {
      return { ok: false, reason: 'repair-cwp-enqueue-fence-required', epoch: pending };
    }
    // Ask the native caller to prove the pair only when this transaction
    // would mint a new epoch. Leave even a terminal predecessor untouched
    // until the caller returns and the same snapshot is checked again.
    if (requireReadPreflight && (superseded || !replay && !pending && epochs.length < REPAIR_EPOCH_CAP)) {
      return { ok: false, reason: REPAIR_READ_PREFLIGHT_REQUIRED };
    }
    if (ended) {
      ended.terminalAt = now;
      ended.terminalLaunch = terminalOwner.ownerLaunch;
    }
    if (replay && !sameIdentity(replay.baseHead, headSha)) return { ok: false, reason: 'repair-head-mismatch' };
    if (replay) return replay.terminalAt
      ? { ok: false, reason: 'repair-worker-terminal', epoch: replay }
      : { ok: true, epoch: replay, replayed: true };
    if (pending && !superseded) return { ok: false, reason: 'repair-owned', epoch: pending };
    if (!superseded && epochs.length >= REPAIR_EPOCH_CAP) return { ok: false, reason: 'repair-epoch-cap', epochs };
    const epoch = { id: `repair-${randomUUID()}`, ownerKey, baseHead: headSha, cause,
      reservedAt: now, reviewHead: null,
      ...(dispatchProjectRef === undefined ? {} : { dispatchProjectRef }),
      priorSpend: { series: ledger.attemptCount || 0, head: ledger.targetAttemptCount || 0,
        lifetime: ledger.lifetimeAttemptCount || 0 },
      refundedSpend: ledger.selfErrorRefunds || {} };
    if (superseded) {
      pending.terminalAt = now;
      // The successor LRQ does not exist yet. The dispatch key identifies it
      // and its retry family through the same canonical lookup as ownerKey.
      pending.supersededBy = { kind: 'operator-repair', launch: ownerKey, at: now };
      epoch.supersedesEpochId = pending.id;
    }
    epochs.push(epoch);
    return { ok: true, epoch };
  }, { shouldWrite: result => result.reason !== REPAIR_READ_PREFLIGHT_REQUIRED });
}

// Called under the closer-intent lock after the paired owner lookup. This
// compare-and-read cannot create, retire, refresh or transfer an epoch.
export function replayUnenqueuedRepairEpoch({ rootDir, repo, prNumber, headSha,
  ownerKey, dispatchProjectRef, recoveryEpochId, ownerSnapshot }) {
  return mutateRepairEpochs(rootDir, { repo, prNumber }, ledger => {
    const pending = (ledger.repairEpochs || []).filter(epoch => !epoch.reviewHead && !epoch.terminalAt);
    const [epoch] = pending;
    return pending.length === 1 && epoch.id === recoveryEpochId && epoch.ownerKey === ownerKey
      && epoch.dispatchProjectRef === dispatchProjectRef && sameIdentity(epoch.baseHead, headSha)
      && epoch.ownerLaunch == null && epoch.publicationHead == null && epoch.publicationLaunch == null
      && [undefined, null, 'unknown', 'absent', 'absent-unfenced'].includes(epoch.ownerState)
      && sameReservationSnapshot(epoch, ownerSnapshot)
      ? { ok: true, epoch, replayed: true }
      : { ok: false, reason: 'reservation-changed' };
  }, { shouldWrite: () => false });
}

export function pendingRepairEpoch(rootDir, identity) {
  const ledger = readHammerRetryCapLedger(rootDir, identity);
  if (ledger?.__corrupt) throw new Error('repair ledger unreadable');
  return ledger?.repairEpochs?.findLast(epoch => !epoch.reviewHead && !epoch.terminalAt) || null;
}

export function repairEpochDeadline(epoch, ...anchors) {
  const reservedAt = Date.parse(epoch?.reservedAt);
  return Math.max(reservedAt, ...anchors.filter(Number.isFinite)) + AMA_CLOSER_DISPATCHED_LEASE_RECLAIM_AGE_MS;
}

// An already attested publication can lose its execution reservation without
// claiming review of the new head. An unproven moved head still needs the
// existing publication/foreign-head reconciliation.
export function repairEpochMayExpire(epoch, headSha, now = Date.now(), deadlineMs = 0) {
  return Boolean(epoch && !epoch.reviewHead && !epoch.terminalAt && !repairOperatorHoldReason(epoch)
    && (sameIdentity(epoch.baseHead, headSha) || sameIdentity(epoch.publicationHead, headSha))
    && closureOwnerOverdue(Math.max(deadlineMs, repairEpochDeadline(epoch)), now));
}

export async function reclaimExpiredRepairOwner({ rootDir, repo, prNumber, headSha, epochId, now = Date.now(), deadlineMs,
  logger = console, ...options }) {
  const identity = { repo, prNumber };
  const epoch = repairEpochObservation(rootDir, identity).repairEpoch;
  if ((epochId && epochId !== epoch?.id) || !repairEpochMayExpire(epoch, headSha, now, deadlineMs)) return null;
  const observed = await observeRepairOwner({ rootDir, ...identity, epoch, now, logger, expiry: true, ...options });
  if (!observed?.ownerStopped) return null;
  return mutateRepairEpochs(rootDir, identity, ledger => {
    const current = ledger.repairEpochs?.findLast(entry => !entry.reviewHead && !entry.terminalAt);
    if (!current || !sameReservationSnapshot(current, epoch)) return null;
    const at = new Date(now).toISOString();
    Object.assign(current, { ownerObservedAt: at, ownerState: 'terminal', ownerLaunch: observed.ownerLaunch,
      terminalAt: at, terminalLaunch: observed.ownerLaunch, terminalReason: 'owner-expired' });
    return current;
  }, { shouldWrite: Boolean });
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
