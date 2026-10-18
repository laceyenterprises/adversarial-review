import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { meteredExecFile } from './metered-gh.mjs';

const execFileAsync = promisify(execFile);

// Read-only seam for posted-review scheduling. Guard actions remain in the
// normal candidate evaluation, after the handler's review/scope checks.
export async function fetchMergeAgentCandidateSnapshot(repo, prNumber, {
  execFileImpl = execFileAsync, signal = null,
} = {}) {
  const { stdout } = await meteredExecFile(execFileImpl,
    'gh',
    [
      'pr',
      'view',
      String(prNumber),
      '--repo',
      repo,
      '--json',
      'mergeable,mergeStateStatus,headRefName,baseRefName,baseRefOid,headRefOid,title,body,labels,statusCheckRollup,state,mergedAt,closedAt,updatedAt,author',
    ],
    { maxBuffer: 5 * 1024 * 1024, ...(signal ? { signal } : {}) }
  );
  return JSON.parse(String(stdout || '{}'));
}
