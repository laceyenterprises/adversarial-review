// Run: node src/ci-recovery-regressions.test.mjs
// Keep regression coverage within this batch's src scope while reusing the
// ordinary offline runner and its per-file filesystem isolation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

if (!process.env.ADVERSARIAL_REVIEW_TEST_SANDBOX_ROOT) {
  const checkout = dirname(dirname(fileURLToPath(import.meta.url)));
  const isolated = mkdtempSync('/tmp/ci-regression-runner-');
  let status = 1;
  try {
    for (const name of readdirSync(checkout)) {
      if (!['.git', 'data', 'test'].includes(name)) symlinkSync(join(checkout, name), join(isolated, name));
    }
    mkdirSync(join(isolated, 'test'));
    for (const name of readdirSync(join(checkout, 'test'))) {
      symlinkSync(join(checkout, 'test', name), join(isolated, 'test', name));
    }
    const name = 'ci-recovery-regressions.test.mjs';
    symlinkSync(fileURLToPath(import.meta.url), join(isolated, 'test', name));
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const run = spawnSync(process.execPath, ['--preserve-symlinks', '--preserve-symlinks-main',
      join(isolated, 'test/run-tests.mjs'), name], { cwd: isolated, env, stdio: 'inherit' });
    if (run.error) throw run.error;
    status = run.status ?? 1;
  } finally {
    rmSync(isolated, { recursive: true, force: true });
  }
  process.exit(status);
}
await import('../test/helpers/rate-limit-state-isolation.mjs');
const [
  { checkInfrastructureReason, enrichCiInfrastructureEvidence, hasMissingActionsEvidence, infrastructureEvidencePending },
  { buildFollowUpJob, listFollowUpJobsInDir, writeFollowUpJob },
  { recoverInfrastructureCiStops }, { writeAmaAuditEntry },
  { evaluateHammerStopHold, isInfrastructureStop, readHammerStopForHead },
  { recordHammerRetryDispatch, readHammerRetryCapLedger },
  { deriveNextActionSnapshot, nextAction }, { bindClosureNextAction },
  { recoverAmaAutomation }, { maybeDispatchAmaClosureFor },
] = await Promise.all([
  import('../src/ci-infrastructure.mjs'), import('../src/follow-up-jobs.mjs'),
  import('../src/remediation-ci-infrastructure.mjs'), import('../src/ama/audit.mjs'),
  import('../src/ama/hammer-stop-hold.mjs'), import('../src/ama/hammer-retry-cap.mjs'),
  import('../src/pr-next-action.mjs'), import('../src/ama/closure-next-action.mjs'),
  import('../src/ama/automated-recovery.mjs'), import('../src/ama-closure-orchestration.mjs'),
]);

