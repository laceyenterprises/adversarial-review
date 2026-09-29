// DIRTYOWN-02 replay (2026-09-29, "conflicting close-phase PRs pass closer
// eligibility; log not-eligible reasons").
//
// DIRTYOWN-01 let a CONFLICTING PR past the background queue's mergeability
// recheck. After that deploy, agent-os#7332 still logged `settled ...
// dispatched=false reason=not-eligible` every tick. The real closer refused it
// at the `!autoHammer` gate with reasons
//   [pr-not-mergeable, stale-review-head, verdict-not-settled-success,
//    non-blocking-findings-present, ci-not-green].
// #7332's comment-only final round was done (the worker pushed 9b19705 onto the
// reviewed d57efeb). But the head conflicts with main and `repo-guards` is red
// on it. COMMENTCLOSE-01 turned the final-round resume off whenever CI was not
// green, which left `stale-review-head` uncovered. The final round creates that
// stale head by construction.
//
// agent-os#7330 is the Request-changes shape: round 2 of 2 failed on the
// provider cap, the hammer pushed 30df2aa (Closed-By: hammer), and main moved
// under it. The closer already routes it to a hammer. Its live ledger already
// holds two hammer launches on the reviewed head, so the retry cap is what
// stops it, and that stop is unchanged.
//
// Fixtures (test/fixtures/dirtyown-02/) come from gh reads only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  maybeDispatchAmaClosureFor,
  resolveMergeAgentCoexistenceForWatcher,
} from '../src/ama-closure-orchestration.mjs';
import { createAmaHammerBackgroundQueue } from '../src/ama-hammer-background-dispatch.mjs';
import { isHammerRemediableEligibilityMiss, maybeDispatchAmaCloser } from '../src/ama/dispatch-closer.mjs';
import { isEligibleForAmaClosure } from '../src/ama/eligibility.mjs';
import { recordHammerRetryDispatch } from '../src/ama/hammer-retry-cap.mjs';
import { proveCommentOnlyFinalRoundHead } from '../src/comment-only-final-round.mjs';
import { getFollowUpJobDir, writeFollowUpJob } from '../src/follow-up-jobs.mjs';
import {
  isTerminalCloserCommitIdentity,
  normalizeVerifiedCloserCommit,
} from '../src/head-closer-commit-suppression.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'dirtyown-02');
const fixture = (name) => {
  const record = JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
  delete record._fixture;
  return record;
};
const silent = { log() {}, info() {}, warn() {}, error() {} };
const CFG = {
  enabled: true, workerClass: 'hammer', mergeMethod: 'squash',
  eligibility: { riskClasses: ['low', 'medium'], highRiskRequiresTwoKey: false },
  branchProtection: { required: false },
};
const rollup = (conclusions) => Object.entries(conclusions)
  .map(([name, conclusion]) => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion }));

function tempRoot(t, label) {
  const rootDir = mkdtempSync(path.join(tmpdir(), `dirtyown-02-${label}-`));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  return rootDir;
}

function seedJob(rootDir, status, job) {
  const dir = getFollowUpJobDir(rootDir, status);
  mkdirSync(dir, { recursive: true });
  writeFollowUpJob(path.join(dir, `${job.jobId}.json`), job);
}

