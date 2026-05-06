// Integration tests for the per-PR remediation ledger (the durable
// counter that drives final-round verdict-categorization decisions),
// the PR-wide cap enforcement on freshly created follow-up jobs, and
// the legacy `maxRounds` carry-forward behavior.
//
// These tests exist because reviewer-final-round.test.mjs only covers
// the pure helper / string-coercion shape — and that gap is what let
// the original PR ship with `review_attempts` driving the lenient
// threshold (so transient post failures could trip lenient mode) and
// with the watcher passing the global default cap instead of the
// job's persisted maxRounds (so legacy 6-round jobs would have lost
// two rounds of remediation budget mid-deploy).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DEFAULT_MAX_REMEDIATION_ROUNDS,
  buildFollowUpJob,
  claimNextFollowUpJob,
  createFollowUpJob,
  ensureFollowUpJobDirs,
  getFollowUpJobDir,
  markFollowUpJobCompleted,
  markFollowUpJobFailed,
  markFollowUpJobSpawned,
  markFollowUpJobStopped,
  readFollowUpJob,
  summarizePRRemediationLedger,
  writeFollowUpJob,
} from '../src/follow-up-jobs.mjs';
import {
  ADVERSARIAL_PROMPT_FINAL_ROUND_ADDENDUM,
  isFinalReviewRound,
} from '../src/reviewer.mjs';

function makeJobInput(rootDir, overrides = {}) {
  return {
    rootDir,
    repo: 'laceyenterprises/clio',
    prNumber: 7,
    reviewerModel: 'claude',
    linearTicketId: null,
    reviewBody: '## Summary\nPlaceholder.\n\n## Verdict\nRequest changes',
    reviewPostedAt: '2026-04-21T08:00:00.000Z',
    critical: false,
    ...overrides,
  };
}

function runOneRound(rootDir, claimedAt, completedAt) {
  const claimed = claimNextFollowUpJob({ rootDir, claimedAt });
  const spawned = markFollowUpJobSpawned({
    jobPath: claimed.jobPath,
    spawnedAt: claimedAt,
    worker: {
      processId: 8123,
      state: 'spawned',
      workspaceDir: 'workspace',
      outputPath: 'workspace/.adversarial-follow-up/codex-last-message.md',
      logPath: 'workspace/.adversarial-follow-up/codex-worker.log',
      promptPath: 'workspace/.adversarial-follow-up/prompt.md',
    },
  });
  return markFollowUpJobCompleted({
    rootDir,
    jobPath: spawned.jobPath,
    finishedAt: completedAt,
    completionPreview: 'one-round',
    remediationWorker: {
      ...spawned.job.remediationWorker,
      state: 'completed',
    },
    reReview: {
      requested: true,
      status: 'pending',
      reason: 'Findings addressed; please re-review.',
      triggered: true,
      outcomeReason: null,
      reviewRow: null,
      requestedAt: completedAt,
    },
  });
}

test('summarizePRRemediationLedger returns zero counts for a PR with no follow-up jobs yet', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  ensureFollowUpJobDirs(rootDir);
  const ledger = summarizePRRemediationLedger(rootDir, {
    repo: 'laceyenterprises/clio',
    prNumber: 99,
  });
  assert.deepEqual(ledger, {
    completedRoundsForPR: 0,
    latestMaxRounds: null,
    latestRiskClass: 'medium',
    latestJobId: null,
  });
});

