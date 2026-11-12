import './helpers/rate-limit-state-isolation.mjs';
// REVIEWROUNDLEDGER-01: one per-PR round ledger counts every review and
// remediation round from every producer, numbers remediation rounds PR-wide,
// and makes the risk-tier budget bind on all of them. Synthetic fixtures only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  claimNextFollowUpJob,
  createFollowUpJob,
  markFollowUpJobCompleted,
  markFollowUpJobSpawned,
  readFollowUpJob,
  requeueInProgressFollowUpJobForRetry,
  summarizePRRemediationLedger,
  writeFollowUpJob,
} from '../src/follow-up-jobs.mjs';
import {
  CHARGED_TO,
  PR_ROUND_KINDS,
  formatPrRoundLedgerSummary,
  prRoundLedgerPath,
  readPrRoundLedger,
  recordPrRound,
  summarizePrRoundLedger,
  voidPrRound,
} from '../src/pr-round-ledger.mjs';
import { buildRemediationOutcomeCommentBody } from '../src/adapters/comms/github-pr-comments/pr-comments.mjs';
import { buildPrRoundLedgerView, main as ledgerCliMain } from '../bin/pr-round-ledger.mjs';
import { main as retriggerReviewMain } from '../src/retrigger-review.mjs';
import {
  recordHammerRetryDispatch, refundUnexecutedHammerDispatch, reserveHammerRepairDispatch,
} from '../src/ama/hammer-retry-cap.mjs';
import { noWorkVerdict } from './fixtures/execution-verdict.mjs';
import { DEFAULT_ROUND_BUDGET_BY_RISK } from '../src/kernel/convergence-budget.mjs';

const REPO = 'example-org/example-repo';
const PR = 42;
const HEAD = (n) => String(n).repeat(40).slice(0, 40);

const BLOCKING_BODY = `## Summary
Synthetic review.

## Blocking issues
- **A real defect**
  - **File:** \`a.mjs\`
  - **Lines:** \`10\`
  - **Problem:** synthetic.

## Non-blocking issues
- None.

## Verdict
Request changes
`;

const NON_BLOCKING_BODY = `## Summary
Synthetic review.

## Blocking issues
- None.

## Non-blocking issues
- **A style nit**
  - **File:** \`b.mjs\`
  - **Lines:** \`20\`
  - **Problem:** synthetic.

## Verdict
Comment only
`;

function tmpRoot() {
  return mkdtempSync(path.join(tmpdir(), 'pr-round-ledger-'));
}

function capture() {
  let text = '';
  return { write(chunk) { text += chunk; return true; }, text: () => text };
}

function createJob(rootDir, overrides = {}) {
  const { job, jobPath } = createFollowUpJob({
    rootDir,
    repo: REPO,
    prNumber: PR,
    reviewerModel: 'claude',
    reviewBody: BLOCKING_BODY,
    critical: false,
    builderTag: 'codex',
    branch: 'feature/synthetic',
    ...overrides,
  });
  return { job, jobPath };
}

function spawnClaimed(claimed, at) {
  return markFollowUpJobSpawned({
    jobPath: claimed.jobPath,
    spawnedAt: at,
    worker: { processId: 4242, state: 'spawned', workspaceDir: 'workspace' },
  });
}

function complete(rootDir, spawned, at) {
  return markFollowUpJobCompleted({
    rootDir,
    jobPath: spawned.jobPath,
    finishedAt: at,
    completionPreview: 'synthetic round',
    remediationWorker: { ...spawned.job.remediationWorker, state: 'completed' },
    reReview: { requested: true, status: 'pending', triggered: true, requestedAt: at, reason: 'synthetic' },
  });
}

function runRound(rootDir, at, done) {
  const claimed = claimNextFollowUpJob({ rootDir, claimedAt: at, returnStopped: true });
  assert.ok(claimed && !claimed.stopped, `expected a live claim at ${at}`);
  const spawned = spawnClaimed(claimed, at);
  const completed = complete(rootDir, spawned, done);
  return { claimed, spawned, completed };
}

function header(job) {
  return buildRemediationOutcomeCommentBody({ workerClass: 'codex', action: 'completed', job,
    reReview: { status: 'pending', requested: true } }).split('\n').find(line => line.startsWith('## Remediation Worker'));
}

