// SINGLEREVIEW-01: a super-small PR gets one review round, then the hammer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  archiveStoppedFollowUpJobs,
  claimNextFollowUpJob,
  createFollowUpJob,
  getFollowUpJobDir,
  isSingleReviewJob,
  isSingleReviewStop,
  readSingleReviewVoid,
  summarizePRRemediationLedger,
} from '../src/follow-up-jobs.mjs';
import { terminalHammerReviewCycleExhausted } from '../src/ama/dispatch-closer.mjs';
import { reviewCycleExhaustedFromRounds } from '../src/review-ceiling-metrics.mjs';
import { pickReviewerStage } from '../src/kernel/prompt-stage.mjs';
import { selectReviewMode, selectSingleReview } from '../src/review-mode-selection.mjs';
import { readSingleReviewDecision, recordReviewModeSelected } from '../src/review-mode-latency.mjs';
import { queueFollowUpForRecoveredPostedReview } from '../src/reviewer-pass-reaper.mjs';
import { SINGLE_REVIEW_DEFAULTS } from '../src/super-small-classifier.mjs';
import { FORCE_FULL_REVIEW_LABEL } from '../src/slim-review-eligibility.mjs';
import { __test__ as reviewerInternals } from '../src/reviewer.mjs';

const { queueFollowUpForPostedReview } = reviewerInternals;

const REPO = 'laceyenterprises/agent-os';
const PR = 8123;
const HEAD = '5f0e3c1d9a7b6e4f2a1c0d9e8f7a6b5c4d3e2f10';
const SILENT_LOG = { log() {}, warn() {}, error() {} };

const FINDINGS_BODY = [
  '## Summary', 'The parser dereferences a missing field.', '',
  '## Blocking issues',
  '- **Null dereference on an empty comment**',
  '  - **File:** `src/pr-comments.mjs`',
  '  - **Problem:** `body.trim()` throws when the comment body is null.',
  '  - **Recommended fix:** default the body to an empty string.', '',
  '## Non-blocking issues', '- None.', '',
  '## Verdict', 'Request changes',
].join('\n');

const CLEAN_BODY = [
  '## Summary', 'Looks right.', '',
  '## Blocking issues', '- None.', '',
  '## Non-blocking issues', '- None.', '',
  '## Verdict', 'Comment only',
].join('\n');

const APPLIED = { applied: true, superSmall: true, basis: 'small-change', stats: { files: 2, changedLines: 12 } };

