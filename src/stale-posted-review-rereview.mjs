import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  MERGE_AGENT_DISPATCHED_LABEL,
  MERGE_AGENT_REQUESTED_LABEL,
} from './adapters/operator/github-pr-label-controls/index.mjs';
import { isMergeAgentDispatchActiveForHead } from './follow-up-merge-agent.mjs';

const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export async function getStalePostedReviewAutoRereviewSuppression({
  rootDir = ROOT,
  repoPath,
  prNumber,
  subjectRef,
  currentRevisionRef,
  currentHeadSha,
  labelNames = [],
  operatorSurface = null,
  domainId,
  execFileImpl = execFileAsync,
  env = process.env,
  logger = console,
  isMergeAgentDispatchActiveForHeadImpl = isMergeAgentDispatchActiveForHead,
} = {}) {
  const normalizedLabelNames = new Set(
    (Array.isArray(labelNames) ? labelNames : [])
      .map((label) => String(label || '').trim())
      .filter(Boolean)
  );
  const controlSubjectRef = subjectRef || {
    domainId,
    subjectExternalId: `${repoPath}#${prNumber}`,
    revisionRef: currentRevisionRef || currentHeadSha || null,
  };
  const revisionRef = currentRevisionRef || controlSubjectRef.revisionRef || currentHeadSha || null;

  if (normalizedLabelNames.has(MERGE_AGENT_REQUESTED_LABEL) && operatorSurface) {
    const mergeAgentRequest = await operatorSurface.observeMergeAgentOverride(
      controlSubjectRef,
      revisionRef,
    );
    if (mergeAgentRequest?.applied) {
      return {
        suppressed: true,
        reason: 'scoped-current-head-merge-agent-requested',
      };
    }
  }

  if (normalizedLabelNames.has(MERGE_AGENT_DISPATCHED_LABEL)) {
    const dispatch = await isMergeAgentDispatchActiveForHeadImpl(
      rootDir,
      { repo: repoPath, prNumber, headSha: currentHeadSha },
      { execFileImpl, env, logger },
    );
    if (dispatch?.active) {
      return {
        suppressed: true,
        reason: dispatch.reason || 'active-current-head-merge-agent-dispatch',
      };
    }
  }

  return { suppressed: false, reason: null };
}
