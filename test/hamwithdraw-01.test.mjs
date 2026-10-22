import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReviewCurrencyReader, carryHammerWithdrawals } from '../src/ama/review-currency.mjs';
import { isCurrentAuthoritativeFamilyReview, latestAuthoritativeReviewInAncestry } from '../src/ama/reviewer-authority.mjs';
import { disputeFinding } from '../src/ama/finding-dispute.mjs';
import { readHammerWithdrawals, hammerWithdrawalsFromComments, resolveHammerAdjudication, blockingFindingIdentitiesFromBody } from '../src/ama/hammer-adjudication.mjs';
import { dismissWithdrawnReviews } from '../src/ama/withdrawn-review-dismissal.mjs';
import { ensureReviewStateSchema, openReviewStateDb } from '../src/review-state.mjs';
import { isEligibleForAmaClosure } from '../src/ama/eligibility.mjs';
import { buildAdversarialGateSnapshot, pickAdversarialGateStatus } from '../src/adversarial-gate-status.mjs';

const repo = 'fixture/repo', prNumber = 42;
const body = '## Blocking issues\n- **Prefix already present**\n  - **File:** `feature.txt`\n  - **Problem:** Prefix absent.\n\n## Non-blocking issues\n- None.\n\n## Verdict\nRequest changes';
const evidence = '```\n$ git show HEAD:feature.txt\nprefix: feature\n```';

async function fixture(t, { changed = false, remediation = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hamwithdraw-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', timeout: 5000,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  const git = async (args, input) => execFileSync('git', args, { cwd: dir, input, encoding: 'utf8', timeout: 5000 });
  const write = (path, text) => writeFileSync(join(dir, path), text);
  const commit = message => { run('add', '--all'); run('commit', '-qm', message); return run('rev-parse', 'HEAD'); };
  run('init', '-q'); run('config', 'user.name', 'Fixture'); run('config', 'user.email', 'fixture@example.invalid');
  write('initial.txt', 'initial\n'); const fork = commit('Initial');
  write('feature.txt', 'prefix: feature\n'); const a = commit('Feature');
  const review = { id: 17, node_id: 'PRR_17', html_url: 'https://github.com/fixture/repo/pull/42#pullrequestreview-17',
    commit_id: a, state: 'CHANGES_REQUESTED', user: { login: 'lacey-codex-reviewer[bot]' }, body };
  let live = a;
  const comments = [], posted = [], dismissed = [], authenticatedCommits = new Map();
  const db = openReviewStateDb(dir); ensureReviewStateSchema(db); t.after(() => db.close());
  const get = async path => {
    if (path.includes('/reviews?')) return [review];
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
  write('feature.txt', changed ? 'unreviewed feature\n' : 'prefix: feature\n');
  const replay = commit('Replayed feature');
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
  return { dir, a, b, base, replay, run, get, git, review, comments, posted, args, deps, state, pr, authenticatedCommits,
    currency, withdrawals, setLive: sha => { live = sha; }, dismiss: async path => { dismissed.push(path); review.state = 'DISMISSED'; }, dismissed };
}

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

test('HAMWITHDRAW-01: ama-check uses the same durable withdrawal at the diverged head', async t => {
  const f = await fixture(t);
  f.comments.push({ user: { login: 'the-hammer-lacey[bot]' }, body: `HAM-Base-Head: ${f.a}\nHAM-Validated-Head: ${f.b}` });
  const file = (name, value) => { const path = join(f.dir, name); writeFileSync(path, JSON.stringify(value)); return path; };
  const config = join(f.dir, 'global.yaml');
  writeFileSync(config, 'version: 1\nroles:\n  adversarial:\n    merge_authority:\n      enabled: true\n      eligibility:\n        risk_classes: [low]\n      branch_protection:\n        required: false\n');
  const result = spawnSync(process.execPath, [new URL('../bin/ama-check.mjs', import.meta.url).pathname,
    '--repo', repo, '--root-dir', f.dir, '--reviewed-sha', f.a, '--reviewer', 'codex', '--risk-class', 'low',
    '--pr', file('pr.json', { number: prNumber, headRefOid: f.b, baseRefOid: f.base, state: 'OPEN', isDraft: false,
      mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', labels: [], statusCheckRollup: f.pr.statusCheckRollup }),
    '--reviews', file('reviews.json', { reviews: [{ ...f.review, submitted_at: '2026-01-01T00:00:00Z' }] }),
    '--timeline', file('timeline.json', f.comments), '--protection', file('protection.json', {}),
    '--primary-change', file('primary.json', { headSha: f.b, hasHammerCommits: false })],
  { cwd: f.dir, encoding: 'utf8', timeout: 15000, env: { ...process.env, AGENT_OS_CONFIG_PATH: config } });
  assert.equal(result.status, 0, result.stderr);
  const verdict = JSON.parse(result.stdout);
  assert.equal(verdict.eligible, true, JSON.stringify(verdict.reasons));
  assert.equal(verdict.trace.verdict.hammerAdjudication.withdrawnCount, 1);
});


test('HAMWITHDRAW-01: daemon snapshot restores the same review body and withdrawal after rebase', async t => {
  const f = await fixture(t);
  f.comments.push({ user: { login: 'the-hammer-lacey[bot]' }, body: `HAM-Base-Head: ${f.a}\nHAM-Validated-Head: ${f.b}` });
  const snapshot = await buildAdversarialGateSnapshot(f.dir, { repo, prNumber, headSha: f.b,
    includeSettledReview: true, liveHeadReview: null,
    reviewRow: { repo, pr_number: prNumber, review_status: 'posted', reviewer: 'codex',
      reviewer_head_sha: f.a, review_body: body },
    execFileImpl: async (_file, args) => ({ stdout: JSON.stringify(await f.get(args.find(arg => arg.startsWith('repos/')))) }) });
  assert.equal(snapshot.reviewCurrency.current, true, JSON.stringify(snapshot.reviewCurrency));
  assert.equal(snapshot.settledReview.blockingFindingCount, 1);
  assert.equal(snapshot.settledReview.verdict, 'request-changes');
  assert.equal(resolveHammerAdjudication({ ...snapshot.settledReview, reviewedHead: f.a, currentHead: f.b },
    snapshot.hammerWithdrawals).allBlockingWithdrawn, true);
  assert.equal(pickAdversarialGateStatus(snapshot).reason, 'hammer-adjudicated');
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