// Replays one watcher tick through resolveMergeAgentCoexistenceForWatcher with
// the REAL orchestration and the REAL closer. Only gh/exec and the hammer
// launch are stubbed.
async function replay(rootDir, {
  reviewStateRow, dispatchJob, candidate, labelNames = [], reviewBody, reviewedHead, stubs = {},
  queue = null, logs = [],
}) {
  const execCalls = [];
  const closerPayloads = [];
  const closerResults = [];
  const logger = { ...silent, log: (line) => logs.push(line), warn: (line) => logs.push(line) };
  const allStubs = {
    loadConfigImpl: () => ({ getMergeAuthorityConfig: () => CFG, get: (_key, fallback) => fallback }),
    resolveAmaHammerDispatchModeImpl: () => (queue ? 'background' : 'inline'),
    ...(queue ? {
      amaHammerBackgroundQueueImpl: () => queue,
      fetchCurrentPrStateImpl: async () => ({
        state: 'OPEN', headSha: candidate.headSha, isDraft: false, mergeable: candidate.mergeable,
      }),
    } : {}),
    fetchLatestHeadReviewBodiesImpl: async (_repo, _pr, head) => (head === reviewedHead ? [reviewBody] : []),
    fetchMergedProtectiveDependentsImpl: async () => [],
    runDaemonCleanMergeAttemptImpl: async () => ({ disposition: 'not-taken', reason: 'not-eligible' }),
    requestEligibleHammerWakeImpl: () => ({ requested: false }),
    maybeDispatchAmaCloserImpl: async (args) => {
      closerPayloads.push(args);
      const result = await maybeDispatchAmaCloser({
        ...args,
        dispatchContext: {
          ...args.dispatchContext, rootDir, hqRoot: path.join(rootDir, 'hq-root'),
          hqOwnerUser: userInfo().username, currentUser: userInfo().username,
        },
        execFileImpl: async (cmd, argv) => {
          execCalls.push({ cmd, argv });
          return { stdout: JSON.stringify({ dispatchId: 'dispatch_hammer', launchRequestId: 'lrq_hammer' }), stderr: '' };
        },
        readTemplateImpl: () => 'hammer prompt <<PR_URL>> <<REVIEWED_SHA>> <<TARGET_REMEDIATION_SHA>> <<AMA_TRAILERS>>',
        writeFileImpl: () => {},
        resolveCloserDispatchHarnessImpl: async ({ workerClass }) => ({ workerClass, fellBack: false }),
        readBuildCompletionSignalForPrImpl: () => ({ ok: false, reason: 'missing-build-completion-signal' }),
        readBuildCompletionProducerEvidenceImpl: () => ({ ok: false, reason: 'missing-build-completion-producer-evidence' }),
        logger: silent,
      });
      closerResults.push(result);
      return result;
    },
    ...stubs,
  };
  const outcome = await resolveMergeAgentCoexistenceForWatcher({
    rootDir, reviewStateRow, dispatchJob, candidate, labelNames,
    repoPath: 'laceyenterprises/agent-os', prNumber: reviewStateRow.pr_number,
    currentRevisionRef: candidate.headSha, logger,
    maybeDispatchAmaClosureForImpl: (args) => maybeDispatchAmaClosureFor({ ...args, ...allStubs }),
  });
  const hammerDispatches = execCalls.filter(({ argv }) => argv[0] === 'dispatch' && argv.includes('hammer'));
  const merges = execCalls.filter(({ cmd, argv }) => cmd === 'gh' && argv[0] === 'pr' && argv[1] === 'merge');
  return { outcome, closerPayloads, closerResults, hammerDispatches, merges, logs };
}

// ── #7332: comment-only final round done, head CONFLICTING, repo-guards red ────

const R7332 = 'd57efeb2d68259ddd12a0d1b3fecfc4213e95766';
const P7332 = '9b19705ca1bf4ac779163e5b366efbc6078352dc';
const INCIDENT_7332_REASONS = [
  'pr-not-mergeable', 'stale-review-head', 'verdict-not-settled-success',
  'non-blocking-findings-present', 'ci-not-green',
];

function setup7332(rootDir, candidateOverrides = {}) {
  const job = fixture('pr-7332-final-round-job.json');
  seedJob(rootDir, 'stopped', job);
  return {
    job,
    reviewedHead: R7332,
    reviewBody: job.reviewBody,
    reviewStateRow: {
      repo: job.repo, pr_number: 7332, pr_state: 'open', review_status: 'posted', reviewer: 'gemini',
      revision_ref: R7332, reviewer_head_sha: R7332, posted_at: '2026-09-29T03:37:45.677Z',
      last_verdict: 'Comment only', risk_class: 'medium', remediation_pending: 0,
    },
    dispatchJob: job,
    // `gh pr view 7332`: CONFLICTING/DIRTY; `repo-guards` FAILURE on 9b19705.
    candidate: {
      headSha: P7332, riskClass: 'medium', prState: 'open', prAuthor: 'claude-code-worker',
      mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', isDraft: false,
      statusCheckRollup: rollup({ 'submodule-pointer-gate': 'SUCCESS', 'release-freeze-gate': 'SUCCESS', 'repo-guards': 'FAILURE' }),
      branchProtection: { requiredContexts: [] },
      ...candidateOverrides,
    },
    stubs: {
      resolveHeadCloserCommitSuppressionImpl: async () => ({ suppressed: false, reason: 'not-closer-commit' }),
      // GitHub compare d57efeb...9b19705 is `diverged`: the worker replayed the
      // reviewed commits onto a fresh base (git-cherry-replay proof on the job).
      proveCommentOnlyFinalRoundHeadImpl: (args) => proveCommentOnlyFinalRoundHead({
        ...args, execFileImpl: async () => ({ stdout: 'diverged\n' }),
      }),
    },
  };
}

