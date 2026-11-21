import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, isDeepStrictEqual } from 'node:util';
import { findLiveAmaCloserLease } from '../src/ama/closer-lease.mjs';
import { isPreReceiptIntent, readAmaCloserDispatchRecordsForPR } from '../src/ama/dispatch-record-read.mjs';
import { updateHammerRetryCapLedger } from '../src/ama/hammer-retry-cap.mjs';
import { readMergeLeaseHolders } from '../src/ama/merge-lease.mjs';
import { tryAcquireCloserIntentLock } from '../src/ama/pre-receipt-intent.mjs';
import { readRepairFollowUpClaim } from '../src/repair-follow-up-claim.mjs';
import { withRepositoryStateRead } from '../src/repository-state-lock.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const HEAD = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const STATES = [undefined, null, 'unknown', 'absent', 'absent-unfenced'];

function readCanonicalProof(rootDir, { repo, prNumber, baseHead, epochId, ownerKey, handoffRound }) {
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
      repo, String(prNumber), baseHead, epochId, ownerKey, String(handoffRound),
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

function pendingLegacyEpoch(ledger, { repo, prNumber, baseHead, epochId, ownerKey }) {
  const epochs = ledger.repairEpochs;
  if (ledger.repo !== repo || ledger.prNumber !== prNumber || !Array.isArray(epochs)
    || epochs.some(epoch => !epoch || typeof epoch !== 'object'
      || (epoch.reviewHead != null && !/^[0-9a-f]{40}$/i.test(epoch.reviewHead))
      || (epoch.terminalAt != null && !Number.isFinite(Date.parse(epoch.terminalAt))))) return null;
  const pending = epochs.filter(epoch => epoch.reviewHead == null && epoch.terminalAt == null);
  const [epoch] = pending;
  return pending.length === 1 && epoch.id === epochId && epoch.ownerKey === ownerKey && epoch.baseHead === baseHead
    && Number.isFinite(Date.parse(epoch.reservedAt))
    && epochs.filter(entry => entry.ownerKey === ownerKey || entry.id === epochId).length === 1
    && !Object.hasOwn(epoch, 'dispatchProjectRef') && !Object.hasOwn(epoch, 'enqueueFenceReceipt')
    && STATES.includes(epoch.ownerState) && epoch.ownerLaunch == null && epoch.publicationHead == null
    && epoch.publicationLaunch == null && epoch.publisherObservation == null && epoch.terminalLaunch == null
    && epoch.terminalReason == null && (epoch.retryLaunches == null || isDeepStrictEqual(epoch.retryLaunches, []))
    ? epoch : null;
}

function matchesProof(proof, epoch, { repo, prNumber, ownerKey }) {
  const evidence = proof?.evidence;
  const submitter = evidence?.submitter;
  return proof?.version === 1 && proof.kind === 'legacy-repair-retirement-proof'
    && Date.parse(proof.recordedAt) >= Date.parse(epoch.reservedAt)
    && evidence?.repo === repo && evidence.prNumber === prNumber && evidence.baseHead === epoch.baseHead
    && evidence.epochId === epoch.id && evidence.ownerKey === ownerKey && evidence.reservedAt === epoch.reservedAt
    && typeof evidence.operator === 'string' && evidence.operator.trim() !== ''
    && DIGEST.test(evidence.reservationSha256) && DIGEST.test(submitter?.sha256)
    && submitter.kind === 'native-merge-rescue-handoff' && typeof submitter.file === 'string' && submitter.file !== ''
    && /^mar-[a-z]-[0-9TZ-]+-[0-9a-f]{6}$/.test(submitter.runId)
    && submitter.provenanceRef === `merge-agent-rescue:${repo}#${prNumber}:${submitter.runId}`
    && isDeepStrictEqual(proof.absenceProof, {
      kind: 'canonical-repair-owner-family-absence', selector: { idempotency_key: ownerKey },
      scope: 'all-canonical-launches',
    })
    && isDeepStrictEqual(proof.enqueueFence, { kind: 'canonical-repair-owner-family-fence', ownerKey });
}

function retireLegacyRepair(rootDir, identity) {
  return withRepositoryStateRead(rootDir, () => {
    const unlock = tryAcquireCloserIntentLock(rootDir, identity);
    if (!unlock) throw new Error('closer-submission-owned');
    const checkCompetingCustody = () => {
      const claim = readRepairFollowUpClaim(rootDir, { ...identity, requireUnowned: true });
      if (!claim.ok) throw new Error(claim.reason);
      if (findLiveAmaCloserLease(rootDir, { ...identity, strict: true })
        || readAmaCloserDispatchRecordsForPR(rootDir, { ...identity, strict: true }).some(record =>
          !record.state || record.state === 'dispatched' || isPreReceiptIntent(record))
        || readMergeLeaseHolders({ rootDir, ...identity }).length) throw new Error('closer-owned-or-unknown');
    };
    try {
      let retired;
      const written = updateHammerRetryCapLedger(rootDir, identity, ledger => {
        const epoch = pendingLegacyEpoch(ledger, identity);
        if (!epoch) throw new Error('legacy-repair-reservation-mismatch');
        checkCompetingCustody();
        const proof = readCanonicalProof(rootDir, identity);
        if (!matchesProof(proof, epoch, identity)) throw new Error('committed-enqueue-fence-proof-mismatch');
        checkCompetingCustody();
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
    } finally { unlock(); }
  });
}

function parseIdentity(args) {
  const { values } = parseArgs({ args, options: {
    repo: { type: 'string' }, pr: { type: 'string' }, 'base-head': { type: 'string' },
    epoch: { type: 'string' }, 'owner-key': { type: 'string' }, 'handoff-round': { type: 'string' },
    apply: { type: 'boolean' },
  } });
  const { repo, pr, epoch: epochId, 'base-head': baseHead, 'owner-key': ownerKey, 'handoff-round': round } = values;
  const validNumber = value => /^[1-9]\d{0,9}$/.test(value) && Number(value) <= 2 ** 31 - 1;
  if (!values.apply || !/^[a-z0-9][a-z0-9-]*\/[a-z0-9_.-]+$/.test(repo) || !validNumber(pr)
    || !HEAD.test(baseHead) || !/^repair-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(epochId)
    || !/^in-place-repair-[0-9a-f]{64}$/.test(ownerKey) || !validNumber(round)) {
    throw new Error('required: --apply --repo --pr --base-head --epoch --owner-key --handoff-round');
  }
  return { repo, prNumber: Number(pr), baseHead, epochId, ownerKey, handoffRound: Number(round) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    console.log(JSON.stringify(retireLegacyRepair(ROOT, parseIdentity(process.argv.slice(2)))));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 75;
  }
}