function liftNonBlockingCap(jobPath) {
  // Synthetic config: allow several non-blocking rounds so the numbering, not
  // the non-blocking cap, is what this test observes.
  const job = readFollowUpJob(jobPath);
  writeFollowUpJob(jobPath, { ...job, nonBlockingMaxRounds: 5 });
}

test('blocking -> non-blocking -> non-blocking rounds are numbered 1, 2, 3 of the budget', () => {
  const rootDir = tmpRoot();
  const headers = [];
  const bodies = [BLOCKING_BODY, NON_BLOCKING_BODY, NON_BLOCKING_BODY];
  for (const [index, reviewBody] of bodies.entries()) {
    const prior = summarizePRRemediationLedger(rootDir, { repo: REPO, prNumber: PR }).completedRoundsForPR;
    const { jobPath, job } = createJob(rootDir, {
      reviewBody,
      revisionRef: HEAD(index + 1),
      reviewPostedAt: `2026-01-0${index + 1}T00:00:00.000Z`,
      priorCompletedRounds: prior,
      maxRemediationRounds: 3,
    });
    if (job.nonBlockingOnly) liftNonBlockingCap(jobPath);
    const { spawned } = runRound(rootDir, `2026-01-0${index + 1}T01:00:00.000Z`, `2026-01-0${index + 1}T02:00:00.000Z`);
    headers.push(header(spawned.job));
  }
  assert.deepEqual(headers, [
    '## Remediation Worker (codex) — round 1 of 3',
    '## Remediation Worker (codex) — round 2 of 3',
    '## Remediation Worker (codex) — round 3 of 3',
  ]);
  const summary = summarizePrRoundLedger(rootDir, { repo: REPO, prNumber: PR });
  assert.equal(summary.byKind[PR_ROUND_KINDS.FOLLOW_UP_BLOCKING], 1);
  assert.equal(summary.byKind[PR_ROUND_KINDS.FOLLOW_UP_NON_BLOCKING], 2);
  assert.equal(summary.byKind[PR_ROUND_KINDS.REVIEW_PASS], 3);
});

test('two jobs carrying the same legacy round number are counted twice and numbered apart', () => {
  const rootDir = tmpRoot();
  createJob(rootDir, { revisionRef: HEAD(1), reviewPostedAt: '2026-01-01T00:00:00.000Z' });
  const first = runRound(rootDir, '2026-01-01T01:00:00.000Z', '2026-01-01T02:00:00.000Z');
  assert.equal(first.spawned.job.remediationPlan.currentRound, 1);
  // A second chain seeded at zero (a racing creator, a closure seed) used to
  // print "round 1 of N" again and leave the PR count at 1.
  createJob(rootDir, { revisionRef: HEAD(2), reviewPostedAt: '2026-01-02T00:00:00.000Z', priorCompletedRounds: 0 });
  const second = runRound(rootDir, '2026-01-02T01:00:00.000Z', '2026-01-02T02:00:00.000Z');
  assert.equal(second.spawned.job.remediationPlan.currentRound, 2);
  assert.match(header(second.spawned.job), /round 2 of 2$/u);
  const remediation = readPrRoundLedger(rootDir, { repo: REPO, prNumber: PR })
    .filter(entry => entry.class === 'remediation');
  assert.equal(remediation.length, 2);
  assert.equal(summarizePRRemediationLedger(rootDir, { repo: REPO, prNumber: PR }).completedRoundsForPR, 2);
});

test('the non-blocking streak keeps separate jobs that share a round number', () => {
  const rootDir = tmpRoot();
  for (const day of [1, 2]) {
    const { jobPath, job } = createJob(rootDir, { reviewBody: NON_BLOCKING_BODY, revisionRef: HEAD(day),
      reviewPostedAt: `2026-01-0${day}T00:00:00.000Z`, priorCompletedRounds: 0, maxRemediationRounds: 3 });
    assert.equal(job.nonBlockingOnly, true);
    liftNonBlockingCap(jobPath);
    const { completed } = runRound(rootDir, `2026-01-0${day}T01:00:00.000Z`, `2026-01-0${day}T02:00:00.000Z`);
    // Force the legacy collision: both terminal jobs carry currentRound 1.
    const done = readFollowUpJob(completed.jobPath);
    writeFollowUpJob(completed.jobPath, { ...done, remediationPlan: { ...done.remediationPlan, currentRound: 1 } });
  }
  assert.equal(summarizePRRemediationLedger(rootDir, { repo: REPO, prNumber: PR }).consecutiveNonBlockingRounds, 2);
});

