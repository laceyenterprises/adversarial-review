import { handlePostedReviewRow } from '../../src/posted-review-row.mjs';
import { maybeDispatchAmaClosureFor } from '../../src/ama-closure-orchestration.mjs';
import { attemptDaemonCleanMerge } from '../../src/ama/daemon-merge.mjs';
import { observeClosureWait } from '../../src/ama/closure-wait.mjs';
const repo = 'fixture/repo';
export const cleanBody = '## Blocking issues\n- None.\n## Non-blocking issues\n- None.\n## Verdict\nApproved';
const findingsBody = '## Blocking issues\n- None.\n## Non-blocking issues\n- **Cleanup**\n  - **File:** `src/fixture.mjs`\n  - **Lines:** `1`\n  - **Problem:** redundant branch\n  - **Recommended fix:** remove it\n## Verdict\nComment only';
const quiet = { log() {}, warn() {}, error() {} };
// Both production watcher phases run. Only external GitHub/dispatch/merge
// boundaries are injected; the actual primary-change and merge predicates run.
export async function watcherTick({ rootDir, prNumber, headSha, evidence, store, row, closerImpl, closureOnly = false, runMerge = async () => {}, gateOverrides = {}, candidateOverrides = {}, pageImpl = async () => {}, findings = false }) {
  const candidate = { repo, prNumber, headSha, prState: store.merged ? 'merged' : 'open',
    title: '[codex] HAMCLOSE replay', body: '', baseBranch: 'main', isDraft: false, riskClass: 'low',
    mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: [{ name: 'ci', conclusion: 'SUCCESS' }],
    labels: [], branchProtection: { requiredContexts: [] }, ...candidateOverrides };
  const reviewState = { blockingFindingCount: 0, blockingFindingState: 'known', nonBlockingFindingCount: 0,
    nonBlockingFindingState: 'known', headSha, verdict: 'approved' };
  if (findings) {
    reviewState.nonBlockingFindingCount = 1;
    reviewState.remediationStopCode = 'max-rounds-reached';
  }
  const body = findings ? findingsBody : cleanBody;
  return handlePostedReviewRow({ rootDir, repoPath: repo, prNumber, existing: row,
    currentRevisionRef: headSha, logger: quiet,
    currentReviewRowReader: () => row, latestFollowUpJobFinder: () => null,
    latestPostedReviewBodyFinder: () => body,
    projectGateStatusSafe: async () => ({ decision: { state: 'success', reason: 'review-settled' } }),
    fetchMergeAgentCandidateImpl: async () => candidate,
    buildMergeAgentDispatchJobImpl: () => ({ ...reviewState }),
    resolveMergeAgentCoexistenceForWatcherImpl: async () => ({ outcome: 'ama-pending',
      amaClosureResult: store.lastClosure = await maybeDispatchAmaClosureFor({ rootDir, repoPath: repo, prNumber,
        candidate, reviewStateRow: row, currentRevisionRef: headSha, dispatchJob: reviewState, labelNames: [], logger: { ...quiet, warn: message => { (store.warnings ||= []).push(message); } },
        loadConfigImpl: () => ({ getMergeAuthorityConfig: () => ({ enabled: true, strictMode: true,
          autonomousMergeExecutionEnabled: true, branchProtection: { required: false }, lha: { consumeAttestations: false } }) }),
        observeClosureWaitImpl: args => observeClosureWait({ ...args, pageImpl }),
        resolveHeadCloserCommitSuppressionImpl: async () => ({ suppressed: false }),
        fetchHeadCloserVerifiedCommitImpl: async () => null,
        fetchPullRequestMergeabilityImpl: async () => ({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }),
        fetchMergedProtectiveDependentsImpl: async () => [],
        fetchProtectivePredecessorStateImpl: async () => null,
        fetchLatestHeadReviewBodiesImpl: async () => closureOnly ? [] : [body], liveReviewRetryDelaysMs: [0],
        maybeDispatchAmaCloserImpl: closerImpl || (async () => { throw new Error('clean review must not launch a hammer'); }),
        runDaemonCleanMergeAttemptImpl: async () => {
          if (closureOnly) return { disposition: 'not-taken', reason: 'stale-head' };
          const gate = { candidateHead: headSha, validatedHead: headSha, requiredChecks: candidate.statusCheckRollup,
            mergeable: 'MERGEABLE', prState: 'OPEN', labels: [], primaryChange: evidence,
            requirePrimaryChange: true, strictNonBlockingRemediation: true, ...gateOverrides };
          const result = await attemptDaemonCleanMerge({ repo, prNumber, base: 'main', validatedHead: headSha,
            verdict: 'settled-success', reviewState, liveGate: gate, branchProtectionRequired: false,
            prTitle: candidate.title, hqRoot: rootDir, logger: quiet,
            fetchLiveGateImpl: async () => store.merged ? { ...gate, prState: 'MERGED' } : gate,
            acquireLeaseImpl: () => ({ acquired: true, lease: { leaseId: 'fixture' } }), releaseLeaseImpl() {},
            runMergeImpl: async () => { await runMerge(headSha); store.merged = true; return { exitCode: 0, stdout: '', stderr: '' }; },
            writeAuditImpl: () => ({ written: true }), appendAuditImpl: () => ({ written: true }), readAuditImpl: () => null });
          return result;
        },
      }) }),
    dispatchMergeAgentForPRImpl: async () => { throw new Error('merge-agent fallback must not run'); },
  });
}