test('replay #7332: a conflicting, red-CI final-round head reaches one hammer instead of not-eligible', async (t) => {
  const rootDir = tempRoot(t, '7332');
  const input = setup7332(rootDir);
  assert.equal(input.job.status, 'stopped');
  assert.equal(input.job.finalRound, 'comment-only');
  assert.equal(input.job.remediationPlan.currentRound, 1);
  assert.equal(input.job.remediationPlan.maxRounds, 2, 'round 1 of 2: the cycle is not exhausted');
  assert.equal(input.job.completion.workerPushedHeadSha, P7332);

  const run = await replay(rootDir, input);

  const [payload] = run.closerPayloads;
  assert.equal(payload.reviewState.reviewCycleExhausted, false);
  assert.deepEqual(
    isEligibleForAmaClosure(payload.reviewState, payload.prMetadata, CFG, { env: {} }).reasons,
    INCIDENT_7332_REASONS,
    'the closer sees exactly the reasons production refused on',
  );
  assert.equal(payload.dispatchContext.commentOnlyFinalRoundConflicting, true, 'CONFLICTING is a proven conflict');
  assert.equal(payload.dispatchContext.commentOnlyFinalRoundResume, true, 'a conflict does not wait on CI');
  assert.equal(run.closerResults[0].dispatched, true, JSON.stringify(run.closerResults[0].reasons));
  assert.equal(run.outcome.outcome, 'ama-dispatched');
  assert.equal(run.hammerDispatches.length, 1, 'exactly one hammer');
  assert.equal(run.merges.length, 0, 'the proof never merges on its own');
});

