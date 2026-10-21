import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './atomic-write.mjs';
import { resolveAdversarialReviewStateDir } from './reviewer-fence.mjs';
import { harnessCapFromStatuses, quotaStatusesFromSnapshot, reserveFloorWeeklyMeasurement } from './fleet-quota-status.mjs';
import { ENUM_CODEX_WORKER_ACCOUNT_ORDER } from './config-loader.mjs';

// Accounts share a model family, but never quota or broker evidence. Keep the
// reviewer order separate from the configurable automatic worker order.
const REVIEWER_ORDER = [['codex-corp', 'oauth-corp'], ['codex', 'oauth']];
const WORKER_ORDER = [['codex', 'oauth'], ['codex-corp', 'oauth-corp']];

export function selectCodexReviewerAccount(payload, options = {}) {
  return selectCodexAccount(payload, REVIEWER_ORDER, options);
}

export function selectCodexWorkerAccount(payload, options = {}) {
  const order = options.policy === 'corporate-first' ? REVIEWER_ORDER : WORKER_ORDER;
  return selectCodexAccount(payload, order, { ...options, fallThroughUnknown: true });
}

export function isAutomaticCodexAccountPolicy(policy) {
  return ENUM_CODEX_WORKER_ACCOUNT_ORDER.includes(policy);
}

function selectCodexAccount(payload, order, { model = null,
  statuses = quotaStatusesFromSnapshot(payload), corporateExhausted = false, personalExhausted = false,
  fallThroughUnknown = false } = {}) {
  const rows = Array.isArray(payload?.providerStatuses) ? payload.providerStatuses : [];
  let unknownEvidence = false;
  for (const [provider, authPath] of order) {
    const cap = harnessCapFromStatuses(statuses, { harness: provider, model, authPath });
    const row = rows.find(entry => entry?.provider === 'openai'
      && (entry.authPath || entry.auth_path) === authPath);
    const weekly = reserveFloorWeeklyMeasurement(payload?.reserveFloors?.[`openai-${authPath}`]);
    const measured = weekly?.status === 'measured' && Number.isFinite(weekly.percentRemaining)
      && weekly.percentRemaining >= 0 && weekly.percentRemaining <= 100;
    const ready = payload?.brokerAuth?.provider_states?.[provider];
    // Stale quota cannot prove either capacity or exhaustion. Local typed
    // exhaustion and an explicitly unavailable broker are independent evidence.
    const fresh = row?.cachedEvidenceStale !== true;
    const exhausted = (provider === 'codex-corp' && corporateExhausted)
      || (provider === 'codex' && personalExhausted)
      || (fresh && (cap.capped || (measured && weekly.percentRemaining === 0)));
    if (!exhausted && fresh && measured && cap.available
      && ready?.ready === true && ready?.can_serve === true) {
      return { provider, authPath, hold: false,
        reason: unknownEvidence ? 'codex-account-evidence-unknown-fallback-ready' : 'codex-account-ready' };
    }
    if (!exhausted && ready?.ready !== false && ready?.can_serve !== false) {
      if (!fallThroughUnknown) return { hold: true, reason: 'codex-account-evidence-unknown' };
      // Workers may use independently measured capacity on the next account;
      // unknown evidence never admits this account or proves it exhausted.
      unknownEvidence = true;
    }
  }
  return { hold: true, reason: unknownEvidence ? 'codex-account-evidence-unknown' : 'no-ready-codex-account' };
}

// Only unpinned Codex lanes opt into account substitution. Corporate classes
// already name an account and retain their existing dispatch/cap behavior.
export function codexWorkerLaneFromSnapshot(payload, { workerClass, policy = 'personal-first', ...options } = {}) {
  if (!isAutomaticCodexAccountPolicy(policy) || !['hammer', 'codex'].includes(workerClass)) return null;
  const account = selectCodexWorkerAccount(payload, { ...options, policy });
  if (account.hold) return { ...account, workerClass };
  const preferred = policy === 'corporate-first' ? 'corporate' : 'personal';
  const selected = account.provider === 'codex' ? 'personal' : 'corporate';
  return { ...account,
    workerClass: account.provider === 'codex' ? workerClass
      : workerClass === 'hammer' ? 'hammer-corp' : 'remediator-codex-corp',
    reason: selected === preferred ? `${selected}-ready`
      : account.reason === 'codex-account-evidence-unknown-fallback-ready'
        ? `${preferred}-evidence-unknown-${selected}-ready` : `${preferred}-unavailable-${selected}-ready`,
  };
}

export function logCodexWorkerDispatch(log, workerClass, routing = {}, prefix = 'review-worker') {
  if (!['hammer', 'hammer-corp', 'codex', 'remediator-codex-corp'].includes(workerClass)) return;
  const account = workerClass.endsWith('-corp') ? 'corporate' : 'personal';
  (log?.info || log?.log)?.call(log, `[${prefix}] codex_account=${account} worker_class=${workerClass} reason=${routing?.reason || 'explicit-worker-class-pin'}`);
}

export function codexReviewerAccountForGrounding(grounding, options = {}) {
  if (grounding?.codexAccountSelection?.pooled && !grounding.staleIfError) return grounding.codexAccountSelection;
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
  const existing = readCorporateCodexQuotaCooldown(rootDir, { env, nowMs });
  const end = Math.max(existing ? Date.parse(existing.resetAt) : 0,
    Number.isFinite(resetMs) && resetMs > nowMs ? resetMs : nowMs + 15 * 60 * 1000);
  const state = { resetAt: new Date(Math.min(end, nowMs + 7 * 24 * 60 * 60 * 1000)).toISOString() };
  writeFileAtomic(join(resolveAdversarialReviewStateDir(rootDir, env), 'codex-corporate-quota-cooldown.json'), JSON.stringify(state));
  return state;
}
