import { enrichCiInfrastructureEvidence, rollupInfrastructureOnly, rollupFailures } from '../ci-infrastructure.mjs';
import { appendAmaAuditAttempt } from './audit.mjs';

// Closing tooling owns this refusal before the model can turn an account
// outage into an operator choice. This helper has no decision or merge seam.
export async function recordHammerCiStop({ pr, repo, prNumber, env = process.env,
  execFileImpl, appendImpl = appendAmaAuditAttempt } = {}) {
  const headSha = pr?.headRefOid;
  if (pr?.state !== 'OPEN' || !/^[a-f0-9]{40}$/i.test(headSha || '')) return null;
  const rollup = await enrichCiInfrastructureEvidence({ rollup: pr.statusCheckRollup,
    repo, headSha, execFileImpl, env });
  if (!rollupInfrastructureOnly(rollup)) return null;
  const failedChecks = rollupFailures(rollup);
  const stop = { outcome: 'failed-without-merge', reason: 'ci-infrastructure',
    attemptPhase: 'hammer-ci-infrastructure', head: headSha,
    launchRequestId: env.HQ_LAUNCH_REQUEST_ID || env.AGENT_OS_WORKER_LRQ_ID || null,
    failedChecks, next: 'Wait for exact-head required checks to execute again; automatic closure owns recovery.' };
  appendImpl({ hqRoot: env.HAM_HQ_ROOT || env.HQ_ROOT, repo, prNumber, headSha,
    attempt: stop, metadata: { closureAuthority: 'ham-terminal-remediation' } });
  return stop;
}