test('replay #7332: a hard-stop label still blocks, and both background log lines name the reasons', async (t) => {
  for (const label of ['do-not-merge', 'merge-agent-stuck']) {
    const rootDir = tempRoot(t, `7332-${label}`);
    const input = setup7332(rootDir);
    const queue = createAmaHammerBackgroundQueue({ maxConcurrent: 1 });
    const logs = [];
    const first = await replay(rootDir, { ...input, labelNames: [label], queue, logs });
    await queue.drain();
    const second = await replay(rootDir, { ...input, labelNames: [label], queue, logs });

    const expected = `reasons=[${[...INCIDENT_7332_REASONS, `label-${label}`].join(',')}]`;
    assert.deepEqual(first.closerResults[0].reasons, [...INCIDENT_7332_REASONS, `label-${label}`]);
    assert.equal(first.closerResults[0].reason, 'not-eligible');
    assert.equal(first.hammerDispatches.length + second.hammerDispatches.length, 0, `${label} dispatches nothing`);
    assert.notEqual(second.outcome.outcome, 'ama-dispatched');
    const settled = logs.find((line) => /AMA hammer background dispatch settled for .*#7332@/.test(line));
    const applied = logs.find((line) => /AMA hammer background outcome applied for .*#7332:/.test(line));
    assert.ok(settled?.includes(`dispatched=false reason=not-eligible ${expected}`), settled);
    assert.ok(applied?.includes(`dispatched=false reason=not-eligible ${expected}`), applied);
  }
});

test('replay #7332 without the conflict: red CI alone still holds the final-round resume', async (t) => {
  const rootDir = tempRoot(t, '7332-mergeable');
  const input = setup7332(rootDir, { mergeable: 'MERGEABLE', mergeStateStatus: 'UNSTABLE' });
  const run = await replay(rootDir, input);
  assert.equal(run.closerPayloads[0].dispatchContext.commentOnlyFinalRoundResume, false);
  assert.equal(run.closerResults[0].reason, 'not-eligible');
  assert.deepEqual(run.closerResults[0].reasons, INCIDENT_7332_REASONS.filter((r) => r !== 'pr-not-mergeable'));
  assert.equal(run.hammerDispatches.length, 0);
});

test('replay #7332 with BLOCKED and no raw mergeable: red CI still holds, because BLOCKED is not a conflict', async (t) => {
  // A red required check reports mergeStateStatus=BLOCKED. With the raw
  // `mergeable` field empty that normalizes to `pr-not-mergeable`, which must
  // not read as the conflict that lifts the CI hold.
  for (const mergeable of ['', null]) {
    const rootDir = tempRoot(t, `7332-blocked-${mergeable === null ? 'null' : 'empty'}`);
    const input = setup7332(rootDir, { mergeable, mergeStateStatus: 'BLOCKED' });
    const run = await replay(rootDir, input);
    const [payload] = run.closerPayloads;
    assert.deepEqual(
      isEligibleForAmaClosure(payload.reviewState, payload.prMetadata, CFG, { env: {} }).reasons,
      INCIDENT_7332_REASONS,
      'BLOCKED still reads as pr-not-mergeable',
    );
    assert.equal(payload.dispatchContext.commentOnlyFinalRoundConflicting, false);
    assert.equal(payload.dispatchContext.commentOnlyFinalRoundResume, false);
    assert.equal(run.closerResults[0].reason, 'not-eligible');
    assert.equal(run.hammerDispatches.length, 0);
  }
});

const PENDING_7332_ROLLUP = [
  ...rollup({ 'submodule-pointer-gate': 'SUCCESS', 'release-freeze-gate': 'SUCCESS' }),
  { __typename: 'CheckRun', name: 'repo-guards', status: 'IN_PROGRESS', conclusion: null },
];
// 16 minutes after the proven final-round push: inside the CI-wait deadline.
const WITHIN_CI_WAIT = () => Date.parse('2026-09-29T04:00:00.000Z');
const HOLDING_FOR_CI = /AMA holding .*#7332 for PR-head CI/;

test('replay #7332 with pending CI: a conflicting final-round head reaches one hammer instead of waiting', async (t) => {
  const rootDir = tempRoot(t, '7332-pending');
  const input = setup7332(rootDir, { statusCheckRollup: PENDING_7332_ROLLUP });
  const logs = [];
  const run = await replay(rootDir, { ...input, stubs: { ...input.stubs, now: WITHIN_CI_WAIT }, logs });
  assert.equal(run.closerPayloads[0].dispatchContext.commentOnlyFinalRoundConflicting, true);
  assert.equal(run.closerPayloads[0].dispatchContext.commentOnlyFinalRoundResume, true);
  assert.equal(run.closerResults[0].dispatched, true, JSON.stringify(run.closerResults[0].reasons));
  assert.equal(run.hammerDispatches.length, 1);
  assert.equal(logs.some((line) => HOLDING_FOR_CI.test(line)), false);
});

test('replay #7332 with pending CI and another miss: a conflicting head is not exempted as waiting on CI', async (t) => {
  // `pr-is-draft` is neither a hard stop nor covered by the resume, so the
  // closer returns not-eligible. Only a mergeable head earns the CI-wait
  // exemption from the retain-loop cap; a conflicting one is not waiting on CI.
  for (const [label, overrides, expectHold] of [
    ['conflict', {}, false],
    ['no-conflict', { mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED' }, true],
  ]) {
    const rootDir = tempRoot(t, `7332-pending-draft-${label}`);
    const input = setup7332(rootDir, { statusCheckRollup: PENDING_7332_ROLLUP, isDraft: true, ...overrides });
    const logs = [];
    const run = await replay(rootDir, { ...input, stubs: { ...input.stubs, now: WITHIN_CI_WAIT }, logs });
    assert.equal(run.closerResults[0]?.reason, 'not-eligible', label);
    assert.ok(run.closerResults[0].reasons.includes('pr-is-draft'), label);
    assert.equal(run.hammerDispatches.length, 0, label);
    assert.equal(logs.some((line) => HOLDING_FOR_CI.test(line)), expectHold, `${label}: ${logs.join('\n')}`);
  }
});

// ── #7330: final-round Request changes, hammer-moved head, CONFLICTING ─────────

const R7330 = 'f7052449d5d6f2efe71a8e7b1a5a9dbd80b1a8e8';
const H7330 = '30df2aa0b3bdca8d5c086f29f860531b92368605';

function setup7330(rootDir) {
  const history = fixture('pr-7330-history.json');
  for (const [status, job] of Object.entries(history.jobs)) seedJob(rootDir, status, job);
  const { headCommit } = history;
  return {
    reviewedHead: R7330,
    reviewBody: history.jobs.failed.reviewBody,
    reviewStateRow: {
      repo: 'laceyenterprises/agent-os', pr_number: 7330, pr_state: 'open', review_status: 'posted', reviewer: 'claude',
      revision_ref: R7330, reviewer_head_sha: R7330, posted_at: '2026-09-29T04:10:37.354Z',
      last_verdict: 'Request changes', risk_class: 'medium', remediation_pending: 0,
    },
    dispatchJob: history.jobs.failed,
    // `gh pr view 7330`: CONFLICTING/DIRTY; `repo-guards` FAILURE on 30df2aa.
    candidate: {
      headSha: H7330, riskClass: 'medium', prState: 'open', prAuthor: 'claude-code-worker',
      mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', isDraft: false,
      statusCheckRollup: rollup({ 'submodule-pointer-gate': 'SUCCESS', 'release-freeze-gate': 'SUCCESS', 'repo-guards': 'FAILURE' }),
      branchProtection: { requiredContexts: [] },
    },
    stubs: {
      resolveHeadCloserCommitSuppressionImpl: async () => isTerminalCloserCommitIdentity({ message: headCommit.message }),
      fetchHeadCloserVerifiedCommitImpl: async () => normalizeVerifiedCloserCommit({
        sha: headCommit.sha,
        parents: headCommit.parents.map((sha) => ({ sha })),
        message: headCommit.message,
        files: headCommit.files.map((filename) => ({ filename })),
      }),
      // No HAM terminal-remediation audit comment is on #7330.
      resolveHamTerminalRemediationEvidenceImpl: async () => null,
    },
  };
}

test('replay #7330: a final-round Request changes on a conflicting hammer-moved head reaches one hammer', async (t) => {
  const rootDir = tempRoot(t, '7330');
  const run = await replay(rootDir, setup7330(rootDir));
  const [payload] = run.closerPayloads;
  assert.equal(payload.reviewState.reviewCycleExhausted, true, 'round 2 of 2 exhausts the budget');
  assert.equal(payload.dispatchContext.allowStaleReviewHeadHammerResume, true, 'Closed-By: hammer self-certifies the head');
  assert.equal(run.closerResults[0].dispatched, true, JSON.stringify(run.closerResults[0].reasons));
  assert.equal(run.outcome.outcome, 'ama-dispatched');
  assert.equal(run.hammerDispatches.length, 1);
  assert.equal(run.merges.length, 0);
});

test('replay #7330 with its live ledger: two hammer launches on the reviewed head still hit the retry cap', async (t) => {
  const rootDir = tempRoot(t, '7330-cap');
  const input = setup7330(rootDir);
  const identity = { repo: 'laceyenterprises/agent-os', prNumber: 7330 };
  for (const now of ['2026-09-29T04:57:21Z', '2026-09-29T06:18:11Z']) {
    recordHammerRetryDispatch(rootDir, identity, { jobKey: R7330, headSha: R7330, now });
  }
  const run = await replay(rootDir, input);
  assert.equal(run.closerResults[0].dispatched, false);
  assert.equal(run.closerResults[0].reason, 'hammer-retry-cap-exhausted');
  assert.equal(run.hammerDispatches.length, 0);
});

// ── The closer's own rule, both sides of the review budget ───────────────────

test('a proven final-round resume covers a conflict with red CI, and never a blocking finding', () => {
  for (const reviewCycleExhausted of [false, true]) {
    const options = {
      reviewCycleExhausted, commentOnlyFinalRoundResume: true, commentOnlyFinalRoundConflicting: true,
    };
    assert.equal(isHammerRemediableEligibilityMiss(INCIDENT_7332_REASONS, options), true, `exhausted=${reviewCycleExhausted}`);
    assert.equal(
      isHammerRemediableEligibilityMiss(INCIDENT_7332_REASONS, { ...options, commentOnlyFinalRoundConflicting: false }),
      false,
      `pr-not-mergeable without a proven conflict still waits on red CI (exhausted=${reviewCycleExhausted})`,
    );
    assert.equal(
      isHammerRemediableEligibilityMiss(INCIDENT_7332_REASONS.filter((r) => r !== 'pr-not-mergeable'), options),
      false,
      `red CI alone still waits (exhausted=${reviewCycleExhausted})`,
    );
    for (const blocker of ['blocking-findings-present', 'blocking-findings-unknown']) {
      assert.equal(isHammerRemediableEligibilityMiss([...INCIDENT_7332_REASONS, blocker], options), false, blocker);
    }
    assert.equal(
      isHammerRemediableEligibilityMiss(INCIDENT_7332_REASONS, { reviewCycleExhausted }),
      false,
      'without the proof the stale head still parks',
    );
  }
});
