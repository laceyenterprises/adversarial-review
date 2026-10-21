import { loadAwareTimeoutMs } from '../load-aware-timeout.mjs';
import { resolvePooledWorkerRouting } from '../worker-token-pool.mjs';
import { FLEET_QUOTA_STATUS_TIMEOUT_MS } from '../fleet-quota-status.mjs';
import { selectClaudeAccountLaneFromSnapshot } from '../claude-account-routing.mjs';
import { codexWorkerLaneFromSnapshot, isAutomaticCodexAccountPolicy } from '../codex-account-routing.mjs';
// LANEFAILOVER-01: unpinned Codex hammers resolve the configured account order
// using the reviewer account evidence classifier. Unknown evidence holds.
// Explicit pins and non-Codex classes retain the HHR behavior below.
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

import { resolveRemediationModel } from '../adapters/agent-runtime/local/remediation.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { writeFileAtomic } from '../atomic-write.mjs';
import {
  AFH_FLEET_QUOTA_STATUS_RETRY_DELAYS_MS,
  readFleetQuotaStatusStdoutWithRetry,
} from '../afh-reviewer-fallback.mjs';
import { fileURLToPath } from 'node:url';

import {
  isGroundedProviderState,
  harnessCapFromStatuses,
  parseHqFleetQuotaSnapshot,
  quotaStatusesFromSnapshot,
  providerAvailabilityFromStatuses,
  providerSoftGroundingFromStatuses,
} from '../fleet-quota-status.mjs';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const SUBMODULE_ROOT = resolve(__dirname, '..', '..');
const AGENT_OS_ROOT = resolve(SUBMODULE_ROOT, '..', '..');

const LAST_GOOD_SNAPSHOT_MAX_AGE_MS = 10 * 60 * 1000;

// Closer/hammer worker_class → HHR provider whose OAuth quota gates whether that
// harness can spawn at all. `hammer` runs on the codex harness (OpenAI OAuth),
// which is exactly the family LAC-1463 exhausted. Kept in sync with
// QUOTA_HARNESS_PROVIDER in ../fleet-quota-status.mjs.
export const CLOSER_WORKER_CLASS_PROVIDER = Object.freeze({
  hammer: 'openai',
  'hammer-corp': 'openai',
  // hammer-claude: the codex-quota fallback merge class — the-hammer-lacey merge
  // identity on the claude harness, so its gating provider is anthropic (the
  // whole point is that it's live when codex/openai is grounded).
  'hammer-claude': 'anthropic',
  'hammer-claude-corp': 'anthropic',
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

// The dispatch owner supplies its state root. Callers without a durable state
// directory can omit rootDir and retain live-only resolution.
export function closerQuotaSnapshotPath(rootDir) {
  return join(rootDir, 'data', 'ama-closer-quota-snapshot.json');
}

function parseCloserQuotaSnapshot(stdout) {
  const snapshot = parseHqFleetQuotaSnapshot(stdout);
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new Error('fleet quota status must be a JSON object');
  }
  return snapshot;
}

function recentQuotaSnapshot(rootDir, nowMs) {
  if (!rootDir) return null;
  try {
    const cached = JSON.parse(readFileSync(closerQuotaSnapshotPath(rootDir), 'utf8'));
    const ageMs = nowMs - cached.readAt;
    if (typeof cached.readAt !== 'number' || !Number.isFinite(ageMs)
      || ageMs < 0 || ageMs >= LAST_GOOD_SNAPSHOT_MAX_AGE_MS) return null;
    const snapshot = parseCloserQuotaSnapshot(JSON.stringify(cached.payload));
    return { snapshot, ageMs, readAt: cached.readAt };
  } catch {
    return null;
  }
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
 * @param {string=} args.rootDir — dispatch owner's state root; enables disk snapshots.
 * @param {Function=} args.nowMs — injected clock, evaluated after the live read.
 * @param {Function=} args.sleepImpl — injected retry delay.
 * @param {'personal-first'|'corporate-first'|'pinned'=} args.codexAccountPolicy — dispatch wrappers preserve operator pins.
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
 *   evidenceSource?: 'live'|'last-good-snapshot',
 *   evidenceAgeMs?: number,
 *   evidenceReadAt?: number, // original read completion, epoch milliseconds
 *   liveReadReason?: string,
 *   error?: string,
 * }>}
 */
