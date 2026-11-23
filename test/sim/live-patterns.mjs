// MRQ-11: live-adapter scenarios for the MLR-05 simulator library.
//
// The discrete-event simulator (simulator.mjs) feeds synthetic ledger events
// straight to the fold. The v2-wrong shadow patterns sit one step earlier: the
// live adapter translates the canonical next-action snapshot into those events.
// Each scenario here drives the production adapter (recordLiveShadow) with
// synthetic snapshots against an in-memory SQLite store, then reads the recorded
// v2 decision and its pattern key. Subjects, heads, labels, launches and jobs are
// synthetic; pattern ids name the adjudicated pattern family only.
//
// `before` records the pre-fix pattern the scenario reproduces. `expect` is the
// corrected decision. The suite asserts `expect`; running it against the
// pre-MRQ-11 sources reproduces `before` (see README "Live-adapter patterns").
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordLiveShadow } from '../../src/finalization/live-shadow.mjs';
import { openFinalizationShadowStore } from '../../src/finalization/shadow-store.mjs';
import { openFinalizationLedgerStore } from '../../src/finalization/ledger-store.mjs';
import { shadowPatternKey } from '../../src/finalization/shadow-pattern.mjs';

export const repo = 'synthetic/project';
export const prNumber = 1;
const subjectKey = `${repo}#${prNumber}`;
const reviewedHead = 'a'.repeat(40);
export const head = 'b'.repeat(40);
const t0 = '2030-01-01T00:00:00.000Z';
// Past the 30 min default verdict patience and the 30 min dispatched-lease window.
const t1 = '2030-01-01T00:31:00.000Z';
const complete = value => ({ state: 'complete', value, provenance: { sourceRef: 'synthetic:read' } });

function snapshot(at, { verdictHead = head, blocking = 0, nonBlocking = 0, verdict = true } = {}) {
  return { subjectKey, head, observedAt: at, passId: `synthetic-pass:${at}`, observations: {
    pr: complete({ headSha: head, baseBranch: 'main', state: 'open', mergeable: 'MERGEABLE' }),
    reviews: complete({ headSha: verdictHead, verdict: verdict ? (blocking ? 'request-changes' : 'comment-only') : null,
      blockingFindingState: 'known', nonBlockingFindingState: 'known',
      blockingFindingCount: blocking, nonBlockingFindingCount: nonBlocking }),
    checks: complete({ headSha: head, requiredContexts: ['unit'], rollup: [
      { name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: t0 }] }),
    leases: complete({ closer: null }),
    launches: complete({ closer: null }),
  } };
}

// A hammer whose closer lease was dispatched at t0: live at t0, its 30 min
// window lapsed at t1. The launch ledger still reports the launch running.
function runningHammer(s, { status = 'running', launchRequestId = 'synthetic-launch', chain } = {}) {
  s.observations.leases = complete({ closer: { status: 'dispatched', headSha: head, updatedAt: t0, lrqId: launchRequestId } });
  s.observations.launches = complete({ closer: { headSha: head, launchRequestId,
    ...(chain ? { row: { status }, retryChainUnreadable: true } : { status }) } });
  return s;
}

const labelGate = s => {
  s.observations.reviews.value.operatorLabelFindings = { allGated: true,
    gated: [{ reason: 'operator-label-required:synthetic-label' }] };
  return s;
};
const spentRounds = s => {
  s.observations.remediation = complete({ job: { status: 'completed', jobId: 'synthetic-job', headSha: reviewedHead,
    remediationPlan: { currentRound: 2, maxRounds: 2 } } });
  return s;
};
const exhausted = s => { s.observations.policy = complete({ reviewCeilingReached: true }); return s; };
const merged = s => { Object.assign(s.observations.pr.value, { state: 'MERGED', mergeable: 'UNKNOWN' }); return s; };
// The reviewer never re-reviews a comment-only final-round push.
const commentOnlyFinalPushJob = { jobId: 'synthetic-final-round', repo, prNumber, status: 'completed',
  revisionRef: reviewedHead, completedAt: t0, finalRound: 'comment-only',
  reReview: { requested: false, suppressed: 'comment-only-final-round' },
  remediationPlan: { currentRound: 3, maxRounds: 3 }, completion: { workerPushedHeadSha: head } };

const hammerLiveOwner = { action: 'hammer', reason: 'live-owner' };
const needsOperator = { action: 'operator-hold', reason: 'needs-operator' };
const custodyWait = { kind: 'wait', reason: 'launch requires verified progress', nextAction: 'reconcile-custody' };

