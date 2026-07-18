// Reviewer-runtime support helpers, extracted from watcher.mjs (ARC-18).
//
// Small, dependency-injected best-effort helpers used around reviewer dispatch:
//   - writeReviewerTokenUsageArtifactBestEffort: swallow-and-warn wrapper for the
//     reviewer token-usage artifact writer.
//   - readReviewerBrokerSharedSecretBestEffort: TTL-cached read of the CQP/oauth
//     broker shared secret; returns '' on any miss so callers fail open.
//   - resolveGeminiCredentialConcurrencyForDispatchCandidates: fetch the gemini
//     credential-concurrency cap only when the candidate set includes gemini.
//
// The broker-secret cache was a watcher module-level singleton used solely by
// readReviewerBrokerSharedSecretBestEffort, so it moves here intact and stays
// private to this module. Behavior is preserved exactly; parity is verified by
// watcher-reviewer-token-artifact.test.mjs and watcher-broker-secret-cache.test.mjs,
// which import these functions re-exported from watcher.mjs.

import { readFile as readFileAsync } from 'node:fs/promises';
import { writeReviewerTokenUsageArtifact } from './reviewer-pass-tokens.mjs';
import { fetchGeminiCredentialConcurrency } from './watcher-reviewer-pool.mjs';

const DEFAULT_REVIEWER_BROKER_SECRET_CACHE_TTL_MS = 5 * 60 * 1000;
let reviewerBrokerSharedSecretCache = {
  file: null,
  value: '',
  expiresAtMs: 0,
};

export function writeReviewerTokenUsageArtifactBestEffort(options, {
  repo,
  prNumber,
  reviewerSessionUuid,
  writeImpl = writeReviewerTokenUsageArtifact,
  warn = console.warn,
} = {}) {
  try {
    return writeImpl(options);
  } catch (err) {
    warn(
      `[watcher] reviewer_token_usage_artifact_write_failed repo=${repo} pr=${prNumber} ` +
      `session=${reviewerSessionUuid}: ${err?.message || err}`
    );
    return null;
  }
}

// Best-effort async read of the CQP/oauth broker shared secret for read-only
// broker probes (e.g. the gemini credential-count fetch). Returns '' on any
// miss; the caller fails open (no gemini cap) so a missing secret never wedges
// dispatch. The read is TTL-cached because this helper can be reached from the
// watcher's hot dispatch drain.
export async function readReviewerBrokerSharedSecretBestEffort(
  env = process.env,
  {
    fsImpl = { readFile: readFileAsync },
    now = Date.now,
    ttlMs = DEFAULT_REVIEWER_BROKER_SECRET_CACHE_TTL_MS,
    logger = console,
  } = {}
) {
  const secretFile = env.CQP_BROKER_SHARED_SECRET_FILE || env.OAUTH_BROKER_SHARED_SECRET_FILE || '';
  if (!secretFile) return '';
  const resolvedNowMs = Number(now());
  const nowMs = Number.isFinite(resolvedNowMs) ? resolvedNowMs : Date.now();
  if (
    reviewerBrokerSharedSecretCache.file === secretFile &&
    reviewerBrokerSharedSecretCache.expiresAtMs > nowMs
  ) {
    return reviewerBrokerSharedSecretCache.value;
  }
  try {
    const value = String(await fsImpl.readFile(secretFile, 'utf8') || '').trim();
    reviewerBrokerSharedSecretCache = {
      file: secretFile,
      value,
      expiresAtMs: nowMs + Math.max(0, Number(ttlMs) || 0),
    };
    return value;
  } catch (err) {
    reviewerBrokerSharedSecretCache = {
      file: secretFile,
      value: '',
      expiresAtMs: nowMs + Math.max(0, Number(ttlMs) || 0),
    };
    if (err?.code !== 'ENOENT') {
      logger?.warn?.(
        `[watcher] failed to read reviewer broker shared secret file ${secretFile}: ${err?.code || err?.message || err}`
      );
    }
    return '';
  }
}

export async function resolveGeminiCredentialConcurrencyForDispatchCandidates(
  candidates,
  {
    env = process.env,
    fetchCredentialConcurrency = fetchGeminiCredentialConcurrency,
    readSharedSecret = readReviewerBrokerSharedSecretBestEffort,
  } = {}
) {
  const hasGeminiCandidates = candidates.some(
    (candidate) => String(candidate?.reviewerModel || '').toLowerCase() === 'gemini'
  );
  if (!hasGeminiCandidates) return null;

  const brokerUrl = env.CQP_BROKER_URL || env.OAUTH_BROKER_URL || null;
  return await fetchCredentialConcurrency({
    brokerUrl,
    secret: brokerUrl ? await readSharedSecret(env) : '',
  });
}