test('the non-blocking streak follows terminal time when round numbers move backwards', () => {
  const rootDir = tmpRoot();
  const completedPaths = [];
  for (const [index, reviewBody] of [NON_BLOCKING_BODY, BLOCKING_BODY, NON_BLOCKING_BODY].entries()) {
    const day = index + 1;
    const { jobPath, job } = createJob(rootDir, { reviewBody, revisionRef: HEAD(day),
      reviewPostedAt: `2026-01-0${day}T00:00:00.000Z`, maxRemediationRounds: 3 });
    if (job.nonBlockingOnly) liftNonBlockingCap(jobPath);
    completedPaths.push(runRound(rootDir, `2026-01-0${day}T01:00:00.000Z`,
      `2026-01-0${day}T02:00:00.000Z`).completed.jobPath);
  }
  for (const [index, jobPath] of completedPaths.entries()) {
    const job = readFollowUpJob(jobPath);
    writeFollowUpJob(jobPath, { ...job, remediationPlan: { ...job.remediationPlan,
      currentRound: [9, 1, 2][index] } });
  }
  assert.equal(summarizePRRemediationLedger(rootDir, { repo: REPO, prNumber: PR }).consecutiveNonBlockingRounds, 1);
});

for (const [riskClass, budget] of Object.entries(DEFAULT_ROUND_BUDGET_BY_RISK)) {
  test(`CLI charges a legacy exhausted ${riskClass} PR update to the operator before its first ledger write`, () => {
    const rootDir = tmpRoot();
    createJob(rootDir, { riskClass, revisionRef: HEAD(1), reviewPostedAt: '2026-01-01T00:00:00.000Z' });
    const { completed } = runRound(rootDir, '2026-01-01T01:00:00.000Z', '2026-01-01T02:00:00.000Z');
    const job = readFollowUpJob(completed.jobPath);
    writeFollowUpJob(completed.jobPath, { ...job, remediationPlan: { ...job.remediationPlan, currentRound: budget } });
    // Legacy jobs predate both the review-pass and remediation ledger writes.
    rmSync(prRoundLedgerPath(rootDir, { repo: REPO, prNumber: PR }));
    assert.equal(summarizePRRemediationLedger(rootDir, { repo: REPO, prNumber: PR }).prRoundLedger, undefined);
    const before = buildPrRoundLedgerView(rootDir, { repo: REPO, prNumber: PR });
    assert.equal(before.budget, budget);
    assert.equal(before.budgetReached, true);
    assert.match(before.summary, new RegExp(`^${budget} of ${budget} remediation rounds used`, 'u'));
    const out = capture();
    assert.equal(ledgerCliMain(['record', '--repo', REPO, '--pr', String(PR), '--kind', 'hq-pr-update',
      '--round-id', 'hq:legacy-update', '--root-dir', rootDir], { stdout: out, stderr: capture() }), 0);
    assert.equal(JSON.parse(out.text()).chargedTo, CHARGED_TO.OPERATOR);
    assert.equal(readPrRoundLedger(rootDir, { repo: REPO, prNumber: PR })[0].chargedTo, CHARGED_TO.OPERATOR);
  });
}

for (const record of [recordHammerRetryDispatch, reserveHammerRepairDispatch]) {
  test(`${record.name} records and refunds the hammer round in its own domain`, () => {
    const rootDir = tmpRoot();
    const identity = { domainId: 'synthetic-domain', repo: REPO, prNumber: PR };
    const options = { dispatchKey: 'domain-key', launchRequestId: 'domain-launch', jobKey: 'review', headSha: 'head' };
    record(rootDir, identity, options);
    const entries = readPrRoundLedger(rootDir, identity);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].domainId, identity.domainId);
    assert.equal(entries[0].voided, false);
    assert.deepEqual(readPrRoundLedger(rootDir, { repo: REPO, prNumber: PR }), []);
    // Refund recovery can have only the launch ID, without its dispatch key.
    const { dispatchKey: _dispatchKey, ...refundOptions } = options;
    assert.equal(refundUnexecutedHammerDispatch(rootDir, identity, { ...refundOptions,
      executionVerdict: noWorkVerdict(options.launchRequestId) }).refunded, true);
    assert.equal(readPrRoundLedger(rootDir, identity)[0].voided, true);
    assert.deepEqual(readPrRoundLedger(rootDir, { repo: REPO, prNumber: PR }), []);
  });
}

