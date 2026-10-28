import { loadAwareTimeoutMs } from './load-aware-timeout.mjs';
// Transport/binding only. Account policy and the global semaphore stay with
// agent_os_core and the broker; ITP-10 validates the owner's wire contract.
import { spawn } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolveIdentityTokenPools } from './role-config.mjs';
import { readAccountSelection } from './identity-token-snapshot.mjs';
import { resolveHqRoot } from './hq-root.mjs';
import { ensureWorkerRegistryReady, resolveRemediationModel } from './adapters/agent-runtime/local/remediation.mjs';
import { normalizeReviewerModel } from './adapters/subject/github-pr/routing.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { resolveAdversarialReviewStateDir } from './reviewer-fence.mjs';
import { writeFileAtomic } from './atomic-write.mjs';
import { journalReviewerTokenLease, forgetReviewerTokenLease, markReviewerTokenLeaseActive } from './reviewer-token-leases.mjs';

function cooldownPath(rootDir, accountId, env) {
  return join(resolveAdversarialReviewStateDir(rootDir, env), 'reviewer-account-cooldowns',
    `${createHash('sha256').update(accountId).digest('hex')}.json`);
}

export function readReviewerAccountCooldown(rootDir, accountId, { env = process.env, nowMs = Date.now() } = {}) {
  try {
    const state = JSON.parse(readFileSync(cooldownPath(rootDir, accountId, env), 'utf8'));
    if (!state || Object.keys(state).length !== 1 || typeof state.resetAt !== 'string'
      || !Number.isFinite(Date.parse(state.resetAt))) return { unknown: true };
    return Date.parse(state.resetAt) > nowMs ? state : null;
  } catch (error) { return error.code === 'ENOENT' ? null : { unknown: true }; }
}

export function recordReviewerAccountQuotaFailure(rootDir, receipt, { resetAt, env = process.env, nowMs = Date.now() } = {}) {
  const previous = readReviewerAccountCooldown(rootDir, receipt.tokenAccountId, { env, nowMs });
  const reset = Date.parse(resetAt);
  const end = Math.max(Date.parse(previous?.resetAt) || 0,
    Number.isFinite(reset) && reset > nowMs ? reset : nowMs + 15 * 60 * 1000);
  const state = { resetAt: new Date(Math.min(end, nowMs + 7 * 24 * 60 * 60 * 1000)).toISOString() };
  writeFileAtomic(cooldownPath(rootDir, receipt.tokenAccountId, env), JSON.stringify(state));
  return state;
}

export function reviewerPoolOwner(value, { env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(env.HQ_PYTHON3 || env.AGENT_OS_PY || 'python3', ['-B',
      fileURLToPath(new URL('./adapters/reviewer-runtime/token-pool-owner.py', import.meta.url))],
    { env, stdio: ['pipe', 'pipe', 'ignore'] });
    let stdout = '';
    const timeout = setTimeout(() => child.kill('SIGKILL'), loadAwareTimeoutMs(15_000));
    child.stdout.on('data', data => {
      stdout += data;
      if (stdout.length > 1024 * 1024) child.kill('SIGKILL');
    });
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.stdin.on('error', () => {});
    child.on('close', code => {
      clearTimeout(timeout);
      try {
        if (code !== 0) throw new Error('reviewer pool owner unavailable');
        resolve(JSON.parse(stdout));
      } catch { reject(new Error('reviewer pool owner unavailable')); }
    });
    child.stdin.end(JSON.stringify(value));
  });
}

