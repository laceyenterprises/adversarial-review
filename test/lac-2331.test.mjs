import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createReviewCurrencyReader, rebaseCurrencyCovers } from '../src/ama/review-currency.mjs';
import {
  fetchHammerHeadRange, HAMMER_COMMENTS_CAPPED, readCompletedRemediationEvidence,
} from '../src/ama/hammer-head-validation.mjs';
import { isCurrentAuthoritativeFamilyReview, latestAuthoritativeReviewInAncestry } from '../src/ama/reviewer-authority.mjs';
import { closerReviewProof } from '../src/ama/closer-review-proof.mjs';
import { closerAuthoredStaleEligible, proveCloserAuthoredStaleHead } from '../src/closer-authored-stale.mjs';
import { completedCommentOnlyHandoff, completedLocalCommentOnlyReplay } from '../src/comment-only-final-round.mjs';
import { isEligibleForAmaClosure } from '../src/ama/eligibility.mjs';
import { primaryChangeFixture } from './helpers/primary-change.mjs';
import { DEFAULT_ADVERSARIAL_GATE_CONTEXT } from '../src/adversarial-gate-context.mjs';

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
  assert.equal((await currency(reviewedHead, currentHead)).proof, 'completed-remediation-hammer-finding-currency');
});

test('LAC-2331 Hammer range composes local completion and exact publication edges', async t => {
  const { options } = fixture(t);
  const range = await fetchHammerHeadRange(options);
  assert.deepEqual(range?.commits, [remediated, rebased, currentHead]);
  assert.deepEqual((await fetchHammerHeadRange({ ...options, hammerBaseHead: rebased }))?.commits, range.commits);
});

for (const requested of [false, true]) {
  test(`non-final completed round requested=${requested} retains findings without waiving head match`, async t => {
    const { options, currency } = fixture(t, {
      rounds: [{ ...round(reviewedHead, remediated), reReview: { requested } }],
    });
    const evidence = await currency(reviewedHead, currentHead);
    assert.equal(evidence.proof, 'completed-remediation-hammer-finding-currency');
    assert.equal(evidence.current, true);
    assert.equal(rebaseCurrencyCovers(evidence, reviewedHead, currentHead), false);
    assert.equal((await currency(reviewedHead, currentHead, { rebaseOnly: true })).current, false);
    assert.equal((await fetchHammerHeadRange(options))?.proof, 'hammer-app-attestation-chain');
    assert.equal((await fetchHammerHeadRange({ ...options, hammerBaseHead: remediated }))?.proof,
      'completed-remediation-round-chain');
  });
}

test('findings-only provenance retains a failed patch proof diagnostic without granting a waiver', async t => {
  const { options } = fixture(t, { job: { reReview: { requested: true } } });
  const currency = createReviewCurrencyReader({ ...options, get: async path => {
    if (path.endsWith(`/pulls/${prNumber}`)) throw new Error('PR lookup unavailable');
    return options.get(path);
  } });
  const evidence = await currency(reviewedHead, currentHead);
  assert.equal(evidence.proof, 'completed-remediation-hammer-finding-currency');
  assert.equal(evidence.patchProofError, 'PR lookup unavailable');
  assert.equal(evidence.current, true);
  assert.equal(rebaseCurrencyCovers(evidence, reviewedHead, currentHead), false);
});

