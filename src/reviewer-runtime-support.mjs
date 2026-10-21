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
import { reviewerRuntimeState, resolveReviewerRuntimeAdapterForDomainId } from './reviewer-runtime-adapter.mjs';
import { writeReviewerTokenUsageArtifact } from './reviewer-pass-tokens.mjs';
import { fetchGeminiCredentialConcurrency, reviewerDispatchCandidateUsesGemini, reviewerDispatchCandidateGeminiSeats } from './watcher-reviewer-pool.mjs';

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
    resolveDomainAdapter = resolveReviewerRuntimeAdapterForDomainId,
    resolveCandidateAdapter = (candidate) => candidate?.reviewerRuntimeAdapter
      || resolveDomainAdapter(candidate?.domainId || candidate?.subject?.domainId)
      || reviewerRuntimeState.adapter,
    logger = console,
  } = {}
) {
  const geminiCandidates = candidates.filter(reviewerDispatchCandidateUsesGemini);
  if (geminiCandidates.length === 0) {
    identityPool.noteGeminiDemand?.({ readyIdentities: 0, candidates: 0 });
    return null;
  }

  // CCX-08: added identities only count toward the cap for reviews whose
  // runtime can actually lease one (see adapterCarriesAgyReviewerIdentity).
  // For those, one readiness pass per watcher pass (settings drift isolates,
  // a passing check re-admits). Null means the pre-CCX-08 path: the broker
  // count below stays the cap exactly as before.
  const leasingCandidates = identityPool.plan().multi
    ? geminiCandidates.filter((candidate) => adapterCarriesAgyReviewerIdentity(resolveCandidateAdapter(candidate)))
    : [];
  // The ready count is total capacity: it already includes identities this
  // watcher holds a lease on (leasing does not unready an identity), and the
  // queue subtracts those in-flight reviews itself, so they count once.
  const readyIdentities = leasingCandidates.length > 0 ? await identityPool.refreshReadiness() : null;
  // Alert when no waiting candidate can fit, including a panel larger than
  // the nonzero ready capacity. A smaller candidate keeps the lane actionable.
  identityPool.noteGeminiDemand?.({
    readyIdentities: readyIdentities ?? 0,
    candidates: leasingCandidates.length,
    requiredSeats: leasingCandidates.length > 0
      ? Math.min(...leasingCandidates.map(reviewerDispatchCandidateGeminiSeats)) : 1,
  });
  const readyUsers = readyIdentities === null ? [] : identityPool.readyUsers?.() || [];
  const report = (limit, brokerLimit = null) => {
    const projection = readyIdentities !== null ? identityPool.projection?.() : null;
    logger.log?.(`[agy-identities] ready=${readyUsers.join(',') || '<none>'} limit=${limit ?? '<unknown>'} brokerLimit=${brokerLimit ?? '<unknown>'} leasingCandidates=${leasingCandidates.length}/${geminiCandidates.length}`);
    if (projection) logger.log?.(`[agy-holders] ${JSON.stringify(projection)}`);
    return limit;
  };
  // Clear prior per-candidate evidence on each pass (config and readiness can
  // change while a deferred candidate remains in the queue).
  for (const candidate of geminiCandidates) delete candidate.geminiCredentialConcurrency;
  if (readyIdentities !== null && leasingCandidates.length === geminiCandidates.length) return report(readyIdentities);

  const brokerUrl = env.CQP_BROKER_URL || env.OAUTH_BROKER_URL || DEFAULT_CQP_BROKER_URL;
  const brokerCount = await fetchCredentialConcurrency({
    brokerUrl,
    secret: brokerUrl ? await readSharedSecret(env) : '',
  });
  if (readyIdentities === null) return report(brokerCount, brokerCount);
  // A broker-only candidate cannot bound the identity-backed candidates to
  // zero. Keep each candidate under the capacity of the runtime it uses. The
  // queue still subtracts all active Gemini seats from either limit, preserving
  // conservative admission across mixed runtimes and recovered pipeline seats.
  const broker = Number.parseInt(String(brokerCount ?? ''), 10);
  const leasingSet = new Set(leasingCandidates);
  for (const candidate of geminiCandidates) {
    candidate.geminiCredentialConcurrency = leasingSet.has(candidate) ? readyIdentities : brokerCount;
  }
  return report(Number.isFinite(broker) ? Math.max(readyIdentities, broker) : Math.max(readyIdentities, 1), brokerCount);
}