function tempRoot(t) {
  const rootDir = mkdtempSync(join(tmpdir(), 'single-review-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  return rootDir;
}

function jobInput(rootDir, overrides = {}) {
  return {
    rootDir, repo: REPO, prNumber: PR, baseBranch: 'main', revisionRef: HEAD, reviewerModel: 'claude',
    reviewBody: FINDINGS_BODY, reviewPostedAt: '2026-09-29T10:00:00.000Z', critical: false, ...overrides,
  };
}

function unifiedDiff(files) {
  return files.map(({ path, added = 0, removed = 0 }) => [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${removed} +1,${added} @@`,
    ...Array.from({ length: removed }, (_, i) => `-old ${i}`),
    ...Array.from({ length: added }, (_, i) => `+new ${i}`),
  ].join('\n')).join('\n') + '\n';
}

const TWELVE_LINE_FIX = unifiedDiff([
  { path: 'src/pr-comments.mjs', added: 5, removed: 3 },
  { path: 'src/verdict-parser.mjs', added: 3, removed: 1 },
]);

function policyImpl(overrides = {}) {
  return () => ({
    ...SINGLE_REVIEW_DEFAULTS,
    slimMaxFiles: 20,
    slimMaxChangedLines: 400,
    deniedPrefixes: [],
    forceFull: false,
    ...overrides,
  });
}

function pick(diff, { promptStage = 'first', labels = [], policy = {} } = {}) {
  const lines = [];
  const decision = selectSingleReview({
    repo: REPO, prNumber: PR, diff, labels, headSha: HEAD, promptStage, env: {},
    resolveSingleReviewPolicyImpl: policyImpl(policy),
    log: { log: (line) => lines.push(line), warn: (line) => lines.push(line) },
  });
  return { decision, lines };
}

// The same chain AMA runs for the terminal Hammer: ledger rounds → cycle
// exhausted → "the remediator had a turn" arming gate.
function terminalHammerArmed(rootDir, { maxRounds, verdict = 'Request changes' }) {
  const ledger = summarizePRRemediationLedger(rootDir, { repo: REPO, prNumber: PR });
  const reviewCycleExhausted = reviewCycleExhaustedFromRounds({
    effectiveRoundBudget: maxRounds,
    completedRemediationRounds: ledger.completedRoundsForPR,
    completedRereviewRounds: 0,
  });
  return {
    ledger,
    armed: terminalHammerReviewCycleExhausted({
      verdict,
      reviewCycleExhausted,
      remediationPending: false,
      completedRemediationRounds: ledger.completedRoundsForPR,
    }),
  };
}

test('a 12-line fix on 2 files: one review, findings hand to the hammer with no remediation or re-review', (t) => {
  const rootDir = tempRoot(t);
  const { decision, lines } = pick(TWELVE_LINE_FIX);
  assert.equal(decision.applied, true);
  assert.match(lines.join('\n'), /single-review: super-small laceyenterprises\/agent-os#8123 super-small \(small-change; 2 file\(s\), 12 changed line\(s\)\).*prompt stage=last/);

  const queued = queueFollowUpForPostedReview({
    rootDir, repo: REPO, prNumber: PR, baseBranch: 'main', reviewerModel: 'claude', revisionRef: HEAD,
    reviewText: FINDINGS_BODY, reviewPostedAt: '2026-09-29T10:00:00.000Z', singleReview: decision,
    resolveHandoffConfigImpl: () => ({ enabled: false }),
  });
  assert.equal(queued.queued, true);
  const created = createdJob(rootDir);
  const maxRounds = created.remediationPlan.maxRounds;
  assert.ok(maxRounds > 0);
  // Born with the tier budget spent; the decision is recorded on the job.
  assert.equal(created.remediationPlan.currentRound, maxRounds);
  assert.equal(created.singleReview.applied, true);
  assert.equal(created.singleReview.basis, 'small-change');
  assert.equal(isSingleReviewJob(created), true);

  const claimed = claimNextFollowUpJob({ rootDir, claimedAt: '2026-09-29T10:01:00.000Z', launcherPid: 4242, returnStopped: true });
  assert.equal(claimed.stopped, true);
  assert.equal(claimed.reason, 'max-rounds-reached');
  assert.equal(claimed.job.remediationPlan.stop.code, 'max-rounds-reached');
  assert.match(claimed.job.remediationPlan.stop.reason, /^single-review: super-small PR; the first review was the final round \(small-change\)/);
  assert.equal(claimed.job.remediationWorker ?? null, null);
  assert.equal(isSingleReviewStop(claimed.job), true);
  assert.equal(claimNextFollowUpJob({ rootDir, claimedAt: '2026-09-29T10:02:00.000Z' }), null);

  // The ledger counts the budget as spent, so the terminal Hammer arms...
  const { ledger, armed } = terminalHammerArmed(rootDir, { maxRounds });
  assert.equal(ledger.completedRoundsForPR, maxRounds);
  assert.deepEqual(ledger.completedRemediationRevisionRefs ?? [], []);
  assert.equal(armed, true);
  // ...and a later author push is reviewed once at the final bar, never as a
  // fresh first review with a new budget.
  assert.equal(pickReviewerStage({
    reviewAttemptNumber: ledger.completedRoundsForPR + 1,
    completedRemediationRounds: ledger.completedRoundsForPR,
    maxRemediationRounds: maxRounds,
  }), 'last');
});

test('the same findings without single review take normal rounds', (t) => {
  const rootDir = tempRoot(t);
  const created = createFollowUpJob(jobInput(rootDir));
  assert.equal(created.job.remediationPlan.currentRound, 0);
  assert.equal(created.job.singleReview, undefined);
  const claimed = claimNextFollowUpJob({ rootDir, claimedAt: '2026-09-29T10:01:00.000Z', launcherPid: 4242, returnStopped: true });
  assert.ok(claimed);
  assert.notEqual(claimed.stopped, true);
  assert.equal(claimed.job.status, 'in_progress');
  assert.equal(claimed.job.remediationPlan.currentRound, 1);
  const { ledger, armed } = terminalHammerArmed(rootDir, { maxRounds: created.job.remediationPlan.maxRounds });
  assert.equal(ledger.completedRoundsForPR, 0);
  assert.equal(armed, false);
});

test('a clean single review takes the normal clean path and spends no rounds', (t) => {
  const rootDir = tempRoot(t);
  createFollowUpJob(jobInput(rootDir, { reviewBody: CLEAN_BODY, singleReview: APPLIED }));
  const claimed = claimNextFollowUpJob({ rootDir, claimedAt: '2026-09-29T10:01:00.000Z', launcherPid: 4242, returnStopped: true });
  assert.equal(claimed.stopped, true);
  assert.equal(claimed.reason, 'no-remediation-required');
  assert.equal(isSingleReviewStop(claimed.job), false);
  assert.equal(summarizePRRemediationLedger(rootDir, { repo: REPO, prNumber: PR }).completedRoundsForPR, 0);
});

test('an unapplied single-review record leaves the job on normal rounds', (t) => {
  const rootDir = tempRoot(t);
  const created = createFollowUpJob(jobInput(rootDir, { singleReview: { ...APPLIED, applied: false } }));
  assert.equal(created.job.remediationPlan.currentRound, 0);
  assert.equal(created.job.singleReview, undefined);
});

test('a 300-line docs-only PR gets one review', () => {
  const { decision } = pick(unifiedDiff([
    { path: 'docs/RUNBOOK-ama-closure.md', added: 240, removed: 20 },
    { path: 'README.md', added: 40, removed: 0 },
  ]));
  assert.equal(decision.applied, true);
  assert.equal(decision.basis, 'docs-tests');
});

test('gate-keeper, oversized, migration and force-full PRs get normal rounds', () => {
  const cases = {
    'a 10-line change to src/watcher.mjs': pick(unifiedDiff([{ path: 'src/watcher.mjs', added: 6, removed: 4 }])),
    'a 60-line code change': pick(unifiedDiff([{ path: 'src/pr-comments.mjs', added: 40, removed: 20 }])),
    'a migration': pick(unifiedDiff([{ path: 'platform/db/alembic/versions/20260929_add_col.py', added: 8 }])),
    'the force-full label': pick(TWELVE_LINE_FIX, { labels: [{ name: FORCE_FULL_REVIEW_LABEL }] }),
    'enabled=false': pick(TWELVE_LINE_FIX, { policy: { enabled: false } }),
  };
  for (const [name, { decision, lines }] of Object.entries(cases)) {
    assert.equal(decision.applied, false, name);
    assert.equal(decision.superSmall, false, name);
    assert.deepEqual(lines, [], name);
  }
});

test('single review applies only to what would be the first review', () => {
  const { decision, lines } = pick(TWELVE_LINE_FIX, { promptStage: 'middle' });
  assert.equal(decision.superSmall, true);
  assert.equal(decision.applied, false);
  assert.deepEqual(decision.reasons, [{ code: 'not-first-review', promptStage: 'middle' }]);
  assert.match(lines.join('\n'), /not applied — prompt stage=middle/);
});

test('selectReviewMode runs a super-small first review at the last stage and leaves others alone', () => {
  const base = {
    rootDir: '/nonexistent-root', repo: REPO, prNumber: PR, headSha: HEAD, attemptNumber: 1, env: {},
    recordReviewModeSelectedImpl: () => ({ recorded: false }), log: SILENT_LOG,
  };
  const single = selectReviewMode({ ...base, diff: TWELVE_LINE_FIX, promptStage: 'first', resolveSingleReviewPolicyImpl: policyImpl() });
  assert.equal(single.singleReview.applied, true);
  assert.equal(single.promptStage, 'last');

  const disabled = selectReviewMode({ ...base, diff: TWELVE_LINE_FIX, promptStage: 'first', resolveSingleReviewPolicyImpl: policyImpl({ enabled: false }) });
  assert.equal(disabled.singleReview.applied, false);
  assert.equal(disabled.promptStage, 'first');

  const watcher = selectReviewMode({
    ...base, diff: unifiedDiff([{ path: 'src/watcher.mjs', added: 6, removed: 4 }]),
    promptStage: 'first', resolveSingleReviewPolicyImpl: policyImpl(),
  });
  assert.equal(watcher.singleReview.applied, false);
  assert.equal(watcher.promptStage, 'first');

  const throwing = selectReviewMode({
    ...base, diff: TWELVE_LINE_FIX, promptStage: 'first',
    resolveSingleReviewPolicyImpl: () => { throw new Error('policy exploded'); },
  });
  assert.equal(throwing.singleReview.applied, false);
  assert.deepEqual(throwing.singleReview.reasons, [{ code: 'classification-failed' }]);
  assert.equal(throwing.promptStage, 'first');
});

test('the single-review decision round-trips through the review-mode row, keyed by head and attempt', (t) => {
  const rootDir = tempRoot(t);
  const decision = selectReviewMode({
    rootDir, repo: REPO, prNumber: PR, diff: TWELVE_LINE_FIX, headSha: HEAD, attemptNumber: 1,
    promptStage: 'first', env: {}, resolveSingleReviewPolicyImpl: policyImpl(), log: SILENT_LOG,
    recordReviewModeSelectedImpl: recordReviewModeSelected,
  });
  assert.equal(decision.singleReview.applied, true);
  const read = (overrides = {}) => readSingleReviewDecision({ rootDir, repo: REPO, prNumber: PR, headSha: HEAD, attemptNumber: 1, log: SILENT_LOG, ...overrides });
  assert.deepEqual(read(), { applied: true, basis: 'small-change', stats: decision.singleReview.stats });
  assert.equal(read({ attemptNumber: 2 }), null);
  assert.equal(read({ headSha: 'other-head' }), null);

  const emptyRoot = tempRoot(t);
  assert.equal(readSingleReviewDecision({ rootDir: emptyRoot, repo: REPO, prNumber: PR, headSha: HEAD, attemptNumber: 1 }), null);
  assert.equal(existsSync(join(emptyRoot, 'data', 'reviews.db')), false);
});

test('the reviewer-pass reaper carries the dead reviewer\'s single-review decision onto the job', (t) => {
  const rootDir = tempRoot(t);
  const reads = [];
  const reaped = queueFollowUpForRecoveredPostedReview({
    rootDir,
    row: {
      repo: REPO, pr_number: PR, head_sha: HEAD, attempt_number: 1, body_md: FINDINGS_BODY,
      reviewer_model: 'claude', ended_at: '2026-09-29T10:00:00.000Z', metadata_json: '{}',
    },
    reviewPostedAt: '2026-09-29T10:00:00.000Z',
    resolveHandoffConfigImpl: () => ({ enabled: false }),
    readSingleReviewDecisionImpl: (args) => { reads.push(args); return { applied: true, basis: 'small-change', stats: null }; },
  });
  assert.equal(reaped.queued, true);
  assert.deepEqual(reads.map(({ headSha, attemptNumber }) => ({ headSha, attemptNumber })), [{ headSha: HEAD, attemptNumber: 1 }]);
  const job = createdJob(rootDir);
  assert.equal(job.singleReview.applied, true);
  assert.equal(job.remediationPlan.currentRound, job.remediationPlan.maxRounds);
});

test('a later head that grows into a gate-keeper path voids the single-review credit and gets its budget back', (t) => {
  const rootDir = tempRoot(t);
  createFollowUpJob(jobInput(rootDir, { singleReview: APPLIED }));
  const stopped = claimNextFollowUpJob({ rootDir, claimedAt: '2026-09-29T10:01:00.000Z', launcherPid: 4242, returnStopped: true });
  assert.equal(isSingleReviewStop(stopped.job), true);
  const maxRounds = stopped.job.remediationPlan.maxRounds;
  const spent = summarizePRRemediationLedger(rootDir, { repo: REPO, prNumber: PR });
  assert.equal(spent.completedRoundsForPR, maxRounds);
  assert.deepEqual(spent.singleReviewStopJobIds, [stopped.job.jobId]);

  // The author pushes a gate-keeper change. The watcher stages that head as
  // the owed post-budget review (`last`); the reviewer re-classifies it.
  const laterHead = 'a'.repeat(40);
  const stageContext = { reviewAttemptNumber: 2, maxRemediationRounds: maxRounds };
  const base = {
    rootDir, repo: REPO, prNumber: PR, headSha: laterHead, attemptNumber: 2, env: {},
    recordReviewModeSelectedImpl: () => ({ recorded: false }), resolveSingleReviewPolicyImpl: policyImpl(),
    log: SILENT_LOG, stageContext,
  };
  const grown = selectReviewMode({
    ...base,
    diff: unifiedDiff([
      { path: 'src/pr-comments.mjs', added: 5, removed: 3 },
      { path: 'src/watcher.mjs', added: 2, removed: 1 },
    ]),
    promptStage: 'last',
  });
  assert.equal(grown.singleReview.applied, false);
  assert.equal(grown.singleReview.voided.voided, true);
  assert.deepEqual(grown.singleReview.voided.jobIds, [stopped.job.jobId]);
  assert.equal(grown.promptStage, 'first');

  const ledger = summarizePRRemediationLedger(rootDir, { repo: REPO, prNumber: PR });
  assert.equal(ledger.completedRoundsForPR, 0);
  assert.deepEqual(ledger.singleReviewStopJobIds, []);
  assert.equal(readSingleReviewVoid(rootDir, { repo: REPO, prNumber: PR }).history[0].headSha, laterHead);
  assert.equal(terminalHammerArmed(rootDir, { maxRounds }).armed, false);

  // The follow-up for that review gets the full tier budget.
  const queued = queueFollowUpForPostedReview({
    rootDir, repo: REPO, prNumber: PR, baseBranch: 'main', reviewerModel: 'claude', revisionRef: laterHead,
    reviewText: FINDINGS_BODY, reviewPostedAt: '2026-09-29T11:00:00.000Z', singleReview: grown.singleReview,
    resolveHandoffConfigImpl: () => ({ enabled: false }),
  });
  assert.equal(queued.queued, true);
  const next = claimNextFollowUpJob({ rootDir, claimedAt: '2026-09-29T11:01:00.000Z', launcherPid: 4242, returnStopped: true });
  assert.notEqual(next.stopped, true);
  assert.equal(next.job.remediationPlan.currentRound, 1);
});

test('a later head that is still super-small keeps the budget spent; a first review never voids', (t) => {
  const rootDir = tempRoot(t);
  createFollowUpJob(jobInput(rootDir, { singleReview: APPLIED }));
  claimNextFollowUpJob({ rootDir, claimedAt: '2026-09-29T10:01:00.000Z', launcherPid: 4242, returnStopped: true });
  const voids = [];
  const voidSingleReviewCreditImpl = (args) => { voids.push(args); return { voided: false }; };
  const still = selectReviewMode({
    rootDir, repo: REPO, prNumber: PR, headSha: HEAD, attemptNumber: 2, env: {}, diff: TWELVE_LINE_FIX,
    promptStage: 'last', recordReviewModeSelectedImpl: () => ({ recorded: false }),
    resolveSingleReviewPolicyImpl: policyImpl(), voidSingleReviewCreditImpl, log: SILENT_LOG,
    stageContext: { reviewAttemptNumber: 2, maxRemediationRounds: 3 },
  });
  assert.equal(still.promptStage, 'last');
  assert.equal(still.singleReview.voided, undefined);
  selectReviewMode({
    rootDir, repo: REPO, prNumber: PR, headSha: HEAD, attemptNumber: 1, env: {},
    diff: unifiedDiff([{ path: 'src/watcher.mjs', added: 2 }]),
    promptStage: 'first', recordReviewModeSelectedImpl: () => ({ recorded: false }),
    resolveSingleReviewPolicyImpl: policyImpl(), voidSingleReviewCreditImpl, log: SILENT_LOG,
  });
  assert.deepEqual(voids, []);
  assert.ok(summarizePRRemediationLedger(rootDir, { repo: REPO, prNumber: PR }).completedRoundsForPR > 0);
});

test('a single-review job created after a void spends budget again', (t) => {
  const rootDir = tempRoot(t);
  createFollowUpJob(jobInput(rootDir, { singleReview: APPLIED }));
  claimNextFollowUpJob({ rootDir, claimedAt: '2026-09-29T10:01:00.000Z', launcherPid: 4242, returnStopped: true });
  selectReviewMode({
    rootDir, repo: REPO, prNumber: PR, headSha: 'b'.repeat(40), attemptNumber: 2, env: {},
    diff: unifiedDiff([{ path: 'src/watcher.mjs', added: 2 }]), promptStage: 'last',
    recordReviewModeSelectedImpl: () => ({ recorded: false }), resolveSingleReviewPolicyImpl: policyImpl(), log: SILENT_LOG,
  });
  assert.equal(summarizePRRemediationLedger(rootDir, { repo: REPO, prNumber: PR }).completedRoundsForPR, 0);
  const later = new Date(Date.now() + 60_000).toISOString();
  createFollowUpJob(jobInput(rootDir, { revisionRef: 'c'.repeat(40), reviewPostedAt: later, singleReview: APPLIED }));
  const stopped = claimNextFollowUpJob({ rootDir, claimedAt: later, launcherPid: 4242, returnStopped: true });
  assert.equal(isSingleReviewStop(stopped.job), true);
  assert.equal(
    summarizePRRemediationLedger(rootDir, { repo: REPO, prNumber: PR }).completedRoundsForPR,
    stopped.job.remediationPlan.maxRounds,
  );
});

test('the stopped-job archive sweep does not hand a single-review PR its spent budget back', (t) => {
  const rootDir = tempRoot(t);
  createFollowUpJob(jobInput(rootDir, { singleReview: APPLIED }));
  const stopped = claimNextFollowUpJob({ rootDir, claimedAt: '2026-09-29T10:01:00.000Z', launcherPid: 4242, returnStopped: true });
  const maxRounds = stopped.job.remediationPlan.maxRounds;
  const before = summarizePRRemediationLedger(rootDir, { repo: REPO, prNumber: PR });
  assert.equal(before.completedRoundsForPR, maxRounds);
  assert.equal(terminalHammerArmed(rootDir, { maxRounds }).armed, true);

  const swept = archiveStoppedFollowUpJobs({ rootDir, nowMs: Date.parse('2026-10-01T00:00:00.000Z') });
  assert.equal(swept.archived, 1);
  assert.deepEqual(readdirSync(getFollowUpJobDir(rootDir, 'stopped')).filter((name) => name.endsWith('.json')), []);

  const after = summarizePRRemediationLedger(rootDir, { repo: REPO, prNumber: PR });
  assert.equal(after.completedRoundsForPR, maxRounds);
  assert.deepEqual(after.singleReviewStopJobIds, [stopped.job.jobId]);
  assert.deepEqual(after.completedRoundTimestamps, before.completedRoundTimestamps);
  assert.equal(terminalHammerArmed(rootDir, { maxRounds }).armed, true);

  // The void still reaches an archived stop.
  const grown = selectReviewMode({
    rootDir, repo: REPO, prNumber: PR, headSha: 'd'.repeat(40), attemptNumber: 2, env: {},
    diff: unifiedDiff([{ path: 'src/watcher.mjs', added: 2 }]), promptStage: 'last',
    recordReviewModeSelectedImpl: () => ({ recorded: false }), resolveSingleReviewPolicyImpl: policyImpl(), log: SILENT_LOG,
    stageContext: { reviewAttemptNumber: 2, maxRemediationRounds: maxRounds },
  });
  assert.deepEqual(grown.singleReview.voided.jobIds, [stopped.job.jobId]);
  assert.equal(summarizePRRemediationLedger(rootDir, { repo: REPO, prNumber: PR }).completedRoundsForPR, 0);
});

test('a void that cannot be written is retried, then fails the pass instead of keeping the lenient stage', () => {
  const calls = [];
  const sleeps = [];
  const base = {
    rootDir: '/nonexistent-single-review-root', repo: REPO, prNumber: PR, headSha: 'e'.repeat(40), attemptNumber: 2, env: {},
    diff: unifiedDiff([{ path: 'src/watcher.mjs', added: 2 }]), promptStage: 'last',
    recordReviewModeSelectedImpl: () => ({ recorded: false }), resolveSingleReviewPolicyImpl: policyImpl(),
    sleepImpl: (ms) => sleeps.push(ms), log: SILENT_LOG,
    stageContext: { reviewAttemptNumber: 2, maxRemediationRounds: 3 },
  };
  const failed = selectReviewMode({
    ...base,
    voidSingleReviewCreditImpl: () => { calls.push('void'); throw new Error('EROFS: read-only file system'); },
  });
  assert.equal(calls.length, 3);
  assert.equal(sleeps.length, 2);
  assert.match(failed.singleReview.voidFailed.error, /EROFS/);
  assert.equal(failed.singleReview.voided, undefined);

  // A transient failure that clears on retry voids normally.
  let attempts = 0;
  const recovered = selectReviewMode({
    ...base,
    voidSingleReviewCreditImpl: () => {
      attempts += 1;
      if (attempts === 1) throw new Error('EBUSY');
      return { voided: true, jobIds: ['j'], previousCompletedRounds: 3, completedRoundsForPR: 0 };
    },
  });
  assert.equal(recovered.singleReview.voidFailed, undefined);
  assert.equal(recovered.singleReview.voided.voided, true);
  assert.equal(recovered.promptStage, 'first');
});

test('a slim-classification failure never applies single review', () => {
  const decision = selectSingleReview({
    repo: REPO, prNumber: PR, diff: TWELVE_LINE_FIX, headSha: HEAD, promptStage: 'first', env: {},
    allowApply: false, resolveSingleReviewPolicyImpl: policyImpl(), log: SILENT_LOG,
  });
  assert.equal(decision.superSmall, true);
  assert.equal(decision.applied, false);
});

function createdJob(rootDir) {
  const dir = getFollowUpJobDir(rootDir, 'pending');
  const [name] = readdirSync(dir).filter((entry) => entry.endsWith('.json'));
  return JSON.parse(readFileSync(join(dir, name), 'utf8'));
}
