import { isGithubMergeConflict } from '../github-mergeability.mjs';
import { mergeLeaseAdmissionReason } from './merge-lease-admission.mjs';
import { observeClosureWait } from './closure-wait.mjs';

// Cap recovery owns no merge authority and never clears refusal evidence.
// The caller refreshes live state first; a conflict returns to the hammer's
// existing lease-free conflict procedure. Otherwise use the durable page path.
export async function recoverMergeLeaseCap({ rootDir, repo, prNumber, headSha, pr,
  observeClosureWaitImpl = observeClosureWait }) {
  const refusal = mergeLeaseAdmissionReason(pr, headSha);
  if (refusal) return { owner: 'closure-recovery', action: 'wait', reason: refusal };
  if (isGithubMergeConflict(pr)) {
    return { owner: 'hammer', action: 'resolve-conflict', reason: 'rebase-conflict' };
  }
  const result = await observeClosureWaitImpl({ rootDir, repo, prNumber, headSha,
    immediate: true, waitClass: 'merge-lease-cap',
    reason: 'merge lease predicate refusal cap at a stable base; closure recovery owns the PR; re-evaluate current predicates and route repair, without an operator attempt reset' });
  return { owner: 'closure-recovery', action: 'page', reason: 'merge-lease-cap',
    paged: result.notify || result.exhausted };
}
