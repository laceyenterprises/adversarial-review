import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFinalRemediationIntegration } from '../src/final-remediation-integration.mjs';
import { currencyGit } from '../src/ama/review-currency.mjs';

const repo = 'fixture/repo';
const prNumber = 42;
const branch = 'fixture-branch';
const reviewBody = '## Blocking issues\n- None.\n\n## Non-blocking issues\n- None.\n\n## Verdict\nComment only';

function fixture(t, { alteredMerge = false, rerooted = false, additionalCommit = false } = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'final-integration-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const run = (...args) => execFileSync('git', args, { cwd: rootDir, encoding: 'utf8', timeout: 5000,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (file, content) => writeFileSync(join(rootDir, file), `${content}\n`);
  const commit = message => {
    run('add', '-A');
    run('commit', '-qm', message);
    return run('rev-parse', 'HEAD');
  };
  run('init', '-qb', 'main');
  run('config', 'user.name', 'Fixture');
  run('config', 'user.email', 'fixture@example.invalid');
  write('source', 'base');
  const fork = commit('base');
  run('checkout', '-qb', branch);
  write('source', 'reviewed');
  const reviewedHead = commit('reviewed');
  if (rerooted) run('checkout', '-qb', 'rerooted-repair', fork);
  write('source', 'fixed');
  const published = commit('repair');
  if (rerooted) run('branch', '-f', branch, published);
  run('checkout', '-q', 'main');
  write('upstream', 'upstream');
  const main = commit('advance main');
  write('follow-on', 'follow-on');
  const base = commit('advance main again');
  run('checkout', '-q', branch);
  run('merge', '--no-ff', '--no-commit', main);
  if (alteredMerge) write('source', 'extra unreviewed edit');
  const integration = commit('integrate main');
  if (additionalCommit) write('extra', 'extra');
  const headSha = additionalCommit ? commit('follow-on change') : integration;
  const jobId = 'fixture__repo-pr-42-final';
  const job = {
    kind: 'adversarial-review-follow-up', jobId, repo, prNumber, branch, baseBranch: 'main',
    status: 'completed', finalRound: 'comment-only', nonBlockingOnly: true, revisionRef: reviewedHead,
    reviewBody, reviewerModel: 'gemini', createdAt: '2026-11-26T21:50:01Z',
    reReview: { requested: false, status: 'suppressed', suppressed: 'comment-only-final-round',
      nextAction: { head: published } },
    completion: { finalRemediationPush: true, workerPushedHeadSha: published,
      workerPushProof: { method: 'git-cherry-replay', workerCommits: 1 },
      finalRoundOutcome: { completed: true, push: 'descendant' } },
    remediationWorker: { state: 'completed', launchRequestId: jobId },
    remediationPlan: { currentRound: 1, rounds: [
      { round: 1, state: 'completed', startHeadSha: reviewedHead,
        resultingHeadSha: published, publishedHeadSha: published },
    ] },
  };
  const live = {
    number: prNumber, state: 'open', head: { sha: headSha, ref: branch, repo: { full_name: repo } },
    base: { ref: 'main', sha: base, repo: { full_name: repo } },
  };
  const reviews = [{ state: 'COMMENTED', user: { login: 'gemini-reviewer-lacey[bot]', type: 'Bot' },
    commit_id: reviewedHead, body: reviewBody, submitted_at: '2026-11-26T21:50:00Z' }];
  const proof = async ({ destination = live, refresh = destination, reviewsRead = reviews } = {}) => {
    const dir = join(rootDir, 'data', 'follow-up-jobs', job.status);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${jobId}.json`), JSON.stringify(job));
    let reads = 0;
    return readFinalRemediationIntegration({ rootDir, repo, prNumber, reviewedHead, headSha,
      git: (args, input, options) => currencyGit(args, input, { cwd: rootDir, ...options }),
      get: async endpoint => endpoint.endsWith('/reviews?per_page=100') ? reviewsRead
        : ++reads === 1 ? destination : refresh,
    });
  };
  return { proof, job, live, reviews, reviewedHead, headSha, fork };
}

test('LAC-2442: one direct exact main integration retains a protected handoff with a later main tip', async t => {
  const f = fixture(t);
  assert.deepEqual(await f.proof(), { revisionRef: f.reviewedHead, head: f.headSha });
});

test('LAC-2442: the final fix-all receipt also retains custody across the exact merge', async t => {
  const f = fixture(t);
  delete f.job.reviewerModel;
  f.job.closureHandoff = { reason: 'final-fix-all', headSha: f.reviewedHead };
  f.job.reReview.suppressed = 'shared-next-action';
  f.job.completion.workerPushProof.producedAttestationId = 'fixture-verified-produced-receipt';
  Object.assign(f.job.remediationWorker, { dispatchId: 'fixture-dispatch', launchRequestId: 'fixture-launch',
    dispatchMode: 'hq', requiresProducedAttestation: true });
  assert.deepEqual(await f.proof(), { revisionRef: f.reviewedHead, head: f.headSha });
});

for (const [name, change] of [
  ['stopped job', f => { f.job.status = 'stopped'; }],
  ['missing structural proof', f => { delete f.job.completion.workerPushProof; }],
  ['missing explicit published head', f => { delete f.job.remediationPlan.rounds[0].publishedHeadSha; }],
  ['requested rereview', f => { f.job.reReview.requested = true; }],
  ['unavailable native producer proof', f => {
    Object.assign(f.job.remediationWorker, { dispatchId: 'fixture', requiresProducedAttestation: true });
  }],
  ['stale main before the integration', f => { f.live.base.sha = f.fork; }],
  ['different destination', f => { f.live.head.ref = 'different'; }],
  ['fork destination', f => { f.live.head.repo.full_name = 'other/repo'; }],
  ['terminal PR', f => { f.live.state = 'closed'; }],
  ['source review from an unrecognized bot', f => { f.reviews[0].user.login = 'fixture-bot[bot]'; }],
  ['later human review', f => {
    f.reviews.push({ state: 'CHANGES_REQUESTED', commit_id: f.headSha, user: { type: 'User' },
      submitted_at: '2026-11-26T22:00:00Z' });
  }],
  ['new findings from the source reviewer on the integration', f => {
    f.reviews.push({ ...f.reviews[0], commit_id: f.headSha, submitted_at: '2026-11-26T22:00:00Z' });
  }],
]) {
  test(`LAC-2442: integration refuses ${name}`, async t => {
    const f = fixture(t);
    change(f);
    assert.equal(await f.proof(), null);
  });
}

test('LAC-2442: a source edit in the merge invalidates exact replay', async t => {
  assert.equal(await fixture(t, { alteredMerge: true }).proof(), null);
});

test('LAC-2442: a rerooted source lacks ordinary ancestry', async t => {
  assert.equal(await fixture(t, { rerooted: true }).proof(), null);
});

test('LAC-2442: a successor after an exact merge cannot inherit custody', async t => {
  assert.equal(await fixture(t, { additionalCommit: true }).proof(), null);
});

test('LAC-2442: movement during proof invalidates the handoff', async t => {
  const f = fixture(t);
  assert.equal(await f.proof({ refresh: { ...f.live, head: { ...f.live.head, sha: f.reviewedHead } } }), null);
});
