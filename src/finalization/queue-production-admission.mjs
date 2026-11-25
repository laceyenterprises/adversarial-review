import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { resolveHomePath } from '../account-home.mjs';
import { isDeepStrictEqual } from 'node:util';
import { closerReviewProof } from '../ama/closer-review-proof.mjs';
import { readAmaCloserDispatchRecordsForPR } from '../ama/dispatch-record-read.mjs';
import { blockingFindingIdentity, hammerWithdrawalsFromComments, parseWithdrawalComment, readHammerWithdrawals } from '../ama/hammer-adjudication.mjs';
import { exactHammerValidation, hammerProvenanceEdge } from '../ama/hammer-head-validation.mjs';
import { checkPrimaryChange } from '../ama/primary-change.mjs';
import { amaReviewerFamilyForLogin } from '../ama/reviewer-authority.mjs';
import { deployAttestationVerifierEnv, readHeadAttestationChainForPr } from '../daemon-worker-identity.mjs';
import { findingEvidenceLocation } from '../kernel/review-findings.mjs';
import { normalizeReviewVerdict } from '../kernel/verdict.mjs';
import { isOperatorHeld } from '../operator-hold-labels.mjs';
import { buildHammerQueueHandoffRequest, hammerReviewProof } from './hammer-queue-handoff.mjs';
import { handoffDigest } from './queue-handoff.mjs';
import { cleanReview } from './queue-live.mjs';
import { queueWaitMs } from './queue-wait.mjs';

const exec = promisify(execFile);
const text = value => typeof value === 'string' && Boolean(value.trim());
const identityOf = record => ({ workerId: record.payload.worker_id ?? record.producer_identity,
  workerClass: record.payload.worker_class, launchRequestId: record.payload.launch_request_id });
const hasIdentity = record => record?.payload && Object.values(identityOf(record)).every(text);
const signedBody = row => {
  const { valid, ...record } = row;
  const ref = record.attestation_id ?? record.signature?.digest;
  if (!text(ref)) throw new Error('queue-attestation-reference-unavailable');
  return { valid, ref, record, sourceRef: `head-attestation:${ref}` };
};

export function validateHammerQueueRequest(request) {
  const canonical = buildHammerQueueHandoffRequest({ ...request, reviewProof: request?.reviewProof });
  if (!isDeepStrictEqual(request, canonical) || !isDeepStrictEqual(request.lane, request.reviewProof.lane)) {
    throw new Error('queue-hammer-request-invalid');
  }
  return canonical;
}

function requireOpen(context, head) {
  const { subject, pr } = context;
  if (subject.state !== 'open' || subject.head !== head || pr.draft !== false
    || !Array.isArray(subject.labels) || subject.labels.some(label => !text(typeof label === 'string' ? label : label?.name))
    || isOperatorHeld(subject.labels)) throw new Error('queue-admission-subject-ineligible');
}

function signedReview(rows, source) {
  const record = rows.find(row => row.kind === 'reviewed' && row.head_sha === source.row.commit_id
    && amaReviewerFamilyForLogin(row.producer_identity) === source.family
    && row.findings_count === source.findings.length
    && ([row.verdict, normalizeReviewVerdict(row.verdict)].includes(source.verdict)));
  if (!record) throw new Error('queue-source-review-attestation-unavailable');
  return signedBody(record);
}

// Sign the independently observed App publication as a service observation.
// The receipt retains this original signed record in the queue store. It does
// not write or replace a builder/worker attestation in the HQ ledger.
async function signHammerPublication({ request, audit, hqRoot, env, signal, timeoutMs }) {
  const { lane, prNumber, head, closer, reviewProof } = request;
  const payload = { source: 'finalization_queue_hammer_publication', launch_request_id: closer.launchRequestId,
    worker_id: closer.workerId, worker_class: closer.workerClass, review_proof_digest: reviewProof.digest,
    audit_comment_id: audit.id };
  const hqBin = env.HQ_BIN || resolveHomePath(env, '.local', 'bin', 'hq');
  if (!hqBin || !isAbsolute(hqBin)) throw new Error('queue-hammer-signer-unavailable');
  const { stdout } = await exec(hqBin, ['attest', 'sign', '--root', hqRoot, '--repo', lane.repository,
    '--pr', String(prNumber), '--head-sha', head, '--kind', 'produced', '--payload-json', JSON.stringify(payload)], {
    env: { ...deployAttestationVerifierEnv(env), HCP_SUBJECT: 'finalization-queue-v2' }, signal, timeout: timeoutMs,
    killSignal: 'SIGKILL', maxBuffer: 128 * 1024,
  });
  const record = JSON.parse(stdout);
  if (record?.kind !== 'produced' || record?.producer_identity !== 'finalization-queue-v2'
    || !isDeepStrictEqual(record.payload, payload)) throw new Error('queue-hammer-signature-unavailable');
  return signedBody({ ...record, valid: true });
}