export const livePatternScenarios = [
  // D1: owner and custody blindness.
  { id: 'MRQ11-D1-P01-running-launch-past-verdict-patience', defect: 'D1',
    before: { kind: 'escalate', reason: 'verdict patience expired at current revision' },
    steps: [
      { at: t0, snapshot: () => runningHammer(snapshot(t0, { verdictHead: reviewedHead })), legacy: hammerLiveOwner },
      { at: t1, snapshot: () => runningHammer(snapshot(t1, { verdictHead: reviewedHead })), legacy: hammerLiveOwner },
    ], expect: custodyWait },
  { id: 'MRQ11-D1-P09-running-launch-blocking-finding', defect: 'D1',
    before: { kind: 'remediate', reason: 'blocking review finding at current revision' },
    steps: [{ at: t1, snapshot: () => runningHammer(snapshot(t1, { blocking: 1 })), legacy: hammerLiveOwner }],
    expect: custodyWait },
  { id: 'MRQ11-D1-P10-running-launch-final-remediation', defect: 'D1',
    before: { kind: 'remediate', reason: 'final coverage-gated remediation (budget exhausted; addresses all comments before merge)' },
    steps: [{ at: t1, snapshot: () => exhausted(runningHammer(snapshot(t1, { blocking: 1 }))), legacy: hammerLiveOwner }],
    expect: custodyWait },
  { id: 'MRQ11-D1-P27-running-launch-strict-comments', defect: 'D1',
    before: { kind: 'remediate', reason: 'non-blocking comments must be addressed before merge (strict_mode)' },
    steps: [{ at: t1, snapshot: () => runningHammer(snapshot(t1, { nonBlocking: 1 })), legacy: hammerLiveOwner }],
    expect: custodyWait },
  { id: 'MRQ11-D1-P13-running-launch-conflict', defect: 'D1',
    before: { kind: 'wait', reason: 'conflict requires owned repair', nextAction: 'conflict-rebase' },
    steps: [{ at: t1, snapshot: () => {
      const s = runningHammer(snapshot(t1));
      s.observations.pr.value.mergeable = 'DIRTY';
      return s;
    }, legacy: needsOperator }],
    expect: custodyWait },
  { id: 'MRQ11-D1-P31-running-launch-held-final-remediation', defect: 'D1',
    before: { kind: 'remediate', reason: 'final coverage-gated remediation (budget exhausted; addresses all comments before merge)' },
    steps: [{ at: t1, snapshot: () => exhausted(runningHammer(snapshot(t1, { blocking: 1 }))), legacy: needsOperator }],
    expect: custodyWait },
  { id: 'MRQ11-D1-P17-launch-ownership-unreadable', defect: 'D1',
    before: { kind: 'escalate', reason: 'verdict patience expired at current revision' },
    steps: [
      { at: t0, snapshot: () => snapshot(t0, { verdictHead: reviewedHead }), legacy: hammerLiveOwner },
      { at: t1, snapshot: () => runningHammer(snapshot(t1, { verdictHead: reviewedHead }), { status: 'succeeded', chain: true }),
        legacy: { action: 'hammer', reason: 'ownership-unreadable' } },
    ], expect: { kind: 'wait', reason: 'live evidence unknown: launch ownership unreadable', nextAction: 'refresh-evidence' } },
  { id: 'MRQ11-D1-terminal-launch-releases-custody', defect: 'D1', regression: true,
    before: { kind: 'remediate', reason: 'blocking review finding at current revision' },
    steps: [
      { at: t0, snapshot: () => runningHammer(snapshot(t0, { blocking: 1 })), legacy: hammerLiveOwner },
      { at: t1, snapshot: () => runningHammer(snapshot(t1, { blocking: 1 }), { status: 'succeeded' }),
        legacy: { action: 'remediate', reason: 'review-findings' } },
    ], expect: { kind: 'remediate', reason: 'blocking review finding at current revision', nextAction: 'dispatch-remediation' } },

  // D2: verdict required on a review-suppressed (comment-only final round) head.
  { id: 'MRQ11-D2-P04-final-round-push-awaits-verdict', defect: 'D2', jobs: [commentOnlyFinalPushJob],
    before: { kind: 'wait', reason: 'no verdict at current revision' },
    steps: [{ at: t0, snapshot: () => snapshot(t0, { verdictHead: reviewedHead }),
      legacy: { action: 'hammer', reason: 'suppressed-final-push', legacyReason: 'dispatched' } }],
    expect: { kind: 'wait', reason: 'final remediator head requires strict exact-head review', nextAction: 'request-reexact-review' } },
  { id: 'MRQ11-D2-P05-final-round-push-past-patience', defect: 'D2', jobs: [commentOnlyFinalPushJob],
    before: { kind: 'escalate', reason: 'verdict patience expired at current revision' },
    steps: [
      { at: t0, snapshot: () => snapshot(t0, { verdictHead: reviewedHead }), legacy: { action: 'hammer', reason: 'suppressed-final-push' } },
      { at: t1, snapshot: () => snapshot(t1, { verdictHead: reviewedHead }), legacy: { action: 'hammer', reason: 'suppressed-final-push' } },
    ], expect: { kind: 'wait', reason: 'final remediator head requires strict exact-head review', nextAction: 'request-reexact-review' } },
  { id: 'MRQ11-D2-P14-dispatched-final-round-push-past-patience', defect: 'D2', jobs: [commentOnlyFinalPushJob],
    before: { kind: 'escalate', reason: 'verdict patience expired at current revision' },
    steps: [
      { at: t0, snapshot: () => snapshot(t0, { verdictHead: reviewedHead }),
        legacy: { action: 'hammer', reason: 'suppressed-final-push', legacyReason: 'dispatched' } },
      { at: t1, snapshot: () => snapshot(t1, { verdictHead: reviewedHead }),
        legacy: { action: 'hammer', reason: 'suppressed-final-push', legacyReason: 'dispatched' } },
    ], expect: { kind: 'wait', reason: 'final remediator head requires strict exact-head review', nextAction: 'request-reexact-review' } },

  // D3: operator-decision holds, applied after the live-owner and custody gates.
  { id: 'MRQ11-D3-P06-label-gated-finding-no-owner', defect: 'D3',
    before: { kind: 'remediate', reason: 'blocking review finding at current revision' },
    steps: [{ at: t0, snapshot: () => labelGate(snapshot(t0, { blocking: 1 })), legacy: needsOperator }],
    expect: { kind: 'escalate', reason: 'operator decision required: findings gated on an operator label',
      nextAction: 'monitor-hold', relation: 'agree' } },
  { id: 'MRQ11-D3-label-gated-finding-running-launch', defect: 'D3', regression: true,
    before: { kind: 'remediate', reason: 'blocking review finding at current revision' },
    steps: [{ at: t1, snapshot: () => labelGate(runningHammer(snapshot(t1, { blocking: 1 }))), legacy: needsOperator }],
    expect: custodyWait },
  { id: 'MRQ11-D3-P07-label-gated-finding-live-hammer-lease', defect: 'D3', regression: true,
    before: { kind: 'wait', reason: 'live-owner: hammer holds an unexpired lease' },
    steps: [{ at: t0, snapshot: () => labelGate(runningHammer(snapshot(t0, { blocking: 1 }))), legacy: needsOperator }],
    expect: { kind: 'wait', reason: 'live-owner: hammer holds an unexpired lease', nextAction: 'monitor-agent' } },

  // D4: spent remediation rounds reach v2's exhaustion policy.
  { id: 'MRQ11-D4-P11-spent-rounds-final-remediation', defect: 'D4',
    before: { kind: 'remediate', reason: 'blocking review finding at current revision' },
    steps: [{ at: t0, snapshot: () => spentRounds(snapshot(t0, { blocking: 1 })),
      legacy: { action: 'hammer', reason: 'review-findings-final' } }],
    expect: { kind: 'remediate', reason: 'final coverage-gated remediation (budget exhausted; addresses all comments before merge)',
      nextAction: 'dispatch-remediation' } },

  // D5: an observed merge is terminal evidence.
  { id: 'MRQ11-D5-P20-merged-this-pass', defect: 'D5',
    before: { kind: 'wait', reason: 'mergeability unknown' },
    steps: [
      { at: t0, snapshot: () => snapshot(t0), legacy: { action: 'daemon-merge', reason: 'clean-exact-head' } },
      { at: t1, snapshot: () => merged(snapshot(t1)), legacy: { action: 'daemon-merge', reason: 'merged-this-pass' } },
    ], expect: { kind: 'wait', reason: 'merged; post-merge activation pending', nextAction: 'deliver', relation: 'agree' } },
  { id: 'MRQ11-D5-P21-done-merged', defect: 'D5',
    before: { kind: 'wait', reason: 'mergeability unknown' },
    steps: [
      { at: t0, snapshot: () => snapshot(t0), legacy: { action: 'daemon-merge', reason: 'clean-exact-head' } },
      { at: t1, snapshot: () => merged(snapshot(t1)), legacy: { action: 'done', reason: 'merged' } },
    ], expect: { kind: 'wait', reason: 'merged; post-merge activation pending', nextAction: 'deliver', relation: 'agree' } },

  // D7: previously unkeyable v1 detail classes (null-key bucket).
  { id: 'MRQ11-D7-null-label-gated-detail', defect: 'D7', keyOnly: true,
    before: { kind: 'remediate', reason: 'blocking review finding at current revision', patternKey: null },
    steps: [{ at: t0, snapshot: () => snapshot(t0, { blocking: 1 }),
      legacy: { action: 'operator-hold', reason: 'operator-label-required:synthetic-label' } }],
    expect: { kind: 'remediate', reason: 'blocking review finding at current revision',
      detail: 'operator-hold:operator-label-required' } },
  { id: 'MRQ11-D7-null-repair-owner-unproven', defect: 'D7', keyOnly: true,
    before: { kind: 'wait', reason: 'conflict requires owned repair', patternKey: null },
    steps: [{ at: t0, snapshot: () => { const s = snapshot(t0); s.observations.pr.value.mergeable = 'DIRTY'; return s; },
      legacy: { action: 'operator-hold', reason: 'repair-owner-unproven' } }],
    expect: { kind: 'wait', reason: 'conflict requires owned repair', detail: 'operator-hold:repair-owner-unproven' } },

  // D8: fold/evidence error causes become typed unknowns.
  { id: 'MRQ11-D8-checks-evidence-regressed', defect: 'D8',
    before: { kind: 'escalate', foldError: true },
    steps: [
      { at: t0, snapshot: () => snapshot(t0, { verdictHead: reviewedHead }), legacy: { action: 'wait-for-CI', reason: 'checks-pending' } },
      { at: t1, snapshot: () => {
        const s = snapshot(t1, { verdictHead: reviewedHead });
        s.observations.checks = { state: 'unknown', value: null };
        return s;
      }, legacy: { action: 'wait-for-CI', reason: 'checks-unknown' } },
    ], expect: { kind: 'wait', reason: 'live evidence unknown: checks evidence regressed at settled head', nextAction: 'refresh-evidence' } },
  { id: 'MRQ11-D8-verdict-evidence-regressed', defect: 'D8',
    before: { kind: 'escalate', foldError: true },
    steps: [
      { at: t0, snapshot: () => snapshot(t0, { blocking: 1 }), legacy: { action: 'remediate', reason: 'review-findings' } },
      { at: t1, snapshot: () => {
        const s = snapshot(t1, { blocking: 1 });
        s.observations.reviews = { state: 'unknown', value: null };
        return s;
      }, legacy: { action: 'wait-for-CI', reason: 'reviews-unknown' } },
    ], expect: { kind: 'wait', reason: 'live evidence unknown: verdict evidence regressed at recorded verdict head',
      nextAction: 'refresh-evidence' } },
  { id: 'MRQ11-D8-out-of-order-snapshot', defect: 'D8',
    before: { kind: 'escalate', foldError: true },
    steps: [
      { at: t1, snapshot: () => snapshot(t1, { verdictHead: reviewedHead }), legacy: { action: 'wait-for-CI', reason: 'checks-pending' } },
      { at: t0, snapshot: () => snapshot(t0, { verdictHead: reviewedHead }), legacy: { action: 'wait-for-CI', reason: 'checks-pending' } },
    ], expect: { kind: 'wait', reason: 'live evidence unknown: out-of-order snapshot', nextAction: 'refresh-evidence' } },
  { id: 'MRQ11-D8-post-merge-evidence-regressed', defect: 'D8',
    before: { kind: 'escalate', foldError: true },
    steps: [
      { at: t0, snapshot: () => snapshot(t0), legacy: { action: 'daemon-merge', reason: 'clean-exact-head' } },
      { at: t1, snapshot: () => {
        const s = merged(snapshot(t1));
        s.observations.checks = { state: 'unknown', value: null };
        return s;
      }, legacy: { action: 'done', reason: 'merged' } },
    ], expect: { kind: 'wait', reason: 'merged; post-merge activation pending', nextAction: 'deliver', relation: 'agree' } },
];

/** Drive one scenario through the production live adapter. Returns the last
 * recorded observation, its pattern key and the subject's ledger events. */
export function runLivePattern(scenario) {
  const db = new Database(':memory:');
  const rootDir = mkdtempSync(join(tmpdir(), 'mrq11-live-pattern-'));
  try {
    if (scenario.jobs?.length) {
      const dir = join(rootDir, 'data', 'follow-up-jobs', 'completed');
      mkdirSync(dir, { recursive: true });
      scenario.jobs.forEach((job, index) => writeFileSync(join(dir,
        `${repo.replace('/', '__')}-pr-${prNumber}-synthetic-${index}.json`), JSON.stringify(job)));
    }
    const shadowStore = openFinalizationShadowStore({ db });
    let observation = null;
    for (const step of scenario.steps) {
      observation = recordLiveShadow({ rootDir, snapshot: step.snapshot(), legacy: step.legacy,
        repo, prNumber, source: 'synthetic-live-pattern', shadowStore });
    }
    const events = openFinalizationLedgerStore({ db }).read({ domainId: 'code-pr', subjectExternalId: subjectKey });
    return { observation, patternKey: shadowPatternKey(observation), events };
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
}
