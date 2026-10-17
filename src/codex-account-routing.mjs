import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './atomic-write.mjs';
import { resolveAdversarialReviewStateDir } from './reviewer-fence.mjs';
import { harnessCapFromStatuses, quotaStatusesFromSnapshot } from './fleet-quota-status.mjs';

// Reviewer accounts share a model family, but never quota or broker evidence.
export function selectCodexReviewerAccount(payload, { model = null,
  statuses = quotaStatusesFromSnapshot(payload), corporateExhausted = false } = {}) {
  for (const [provider, authPath] of [['codex-corp', 'oauth-corp'], ['codex', 'oauth']]) {
    const cap = harnessCapFromStatuses(statuses, { harness: provider, model, authPath });
    const row = payload?.providerStatuses?.find(entry => entry.provider === 'openai'
      && (entry.authPath || entry.auth_path) === authPath);
    const weekly = payload?.reserveFloors?.[`openai-${authPath}`]?.weeklyMeasurement;
    const measured = weekly?.status === 'measured' && Number.isFinite(weekly.percentRemaining)
      && weekly.percentRemaining >= 0 && weekly.percentRemaining <= 100;
    const ready = payload?.brokerAuth?.provider_states?.[provider];
    // Stale quota cannot prove either capacity or exhaustion. Local typed
    // exhaustion and an explicitly unavailable broker are independent evidence.
    const fresh = row?.cachedEvidenceStale !== true;
    const exhausted = (provider === 'codex-corp' && corporateExhausted)
      || (fresh && (cap.capped || (measured && weekly.percentRemaining === 0)));
    if (!exhausted && fresh && measured && cap.available
      && ready?.ready === true && ready?.can_serve === true) {
      return { provider, authPath, hold: false, reason: 'codex-account-ready' };
    }
    if (!exhausted && ready?.ready !== false && ready?.can_serve !== false) {
      return { hold: true, reason: 'codex-account-evidence-unknown' };
    }
  }
  return { hold: true, reason: 'no-ready-codex-account' };
}

export function codexReviewerAccountForGrounding(grounding, options = {}) {
  if (grounding?.staleIfError || !grounding?.codexAccountSnapshot) {
    return { hold: true, reason: 'codex-account-evidence-unknown' };
  }
  return selectCodexReviewerAccount(grounding.codexAccountSnapshot, {
    model: grounding.codexAccountModel, ...options,
  });
}

export function readCorporateCodexQuotaCooldown(rootDir, { env = process.env, nowMs = Date.now() } = {}) {
  try {
    const state = JSON.parse(readFileSync(join(resolveAdversarialReviewStateDir(rootDir, env), 'codex-corporate-quota-cooldown.json'), 'utf8'));
    return Date.parse(state.resetAt) > nowMs ? state : null;
  } catch { return null; }
}

export function recordCorporateCodexQuotaCooldown(rootDir, { resetAt = null, env = process.env, nowMs = Date.now() } = {}) {
  const resetMs = Date.parse(resetAt);
  const end = Number.isFinite(resetMs) && resetMs > nowMs ? resetMs : nowMs + 15 * 60 * 1000;
  const state = { resetAt: new Date(Math.min(end, nowMs + 7 * 24 * 60 * 60 * 1000)).toISOString() };
  writeFileAtomic(join(resolveAdversarialReviewStateDir(rootDir, env), 'codex-corporate-quota-cooldown.json'), JSON.stringify(state));
  return state;
}