function findAudit(current, request, launch) {
  const launchDigest = createHash('sha256').update(request.closer.launchRequestId).digest('hex');
  const matches = current.comments.filter(comment => {
    if (!Number.isSafeInteger(comment?.id) || comment.user?.type !== 'Bot' || !exactHammerValidation(comment, request.head)
      || !hammerProvenanceEdge(comment)?.validated || !String(comment.body).startsWith('<!-- hq:ham-terminal-remediation:audit -->')
      || !isDeepStrictEqual(String(comment.body).split(/\r?\n/).filter(line => line.startsWith('HAM-Queue-Launch-SHA256:')),
        [`HAM-Queue-Launch-SHA256: ${launchDigest}`])
      || !(Date.parse(comment.updated_at ?? comment.created_at) >= Date.parse(launch.dispatchedAt))) return false;
    return hammerReviewProof({ ...request, reviewedSha: request.reviewProof.reviewedSha,
      auditHead: request.head, auditBody: comment.body }).digest === request.reviewProof.digest;
  });
  if (matches.length !== 1) throw new Error('queue-exact-hammer-audit-unavailable');
  return matches[0];
}

async function findingDispositions({ rootDir, observed, inventory, audit, comments, launch, strictNonBlockingRemediation }) {
  const { subject, get } = observed;
  const repo = subject.lane.repository;
  const { prNumber, head } = subject;
  if (!inventory.length) return [];
  // Reuse the legacy audit parser, including the live-pack deferral exclusion.
  // Load it lazily so the receiver does not create a dispatch import cycle.
  const { buildHamTerminalRemediationEvidenceFromGroundTruth } = await import('../ama/dispatch-closer.mjs');
  const comparison = await get(`repos/${repo}/compare/${launch.reviewedSha}...${head}`);
  if (!['ahead', 'identical'].includes(comparison?.status) || !Array.isArray(comparison.files) || comparison.files.length >= 300) {
    throw new Error('queue-finding-change-inventory-unavailable');
  }
  const changed = comparison.files.map(file => file.filename);
  const reported = buildHamTerminalRemediationEvidenceFromGroundTruth({ verifiedCommit: { sha: head, changedFiles: changed },
    verifiedAuditComment: audit }).auditComment.findings ?? [];
  const withdrawals = readHammerWithdrawals({ rootDir, repo, prNumber, strict: true });
  const auditRef = `github:repos/${repo}/issues/comments/${audit.id}`;
  return inventory.map(finding => {
    const { reviewId, reviewCommitId, findingId, severity } = finding;
    const disposition = { reviewId, reviewCommitId, findingId, severity, head };
    const location = findingEvidenceLocation(finding);
    const admittedWithdrawal = comments.find(comment => hammerWithdrawalsFromComments([comment], withdrawals).some(record =>
      severity === 'blocking' && record.identity === blockingFindingIdentity(finding) && record.headSha === head
      && record.findingReviewedHead === reviewCommitId));
    if (admittedWithdrawal && location) {
      const evidence = String(admittedWithdrawal.body);
      return { ...disposition, resolution: 'withdrawn', sourceRef: `github:repos/${repo}/issues/comments/${admittedWithdrawal.id}`,
        explanation: parseWithdrawalComment(evidence).resolution,
        sourceLocations: location.ranges.map(range => ({ path: location.path, line: range.start })), evidence };
    }
    const matches = reported.filter(item => item.title === finding.title && item.blocking === (severity === 'blocking') && item.file);
    const repeated = inventory.some(other => other !== finding && other.title === finding.title && other.severity === severity);
    const match = matches.find(item => item.file === location?.path)
      ?? (!repeated && matches.length === 1 ? matches[0] : null);
    const file = match && comparison.files.find(file => file.filename === match.file);
    // Each addressed occurrence requires its own audit bullet.
    if (file && text(file.patch)) reported.splice(reported.indexOf(match), 1);
    if (!file || !text(file.patch)) {
      if (severity === 'non-blocking' && !strictNonBlockingRemediation) {
        return { ...disposition, resolution: 'deferred', sourceRef: auditRef };
      }
      throw new Error('queue-exact-finding-fix-unavailable');
    }
    const fence = '~'.repeat(Math.max(3, ...Array.from(file.patch.matchAll(/~+/g), match => match[0].length + 1)));
    return { ...disposition, resolution: 'fixed', sourceRef: auditRef, paths: [file.filename],
      evidence: `${fence}diff\n${file.patch}\n${fence}` };
  });
}

