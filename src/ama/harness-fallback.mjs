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
//   2. If the configured (primary) worker_class's provider is grounded — either
//      HARD (exhausted/suspended) or SOFT (AFH-02's `afhGrounding` verdict, see
//      below) — pick the first configured fallback worker_class whose provider
//      is NOT also grounded and dispatch on THAT harness instead.
//   3. If the primary provider is `ok` — or its state is ambiguous
//      (degraded/unknown/missing) — keep the primary. That yields automatic
//      auto-revert: the moment codex recovers to `ok`, the next close returns to
//      the configured primary with no manual flip.
//
// AFH-05 adds the SOFT limb of (2). The hard states are a real 429: a *flapping*
// codex outage leaves the probe row at `state: unknown` forever, so the hard gate
// stays dark exactly when the operator reaches for a manual `worker_class` pin
// (proven live 2026-08-06: codex down, ~100% usage, 10 suspended LRQs, probe
// `unknown`). AFH-02 (agent-os #4999) publishes the sustained-exhaustion verdict
// on `hq fleet quota status --json` as a per-provider `afhGrounding` object; we
// READ it, we do not re-derive it, so the Python and Node sides cannot drift.
//
// The soft signal is strictly ADDITIVE: it is one more way the PRIMARY can be
// grounded. It does not touch the hard classification, the fail-open branches (an
// unreadable/absent/malformed verdict keeps the primary, same as an ambiguous
// hard state), or auto-revert — the verdict clears itself once the provider
// recovers, and the very next close returns to the primary.
//
// Only the physical `--worker-class` harness changes; the closer's
// terminal-remediation prompt, merge-under-lease behavior, and audit provenance
// all continue to key off the LOGICAL worker_class at the call site. It is the
// MERGE path that must survive a cap, not the harness identity.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  isGroundedProviderState,
  parseHqFleetQuotaStatus,
  providerAvailabilityFromStatuses,
  providerSoftGroundingFromStatuses,
} from '../fleet-quota-status.mjs';

const execFileAsync = promisify(execFile);

const FLEET_QUOTA_STATUS_TIMEOUT_MS = 10_000;

// Closer/hammer worker_class → HHR provider whose OAuth quota gates whether that
// harness can spawn at all. `hammer` runs on the codex harness (OpenAI OAuth),
// which is exactly the family LAC-1463 exhausted. Kept in sync with
// QUOTA_HARNESS_PROVIDER in ../fleet-quota-status.mjs.
export const CLOSER_WORKER_CLASS_PROVIDER = Object.freeze({
  hammer: 'openai',
  // hammer-claude: the codex-quota fallback merge class — the-hammer-lacey merge
  // identity on the claude harness, so its gating provider is anthropic (the
  // whole point is that it's live when codex/openai is grounded).
  'hammer-claude': 'anthropic',
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
 *   primaryState?: string,    // the HARD state, never rewritten by the soft limb
 *   groundedBy?: 'hard'|'soft'|'hard+soft',
 *   softGrounded?: boolean,   // AFH-02 verdict said the primary is soft-grounded
 *   softGrounding?: Object|null, // the raw afhGrounding verdict, for the audit
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

  // Both limbs are read from the SAME single status payload, so the hard state
  // and the soft verdict can never describe different moments. Parse it ONCE
  // here: the primary's two limbs and every fallback candidate below all query
  // the same parsed rows, instead of re-parsing the identical stdout per lookup
  // on the closer's dispatch path. A malformed payload throws out of the parser
  // — fail open to the primary here too, rather than leaning on the call site's
  // catch, so this module's own contract holds.
  let providerStatuses;
  let primaryAvailability;
  let primarySoft;
  try {
    providerStatuses = parseHqFleetQuotaStatus(stdout);
    primaryAvailability = providerAvailabilityFromStatuses(providerStatuses, { provider: primaryProvider });
    primarySoft = providerSoftGroundingFromStatuses(providerStatuses, { provider: primaryProvider });
  } catch (err) {
    return { ...base, reason: 'fleet-quota-status-unreadable', error: String(err?.message || err) };
  }

  const hardGrounded = isGroundedProviderState(primaryAvailability.state);
  const softGrounded = primarySoft.grounded === true;
  if (!hardGrounded && !softGrounded) {
    // Primary is `ok` (healthy → auto-revert) or ambiguous (degraded/unknown/
    // missing, and no soft verdict → do not guess). Either way, keep the primary.
    return {
      ...base,
      reason: primaryAvailability.available ? 'primary-available' : 'primary-not-grounded',
      provider: primaryProvider,
      primaryState: primaryAvailability.state,
      softGrounded: false,
      softGrounding: primarySoft.verdict,
    };
  }

  // Which limb grounded the primary. Reported verbatim on the audit record so a
  // soft verdict is never read back as the hard 429 classification (SPEC §10) —
  // `primaryState` keeps reporting the untouched hard state (often `unknown`).
  const groundedBy = hardGrounded && softGrounded ? 'hard+soft' : (hardGrounded ? 'hard' : 'soft');
  const groundingFields = {
    provider: primaryProvider,
    primaryState: primaryAvailability.state,
    groundedBy,
    softGrounded,
    softGrounding: primarySoft.verdict,
  };

  // Primary is authoritatively grounded (hard, soft, or both). Pick the first
  // fallback whose provider is not ALSO grounded.
  //
  // Candidate screening stays HARD-only, deliberately: AFH-05's scope is one
  // additional way the PRIMARY is grounded. Skipping merely soft-grounded
  // candidates too would be a second behavior change, and it can only ever
  // subtract a fallback — leaving the closer on an already-grounded primary,
  // which is the outcome this pack exists to prevent.
  for (const candidate of fallbacks) {
    if (candidate === primary) continue;
    const candidateProvider = providerForCloserWorkerClass(candidate);
    if (candidateProvider) {
      const candidateAvailability = providerAvailabilityFromStatuses(providerStatuses, {
        provider: candidateProvider,
      });
      if (isGroundedProviderState(candidateAvailability.state)) continue;
    }
    return {
      workerClass: candidate,
      fellBack: true,
      from: primary,
      to: candidate,
      ...groundingFields,
      fallbackProvider: candidateProvider,
    };
  }

  // Every configured fallback is also grounded (or none differ from the
  // primary). Keep the primary — a doomed spawn on the primary is no worse than
  // a doomed spawn on an equally-grounded fallback, and it preserves auto-revert.
  return {
    ...base,
    reason: 'all-fallbacks-grounded',
    ...groundingFields,
  };
}
