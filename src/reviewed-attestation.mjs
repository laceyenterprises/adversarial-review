import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { classifyStructuredBlockingIssues } from './kernel/verdict.mjs';

const execFileAsync = promisify(execFile);
const REVIEWED_ATTESTATION_SIGN_TIMEOUT_MS = 15_000;
const REVIEWED_ATTESTATION_SIGN_MAX_ATTEMPTS = 3;
const REVIEWED_ATTESTATION_SIGN_RETRY_DELAY_MS = 250;
const REVIEWED_ATTESTATION_SIGNATURE_ALGORITHM = 'hcp-hmac-sha256:v1';
const REVIEWED_ATTESTATION_DIGEST_RE = /^sha256:[A-Za-z0-9_-]{43}$/;

function isTransientSignError(err) {
  if (err?.killed === true) return true;
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

async function execFileWithTransientRetry(execFileImpl, command, args, options, {
  maxAttempts,
  retryDelayMs,
  delayImpl,
} = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await execFileImpl(command, args, options);
    } catch (err) {
      if (attempt >= maxAttempts || !isTransientSignError(err)) throw err;
      await delayImpl(retryDelayMs * attempt);
    }
  }
  throw new Error('unreachable retry state');
}

function execFileWithStdin(execFileImpl, command, args, options, input) {
  const execution = execFileImpl(command, args, options);
  const stdin = execution?.child?.stdin;
  if (!stdin || typeof stdin.end !== 'function') {
    throw new TypeError('async execFile implementation must expose child.stdin for payload delivery');
  }
  stdin.end(input);
  return execution;
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
    verdict: normalizedVerdict,
    findings_count: Number.isInteger(findingsCount) && findingsCount >= 0 ? findingsCount : null,
    payload: { reviewer_identity: normalizedReviewerIdentity },
    ts,
  };
}

function reviewedAttestationSignArgs(payload) {
  const args = [
    'attest', 'sign',
    '--repo', payload.repo,
    '--pr', String(payload.pr_number),
    '--head-sha', payload.head_sha,
    '--kind', payload.kind,
    '--verdict', payload.verdict,
    '--payload-json', JSON.stringify(payload.payload || {}),
    '--ts', payload.ts,
  ];
  if (payload.parent_head_sha) args.push('--parent-head-sha', payload.parent_head_sha);
  if (payload.findings_count !== null) {
    args.push('--findings-count', String(payload.findings_count));
  }
  return args;
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
  const { stdout } = await execFileWithTransientRetry(
    execFileImpl,
    hqPath,
    reviewedAttestationSignArgs(payload),
    { env, timeout: timeoutMs, maxBuffer: 1024 * 1024 },
    { maxAttempts, retryDelayMs, delayImpl }
  );
  const trimmed = String(stdout || '').trim();
  if (!trimmed) throw new Error('hq attest sign returned empty output');
  let signed;
  try {
    signed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(
      `hq attest sign returned invalid JSON: ${err.message}; stdout=${JSON.stringify(trimmed.slice(0, 500))}`,
      { cause: err }
    );
  }
  validateSignedReviewedAttestation(signed, payload);
  return signed;
}

function validateSignedReviewedAttestation(signed, payload) {
  if (!signed || typeof signed !== 'object' || Array.isArray(signed)) {
    throw new Error('signed attestation must be an object');
  }
  const signedPayloadKeys = Object.keys(signed).filter((field) => field !== 'signature').sort();
  const expectedPayloadKeys = Object.keys(payload).sort();
  if (JSON.stringify(signedPayloadKeys) !== JSON.stringify(expectedPayloadKeys)) {
    throw new Error(
      `signed attestation payload keys mismatch: ${signedPayloadKeys.join(',') || '(none)'}`
    );
  }
  for (const [field, expected] of Object.entries(payload)) {
    const matches = field === 'payload'
      ? JSON.stringify(signed[field]) === JSON.stringify(expected)
      : signed[field] === expected;
    if (!matches) {
      throw new Error(`signed attestation ${field} mismatch: ${signed[field]}`);
    }
  }
  const signature = signed.signature;
  if (!signature || typeof signature !== 'object' || Array.isArray(signature)) {
    throw new Error('signed attestation signature is missing');
  }
  if (signature.algorithm !== REVIEWED_ATTESTATION_SIGNATURE_ALGORITHM) {
    throw new Error(`signed attestation signature algorithm mismatch: ${signature.algorithm}`);
  }
  const reviewerIdentity = payload.payload?.reviewer_identity;
  const signedSubject = String(signature.subject || '').trim();
  if (!signedSubject || signedSubject !== reviewerIdentity) {
    throw new Error(`signed attestation HCP subject mismatch: ${signedSubject}`);
  }
  if (!REVIEWED_ATTESTATION_DIGEST_RE.test(String(signature.digest || ''))) {
    throw new Error('signed attestation signature digest is malformed');
  }
}

async function recordSignedReviewedAttestation({
  signed,
  hqPath = process.env.HQ_BIN || 'hq',
  execFileImpl = execFileAsync,
  env = process.env,
  timeoutMs = REVIEWED_ATTESTATION_SIGN_TIMEOUT_MS,
  maxAttempts = REVIEWED_ATTESTATION_SIGN_MAX_ATTEMPTS,
  retryDelayMs = REVIEWED_ATTESTATION_SIGN_RETRY_DELAY_MS,
  delayImpl = delay,
} = {}) {
  const input = `${JSON.stringify(signed)}\n`;
  const { stdout } = await execFileWithTransientRetry(
    (command, args, options) => execFileWithStdin(
      execFileImpl,
      command,
      args,
      options,
      input
    ),
    hqPath,
    ['attest', 'record', '--payload', '-'],
    {
      env,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
    },
    { maxAttempts, retryDelayMs, delayImpl }
  );
  const trimmed = String(stdout || '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch (err) {
    throw new Error(
      `hq attest record returned invalid JSON: ${err.message}; stdout=${JSON.stringify(trimmed.slice(0, 500))}`,
      { cause: err }
    );
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
  const recorded = await recordSignedReviewedAttestation({
    signed,
    hqPath,
    execFileImpl,
    env,
  });
  log?.log?.(
    `[reviewer] reviewed attestation emitted for ${payload.repo}#${payload.pr_number}@${payload.head_sha.slice(0, 12)} ` +
      `verdict=${payload.verdict} findings_count=${payload.findings_count ?? 'unknown'}`
  );
  return { payload, signed, recorded };
}

export {
  REVIEWED_ATTESTATION_SIGNATURE_ALGORITHM,
  REVIEWED_ATTESTATION_SIGN_MAX_ATTEMPTS,
  REVIEWED_ATTESTATION_SIGN_RETRY_DELAY_MS,
  REVIEWED_ATTESTATION_SIGN_TIMEOUT_MS,
  buildReviewedAttestationPayload,
  emitReviewedAttestation,
  normalizeFindingsCount,
  isTransientSignError,
  recordSignedReviewedAttestation,
  reviewedAttestationSignArgs,
  signReviewedAttestation,
  validateSignedReviewedAttestation,
};
