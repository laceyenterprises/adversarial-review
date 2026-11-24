// Mechanical final-remediation coverage validation. No model or re-review.
// Evidence is read by a trusted composition adapter, never from the submitter.
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { resolveLaneKey } from './ledger-events.mjs';
import { queueId } from './queue-store.mjs';
import { reviewCurrencyCovers } from '../ama/review-currency.mjs';
import { hasConcreteExactHeadEvidence } from '../ama/hammer-adjudication.mjs';
import { hasCompletedUnknownValidationEvidence } from '../ama/local-validation-unknown.mjs';

const sha = /^[a-f0-9]{40}$/i;
const text = value => typeof value === 'string' && value.trim().length > 0;
// Distinguish rejected receipt evidence from adapter/runtime failures.
export class QueueReceiptValidationError extends Error {}
const requireFact = (condition, reason) => { if (!condition) throw new QueueReceiptValidationError(`handoff: ${reason}`); };

// Canonical JSON makes transport object-key order irrelevant, retaining array
// order and every signed field. Reject non-JSON input rather than hash a lossy copy.
export function handoffJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + Array.from(value, handoffJson).join(',') + ']';
  const proto = value && Object.getPrototypeOf(value);
  if (value && (proto === Object.prototype || proto === null)) {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + handoffJson(value[key])).join(',') + '}';
  }
  throw new TypeError('handoff requires JSON data');
}
export const handoffDigest = value => createHash('sha256').update(handoffJson(value)).digest('hex');

export function normalizeQueueHandoff(input) {
  const h = JSON.parse(handoffJson(input));
  requireFact(h?.schemaVersion === 1, 'unsupported schema');
  h.lane = resolveLaneKey(h.lane);
  queueId(h.handoffId);
  requireFact(Number.isSafeInteger(h.prNumber) && h.prNumber > 0
    && Number.isSafeInteger(h.admissionGeneration) && h.admissionGeneration > 0 && sha.test(h.head), 'invalid admission');
  for (const identity of [h.worker, h.closer]) {
    requireFact(identity && ['workerId', 'workerClass', 'launchRequestId'].every(key => text(identity[key])), 'invalid identity');
  }
  requireFact(text(h.sourceReview?.id) && sha.test(h.sourceReview?.commitId), 'invalid source review');
  requireFact(text(h.attestations?.produced) && text(h.attestations?.reviewed), 'missing attestation references');
  requireFact(text(h.primaryChange?.intent) && text(h.primaryChange?.sourceRef), 'missing primary-change provenance');
  requireFact(h.localValidation?.head === h.head && text(h.localValidation?.sourceRef), 'missing local validation');
  requireFact(h.publication?.head === h.head && text(h.publication?.sourceRef), 'missing publication');
  requireFact(Array.isArray(h.dispositions), 'missing finding dispositions');
  // MRQ-21: a hammer handoff is bound to the review evidence it relies on.
  // Optional, so receipts committed before this binding still validate.
  if (h.reviewProof !== undefined) {
    requireFact(/^[a-f0-9]{64}$/.test(h.reviewProof?.digest ?? '') && h.reviewProof.head === h.head, 'invalid review proof');
  }
  return h;
}

// A trusted read that local validation ended with no verdict (timed out,
// killed for load, process inspection denied). A real failure is never this.
// A separately verified direct clean admission has no Hammer battery. Its
// existing CI-only receipt still requires declared contexts at the merge gate.
export const queueLocalValidationUnknown = (evidence, { clean = false } = {}) =>
  evidence?.localValidation?.result === 'unknown' && (clean
    ? evidence.localValidation.ciAuthoritative === true && evidence.localValidation.localFailureObserved !== true
    : hasCompletedUnknownValidationEvidence(evidence.localValidation));

const findingKey = finding => handoffJson([finding.reviewId, finding.reviewCommitId, finding.findingId]);

/** Trusted evidence adapter contract:
 * - read the complete applicable finding inventory (blocking AND non-blocking),
 *   original review ids/commit_ids and currency at the exact pushed head;
 * - verify signatures via the identity/attestation surface, retaining original
 *   signed records; verify worker AND closer launch identities independently;
 * - read successful exact-head publication, primary-change and local validation.
 * A missing/unreadable/partial fact fails closed. No submitter-provided `valid`
 * field, markdown acknowledgement or exhausted budget substitutes for these reads.
 */
