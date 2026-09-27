import { staleDriftStopDecision } from './stale-drift.mjs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getReviewRow, openReviewStateDb } from './review-state.mjs';

async function resolveJobPRLifecycleSafe({
  rootDir,
  job,
  resolvePRLifecycleImpl,
  execFileImpl,
  log = console,
}) {
  try {
    const lifecycle = await resolvePRLifecycleImpl(rootDir, {
      repo: job.repo,
      prNumber: job.prNumber,
      execFileImpl,
    });
    try {
      if (!existsSync(join(rootDir, 'data', 'reviews.db'))) return lifecycle;
      const db = openReviewStateDb(rootDir);
      let row;
      try {
        row = getReviewRow(db, { repo: job.repo, prNumber: job.prNumber });
      } finally {
        db.close();
      }
      const pendingHead = String(row?.revision_ref || row?.reviewer_head_sha || '').trim();
      const newerReviewPending = Boolean(
        ['pending', 'reviewing', 'pending-upstream'].includes(row?.review_status)
        && pendingHead && pendingHead !== job.revisionRef && pendingHead === lifecycle?.headSha
      );
      return lifecycle ? { ...lifecycle, newerReviewPending } : { prState: null, newerReviewPending };
    } catch (err) {
      log.warn?.(`[follow-up-remediation] review state lookup failed for ${job.repo}#${job.prNumber} (non-fatal): ${err.message}`);
      return lifecycle;
    }
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
    // stale-review-head is evaluated first: it is the retriggerable stop for a moved head, and a
    // newer pending review on that head is detail, not a different (terminal) outcome.
    if (site !== 'reconcile' && jobRevisionRef && currentHeadSha && jobRevisionRef !== currentHeadSha) {
      const sourceTag = lifecycle.source ? ` source=${lifecycle.source}` : '';
      const pendingTag = lifecycle.newerReviewPending ? ' (a review of the new head is pending)' : '';
      return {
        stopCode: 'stale-review-head',
        actionReason: 'stale-review-head',
        workerState: site === 'consume' ? 'never-spawned' : 'completed-stale-review-head',
        stopReason: `Review follow-up for ${repo}#${prNumber} was created for head ${jobRevisionRef}` +
          ` but the current PR head is ${currentHeadSha}${sourceTag}${pendingTag}; stopping instead of racing a stale remediation job.`,
      };
    }
    // Only a job without a revisionRef needs the pending-review signal: the stale-head check
    // above cannot see that it was superseded.
    if (site === 'consume' && !jobRevisionRef && lifecycle.newerReviewPending) {
      return {
        stopCode: 'newer-review-pending',
        actionReason: 'newer-review-pending',
        workerState: 'never-spawned',
        stopReason: `A newer review is pending for ${repo}#${prNumber}; cancelling remediation for the prior verdict.`,
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

// True only when git proves the commit is absent (`rev-parse --verify --quiet` exits 1).
// A broken or unreadable workspace (exit 128, spawn errors) is not proof of anything.
async function workspaceLacksCommit(execFileImpl, workspaceDir, sha) {
  if (!sha) return false;
  try {
    await execFileImpl('git', ['-C', workspaceDir, 'rev-parse', '--verify', '--quiet', `${sha}^{commit}`]);
    return false;
  } catch (err) {
    return err?.code === 1;
  }
}

async function activeRemediationStopDecision({
  lifecycle, liveness, job, rootDir, execFileImpl,
  buildReconciliationPathsImpl, parseHqWorkerWorkspaceFromPayloadImpl,
}) {
  let stop = lifecycleStopDecision(lifecycle, {
    repo: job.repo,
    prNumber: job.prNumber,
    site: liveness.state === 'active' ? 'reconcile-active' : 'reconcile',
    job,
  });
  // A worker's own push moves the reviewed head, and it may already have
  // committed more work locally. Stop only when a known workspace proves the
  // current PR head is not in that worker's history.
  if (liveness.state === 'active' && stop?.stopCode === 'stale-review-head') {
    try {
      const workspaceDir = job?.remediationWorker?.dispatchMode === 'hq'
        ? parseHqWorkerWorkspaceFromPayloadImpl(liveness?.dispatchStatus || {})
        : buildReconciliationPathsImpl(rootDir, job).workspaceDir;
      if (!workspaceDir || !existsSync(join(workspaceDir, '.git'))) {
        stop = null;
      } else if (await workspaceLacksCommit(execFileImpl, workspaceDir, lifecycle.headSha)) {
        // The worker's own push always exists in its workspace. A head the workspace has never
        // seen came from someone else, so the stop stands.
      } else {
        try {
          await execFileImpl('git', ['-C', workspaceDir, 'merge-base', '--is-ancestor', lifecycle.headSha, 'HEAD']);
          stop = null;
        } catch (err) {
          // Exit 1 proves non-ancestry; command errors leave ownership unknown.
          if (err?.code !== 1) stop = null;
        }
      }
    } catch {
      // An unreadable workspace cannot prove external supersession.
      stop = null;
    }
  }
  const currentRound = Number(job?.remediationPlan?.currentRound || 0);
  const maxRounds = Number(job?.remediationPlan?.maxRounds || 0);
  if (!stop && (job?.remediationPlan?.stop?.code === 'max-rounds-reached'
    || (maxRounds > 0 && currentRound > maxRounds))) {
    stop = {
      stopCode: 'max-rounds-reached',
      actionReason: 'max-rounds-reached',
      workerState: 'cancelled-max-rounds',
      stopReason: `Remediation round ${currentRound} exceeds the current cap of ${maxRounds}; cancelling the active worker.`,
    };
  }
  return stop;
}

export {
  activeRemediationStopDecision,
  lifecycleStopDecision,
  resolveJobPRLifecycleSafe,
};