test('summarizePRRemediationLedger only counts terminal jobs and isolates by (repo, prNumber)', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));

  // Different PR — must not be counted
  const otherPr = createFollowUpJob(makeJobInput(rootDir, {
    prNumber: 99,
    reviewPostedAt: '2026-04-21T07:00:00.000Z',
  }));
  const otherClaimed = claimNextFollowUpJob({ rootDir, claimedAt: '2026-04-21T07:30:00.000Z' });
  markFollowUpJobCompleted({
    rootDir,
    jobPath: otherClaimed.jobPath,
    finishedAt: '2026-04-21T07:35:00.000Z',
    completionPreview: 'unrelated PR',
  });
  // Sanity: the unrelated job was for prNumber 99
  assert.equal(otherPr.job.prNumber, 99);

  // Pending — must NOT count toward completedRoundsForPR
  createFollowUpJob(makeJobInput(rootDir, {
    prNumber: 7,
    reviewPostedAt: '2026-04-21T08:00:00.000Z',
  }));

  const ledgerWithPending = summarizePRRemediationLedger(rootDir, {
    repo: 'laceyenterprises/clio',
    prNumber: 7,
  });
  assert.equal(ledgerWithPending.completedRoundsForPR, 0);

  // Now consume one round for PR 7 → completed
  runOneRound(rootDir, '2026-04-21T09:00:00.000Z', '2026-04-21T09:05:00.000Z');

  const ledgerAfterOne = summarizePRRemediationLedger(rootDir, {
    repo: 'laceyenterprises/clio',
    prNumber: 7,
  });
  assert.equal(ledgerAfterOne.completedRoundsForPR, 1);
  assert.equal(ledgerAfterOne.latestMaxRounds, DEFAULT_MAX_REMEDIATION_ROUNDS);
});

test('summarizePRRemediationLedger takes max(currentRound) across terminal jobs (currentRound is cumulative, not per-job)', () => {
  // Three sequential remediation cycles. Each new follow-up job is
  // seeded from the PR's prior accumulated count, so the terminal
  // currentRound stamps are 1, 2, 3 — already cumulative. The PR-wide
  // ledger must take the MAX (3), not the SUM (6). Summing would
  // double-count and trip max-rounds-reached after only 2 cycles.
    // Use an explicit 3-round cap so this test exercises the
    // cumulative-round-counting invariant independently of current
    // risk-class defaults.
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));

  for (let i = 1; i <= 3; i += 1) {
    createFollowUpJob(makeJobInput(rootDir, {
      reviewPostedAt: `2026-04-21T0${i}:00:00.000Z`,
      priorCompletedRounds: i - 1,
      maxRemediationRounds: 3,
    }));
    runOneRound(
      rootDir,
      `2026-04-21T0${i}:30:00.000Z`,
      `2026-04-21T0${i}:35:00.000Z`,
    );
  }

  const ledger = summarizePRRemediationLedger(rootDir, {
    repo: 'laceyenterprises/clio',
    prNumber: 7,
  });
  assert.equal(
    ledger.completedRoundsForPR,
    3,
    'three cycles should report 3 consumed rounds (max), not 1+2+3=6 (sum)',
  );
});

test('after 2 completed rounds on a 3-round cap, the next attempt is 3 and a third worker can still claim', () => {
  // Reviewer requested regression: with the buggy sum-of-currentRound
  // accounting, after 2 cycles completedRoundsForPR was 1+2=3. The
  // next adversarial review pass would compute attempt=4, the new
  // job would be seeded with currentRound=3, and claim would
  // immediately stop it as max-rounds-reached — the third remediation
  // worker would never run on a 3-round cap.
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));

  // Round 1
  createFollowUpJob(makeJobInput(rootDir, {
    reviewPostedAt: '2026-04-21T01:00:00.000Z',
    priorCompletedRounds: 0,
    maxRemediationRounds: 3,
  }));
  runOneRound(rootDir, '2026-04-21T01:30:00.000Z', '2026-04-21T01:35:00.000Z');

  // Round 2 — seeded from the now-correctly-reported PR ledger.
  let ledgerAfter1 = summarizePRRemediationLedger(rootDir, {
    repo: 'laceyenterprises/clio',
    prNumber: 7,
  });
  createFollowUpJob(makeJobInput(rootDir, {
    reviewPostedAt: '2026-04-21T02:00:00.000Z',
    priorCompletedRounds: ledgerAfter1.completedRoundsForPR,
    maxRemediationRounds: 3,
  }));
  runOneRound(rootDir, '2026-04-21T02:30:00.000Z', '2026-04-21T02:35:00.000Z');

  // After 2 rounds the ledger must report exactly 2 — not 1+2=3.
  const ledgerAfter2 = summarizePRRemediationLedger(rootDir, {
    repo: 'laceyenterprises/clio',
    prNumber: 7,
  });
  assert.equal(ledgerAfter2.completedRoundsForPR, 2);

  // The next adversarial review pass computes attempt = ledger + 1.
  // With the fix, this is 3 (the third and final round). With the bug
  // it would have been 4 — already past the 3-round cap.
  const reviewAttemptNumber = ledgerAfter2.completedRoundsForPR + 1;
  assert.equal(reviewAttemptNumber, 3, 'attempt must be 3 after 2 cycles, not 4');

  // Reviewer creates the round-3 follow-up job, seeded with the PR's
  // correct prior count.
  createFollowUpJob(makeJobInput(rootDir, {
    reviewPostedAt: '2026-04-21T03:00:00.000Z',
    priorCompletedRounds: ledgerAfter2.completedRoundsForPR,
    maxRemediationRounds: 3,
  }));

  // The third worker MUST be able to claim — the buggy accounting
  // would have tripped max-rounds-reached and stopped the job here.
  const claimResult = claimNextFollowUpJob({
    rootDir,
    claimedAt: '2026-04-21T03:30:00.000Z',
  });
  assert.ok(claimResult, 'third worker must still be claimable on the 3-round cap');
  assert.equal(claimResult.job.status, 'in_progress');
  assert.equal(
    claimResult.job.remediationPlan.currentRound,
    3,
    'claim should bump currentRound to the third (final) round',
  );
});