test('an HQ PR-update and an operator retrigger are recorded and counted; the retrigger is operator-charged', () => {
  const rootDir = tmpRoot();
  const out = capture();
  const rc = ledgerCliMain(['record', '--repo', REPO, '--pr', String(PR), '--kind', 'hq-pr-update',
    '--round-id', 'hq-pr-update:lrq_synthetic_1', '--head-sha', HEAD(3), '--root-dir', rootDir], { stdout: out, stderr: capture() });
  assert.equal(rc, 0);
  assert.equal(JSON.parse(out.text()).chargedTo, CHARGED_TO.PIPELINE);
  // Re-recording the same update is the same round.
  ledgerCliMain(['record', '--repo', REPO, '--pr', String(PR), '--kind', 'hq-pr-update',
    '--round-id', 'hq-pr-update:lrq_synthetic_1', '--root-dir', rootDir], { stdout: capture(), stderr: capture() });
  // A caller cannot record a retrigger as free.
  const retrigger = recordPrRound(rootDir, { repo: REPO, prNumber: PR, roundId: 'operator-retrigger:key-1',
    kind: PR_ROUND_KINDS.OPERATOR_RETRIGGER, chargedTo: CHARGED_TO.PIPELINE });
  assert.equal(retrigger.entry.chargedTo, CHARGED_TO.OPERATOR);

  const summary = summarizePrRoundLedger(rootDir, { repo: REPO, prNumber: PR }, { budget: 2 });
  assert.equal(summary.remediationRoundsUsed, 1);
  assert.equal(summary.reviewPasses, 1);
  assert.equal(summary.operatorCharged, 1);
  assert.deepEqual(summary.byKind, { 'hq-pr-update': 1, 'operator-retrigger': 1 });
  assert.equal(formatPrRoundLedgerSummary(summary),
    '1 of 2 remediation rounds used · 1 review passes · 1 operator-charged (hq-pr-update 1, operator-retrigger 1)');
  // The watcher and the follow-up daemon read the HQ round through the shared summary.
  assert.equal(summarizePRRemediationLedger(rootDir, { repo: REPO, prNumber: PR }).completedRoundsForPR, 1);

  // The CLI only accepts producers that have no in-repo recorder.
  assert.equal(ledgerCliMain(['record', '--repo', REPO, '--pr', String(PR), '--kind', 'hammer',
    '--round-id', 'x', '--root-dir', rootDir], { stdout: capture(), stderr: capture() }), 64);
});

