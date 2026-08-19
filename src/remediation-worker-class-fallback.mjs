// Cap-aware remediation worker-class fallback (the remediation-dispatch analogue
// of the AMA closer HHR harness-fallback in ./ama/harness-fallback.mjs).
//
// SEV (2026-08-19): the remediation-worker class is routed by builder-tag writer
// diversity (`pickRemediationWorkerClass`): a [claude-code] PR routes to `codex`
// to remediate. When codex's OpenAI-OAuth quota is EXHAUSTED, that routed codex
// worker cannot spawn — it quota-holds and the PR sits un-remediated (observed on
// #5542 while codex was capped until 2026-08-20). The merge/hammer path already
// auto-falls-back (`roles.adversarial.merge_authority.worker_class_fallback`), but
// the remediation path did not, so an operator had to hand-pin
// `ADVERSARIAL_REVIEW_DEFAULT_REMEDIATOR=claude-code` and un-pin it on recovery.
//
// This module removes the hard-pin churn: when the routed primary harness's
// provider is AUTHORITATIVELY quota-grounded (exhausted/suspended, per
// `hq fleet quota status --json` — the same classifier the closer HHR path uses),
// fall back to the first configured fallback harness whose provider has quota. It
// AUTO-REVERTS: the check runs on every consume, so the routed primary is used
// again the moment its provider recovers. Soft/unknown/degraded provider signals
// are deliberately NOT treated as grounded ("do not guess"), and an unreadable
// status keeps the primary (fail-open, matching HHR).
import { promisify } from 'node:util';
import { execFile as execFileCb } from 'node:child_process';

import {
  quotaAvailableFromFleetStatus,
  providerForQuotaHarness,
  isGroundedProviderState,
} from './fleet-quota-status.mjs';

const execFileAsync = promisify(execFileCb);
const FLEET_QUOTA_STATUS_TIMEOUT_MS = 20_000;

// Default fallback chain when the routed remediator harness is grounded: drop to
// claude-code (AFH). Operator-tunable via a comma-separated env override; `[]`
// (or a single empty value) disables the fallback and restores the pre-2026-08-19
// behavior (a capped remediator quota-holds instead of falling back).
const DEFAULT_REMEDIATION_WORKER_CLASS_FALLBACK = Object.freeze(['claude-code']);

export function remediationWorkerClassFallback(env = process.env) {
  const raw = env?.ADVERSARIAL_REVIEW_REMEDIATOR_WORKER_CLASS_FALLBACK;
  if (raw === undefined || raw === null) return [...DEFAULT_REMEDIATION_WORKER_CLASS_FALLBACK];
  return String(raw)
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function resolveHqPath(env = process.env) {
  return String(env?.AGENT_OS_HQ_BIN || env?.HQ_BIN || 'hq').trim() || 'hq';
}

/**
 * @param {Object} args
 * @param {string} args.primary — the routed remediation worker_class (from pickRemediationWorkerClass).
 * @param {string[]=} args.fallbackWorkerClasses — ordered fallback harnesses.
 * @param {Object=} args.env
 * @param {string=} args.hqPath
 * @param {Function=} args.execFileImpl — DI for `hq fleet quota status --json`.
 * @returns {Promise<{ workerClass: string, fellBack: boolean, reason: string,
 *   from?: string, to?: string, primaryState?: string, error?: string }>}
 */
export async function resolveRemediationWorkerClassWithFallback({
  primary,
  fallbackWorkerClasses,
  env = process.env,
  hqPath = resolveHqPath(env),
  execFileImpl = execFileAsync,
} = {}) {
  const primaryClass = String(primary || '').trim().toLowerCase();
  const fallbacks = (Array.isArray(fallbackWorkerClasses) ? fallbackWorkerClasses : [])
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean);
  const base = { workerClass: primaryClass, fellBack: false };

  if (!primaryClass || fallbacks.length === 0) {
    return { ...base, reason: 'no-fallback-configured' };
  }
  if (!providerForQuotaHarness(primaryClass)) {
    // The routed harness has no tracked provider — we cannot authoritatively
    // ground it, so never fall back (mirrors HHR 'primary-provider-untracked').
    return { ...base, reason: 'primary-provider-untracked' };
  }

  let stdout;
  try {
    const result = await execFileImpl(hqPath, ['fleet', 'quota', 'status', '--json'], {
      env,
      encoding: 'utf8',
      maxBuffer: 5 * 1024 * 1024,
      timeout: FLEET_QUOTA_STATUS_TIMEOUT_MS,
    });
    stdout = typeof result === 'string' ? result : String(result?.stdout || '');
  } catch (err) {
    // Fail-open: a status we cannot read is not authoritative grounding.
    return { ...base, reason: 'fleet-quota-status-unavailable', error: String(err?.message || err) };
  }

  const primaryAvail = quotaAvailableFromFleetStatus(stdout, { harness: primaryClass });
  // Only an AUTHORITATIVE ground (exhausted/suspended/grounded) warrants a
  // fallback. `ok`, `degraded`, `unknown`, or a missing state is NOT grounding
  // ("do not guess") -- keep the routed primary in every non-grounded case.
  if (!isGroundedProviderState(primaryAvail.state)) {
    return {
      ...base,
      reason: primaryAvail.available ? 'primary-available' : 'primary-not-grounded',
      primaryState: primaryAvail.state,
    };
  }

  for (const candidate of fallbacks) {
    if (candidate === primaryClass) continue;
    if (!providerForQuotaHarness(candidate)) continue;
    const candidateAvail = quotaAvailableFromFleetStatus(stdout, { harness: candidate });
    if (candidateAvail.available) {
      return {
        workerClass: candidate,
        fellBack: true,
        from: primaryClass,
        to: candidate,
        reason: 'primary-grounded-fallback',
        primaryState: primaryAvail.state,
      };
    }
  }

  // No fallback provider has quota either — keep the primary (it quota-holds as
  // before rather than dispatching onto a second grounded provider).
  return { ...base, reason: 'no-available-fallback', primaryState: primaryAvail.state };
}