test('legacy maxRounds=6 PR runs all six actual remediation cycles, not three', () => {
  // Reviewer requested regression: with the buggy sum-of-currentRound
  // accounting, after 3 cycles on a legacy maxRounds=6 PR, the ledger
  // reported 1+2+3=6 — already at the cap — so the loop would stop
  // after only 3 of the 6 budgeted rounds. With the max(currentRound)
  // fix, the ledger reports 3, and rounds 4, 5, 6 can still claim.
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));

  for (let i = 1; i <= 6; i += 1) {
    const ledger = summarizePRRemediationLedger(rootDir, {
      repo: 'laceyenterprises/clio',
      prNumber: 7,
    });
    createFollowUpJob(makeJobInput(rootDir, {
      reviewPostedAt: `2026-04-21T${String(i).padStart(2, '0')}:00:00.000Z`,
      priorCompletedRounds: ledger.completedRoundsForPR,
      maxRemediationRounds: 6,
    }));
    const claimed = claimNextFollowUpJob({
      rootDir,
      claimedAt: `2026-04-21T${String(i).padStart(2, '0')}:30:00.000Z`,
    });
    assert.ok(
      claimed,
      `legacy 6-round PR must claim all six rounds; failed at round ${i}`,
    );
    assert.equal(
      claimed.job.remediationPlan.currentRound,
      i,
      `round ${i} claim should set currentRound to ${i}`,
    );
    const spawned = markFollowUpJobSpawned({
      jobPath: claimed.jobPath,
      spawnedAt: `2026-04-21T${String(i).padStart(2, '0')}:31:00.000Z`,
      worker: {
        processId: 8123 + i,
        state: 'spawned',
        workspaceDir: 'workspace',
        outputPath: 'workspace/.adversarial-follow-up/codex-last-message.md',
        logPath: 'workspace/.adversarial-follow-up/codex-worker.log',
        promptPath: 'workspace/.adversarial-follow-up/prompt.md',
      },
    });
    markFollowUpJobCompleted({
      rootDir,
      jobPath: spawned.jobPath,
      finishedAt: `2026-04-21T${String(i).padStart(2, '0')}:35:00.000Z`,
      completionPreview: `legacy round ${i}`,
      remediationWorker: {
        ...spawned.job.remediationWorker,
        state: 'completed',
      },
      reReview: {
        requested: true,
        status: 'pending',
        reason: 'Findings addressed; please re-review.',
        triggered: true,
        outcomeReason: null,
        reviewRow: null,
        requestedAt: `2026-04-21T${String(i).padStart(2, '0')}:35:00.000Z`,
      },
    });
  }

  const finalLedger = summarizePRRemediationLedger(rootDir, {
    repo: 'laceyenterprises/clio',
    prNumber: 7,
  });
  assert.equal(finalLedger.completedRoundsForPR, 6);
  assert.equal(finalLedger.latestMaxRounds, 6);

  // Round 7 must be blocked because the legacy 6-round cap is now
  // genuinely exhausted (not falsely exhausted at round 4).
  createFollowUpJob(makeJobInput(rootDir, {
    reviewPostedAt: '2026-04-21T07:00:00.000Z',
    priorCompletedRounds: finalLedger.completedRoundsForPR,
    maxRemediationRounds: 6,
  }));
  const blockedClaim = claimNextFollowUpJob({
    rootDir,
    claimedAt: '2026-04-21T07:30:00.000Z',
  });
  assert.equal(
    blockedClaim,
    null,
    'no further claim after the legacy 6-round cap is genuinely consumed',
  );
});