for (const fields of [
  { name: 'AbortError' },
  { code: 'ABORT_ERR' },
  { name: 'TimeoutError' },
  { code: 'ETIMEDOUT' },
  { killed: true, signal: 'SIGTERM' },
  { killed: true, signal: 'SIGKILL' },
  { killed: false, signal: 'SIGTERM' },
  { killed: false, signal: 'SIGKILL' },
  { signal: 'SIGTERM' },
  { signal: 'SIGKILL' },
]) {
  for (const stage of ['compare', 'comments', 'PR lookup', 'git']) {
    test(`findings-only currency propagates ${JSON.stringify(fields)} from ${stage}`, async t => {
      const { options } = fixture(t, { job: { reReview: { requested: true } } });
      const error = Object.assign(new Error('evaluation cancelled'), fields);
      const currency = createReviewCurrencyReader({ ...options,
        loadComments: async () => {
          if (stage === 'comments') throw error;
          return options.comments;
        },
        get: async path => {
          if (stage === 'compare' && path.includes('/compare/')) throw error;
          if (path.endsWith(`/pulls/${prNumber}`)) {
            if (stage === 'PR lookup') throw error;
            return { head: { sha: currentHead }, base: { sha: futureHead } };
          }
          return options.get(path);
        },
        git: async () => { throw error; },
      });
      await assert.rejects(currency(reviewedHead, currentHead), actual => actual === error);
    });
  }
}

const nativeJobId = 'fixture__repo-pr-42-job';

for (const stage of ['compare', 'comments', 'PR lookup', 'git']) {
  test(`the same currency reader retries a transient ${stage} rejection`, async t => {
    const { options } = fixture(t, { rounds: [], comments: [] });
    const error = Object.assign(new Error('temporary inspection timeout'), { code: 'ETIMEDOUT' });
    let attempts = 0;
    const inspect = () => { if (++attempts === 1) throw error; };
    const currency = createReviewCurrencyReader({ ...options,
      loadComments: async () => { if (stage === 'comments') inspect(); return []; },
      get: async path => {
        if (path.includes('/compare/')) {
          if (stage === 'compare') inspect();
          return { status: stage === 'compare' ? 'ahead' : 'diverged' };
        }
        if (path.endsWith(`/pulls/${prNumber}`)) {
          if (stage === 'PR lookup') inspect();
          return { head: { sha: currentHead }, base: { sha: futureHead } };
        }
        return null;
      },
      git: async args => {
        if (stage === 'git' && args[0] === 'merge-base') inspect();
        return args[0] === 'merge-base' ? futureHead : '';
      },
    });
    const first = currency(reviewedHead, currentHead);
    assert.equal(currency(reviewedHead, currentHead), first, 'concurrent reads share work');
    await assert.rejects(first, actual => actual === error);
    const result = await currency(reviewedHead, currentHead);
    assert.equal(attempts, 2, 'the rejected underlying read is attempted again');
    assert.equal(result.current, stage === 'compare', 'retry never fabricates currency');
    assert.equal(await currency(reviewedHead, currentHead), result, 'settled evidence stays cached');
    assert.equal(attempts, 2);
  });
}

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

test('completed handoff and local replay reject missing or non-object job inputs', () => {
  for (const input of [undefined, null, 'job', 1]) {
    assert.equal(completedCommentOnlyHandoff(input), null);
    assert.equal(completedLocalCommentOnlyReplay(input), null);
  }
});

test('standalone local replay requires an explicitly recorded published head', () => {
  const job = { ...nativeFinalJob(), status: 'completed' };
  assert.deepEqual(completedLocalCommentOnlyReplay(job), { reviewedHead, head: remediated });
  delete job.remediationPlan.rounds[0].publishedHeadSha;
  assert.equal(completedCommentOnlyHandoff(job), job.remediationPlan.rounds[0]);
  assert.equal(completedLocalCommentOnlyReplay(job), null);
});

