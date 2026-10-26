// Worker dispatch proposals only. cwp_dispatch revalidates and acquires the
// execution lease at admission; a proposal is neither a pin nor merge authority.
import { isDeepStrictEqual } from 'node:util';
import { resolveIdentityTokenPools } from './role-config.mjs';
import { readAccountSelection, readIdentityTokenPools } from './identity-token-snapshot.mjs';
import { reviewerPoolOwner } from './reviewer-token-pool.mjs';
import { resolveHqRoot } from './hq-root.mjs';
import { isCrossModelReviewWaived } from './adapters/subject/github-pr/routing.mjs';

const REMEDIATORS = Object.freeze({ codex: 'remediator-codex', 'claude-code': 'remediator-claude',
  claude: 'remediator-claude', 'remediator-codex-corp': 'remediator-codex',
  'remediator-claude-corp': 'remediator-claude' });
const HAMMERS = Object.freeze({ 'hammer-corp': 'hammer', 'hammer-claude-corp': 'hammer-claude' });
const FAMILIES = Object.freeze({ hammer: 'codex', 'hammer-claude': 'claude',
  'remediator-codex': 'codex', 'remediator-claude': 'claude' });

export async function selectWorkerTokenAccount({ identity, model, env = process.env,
  oauth = null, resolvePoolsImpl = resolveIdentityTokenPools, ownerImpl = reviewerPoolOwner,
  legacyAccountPinned = false,
  blockedAccountIds = [], unknownCooldownAccountIds = [] } = {}) {
  const base = { identity, workerClass: identity, pooled: true };
  const fromConfig = oauth === null;
  try {
    oauth ??= resolvePoolsImpl({ env });
    oauth = readIdentityTokenPools(oauth);
    if (!Object.hasOwn(oauth.identity_token_pools, identity)) return null;
    if (legacyAccountPinned) return { ...base, hold: true, status: 'held', reason: 'legacy-account-pin-requires-migration' };
    const family = Object.hasOwn(FAMILIES, identity) ? FAMILIES[identity] : null;
    if (!family || !model) throw new Error('invalid worker pool request');
    const wire = await ownerImpl({ operation: 'propose', oauth, identity, family, model,
      taskKind: identity.startsWith('hammer') ? 'merge' : 'coding',
      requestId: 'worker-proposal', hqRoot: resolveHqRoot(env), blockedAccountIds, unknownCooldownAccountIds }, { env });
    if (wire.held) return { ...base, hold: true, status: 'held',
      reason: wire.held === 'capacity-saturated' ? wire.held : 'evidence-unknown' };
    if (wire.request.identity !== identity || wire.request.family !== family
      || wire.request.requested_models.length !== 1 || wire.request.requested_models[0] !== model) {
      throw new Error('worker pool request mismatch');
    }
    const selection = readAccountSelection(wire.selection, { oauth, request: wire.request });
    if (fromConfig && !isDeepStrictEqual(oauth, resolvePoolsImpl({ env }))) {
      return { ...base, hold: true, status: 'held', reason: 'evidence-generation-mismatch' };
    }
    if (selection.status !== 'selected') return { ...base, hold: true,
      status: selection.status, reason: selection.reason, selection };
    return { ...base, hold: false, status: 'selected', reason: selection.reason,
      tokenAccountId: selection.account_id,
      brokerProvider: oauth.token_accounts[selection.account_id].broker_provider,
      evidenceGeneration: selection.generation, selection };
  } catch {
    // Report evidence failures explicitly; callers own hold/compatibility
    // policy. No credential reads or diagnostics are emitted here.
    return { ...base, hold: true, status: 'held', reason: 'evidence-unknown' };
  }
}

export async function resolvePooledWorkerRouting({ primary, fallbackWorkerClasses = [],
  kind, env, modelForClass, reviewerModels = [], selectAccountImpl = selectWorkerTokenAccount,
  preferCrossFamily = false, infrastructureReason = null,
  ...options }) {
  const aliases = kind === 'hammer' ? HAMMERS : REMEDIATORS;
  const canonical = name => Object.hasOwn(aliases, name) ? aliases[name] : name;
  // Explicit legacy corporate requests retain their first-attempt affinity in
  // the compatibility dispatcher. Automatic choices never emit those aliases.
  if (Object.hasOwn(aliases, primary) && primary.endsWith('-corp')) return null;
  const identity = canonical(primary);
  if (!Object.hasOwn(FAMILIES, identity)
    || (kind === 'hammer' ? !identity.startsWith('hammer') : !identity.startsWith('remediator-'))) return null;
  const select = async role => {
    let account;
    try { account = await selectAccountImpl({ identity: role, model: modelForClass?.(role), env, ...options }); }
    catch { account = { identity: role, workerClass: role, pooled: true,
      hold: true, status: 'held', reason: 'evidence-unknown' }; }
    return account;
  };
  const account = await select(identity);
  if (!account) return null; // Undeclared installations retain compatibility.
  // Remediator proposals are optional preflight evidence. Only a selected
  // account or a positive all-accounts refusal replaces legacy class routing.
  // A pool for `codex` does not enroll `remediator-codex`; unknown/failed
  // proposals cannot ground that role. Dispatch still owns account admission.
  if (kind === 'remediator' && account.status !== 'selected'
    && !(account.status === 'unavailable' && account.reason === 'accounts-unavailable')) return null;
  const base = { ...account, workerClass: identity, fellBack: false,
    ...(kind === 'remediator' && account.status === 'unavailable' ? { capSource: account.reason } : {}) };
  if (account.status !== 'unavailable' && (!preferCrossFamily || account.hold)) return base;
  const skipped = [];
  for (const candidate of [...new Set(fallbackWorkerClasses.map(canonical))]) {
    if (!Object.hasOwn(FAMILIES, candidate) || FAMILIES[candidate] === FAMILIES[identity]
      || (kind === 'hammer' ? !candidate.startsWith('hammer') : !candidate.startsWith('remediator-'))) continue;
    if (kind === 'remediator' && reviewerModels.some(model => isCrossModelReviewWaived(candidate, model))) {
      skipped.push({ workerClass: candidate, reason: 'reviews-next-round' });
      continue;
    }
    const fallback = await select(candidate);
    if (kind === 'remediator' && (!fallback || fallback.status !== 'selected')) {
      skipped.push({ workerClass: candidate, reason: fallback?.reason || fallback?.status || 'pool-undeclared' });
      continue;
    }
    if (!fallback || fallback.status === 'unavailable') continue;
    if (fallback.hold) return { ...base, hold: true, status: 'held', reason: fallback.reason, skipped };
    return { ...fallback, workerClass: candidate, fellBack: true, from: identity, to: candidate,
      provider: FAMILIES[identity] === 'codex' ? 'openai' : 'anthropic',
      fallbackProvider: FAMILIES[candidate] === 'codex' ? 'openai' : 'anthropic',
      primaryState: account.status, capSource: preferCrossFamily ? infrastructureReason : account.reason,
      reason: preferCrossFamily ? 'infrastructure-fallback' : 'primary-grounded-fallback', skipped };
  }
  if (preferCrossFamily && !account.hold) return { ...base, reason: 'infrastructure-fallback-unavailable', skipped };
  return { ...base, hold: true, reason: 'no-available-fallback', skipped };
}