export async function selectReviewerTokenAccount({ reviewerModel, requestId = 'reviewer-proposal',
  acquire = false, env = process.env, oauth = null,
  model = null,
  rootDir = fileURLToPath(new URL('..', import.meta.url)),
  resolvePoolsImpl = resolveIdentityTokenPools,
  ownerImpl = reviewerPoolOwner, log = console } = {}) {
  const family = normalizeReviewerModel(reviewerModel);
  if (!['claude', 'codex'].includes(family)) return null;
  const identity = `${family}-reviewer`;
  const fromConfig = oauth === null;
  const declarationPath = join(rootDir, 'data', 'reviewer-pool-declarations.json');
  if (fromConfig) {
    try {
      oauth = resolvePoolsImpl({ env });
      const identities = Object.keys(oauth.identity_token_pools).filter(id => ['claude-reviewer', 'codex-reviewer'].includes(id));
      const value = JSON.stringify({ identities });
      let previous;
      try { previous = readFileSync(declarationPath, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (previous !== value) writeFileAtomic(declarationPath, value);
    } catch {
      // An unrelated declaration error must not enroll legacy roles. Once a
      // role has enrolled, retain its fail-closed boundary across restarts.
      let declared = Boolean(oauth?.identity_token_pools && Object.hasOwn(oauth.identity_token_pools, identity));
      try { declared ||= JSON.parse(readFileSync(declarationPath, 'utf8')).identities.includes(identity); }
      catch (error) { declared ||= error.code !== 'ENOENT'; }
      log.warn(`[watcher] reviewer pool configuration unreadable identity=${identity} routing=${declared ? 'hold' : 'legacy'}`);
      return declared ? { hold: true, reason: 'pool-configuration-unreadable', identity, pooled: true } : null;
    }
  }
  let acquiredLease = null;
  let admitted = false;
  let journaled = false;
  try {
    if (!Object.hasOwn(oauth.identity_token_pools, identity)) return null;
    if (model === null) await ensureWorkerRegistryReady({env});
    model ??= resolveRemediationModel(identity, { env,
      ...(family === 'codex' ? { pin: env.CODEX_MODEL_ID || null } : {}), fallbackModel: null }).resolvedModel;
    if (acquire) {
      journalReviewerTokenLease(rootDir, requestId, identity);
      journaled = true;
      markReviewerTokenLeaseActive(rootDir, requestId, true);
    }
    const wire = await ownerImpl({ operation: acquire ? 'acquire' : 'propose', oauth,
      identity, family, model, requestId, hqRoot: resolveHqRoot(env),
      blockedAccountIds: oauth.identity_token_pools[identity].filter(id => {
        const cooldown = readReviewerAccountCooldown(rootDir, id, { env });
        return cooldown && !cooldown.unknown;
      }),
      unknownCooldownAccountIds: oauth.identity_token_pools[identity].filter(id => readReviewerAccountCooldown(rootDir, id, { env })?.unknown),
    }, { env });
    acquiredLease = acquire ? wire.lease : null;
    if (acquiredLease) journalReviewerTokenLease(rootDir, requestId, identity, acquiredLease);
    if (wire.held) return { hold: true, reason: wire.held, identity, pooled: true };
    // Never validate against an owner-supplied substitute declaration/request.
    const request = wire.request;
    if (request.identity !== identity || request.family !== family
      || request.requested_models.length !== 1 || request.requested_models[0] !== model) {
      throw new Error('reviewer pool request mismatch');
    }
    const selection = readAccountSelection(wire.selection, { oauth, request });
    if (selection.status !== 'selected') return { hold: true, status: selection.status, reason: selection.reason, identity, pooled: true };
    const account = oauth.token_accounts[selection.account_id];
    const lease = wire.lease;
    const leaseFields = ['version', 'lease_id', 'account_id', 'identity', 'request_id', 'generation',
      'expires_at', 'broker_provider', 'holder_user', 'kind'];
    if (acquire && (!lease || Object.keys(lease).some(key => !leaseFields.includes(key))
      || lease.version !== 1 || lease.kind !== 'managed' || lease.holder_user !== null
      || lease.identity !== identity || lease.account_id !== selection.account_id
      || lease.request_id !== requestId || lease.broker_provider !== account.broker_provider
      || !Number.isFinite(lease.expires_at) || lease.expires_at <= request.now
      || !Number.isInteger(lease.generation) || lease.generation <= 0
      || typeof lease.lease_id !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/.test(lease.lease_id))) {
      throw new Error('reviewer pool lease mismatch');
    }
    if (fromConfig && !isDeepStrictEqual(oauth, resolvePoolsImpl({ env }))) {
      return { hold: true, reason: 'evidence-generation-mismatch', identity, pooled: true };
    }
    admitted = true;
    return Object.freeze({ hold: false, pooled: true, identity, provider: account.broker_provider,
      brokerProvider: account.broker_provider,
      reason: selection.reason, tokenAccountId: selection.account_id,
      evidenceGeneration: selection.generation, selection, lease: lease ? Object.freeze({ ...lease }) : null });
  } catch (error) {
    if (error.code === 'registry-unavailable') throw error;
    return { hold: true, reason: 'evidence-unknown', identity, pooled: true };
  } finally {
    if (journaled) markReviewerTokenLeaseActive(rootDir, requestId, false);
    if (!admitted && acquiredLease) {
      try {
        await updateReviewerTokenLease({ lease: acquiredLease }, 'release', { env, ownerImpl });
        forgetReviewerTokenLease(rootDir, requestId);
      } catch {
        try { journalReviewerTokenLease(rootDir, requestId, identity, null); } catch {}
        log.warn(`[watcher] reviewer account lease release unavailable session=${requestId}; journal retained`);
      }
    }
    // Unknown transport outcomes keep the pre-acquire intent for diagnostics
    // recovery, even when no receipt ever made it across stdio.
  }
}

export function reviewerBrokerProviders(context = {}) {
  const receipt = context.reviewerAccountReceipt;
  const family = normalizeReviewerModel(context.reviewerModel);
  if (receipt && (!['claude', 'codex'].includes(family) || receipt.identity !== `${family}-reviewer`
    || receipt.hold || !receipt.lease || receipt.lease.account_id !== receipt.tokenAccountId
    || receipt.lease.broker_provider !== receipt.brokerProvider
    || !(family === 'codex' ? ['codex', 'codex-corp'] : ['claude-code', 'claude-code-corp']).includes(receipt.brokerProvider))) {
    throw new Error('reviewer account binding mismatch');
  }
  return {
    codexBrokerProvider: family === 'codex' && receipt ? receipt.brokerProvider : context.codexBrokerProvider || 'codex',
    claudeBrokerProvider: family === 'claude' && receipt ? receipt.brokerProvider : context.claudeBrokerProvider || 'claude-code',
  };
}

// Renewal never reselects: use exactly the original account/lease/generation.
export async function updateReviewerTokenLease(receipt, operation, options = {}) {
  if (!receipt?.lease) return null;
  if (!['renew', 'release'].includes(operation)) throw new Error('invalid reviewer lease operation');
  const { rootDir } = options;
  const sessionUuid = receipt.lease.request_id;
  if (operation === 'release' && rootDir && sessionUuid) {
    journalReviewerTokenLease(rootDir, sessionUuid, receipt.identity || receipt.lease.identity, receipt.lease);
  }
  const result = await (options.ownerImpl || reviewerPoolOwner)({ operation, lease: receipt.lease }, options);
  if (result?.ok !== true || result.operation !== operation) throw new Error('reviewer lease operation failed');
  if (operation === 'release' && rootDir && sessionUuid) forgetReviewerTokenLease(rootDir, sessionUuid);
  return result;
}
