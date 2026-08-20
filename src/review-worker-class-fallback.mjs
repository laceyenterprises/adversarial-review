import { promisify } from 'node:util';
import { execFile as execFileCb } from 'node:child_process';

import {
  quotaAvailableFromFleetStatus,
  providerForQuotaHarness,
  isGroundedProviderState,
} from './fleet-quota-status.mjs';

const execFileAsync = promisify(execFileCb);
const FLEET_QUOTA_STATUS_TIMEOUT_MS = 20_000;

const DEFAULT_REVIEWER_WORKER_CLASS_FALLBACK = Object.freeze(['claude-code']);

export function reviewWorkerClassFallback(env = process.env) {
  const raw = env?.ADVERSARIAL_REVIEW_REVIEWER_WORKER_CLASS_FALLBACK;
  if (raw === undefined || raw === null) return [...DEFAULT_REVIEWER_WORKER_CLASS_FALLBACK];
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
 * @param {string} args.authorClass — the PR author worker class.
 * @param {string} args.primary — the routed reviewer worker_class.
 * @param {string[]=} args.fallbackWorkerClasses — ordered fallback harnesses.
 * @param {Object=} args.env
 * @param {string=} args.hqPath
 * @param {Function=} args.execFileImpl — DI for `hq fleet quota status --json`.
 * @returns {Promise<{ workerClass: string, fellBack: boolean, reason: string,
 *   from?: string, to?: string, primaryState?: string, error?: string }>}
 */
export async function resolveReviewerWorkerClassWithFallback({
  authorClass,
  primary,
  fallbackWorkerClasses,
  env = process.env,
  hqPath = resolveHqPath(env),
  execFileImpl = execFileAsync,
} = {}) {
  const author = String(authorClass || '').trim().toLowerCase();
  const primaryClass = String(primary || '').trim().toLowerCase();
  const fallbacks = (Array.isArray(fallbackWorkerClasses) ? fallbackWorkerClasses : [])
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean);
  const base = { workerClass: primaryClass, fellBack: false };

  if (!primaryClass || fallbacks.length === 0) {
    return { ...base, reason: 'no-fallback-configured' };
  }
  if (!providerForQuotaHarness(primaryClass)) {
    return { ...base, reason: 'primary-provider-untracked' };
  }
  const viableFallbacks = fallbacks.filter((candidate) => (
    candidate !== primaryClass &&
    candidate !== author &&
    providerForQuotaHarness(candidate)
  ));
  if (viableFallbacks.length === 0) {
    return { ...base, reason: 'no-available-fallback' };
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
    return { ...base, reason: 'fleet-quota-status-unavailable', error: String(err?.message || err) };
  }

  const primaryAvail = quotaAvailableFromFleetStatus(stdout, { harness: primaryClass });
  if (!isGroundedProviderState(primaryAvail.state)) {
    return {
      ...base,
      reason: primaryAvail.available ? 'primary-available' : 'primary-not-grounded',
      primaryState: primaryAvail.state,
    };
  }

  for (const candidate of viableFallbacks) {
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

  return { ...base, reason: 'no-available-fallback', primaryState: primaryAvail.state };
}
