import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './atomic-write.mjs';
import { resolveAdversarialReviewStateDir } from './reviewer-fence.mjs';
import { harnessCapFromStatuses, quotaStatusesFromSnapshot, reserveFloorWeeklyMeasurement } from './fleet-quota-status.mjs';

// Accounts share a model family, but never quota or broker evidence. Keep the
// two policies explicit: reviewers are corporate-first, workers personal-first.
const REVIEWER_ORDER = [['codex-corp', 'oauth-corp'], ['codex', 'oauth']];
const WORKER_ORDER = [['codex', 'oauth'], ['codex-corp', 'oauth-corp']];

export function selectCodexReviewerAccount(payload, options = {}) {
  return selectCodexAccount(payload, REVIEWER_ORDER, options);
}

export function selectCodexWorkerAccount(payload, options = {}) {
  return selectCodexAccount(payload, WORKER_ORDER, options);
}

function selectCodexAccount(payload, order, { model = null,
  statuses = quotaStatusesFromSnapshot(payload), corporateExhausted = false, personalExhausted = false } = {}) {
  const rows = Array.isArray(payload?.providerStatuses) ? payload.providerStatuses : [];
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
      return { provider, authPath, hold: false, reason: 'codex-account-ready' };
    }
    if (!exhausted && ready?.ready !== false && ready?.can_serve !== false) {
      return { hold: true, reason: 'codex-account-evidence-unknown' };
    }
  }
  return { hold: true, reason: 'no-ready-codex-account' };
}

// Only unpinned Codex lanes opt into account substitution. Corporate classes
// already name an account and retain their existing dispatch/cap behavior.
export function codexWorkerLaneFromSnapshot(payload, { workerClass, policy = 'personal-first', ...options } = {}) {
  if (policy !== 'personal-first' || !['hammer', 'codex'].includes(workerClass)) return null;
  const account = selectCodexWorkerAccount(payload, options);
  if (account.hold) return { ...account, workerClass };
  return { ...account,
    workerClass: account.provider === 'codex' ? workerClass
      : workerClass === 'hammer' ? 'hammer-corp' : 'remediator-codex-corp',
    reason: account.provider === 'codex' ? 'personal-ready' : 'personal-unavailable-corporate-ready',
  };
}

export function logCodexWorkerDispatch(log, workerClass, routing = {}, prefix = 'review-worker') {
  if (!['hammer', 'hammer-corp', 'codex', 'remediator-codex-corp'].includes(workerClass)) return;
  const account = workerClass.endsWith('-corp') ? 'corporate' : 'personal';
  (log?.info || log?.log)?.call(log, `[${prefix}] codex_account=${account} worker_class=${workerClass} reason=${routing?.reason || 'explicit-worker-class-pin'}`);
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
  const existing = readCorporateCodexQuotaCooldown(rootDir, { env, nowMs });
  const end = Math.max(existing ? Date.parse(existing.resetAt) : 0,
    Number.isFinite(resetMs) && resetMs > nowMs ? resetMs : nowMs + 15 * 60 * 1000);
  const state = { resetAt: new Date(Math.min(end, nowMs + 7 * 24 * 60 * 60 * 1000)).toISOString() };
  writeFileAtomic(join(resolveAdversarialReviewStateDir(rootDir, env), 'codex-corporate-quota-cooldown.json'), JSON.stringify(state));
  return state;
}
