import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { classifyStructuredBlockingIssues } from './kernel/verdict.mjs';

const execFileAsync = promisify(execFile);
const REVIEWED_ATTESTATION_SIGN_TIMEOUT_MS = 15_000;

function normalizeFindingsCount(reviewBody) {
  const blocking = classifyStructuredBlockingIssues(reviewBody || '');
  return blocking.state === 'known' ? blocking.count : null;
}

function buildReviewedAttestationPayload({
  repo,
  prNumber,
  headSha,
  reviewerIdentity,
  verdict,
  findingsCount,
  ts = new Date().toISOString(),
} = {}) {
  const normalizedRepo = String(repo || '').trim();
  const normalizedHeadSha = String(headSha || '').trim();
  const normalizedReviewerIdentity = String(reviewerIdentity || '').trim();
  const normalizedVerdict = String(verdict || '').trim();
  const normalizedPrNumber = Number(prNumber);
  if (!normalizedRepo) throw new TypeError('repo is required');
  if (!Number.isInteger(normalizedPrNumber) || normalizedPrNumber <= 0) {
    throw new TypeError('prNumber must be a positive integer');
  }
  if (!normalizedHeadSha) throw new TypeError('headSha is required');
  if (!normalizedReviewerIdentity) throw new TypeError('reviewerIdentity is required');
  if (!normalizedVerdict) throw new TypeError('verdict is required');

  return {
    schema_version: 1,
    repo: normalizedRepo,
    pr_number: normalizedPrNumber,
    head_sha: normalizedHeadSha,
    parent_head_sha: null,
    kind: 'reviewed',
    producer_identity: normalizedReviewerIdentity,
    reviewer_identity: normalizedReviewerIdentity,
    verdict: normalizedVerdict,
    findings_count: Number.isInteger(findingsCount) && findingsCount >= 0 ? findingsCount : null,
    ts,
  };
}

async function signReviewedAttestation({
  payload,
  hqPath = process.env.HQ_BIN || 'hq',
  execFileImpl = execFileAsync,
  env = process.env,
  timeoutMs = REVIEWED_ATTESTATION_SIGN_TIMEOUT_MS,
} = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('payload object is required');
  }
  const serialized = `${JSON.stringify(payload)}\n`;
  const { stdout } = await execFileImpl(
    hqPath,
    ['attest', 'sign', '--payload', '-'],
    {
      env,
      input: serialized,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
    }
  );
  const trimmed = String(stdout || '').trim();
  if (!trimmed) return null;
  let signed;
  try {
    signed = JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
  validateSignedReviewedAttestation(signed, payload);
  return signed;
}

function validateSignedReviewedAttestation(signed, payload) {
  if (!signed || typeof signed !== 'object' || Array.isArray(signed)) return;
  if (signed.kind !== undefined && signed.kind !== payload.kind) {
    throw new Error(`signed attestation kind mismatch: ${signed.kind}`);
  }
  if (signed.head_sha !== undefined && signed.head_sha !== payload.head_sha) {
    throw new Error(`signed attestation head_sha mismatch: ${signed.head_sha}`);
  }
  if (signed.verdict !== undefined && signed.verdict !== payload.verdict) {
    throw new Error(`signed attestation verdict mismatch: ${signed.verdict}`);
  }
  if (
    signed.reviewer_identity !== undefined &&
    signed.reviewer_identity !== payload.reviewer_identity
  ) {
    throw new Error(`signed attestation reviewer_identity mismatch: ${signed.reviewer_identity}`);
  }
  if (
    signed.producer_identity !== undefined &&
    signed.producer_identity !== payload.producer_identity
  ) {
    throw new Error(`signed attestation producer_identity mismatch: ${signed.producer_identity}`);
  }
  if (signed.signature?.verified === false) {
    throw new Error('signed attestation signature did not verify');
  }
  const signedSubject = signed.signature?.hcp_subject ?? signed.signature?.subject;
  if (signedSubject !== undefined && signedSubject !== payload.reviewer_identity) {
    throw new Error(`signed attestation HCP subject mismatch: ${signedSubject}`);
  }
}

async function emitReviewedAttestation({
  repo,
  prNumber,
  headSha,
  reviewerIdentity,
  verdict,
  reviewBody,
  findingsCount = normalizeFindingsCount(reviewBody),
  hqPath,
  execFileImpl,
  env,
  log = console,
} = {}) {
  const payload = buildReviewedAttestationPayload({
    repo,
    prNumber,
    headSha,
    reviewerIdentity,
    verdict,
    findingsCount,
  });
  const signed = await signReviewedAttestation({
    payload,
    hqPath,
    execFileImpl,
    env,
  });
  log?.log?.(
    `[reviewer] reviewed attestation emitted for ${payload.repo}#${payload.pr_number}@${payload.head_sha.slice(0, 12)} ` +
      `verdict=${payload.verdict} findings_count=${payload.findings_count ?? 'unknown'}`
  );
  return { payload, signed };
}

export {
  REVIEWED_ATTESTATION_SIGN_TIMEOUT_MS,
  buildReviewedAttestationPayload,
  emitReviewedAttestation,
  normalizeFindingsCount,
  signReviewedAttestation,
  validateSignedReviewedAttestation,
};