export function createQueueProductionEvidence({ rootDir, hqRoot, env = process.env, live,
  readChain = readHeadAttestationChainForPr, readDispatches = readAmaCloserDispatchRecordsForPR,
  sign = signHammerPublication, now = () => new Date().toISOString() }) {
  return async function observe({ lane, prNumber, head, request, cfg, deadline, admissionGeneration = 1, signal: parentSignal }) {
    const timeoutMs = queueWaitMs(15_000, { ceilingMs: 60_000, deadline, now: now() });
    if (!timeoutMs) throw new Error('queue-admission-deadline-expired');
    const timerSignal = AbortSignal.timeout(timeoutMs);
    const signal = parentSignal ? AbortSignal.any([timerSignal, parentSignal]) : timerSignal;
    const started = performance.now();
    const budget = () => {
      signal.throwIfAborted();
      return { signal, timeoutMs: Math.max(1, Math.floor(timeoutMs - (performance.now() - started))) };
    };
    const repo = lane.repository;
    const observed = await live.snapshot(lane, prNumber, budget());
    requireOpen(observed, head);
    const rows = (await readChain({ repo, prNumber, rootDir, hqRoot, env, useDeployVerifier: true,
      retryDelaysMs: [], ...budget() })).filter(row => row.valid === true && row.repo === repo && row.pr_number === prNumber);
    const reviews = await live.reviews(observed);
    const inventory = reviews.applicable.flatMap(review => review.findings);
    const strictNonBlockingRemediation = cfg.strictNonBlockingRemediation !== false;
    const source = request ? reviews.applicable.find(record => record.row.commit_id === request.reviewProof.reviewedSha) : reviews.applicable[0];
    if (!source || (!request && (source.row.commit_id !== head || !cleanReview(source) || inventory.length))) {
      throw new Error('queue-admission-review-unavailable');
    }
    const reviewed = signedReview(rows, source);
    // Produced approver evidence is exact-head for clean admission. On a
    // remediated handoff the builder remains the original signed PR opener.
    const builder = rows.find(row => row.kind === 'produced' && hasIdentity(row)
      && (request ? row.payload.source === 'hq_pr_open' : row.head_sha === head));
    if (!builder) throw new Error('queue-builder-identity-unavailable');
    const worker = identityOf(builder);
    const primary = await live.primary(observed, budget(), builder.head_sha);
    if (!checkPrimaryChange(primary, head, { strictNonBlockingRemediation: cfg.strictNonBlockingRemediation }).ok) {
      throw new Error('queue-primary-change-unverified');
    }
    const builderAttestation = signedBody(builder);
    let produced = builderAttestation, validation = { head, result: 'unknown', ciAuthoritative: true, sourceRef: produced.sourceRef };
    let publication = { ok: true, head, sourceRef: observed.subject.sourceRef };
    let dispositions = [], closer = worker, proof;
    if (request) {
      closer = request.closer;
      const records = readDispatches(rootDir, { repo, prNumber, strict: true });
      const launch = records.find(record => record.launchRequestId === closer.launchRequestId && record.workerId === closer.workerId
        && record.dispatchWorkerClass === closer.workerClass && record.reviewedSha === request.reviewProof.reviewedSha
        && record.state === 'dispatched' && !record.launchRequestIdIsDispatchFallback);
      if (!launch) throw new Error('queue-closer-launch-unverified');
      const audit = findAudit(reviews, request, launch);
      const terminal = await closerReviewProof({ snapshot: reviews.snapshot, repo, prNumber, rootDir, headSha: head,
        validatedAt: audit.updated_at ?? audit.created_at, operatorLogins: cfg.operatorLogins, get: observed.get });
      if (!terminal.ok) throw new Error('queue-hammer-review-coverage-unverified');
      dispositions = await findingDispositions({ rootDir, observed, inventory, audit, comments: reviews.comments, launch,
        strictNonBlockingRemediation });
      const auditRef = `github:repos/${repo}/issues/comments/${audit.id}`;
      proof = { ok: true, head, digest: request.reviewProof.digest, sourceRef: auditRef, observedAt: audit.updated_at ?? audit.created_at };
      // The live App-authored audit is bound to this exact head, launch and
      // request digest. A request alone cannot assert local validation truth.
      const validationLines = String(audit.body).split(/\r?\n/).map(line => line.trim())
        .filter(line => line.startsWith('HAM-Queue-Validation:'));
      if (isDeepStrictEqual(validationLines, ['HAM-Queue-Validation: unknown'])) {
        validation = { head, sourceRef: auditRef, result: 'unknown', ciAuthoritative: true,
          cleanup: 'finished', cleanCheckout: true, localFailureObserved: false };
      } else if (isDeepStrictEqual(validationLines, ['HAM-Queue-Validation: ordinary'])) {
        validation = { ok: true, head, sourceRef: auditRef };
      } else {
        throw new Error('queue-exact-hammer-validation-result-unavailable');
      }
      publication = { ok: true, head, sourceRef: auditRef };
      produced = await sign({ request, hqRoot, audit, env, ...budget() });
    }
    // Re-read after all long evidence reads. A submission may not bind a
    // receipt to a head that moved while review, signature or policy was read.
    const latest = await live.snapshot(lane, prNumber, budget());
    requireOpen(latest, head);
    const primaryChange = { ok: true, head, intent: 'primary-change-preserved', sourceRef: `primary-change:${repo}#${prNumber}@${head}` };
    const input = { schemaVersion: 1, lane, prNumber, head, admissionGeneration: request?.admissionGeneration ?? admissionGeneration,
      handoffId: request?.handoffId ?? `clean:${handoffDigest(admissionGeneration === 1
        ? [lane, prNumber, head] : [lane, prNumber, head, admissionGeneration])}`, worker,
      sourceReview: { id: String(source.row.id), commitId: source.row.commit_id },
      attestations: { produced: produced.ref, reviewed: reviewed.ref }, primaryChange: { intent: primaryChange.intent, sourceRef: primaryChange.sourceRef },
      publication: { head, sourceRef: publication.sourceRef }, localValidation: { head, sourceRef: validation.sourceRef },
      ...(request ? { closer, dispositions, reviewProof: request.reviewProof } : {}) };
    const evidence = { subject: latest.subject,
      review: { complete: true, id: input.sourceReview.id, commitId: source.row.commit_id,
        reviewerIdentity: reviewed.record.producer_identity, sourceRef: source.sourceRef,
        verdict: cleanReview(source) ? 'settled-success' : source.verdict,
        findings: inventory.map(({ findingId, reviewId, reviewCommitId, severity, sourceRef, currency }) =>
          ({ findingId, reviewId, reviewCommitId, severity, sourceRef, currency: {
            current: currency.current, reviewedHead: currency.reviewedHead, currentHead: currency.currentHead,
            proof: currency.proof, sourceRef: currency.sourceRef,
          } })) }, currency: { current: source.currency.current, reviewedHead: source.currency.reviewedHead,
        currentHead: source.currency.currentHead, proof: source.currency.proof, sourceRef: source.sourceRef },
      identities: { ok: true, worker, closer, sourceRef: produced.sourceRef },
      attestations: { produced, reviewed }, primaryChange, publication, localValidation: validation,
      ...(proof ? { reviewProof: proof, builderAttestation, strictNonBlockingRemediation } : {}),
    };
    return { input, evidence };
  };
}
