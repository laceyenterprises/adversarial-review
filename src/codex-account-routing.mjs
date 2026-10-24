import { boundedDiagnostics } from './producer-contracts/diagnostics.mjs';
import { readBrokerProvider } from './producer-contracts/broker-evidence.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './atomic-write.mjs';
import { resolveAdversarialReviewStateDir } from './reviewer-fence.mjs';
import { harnessCapFromStatuses, quotaStatusesFromSnapshot, weeklyOnlyReserveFloorMeasurement, quotaAccountDiagnostics } from './fleet-quota-status.mjs';
import { ENUM_CODEX_WORKER_ACCOUNT_ORDER } from './config-loader.mjs';

// Accounts share a model family, but never quota or broker evidence. Keep the
// reviewer order separate from explicit compatibility worker overrides.
const REVIEWER_ORDER = [['codex-corp', 'oauth-corp'], ['codex', 'oauth']];
const WORKER_ORDER = [['codex', 'oauth'], ['codex-corp', 'oauth-corp']];

export function selectCodexReviewerAccount(payload, options = {}) {
  return selectCodexAccount(payload, REVIEWER_ORDER, options);
}

export function selectCodexWorkerAccount(payload, options = {}) {
  const order = options.policy === 'personal-first' ? WORKER_ORDER : REVIEWER_ORDER;
  return selectCodexAccount(payload, order, options);
}

export function isAutomaticCodexAccountPolicy(policy) {
  return ENUM_CODEX_WORKER_ACCOUNT_ORDER.includes(policy);
}

function selectCodexAccount(payload, order, { model = null,
  statuses = quotaStatusesFromSnapshot(payload), corporateExhausted = false, personalExhausted = false,
} = {}) {
  const rows = Array.isArray(payload?.providerStatuses) ? payload.providerStatuses : [];
  const diagnostics = [];
  for (const [provider, authPath] of order) {
    const cap = harnessCapFromStatuses(statuses, { harness: provider, model, authPath });
    const row = rows.find(entry => entry?.provider === 'openai'
      && (entry.authPath || entry.auth_path) === authPath);
    const weekly = weeklyOnlyReserveFloorMeasurement(payload?.reserveFloors?.[`openai-${authPath}`]);
    const measured = weekly?.status === 'measured' && Number.isFinite(weekly.percentRemaining)
      && weekly.percentRemaining >= 0 && weekly.percentRemaining <= 100;
    const broker = readBrokerProvider(payload?.brokerAuth, provider);
    const ready = { ready: broker.ready, can_serve: broker.canServe };
    diagnostics.push(...quotaAccountDiagnostics(payload, { provider: 'openai', authPath, cap }), ...broker.diagnostics);
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
      return { hold: true, reason: 'codex-account-evidence-unknown', diagnostics: boundedDiagnostics(diagnostics) };
    }
  }
  return { hold: true, reason: 'no-ready-codex-account', diagnostics: boundedDiagnostics(diagnostics) };
}

// Only unpinned Codex lanes opt into account substitution. Corporate classes
// already name an account and retain their existing dispatch/cap behavior.
export function codexWorkerLaneFromSnapshot(payload, { workerClass, policy = 'corporate-first', ...options } = {}) {
  if (!isAutomaticCodexAccountPolicy(policy) || !['hammer', 'codex', 'remediator-codex'].includes(workerClass)) return null;
  const account = selectCodexWorkerAccount(payload, { ...options, policy });
  if (account.hold) return { ...account, workerClass };
  const preferred = policy === 'corporate-first' ? 'corporate' : 'personal';
  const selected = account.provider === 'codex' ? 'personal' : 'corporate';
  return { ...account,
    workerClass: account.provider === 'codex' ? workerClass
      : workerClass === 'hammer' ? 'hammer-corp' : 'remediator-codex-corp',
    reason: selected === preferred ? `${selected}-ready` : `${preferred}-unavailable-${selected}-ready`,
  };
}

export function logCodexWorkerDispatch(log, workerClass, routing = {}, prefix = 'review-worker') {
  if (!['hammer', 'hammer-corp', 'codex', 'remediator-codex', 'remediator-codex-corp'].includes(workerClass)) return;
  const account = routing.pooled ? (routing.brokerProvider === 'codex-corp' ? 'corporate' : 'personal')
    : workerClass.endsWith('-corp') ? 'corporate' : 'personal';
  (log?.info || log?.log)?.call(log, `[${prefix}] codex_account=${account} worker_class=${workerClass} reason=${routing?.reason || 'explicit-worker-class-pin'}`);
}

export function codexReviewerAccountForGrounding(grounding, options = {}) {
  if (grounding?.codexAccountSelection?.pooled && !grounding.staleIfError) return grounding.codexAccountSelection;
  if (grounding?.staleIfError || !grounding?.codexAccountSnapshot) {
    return { hold: true, reason: 'codex-account-evidence-unknown', diagnostics: ['cwp_dispatch.cli_fleet: $stdout missing or stale after refresh error'] };
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
