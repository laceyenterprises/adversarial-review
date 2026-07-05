// HHR — harness-fallback protection for the AMA closer/hammer.
//
// The AMA closer worker_class defaults to `hammer`, a codex (OpenAI OAuth)
// harness profile. When the codex OAuth quota is exhausted the hammer cannot
// spawn AT ALL — `hq dispatch --worker-class hammer` provisions a worker that
// dies on the cap, so settled PRs never close even though the merge-under-lease
// path (MSM-01) is deployed. The existing HHR/HRR pack added an OAuth→LiteLLM-vk
// auth-path fallback, but not a harness/worker-class fallback: a codex-capped
// hammer still died instead of running on an available harness. Operators
// hot-patched this by pinning `roles.adversarial.merge_authority.worker_class:
// claude-code`, but that is manual and static (it does not auto-revert when
// codex recovers, and it strands the hammer on claude-code forever).
//
// This module resolves — at dispatch time, per launch — which HARNESS the closer
// should physically run on:
//
//   1. Read the HHR fleet-quota provider-state authoritatively
//      (`hq fleet quota status --json`, the same classifier the reviewer/
//      remediator quota-hold path uses). Never guess from a single worker error.
//   2. If the configured (primary) worker_class's provider is grounded
//      (exhausted/suspended), pick the first configured fallback worker_class
//      whose provider is NOT also grounded and dispatch on THAT harness instead.
//   3. If the primary provider is `ok` — or its state is ambiguous
//      (degraded/unknown/missing) — keep the primary. That yields automatic
//      auto-revert: the moment codex recovers to `ok`, the next close returns to
//      the configured primary with no manual flip.
//
// Only the physical `--worker-class` harness changes; the closer's
// terminal-remediation prompt, merge-under-lease behavior, and audit provenance
// all continue to key off the LOGICAL worker_class at the call site. It is the
// MERGE path that must survive a cap, not the harness identity.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  isGroundedProviderState,
  providerAvailabilityFromFleetStatus,
} from '../fleet-quota-status.mjs';

const execFileAsync = promisify(execFile);

const FLEET_QUOTA_STATUS_TIMEOUT_MS = 10_000;

// Closer/hammer worker_class → HHR provider whose OAuth quota gates whether that
// harness can spawn at all. `hammer` runs on the codex harness (OpenAI OAuth),
// which is exactly the family LAC-1463 exhausted. Kept in sync with
// QUOTA_HARNESS_PROVIDER in ../fleet-quota-status.mjs.
export const CLOSER_WORKER_CLASS_PROVIDER = Object.freeze({
  hammer: 'openai',
  codex: 'openai',
  'claude-code': 'anthropic',
  claude: 'anthropic',
  gemini: 'google',
});

export function providerForCloserWorkerClass(workerClass) {
  return CLOSER_WORKER_CLASS_PROVIDER[String(workerClass || '').trim().toLowerCase()] || null;
}

function normalizeFallbackList(fallbackWorkerClasses) {
  if (!Array.isArray(fallbackWorkerClasses)) return [];
  return fallbackWorkerClasses.map((value) => String(value || '').trim()).filter(Boolean);
}

async function readFleetQuotaStatusStdout({ hqPath, execFileImpl, env }) {
  const result = await execFileImpl(hqPath, ['fleet', 'quota', 'status', '--json'], {
    env,
    encoding: 'utf8',
    maxBuffer: 5 * 1024 * 1024,
    timeout: FLEET_QUOTA_STATUS_TIMEOUT_MS,
  });
  return typeof result === 'string' ? result : (result?.stdout || '');
}

/**
 * Resolve the physical harness (worker_class) the closer should dispatch on.
 *
 * @param {Object} args
 * @param {string} args.workerClass — the LOGICAL/configured closer worker_class.
 * @param {string[]=} args.fallbackWorkerClasses — ordered fallback harnesses.
 * @param {string=} args.hqPath — path to the `hq` binary.
 * @param {Function=} args.execFileImpl — DI for `hq fleet quota status`.
 * @param {Object=} args.env
 * @returns {Promise<{
 *   workerClass: string,      // the harness to actually pass to `hq dispatch`
 *   fellBack: boolean,
 *   from?: string, to?: string,
 *   provider?: string,        // grounded primary provider (when fellBack)
 *   primaryState?: string,
 *   fallbackProvider?: string,
 *   reason?: string,          // why NO fallback was taken (when !fellBack)
 *   error?: string,
 * }>}
 */
export async function resolveCloserDispatchHarness({
  workerClass,
  fallbackWorkerClasses = [],
  hqPath = 'hq',
  execFileImpl = execFileAsync,
  env = process.env,
} = {}) {
  const primary = String(workerClass || '').trim();
  const fallbacks = normalizeFallbackList(fallbackWorkerClasses);
  const base = { workerClass: primary, fellBack: false };

  if (!primary || fallbacks.length === 0) {
    return { ...base, reason: 'no-fallback-configured' };
  }

  const primaryProvider = providerForCloserWorkerClass(primary);
  if (!primaryProvider) {
    // Primary harness is not quota-tracked — we cannot prove it is capped, so
    // never fall back on a guess.
    return { ...base, reason: 'primary-provider-untracked' };
  }

  // Authoritative HHR read, ONCE per launch. Fail-open to the primary on any
  // error: a doomed spawn is the pre-HHR behavior, and falling back on an
  // unreadable signal would be exactly the "guess" HHR forbids.
  let stdout;
  try {
    stdout = await readFleetQuotaStatusStdout({ hqPath, execFileImpl, env });
  } catch (err) {
    return { ...base, reason: 'fleet-quota-status-unavailable', error: String(err?.message || err) };
  }

  const primaryAvailability = providerAvailabilityFromFleetStatus(stdout, { provider: primaryProvider });
  if (!isGroundedProviderState(primaryAvailability.state)) {
    // Primary is `ok` (healthy → auto-revert) or ambiguous (degraded/unknown/
    // missing → do not guess). Either way, keep the primary.
    return {
      ...base,
      reason: primaryAvailability.available ? 'primary-available' : 'primary-not-grounded',
      provider: primaryProvider,
      primaryState: primaryAvailability.state,
    };
  }

  // Primary is authoritatively grounded. Pick the first fallback whose provider
  // is not ALSO grounded.
  for (const candidate of fallbacks) {
    if (candidate === primary) continue;
    const candidateProvider = providerForCloserWorkerClass(candidate);
    if (candidateProvider) {
      const candidateAvailability = providerAvailabilityFromFleetStatus(stdout, {
        provider: candidateProvider,
      });
      if (isGroundedProviderState(candidateAvailability.state)) continue;
    }
    return {
      workerClass: candidate,
      fellBack: true,
      from: primary,
      to: candidate,
      provider: primaryProvider,
      primaryState: primaryAvailability.state,
      fallbackProvider: candidateProvider,
    };
  }

  // Every configured fallback is also grounded (or none differ from the
  // primary). Keep the primary — a doomed spawn on the primary is no worse than
  // a doomed spawn on an equally-grounded fallback, and it preserves auto-revert.
  return {
    ...base,
    reason: 'all-fallbacks-grounded',
    provider: primaryProvider,
    primaryState: primaryAvailability.state,
  };
}
