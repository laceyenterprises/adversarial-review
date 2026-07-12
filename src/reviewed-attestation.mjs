import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { writeFileAtomic } from './atomic-write.mjs';
import { classifyStructuredBlockingIssues } from './kernel/verdict.mjs';

const execFileAsync = promisify(execFile);
const REVIEWED_ATTESTATION_SIGN_TIMEOUT_MS = 15_000;
const REVIEWED_ATTESTATION_SIGN_MAX_ATTEMPTS = 3;
const REVIEWED_ATTESTATION_SIGN_RETRY_DELAY_MS = 250;

function isTransientSignError(err) {
  const code = String(err?.code || '').toUpperCase();
  if (['EAGAIN', 'EBUSY', 'ECONNRESET', 'EIO', 'EMFILE', 'ENFILE', 'ETIMEDOUT'].includes(code)) {
    return true;
  }
  const message = String(err?.message || err || '').toLowerCase();
  return /resource temporarily unavailable|timed? out|timeout|tls handshake|socket hang up/.test(message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
  maxAttempts = REVIEWED_ATTESTATION_SIGN_MAX_ATTEMPTS,
  retryDelayMs = REVIEWED_ATTESTATION_SIGN_RETRY_DELAY_MS,
  delayImpl = delay,
} = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('payload object is required');
  }
  const serialized = `${JSON.stringify(payload)}\n`;
  let stdout;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      ({ stdout } = await execFileImpl(
        hqPath,
        ['attest', 'sign', '--payload', '-'],
        {
          env,
          input: serialized,
          timeout: timeoutMs,
          maxBuffer: 1024 * 1024,
        }
      ));
      break;
    } catch (err) {
      if (attempt >= maxAttempts || !isTransientSignError(err)) throw err;
      await delayImpl(retryDelayMs * attempt);
    }
  }
  const trimmed = String(stdout || '').trim();
  if (!trimmed) throw new Error('hq attest sign returned empty output');
  let signed;
  try {
    signed = JSON.parse(trimmed);
  } catch (err) {
    const diagnostic = trimmed.length > 500 ? `${trimmed.slice(0, 500)}...` : trimmed;
    throw new Error(`hq attest sign returned invalid JSON: ${err.message}; stdout=${JSON.stringify(diagnostic)}`, { cause: err });
  }
  validateSignedReviewedAttestation(signed, payload);
  return signed;
}

function reviewedAttestationPath(rootDir, payload, artifactDiscriminator = 'review') {
  const repoKey = payload.repo.replace(/[^A-Za-z0-9._-]+/g, '__');
  const artifactKey = `${payload.head_sha}-${artifactDiscriminator}-${payload.reviewer_identity}`
    .replace(/[^A-Za-z0-9._-]+/g, '_');
  return join(rootDir, 'data', 'reviewed-attestations', repoKey, `pr-${payload.pr_number}`, `${artifactKey}.json`);
}

function persistReviewedAttestation({ rootDir, payload, signed, artifactDiscriminator, writeFileAtomicImpl = writeFileAtomic }) {
  const artifactPath = reviewedAttestationPath(rootDir, payload, artifactDiscriminator);
  mkdirSync(dirname(artifactPath), { recursive: true });
  writeFileAtomicImpl(artifactPath, `${JSON.stringify({ payload, signed }, null, 2)}\n`);
  return artifactPath;
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
  REVIEWED_ATTESTATION_SIGN_MAX_ATTEMPTS,
  REVIEWED_ATTESTATION_SIGN_RETRY_DELAY_MS,
  REVIEWED_ATTESTATION_SIGN_TIMEOUT_MS,
  buildReviewedAttestationPayload,
  emitReviewedAttestation,
  persistReviewedAttestation,
  reviewedAttestationPath,
  normalizeFindingsCount,
  isTransientSignError,
  signReviewedAttestation,
  validateSignedReviewedAttestation,
};
