import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReviewCurrencyReader, rebaseCurrencyCovers } from '../src/ama/review-currency.mjs';
import { fetchHammerHeadRange } from '../src/ama/hammer-head-validation.mjs';
import { isCurrentAuthoritativeFamilyReview, latestAuthoritativeReviewInAncestry } from '../src/ama/reviewer-authority.mjs';
import { closerReviewProof } from '../src/ama/closer-review-proof.mjs';
import { isEligibleForAmaClosure } from '../src/ama/eligibility.mjs';
import { primaryChangeFixture } from './helpers/primary-change.mjs';

const repo = 'fixture/repo', prNumber = 42;
const [reviewedHead, remediated, rebased, currentHead, futureHead] = 'abcde'.split('').map(hex => hex.repeat(40));
const round = (startHeadSha, resultingHeadSha, state = 'completed') => ({ state, startHeadSha, resultingHeadSha });
const edge = (from, to, login = 'the-hammer-lacey[bot]') => ({ user: { login },
  body: `HAM-Base-Head: ${from}\nHAM-Pushed-Head: ${to}` });
const reviews = [
  { id: 1, commit_id: reviewedHead, state: 'COMMENTED', user: { login: 'lacey-codex-reviewer[bot]' },
    submitted_at: '2026-01-01T00:00:00Z', body: 'First verdict' },
  { id: 2, commit_id: reviewedHead, state: 'COMMENTED', user: { login: 'lacey-codex-reviewer[bot]' },
    submitted_at: '2026-01-01T00:00:02Z', body: 'New findings' },
];
function fixture(t, { rounds = [round(reviewedHead, remediated)], comments = [edge(rebased, currentHead), edge(remediated, rebased)], job = {}, compareStatus = 'diverged' } = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'lac-2331-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const dir = join(rootDir, 'data', 'follow-up-jobs', 'completed');
  mkdirSync(dir, { recursive: true });
  const record = join(dir, 'fixture__repo-pr-42-job.json');
  writeFileSync(record, JSON.stringify({ repo, prNumber, status: 'completed', remediationPlan: { rounds }, ...job }));
  const compare = (from, to) => ({ status: from === reviewedHead && to === remediated && comments.length ? 'ahead' : compareStatus,
    total_commits: 1, commits: [{ sha: to }] });
  const get = async path => {
    if (path.includes('/compare/')) return compare(...path.split('/compare/')[1].split('...'));
    if (path.endsWith('/commits/main')) return { sha: 'f'.repeat(40) };
    return null;
  };
  const options = { repo, prNumber, rootDir, comments, reviewedHead, currentHead, get };
  return { options, compare, record, currency: createReviewCurrencyReader(options) };
}

test('LAC-2331 native completed round then repeated Hammer rebases preserves the authoritative review', async t => {
  const { currency, compare } = fixture(t);
  const [review] = reviews;
  assert.equal(await latestAuthoritativeReviewInAncestry([review], currentHead, compare, currency), review);
  assert.equal((await currency(reviewedHead, currentHead, { rebaseOnly: true })).proof, 'closer-rebase-provenance');
});

test('LAC-2331 Hammer range composes local completion and exact publication edges', async t => {
  const { options } = fixture(t);
  const range = await fetchHammerHeadRange(options);
  assert.deepEqual(range?.commits, [remediated, rebased, currentHead]);
  assert.deepEqual((await fetchHammerHeadRange({ ...options, hammerBaseHead: rebased }))?.commits, range.commits);
});

const nativeJobId = 'fixture__repo-pr-42-job';
function nativeFinalJob() {
  return {
    kind: 'adversarial-review-follow-up', jobId: nativeJobId, revisionRef: reviewedHead, branch: 'fixture/change', baseBranch: 'main',
    finalRound: 'comment-only', nonBlockingOnly: true,
    reviewBody: '## Blocking Issues\n- None.\n\n## Non-blocking Issues\n- Fix the fixture.\n\n## Verdict\nComment only',
    reReview: { requested: false, suppressed: 'comment-only-final-round', nextAction: { head: remediated } },
    remediationPlan: { currentRound: 1, rounds: [
      { ...round(reviewedHead, remediated), round: 1, publishedHeadSha: remediated },
    ] },
    remediationWorker: { state: 'completed', launchRequestId: nativeJobId },
    completion: { finalRemediationPush: true, workerPushedHeadSha: remediated,
      finalRoundOutcome: { completed: true, push: 'replayed-onto-base' },
      workerPushProof: { method: 'git-cherry-replay', reviewedCommitsReplayed: 1, workerCommits: 1 } },
  };
}