test('summarizePRRemediationLedger fails soft on a single corrupt JSON record without zeroing out unrelated PR history', () => {
  // Reviewer blocking #2: the previous broad per-directory try/catch
  // meant one bad JSON file in completed/ would silently drop ALL
  // history from that directory for ALL PRs, undercount the target
  // PR's ledger, and re-arm PRs that had already exhausted their
  // budget. The resilient scan must catch and log per-file errors,
  // skip the bad record, and keep the rest of the directory intact.
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));

  // Three completed rounds for the target PR.
  for (let i = 1; i <= 3; i += 1) {
    createFollowUpJob(makeJobInput(rootDir, {
      reviewPostedAt: `2026-04-21T0${i}:00:00.000Z`,
      priorCompletedRounds: i - 1,
      maxRemediationRounds: 6,
    }));
    runOneRound(
      rootDir,
      `2026-04-21T0${i}:30:00.000Z`,
      `2026-04-21T0${i}:35:00.000Z`,
    );
  }

  // Drop a corrupt JSON file alongside the legitimate completed/
  // records — modeled on a partially-written or operator-edited file.
  const completedDir = getFollowUpJobDir(rootDir, 'completed');
  writeFileSync(
    path.join(completedDir, 'corrupt-not-json.json'),
    '{ this is not valid json',
    'utf8',
  );

  // Suppress the expected per-file warning so test output stays clean
  // without hiding regressions: we still assert it was called.
  const originalError = console.error;
  let warnedAboutBadFile = false;
  console.error = (...args) => {
    if (
      args.some((a) => typeof a === 'string' && a.includes('Skipping unreadable ledger record'))
    ) {
      warnedAboutBadFile = true;
      return;
    }
    originalError.apply(console, args);
  };

  let ledger;
  try {
    ledger = summarizePRRemediationLedger(rootDir, {
      repo: 'laceyenterprises/clio',
      prNumber: 7,
    });
  } finally {
    console.error = originalError;
  }

  assert.ok(warnedAboutBadFile, 'corrupt file must produce a per-file warning');
  assert.equal(
    ledger.completedRoundsForPR,
    3,
    'corrupt file must not zero out unrelated completed rounds for the target PR',
  );
  assert.equal(
    ledger.latestMaxRounds,
    6,
    'corrupt file must not erase latestMaxRounds for unrelated jobs in the same directory',
  );
});

test('summarizePRRemediationLedger picks latestMaxRounds from the most recent terminal job, preserving legacy 6-round caps', () => {
  // Reviewer blocking #2: a legacy job persisted with maxRounds=6
  // must not be silently downgraded to the current default. The
  // ledger must report the persisted cap so the watcher carries it
  // forward into the next adversarial review pass.
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));

  const legacy = createFollowUpJob(makeJobInput(rootDir, {
    reviewPostedAt: '2026-04-21T08:00:00.000Z',
    maxRemediationRounds: 6,
  }));
  const claimed = claimNextFollowUpJob({ rootDir, claimedAt: '2026-04-21T08:30:00.000Z' });
  markFollowUpJobCompleted({
    rootDir,
    jobPath: claimed.jobPath,
    finishedAt: '2026-04-21T08:35:00.000Z',
    completionPreview: 'legacy round',
  });
  assert.equal(legacy.job.remediationPlan.maxRounds, 6);

  const ledger = summarizePRRemediationLedger(rootDir, {
    repo: 'laceyenterprises/clio',
    prNumber: 7,
  });
  assert.equal(ledger.latestMaxRounds, 6, 'persisted legacy cap must carry forward, not be substituted by the global default');
});

