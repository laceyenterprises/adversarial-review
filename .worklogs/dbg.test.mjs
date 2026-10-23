import { handlePostedReviewRow } from '../src/posted-review-row.mjs';
import { setNextActionShadowSinkForTesting } from '../src/pr-next-action-shadow.mjs';
const HEAD='a'.repeat(40);
const records=[]; setNextActionShadowSinkForTesting(r=>records.push(r));
const row = { review_status: 'posted', reviewer_head_sha: HEAD, posted_at: '2026-01-01T00:00:00Z' };
await handlePostedReviewRow({ repoPath: 'example/synthetic', prNumber: 7, currentRevisionRef: HEAD, now: () => 0,
    currentReviewRowReader: () => row, projectGateStatusSafe: async () => null,
    latestFollowUpJobFinder: () => null, latestPostedReviewBodyFinder: () => null,
    fetchMergeAgentCandidateImpl: async () => ({ headSha: HEAD, prState: 'merged', merged: true }),
    buildMergeAgentDispatchJobImpl: () => ({}),
    resolveMergeAgentCoexistenceForWatcherImpl: async () => ({ outcome: 'pr-terminal', terminalReason: 'merged' }), logger: {log(){},warn(){},error(){}} });
await new Promise(r=>setImmediate(r));
console.log(JSON.stringify(records.map(r=>[r.kind,r.legacy,r.next.action,r.next.reason])));
