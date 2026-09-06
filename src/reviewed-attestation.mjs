import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual, promisify } from 'node:util';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { classifyStructuredBlockingIssues } from './kernel/verdict.mjs';

const execFileAsync = promisify(execFile);
const REVIEWED_ATTESTATION_SIGN_TIMEOUT_MS = 15_000;
const REVIEWED_ATTESTATION_SIGN_MAX_ATTEMPTS = 3;
const REVIEWED_ATTESTATION_SIGN_RETRY_DELAY_MS = 250;
const REVIEWED_ATTESTATION_SIGNATURE_ALGORITHM = 'hcp-hmac-sha256:v1';
const REVIEWED_ATTESTATION_DIGEST_RE = /^sha256:[A-Za-z0-9_-]{43}$/;
const ATTESTATION_SIGN_FAILED_FAILURE_CLASS = 'attestation-sign-failed';
const HCP_UNAVAILABLE_FAILURE_CLASS = 'hcp-unavailable';
const REVIEWED_ATTESTATION_QUEUE_RELATIVE_PATH = join('data', 'reviewed-attestations', 'pending.jsonl');
const REVIEWED_ATTESTATION_QUEUE_LOCK_STALE_MS = 60_000;
const REVIEWED_ATTESTATION_QUEUE_LOCK_WAIT_MS = 65_000;
const REVIEWED_ATTESTATION_QUEUE_LOCK_POLL_MS = 25;

function isTransientSignError(err) {
  if (err?.killed === true) return true;
  const code = String(err?.code || '').toUpperCase();
  if (['EAGAIN', 'EBUSY', 'ECONNRESET', 'EIO', 'EMFILE', 'ENFILE', 'ETIMEDOUT'].includes(code)) {
    return true;
  }
  const message = String(err?.message || err || '').toLowerCase();
  return /resource temporarily unavailable|timed? out|timeout|tls handshake|socket hang up/.test(message);
}