const repo = 'example/fixture', prNumber = 42, head = 'a'.repeat(40);
const now = '2026-01-01T00:00:00.000Z', later = '2026-01-01T02:00:00.000Z';
const failed = { name: 'unit', conclusion: 'FAILURE', steps: [] };
const green = { name: 'unit', conclusion: 'SUCCESS', status: 'COMPLETED' };
const logger = { log() {}, warn() {}, error() {} };
function root(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-regression-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function postedReview(body) {
  return { repo, pr_number: prNumber, pr_state: 'open', review_status: 'posted',
    reviewer: 'codex', reviewer_head_sha: head, review_body: body, posted_at: now };
}

test('multiline billing diagnostics require zero-step evidence', () => {
  const output = { summary: 'The workflow\nwas not started\nbecause the Actions budget was exceeded.' };
  assert.equal(checkInfrastructureReason({ ...failed, output }), 'actions-billing-quota');
  assert.equal(checkInfrastructureReason({ ...failed, output, steps: [{ conclusion: 'failure' }] }), null);
  assert.equal(checkInfrastructureReason({ ...failed, output, steps: undefined }), null);
});

test('REST details_url caches remain bound to the exact job, run and head', async () => {
  const checks = [10, 20].map(id => ({ name: 'unit-' + id, conclusion: 'FAILURE',
    details_url: `https://github.com/${repo}/actions/runs/${id}/job/${id}` }));
  const reads = [];
  const execFileImpl = async (_bin, args) => {
    const id = Number(args[1].match(/runs\/(\d+)/)[1]);
    reads.push(id);
    return { stdout: JSON.stringify({ jobs: [{ id, head_sha: head, conclusion: 'failure',
      steps: id === 10 ? [] : [{ conclusion: 'failure', status: 'completed' }] }] }) };
  };
  const args = { rollup: checks, repo, headSha: head, execFileImpl };
  const first = await enrichCiInfrastructureEvidence(args);
  assert.equal(checkInfrastructureReason(first[0]), 'actions-zero-step');
  assert.equal(checkInfrastructureReason(first[1]), null);
  assert.equal(hasMissingActionsEvidence([checks[1]], repo), true);
  assert.equal(hasMissingActionsEvidence([null], repo), false);
  assert.equal(infrastructureEvidencePending(first), true);
  const second = await enrichCiInfrastructureEvidence(args);
  assert.deepEqual(reads, [10, 20]);
  assert.equal(checkInfrastructureReason(second[1]), null, 'an executed sibling cannot borrow zero steps');
  assert.deepEqual(second[1].steps, [{ conclusion: 'failure', status: 'completed' }]);
  await enrichCiInfrastructureEvidence({ ...args, rollup: checks.map(({ details_url, ...check }) =>
    ({ ...check, detailsUrl: details_url })) });
  assert.deepEqual(reads, [10, 20], 'REST and GraphQL aliases reuse the same evidence');
  await enrichCiInfrastructureEvidence({ ...args, headSha: 'b'.repeat(40) });
  assert.deepEqual(reads, [10, 20, 10], 'a new head requires fresh exact-head evidence');
});

for (const concurrent of [false, true]) test(`historical recovery keeps one live PR owner, concurrent=${concurrent}`, async t => {
  const rootDir = root(t);
  for (const [index, status] of ['stopped', 'failed'].entries()) {
    const job = buildFollowUpJob({ repo, prNumber, revisionRef: head,
      reviewBody: '## Verdict\nRequest changes', createdAt: new Date(Date.parse(now) + index * 1000).toISOString() });
    job.jobId += '-' + index;
    Object.assign(job, { status, failedAt: now, stoppedAt: now,
      failure: { code: 'ci-regression', ciGate: { headSha: head, failedChecks: [failed] } } });
    job.remediationPlan.currentRound = 1;
    const path = join(rootDir, 'data/follow-up-jobs', status, job.jobId + '.json');
    mkdirSync(join(path, '..'), { recursive: true });
    writeFollowUpJob(path, job);
  }
  const args = { rootDir, repo, prNumber, headSha: head, now: later,
    ciGate: { headSha: head, state: 'green', rollup: [green] } };
  const results = await Promise.all(Array.from({ length: concurrent ? 2 : 1 },
    () => recoverInfrastructureCiStops(args)));
  assert.equal(results.flat().length, 1);
  const pending = listFollowUpJobsInDir(rootDir, 'pending', { repo, prNumber });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].job.remediationPlan.currentRound, 0);
  assert.equal(['stopped', 'failed'].flatMap(key => listFollowUpJobsInDir(rootDir, key)).length, 1);
  assert.deepEqual(await recoverInfrastructureCiStops(args), []);
});

