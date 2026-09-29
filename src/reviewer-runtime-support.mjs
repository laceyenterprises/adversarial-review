// Reviewer-runtime support helpers, extracted from watcher.mjs (ARC-18).
//
// Small, dependency-injected best-effort helpers used around reviewer dispatch:
//   - writeReviewerTokenUsageArtifactBestEffort: swallow-and-warn wrapper for the
//     reviewer token-usage artifact writer.
//   - readReviewerBrokerSharedSecretBestEffort: TTL-cached read of the CQP/oauth
//     broker shared secret; returns '' on any miss so callers fail open.
//   - resolveGeminiCredentialConcurrencyForDispatchCandidates: fetch the gemini
//     credential-concurrency cap only when the candidate set includes gemini.
//     CCX-08: with added agy reviewer identities configured and a reviewer
//     runtime that can carry them, the cap is the number of ready identities
//     instead of the broker credential count.
//
// The broker-secret cache was a watcher module-level singleton used solely by
// readReviewerBrokerSharedSecretBestEffort, so it moves here intact and stays
// private to this module. Behavior is preserved exactly; parity is verified by
// watcher-reviewer-token-artifact.test.mjs and watcher-broker-secret-cache.test.mjs,
// which import these functions re-exported from watcher.mjs.

import { readFile as readFileAsync } from 'node:fs/promises';
import { adapterCarriesAgyReviewerIdentity, getAgyReviewerIdentityPool } from './agy-reviewer-identities.mjs';
import { reviewerRuntimeState } from './reviewer-runtime-adapter.mjs';
import { writeReviewerTokenUsageArtifact } from './reviewer-pass-tokens.mjs';
import { fetchGeminiCredentialConcurrency, reviewerDispatchCandidateUsesGemini } from './watcher-reviewer-pool.mjs';

const DEFAULT_REVIEWER_BROKER_SECRET_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_CQP_BROKER_URL = 'http://127.0.0.1:4099';
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
    // Do NOT cache an empty secret across the TTL on a transient read error
    // (EACCES/EIO/etc). Caching empty would fail Gemini broker dispatch for the
    // full TTL after a blip; expire immediately so the next call re-reads.
    reviewerBrokerSharedSecretCache = {
      file: secretFile,
      value: '',
      expiresAtMs: 0,
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
    identityPool = getAgyReviewerIdentityPool(),
    resolveCandidateAdapter = (candidate) => candidate?.reviewerRuntimeAdapter || reviewerRuntimeState.adapter,
  } = {}
) {
  const geminiCandidates = candidates.filter(reviewerDispatchCandidateUsesGemini);
  if (geminiCandidates.length === 0) return null;

  // CCX-08: added identities only count toward the cap for reviews whose
  // runtime can actually lease one (see adapterCarriesAgyReviewerIdentity).
  // For those, one readiness pass per watcher pass (settings drift isolates,
  // a passing check re-admits). Null means the pre-CCX-08 path: the broker
  // count below stays the cap exactly as before.
  const leasingCandidates = identityPool.plan().multi
    ? geminiCandidates.filter((candidate) => adapterCarriesAgyReviewerIdentity(resolveCandidateAdapter(candidate))).length
    : 0;
  const freeIdentities = leasingCandidates > 0 ? await identityPool.refreshReadiness() : null;
  // The queue subtracts active Gemini reservations. Include already leased
  // healthy identities in the total capacity to avoid subtracting them twice.
  const leasedIdentities = (identityPool.snapshot?.() || []).filter((state) => state.ready && state.leased).length;
  const readyIdentities = freeIdentities === null ? null : freeIdentities + leasedIdentities;
  // A lane that stays at zero ready identities with work waiting alerts.
  if (leasingCandidates > 0) identityPool.noteGeminiDemand?.({ readyIdentities, candidates: leasingCandidates });
  if (readyIdentities !== null && leasingCandidates === geminiCandidates.length) return readyIdentities;

  const brokerUrl = env.CQP_BROKER_URL || env.OAUTH_BROKER_URL || DEFAULT_CQP_BROKER_URL;
  const brokerCount = await fetchCredentialConcurrency({
    brokerUrl,
    secret: brokerUrl ? await readSharedSecret(env) : '',
  });
  if (readyIdentities === null) return brokerCount;
  // Mixed runtimes in one drain: leasing reviews must stay within the ready
  // identities and HQ-owner reviews within the broker count, so bound the
  // shared Gemini cap by both.
  const broker = Number.parseInt(String(brokerCount ?? ''), 10);
  return Number.isFinite(broker) ? Math.min(readyIdentities, broker) : readyIdentities;
}