export async function resolveCloserDispatchHarness({
  workerClass,
  fallbackWorkerClasses = [],
  hqPath = 'hq',
  execFileImpl = execFileAsync,
  env = process.env,
  rootDir = null,
  nowMs = Date.now,
  sleepImpl,
  codexAccountPolicy = 'corporate-first',
  selectAccountImpl,
  modelForWorkerClass = (className) => resolveRemediationModel(className, { env, fallbackModel: null }).resolvedModel,
  // CLOSERREUSE-01: the merge-agent needs the primary's grounding even with no
  // fallback configured, because it defers rather than dispatch a grounded
  // class (src/merge-agent-harness.mjs). With no fallbacks, a grounded primary
  // reports `all-fallbacks-grounded` and its grounding fields.
  probeWithoutFallbacks = true,
  // Retained for callers screening custom provider mappings. Shared cap
  // classification already screens soft grounding for tracked harnesses.
  screenSoftGroundedFallbacks = false,
} = {}) {
  const primary = String(workerClass || '').trim();
  const fallbacks = normalizeFallbackList(fallbackWorkerClasses);
  const pooled = await resolvePooledWorkerRouting({ primary, fallbackWorkerClasses: fallbacks,
    kind: 'hammer', env, modelForClass: modelForWorkerClass, selectAccountImpl,
    legacyAccountPinned: primary === 'hammer' && codexAccountPolicy === 'pinned' });
  if (pooled) return pooled;
  let base = { workerClass: primary, fellBack: false };
  const autoCodex = isAutomaticCodexAccountPolicy(codexAccountPolicy) && primary === 'hammer';

  if (!primary || (fallbacks.length === 0 && !probeWithoutFallbacks && !autoCodex)) {
    return { ...base, reason: 'no-fallback-configured' };
  }

  const primaryProvider = providerForCloserWorkerClass(primary);
  if (!primaryProvider) {
    // Primary harness is not quota-tracked — we cannot prove it is capped, so
    // never fall back on a guess.
    return { ...base, reason: 'primary-provider-untracked' };
  }

  // All account/provider decisions use the same payload. Retry transient live
  // failures before consulting a bounded last-good snapshot; never renew the
  // snapshot timestamp on a failed read or cached use.
  let snapshot;
  let failureReason = 'fleet-quota-status-unavailable';
  let evidence;
  try {
    const stdout = await readFleetQuotaStatusStdoutWithRetry({
      resolvedHqPath: hqPath,
      hqCwd: String(env?.AGENT_OS_ROOT || AGENT_OS_ROOT).trim() || AGENT_OS_ROOT,
      execFileImpl, env, timeoutMs: loadAwareTimeoutMs(FLEET_QUOTA_STATUS_TIMEOUT_MS),
      retryDelaysMs: AFH_FLEET_QUOTA_STATUS_RETRY_DELAYS_MS, sleepImpl,
    });
    failureReason = 'fleet-quota-status-unreadable';
    snapshot = parseCloserQuotaSnapshot(stdout);
    const readAt = nowMs();
    evidence = { evidenceSource: 'live', evidenceAgeMs: 0, evidenceReadAt: readAt };
    if (rootDir) {
      try {
        writeFileAtomic(closerQuotaSnapshotPath(rootDir),
          `${JSON.stringify({ readAt, payload: snapshot })}\n`, { mode: 0o600 });
      } catch (err) {
        // A cache write fault must not discard successful live evidence.
        evidence.snapshotWriteError = String(err?.message || err);
      }
    }
  } catch (err) {
    const cached = recentQuotaSnapshot(rootDir, nowMs());
    if (!cached) {
      return { ...base, hold: autoCodex || primary === 'hammer-claude-corp',
        reason: failureReason, error: String(err?.message || err),
        diagnostics: [`cwp_dispatch.cli_fleet: $stdout ${failureReason === 'fleet-quota-status-unreadable' ? 'invalid JSON or payload' : 'unavailable'}; no fresh cached snapshot`] };
    }
    snapshot = cached.snapshot;
    evidence = { evidenceSource: 'last-good-snapshot', evidenceAgeMs: cached.ageMs,
      evidenceReadAt: cached.readAt, liveReadReason: failureReason };
  }
  base = { ...base, ...evidence };
  const providerStatuses = quotaStatusesFromSnapshot(snapshot);
  const primaryAvailability = providerAvailabilityFromStatuses(providerStatuses, {
    provider: primaryProvider, authPath: primary.endsWith('-corp') ? 'oauth-corp' : null,
  });
  const primarySoft = providerSoftGroundingFromStatuses(providerStatuses, {
    provider: primaryProvider, authPath: primary.endsWith('-corp') ? 'oauth-corp' : null,
  });

  const codexAccount = autoCodex ? codexWorkerLaneFromSnapshot(snapshot, {
    workerClass: primary, policy: codexAccountPolicy, statuses: providerStatuses,
    model: modelForWorkerClass(primary),
  }) : null;
  if (codexAccount) return { ...base, ...codexAccount,
    fellBack: codexAccount.workerClass !== primary, from: primary, to: codexAccount.workerClass,
    provider: primaryProvider, fallbackProvider: primaryProvider };

  const accountLane = (name) => selectClaudeAccountLaneFromSnapshot(snapshot, {
    statuses: providerStatuses,
    workerClass: ['claude', 'claude-code'].includes(name) ? 'hammer-claude' : name,
    model: modelForWorkerClass(name),
  });
  const primaryAccount = accountLane(primary);
  if (primaryAccount?.reason === 'claude-account-evidence-unknown') {
    return { ...base, hold: true, reason: primaryAccount.reason, diagnostics: primaryAccount.diagnostics };
  }
  if (primaryAccount && !primaryAccount.hold) {
    return { ...base, workerClass: primaryAccount.workerClass,
      fellBack: primaryAccount.workerClass !== primary, from: primary, to: primaryAccount.workerClass,
      provider: primaryProvider, fallbackProvider: primaryProvider, reason: primaryAccount.reason };
  }

  const primaryCap = harnessCapFromStatuses(providerStatuses, {
    harness: primaryProvider === 'openai' ? (primary === 'hammer-corp' ? 'codex-corp' : 'codex') : primary,
    model: modelForWorkerClass(primary),
  });
  const hardGrounded = isGroundedProviderState(primaryAvailability.state) || primaryCap.capSource === 'model-exhausted';
  const softGrounded = primarySoft.grounded === true;
  if (!primaryAccount?.hold && !hardGrounded && !softGrounded) {
    // Primary is `ok` (healthy → auto-revert) or ambiguous (degraded/unknown/
    // missing, and no soft verdict → do not guess). Either way, keep the primary.
    return {
      ...base,
      reason: primaryAvailability.available ? 'primary-available' : 'primary-not-grounded',
      provider: primaryProvider,
      primaryState: primaryAvailability.state,
      softGrounded: false,
      softGrounding: primarySoft.verdict,
      ...(!primaryAvailability.available ? { diagnostics: [primaryAvailability.diagnostic, primaryCap.diagnostic, primarySoft.diagnostic].filter(Boolean) } : {}),
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
  const diagnostics = [...(primaryAccount?.diagnostics || []), primaryAvailability.diagnostic, primaryCap.diagnostic].filter(Boolean);

  // Primary is authoritatively grounded (hard, soft, or both). Pick the first
  // fallback whose provider is not ALSO grounded.
  //
  // CCX-04: screen model caps and soft grounding on every candidate too.
  // With no admitting candidate the caller holds instead of spawning capped.
  for (let candidate of fallbacks) {
    if (candidate === primary) continue;
    const account = accountLane(candidate);
    if (account?.hold) { diagnostics.push(...(account.diagnostics || [])); continue; }
    if (account) candidate = account.workerClass;
    const candidateProvider = providerForCloserWorkerClass(candidate);
    if (candidateProvider) {
      const candidateAvailability = providerAvailabilityFromStatuses(providerStatuses, {
        provider: candidateProvider,
        authPath: candidate.endsWith('-corp') ? 'oauth-corp' : null,
      });
      const candidateCap = harnessCapFromStatuses(providerStatuses, {
        harness: candidateProvider === 'openai' ? (candidate === 'hammer-corp' ? 'codex-corp' : 'codex') : candidate,
        model: modelForWorkerClass(candidate),
      });
      diagnostics.push(...[candidateAvailability.diagnostic, candidateCap.diagnostic].filter(Boolean));
      if (candidateCap.capped || isGroundedProviderState(candidateAvailability.state)) continue;
      if (candidate === 'hammer-corp' && !candidateCap.available) continue;
      if (screenSoftGroundedFallbacks
        && providerSoftGroundingFromStatuses(providerStatuses, { provider: candidateProvider, authPath: candidate.endsWith('-corp') ? 'oauth-corp' : null }).grounded === true) {
        continue;
      }
    }
    return {
      ...evidence,
      workerClass: candidate,
      fellBack: true,
      from: primary,
      to: candidate,
      ...groundingFields,
      fallbackProvider: candidateProvider,
    };
  }

  // Every declared fallback is unavailable. Hold the grounded primary without
  // spending a dispatch attempt; re-resolve when the next tick observes recovery.
  return {
    ...base,
    reason: 'all-fallbacks-grounded',
    hold: true,
    diagnostics,
    ...groundingFields,
  };
}