test('summarizePRRemediationLedger does not double-count failed and stopped intermediate rounds', () => {
  // A worker that ran but the reply was invalid lands in failed/.
  // Its currentRound was set to 1 by the claim. That counts as one
  // PR-wide consumed round (the worker spent the cycle), and under
  // max(currentRound) semantics the failed job alone reports 1.
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  createFollowUpJob(makeJobInput(rootDir));
  const claimed = claimNextFollowUpJob({ rootDir, claimedAt: '2026-04-21T08:30:00.000Z' });
  const spawned = markFollowUpJobSpawned({
    jobPath: claimed.jobPath,
    spawnedAt: '2026-04-21T08:31:00.000Z',
    worker: {
      processId: 8123,
      state: 'spawned',
      workspaceDir: 'workspace',
      outputPath: 'workspace/.adversarial-follow-up/codex-last-message.md',
      logPath: 'workspace/.adversarial-follow-up/codex-worker.log',
      promptPath: 'workspace/.adversarial-follow-up/prompt.md',
    },
  });
  markFollowUpJobFailed({
    rootDir,
    jobPath: spawned.jobPath,
    error: new Error('invalid reply'),
    failedAt: '2026-04-21T08:40:00.000Z',
    failureCode: 'invalid-remediation-reply',
    remediationWorker: {
      ...spawned.job.remediationWorker,
      state: 'failed',
    },
  });

  const ledger = summarizePRRemediationLedger(rootDir, {
    repo: 'laceyenterprises/clio',
    prNumber: 7,
  });
  assert.equal(ledger.completedRoundsForPR, 1);
});

test('summarizePRRemediationLedger excludes never-spawned terminal jobs from the round count', () => {
  // Reviewer blocking finding: `claimNextFollowUpJob` increments
  // `currentRound` before consume-time pre-spawn gates run (lifecycle,
  // round-budget, OAuth, workspace prep). When one of those gates
  // refuses, the terminal record carries the bumped round count even
  // though no worker ever started — and the previous ledger counted
  // it, permanently burning a round of remediation budget on a closed
  // PR or an OAuth hiccup. The fix tags those records with
  // `remediationWorker.state == 'never-spawned'`; the ledger now
  // excludes them so the PR-wide count reflects only rounds that
  // actually ran a worker.
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  createFollowUpJob(makeJobInput(rootDir));
  const claimed = claimNextFollowUpJob({ rootDir, claimedAt: '2026-04-21T08:30:00.000Z' });

  // Simulate a consume-time stop (lifecycle gate or round-budget gate
  // refused to spawn) by writing the never-spawned worker tag into the
  // record before moving it to stopped/.
  writeFollowUpJob(claimed.jobPath, {
    ...claimed.job,
    remediationWorker: { state: 'never-spawned', reconciledAt: '2026-04-21T08:31:00.000Z' },
  });
  markFollowUpJobStopped({
    rootDir,
    jobPath: claimed.jobPath,
    stoppedAt: '2026-04-21T08:31:00.000Z',
    stopCode: 'operator-closed-pr',
    stopReason: 'PR was closed before remediation could run.',
    remediationWorker: { state: 'never-spawned', reconciledAt: '2026-04-21T08:31:00.000Z' },
    sourceStatus: 'in_progress',
  });

  const ledger = summarizePRRemediationLedger(rootDir, {
    repo: 'laceyenterprises/clio',
    prNumber: 7,
  });
  assert.equal(
    ledger.completedRoundsForPR,
    0,
    'never-spawned terminal jobs must not contribute to the PR-wide round count',
  );
});