test('LAC-2331 native final remediation preserves the applicable review before Hammer publication', async t => {
  const { options, compare, currency } = fixture(t, { comments: [], job: nativeFinalJob() });
  const [review] = reviews;
  assert.equal(await latestAuthoritativeReviewInAncestry([review], remediated, compare, currency), review);
  const proof = await currency(reviewedHead, remediated);
  assert.equal(proof.proof, 'comment-only-final-remediation-publication');
  assert.equal(rebaseCurrencyCovers(proof, reviewedHead, remediated), false);
  assert.equal((await currency(reviewedHead, remediated, { rebaseOnly: true })).current, false);
  assert.equal((await currency(reviewedHead, futureHead)).current, false);
  const range = await fetchHammerHeadRange({ ...options, currentHead: remediated, hammerBaseHead: remediated });
  assert.deepEqual(range?.commits, [remediated]);
  assert.equal(await fetchHammerHeadRange({ ...options, currentHead: futureHead, hammerBaseHead: remediated }), null);
});

test('LAC-2331 the final review gate still sees a changed source review after a native rebase', async t => {
  const { options } = fixture(t, { comments: [], job: nativeFinalJob() });
  const result = await closerReviewProof({ ...options, headSha: remediated, validatedAt: '2026-01-01T00:00:01Z',
    snapshot: { state: 'OPEN', headSha: remediated, comments: [], reviews } });
  assert.equal(result.reason, 'review-changed-since-validation');
});

for (const [name, alter, compareStatus] of [
  ['other worker', job => { job.remediationWorker.launchRequestId = 'other-job'; }],
  ['incomplete worker', job => { job.remediationWorker.state = 'spawned'; }],
  ['unverified HQ publication', job => { job.remediationWorker.dispatchMode = 'hq'; }],
  ['different publication head', job => { job.completion.workerPushedHeadSha = futureHead; }],
  ['different round head', job => { job.remediationPlan.rounds[0].publishedHeadSha = futureHead; }],
  ['requested rereview', job => { job.reReview.requested = true; }],
  ['unverified replay', job => { delete job.completion.workerPushProof; }],
  ['no replayed reviewed commit', job => { job.completion.workerPushProof.reviewedCommitsReplayed = 0; }],
  ['branch reset', () => {}, 'behind'],
]) {
  test(`LAC-2331 native final remediation refuses ${name}`, async t => {
    const job = nativeFinalJob();
    alter(job);
    const { options, currency } = fixture(t, { comments: [], job, compareStatus });
    assert.equal((await currency(reviewedHead, remediated)).current, false);
    assert.equal(await fetchHammerHeadRange({ ...options, currentHead: remediated, hammerBaseHead: remediated }), null);
  });
}

for (const [name, input] of [
  ['wrong repo', { job: { repo: 'fixture/elsewhere' } }],
  ['wrong PR', { job: { prNumber: prNumber + 1 } }],
  ['invalid PR field type', { job: { prNumber: [prNumber] } }],
  ['unknown job state', { job: { status: 'closed' } }],
  ['unknown round state', { rounds: [round(reviewedHead, remediated, 'finished')] }],
  ['legacy round without result', { rounds: [round(reviewedHead, null)] }],
  ['published head without daemon result', { rounds: [{ ...round(reviewedHead, null), publishedHeadSha: remediated }] }],
  ['unrelated final push after a complete round', { comments: [edge(remediated, rebased)] }],
  ['future-only attestation', { comments: [edge(remediated, futureHead)] }],
  ['unknown author with forged metadata', { comments: [{
    ...edge(remediated, currentHead, 'builder[bot]'), author: { login: 'the-hammer-lacey[bot]' },
  }] }],
  ['tampered terminal head', { comments: [{
    ...edge(remediated, currentHead), body: `HAM-Base-Head: ${remediated}\nHAM-Validated-Head: ${currentHead}`
      + `\nHAM-Terminal-Remediation-Head: ${futureHead}`,
  }] }],
  ['tampered starting endpoint', { rounds: [round(reviewedHead, futureHead)] }],
  ['cycle dangling from the actual final head', { rounds: [round(reviewedHead, currentHead)],
    comments: [edge(currentHead, rebased), edge(rebased, currentHead)] }],
  ['branch reset', { compareStatus: 'behind' }],
]) {
  test(`LAC-2331 rejects ${name}`, async t => {
    const { options, currency } = fixture(t, input);
    assert.equal((await currency(reviewedHead, currentHead)).current, false);
    // In the cycle fixture, the legacy pure-round proof is independently
    // refused by the diverged comparison for that exact round.
    assert.equal(await fetchHammerHeadRange(options), null);
  });
}