export function validateQueueHandoff(h, e, { clean = false } = {}) {
  requireFact(e && e.subject?.state === 'open' && isDeepStrictEqual(e.subject.lane, h.lane)
    && e.subject.prNumber === h.prNumber && e.subject.head === h.head && text(e.subject.sourceRef), 'subject currency');
  requireFact(e.review?.complete === true && e.review.id === h.sourceReview.id
    && e.review.commitId === h.sourceReview.commitId && text(e.review.reviewerIdentity)
    && text(e.review.sourceRef), 'source review currency');
  const current = (currency, head) => reviewCurrencyCovers(currency, head, h.head)
    && ['exact-head', 'ancestry', 'closer-rebase-provenance', 'reviewed-rebase-patch-id'].includes(currency.proof)
    && (currency.proof !== 'exact-head' || head === h.head) && text(currency.sourceRef);
  requireFact(current(e.currency, h.sourceReview.commitId), 'stale review commit');
  requireFact(e.identities?.ok === true && text(e.identities.sourceRef)
    && isDeepStrictEqual(e.identities.worker, h.worker) && isDeepStrictEqual(e.identities.closer, h.closer), 'unverified identity');
  for (const [kind, head] of [['produced', h.head], ['reviewed', h.sourceReview.commitId]]) {
    const a = e.attestations?.[kind];
    requireFact(a?.valid === true && a.ref === h.attestations[kind] && text(a.sourceRef)
      && a.record?.repo === h.lane.repository && a.record.pr_number === h.prNumber
      && a.record.kind === kind && a.record.head_sha === head && text(a.record.signature?.algorithm)
      && text(a.record.signature?.digest) && text(a.record.signature?.subject)
      && text(a.record.producer_identity), `invalid ${kind} attestation`);
    if (kind === 'produced') requireFact(a.record.payload?.launch_request_id === h.closer.launchRequestId
      && a.record.payload?.worker_class === h.closer.workerClass, 'produced identity mismatch');
    else requireFact(a.record.producer_identity === e.review.reviewerIdentity, 'reviewed identity mismatch');
  }
  if (h.reviewProof !== undefined) requireFact(e.reviewProof?.ok === true && e.reviewProof.head === h.head
    && e.reviewProof.digest === h.reviewProof.digest && text(e.reviewProof.sourceRef), 'review proof mismatch');
  requireFact(e.primaryChange?.ok === true && e.primaryChange.head === h.head
    && e.primaryChange.sourceRef === h.primaryChange.sourceRef && e.primaryChange.intent === h.primaryChange.intent, 'primary-change provenance');
  for (const kind of ['localValidation', 'publication']) {
    // MRQ-20: UNKNOWN local validation (no verdict) is admissible; the
    // executor's final gate then requires declared exact-candidate contexts.
    const read = kind === 'localValidation' && e[kind]?.result === 'unknown'
      ? queueLocalValidationUnknown(e, { clean }) : e[kind]?.ok === true;
    requireFact(read && e[kind].head === h.head && e[kind].sourceRef === h[kind].sourceRef, `failed ${kind}`);
  }
  requireFact(Array.isArray(e.review.findings), 'unknown finding inventory');
  const inventory = new Map();
  for (const f of e.review.findings) {
    requireFact(text(f.findingId) && text(f.reviewId) && sha.test(f.reviewCommitId)
      && ['blocking', 'non-blocking'].includes(f.severity) && text(f.sourceRef)
      && current(f.currency, f.reviewCommitId), 'invalid finding inventory');
    const key = findingKey(f);
    requireFact(!inventory.has(key), 'duplicate source finding');
    inventory.set(key, f);
  }
  const seen = new Set();
  for (const d of h.dispositions) {
    const key = findingKey(d), f = inventory.get(key);
    requireFact(f && !seen.has(key) && d.severity === f.severity, 'foreign or duplicate finding disposition');
    seen.add(key);
    requireFact(d.head === h.head && text(d.sourceRef), 'missing exact-head finding reference');
    if (d.resolution === 'deferred') {
      requireFact(f.severity === 'non-blocking' && e.strictNonBlockingRemediation === false, 'finding cannot be deferred');
      requireFact(h.reviewProof && d.sourceRef === e.reviewProof?.sourceRef, 'missing deferral audit reference');
      continue;
    }
    requireFact(hasConcreteExactHeadEvidence(d.evidence), 'missing exact-head finding evidence');
    requireFact(['fixed', 'withdrawn'].includes(d.resolution), 'unsupported finding disposition');
    if (d.resolution === 'fixed') requireFact(Array.isArray(d.paths) && d.paths.length > 0 && d.paths.every(text), 'fix paths missing');
    else requireFact(text(d.explanation) && Array.isArray(d.sourceLocations) && d.sourceLocations.length > 0
      && d.sourceLocations.every(location => text(location.path) && Number.isSafeInteger(location.line) && location.line > 0), 'unsupported withdrawal');
  }
  requireFact(seen.size === inventory.size, 'incomplete finding coverage');
  return true;
}
