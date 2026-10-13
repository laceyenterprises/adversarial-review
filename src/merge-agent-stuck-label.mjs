import { meteredExecFile } from './metered-gh.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hasCommentOnlyFinalRoundPush, scanPrFollowUpJobs } from './comment-only-final-round.mjs';
import { normalizeLabelNames } from './merge-agent-candidate.mjs';
import { MERGE_AGENT_STUCK_LABEL } from './adapters/operator/github-pr-label-controls/index.mjs';

const execFileAsync = promisify(execFile);

// Best-effort terminal hand-off: mark an unowned PR `merge-agent-stuck` so it
// surfaces for the operator. A final-round or active remediation owner wins. Used
// when the watcher's bounded re-dispatch budget is exhausted. Never throws into
// the watcher loop — a failed label add just leaves the PR in its prior state.
export async function applyMergeAgentStuckLabel({
  rootDir, headSha,
  tryAdapterPullRequestLabelImpl,
  repo,
  prNumber,
  labels = [],
  ghExecFileImpl = execFileAsync,
  logger = console, env = process.env,
} = {}) {
  if (rootDir && (hasCommentOnlyFinalRoundPush(rootDir, { repo, prNumber, headSha }, logger) ||
      ['pending', 'in-progress'].some((status) => scanPrFollowUpJobs(rootDir, status, repo, prNumber, logger).length > 0))) {
    logger.info?.(`[merge-agent] not applying merge-agent-stuck to ${repo}#${prNumber}@${headSha}: automatic final-round or remediation route owns the PR`);
    return false;
  }
  if (normalizeLabelNames(labels).includes(MERGE_AGENT_STUCK_LABEL)) return false;
  try {
    const adapterHandled = await tryAdapterPullRequestLabelImpl({
      repo,
      prNumber,
      action: 'add',
      labelName: MERGE_AGENT_STUCK_LABEL,
      execFileImpl: ghExecFileImpl, env,
    });
    if (!adapterHandled) {
      await meteredExecFile(ghExecFileImpl, 'gh', [
        'pr',
        'edit',
        String(prNumber),
        '--repo',
        repo,
        '--add-label',
        MERGE_AGENT_STUCK_LABEL,
      ], { maxBuffer: 5 * 1024 * 1024 });
    }
    return true;
  } catch (err) {
    logger?.error?.(
      `merge-agent: failed to apply ${MERGE_AGENT_STUCK_LABEL} to ${repo}#${prNumber}: ${err?.message || err}`
    );
    return false;
  }
}