test('a transient watcher post-failure (modeled as review_attempts++) does NOT trip the final-round threshold via the ledger', () => {
  // Reviewer blocking #1: the lenient final-round threshold must not
  // activate just because review_attempts incremented for a failed
  // post / OAuth crash / reviewer timeout. The ledger only counts
  // *completed remediation rounds* — transient failures that never
  // ran a remediation worker do not touch the follow-up-jobs ledger
  // at all, so the watcher's reviewAttemptNumber is unaffected.
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));

  // Simulate three transient post failures with no remediation work
  // ever happening: there are no follow-up jobs in the ledger.
  const ledger = summarizePRRemediationLedger(rootDir, {
    repo: 'laceyenterprises/clio',
    prNumber: 7,
  });

  const reviewAttemptNumber = ledger.completedRoundsForPR + 1;
  const cap = ledger.latestMaxRounds || DEFAULT_MAX_REMEDIATION_ROUNDS;
  assert.equal(reviewAttemptNumber, 1);
  assert.equal(
    isFinalReviewRound({ reviewAttemptNumber, maxRemediationRounds: cap }),
    false,
    'first review pass must not be the final round, even after many transient failures'
  );
});

test('buildFollowUpJob seeds remediationPlan.currentRound from priorCompletedRounds so the cap is enforced PR-wide', () => {
  // Each adversarial review pass creates a new follow-up job. To make
  // the cap a PR-wide bound (not per-job), the new job's currentRound
  // is seeded with the PR's prior accumulated count, and
  // claimNextFollowUpJob's `currentRound >= maxRounds` guard then
  // naturally stops the loop once the PR exhausts its budget.
  const job = buildFollowUpJob({
    repo: 'laceyenterprises/clio',
    prNumber: 7,
    reviewerModel: 'codex',
    reviewBody: '## Summary\nx\n\n## Verdict\nRequest changes',
    reviewPostedAt: '2026-04-21T10:00:00.000Z',
    critical: false,
    priorCompletedRounds: 2,
    maxRemediationRounds: 3,
  });
  assert.equal(job.remediationPlan.currentRound, 2);
  assert.equal(job.remediationPlan.maxRounds, 3);
  assert.equal(job.remediationPlan.nextAction.round, 3);
});

test('claimNextFollowUpJob stops a freshly created job whose seeded currentRound is already at the PR-wide cap', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));

  // Simulate the case after a final-round review that landed
  // `Request changes`: the reviewer creates a new follow-up job, but
  // the PR already consumed all 3 of its remediation rounds. The new
  // job's currentRound is seeded to 3, so claim must stop it
  // immediately with max-rounds-reached.
  createFollowUpJob(makeJobInput(rootDir, {
    reviewPostedAt: '2026-04-21T11:00:00.000Z',
    priorCompletedRounds: 3,
    maxRemediationRounds: 3,
  }));

  const claimResult = claimNextFollowUpJob({
    rootDir,
    claimedAt: '2026-04-21T11:30:00.000Z',
  });
  assert.equal(claimResult, null, 'no claimable job remains because the cap was reached');

  const stoppedDir = getFollowUpJobDir(rootDir, 'stopped');
  const stoppedFiles = readdirSync(stoppedDir).filter((f) => f.endsWith('.json'));
  assert.equal(stoppedFiles.length, 1);
  const stoppedJob = readFollowUpJob(path.join(stoppedDir, stoppedFiles[0]));
  assert.equal(stoppedJob.status, 'stopped');
  assert.equal(stoppedJob.remediationPlan.stop.code, 'max-rounds-reached');
  assert.match(
    stoppedJob.remediationPlan.stop.reason,
    /Reached max remediation rounds \(3\/3\)/,
  );
});

