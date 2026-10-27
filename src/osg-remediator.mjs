// OSG-14 execution seam. Assignments/budgets belong to the ledger owner;
// account proposals belong to ITP; merge authority remains with the caller.
import { loadAppSdkSync } from './app-sdk-loader.mjs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { loadRoleConfig } from './role-config.mjs';
import { selectWorkerTokenAccount } from './worker-token-pool.mjs';
import { isHammerWorkerClass } from './ama/hammer-worker-class.mjs';
import { isCrossModelReviewWaived, normalizeBuilderClass } from './adapters/subject/github-pr/routing.mjs';
import { writeFileAtomic } from './atomic-write.mjs';
import { resolveAdversarialReviewStateDir } from './reviewer-fence.mjs';

export function remediatorProposalOwner(value, { env = process.env } = {}) {
  return loadAppSdkSync().readRemediatorProposal(value, {env, hq_bin:env.HQ_BIN || 'hq', timeout_ms:1500})
    .catch(()=>{throw new Error('osg-owner-unavailable');});
}

function recordRoute(rootDir, env, value) {
  const directory = join(resolveAdversarialReviewStateDir(rootDir, env), 'osg-remediator');
  mkdirSync(directory, { recursive: true });
  writeFileAtomic(join(directory, `${randomUUID()}.json`), JSON.stringify(value));
}

export async function resolveOsgRemediatorRoute({ current, kind, repo, prNumber,
  rootDir, reviewerModels = [], env = process.env, mode,
  ownerImpl = remediatorProposalOwner, selectAccountImpl = selectWorkerTokenAccount,
  recordImpl = value => recordRoute(rootDir, env, value), log = console } = {}) {
  let reason = 'error-remediator-route';
  let assignment;
  try {
    mode ??= loadRoleConfig({ env, contextKey: 'osg.mode' }).get('osg.mode', 'off');
    if (mode === 'off') return current;
    const proposal = await ownerImpl({ kind, repo, prNumber }, { env });
    // Only public, bounded values are emitted. Never log transport exceptions.
    reason = /^[a-z][a-z0-9-]{0,95}$/.test(proposal?.reason) ? proposal.reason : 'error-remediator-route';
    assignment = proposal?.assignment;
    let selected = null;
    if (reason === 'assigned' && assignment?.experiment === 'remediator' && assignment.mode === 'apply'
      && mode === 'apply' && proposal.arm?.role === 'remediator') {
      const workerClass = proposal.worker_class;
      const validRole = kind === 'hammer' ? isHammerWorkerClass(workerClass)
        : ['remediator-codex', 'remediator-claude'].includes(workerClass);
      if (!validRole || (kind === 'remediator' && normalizeBuilderClass(workerClass) !== normalizeBuilderClass(current.workerClass)
        && reviewerModels.some(model => isCrossModelReviewWaived(workerClass, model)))) {
        reason = 'arm-role-unavailable';
      } else {
        const account = await selectAccountImpl({ identity: workerClass, model: proposal.arm.model, env });
        if (!account?.pooled || account.hold || account.status !== 'selected'
          || account.identity !== workerClass || account.tokenAccountId !== proposal.arm.account) {
          reason = 'arm-account-unavailable';
        } else {
          selected = { workerClass, modelResolution: { resolvedModel: proposal.arm.model,
            resolvedReasoningLevel: proposal.effort ?? proposal.arm.effort ?? null, source: 'osg-remediator' }, arm: proposal.arm,
          account, accountProposal: { identity: account.identity, tokenAccountId: account.tokenAccountId,
            evidenceGeneration: account.evidenceGeneration } };
        }
      }
    } else if (reason === 'assigned') reason = mode === 'shadow' ? 'shadow' : 'assignment-inactive';
    const osg = { version: 1, repo, prNumber, kind, reason,
      ...(assignment ? { assignment } : {}),
      ...(selected ? { arm: selected.arm, accountProposal: selected.accountProposal } : {}),
      defaultWorkerClass: current.workerClass, recordedAt: new Date().toISOString() };
    // An unrecorded arm is never applied. The ordinary dispatch still runs.
    recordImpl(osg);
    return { ...current, ...(selected ? { ...selected.account, workerClass: selected.workerClass,
      fellBack: false, reason: 'osg-assigned', modelResolution: selected.modelResolution } : {}), osg };
  } catch {
    try { recordImpl({ version: 1, repo, prNumber, kind, reason: 'error-remediator-route',
      ...(assignment ? { assignment } : {}), recordedAt: new Date().toISOString() }); } catch { /* default */ }
    try { log.warn?.('[osg-remediator] default route: error-remediator-route'); } catch { /* default */ }
    return current;
  }
}
