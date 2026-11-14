import './helpers/rate-limit-state-isolation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPrTenure, tenureReviewReason, tenureReviewRange, tenureReviewerAllowed,
  tenureHeadNeedsReview, queueTenureReview, readTenureReviewRange } from '../src/pr-tenure.mjs';
import { openReviewStateDb, ensureReviewStateSchema, requestReviewRereview } from '../src/review-state.mjs';
import { dispatchRemediationViaHq } from '../src/follow-up-remediation.mjs';
import { getHeadCloserCommitSuppression } from '../src/head-closer-commit-suppression.mjs';
import { resolveHamTerminalRemediationEvidence, composeCloserPrompt } from '../src/ama/dispatch-closer.mjs';
import { remediationCloseout, closeoutRereview } from '../src/remediation-closeout.mjs';
import { deriveNextActionSnapshot } from '../src/pr-next-action.mjs';
import { buildReviewerExtraContext, buildReviewerPrompt } from '../src/reviewer-prompt.mjs';
import { renderHammerProcedure } from '../src/hammer-procedure.mjs';
import { isDaemonMergeReviewAllowed } from '../src/ama/daemon-merge.mjs';

const repo = 'example/widget';
const previousHead = 'a'.repeat(40), headSha = 'b'.repeat(40), otherHead = 'c'.repeat(40);
const at = '2026-01-01T00:00:00.000Z';
const tenure = { tenureId: 'ten_fixture', workerClass: 'codex', launchRequestId: 'lrq_build' };
const quiet = { warn() {}, log() {}, error() {} };
function root(t) {
  const path = mkdtempSync(join(tmpdir(), 'ten-06-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

for (const tenureId of [undefined, null, '', 'ten_fixture']) {
  test(`build launch tenure routing: ${String(tenureId)}`, async () => {
    const result = await readPrTenure({ repo, prNumber: 7, env: {},
      readBuildIdentityImpl: async args => {
        assert.equal(args.headSha, undefined, 'stable opener survives remediation head movement');
        return { ok: true, rows: [{ launch_request_id: 'lrq_build', worker_class: 'codex' }] };
      },
      readLaunchesImpl: async selector => {
        assert.deepEqual(selector, { launch_request_ids: ['lrq_build'] });
        return { ok: true, rows: [{ launch_request_id: 'lrq_other', tenureId: 'ten_other' },
          { launch_request_id: 'lrq_build', tenureId }] };
      } });
    assert.deepEqual(result, tenureId ? tenure : null);
  });
}

test('unavailable launch evidence cannot establish untenured behavior', async () => {
  await assert.rejects(readPrTenure({ repo, prNumber: 7, env: {},
    readBuildIdentityImpl: async () => ({ ok: true, rows: [{ launch_request_id: 'lrq_build' }] }),
    readLaunchesImpl: async () => ({ ok: false }) }), /tenure-build-launch-unavailable/);
  assert.equal(await readPrTenure({ repo, prNumber: 7, env: {} }), null, 'standalone stays offline');
});

for (const sameTenure of [true, false]) test(`exact-head producer family binds to the PR tenure (same=${sameTenure})`, async () => {
  const result = await readPrTenure({ repo, prNumber: 7, headSha, env: {},
    readBuildIdentityImpl: async args => {
      assert.equal(args.headSha, undefined);
      return { ok: true, rows: [{ launch_request_id: 'lrq_build', worker_class: 'codex' }] };
    },
    readHeadProvenanceImpl: async selector => {
      assert.equal(selector.head_sha, headSha);
      assert.equal(selector.builder_identity, true);
      return { ok: true, rows: [{ launch_request_id: 'lrq_stage', head_sha: headSha, worker_class: 'hammer-claude' }] };
    },
    readLaunchesImpl: async selector => ({ ok: true, rows: selector.launch_request_ids.map(id => ({
      launch_request_id: id, tenureId: id === 'lrq_build' || sameTenure ? tenure.tenureId : 'ten_other',
      worker_class: id === 'lrq_build' ? 'codex' : 'hammer-claude',
    })) }),
  });
  assert.equal(tenureReviewerAllowed(result, 'codex'), false);
  assert.equal(tenureReviewerAllowed(result, 'claude'), !sameTenure);
  assert.equal(tenureReviewerAllowed(result, 'gemini'), true);
});

test('tenured native remediator keeps its class and PR alias; untenured argv is unchanged', async t => {
  const path = root(t);
  const calls = [];
  const args = {
    hqRoot: path, workerClass: 'remediator-codex', repo, prNumber: 7,
    branch: 'fixture/remediation', promptPath: join(path, 'prompt.md'), jobId: 'fixture-round',
    env: { HQ_ROOT: path, HQ_PARENT_SESSION: 'fixture-session', HQ_PROJECT: 'fixture',
      AGENT_OS_ROLES_ADVERSARIAL_ORCHESTRATION_MODE: 'agentos' },
    execFileImpl: async (_command, argv) => {
      calls.push(argv);
      return { stdout: JSON.stringify(argv[1] === 'status'
        ? { status: 'queued', workspacePath: path }
        : { launch_request_id: 'lrq_stage', dispatch_id: 'dispatch_stage' }) };
    },
  };
  const worker = await dispatchRemediationViaHq({ ...args, readPrTenureImpl: async () => tenure });
  assert.equal(worker.workerClass, 'remediator-codex');
  assert.equal(worker.originTenureId, tenure.tenureId);
  const boundArgv = calls[0];
  assert.equal(boundArgv[boundArgv.indexOf('--pr') + 1], '7');
  assert.equal(boundArgv[boundArgv.indexOf('--worker-class') + 1], 'remediator-codex');
  calls.length = 0;
  // Native is the reference argv. Only transport selection differs for tenure.
  const nativeArgs = { ...args, env: { ...args.env, AGENT_OS_ROLES_ADVERSARIAL_ORCHESTRATION_MODE: 'native' } };
  const unbound = await dispatchRemediationViaHq({ ...nativeArgs, readPrTenureImpl: async () => null });
  assert.deepEqual(calls[0], boundArgv);
  assert.equal('originTenureId' in unbound, false);
});

test('tenure refuses trailer and HAM certificate suppression', async () => {
  const result = await getHeadCloserCommitSuppression({ repoPath: repo, prNumber: 7, headSha,
    readPrTenureImpl: async () => tenure,
    activeHammerPublicationImpl: () => null,
    fetchVerifiedCommitFromLocalGitImpl: () => { throw new Error('must not certify a tenured head'); },
  });
  assert.deepEqual(result, { suppressed: false, reason: 'tenure-independent-review-required', headSha });
  assert.equal(await resolveHamTerminalRemediationEvidence({
    repoPath: repo, prNumber: 7, reviewState: { headSha: previousHead }, prMetadata: { headSha },
    readPrTenureImpl: async () => tenure,
    fetchHeadCloserVerifiedCommitImpl: () => { throw new Error('must not resolve certificate'); },
  }), null);
});

test('a live tenured publisher retains custody without certifying its head', async () => {
  const result = await getHeadCloserCommitSuppression({ repoPath: repo, prNumber: 7, headSha,
    readPrTenureImpl: async () => tenure,
    activeHammerPublicationImpl: () => ({ suppressed: true, reason: 'active-closer-merge-lease', headSha }),
  });
  assert.deepEqual(result, { suppressed: true, reason: 'closer-publication-unconfirmed', headSha });
});

test('untenured suppression returns the original publication result byte-for-byte', async () => {
  const original = { suppressed: true, reason: 'active-closer-published-head', headSha };
  assert.equal(await getHeadCloserCommitSuppression({ repoPath: repo, prNumber: 7, headSha,
    readPrTenureImpl: async () => null, activeHammerPublicationImpl: () => original }), original);
});

test('exact-head request persists remediation range, preserves budgets and never resets a live claim', t => {
  const rootDir = root(t), db = openReviewStateDb(rootDir);
  t.after(() => db.close());
  ensureReviewStateSchema(db);
  db.prepare(`INSERT INTO reviewed_prs
    (repo, pr_number, reviewed_at, reviewer, review_status, review_attempts, reviewer_head_sha, revision_ref)
    VALUES (?, 7, ?, 'gemini', 'posted', 4, ?, ?)`).run(repo, at, previousHead, previousHead);
  const request = args => requestReviewRereview({ rootDir, db, logger: quiet, ...args });
  const first = queueTenureReview({ db, request, repo, prNumber: 7, previousHead, headSha });
  assert.equal(first.triggered, true);
  let row = db.prepare('SELECT * FROM reviewed_prs').get();
  assert.equal(row.revision_ref, headSha);
  assert.equal(row.review_status, 'pending');
  assert.equal(row.review_attempts, 4);
  assert.deepEqual(readTenureReviewRange({ rootDir, repo, prNumber: 7, headSha }), { previousHead, headSha });
  assert.equal(readTenureReviewRange({ rootDir, repo, prNumber: 7, headSha: otherHead }), null);
  db.prepare(`UPDATE reviewed_prs SET revision_ref = ?, infra_auto_recover_attempts = 2,
    review_population_retry_attempts = 3`).run(previousHead);
  queueTenureReview({ db, request, repo, prNumber: 7, previousHead, headSha });
  row = db.prepare('SELECT * FROM reviewed_prs').get();
  assert.equal(row.revision_ref, headSha);
  assert.equal(row.review_attempts, 4);
  assert.equal(row.infra_auto_recover_attempts, 2);
  assert.equal(row.review_population_retry_attempts, 3);
  assert.deepEqual(readTenureReviewRange({ rootDir, repo, prNumber: 7, headSha }), { previousHead, headSha });
  db.prepare("UPDATE reviewed_prs SET review_status = 'reviewing', reviewer_head_sha = ?").run(headSha);
  queueTenureReview({ db, request, repo, prNumber: 7, previousHead, headSha });
  row = db.prepare('SELECT * FROM reviewed_prs').get();
  assert.equal(row.review_status, 'reviewing');
  assert.equal(row.review_attempts, 4);
  db.prepare("UPDATE reviewed_prs SET review_status = 'posted'").run();
  const settled = queueTenureReview({ db, request, repo, prNumber: 7, previousHead, headSha });
  assert.equal(settled.reason, 'exact-head-already-reviewed');
  assert.equal(db.prepare('SELECT review_status FROM reviewed_prs').get().review_status, 'posted');
  db.prepare("UPDATE reviewed_prs SET review_status = 'pending', pr_state = 'merged', rereview_reason = NULL").run();
  queueTenureReview({ db, request, repo, prNumber: 7, previousHead, headSha });
  row = db.prepare('SELECT * FROM reviewed_prs').get();
  assert.equal(row.pr_state, 'merged');
  assert.equal(row.rereview_reason, null, 'terminal state cannot receive a new review intent');
});

test('reviews-next-round family predicate excludes the author and its aliases', () => {
  for (const workerClass of ['codex', 'clio-agent', 'remediator-codex']) {
    assert.equal(tenureReviewerAllowed({ ...tenure, workerClass }, 'codex'), false);
    assert.equal(tenureReviewerAllowed({ ...tenure, workerClass }, 'claude'), true);
    assert.equal(tenureReviewerAllowed({ ...tenure, workerClass }, 'gemini'), true);
  }
  assert.equal(tenureReviewerAllowed({ workerClass: 'unknown' }, 'gemini'), false);
});

test('final remediation queues independent review through the existing full-review owner', t => {
  const rootDir = root(t);
  const job = { repo, prNumber: 7, revisionRef: previousHead, status: 'in_progress',
    finalRound: 'comment-only', reviewBody: '## Blocking issues\n- None.\n## Verdict\nComment only',
    remediationWorker: { originTenureId: tenure.tenureId },
    remediationPlan: { currentRound: 2, maxRounds: 2 } };
  const snapshot = deriveNextActionSnapshot({ subjectKey: repo, head: headSha, observedAt: at,
    observations: { policy: { autonomousMergeExecutionEnabled: true, strictMode: true },
      leases: { closer: null }, launches: { closer: null } } });
  const decide = candidate => remediationCloseout({ rootDir, job: candidate, snapshot, completedAt: at,
    headSha, workerPushedHeadSha: headSha, ciGate: { state: 'green', headSha } });
  const bound = decide(job), reReview = closeoutRereview(bound);
  assert.equal(bound.decision.action, 'review');
  assert.equal(bound.decision.head, headSha);
  assert.equal(reReview.requested, true);
  assert.equal(reReview.reason, tenureReviewReason(previousHead, headSha));
  assert.equal(reReview.suppressed, undefined);
  const unbound = decide({ ...job, remediationWorker: {} });
  assert.equal(unbound.decision.action, 'hammer');
  assert.equal(closeoutRereview(unbound).requested, false);
});

for (const slim of [false, true]) test(`review prompt contains exact remediation range (slim=${slim})`, async () => {
  const context = await buildReviewerExtraContext({ repo, prNumber: 7, prContext: { headRefOid: headSha },
    reviewModeDecision: { slim, lowRiskClasses: [], stats: { files: 1, added: 1, removed: 0 } }, log: quiet,
    readTenureReviewRangeImpl: () => ({ previousHead, headSha }),
    readFindingDisputeReservationsImpl: () => [], fetchLinkedSpecContentsImpl: async () => '',
    buildHardeningReviewContextImpl: async () => '',
  });
  const prompt = buildReviewerPrompt({ promptPrefix: 'Review.', extraContext: context, diff: 'fixture' });
  assert.ok(prompt.includes(`Remediation range: ${previousHead}..${headSha}`));
  assert.ok(prompt.includes(`exact head ${headSha}`));
});

test('closer class remains separate; rendered controller inputs and in-lease refusal carry tenure', () => {
  const templateBody = readFileSync(new URL('../templates/hammer-prompt.md', import.meta.url), 'utf8');
  const inputs = { templateBody, repo, prNumber: 7, reviewedSha: previousHead, targetRemediationSha: previousHead,
    hqRoot: '/fixture', rootDir: '/fixture/reviewer', scratchDir: '/fixture/run', amaTrailers: '' };
  assert.equal(composeCloserPrompt(inputs), composeCloserPrompt({ ...inputs, tenureId: null }));
  const prompt = composeCloserPrompt({ ...inputs, tenureId: tenure.tenureId });
  assert.match(prompt, /Keep your merge-authority class and principal/);
  assert.match(prompt, /export HAM_TENURE_REVIEW_REQUIRED=1/);
  const source = readFileSync(new URL('../bin/hammer-merge.sh', import.meta.url), 'utf8');
  const values = Object.fromEntries([...source.matchAll(/<<([A-Z_]+)>>/g)].map(([, key]) => [key, 'fixture']));
  const rendered = renderHammerProcedure('hammer-merge', { ...values, TENURE_REVIEW_ARG: '--tenure-review ' });
  assert.match(rendered, /--tenure-review --reviewed-sha/);
  assert.match(rendered, /eligibility\.reasons\.push\('tenure-independent-review-required'\)/);
  assert.equal(tenureHeadNeedsReview(true, previousHead, headSha), true);
  assert.equal(tenureHeadNeedsReview(true, headSha, headSha), false);
  assert.equal(tenureHeadNeedsReview(false, previousHead, headSha), false);
  assert.equal(tenureReviewRange(tenureReviewReason(previousHead, headSha), otherHead), null);
});

test('strict_mode still rejects non-blocking findings and unknown classifications', () => {
  const review = { blockingFindingState: 'known', blockingFindingCount: 0,
    nonBlockingFindingState: 'known', nonBlockingFindingCount: 1 };
  assert.equal(isDaemonMergeReviewAllowed(review), false);
  assert.equal(isDaemonMergeReviewAllowed(review, { strictMode: false }), true);
  assert.equal(isDaemonMergeReviewAllowed({ ...review, blockingFindingCount: 1 }, { strictMode: false }), false);
  assert.equal(isDaemonMergeReviewAllowed({ ...review, nonBlockingFindingState: 'unknown' }, { strictMode: false }), false);
});
