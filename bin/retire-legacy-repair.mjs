import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, isDeepStrictEqual } from 'node:util';
import { findLiveAmaCloserLease } from '../src/ama/closer-lease.mjs';
import { hasUnsettledAmaCloserDispatch } from '../src/ama/dispatch-record-read.mjs';
import { updateHammerRetryCapLedger, withLockedHammerRetryCapLedger } from '../src/ama/hammer-retry-cap.mjs';
import { readMergeLeaseHolders } from '../src/ama/merge-lease.mjs';
import { tryAcquireCloserIntentLock } from '../src/ama/pre-receipt-intent.mjs';
import { readRepairFollowUpClaim } from '../src/repair-follow-up-claim.mjs';
import { withRepositoryStateRead } from '../src/repository-state-lock.mjs';
import { REPAIR_ABSENCE_ESCALATE_MS } from '../src/repair-epochs.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const HEAD = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const CWP_OWNER_KEY = /^cwp-[0-9a-f]{24}$/;
const REPO = /^[a-z0-9][a-z0-9-]*\/[a-z0-9_.-]+$/;
const EPOCH = /^repair-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const STATES = [undefined, null, 'unknown', 'absent', 'absent-unfenced'];
const LEDGER_ABSENCE = { kind: 'canonical-cwp-ledger-absence' };

/**
 * @typedef {{repo: string, prNumber: number, baseHead: string, epochId: string, ownerKey: string}
 *   & ({variant: 'legacy', handoffRound: number}
 *     | ({variant: 'cwp', currentHead: string}
 *       & ({ledgerAbsence: true} | {ledgerAbsence?: false, conflictWorkerId: string, bootTraceOffset: number})))} RetirementIdentity
 */

/** @param {RetirementIdentity} identity */
function readCanonicalProof(rootDir, identity) {
  const { repo, prNumber, baseHead, epochId, ownerKey } = identity;
  const provenance = identity.variant === 'cwp'
    ? [identity.currentHead, ...(identity.ledgerAbsence ? ['ledger-absence']
      : [identity.conflictWorkerId, String(identity.bootTraceOffset)])]
    : [String(identity.handoffRound)];
  const runtime = resolve(rootDir, '../../modules/worker-pool/lib/hq-python-runtime.sh');
  const env = { ...process.env, BASH_ENV: '', ENV: '', PYTHONNOUSERSITE: '1' };
  for (const key of ['PYTHONPATH', 'PYTHONHOME', 'PYTHONUSERBASE',
    'HQ_PYTHON3', 'HQ_PYTHON3_CANDIDATES_FOR_TEST']) delete env[key];
  try {
    // Keep the producer's checkout, import path and operator guard. The
    // command has no proof file, stdin, alternative reader or ledger path.
    const output = execFileSync('/bin/bash', ['-c',
      'source "$1" && shift && hq_exec_python3_runtime "$@"',
      'repair-fence-reader', runtime, join(rootDir, 'bin/read-legacy-repair-fence.py'),
      repo, String(prNumber), baseHead, epochId, ownerKey, ...provenance,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env, timeout: 65_000,
      killSignal: 'SIGKILL', maxBuffer: 32_768 });
    return JSON.parse(output);
  } catch (error) {
    const refusal = String(error.stderr ?? '').split(/\r?\n/).map(line => line.trim())
      .map(line => /^repair-fence-refused:([a-z][a-z0-9-]{0,119})$/.exec(line)).find(Boolean);
    if (error.status === 75 && refusal) throw new Error(refusal[0]);
    if (error.code === 'ETIMEDOUT') throw new Error('canonical-repair-fence-reader-timeout');
    throw new Error('canonical-committed-repair-fence-or-current-evidence-unavailable');
  }
}

