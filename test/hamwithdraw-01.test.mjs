import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReviewCurrencyReader, carryHammerWithdrawals, rebaseCurrencyCovers } from '../src/ama/review-currency.mjs';
import { isCurrentAuthoritativeFamilyReview, latestAuthoritativeReviewInAncestry } from '../src/ama/reviewer-authority.mjs';
import { disputeFinding } from '../src/ama/finding-dispute.mjs';
import { readHammerWithdrawals, hammerWithdrawalsFromComments, resolveHammerAdjudication, blockingFindingIdentitiesFromBody } from '../src/ama/hammer-adjudication.mjs';
import { dismissWithdrawnReviews } from '../src/ama/withdrawn-review-dismissal.mjs';
import { ensureReviewStateSchema, openReviewStateDb } from '../src/review-state.mjs';
import { isEligibleForAmaClosure } from '../src/ama/eligibility.mjs';
import { buildAdversarialGateSnapshot, pickAdversarialGateStatus } from '../src/adversarial-gate-status.mjs';
import { PR_ROUND_KINDS, recordPrRound } from '../src/pr-round-ledger.mjs';

const repo = 'fixture/repo', prNumber = 42;
const body = '## Blocking issues\n- **Prefix already present**\n  - **File:** `feature.txt`\n  - **Problem:** Prefix absent.\n\n## Non-blocking issues\n- None.\n\n## Verdict\nRequest changes';
const evidence = '```\n$ git show HEAD:feature.txt\nprefix: feature\n```';

test('REBASECURRENCY-01: conflict resolution needs hammer provenance to carry review currency', async t => {
  const f = await fixture(t, { changed: true });
  // Source resolution changes the patch: a PR-update rebase has no currency proof.
  assert.equal((await f.currency()(f.a, f.b, { rebaseOnly: true })).current, false);
  const body = `HAM-Base-Head: ${f.a}\nHAM-Validated-Head: ${f.b}`;
  f.comments.push({ user: { login: 'fixture-builder[bot]' }, body });
  assert.equal((await f.currency()(f.a, f.b, { rebaseOnly: true })).current, false);
  f.comments.push({ user: { login: 'the-hammer-lacey[bot]' }, body });
  const currency = await f.currency()(f.a, f.b, { rebaseOnly: true });
  assert.equal(currency.current, true);
  assert.equal(currency.proof, 'closer-rebase-provenance');
  assert.equal((await f.currency()(f.a, 'c'.repeat(40), { rebaseOnly: true })).current, false);
});

test('LAC-2331 preserves genuine rerooted patch equivalence when Hammer evidence is capped', async t => {
  const f = await fixture(t);
  const pages = [];
  const currency = createReviewCurrencyReader({ repo, prNumber, rootDir: f.dir, cwd: f.dir,
    get: path => {
      if (!path.includes('/comments?')) return f.get(path);
      pages.push(path);
      return Array.from({ length: 100 }, () => ({ body: '' }));
    } });
  assert.equal((await currency(f.a, f.b, { rebaseOnly: true })).proof, 'reviewed-rebase-patch-id');
  assert.equal(pages.length, 10);
});