test('legacy maxRounds=6 PRs run all six rounds after default-cap changes', () => {
  // Migration safety: a PR whose first follow-up job was created
  // before the default-cap change must keep its persisted 6-round
  // cap. The watcher carries latestMaxRounds forward into both the
  // reviewer's isFinalRound decision and the next follow-up job's
  // persisted cap, so the lenient threshold only kicks in at the
  // legacy round-7 review, not at round-4.
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));

  // Round 1: legacy job with maxRounds=6
  createFollowUpJob(makeJobInput(rootDir, {
    reviewPostedAt: '2026-04-21T01:00:00.000Z',
    maxRemediationRounds: 6,
    priorCompletedRounds: 0,
  }));
  runOneRound(rootDir, '2026-04-21T01:30:00.000Z', '2026-04-21T01:35:00.000Z');

  // The watcher would now read the ledger before re-spawning. After
  // round 1, completed=1, latest cap=6.
  let ledger = summarizePRRemediationLedger(rootDir, {
    repo: 'laceyenterprises/clio',
    prNumber: 7,
  });
  assert.equal(ledger.completedRoundsForPR, 1);
  assert.equal(ledger.latestMaxRounds, 6);

  // Simulate the watcher's reviewer-attempt computation for the
  // re-review after round 1: attempt=2. With max=6 (legacy cap),
  // attempt 2 is NOT final.
  assert.equal(
    isFinalReviewRound({
      reviewAttemptNumber: ledger.completedRoundsForPR + 1,
      maxRemediationRounds: ledger.latestMaxRounds,
    }),
    false,
    'a legacy 6-round PR must not get the lenient threshold at attempt 2',
  );

  // Pin the breaking case the reviewer flagged: with the buggy
  // global-default behavior, attempt 4 with max=3 would have been
  // marked final. With the carry-forward fix, attempt 4 with max=6
  // is NOT final.
  assert.equal(
    isFinalReviewRound({
      reviewAttemptNumber: 4,
      maxRemediationRounds: ledger.latestMaxRounds,
    }),
    false,
    'a legacy 6-round PR must keep its full remediation budget at attempt 4',
  );
});

test('the lenient final-round addendum keeps Request changes when any finding remains, so the merge gate cannot silently auto-merge known issues', () => {
  // Reviewer blocking #3: the addendum used to map "everything
  // non-critical" to verdict `Comment only`, which the worker-pool
  // automerge gate treats as a pass. A merge-safe verdict policy
  // requires that the verdict stays `Request changes` whenever any
  // finding remains (blocking OR non-blocking). The addendum text
  // is the load-bearing part of the contract — pin it here so
  // future edits don't silently revert the gate-bypass behavior.
  const addendum = ADVERSARIAL_PROMPT_FINAL_ROUND_ADDENDUM;

  // The addendum must explicitly forbid downgrading the verdict
  // to Comment only as a convergence shortcut.
  assert.match(
    addendum,
    /do NOT downgrade to `Comment only`/,
    'verdict policy header must explicitly call out the no-downgrade rule',
  );

  // The addendum must require Request changes whenever any finding
  // exists, even after lenient categorization moves things to
  // non-blocking.
  assert.match(
    addendum,
    /`Request changes`.*whenever.*`## Blocking issues` OR `## Non-blocking issues` contains any item/s,
    'verdict policy must keep Request changes when any finding remains',
  );

  // The addendum must restrict Comment only to truly clean reviews.
  assert.match(
    addendum,
    /`Comment only`.*only when.*`## Blocking issues` AND `## Non-blocking issues` are both `- None\.`/s,
    'Comment only must require empty Blocking AND Non-blocking sections',
  );

  // The addendum must call out the merge-gate semantics so the
  // contract is self-documenting (a future editor cannot loosen the
  // verdict policy without first deciding to weaken the gate).
  assert.match(
    addendum,
    /merge gate.*Comment only.*automatic pass/,
    'addendum must document why the verdict policy is strict (downstream gate behavior)',
  );
});

test('the addendum text remains substantial — a vacuous addendum would silently neutralize the convergence + merge-gate contract', () => {
  // Defensive: if a future change accidentally truncates the
  // addendum, the convergence behavior collapses to the base prompt.
  // This is a smoke check to catch obvious regressions like an
  // empty / single-line addendum file.
  assert.ok(
    ADVERSARIAL_PROMPT_FINAL_ROUND_ADDENDUM.length > 800,
    'addendum must be long enough to preserve the categorization + verdict-policy contract',
  );
});