function pendingRepairReservation(ledger, { repo, prNumber, baseHead, epochId, ownerKey, variant }) {
  if (!ledger) return null;
  const epochs = ledger.repairEpochs;
  if (ledger.repo !== repo || ledger.prNumber !== prNumber || !Array.isArray(epochs)
    || epochs.some(epoch => !epoch || typeof epoch !== 'object'
      || (epoch.reviewHead != null && !/^[0-9a-f]{40}$/i.test(epoch.reviewHead))
      || (epoch.terminalAt != null && !Number.isFinite(Date.parse(epoch.terminalAt))))) return null;
  const pending = epochs.filter(epoch => epoch.reviewHead == null && epoch.terminalAt == null);
  const [epoch] = pending;
  return pending.length === 1 && epoch.id === epochId && epoch.ownerKey === ownerKey && epoch.baseHead === baseHead
    && (variant !== 'cwp' || epoch.cause === 'conflict-without-owner')
    && Number.isFinite(Date.parse(epoch.reservedAt))
    && epochs.filter(entry => entry.ownerKey === ownerKey || entry.id === epochId).length === 1
    && !Object.hasOwn(epoch, 'dispatchProjectRef') && !Object.hasOwn(epoch, 'enqueueFenceReceipt')
    && STATES.includes(epoch.ownerState) && epoch.ownerLaunch == null && epoch.publicationHead == null
    && epoch.publicationLaunch == null && epoch.publisherObservation == null && epoch.terminalLaunch == null
    && epoch.terminalReason == null && (epoch.retryLaunches == null || isDeepStrictEqual(epoch.retryLaunches, []))
    ? epoch : null;
}

function requireSameHeadNativeAbsence(epoch) {
  if (epoch.ownerState !== 'absent-unfenced'
    || !Number.isSafeInteger(epoch.absentObservations) || epoch.absentObservations < 2) {
    throw new Error('same-head-native-absence-unproven');
  }
}

/** @param {RetirementIdentity} identity */
function matchesProof(proof, epoch, identity) {
  const { repo, prNumber, ownerKey, variant } = identity;
  const evidence = proof?.evidence;
  const submitter = evidence?.submitter;
  const cwp = variant === 'cwp';
  if (proof?.version !== 1 || proof.kind !== `${variant}-repair-retirement-proof`
    || !(Date.parse(proof.recordedAt) >= Date.parse(epoch.reservedAt))
    || evidence?.repo !== repo || evidence.prNumber !== prNumber || evidence.baseHead !== epoch.baseHead
    || evidence.epochId !== epoch.id || evidence.ownerKey !== ownerKey || evidence.reservedAt !== epoch.reservedAt
    || typeof evidence.operator !== 'string' || evidence.operator.trim() === ''
    || !DIGEST.test(evidence.reservationSha256)
    || !isDeepStrictEqual(proof.absenceProof, {
      kind: 'canonical-repair-owner-family-absence',
      selector: { idempotency_key: ownerKey, ...(cwp ? { repair_epoch_id: epoch.id } : {}) },
      scope: 'all-canonical-launches',
    })
    || !isDeepStrictEqual(proof.enqueueFence, {
      kind: 'canonical-repair-owner-family-fence', ownerKey, ...(cwp ? { epochId: epoch.id } : {}),
    })) return false;
  if (cwp) {
    if (evidence.currentHead !== identity.currentHead
      || typeof evidence.branch !== 'string' || evidence.branch.trim() === '') return false;
    if (identity.ledgerAbsence) {
      return isDeepStrictEqual(submitter, LEDGER_ABSENCE)
        && (identity.currentHead !== identity.baseHead || evidence.ownerState === 'absent-unfenced')
        && Date.parse(proof.recordedAt) - Date.parse(epoch.reservedAt) >= REPAIR_ABSENCE_ESCALATE_MS;
    }
    return submitter?.kind === 'native-auto-merge-conflict-dispatch'
      && submitter.workerId === identity.conflictWorkerId && submitter.bootTraceOffset === identity.bootTraceOffset
      && [submitter.jobSha256, submitter.resultSha256, submitter.bootTraceSha256]
        .every(digest => typeof digest === 'string' && DIGEST.test(digest));
  }
  return DIGEST.test(submitter?.sha256)
    && submitter.kind === 'native-merge-rescue-handoff' && typeof submitter.file === 'string' && submitter.file !== ''
    && /^mar-[a-z]-[0-9TZ-]+-[0-9a-f]{6}$/.test(submitter.runId)
    && submitter.provenanceRef === `merge-agent-rescue:${repo}#${prNumber}:${submitter.runId}`;
}