async function fixture(t, { changed = false, remediation = false, binary = false, twoPatches = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hamwithdraw-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', timeout: 5000,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  const git = async (args, input) => execFileSync('git', args, { cwd: dir, input, encoding: 'utf8', timeout: 5000 });
  const write = (path, text) => writeFileSync(join(dir, path), text);
  const commit = message => { run('add', '--all'); run('commit', '-qm', message); return run('rev-parse', 'HEAD'); };
  run('init', '-q'); run('config', 'user.name', 'Fixture'); run('config', 'user.email', 'fixture@example.invalid');
  write('initial.txt', 'initial\n');
  if (binary) write('feature.txt', Buffer.from([0, 1, 255]));
  const fork = commit('Initial');
  write('feature.txt', binary ? Buffer.from([0, 2, 255]) : 'prefix: feature\n'); let a = commit('Feature');
  if (twoPatches) {
    write('detail.txt', 'Reviewed detail\n');
    a = commit('Detail');
  }
  const review = { id: 17, node_id: 'PRR_17', html_url: 'https://github.com/fixture/repo/pull/42#pullrequestreview-17',
    commit_id: a, state: 'CHANGES_REQUESTED', user: { login: 'lacey-codex-reviewer[bot]' }, body };
  let live = a;
  const reviews = [review], comments = [], posted = [], dismissed = [], authenticatedCommits = new Map();
  const db = openReviewStateDb(dir); ensureReviewStateSchema(db); t.after(() => db.close());
  const get = async path => {
    if (path.includes('/reviews?')) return reviews;
    if (path.endsWith('/reviews/17')) return review;
    if (path.includes('/comments?')) return comments;
    if (path.includes('/commits/')) return authenticatedCommits.get(path.split('/commits/')[1]) || {};
    if (path.includes('/compare/')) {
      const [from, to] = path.split('/compare/')[1].split('...');
      try { run('merge-base', '--is-ancestor', from, to); return { status: from === to ? 'identical' : 'ahead' }; } catch { /* divergent or reset */ }
      try { run('merge-base', '--is-ancestor', to, from); return { status: 'behind' }; } catch { return { status: 'diverged' }; }
    }
    return { state: 'open', head: { sha: live }, base: { sha: base } };
  };
  // The exact-head admission needs no base read.
  let base = fork;
  const args = { rootDir: dir, repo, prNumber, headSha: a, reviewRef: review.node_id, findingNumber: 1, evidence };
  const deps = { db, get, git, logger: {}, postComment: async body => {
    posted.push(body);
    const comment = { node_id: `IC_${posted.length}`, body, user: { login: 'the-hammer-lacey[bot]' } };
    comments.push(comment); return comment;
  } };
  await disputeFinding(args, deps);
  run('checkout', '-qb', 'replay', fork);
  write('base.txt', 'new base\n'); base = commit('Base advancement');
  write('feature.txt', binary ? Buffer.from([0, changed ? 3 : 2, 255]) : changed ? 'unreviewed feature\n' : 'prefix: feature\n');
  let replay = commit('Replayed feature');
  if (twoPatches) {
    write('detail.txt', 'Reviewed detail\n');
    replay = commit('Replayed detail');
  }
  if (remediation) {
    write('repair.txt', 'remediation\n');
    const message = `Repair\n\nWorker-Class: hammer\nWorker-Ticket: HAM\nReviewed-Head: ${a}\nClosed-By: hammer (adversarial-pipe-mode)`;
    const sha = commit(message);
    authenticatedCommits.set(sha, { sha, author: { login: 'hammer-worker' }, commit: { message } });
  }
  const b = run('rev-parse', 'HEAD'); live = b;
  const currency = () => createReviewCurrencyReader({ repo, prNumber, get, git });
  const withdrawals = () => hammerWithdrawalsFromComments(comments, readHammerWithdrawals({ rootDir: dir, repo, prNumber }));
  const state = { headSha: a, reviewedHead: a, currentHead: b, verdict: 'request-changes', riskClass: 'low', remediationPending: false,
    blockingFindingState: 'known', blockingFindingCount: 1, blockingFindingIdentities: blockingFindingIdentitiesFromBody(body),
    nonBlockingFindingState: 'known', nonBlockingFindingCount: 0, nonBlockingFindingIdentities: [] };
  const pr = { prNumber, headSha: b, isOpen: true, isDraft: false, mergeableState: 'MERGEABLE', labels: [],
    statusCheckRollup: [{ __typename: 'CheckRun', name: 'lint', conclusion: 'SUCCESS' }] };
  return { dir, a, b, base, replay, run, get, git, write, commit, review, reviews, comments, posted, args, deps, state, pr, authenticatedCommits,
    currency, withdrawals, setLive: sha => { live = sha; }, dismiss: async path => { dismissed.push(path); review.state = 'DISMISSED'; }, dismissed };
}

const laneJob = 'fixture__repo-pr-42-remediation';
function appendLaneCommit(f, message, suffix = 'first') {
  f.write(`${suffix}-repair.txt`, 'Remediation\n');
  const sha = f.commit(message);
  f.authenticatedCommits.set(sha, { sha, commit: { message } });
  f.setLive(sha);
  return sha;
}

function recordLanePublication(f, sha, worker = { model: 'codex', launchRequestId: laneJob }) {
  const dir = join(f.dir, 'data', 'follow-up-jobs', 'completed');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${laneJob}.json`), JSON.stringify({
    repo, prNumber, kind: 'adversarial-review-follow-up', status: 'completed', jobId: laneJob,
    remediationPlan: { rounds: [{
      state: 'completed', startHeadSha: f.a, resultingHeadSha: sha,
      worker: { state: 'completed', ...worker }, completion: { workerPushedHeadSha: sha },
    }] },
  }));
}

for (const scenario of ['attributed', 'unattributed', 'changed-prefix', 'newer-review', 'unattributed-tail']) {
  test(`DISPUTECURRENCY-01: blocking dispute with lane suffix scenario ${scenario}`, async t => {
    const f = await fixture(t, { twoPatches: true, changed: scenario === 'changed-prefix' });
    const repair = appendLaneCommit(f, `Repair\n\nWorker-Class: codex-remediation\nWorker-Job-Id: ${laneJob}`);
    if (scenario !== 'unattributed') recordLanePublication(f, repair);
    const head = scenario === 'unattributed-tail' ? appendLaneCommit(f, 'Unidentified edit', 'second') : repair;
    const currency = createReviewCurrencyReader({ repo, prNumber, rootDir: f.dir, get: f.get, git: f.git });
    const applicability = await currency(f.a, head);
    if (scenario === 'attributed' || scenario === 'newer-review') {
      assert.equal(applicability.proof, 'reviewed-rebase-lane-suffix');
      assert.equal(rebaseCurrencyCovers(applicability, f.a, head), false);
      assert.equal((await currency(f.a, head, { rebaseOnly: true })).current, false);
    } else {
      assert.equal(applicability.current, false);
    }
    if (scenario === 'newer-review') {
      f.reviews.push({ ...f.review, id: 18, node_id: 'PRR_18', commit_id: f.replay });
    }
    const dispute = disputeFinding({ ...f.args, headSha: head }, f.deps);
    if (scenario === 'attributed') {
      assert.equal((await dispute).headSha, head, 'requires fresh evidence after a lane commit');
      assert.equal(f.posted.length, 2, 'does not reuse the withdrawal from the reviewed head');
    } else {
      await assert.rejects(dispute, { phaseOutcome: 'dispute-review-currency-unproven' });
      assert.equal(f.posted.length, 1);
    }
  });
}

test('DISPUTECURRENCY-01: HQ remediation receipt requires its own verified launch', async t => {
  const f = await fixture(t, { twoPatches: true });
  const head = appendLaneCommit(f, `Repair\n\nWorker-Class: codex-remediation\nWorker-Job-Id: ${laneJob}`);
  const worker = { workerClass: 'remediator-codex', launchRequestId: 'lrq_fixture', dispatchMode: 'hq' };
  recordLanePublication(f, head, worker);
  let launchRequestId = 'lrq_other';
  const currency = () => createReviewCurrencyReader({ repo, prNumber, rootDir: f.dir, get: f.get, git: f.git,
    readHeadAttestations: async () => [{ repo, pr_number: prNumber, head_sha: head, kind: 'produced', valid: true,
      payload: { launch_request_id: launchRequestId, worker_class: worker.workerClass } }],
  });
  assert.equal((await currency()(f.a, head)).current, false);
  launchRequestId = worker.launchRequestId;
  assert.equal((await currency()(f.a, head)).proof, 'reviewed-rebase-lane-suffix');
});

test('DISPUTECURRENCY-01: in-place update requires a launch attestation and a round for each suffix commit', async t => {
  const f = await fixture(t, { twoPatches: true });
  const first = appendLaneCommit(f, 'First update');
  const head = appendLaneCommit(f, 'Second update', 'second');
  const produced = sha => ({ repo, pr_number: prNumber, head_sha: sha, kind: 'produced', valid: true,
    payload: { source: 'hq_branch_push', launch_request_id: 'lrq_fixture', worker_class: 'codex' } });
  let reads = 0;
  let attestations = [produced(first), produced(head)];
  const currency = () => createReviewCurrencyReader({ repo, prNumber, rootDir: f.dir, get: f.get, git: f.git,
    readHeadAttestations: async () => { reads++; return attestations; } });
  const record = sha => recordPrRound(f.dir, { repo, prNumber, kind: PR_ROUND_KINDS.HQ_PR_UPDATE,
    roundId: `hq-pr-update:${sha}`, headSha: sha });
  record(head);
  assert.equal((await currency()(f.a, head)).current, false, 'a signed head without an update round cannot activate the proof');
  assert.equal(reads, 0);
  record(first);
  assert.equal((await currency()(f.a, head)).proof, 'reviewed-rebase-lane-suffix');
  assert.equal(reads, 1, 'the same verified chain covers both exact heads');
  attestations = [produced(first), { ...produced(head), pr_number: prNumber + 1 }];
  assert.equal((await currency()(f.a, head)).current, false);
});

for (const proof of ['provenance', 'patch-id']) {
  test(`HAMWITHDRAW-01: withdraw at A, closer rebase to B, next closer proceeds via ${proof}`, async t => {
    const f = await fixture(t, { remediation: true });
    assert.equal((await f.get(`repos/${repo}/compare/${f.a}...${f.b}`)).status, 'diverged');
    if (proof === 'provenance') {
      f.comments.push({ user: { login: 'the-hammer-lacey[bot]' }, body: `HAM-Base-Head: ${f.a}\nHAM-Validated-Head: ${f.b}` });
    }
    const currency = f.currency();
    const admitted = await currency(f.a, f.b);
    assert.equal(admitted.current, true, JSON.stringify(admitted));
    assert.equal(admitted.proof, proof === 'provenance' ? 'closer-rebase-provenance' : 'reviewed-rebase-patch-id');
    const compare = (from, to) => f.get(`repos/${repo}/compare/${from}...${to}`);
    assert.equal(await latestAuthoritativeReviewInAncestry([f.review], f.b, compare, currency), f.review);
    assert.equal(await isCurrentAuthoritativeFamilyReview(f.review, [f.review], f.b, compare, currency), true);
    const withdrawals = await carryHammerWithdrawals(f.withdrawals(), f.b, currency);
    assert.equal(resolveHammerAdjudication(f.state, withdrawals).allBlockingWithdrawn, true);
    const state = { ...f.state, reviewCurrency: admitted };
    const verdict = isEligibleForAmaClosure(state, f.pr,
      { enabled: true, eligibility: { riskClasses: ['low'] }, branchProtection: { required: false } },
      { env: {}, primaryChange: { headSha: f.b, hasHammerCommits: false }, hammerWithdrawnFindings: withdrawals });
    assert.equal(verdict.eligible, true, JSON.stringify(verdict.reasons));
    assert.equal(verdict.trace.verdict.hammerAdjudication.withdrawnCount, 1);
    const gate = pickAdversarialGateStatus({ reviewRow: { review_status: 'posted', reviewer_head_sha: f.a, review_body: body },
      latestJob: { status: 'stopped', reviewBody: body }, headSha: f.b, hammerWithdrawals: withdrawals, reviewCurrency: admitted });
    assert.equal(gate.reason, 'hammer-adjudicated');
    assert.doesNotMatch(gate.description, /operator recovery|operator decision/i);
    // No second comment and no durable-head rewrite after a proven rebase.
    assert.equal((await disputeFinding({ ...f.args, headSha: f.b }, f.deps)).alreadyRecorded, true);
    assert.equal(f.posted.length, 1);
    assert.equal(f.withdrawals()[0].headSha, f.a);
    await dismissWithdrawnReviews({ rootDir: f.dir, repo, prNumber, headSha: f.b,
      expectedWithdrawnIdentities: f.state.blockingFindingIdentities }, { ...f.deps, dismiss: f.dismiss });
    assert.equal(f.dismissed.length, 1);
  });
}

for (const scenario of ['changed patch', 'third-party push', 'untrusted provenance', 'untrusted remediation', 'missing objects']) {
  test(`HAMWITHDRAW-01: ${scenario} supplies neither finding nor withdrawal currency and no merge`, async t => {
    const f = await fixture(t, { changed: scenario === 'changed patch', remediation: scenario === 'untrusted remediation' });
    if (scenario === 'third-party push') {
      f.comments.push({ user: { login: 'the-hammer-lacey[bot]' }, body: `HAM-Base-Head: ${f.a}\nHAM-Validated-Head: ${f.b}` });
      writeFileSync(join(f.dir, 'foreign.txt'), 'foreign edit\n'); f.run('add', 'foreign.txt'); f.run('commit', '-qm', 'Foreign push');
    }
    const head = f.run('rev-parse', 'HEAD'); f.setLive(head);
    if (scenario === 'untrusted provenance') {
      // Valid-looking fields from a builder cannot attest a changed replay.
      writeFileSync(join(f.dir, 'foreign.txt'), 'foreign edit\n'); f.run('add', 'foreign.txt'); f.run('commit', '-qm', 'Foreign push');
      f.setLive(f.run('rev-parse', 'HEAD'));
      f.comments.push({ user: { login: 'pr-author' }, body: `HAM-Base-Head: ${f.a}\nHAM-Validated-Head: ${f.run('rev-parse', 'HEAD')}` });
    }
    if (scenario === 'untrusted remediation') f.authenticatedCommits.clear();
    const currentHead = f.run('rev-parse', 'HEAD');
    const currency = scenario === 'missing objects'
      ? createReviewCurrencyReader({ repo, prNumber, get: f.get, git: async () => { throw new Error('reviewed Git object unavailable'); } }) : f.currency();
    const admitted = await currency(f.a, currentHead);
    assert.equal(admitted.current, false, JSON.stringify(admitted));
    assert.match(admitted.missingProof, /HAM base\/head provenance or patch-equivalent PR commits/);
    const state = { ...f.state, currentHead, reviewCurrency: admitted };
    const withdrawals = await carryHammerWithdrawals(f.withdrawals(), currentHead, currency);
    assert.equal(resolveHammerAdjudication(state, withdrawals).withdrawnCount, 0);
    assert.equal(await latestAuthoritativeReviewInAncestry([f.review], currentHead,
      (from, to) => f.get(`repos/${repo}/compare/${from}...${to}`), currency), undefined);
    const verdict = isEligibleForAmaClosure(state, { ...f.pr, headSha: currentHead }, { enabled: true },
      { env: {}, primaryChange: { headSha: currentHead, hasHammerCommits: false }, hammerWithdrawnFindings: withdrawals });
    assert.equal(verdict.eligible, false);
    assert.ok(verdict.reasons.includes('review-currency-unproven'));
    assert.ok(!verdict.reasons.includes('blocking-findings-present'), 'a non-current review must not contribute blockers');
    assert.equal(verdict.trace.headMatch.reviewCurrency.missingProof, admitted.missingProof);
  });
}

test('HAMWITHDRAW-01: a newer authoritative family review supersedes rebase-carried findings and withdrawals', async t => {
  const f = await fixture(t);
  const newer = { ...f.review, node_id: 'PRR_18', commit_id: f.b, state: 'APPROVED' };
  assert.equal(await isCurrentAuthoritativeFamilyReview(f.review, [f.review, newer], f.b,
    (from, to) => f.get(`repos/${repo}/compare/${from}...${to}`), f.currency()), false);
});

test('HAMWITHDRAW-01: ama-check uses the same durable withdrawal despite unrelated timeline events', async t => {
  const f = await fixture(t, { changed: true });
  f.comments.push({ event: 'commented', user: { login: 'the-hammer-lacey[bot]' }, body: `HAM-Base-Head: ${f.a}\nHAM-Validated-Head: ${f.b}` });
  const timeline = [...Array.from({ length: 1000 }, () => ({ event: 'labeled' })), ...f.comments];
  const file = (name, value) => { const path = join(f.dir, name); writeFileSync(path, JSON.stringify(value)); return path; };
  const config = join(f.dir, 'global.yaml');
  writeFileSync(config, 'version: 1\nroles:\n  adversarial:\n    merge_authority:\n      enabled: true\n      eligibility:\n        risk_classes: [low]\n      branch_protection:\n        required: false\n');
  const result = spawnSync(process.execPath, [new URL('../bin/ama-check.mjs', import.meta.url).pathname,
    '--repo', repo, '--root-dir', f.dir, '--reviewed-sha', f.a, '--reviewer', 'codex', '--risk-class', 'low',
    '--pr', file('pr.json', { number: prNumber, headRefOid: f.b, baseRefOid: f.base, state: 'OPEN', isDraft: false,
      mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', labels: [], statusCheckRollup: f.pr.statusCheckRollup }),
    '--reviews', file('reviews.json', { reviews: [{ ...f.review, submitted_at: '2026-01-01T00:00:00Z' }] }),
    '--timeline', file('timeline.json', timeline), '--protection', file('protection.json', {}),
    '--primary-change', file('primary.json', { headSha: f.b, hasHammerCommits: false })],
  { cwd: f.dir, encoding: 'utf8', timeout: 15000, env: { ...process.env, AGENT_OS_CONFIG_PATH: config } });
  assert.equal(result.status, 0, result.stderr);
  const verdict = JSON.parse(result.stdout);
  assert.equal(verdict.eligible, true, JSON.stringify(verdict.reasons));
  assert.equal(verdict.trace.verdict.hammerAdjudication.withdrawnCount, 1);
});


for (const proof of ['provenance', 'patch-id']) {
  test(`HAMWITHDRAW-01: daemon snapshot restores the same review body and withdrawal after rebase via ${proof}`, async t => {
    const f = await fixture(t);
    if (proof === 'provenance') {
      f.comments.push({ user: { login: 'the-hammer-lacey[bot]' }, body: `HAM-Base-Head: ${f.a}\nHAM-Validated-Head: ${f.b}` });
    }
    assert.notEqual(process.cwd(), f.dir, 'daemon runs outside the target checkout');
    const snapshot = await buildAdversarialGateSnapshot(f.dir, { repo, prNumber, headSha: f.b,
      reviewCurrencyCwd: f.dir,
      includeSettledReview: true, liveHeadReview: null,
      reviewRow: { repo, pr_number: prNumber, review_status: 'posted', reviewer: 'codex',
        reviewer_head_sha: f.a, review_body: body },
      execFileImpl: async (_file, args) => ({ stdout: JSON.stringify(await f.get(args.find(arg => arg.startsWith('repos/')))) }) });
    assert.equal(snapshot.reviewCurrency.current, true, JSON.stringify(snapshot.reviewCurrency));
    assert.equal(snapshot.reviewCurrency.proof, proof === 'provenance' ? 'closer-rebase-provenance' : 'reviewed-rebase-patch-id');
    assert.equal(snapshot.settledReview.blockingFindingCount, 1);
    assert.equal(snapshot.settledReview.verdict, 'request-changes');
    assert.equal(resolveHammerAdjudication({ ...snapshot.settledReview, reviewedHead: f.a, currentHead: f.b },
      snapshot.hammerWithdrawals).allBlockingWithdrawn, true);
    assert.equal(pickAdversarialGateStatus(snapshot).reason, 'hammer-adjudicated');
  });
}

for (const scenario of ['missing', 'superseded']) {
  test(`HAMWITHDRAW-01: daemon skips withdrawal comment reads for ${scenario} authoritative review`, async t => {
    const f = await fixture(t);
    const head = f.run('commit-tree', `${f.a}^{tree}`, '-p', f.a, '-m', 'Descendant');
    f.setLive(head);
    const reviews = scenario === 'missing' ? [] : [f.review, { ...f.review, id: 18, commit_id: head, state: 'APPROVED' }];
    const calls = [];
    const snapshot = await buildAdversarialGateSnapshot(f.dir, { repo, prNumber, headSha: head,
      includeSettledReview: true, liveHeadReview: null,
      reviewRow: { repo, pr_number: prNumber, review_status: 'posted', reviewer: 'codex',
        reviewer_head_sha: f.a, review_body: body },
      execFileImpl: async (_file, args) => {
        const path = args.find(arg => arg.startsWith('repos/'));
        calls.push(path);
        if (path.includes('/reviews?')) return { stdout: JSON.stringify(reviews) };
        assert.ok(!path.includes('/comments?'), 'withdrawal comments must not be read');
        return { stdout: JSON.stringify(await f.get(path)) };
      } });
    assert.ok(calls.some(path => path.includes('/reviews?')));
    assert.ok(!calls.some(path => path.includes('/comments?')));
    assert.deepEqual(snapshot.hammerWithdrawals, []);
    assert.equal(snapshot.reviewCurrency.current, false);
    assert.match(snapshot.reviewCurrency.missingProof, /missing or superseded/);
    assert.equal(pickAdversarialGateStatus(snapshot).reason, 'review-currency-unproven');
  });
}

for (const changed of [false, true]) {
  test(`HAMWITHDRAW-01: binary-only rebase ${changed ? 'rejects changed bytes' : 'preserves patch currency'}`, async t => {
    const f = await fixture(t, { binary: true, changed });
    const diff = await f.git(['diff', '--binary', '--full-index', `${f.a}^`, f.a]);
    assert.match(diff, /GIT binary patch/);
    const currency = createReviewCurrencyReader({ repo, prNumber, get: f.get, cwd: f.dir });
    const result = await currency(f.a, f.b);
    assert.equal(result.current, !changed, JSON.stringify(result));
    if (!changed) assert.equal(result.proof, 'reviewed-rebase-patch-id');
  });
}

test('HAMWITHDRAW-01: unavailable binary patch ID fails closed without a digest fallback', async t => {
  const f = await fixture(t, { binary: true });
  const currency = createReviewCurrencyReader({ repo, prNumber, get: f.get,
    git: (args, input) => args[0] === 'patch-id' ? Promise.resolve('') : f.git(args, input) });
  const result = await currency(f.a, f.b);
  assert.equal(result.current, false);
  assert.match(result.missingProof, /missing patch ID/);
});


test('HAMWITHDRAW-01: partial withdrawal subtracts only its finding from the blocking count', async t => {
  const f = await fixture(t);
  const currency = f.currency();
  const withdrawals = await carryHammerWithdrawals(f.withdrawals(), f.b, currency);
  const state = { ...f.state, reviewCurrency: await currency(f.a, f.b), blockingFindingCount: 2,
    blockingFindingIdentities: [...f.state.blockingFindingIdentities, 'e'.repeat(64)] };
  const verdict = isEligibleForAmaClosure(state, f.pr, { enabled: true },
    { env: {}, primaryChange: { headSha: f.b, hasHammerCommits: false }, hammerWithdrawnFindings: withdrawals });
  assert.equal(verdict.trace.verdict.hammerAdjudication.withdrawnCount, 1);
  assert.equal(verdict.trace.verdict.blockingFindings.count, 1);
  assert.ok(verdict.reasons.includes('blocking-findings-present'));
  assert.equal(verdict.eligible, false);
});

test('HAMWITHDRAW-01: discarding the withdrawal evidence head in a reset grants no coverage', async t => {
  const f = await fixture(t);
  const withdrawal = { ...f.withdrawals()[0], headSha: f.b };
  f.setLive(f.a);
  const currency = f.currency();
  const carried = await carryHammerWithdrawals([withdrawal], f.a, currency);
  assert.equal(carried[0].evidenceCurrency.current, false);
  assert.equal(resolveHammerAdjudication({ ...f.state, currentHead: f.a }, carried).withdrawnCount, 0);
});


test('HAMWITHDRAW-01: ordinary ancestry cannot become a new head-match merge waiver', async t => {
  const f = await fixture(t);
  f.run('checkout', '-qb', 'foreign-descendant', f.a);
  writeFileSync(join(f.dir, 'foreign.txt'), 'unreviewed edit\n');
  f.run('add', 'foreign.txt'); f.run('commit', '-qm', 'Foreign push');
  const currentHead = f.run('rev-parse', 'HEAD'); f.setLive(currentHead);
  const currency = f.currency();
  const verdict = isEligibleForAmaClosure({ ...f.state, currentHead, reviewCurrency: await currency(f.a, currentHead) },
    { ...f.pr, headSha: currentHead }, { enabled: true }, { env: {},
      primaryChange: { headSha: currentHead, hasHammerCommits: false },
      hammerWithdrawnFindings: await carryHammerWithdrawals(f.withdrawals(), currentHead, currency) });
  assert.equal(verdict.eligible, false);
  assert.ok(verdict.reasons.includes('stale-review-head'));
  assert.equal(verdict.trace.verdict.hammerAdjudication.withdrawnCount, 0);
});
