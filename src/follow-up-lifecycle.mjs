import { staleDriftStopDecision } from './stale-drift.mjs';

async function resolveJobPRLifecycleSafe({
  rootDir,
  job,
  resolvePRLifecycleImpl,
  execFileImpl,
  log = console,
}) {
  try {
    return await resolvePRLifecycleImpl(rootDir, {
      repo: job.repo,
      prNumber: job.prNumber,
      execFileImpl,
    });
  } catch (err) {
    log.error?.(
      `[follow-up-remediation] PR lifecycle resolve threw for ${job.repo}#${job.prNumber} (non-fatal): ${err.message}`
    );
    return null;
  }
}

// Map a lifecycle observation to a stop decision (or null when the gate
// should let the flow through). Centralized so the consume + reconcile
// sites can't drift out of sync on which states stop and what stop code
// they emit. Precedence is deliberate: merged/closed PR lifecycle beats
// stale-drift for stop-code reporting, but stale-drift still suppresses
// automation on otherwise-open PRs.
function lifecycleStopDecision(lifecycle, { repo, prNumber, site, job = null }) {
  if (!lifecycle) return null;
  const staleDriftStop = staleDriftStopDecision(lifecycle, { prNumber, site });
  if (lifecycle.prState !== 'merged' && lifecycle.prState !== 'closed') {
    const jobRevisionRef = typeof job?.revisionRef === 'string' ? job.revisionRef.trim() : '';
    const currentHeadSha = typeof lifecycle.headSha === 'string' ? lifecycle.headSha.trim() : '';
    if (site === 'consume' && jobRevisionRef && currentHeadSha && jobRevisionRef !== currentHeadSha) {
      const sourceTag = lifecycle.source ? ` source=${lifecycle.source}` : '';
      return {
        stopCode: 'stale-review-head',
        actionReason: 'stale-review-head',
        workerState: site === 'consume' ? 'never-spawned' : 'completed-stale-review-head',
        stopReason: `Review follow-up for ${repo}#${prNumber} was created for head ${jobRevisionRef}` +
          ` but the current PR head is ${currentHeadSha}${sourceTag}; stopping instead of racing a stale remediation job.`,
      };
    }
    return staleDriftStop;
  }

  const sourceTag = lifecycle.source ? ` source=${lifecycle.source}` : '';
  const tail = site === 'consume'
    ? 'stopping the bounded loop instead of spawning a worker on a closed branch.'
    : 'stopping the bounded loop instead of advancing the queue or posting a comment on a closed PR.';

  if (lifecycle.prState === 'merged') {
    const mergedTail = site === 'consume'
      ? 'stopping the bounded loop instead of spawning a worker on a closed branch.'
      : 'stopping the bounded loop instead of advancing the queue or posting a comment on a merged PR.';
    const verb = site === 'consume' ? 'was merged before remediation could run' : 'was merged while the remediation worker was running';
    return {
      stopCode: 'operator-merged-pr',
      actionReason: 'pr-merged',
      workerState: site === 'consume' ? 'never-spawned' : 'completed-pr-already-merged',
      stopReason: `PR ${repo}#${prNumber} ${verb}` +
        `${lifecycle.mergedAt ? ` (mergedAt=${lifecycle.mergedAt})` : ''}${sourceTag}; ${mergedTail}`,
    };
  }

  const verb = site === 'consume' ? 'was closed before remediation could run' : 'was closed while the remediation worker was running';
  return {
    stopCode: 'operator-closed-pr',
    actionReason: 'pr-closed',
    workerState: site === 'consume' ? 'never-spawned' : 'completed-pr-already-closed',
    stopReason: `PR ${repo}#${prNumber} ${verb}` +
      `${lifecycle.closedAt ? ` (closedAt=${lifecycle.closedAt})` : ''}${sourceTag}; ${tail}`,
  };
}

export {
  lifecycleStopDecision,
  resolveJobPRLifecycleSafe,
};