function audit(rootDir, check = failed) {
  writeAmaAuditEntry({ hqRoot: rootDir, repo, prNumber, headSha: head, now,
    attempt: { path: 'hammer', head, outcome: 'failed-without-merge', reason: 'github-gate-not-green',
      githubGate: { reasons: ['ci-not-green'], badChecks: [check] }, launchRequestId: 'fixture-infra' } });
}
function closureResult(field, rollup) {
  const snapshot = deriveNextActionSnapshot({ subjectKey: repo + '#' + prNumber, head,
    observedAt: now, observations: {
      pr: { headSha: head, state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', labels: [] },
      checks: { conclusion: 'SUCCESS', [field]: rollup }, remediation: { roundsLeft: false },
      reviews: { verdict: 'approved', headSha: head, blockingFindingState: 'known', blockingFindingCount: 0,
        nonBlockingFindingState: 'known', nonBlockingFindingCount: 0 },
      policy: { strictMode: true, autonomousMergeExecutionEnabled: true },
      leases: { closer: null }, launches: { closer: null }, controls: {},
    } });
  const shared = { snapshot, decision: nextAction(snapshot) };
  return bindClosureNextAction({ reason: shared.decision.reason, nextAction: shared.decision }, shared);
}

for (const field of ['rollup', 'statusCheckRollup']) {
  for (const replacement of [green, { ...green, name: 'unrelated' }]) {
    test(`automated recovery refunds only a matching green replacement in ${field}: ${replacement.name}`, async t => {
      const rootDir = root(t);
      const oldRoot = process.env.HQ_ROOT;
      process.env.HQ_ROOT = rootDir;
      t.after(() => { process.env.HQ_ROOT = oldRoot; });
      audit(rootDir);
      const dir = join(rootDir, 'data/follow-up-jobs/ama-automated-recovery');
      mkdirSync(dir, { recursive: true });
      const key = createHash('sha256').update(repo + '#' + prNumber + '@' + head).digest('hex');
      const path = join(dir, key + '.json');
      writeFileSync(path, JSON.stringify({ attempts: 1, event: { reason: 'automated-stop' },
        pagedReasons: ['automated-stop'], paged: true }));
      await recoverAmaAutomation({ rootDir, repo, prNumber, headSha: head,
        result: closureResult(field, [replacement]), reviewStateRow: {}, now: () => Date.parse(later), logger,
        dispatchHammer: async () => assert.fail('green head cannot launch a hammer'),
        pageImpl: async () => ({ id: 'fixture-page' }) });
      const state = JSON.parse(readFileSync(path));
      const recovered = replacement.name === 'unit';
      assert.equal(state.attempts, recovered ? 0 : 1);
      assert.equal(state.ciInfrastructureRecovery?.reason, recovered ? 'checks-executed-again' : undefined);
      assert.equal(Boolean(state.event), !recovered);
    });
  }
}

for (const executed of [false, true]) {
  test(`closure enriches historical CI stops before selecting the owner, executed=${executed}`, async t => {
    const rootDir = root(t);
    const check = { name: 'unit', conclusion: 'FAILURE',
      detailsUrl: `https://github.com/${repo}/actions/runs/10/job/1` };
    recordHammerRetryDispatch(rootDir, { repo, prNumber },
      { jobKey: head, headSha: head, launchRequestId: 'fixture-infra', now });
    audit(rootDir, check);
    assert.equal(isInfrastructureStop(readHammerStopForHead({ hqRoot: rootDir, repo, prNumber, headSha: head })), false);
    const body = '## Blocking issues\n- None.\n\n## Non-blocking issues\n- Synthetic finding\n\n## Verdict\nComment only';
    let evaluations = 0, reads = 0, evaluation;
    const result = await maybeDispatchAmaClosureFor({
      rootDir, repoPath: repo, prNumber, currentRevisionRef: head, env: { HQ_ROOT: rootDir },
      reviewStateRow: postedReview(body),
      dispatchJob: { remediationStopCode: 'max-rounds-reached' }, labelNames: [],
      candidate: { headSha: head, prState: 'OPEN', mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN', statusCheckRollup: [green] },
      now: () => Date.parse(later), logger,
      loadConfigImpl: () => ({ getMergeAuthorityConfig: () => ({ enabled: true }) }),
      fetchLatestHeadReviewBodiesImpl: async () => [body],
      fetchMergedProtectiveDependentsImpl: async () => [],
      requestEligibleHammerWakeImpl: () => ({ requested: false }),
      observeClosureWaitImpl: async () => ({ exhausted: true, retryAfterMs: 30_000 }),
      runDaemonCleanMergeAttemptImpl: async () => ({ disposition: 'not-taken' }),
      maybeDispatchAmaCloserImpl: async () => ({ dispatched: false, reason: 'fixture-stop' }),
      deliverAlertImpl: async () => {},
      evaluateHammerStopHoldImpl: async options => {
        evaluations++;
        evaluation = await evaluateHammerStopHold({ ...options,
          deliverAlertImpl: async () => {},
          fetchPrimaryChangeImpl: async () => ({ ok: false, reason: 'synthetic-unavailable' }),
          execFileImpl: async () => {
            reads++;
            return { stdout: JSON.stringify({ jobs: [{ id: 1, head_sha: head, conclusion: 'failure',
              steps: executed ? [{ conclusion: 'failure', status: 'completed' }] : [] }] }) };
          } });
        return evaluation;
      },
    });
    assert.equal(evaluations, 1, JSON.stringify(result));
    assert.equal(reads, 1);
    assert.equal(readHammerRetryCapLedger(rootDir, { repo, prNumber }).attemptCount, executed ? 1 : 0);
    if (executed) {
      assert.ok(!evaluation.changed?.includes('ci-infrastructure-recovered'),
        'ordinary gate recovery must not refund an executed failure as infrastructure');
    } else {
      assert.equal(evaluation.action, 'release');
      assert.deepEqual(evaluation.changed, ['ci-infrastructure-recovered']);
      assert.notEqual(result.nextAction?.reason, 'automated-stop');
    }
  });
}
