import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { requestEligibleHammerWake } from '../src/hammer-wake.mjs';
import { maybeDispatchAmaClosureFor } from '../src/ama-closure-orchestration.mjs';
import { maybeDispatchAmaCloser } from '../src/ama/dispatch-closer.mjs';
import { proveCommentOnlyFinalRoundHead } from '../src/comment-only-final-round.mjs';
import { requestReviewRereview } from '../src/review-state.mjs';
import { buildRemediationOutcomeCommentBody } from '../src/adapters/comms/github-pr-comments/pr-comments.mjs';

const repo = 'fixture/project', prNumber = 27;
const reviewedHead = 'a'.repeat(40), pushedHead = 'b'.repeat(40), unrelatedHead = 'c'.repeat(40);
const reviewBody = '## Blocking issues\n- None.\n## Non-blocking issues\n- **Cleanup**\n  - **Problem:** redundant branch\n## Verdict\nComment only';
const silent = { log() {}, warn() {}, error() {} };

function fixture(t, overrides = {}, status = 'completed') {
  const rootDir = mkdtempSync(join(tmpdir(), 'wake-closeout-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const job = { repo, prNumber, jobId: 'fixture__project-pr-27-final', status,
    revisionRef: reviewedHead, reviewBody, riskClass: 'low', finalRound: 'comment-only',
    reReview: { status: 'suppressed', suppressed: 'comment-only-final-round',
      normalizedFrom: 'ci-pending-only', requested: false },
    completedAt: new Date().toISOString(),
    completion: { workerPushedHeadSha: pushedHead, pendingCiOnly: true,
      finalRoundOutcome: { reason: 'kind-pending-ci', ciState: 'pending' } },
    remediationPlan: { currentRound: 1, maxRounds: 2 },
    remediationWorker: { state: 'completed' }, ...overrides };
  const dir = join(rootDir, 'data', 'follow-up-jobs', status);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${job.jobId}.json`), JSON.stringify(job));
  const wakes = [];
  const wake = args => requestEligibleHammerWake({ rootDir, repo, prNumber,
    headSha: pushedHead, reviewedHeadSha: reviewedHead,
    eligibility: { eligible: false, reasons: ['stale-head'] }, log: silent,
    requestWatcherWakeImpl: payload => {
      wakes.push(payload);
      return { requested: true, payload: { request_id: 'fixture-wake' } };
    }, ...args });
  return { rootDir, job, wakes, wake };
}

test('suppressed final-round push waits for CI, then wakes and reaches the hammer on the next pass', async t => {
  const f = fixture(t), dispatches = [], wakeResults = [], sharedWakes = [];
  const args = { rootDir: f.rootDir, repoPath: repo, prNumber, currentRevisionRef: pushedHead,
    labelNames: [], logger: silent,
    reviewStateRow: { repo, pr_number: prNumber, review_status: 'posted', reviewer: 'claude',
      reviewer_head_sha: reviewedHead, last_verdict: 'Comment only', posted_at: f.job.completedAt },
    loadConfigImpl: () => ({ getMergeAuthorityConfig: () => ({ enabled: true, strictMode: true,
      workerClass: 'hammer', eligibility: { riskClasses: ['low'], highRiskRequiresTwoKey: false },
      strictNonBlockingRemediation: true, branchProtection: { required: false } }) }),
    resolveAmaHammerDispatchModeImpl: () => 'inline',
    fetchLatestHeadReviewBodiesImpl: async () => [reviewBody],
    resolveHeadCloserCommitSuppressionImpl: async () => ({ suppressed: false }),
    proveCloserAuthoredStaleHeadImpl: async () => ({ proven: false }),
    fetchMergedProtectiveDependentsImpl: async () => [],
    runDaemonCleanMergeAttemptImpl: async () => ({ disposition: 'not-taken', reason: 'non-blocking-findings-present' }),
    proveCommentOnlyFinalRoundHeadImpl: args => proveCommentOnlyFinalRoundHead({
      ...args, execFileImpl: async () => ({ stdout: 'ahead' }),
    }),
    requestEligibleHammerWakeImpl: args => { sharedWakes.push(args.shared); wakeResults.push(f.wake(args)); },
    maybeDispatchAmaCloserImpl: async args => {
      const result = await maybeDispatchAmaCloser({ ...args,
        dispatchContext: { ...args.dispatchContext, hqRoot: join(f.rootDir, 'hq'),
          hqOwnerUser: userInfo().username, currentUser: userInfo().username },
        execFileImpl: async () => ({ stdout: JSON.stringify({ ticketRef: `AMA-PR-${prNumber}`,
          dispatchId: 'fixture-dispatch', launchRequestId: 'fixture-launch' }) }),
        readTemplateImpl: () => 'fixture hammer <<PR_URL>> <<AMA_TRAILERS>>',
        writeFileImpl() {},
        resolveCloserDispatchHarnessImpl: async ({ workerClass }) => ({ workerClass, fellBack: false }),
        readBuildCompletionSignalForPrImpl: () => ({ ok: false, reason: 'missing-build-completion-signal' }),
        readBuildCompletionProducerEvidenceImpl: () => ({ ok: false, reason: 'missing-build-completion-producer-evidence' }),
        logger: silent,
      });
      if (result.dispatched) dispatches.push(args);
      return result;
    },
  };
  const candidate = { headSha: pushedHead, prState: 'open', riskClass: 'low',
    prAuthor: 'fixture-builder', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' };
  await maybeDispatchAmaClosureFor({ ...args, candidate: { ...candidate,
    statusCheckRollup: [{ name: 'test', status: 'IN_PROGRESS', conclusion: null }] } });
  assert.equal(wakeResults[0].reason, 'checks-pending');
  assert.equal(f.wakes.length, 0);
  assert.equal(dispatches.length, 0);
  const result = await maybeDispatchAmaClosureFor({ ...args, candidate: { ...candidate,
    statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] } });
  assert.equal(wakeResults[1].outcome, 'requested');
  assert.equal(result.dispatched, true, JSON.stringify(result));
  assert.equal(f.wakes.length, 1);
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].dispatchContext.commentOnlyFinalRoundResume, true);
  assert.equal(dispatches[0].dispatchContext.targetRemediationSha, pushedHead);
  assert.equal(dispatches[0].reviewState.headSha, reviewedHead, 'wake never changes reviewed merge evidence');
  assert.equal(requestReviewRereview({ rootDir: f.rootDir, repo, prNumber,
    targetRevisionRef: pushedHead, reason: 'auto-refresh: PR head moved' }).reason,
  'comment-only-final-round-completed');
  assert.equal(f.wake({ shared: sharedWakes[1] }).outcome, 'duplicate',
  'one wake per recorded head');
});

test('a suppressed round with no push keeps the current-head wake and unrelated-head refusal', t => {
  const f = fixture(t, { completion: {} });
  assert.equal(f.wake({ headSha: reviewedHead, eligibility: { eligible: true, reasons: [] } }).outcome, 'requested');
  assert.equal(f.wake().reason, 'stale-head');
});

for (const [label, overrides, wakeArgs, status] of [
  ['unrelated push', {}, { headSha: unrelatedHead }],
  ['different reviewed head', {}, { reviewedHeadSha: unrelatedHead }],
  ['unsuppressed round', { reReview: { requested: true } }, {}],
  ['blocking round', { finalRound: undefined, reviewBody: '## Verdict\nRequest changes' }, {}],
  ['in-progress round', {}, {}, 'in-progress'],
]) {
  test(`${label} cannot inherit the recorded final-round wake`, t => {
    const f = fixture(t, overrides, status);
    assert.equal(f.wake(wakeArgs).reason, 'stale-head');
    assert.equal(f.wakes.length, 0);
  });
}

test('a recorded push preserves other wake eligibility misses', t => {
  const f = fixture(t);
  for (const reason of ['ci-not-green', 'verdict-not-eligible', 'branch-protection-missing-gate', 'labels-unavailable']) {
    assert.equal(f.wake({ eligibility: { eligible: false, reasons: ['stale-head', reason] } }).reason, reason);
  }
  assert.equal(f.wakes.length, 0);
});

for (const pendingCiOnly of [true, false]) {
  test(`suppressed completion names hammer ownership with pending CI ${pendingCiOnly}`, t => {
    const { job } = fixture(t);
    job.completion.pendingCiOnly = pendingCiOnly;
    const body = buildRemediationOutcomeCommentBody({ workerClass: 'fixture-worker', action: 'completed', job });
    assert.match(body, /hammer owns final validation and close of this remediation round's recorded head/);
    assert.doesNotMatch(body, /\u2019/);
    assert.match(body, /No re-review is queued/);
    assert.doesNotMatch(body, /re-review queued|re-review already pending/);
    if (pendingCiOnly) assert.match(body, /CI still running/);
  });
}

for (const [label, completion] of [
  ['missing completion', undefined],
  ['missing pushed head', {}],
  ['null pushed head', { workerPushedHeadSha: null }],
]) {
  test(`pushless suppressed completion refers to the PR head: ${label}`, t => {
    const { job } = fixture(t, { completion });
    const body = buildRemediationOutcomeCommentBody({ workerClass: 'fixture-worker', action: 'completed', job });
    assert.match(body, /hammer owns final validation and close of the PR head once structural gates are green/);
    assert.doesNotMatch(body, /recorded head|\u2019/);
    assert.match(body, /No re-review is queued/);
  });
}