test('the budget stops automatic rounds once other producers spend it, and the closure path still runs', () => {
  const rootDir = tmpRoot();
  createJob(rootDir, { revisionRef: HEAD(1), reviewPostedAt: '2026-01-01T00:00:00.000Z' });
  runRound(rootDir, '2026-01-01T01:00:00.000Z', '2026-01-01T02:00:00.000Z');
  // The next follow-up job is queued with one settled round (seed 1 of 2)...
  createJob(rootDir, { revisionRef: HEAD(2), reviewPostedAt: '2026-01-02T00:00:00.000Z',
    priorCompletedRounds: summarizePRRemediationLedger(rootDir, { repo: REPO, prNumber: PR }).completedRoundsForPR });
  // ...then an in-place HQ PR-update spends the second round before it is claimed.
  recordPrRound(rootDir, { repo: REPO, prNumber: PR, roundId: 'hq-pr-update:lrq_synthetic_2',
    kind: PR_ROUND_KINDS.HQ_PR_UPDATE, headSha: HEAD(3), recordedAt: '2026-01-02T00:30:00.000Z' });

  const stopped = claimNextFollowUpJob({ rootDir, claimedAt: '2026-01-02T01:00:00.000Z', returnStopped: true });
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.reason, 'max-rounds-reached');
  assert.equal(stopped.job.remediationPlan.stop.code, 'max-rounds-reached');
  assert.match(stopped.job.remediationPlan.stopReason, /\(2\/2\)/u);
  assert.match(stopped.job.remediationPlan.stopReason, /PR round ledger: 2 of 2 remediation rounds used/u);
  assert.equal(stopped.finalCapResult, undefined, 'a budget stop is the hammer hand-off, not an operator rescue');

  // The closure path the budget hands to is not blocked, and its comment is
  // numbered PR-wide instead of "round 1 of 1".
  createJob(rootDir, { revisionRef: HEAD(3), reviewPostedAt: '2026-01-03T00:00:00.000Z',
    closureHandoff: { reason: 'final-fix-all', headSha: HEAD(3) } });
  const closure = claimNextFollowUpJob({ rootDir, claimedAt: '2026-01-03T01:00:00.000Z', returnStopped: true });
  assert.ok(closure && !closure.stopped);
  assert.equal(closure.job.remediationPlan.currentRound, 1);
  assert.equal(closure.job.remediationPlan.prRound.kind, PR_ROUND_KINDS.FINAL_FIX_ALL);
  assert.equal(closure.job.remediationPlan.prRound.chargedTo, CHARGED_TO.PIPELINE);
  assert.equal(header(closure.job), '## Remediation Worker (codex) — round 3 of 2');
  const body = buildRemediationOutcomeCommentBody({ workerClass: 'codex', action: 'completed', job: closure.job,
    reReview: { status: 'pending', requested: true } });
  assert.match(body, /> Round ledger: `?3 of 2 remediation rounds used · \d+ review passes \(.*final-fix-all 1.*hq-pr-update 1/u);
});

test('an operator-authorized round past the budget still runs and is charged to the operator', () => {
  const rootDir = tmpRoot();
  recordPrRound(rootDir, { repo: REPO, prNumber: PR, roundId: 'hq-pr-update:a', kind: PR_ROUND_KINDS.HQ_PR_UPDATE });
  recordPrRound(rootDir, { repo: REPO, prNumber: PR, roundId: 'hq-pr-update:b', kind: PR_ROUND_KINDS.HQ_PR_UPDATE });
  const { jobPath, job } = createJob(rootDir, { revisionRef: HEAD(4), reviewPostedAt: '2026-01-04T00:00:00.000Z',
    priorCompletedRounds: 2 });
  // An operator retrigger-remediation: one more round, explicitly authorized.
  writeFollowUpJob(jobPath, { ...job, remediationPlan: { ...job.remediationPlan, maxRounds: 3,
    nextAction: { ...job.remediationPlan.nextAction, operatorOverride: true } } });
  const claimed = claimNextFollowUpJob({ rootDir, claimedAt: '2026-01-04T01:00:00.000Z', returnStopped: true });
  assert.ok(claimed && !claimed.stopped);
  assert.equal(claimed.job.remediationPlan.prRound.chargedTo, CHARGED_TO.OPERATOR);
  assert.match(header(claimed.job), /round 3 of 3 \(operator-charged\)$/u);
  spawnClaimed(claimed, '2026-01-04T01:00:00.000Z');
  const entry = readPrRoundLedger(rootDir, { repo: REPO, prNumber: PR }).find(item => item.jobId === job.jobId
    && item.class === 'remediation');
  assert.equal(entry.chargedTo, CHARGED_TO.OPERATOR);
});

test('retrigger-review past budget runs, is operator-charged in the ledger and the audit, and a refusal voids it', async () => {
  const rootDir = tmpRoot();
  recordPrRound(rootDir, { repo: REPO, prNumber: PR, roundId: 'hq-pr-update:a', kind: PR_ROUND_KINDS.HQ_PR_UPDATE });
  recordPrRound(rootDir, { repo: REPO, prNumber: PR, roundId: 'hq-pr-update:b', kind: PR_ROUND_KINDS.HQ_PR_UPDATE });
  const deps = (result) => ({
    stdout: capture(),
    stderr: capture(),
    readReviewRow: () => ({ pr_state: 'open', review_status: 'posted', revision_ref: HEAD(5), reviewer_head_sha: HEAD(5) }),
    latestJobFinder: () => null,
    fetchCurrentHeadShaImpl: async () => HEAD(5),
    rereview: () => result,
  });
  const ok = deps({ triggered: true, status: 'pending' });
  const rc = await retriggerReviewMain(['--repo', REPO, '--pr', String(PR), '--reason', 'synthetic recheck',
    '--root-dir', rootDir, '--audit-root-dir', rootDir, '--exact-head-now', '--no-bump-budget'], ok);
  assert.equal(rc, 0, ok.stderr.text());
  const row = JSON.parse(ok.stdout.text());
  assert.equal(row.prRoundLedger.chargedTo, CHARGED_TO.OPERATOR);
  assert.equal(row.prRoundLedger.overBudget, true);
  assert.match(ok.stderr.text(), /past its round budget \(2\/2\); this retrigger is operator-charged/u);
  const retriggers = () => readPrRoundLedger(rootDir, { repo: REPO, prNumber: PR })
    .filter(entry => entry.kind === PR_ROUND_KINDS.OPERATOR_RETRIGGER);
  assert.equal(retriggers().length, 1);
  assert.equal(retriggers()[0].chargedTo, CHARGED_TO.OPERATOR);

  const refused = deps({ triggered: false, status: 'blocked', reason: 'synthetic-refusal' });
  const rc2 = await retriggerReviewMain(['--repo', REPO, '--pr', String(PR), '--reason', 'second synthetic recheck',
    '--root-dir', rootDir, '--audit-root-dir', rootDir, '--no-bump-budget'], refused);
  assert.notEqual(rc2, 0);
  assert.equal(retriggers().filter(entry => !entry.voided).length, 1, 'a refused retrigger is not charged');
});

test('a transient requeue voids its round and the re-spawn charges it once', () => {
  const rootDir = tmpRoot();
  createJob(rootDir, { revisionRef: HEAD(6), reviewPostedAt: '2026-01-06T00:00:00.000Z' });
  const claimed = claimNextFollowUpJob({ rootDir, claimedAt: '2026-01-06T01:00:00.000Z' });
  const spawned = markFollowUpJobSpawned({ jobPath: claimed.jobPath, spawnedAt: '2026-01-06T01:00:00.000Z',
    worker: { processId: 1, state: 'spawned', workspaceDir: 'workspace', dispatchMode: 'hq' } });
  requeueInProgressFollowUpJobForRetry({ rootDir, jobPath: spawned.jobPath, requeuedAt: '2026-01-06T01:05:00.000Z',
    retryAfterOverride: '2026-01-06T01:05:00.000Z' });
  const live = () => readPrRoundLedger(rootDir, { repo: REPO, prNumber: PR })
    .filter(entry => entry.class === 'remediation' && !entry.voided);
  assert.equal(live().length, 0);
  const again = claimNextFollowUpJob({ rootDir, claimedAt: '2026-01-06T02:00:00.000Z' });
  assert.equal(again.job.remediationPlan.currentRound, 1);
  spawnClaimed(again, '2026-01-06T02:00:00.000Z');
  assert.equal(live().length, 1);
});

test('voidPrRound is a no-op for an unknown round and the reader skips torn lines', () => {
  const rootDir = tmpRoot();
  assert.deepEqual(voidPrRound(rootDir, { repo: REPO, prNumber: PR, roundId: 'missing' }), { voided: false });
  assert.throws(() => recordPrRound(rootDir, { repo: REPO, prNumber: PR, roundId: 'x', kind: 'bogus' }), /unknown round kind/u);
  assert.throws(() => recordPrRound(rootDir, { repo: REPO, prNumber: 0, roundId: 'x', kind: PR_ROUND_KINDS.HAMMER }),
    /positive prNumber/u);
  recordPrRound(rootDir, { repo: REPO, prNumber: PR, roundId: 'hammer:dispatch:k1', kind: PR_ROUND_KINDS.HAMMER });
  appendFileSync(prRoundLedgerPath(rootDir, { repo: REPO, prNumber: PR }), '{"roundId":"torn\n');
  recordPrRound(rootDir, { repo: REPO, prNumber: PR, roundId: 'hammer:dispatch:k2', kind: PR_ROUND_KINDS.HAMMER });
  assert.deepEqual(readPrRoundLedger(rootDir, { repo: REPO, prNumber: PR }, { logger: null }).map(entry => entry.roundId),
    ['hammer:dispatch:k1', 'hammer:dispatch:k2']);
});

test('voidPrRound normalizes round IDs exactly as the recorder does', () => {
  const rootDir = tmpRoot();
  const identity = { repo: REPO, prNumber: PR };
  for (const roundId of ['  hammer:whitespace  ', `hammer:${'x'.repeat(350)}  `]) {
    const { entry } = recordPrRound(rootDir, { ...identity, roundId, kind: PR_ROUND_KINDS.HAMMER });
    assert.deepEqual(voidPrRound(rootDir, { ...identity, roundId }), { voided: true });
    assert.equal(readPrRoundLedger(rootDir, identity).find(row => row.roundId === entry.roundId).voided, true);
    assert.deepEqual(voidPrRound(rootDir, { ...identity, roundId }), { voided: false });
  }
  assert.deepEqual(voidPrRound(rootDir, { ...identity, roundId: '  ' }), { voided: false });
  assert.equal(summarizePrRoundLedger(rootDir, identity).remediationRoundsUsed, 0);
});
