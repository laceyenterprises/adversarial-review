import { boundedDiagnostics } from './producer-contracts/diagnostics.mjs';
import { readBrokerProvider } from './producer-contracts/broker-evidence.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './atomic-write.mjs';
import { resolveAdversarialReviewStateDir } from './reviewer-fence.mjs';
import { normalizeReviewerModel } from './adapters/subject/github-pr/routing.mjs';
import { personalClaudeReviewerFloor } from './reviewer-reserve-floor.mjs';
// Account selection consumes the canonical fleet projection. Freshness and
// reserve arithmetic stay in quota_reserve; reviewers additionally bind its
// projected weekly capacity to the projected personal reserve threshold.
import { harnessCapFromStatuses, quotaStatusesFromSnapshot, parseHqFleetQuotaSnapshot, reserveFloorWeeklyMeasurement, quotaAccountDiagnostics } from './fleet-quota-status.mjs';

const LANES = Object.freeze({
  'hammer-claude': 'hammer-claude-corp',
  'remediator-claude': 'remediator-claude-corp',
  'claude-reviewer': 'claude-reviewer-corp',
});

// The corporate twin of a Claude lane (either name of the pair), else null.
export function corporateClaudeLane(workerClass) {
  return LANES[String(workerClass || '').replace(/-corp$/, '')] || null;
}

export function resolveClaudeBrokerProvider(env = process.env) {
  const provider = String(env.CLAUDE_BROKER_PROVIDER || 'claude-code').trim();
  if (!['claude-code', 'claude-code-corp'].includes(provider)) {
    throw new Error('unsupported Claude broker provider');
  }
  return provider;
}

// null preserves legacy ambiguity behavior on older fleet projections. A
// projected corporate account requires independently confirmed headroom and
// serviceability; absence/staleness cannot manufacture an available account.
export function selectClaudeAccountLane(stdout, options = {}) {
  return selectClaudeAccountLaneFromSnapshot(parseHqFleetQuotaSnapshot(stdout), options);
}

export function selectClaudeAccountLaneFromSnapshot(payload, { workerClass, model = null,
  statuses = quotaStatusesFromSnapshot(payload), blockedWorkerClasses = [] } = {}) {
  const primary = String(workerClass || '').replace(/-corp$/, '');
  const corporate = LANES[primary];
  if (!corporate) return null; // Never substitute a builder for a privileged lane.
  const hasCorporate = statuses.some(row => row.provider === 'anthropic' && row.authPath === 'oauth-corp');
  if (!hasCorporate && !payload?.brokerAuth?.provider_states?.['claude-code-corp']
    && workerClass !== corporate && !blockedWorkerClasses.includes(corporate)) return null;
  const diagnostics = [];
  for (const [lane, authPath, provider] of [
    [corporate, 'oauth-corp', 'claude-code-corp'],
    [primary, 'oauth', 'claude-code'],
  ]) {
    const cap = harnessCapFromStatuses(statuses, { harness: lane, model, authPath });
    // Preserve the existing malformed-input exception, with its producer field.
    if (payload?.providerStatuses != null && typeof payload.providerStatuses.find !== 'function') {
      throw new TypeError('cwp_dispatch.cli_fleet: $.providerStatuses invalid; expected array');
    }
    const row = payload?.providerStatuses?.find(entry => String(entry?.provider || '').trim().toLowerCase() === 'anthropic'
      && (entry.authPath || entry.auth_path) === authPath);
    const policy = payload?.reserveFloors?.[`anthropic-${authPath}`];
    const broker = readBrokerProvider(payload?.brokerAuth, provider);
    const ready = { ready: broker.ready, can_serve: broker.canServe };
    diagnostics.push(...quotaAccountDiagnostics(payload, { provider: 'anthropic', authPath, cap, reserve: lane !== corporate }), ...broker.diagnostics);
    const locallyBlocked = blockedWorkerClasses.includes(lane);
    const weekly = reserveFloorWeeklyMeasurement(policy);
    const measured = weekly?.status === 'measured' && Number.isFinite(weekly.percentRemaining)
      && weekly.percentRemaining >= 0 && weekly.percentRemaining <= 100;
    const exhausted = locallyBlocked || cap.capped || (measured && weekly.percentRemaining === 0);
    const reserveAllows = lane === corporate
      || (policy?.active === false && policy?.paused === false && policy?.nearCap === false
        && !personalClaudeReviewerFloor(payload, { workerClass: primary }));
    if (!exhausted && cap.available && row?.cachedEvidenceStale !== true && measured && reserveAllows
      && ready?.ready === true && ready?.can_serve === true) {
      return { workerClass: lane, provider, authPath, hold: false, reason: 'claude-account-ready' };
    }
    if (lane === corporate && !exhausted && ready?.ready !== false && ready?.can_serve !== false) {
      return { workerClass, hold: true, reason: 'claude-account-evidence-unknown', diagnostics: boundedDiagnostics(diagnostics) };
    }
  }
  return { workerClass, hold: true, reason: 'no-ready-claude-account', diagnostics: boundedDiagnostics(diagnostics) };
}

// Credential outage state is account-scoped. The review family remains Claude.
export function reviewerCredentialKey(reviewerModel, claudeBrokerProvider) {
  return normalizeReviewerModel(reviewerModel) === 'claude' && claudeBrokerProvider === 'claude-code-corp'
    ? 'claude-code-corp' : reviewerModel;
}

// Typed spawn exhaustion is independent of a lagging fleet projection. Keep it
// account-scoped and bounded by the provider reset (or a short retry window).
export function readCorporateClaudeQuotaCooldown(rootDir, { env = process.env, nowMs = Date.now() } = {}) {
  try {
    const state = JSON.parse(readFileSync(join(resolveAdversarialReviewStateDir(rootDir, env), 'claude-corporate-quota-cooldown.json'), 'utf8'));
    return Date.parse(state.resetAt) > nowMs ? state : null;
  } catch { return null; }
}

export function recordCorporateClaudeQuotaCooldown(rootDir, { resetAt = null, env = process.env, nowMs = Date.now() } = {}) {
  const resetMs = Date.parse(resetAt);
  const end = Number.isFinite(resetMs) && resetMs > nowMs ? resetMs : nowMs + 15 * 60 * 1000;
  const state = { resetAt: new Date(Math.min(end, nowMs + 7 * 24 * 60 * 60 * 1000)).toISOString() };
  writeFileAtomic(join(resolveAdversarialReviewStateDir(rootDir, env), 'claude-corporate-quota-cooldown.json'), JSON.stringify(state));
  return state;
}
