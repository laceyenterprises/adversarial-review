import { normalizeReviewerModel } from './adapters/subject/github-pr/routing.mjs';
// Account selection consumes the canonical fleet projection. Weekly thresholds,
// freshness and reserve arithmetic stay in quota_reserve, not in this service.
import { harnessCapFromStatuses, quotaStatusesFromSnapshot, parseHqFleetQuotaSnapshot } from './fleet-quota-status.mjs';

const LANES = Object.freeze({
  'hammer-claude': 'hammer-claude-corp',
  'remediator-claude': 'remediator-claude-corp',
  'claude-reviewer': 'claude-reviewer-corp',
});

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
    && workerClass !== corporate) return null;
  for (const [lane, authPath, provider] of [
    [corporate, 'oauth-corp', 'claude-code-corp'],
    [primary, 'oauth', 'claude-code'],
  ]) {
    const cap = harnessCapFromStatuses(statuses, { harness: lane, model, authPath });
    const row = payload?.providerStatuses?.find(entry => entry.provider === 'anthropic'
      && (entry.authPath || entry.auth_path) === authPath);
    const policy = payload?.reserveFloors?.[`anthropic-${authPath}`];
    const ready = payload?.brokerAuth?.provider_states?.[provider];
    const locallyBlocked = blockedWorkerClasses.includes(lane);
    const weekly = policy?.weeklyMeasurement;
    if (!locallyBlocked && cap.available && row?.cachedEvidenceStale !== true && weekly?.status === 'measured'
      && Number.isFinite(weekly.percentRemaining) && weekly.percentRemaining >= 0 && weekly.percentRemaining <= 100
      && policy.active === false && policy.paused === false && policy.nearCap === false
      && ready?.ready === true && ready?.can_serve === true) {
      return { workerClass: lane, provider, authPath, hold: false, reason: 'claude-account-ready' };
    }
    if (lane === corporate && !locallyBlocked && !cap.capped && !policy?.nearCap && !policy?.active
      && !policy?.paused && ready?.ready !== false && ready?.can_serve !== false) {
      return { workerClass, hold: true, reason: 'claude-account-evidence-unknown' };
    }
  }
  return { workerClass, hold: true, reason: 'no-ready-claude-account' };
}

// Credential outage state is account-scoped. The review family remains Claude.
export function reviewerCredentialKey(reviewerModel, claudeBrokerProvider) {
  return normalizeReviewerModel(reviewerModel) === 'claude' && claudeBrokerProvider === 'claude-code-corp'
    ? 'claude-code-corp' : reviewerModel;
}