test('LAC-2331 a record supplied through caller or PR metadata confers no authority', async t => {
  const { options, record } = fixture(t);
  rmSync(record);
  const remediationRounds = [round(reviewedHead, remediated)];
  const forged = { ...options, remediationRounds,
    pr: { head: { sha: currentHead }, remediationRounds } };
  assert.equal((await createReviewCurrencyReader(forged)(reviewedHead, currentHead)).current, false);
  assert.equal(await fetchHammerHeadRange(forged), null);
});

test('LAC-2331 completed round reader refuses a symlink to a job outside completed storage', async t => {
  const { options, record, currency } = fixture(t);
  const outside = join(options.rootDir, 'worker-job.json');
  writeFileSync(outside, JSON.stringify({ repo, prNumber, status: 'completed',
    remediationPlan: { rounds: [round(reviewedHead, remediated)] } }));
  rmSync(record);
  symlinkSync(outside, record);
  assert.equal((await currency(reviewedHead, currentHead)).current, false);
  assert.equal(await fetchHammerHeadRange(options), null);
});

test('LAC-2331 damaged and oversized jobs leave independent completed records usable', async t => {
  const { options, record, currency } = fixture(t);
  writeFileSync(record.replace('job.json', 'corrupt.json'), '{');
  writeFileSync(record.replace('job.json', 'oversized.json'), ' '.repeat(1024 * 1024 + 1));
  writeFileSync(record.replace('job.json', 'partial-round.json'), JSON.stringify({ repo, prNumber, status: 'completed',
    remediationPlan: { rounds: [null, round(reviewedHead, remediated, 'spawned')] } }));
  assert.equal((await currency(reviewedHead, currentHead)).current, true);
  assert.deepEqual((await fetchHammerHeadRange(options))?.commits, [remediated, rebased, currentHead]);
});

test('LAC-2331 a capped round scan still admits independent exact App provenance', async t => {
  const { options, record, currency } = fixture(t);
  for (let i = 0; i < 256; i++) writeFileSync(record.replace('job.json', `job-${i}.json`), '{}');
  assert.equal((await currency(reviewedHead, currentHead)).current, false);
  assert.equal(await fetchHammerHeadRange(options), null);
  const direct = { ...options, comments: [edge(reviewedHead, currentHead)] };
  assert.equal((await createReviewCurrencyReader(direct)(reviewedHead, currentHead)).proof, 'closer-rebase-provenance');
  assert.deepEqual((await fetchHammerHeadRange(direct))?.commits, [currentHead]);
});

test('LAC-2331 unavailable comparisons leave an independent exact mixed proof usable', async t => {
  const { options } = fixture(t);
  const unreadableCompare = { ...options, get: async () => { throw new Error('comparison unavailable'); } };
  assert.equal((await createReviewCurrencyReader(unreadableCompare)(reviewedHead, currentHead)).proof, 'closer-rebase-provenance');
  assert.deepEqual((await fetchHammerHeadRange(unreadableCompare))?.commits, [remediated, rebased, currentHead]);
});

test('LAC-2331 mixed provenance retains reviewer-family supersession and the standing operator veto', async t => {
  const { options, compare, currency } = fixture(t);
  assert.equal(await isCurrentAuthoritativeFamilyReview(reviews[0], reviews, currentHead, compare, currency), false);
  assert.equal(await isCurrentAuthoritativeFamilyReview(reviews[1], reviews, currentHead, compare, currency), true);
  const proof = rows => closerReviewProof({ ...options, headSha: currentHead, validatedAt: '2026-01-01T00:00:01Z',
    operatorLogins: ['fixture-operator'], snapshot: { state: 'OPEN', headSha: currentHead, comments: options.comments, reviews: rows } });
  assert.equal((await proof(reviews)).reason, 'review-changed-since-validation');
  const veto = { ...reviews[0], id: 3, state: 'CHANGES_REQUESTED', user: { login: 'fixture-operator' } };
  assert.equal((await proof([...reviews, veto])).reason, 'operator-review-changes-requested');
});

test('LAC-2331 certified review currency does not authorize reversal of primary source', async t => {
  const { currency } = fixture(t);
  const reviewCurrency = await currency(reviewedHead, currentHead);
  const result = isEligibleForAmaClosure({ headSha: reviewedHead, verdict: 'approved', reviewCurrency,
    remediationPending: false, blockingFindingState: 'known', blockingFindingCount: 0,
    nonBlockingFindingState: 'known', nonBlockingFindingCount: 0, riskClass: 'low',
  }, { headSha: currentHead, isOpen: true, mergeableState: 'MERGEABLE', labels: [] }, { enabled: true }, {
    primaryChange: { ...primaryChangeFixture(currentHead), finalFiles: [] },
  });
  assert.equal(reviewCurrency.current, true);
  assert.ok(!result.reasons.includes('stale-review-head'));
  assert.ok(result.reasons.includes('primary-change-reverted'), JSON.stringify(result.reasons));
});