function withRetirementIntent(rootDir, identity, read) {
  return withRepositoryStateRead(rootDir, () => {
    const unlock = tryAcquireCloserIntentLock(rootDir, identity);
    if (!unlock) throw new Error('closer-submission-owned');
    try { return read(); } finally { unlock(); }
  });
}

function checkCompetingCustody(rootDir, identity) {
  const claim = readRepairFollowUpClaim(rootDir, { ...identity, requireUnowned: true });
  if (!claim.ok) throw new Error(claim.reason);
  if (findLiveAmaCloserLease(rootDir, { ...identity, strict: true })
    || hasUnsettledAmaCloserDispatch(rootDir, identity)
    || readMergeLeaseHolders({ rootDir, ...identity }).length) throw new Error('closer-owned-or-unknown');
}

function requireAbsenceGrace(epoch) {
  if (Date.now() - Date.parse(epoch.reservedAt) < REPAIR_ABSENCE_ESCALATE_MS) {
    throw new Error('repair-reservation-grace-active');
  }
}

// LAC-2427 calls this readiness probe under the native submission key lock,
// including during canonical apply. Only the producer can commit a fence.
export function inspectSameHeadRepairRetirement(rootDir, evidence) {
  const { repo, prNumber, baseHead, currentHead, epochId, ownerKey, reservedAt,
    operator, branch, reservationSha256, submitter, ownerState } = evidence ?? {};
  if (![repo, baseHead, currentHead, epochId, ownerKey, reservedAt, operator, branch, reservationSha256]
    .every(value => typeof value === 'string')
    || !REPO.test(repo) || !Number.isInteger(prNumber) || prNumber < 1 || prNumber > 2 ** 31 - 1
    || !HEAD.test(baseHead) || baseHead !== currentHead || !EPOCH.test(epochId) || !CWP_OWNER_KEY.test(ownerKey)
    || !operator.trim() || !branch.trim() || !DIGEST.test(reservationSha256)
    || !Number.isFinite(Date.parse(reservedAt)) || ownerState !== 'absent-unfenced'
    || !isDeepStrictEqual(submitter, LEDGER_ABSENCE)) {
    throw new Error('same-head-retirement-evidence-incompatible');
  }
  const identity = { repo, prNumber, baseHead, currentHead, epochId, ownerKey, variant: 'cwp', ledgerAbsence: true };
  return withRetirementIntent(rootDir, identity, () =>
    withLockedHammerRetryCapLedger(rootDir, identity, ledger => {
      const epoch = pendingRepairReservation(ledger, identity);
      if (!epoch || epoch.reservedAt !== reservedAt) throw new Error('same-head-retirement-reservation-mismatch');
      requireSameHeadNativeAbsence(epoch);
      requireAbsenceGrace(epoch);
      checkCompetingCustody(rootDir, identity);
      return 'ready';
    }));
}