function classifyReviewedAttestationFailure(err) {
  const code = String(err?.code || '').toUpperCase();
  const text = [
    err?.message,
    err?.stderr,
    err?.stdout,
    err?.cause?.message,
  ].filter(Boolean).join('\n').toLowerCase();
  if (
    ['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT'].includes(code) ||
    /127\.0\.0\.1:8002|localhost:8002|\[::1\]:8002/.test(text) ||
    /\bhcp\b/.test(text) && /unavailable|connection refused|timed? out|timeout|no answer|refused|unreachable/.test(text)
  ) {
    return HCP_UNAVAILABLE_FAILURE_CLASS;
  }
  return ATTESTATION_SIGN_FAILED_FAILURE_CLASS;
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
  packLockhash = null,
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

  const payload = { reviewer_identity: normalizedReviewerIdentity };
  if (packLockhash) {
    const lockhash = String(packLockhash.lockhash || packLockhash).trim();
    if (!/^[0-9a-f]{12}$/.test(lockhash)) {
      throw new TypeError('packLockhash.lockhash must be a 12-character lowercase hex lockhash');
    }
    payload.pack_lockhash = lockhash;
    if (packLockhash.packId) payload.pack_id = String(packLockhash.packId);
    if (packLockhash.packPath) payload.pack_path = String(packLockhash.packPath);
    if (packLockhash.source) payload.pack_lockhash_source = String(packLockhash.source);
  }

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
    payload,
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
  const reviewerSubject = String(payload.payload?.reviewer_identity || '').trim();
  if (!reviewerSubject) {
    throw new TypeError('payload.payload.reviewer_identity is required for HCP signing');
  }
  const signingEnv = { ...env, HCP_SUBJECT: reviewerSubject };
  const { stdout } = await execFileWithTransientRetry(
    execFileImpl,
    hqPath,
    reviewedAttestationSignArgs(payload),
    { env: signingEnv, timeout: timeoutMs, maxBuffer: 1024 * 1024 },
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
      ? isDeepStrictEqual(signed[field], expected)
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
  packLockhash = null,
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
    packLockhash,
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

function reviewedAttestationQueuePath(rootDir) {
  return join(rootDir, REVIEWED_ATTESTATION_QUEUE_RELATIVE_PATH);
}

function reviewedAttestationQueueLockPath(rootDir) {
  return `${reviewedAttestationQueuePath(rootDir)}.lock`;
}

async function acquireReviewedAttestationQueueLock(rootDir, {
  waitMs = REVIEWED_ATTESTATION_QUEUE_LOCK_WAIT_MS,
  staleMs = REVIEWED_ATTESTATION_QUEUE_LOCK_STALE_MS,
} = {}) {
  const queuePath = reviewedAttestationQueuePath(rootDir);
  const lockPath = reviewedAttestationQueueLockPath(rootDir);
  const ownerPath = join(lockPath, 'owner.json');
  const owner = {
    pid: process.pid,
    token: `${process.pid}:${Date.now()}:${randomUUID()}`,
    acquired_at: new Date().toISOString(),
  };
  mkdirSync(dirname(queuePath), { recursive: true });
  const startedAt = Date.now();
  while (true) {
    try {
      mkdirSync(lockPath);
      writeFileSync(ownerPath, `${JSON.stringify(owner)}\n`);
      return () => {
        try {
          const currentOwner = JSON.parse(readFileSync(ownerPath, 'utf8'));
          if (currentOwner?.token !== owner.token) return;
          rmSync(lockPath, { recursive: true, force: true });
        } catch (err) {
          if (err?.code === 'ENOENT') return;
          throw err;
        }
      };
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      try {
        const ageMs = Date.now() - statSync(lockPath).mtimeMs;
        if (ageMs > staleMs) {
          rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch (statErr) {
        if (statErr?.code === 'ENOENT') continue;
        throw statErr;
      }
      if (Date.now() - startedAt >= waitMs) {
        throw new Error(`timed out acquiring reviewed attestation queue lock: ${lockPath}`);
      }
      await delay(REVIEWED_ATTESTATION_QUEUE_LOCK_POLL_MS);
    }
  }
}

async function withReviewedAttestationQueueLock(rootDir, callback) {
  const release = await acquireReviewedAttestationQueueLock(rootDir);
  try {
    return callback();
  } finally {
    release();
  }
}

function pendingReviewedAttestationEntry(args = {}, err = null) {
  const payload = args.payload || buildReviewedAttestationPayload({
    repo: args.repo,
    prNumber: args.prNumber,
    headSha: args.headSha,
    reviewerIdentity: args.reviewerIdentity,
    verdict: args.verdict,
    findingsCount: args.findingsCount,
    packLockhash: args.packLockhash,
  });
  return {
    schema_version: 1,
    enqueued_at: new Date().toISOString(),
    failure_class: classifyReviewedAttestationFailure(err),
    last_error: err?.message || String(err || ''),
    payload,
  };
}

async function enqueuePendingReviewedAttestation(rootDir, args = {}, err = null) {
  if (!rootDir) throw new TypeError('rootDir is required');
  const entry = pendingReviewedAttestationEntry(args, err);
  await withReviewedAttestationQueueLock(rootDir, () => {
    const queuePath = reviewedAttestationQueuePath(rootDir);
    writeFileSync(queuePath, `${JSON.stringify(entry)}\n`, { flag: 'a' });
  });
  return entry;
}

function readPendingReviewedAttestationsUnlocked(rootDir) {
  const queuePath = reviewedAttestationQueuePath(rootDir);
  let raw = '';
  try {
    raw = readFileSync(queuePath, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
  return raw.split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

async function readPendingReviewedAttestations(rootDir) {
  if (!rootDir) throw new TypeError('rootDir is required');
  return withReviewedAttestationQueueLock(rootDir, () => readPendingReviewedAttestationsUnlocked(rootDir));
}

function rewritePendingReviewedAttestationsUnlocked(rootDir, entries) {
  const queuePath = reviewedAttestationQueuePath(rootDir);
  mkdirSync(dirname(queuePath), { recursive: true });
  const body = entries.map((entry) => JSON.stringify(entry)).join('\n');
  const tmpPath = `${queuePath}.tmp.${process.pid}`;
  writeFileSync(tmpPath, body ? `${body}\n` : '');
  renameSync(tmpPath, queuePath);
}

async function replaceProcessedReviewedAttestations(rootDir, processedEntries) {
  await withReviewedAttestationQueueLock(rootDir, () => {
    const current = readPendingReviewedAttestationsUnlocked(rootDir);
    const replacements = new Map();
    const consumed = new Map();
    for (const processed of processedEntries) {
      const key = JSON.stringify(processed.original);
      if (processed.remaining) {
        const bucket = replacements.get(key) || [];
        bucket.push(processed.remaining);
        replacements.set(key, bucket);
      } else {
        consumed.set(key, (consumed.get(key) || 0) + 1);
      }
    }
    const next = current.flatMap((entry) => {
      const key = JSON.stringify(entry);
      const replacementBucket = replacements.get(key);
      if (replacementBucket?.length > 0) {
        return [replacementBucket.shift()];
      }
      const consumeCount = consumed.get(key) || 0;
      if (consumeCount > 0) {
        consumed.set(key, consumeCount - 1);
        return [];
      }
      return [entry];
    });
    rewritePendingReviewedAttestationsUnlocked(rootDir, next);
  });
}

async function retryPendingReviewedAttestations({
  rootDir,
  hqPath,
  execFileImpl,
  env,
  log = console,
  now = () => new Date().toISOString(),
} = {}) {
  const pending = await readPendingReviewedAttestations(rootDir);
  if (pending.length === 0) {
    return { attempted: 0, consumed: 0, remaining: 0 };
  }
  const remaining = [];
  const consumed = [];
  const processed = [];
  for (const entry of pending) {
    try {
      const signed = await signReviewedAttestation({
        payload: entry.payload,
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
      consumed.push({ entry, signed, recorded });
      processed.push({ original: entry, remaining: null });
      log?.log?.(
        `[reviewer] queued reviewed attestation consumed for ${entry.payload.repo}#${entry.payload.pr_number}` +
          `@${String(entry.payload.head_sha || '').slice(0, 12)}`
      );
    } catch (err) {
      const failedEntry = {
        ...entry,
        failure_class: classifyReviewedAttestationFailure(err),
        last_error: err?.message || String(err || ''),
        last_attempted_at: now(),
      };
      remaining.push(failedEntry);
      processed.push({ original: entry, remaining: failedEntry });
    }
  }
  await replaceProcessedReviewedAttestations(rootDir, processed);
  return { attempted: pending.length, consumed: consumed.length, remaining: remaining.length };
}

export {
  ATTESTATION_SIGN_FAILED_FAILURE_CLASS,
  HCP_UNAVAILABLE_FAILURE_CLASS,
  REVIEWED_ATTESTATION_SIGNATURE_ALGORITHM,
  REVIEWED_ATTESTATION_SIGN_MAX_ATTEMPTS,
  REVIEWED_ATTESTATION_SIGN_RETRY_DELAY_MS,
  REVIEWED_ATTESTATION_SIGN_TIMEOUT_MS,
  buildReviewedAttestationPayload,
  classifyReviewedAttestationFailure,
  acquireReviewedAttestationQueueLock,
  emitReviewedAttestation,
  enqueuePendingReviewedAttestation,
  normalizeFindingsCount,
  readPendingReviewedAttestations,
  retryPendingReviewedAttestations,
  isTransientSignError,
  recordSignedReviewedAttestation,
  reviewedAttestationSignArgs,
  signReviewedAttestation,
  validateSignedReviewedAttestation,
};
