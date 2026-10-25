import { deriveNextActionSnapshot, nextAction } from '../../src/pr-next-action.mjs';
const HEAD = 'a'.repeat(40), OLD = 'b'.repeat(40);
const AT = '2026-01-01T00:00:00.000Z';
const quiet = { log() {}, warn() {}, error() {} };
const identity = { repo: 'subject-07', prNumber: 7, headSha: HEAD };
const clean = { headSha: HEAD, verdict: 'approved', blockingFindingState: 'known', blockingFindingCount: 0,
  nonBlockingFindingState: 'known', nonBlockingFindingCount: 0 };
const policy = { autonomousMergeExecutionEnabled: true, strictMode: true };
const terminal = { headSha: HEAD, launchRequestId: 'attempt-07', attempt: 1,
  row: { status: 'succeeded' }, retryChain: [], outcome: 'no-merge', retryable: true };
const cases = [
  ['final push', { reviews: { ...clean, headSha: OLD }, remediation: { roundsLeft: false,
    finalPush: { headSha: HEAD, suppressed: true } } }, 'hammer', 'hammer'],
  ['terminal no merge over stale projection', { launches: { closer: terminal },
    leases: { closer: { headSha: HEAD, status: 'dispatched', lrqId: 'attempt-07', acquiredAt: AT } } }, 'hammer', 'hammer'],
  ['failed CI final round', { checks: { conclusion: 'FAILURE' } }, 'hammer', 'hammer'],
  ['failed CI remaining round without a job or findings', { checks: { conclusion: 'FAILURE' },
    remediation: { roundsLeft: true } }, 'hammer', 'hammer'],
  ['failed CI remaining round with a pending PR job', { checks: { conclusion: 'FAILURE' },
    remediation: { roundsLeft: true, job: { status: 'pending', headSha: OLD } } }, 'remediate', 'remediator'],
  ['failed CI completed non-final pushed head', { checks: { conclusion: 'FAILURE' },
    reviews: { ...clean, headSha: OLD }, remediation: { roundsLeft: true,
      job: { status: 'completed', headSha: HEAD } } }, 'remediate', 'remediator'],
  ['failed CI new same-head findings after a stopped job', { checks: { conclusion: 'FAILURE' },
    reviews: { ...clean, verdict: 'request-changes', blockingFindingCount: 1, postedAt: AT },
    remediation: { roundsLeft: true, job: { status: 'stopped', headSha: HEAD,
      createdAt: '2025-12-31T23:59:00.000Z' } } }, 'remediate', 'remediator'],
  ['conflict', { pr: { state: 'OPEN', headSha: HEAD, mergeable: 'CONFLICTING' } }, 'hammer', 'hammer'],
  ['drain before capacity', { checks: { conclusion: 'FAILURE' }, policy: { ...policy,
    drain: { active: true, epoch: 7 }, capacity: { hammer: { inFlight: 2, cap: 2 } } } }, 'hammer', 'hammer'],
  ['semantic rebase', { reviews: { ...clean, headSha: OLD }, progress: {
    contentProof: { kind: 'context-only-rebase', semantic: true, fromHead: OLD, toHead: HEAD } } }, 'daemon-merge', 'daemon'],
  ['empty diff remains open', { progress: { diffEmpty: true } }, 'hammer', 'closure-recovery'],
  ['unknown descendants plus stop', { launches: { closer: { ...terminal, retryChainUnreadable: true } },
    controls: { stop: { deterministic: true, fingerprint: 'stop-07' } } }, 'hammer', 'closure-recovery'],
  ['unknown checks plus safety stop', { checks: null, controls: {
    safetyRefusal: { deterministic: true, reason: 'evidence-07' } } }, 'hammer', 'closure-recovery'],
  ['pending checks', { checks: { conclusion: 'PENDING' } }, 'wait-for-CI', 'ci'],
  ['unproven head', { reviews: { ...clean, headSha: OLD } }, 'review', 'reviewer'],
  ['unproven head with drain', { reviews: { ...clean, headSha: OLD },
    policy: { ...policy, drain: { active: true, epoch: 7 } } }, 'review', 'reviewer'],
  ['unproven head at capacity', { reviews: { ...clean, headSha: OLD },
    policy: { ...policy, capacity: { reviewer: { inFlight: 2, cap: 2 } } } }, 'review', 'reviewer'],
  ['explicit hold', { pr: { state: 'OPEN', headSha: HEAD, isDraft: true } }, 'operator-hold', 'operator'],
  ['confirmed terminal', { pr: { state: 'MERGED', headSha: HEAD } }, 'done', 'none'],
];

export { HEAD, OLD, AT, quiet, identity, clean, policy, terminal, cases };
export function matrixPair(observations = {}) {
  const snapshot = deriveNextActionSnapshot({ subjectKey: 'subject-07#7', head: HEAD, observedAt: AT,
    anchors: { firstActionableAt: AT }, observations: {
      pr: { state: 'OPEN', headSha: HEAD, mergeable: 'MERGEABLE', labels: [] },
      reviews: clean, checks: { conclusion: 'SUCCESS' }, remediation: { roundsLeft: false },
      leases: { closer: null }, launches: { closer: null }, policy, ...observations } });
  return Object.freeze({ snapshot, decision: nextAction(snapshot) });
}