/** @param {RetirementIdentity} identity */
function retireLegacyRepair(rootDir, identity) {
  return withRetirementIntent(rootDir, identity, () => {
    let retired;
    const written = updateHammerRetryCapLedger(rootDir, identity, ledger => {
      const epoch = pendingRepairReservation(ledger, identity);
      if (!epoch) throw new Error(`${identity.variant}-repair-reservation-mismatch`);
      if (identity.variant === 'cwp' && identity.ledgerAbsence) {
        if (identity.currentHead === identity.baseHead) requireSameHeadNativeAbsence(epoch);
        requireAbsenceGrace(epoch);
      }
      checkCompetingCustody(rootDir, identity);
      const proof = readCanonicalProof(rootDir, identity);
      if (!matchesProof(proof, epoch, identity)) throw new Error('committed-enqueue-fence-proof-mismatch');
      checkCompetingCustody(rootDir, identity);
      // The live PR and reservation were rechecked by the reader while
      // holding both PR locks. Keep every historical epoch and spend field.
      epoch.terminalAt = new Date().toISOString();
      epoch.terminalReason = 'canonical-enqueue-fenced';
      epoch.enqueueFenceReceipt = proof;
      retired = epoch;
      return ledger;
    });
    if (!written) throw new Error('repair-ledger-unavailable');
    return { ok: true, epoch: retired };
  });
}

/** @returns {RetirementIdentity} */
function parseIdentity(args) {
  const { values } = parseArgs({ args, options: {
    repo: { type: 'string' }, pr: { type: 'string' }, 'base-head': { type: 'string' },
    epoch: { type: 'string' }, 'owner-key': { type: 'string' }, 'handoff-round': { type: 'string' },
    'current-head': { type: 'string' }, 'conflict-worker-id': { type: 'string' },
    'boot-trace-offset': { type: 'string' },
    'ledger-absence': { type: 'boolean' },
    apply: { type: 'boolean' },
  } });
  const { repo, pr, epoch: epochId, 'base-head': baseHead, 'owner-key': ownerKey, 'handoff-round': round,
    'current-head': currentHead, 'conflict-worker-id': conflictWorkerId, 'boot-trace-offset': offset } = values;
  const validNumber = value => /^[1-9]\d{0,9}$/.test(value) && Number(value) <= 2 ** 31 - 1;
  const required = 'required: --apply --repo --pr --base-head --epoch --owner-key';
  if (!values.apply || !REPO.test(repo) || !validNumber(pr)
    || !HEAD.test(baseHead) || !EPOCH.test(epochId)) {
    throw new Error(`${required} with an exact reservation selector`);
  }
  const common = { repo, prNumber: Number(pr), baseHead, epochId, ownerKey };
  if (CWP_OWNER_KEY.test(ownerKey)) {
    const workerId = new RegExp(`^codex-conflict-pr-${pr}-rebase-[0-9a-f]{8}$`);
    const cwpRequired = `${required} --current-head and either --ledger-absence or --conflict-worker-id --boot-trace-offset (exact CWP selector)`;
    if (round !== undefined || !HEAD.test(currentHead)) throw new Error(cwpRequired);
    if (values['ledger-absence']) {
      if (conflictWorkerId !== undefined || offset !== undefined) throw new Error(cwpRequired);
      return { ...common, variant: 'cwp', currentHead, ledgerAbsence: true };
    }
    // The receipt is retained in the Node JSON ledger. A lossy offset would
    // change the evidence recorded there even if the reader proved it exactly.
    if (currentHead === baseHead || !workerId.test(conflictWorkerId) || !/^(?:0|[1-9]\d{0,15})$/.test(offset)
      || !Number.isSafeInteger(Number(offset))) {
      throw new Error(cwpRequired);
    }
    return { ...common, variant: 'cwp', currentHead, conflictWorkerId, bootTraceOffset: Number(offset) };
  }
  if (values['ledger-absence'] || !/^in-place-repair-[0-9a-f]{64}$/.test(ownerKey) || !validNumber(round)
    || [currentHead, conflictWorkerId, offset].some(value => value !== undefined)) {
    throw new Error(`${required} --handoff-round`);
  }
  return { ...common, variant: 'legacy', handoffRound: Number(round) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    console.log(JSON.stringify(retireLegacyRepair(ROOT, parseIdentity(process.argv.slice(2)))));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 75;
  }
}