test('a non-final round awaiting review cannot waive the head match after a Hammer push', async t => {
  const { options, currency } = fixture(t, { job: { reReview: {
    requested: true, status: 'pending', nextAction: { head: remediated },
  } } });
  const reviewCurrency = await currency(reviewedHead, currentHead);
  const headProof = await proveCloserAuthoredStaleHead({ ...options, repoPath: repo });
  const closerAuthoredStale = closerAuthoredStaleEligible({ headProof, verdict: 'settled-success',
    blockingFindingState: 'known', blockingFindingCount: 0, checksConclusion: 'SUCCESS', mergeability: 'MERGEABLE' });
  const result = isEligibleForAmaClosure({
    headSha: reviewedHead, verdict: 'approved', reviewCurrency,
    remediationPending: false, blockingFindingState: 'known', blockingFindingCount: 0,
    nonBlockingFindingState: 'known', nonBlockingFindingCount: 0, riskClass: 'low',
  }, {
    headSha: currentHead, isOpen: true, mergeableState: 'MERGEABLE', labels: [],
    statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', conclusion: 'SUCCESS' }],
    branchProtection: { requiredContexts: [DEFAULT_ADVERSARIAL_GATE_CONTEXT] },
  }, { enabled: true, eligibility: { riskClasses: ['low'] } }, {
    closerAuthoredStale, primaryChange: primaryChangeFixture(currentHead), env: {},
  });
  assert.equal(reviewCurrency.current, true, 'the original findings remain applicable');
  assert.equal(result.eligible, false);
  assert.deepEqual(result.reasons, ['stale-review-head']);
  assert.equal(closerAuthoredStale.eligible, false);
  assert.equal((await currency(reviewedHead, currentHead, { rebaseOnly: true })).current, false);
});

test('a settled comment-only publication followed by Hammer pushes waives only the head match', async t => {
  const { options, currency } = fixture(t, { job: nativeFinalJob() });
  const proof = await currency(reviewedHead, currentHead, { rebaseOnly: true });
  assert.equal(rebaseCurrencyCovers(proof, reviewedHead, currentHead), true);
  const headProof = await proveCloserAuthoredStaleHead({ ...options, repoPath: repo });
  assert.deepEqual(headProof.closerCommits, [currentHead, rebased, remediated]);
  const gates = { headProof, verdict: 'settled-success', blockingFindingState: 'known',
    blockingFindingCount: 0, checksConclusion: 'SUCCESS', mergeability: 'MERGEABLE' };
  assert.equal(closerAuthoredStaleEligible(gates).eligible, true);
  assert.equal(closerAuthoredStaleEligible({ ...gates, checksConclusion: 'PENDING' }).eligible, false);
  assert.equal(closerAuthoredStaleEligible({ ...gates, blockingFindingCount: 1 }).eligible, false);
});

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
  ['inconsistent pending rereview', job => { job.reReview.status = 'pending'; }],
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
    const mixed = createReviewCurrencyReader({ ...options, comments: [edge(remediated, currentHead)] });
    assert.equal((await mixed(reviewedHead, currentHead, { rebaseOnly: true })).current, false);
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

test('completed proof work is scoped to the matching PR in a large shared directory', async t => {
  const { options, record } = fixture(t, { job: nativeFinalJob() });
  const opendir = fs.opendir;
  const file = name => ({ name, isFile: () => true });
  const replacement = t.mock.method(fs, 'opendir', async path => {
    if (path !== dirname(record)) return opendir(path);
    return (async function* () {
      const other = file('fixture__repo-pr-420-unrelated.json');
      for (let i = 0; i <= 100_000; i++) yield other;
      yield file('fixture__repo-pr-42-job.json');
    })();
  });
  syncBuiltinESMExports();
  t.after(() => { replacement.mock.restore(); syncBuiltinESMExports(); });
  const evidence = await readCompletedRemediationEvidence(options.rootDir, repo, prNumber);
  assert.equal(evidence.rounds.length, 1);
  assert.equal(evidence.settledRounds.length, 1);
});

test('unavailable completed proof returns an empty lane publication map', async t => {
  const { options } = fixture(t);
  for (const rootDir of [null, join(options.rootDir, 'absent')]) {
    const evidence = await readCompletedRemediationEvidence(rootDir, repo, prNumber);
    assert.deepEqual(evidence, { rounds: [], settledRounds: [], finalPublications: [], lanePublications: new Map() });
    assert.equal(evidence.lanePublications.get('unknown'), undefined);
  }
});

