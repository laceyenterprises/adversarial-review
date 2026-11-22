import { isDeepStrictEqual } from 'node:util';
import { launchProbe, readDispatchLaunches } from '../dispatch-read-client.mjs';
import { canonicalRepositoryArguments } from '../repository-names.mjs';
import { withRepositoryStateRead } from '../repository-state-lock.mjs';
import { readAmaAuditEntry } from './audit.mjs';
import { deleteAmaCloserLeaseIfCurrent, findLiveAmaCloserLease, readAmaCloserLease } from './closer-lease.mjs';
import { isPreReceiptIntent, readAmaCloserDispatchRecord } from './dispatch-record-read.mjs';
import { launchRequestMeaning, launchRequestOwned } from './launch-request-status.mjs';
import { closerLaunchMatches, withCloserIntentWriteLock } from './pre-receipt-intent.mjs';

const MAX_ALIAS_HEADS = 32;
const CLOSER_ALIAS_READ_TIMEOUT_MS = 45_000;
const NO_MERGE_STATUSES = new Set(['failed', 'canceled', 'superseded']);

function noMergeLaunch(row) {
  const meaning = launchRequestMeaning(row);
  return meaning.terminal && !meaning.succeeded && NO_MERGE_STATUSES.has(meaning.status);
}

function hasSuccess(record) {
  return [record?.outcome, record?.terminalOutcome, record?.lastObservedStatus, record?.terminalLaunchStatus]
    .some(status => status === 'succeeded' || status === 'merged');
}

function aliasHeads(lease) {
  const previous = Array.isArray(lease.supersededHeads) ? lease.supersededHeads : [];
  return [...new Set([lease.rekeyedFromHeadSha, ...previous])].filter(head => head && head !== lease.headSha);
}

// The immediate rekey predecessor can itself be an alias. Look only along
// the recorded lineage and require exactly one original receipt for this LRQ.
export function findReceiptedCloserAlias(rootDir, lease) {
  if (lease?.status !== 'dispatched' || !lease.lrqId || lease.lrqId === 'unknown') return null;
  const heads = aliasHeads(lease);
  if (heads.length === 0 || heads.length > MAX_ALIAS_HEADS) return null;
  const receipts = heads.map(headSha => readAmaCloserDispatchRecord(rootDir, { ...lease, headSha }))
    .filter((record, index) => record?.launchRequestId === lease.lrqId
      && record.headSha === heads[index] && record.repo === lease.repo && record.prNumber === lease.prNumber);
  if (receipts.length !== 1 || receipts[0].state !== 'launch-terminal') return null;
  return receipts[0];
}

/** Retire a carried lease using a fresh, authenticated exact LRQ and retry read. */
export async function recoverReceiptedCloserAlias({
  rootDir, lease, record, hqRoot = process.env.HQ_ROOT || rootDir, env = process.env, signal,
}) {
  const identity = { repo: lease.repo, prNumber: lease.prNumber, headSha: lease.headSha };
  const evidence = { launchRequestId: lease.lrqId, dispatchHeadSha: record.headSha, leaseHeadSha: lease.headSha };
  const held = (reason, fields) => ({ ...evidence, released: false, reason, ...fields });
  if (hasSuccess(record) || hasSuccess(lease)) return held('closer-success-retained');

  const answer = await readDispatchLaunches({ launch_request_ids: [lease.lrqId], include_retry_chain: true },
    { env, signal, timeoutMs: CLOSER_ALIAS_READ_TIMEOUT_MS });
  signal?.throwIfAborted();
  if (!answer.ok || answer.roots.length !== 1 || answer.roots[0] !== lease.lrqId) {
    return held('closer-read-unavailable', { timedOut: answer.timedOut === true });
  }
  const proof = launchProbe(answer, lease.lrqId, true);
  if (!proof.ok || proof.retryChain.length + 1 !== answer.rows.length) return held('closer-read-unavailable');
  if (!proof.row.target_repo || !proof.row.head_sha || !closerLaunchMatches(record, proof.row)) {
    return held('closer-launch-identity-mismatch');
  }
  if (launchRequestOwned(proof) !== false || ![proof.row, ...proof.retryChain].every(noMergeLaunch)) {
    return held('closer-owned-or-unsettled');
  }
  try {
    return withRepositoryStateRead(rootDir, () => {
      const canonicalIdentity = canonicalRepositoryArguments(rootDir, identity);
      return withCloserIntentWriteLock(rootDir, canonicalIdentity, null, () => settle(canonicalIdentity));
    });
  } catch (error) {
    return held(error.code === 'EBUSY' ? 'closer-owner-changed' : 'closer-settlement-unavailable');
  }

  function settle(canonicalIdentity) {
    const current = findLiveAmaCloserLease(rootDir, { ...canonicalIdentity, strict: true })?.lease;
    const currentReceipt = findReceiptedCloserAlias(rootDir, lease);
    const repos = new Set([identity.repo, canonicalIdentity.repo]);
    const currentHeadRecords = [...repos].map(repo =>
      readAmaCloserDispatchRecord(rootDir, { ...identity, repo }, { strict: true }));
    if (!isDeepStrictEqual(current, lease) || !isDeepStrictEqual(currentReceipt, record)
      || currentHeadRecords.some(row => isPreReceiptIntent(row)
        || (row?.state === 'dispatched' && row.launchRequestId !== lease.lrqId))) {
      return held('closer-owner-changed');
    }
    const previous = aliasHeads(lease);
    // An interrupted rekey can leave two files. Removing the destination
    // would make the shadowed source the live owner again.
    if (previous.some(headSha => {
      const prior = readAmaCloserLease(rootDir, { ...identity, headSha });
      return prior && !['terminal', 'handed-to-review'].includes(prior.status);
    })) return held('closer-rekey-incomplete');
    if (currentHeadRecords.some(hasSuccess) || [...repos].some(repo => [lease.headSha, ...previous].some(head =>
      readAmaAuditEntry(hqRoot, repo, lease.prNumber, head)?.status === 'succeeded'))) {
      return held('closer-success-retained');
    }
    if (!deleteAmaCloserLeaseIfCurrent(rootDir, lease, { exactSnapshot: true })) return held('closer-owner-changed');
    return { ...evidence, released: true, reason: 'terminal-closer-alias-released',
      launchStatus: launchRequestMeaning(proof.row).status, failureClass: proof.row.failure_class ?? null,
      source: proof.target.source };
  }
}