test('completed proof scan stops after a bounded number of unrelated directory entries', async t => {
  const { options, record } = fixture(t, { job: nativeFinalJob() });
  const opendir = fs.opendir;
  const replacement = t.mock.method(fs, 'opendir', async path => {
    if (path !== dirname(record)) return opendir(path);
    return (async function* () {
      for (let i = 0; i < 125_000; i++) yield { name: 'unrelated-pr-1-job.json', isFile: () => true };
      yield { name: 'fixture__repo-pr-42-job.json', isFile: () => true };
    })();
  });
  syncBuiltinESMExports();
  t.after(() => { replacement.mock.restore(); syncBuiltinESMExports(); });
  const evidence = await readCompletedRemediationEvidence(options.rootDir, repo, prNumber);
  assert.deepEqual(evidence, { rounds: [], settledRounds: [], finalPublications: [], lanePublications: new Map(),
    limitReached: 'directory entries' });
});

test('record and edge limits are attributed to their target and rate limited per reason', async t => {
  const { options, record } = fixture(t, { job: nativeFinalJob() });
  const logs = t.mock.method(console, 'warn', () => {});
  let clock = 0;
  t.mock.method(performance, 'now', () => clock);
  for (const number of [4201, 4202]) {
    for (let i = 0; i < 257; i++) writeFileSync(record.replace('42-job', `${number}-job-${i}`), '{}');
    for (const name of [repo, repo.toUpperCase()]) {
      const evidence = await readCompletedRemediationEvidence(options.rootDir, name, number);
      assert.deepEqual(evidence, { rounds: [], settledRounds: [], finalPublications: [], lanePublications: new Map(),
        limitReached: 'matching records' });
    }
  }
  const many = Array.from({ length: 257 }, (_, i) => round(reviewedHead, i.toString(16).padStart(40, '0')));
  writeFileSync(record.replace('42-job', '4201-edges'), JSON.stringify({
    repo, prNumber: 4201, status: 'completed', remediationPlan: { rounds: many },
  }));
  // Replace the matching-record cap with an independent excess-edge cap.
  for (let i = 0; i < 257; i++) rmSync(record.replace('42-job', `4201-job-${i}`));
  const evidence = await readCompletedRemediationEvidence(options.rootDir, repo, 4201);
  assert.equal(evidence.limitReached, 'round edges');
  assert.equal(evidence.rounds.length, 0);
  assert.deepEqual(evidence.lanePublications, new Map());
  clock = 60 * 60 * 1000;
  await readCompletedRemediationEvidence(options.rootDir, repo, 4202);
  assert.deepEqual(logs.mock.calls.map(call => call.arguments[0].split(' for ')), [
    ['[ama] completed-round proof scan hit the matching records limit (256)', `${repo}#4201`],
    ['[ama] completed-round proof scan hit the matching records limit (256)', `${repo}#4202`],
    ['[ama] completed-round proof scan hit the round edges limit (256)', `${repo}#4201`],
    ['[ama] completed-round proof scan hit the matching records limit (256)', `${repo}#4202`],
  ]);
});

test('capped snapshots and pagination diagnose missing comment proof and contribute no partial edge', async t => {
  const { options } = fixture(t);
  const comments = [edge(reviewedHead, currentHead), ...Array(999).fill({ body: 'other' })];
  const snapshot = createReviewCurrencyReader({ ...options, comments });
  assert.match((await snapshot(reviewedHead, currentHead)).missingProof, new RegExp(HAMMER_COMMENTS_CAPPED));
  const pages = [];
  const paginated = createReviewCurrencyReader({ ...options, comments: null, get: async path => {
    if (!path.includes('/comments?')) return options.get(path);
    const page = Number(path.match(/&page=(\d+)/)?.[1] || 1);
    pages.push(page);
    return comments.slice((page - 1) * 100, page * 100);
  } });
  assert.match((await paginated(reviewedHead, currentHead)).missingProof, new RegExp(HAMMER_COMMENTS_CAPPED));
  assert.deepEqual(pages, Array.from({ length: 10 }, (_, i) => i + 1));
  const capped = await proveCloserAuthoredStaleHead({ ...options, repoPath: repo, comments });
  assert.equal(capped.reason, HAMMER_COMMENTS_CAPPED);
  assert.equal(capped.currentHeadHammerAttested, true);
  const complete = comments.slice(0, -1).concat({ event: 'labeled' });
  assert.equal((await createReviewCurrencyReader({ ...options, comments: complete })(reviewedHead, currentHead)).proof,
    'closer-rebase-provenance');
  const prior = { ...reviews[0], commit_id: currentHead };
  const later = { ...reviews[1], commit_id: rebased, state: 'CHANGES_REQUESTED' };
  const proof = await closerReviewProof({ ...options, headSha: currentHead, validatedAt: '2026-01-01T00:00:01Z',
    snapshot: { state: 'OPEN', headSha: currentHead, comments, reviews: [prior, later] } });
  assert.deepEqual(proof, { ok: false, reason: 'terminal-review-evidence-unavailable',
    missingProof: HAMMER_COMMENTS_CAPPED });
});

test('an older diverged review cannot make an exact-head citation uncertain at the comment cap', async t => {
  const { options, compare } = fixture(t, { comments: Array(1000).fill({ body: 'other' }) });
  const currency = createReviewCurrencyReader(options);
  const older = { ...reviews[0], commit_id: reviewedHead };
  const cited = { ...reviews[1], commit_id: currentHead };
  assert.equal(await isCurrentAuthoritativeFamilyReview(cited, [older, cited], currentHead, compare, currency), true);
  const otherFamily = { ...older, user: { login: 'lacey-claude-reviewer' } };
  const copy = structuredClone(cited);
  assert.equal(await isCurrentAuthoritativeFamilyReview(copy, [otherFamily, cited], currentHead, compare, currency), true);
  await assert.rejects(isCurrentAuthoritativeFamilyReview(copy, [cited, otherFamily], currentHead, compare, currency),
    error => error.proofLimit === HAMMER_COMMENTS_CAPPED);
  assert.equal(await isCurrentAuthoritativeFamilyReview({ ...copy, id: 999 }, [cited], currentHead, compare, currency), false);
});

test('LAC-2331 unavailable comparisons leave an independent exact mixed proof usable', async t => {
  const { options } = fixture(t, { job: nativeFinalJob() });
  const unreadableCompare = { ...options, get: async () => { throw new Error('comparison unavailable'); } };
  assert.equal((await createReviewCurrencyReader(unreadableCompare)(reviewedHead, currentHead)).proof, 'closer-rebase-provenance');
  assert.deepEqual((await fetchHammerHeadRange(unreadableCompare))?.commits, [remediated, rebased, currentHead]);
});

test('LAC-2331 mixed provenance retains reviewer-family supersession and the standing operator veto', async t => {
  const { options, compare, currency } = fixture(t, { job: nativeFinalJob() });
  assert.equal(await isCurrentAuthoritativeFamilyReview(reviews[0], reviews, currentHead, compare, currency), false);
  assert.equal(await isCurrentAuthoritativeFamilyReview(reviews[1], reviews, currentHead, compare, currency), true);
  const proof = rows => closerReviewProof({ ...options, headSha: currentHead, validatedAt: '2026-01-01T00:00:01Z',
    operatorLogins: ['fixture-operator'], snapshot: { state: 'OPEN', headSha: currentHead, comments: options.comments, reviews: rows } });
  assert.equal((await proof(reviews)).reason, 'review-changed-since-validation');
  const veto = { ...reviews[0], id: 3, state: 'CHANGES_REQUESTED', user: { login: 'fixture-operator' } };
  assert.equal((await proof([...reviews, veto])).reason, 'operator-review-changes-requested');
});

test('LAC-2331 certified review currency does not authorize reversal of primary source', async t => {
  const { currency } = fixture(t, { job: nativeFinalJob() });
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
