import './helpers/load-aware-timeout-fixture.mjs';
import './helpers/rate-limit-state-isolation.mjs';
// REBASETRAILER-01: "was this head produced by a closer?" is decided by the
// producer of the head commit. A rebase that replays a closer commit keeps the
// commit's author and its closer trailer, but writes its own committer. The
// watcher's review refresh, the hammer retry series and the adversarial gate
// all read the same classifier, so they cannot disagree about one head.
//
// Every repository here is a synthetic temp Git repo; gh is a local stub.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  closerCommitReplayedByOtherProducer,
  fetchVerifiedCommitFromLocalGit,
  getHeadCloserCommitSuppression,
  isTerminalCloserCommitIdentity,
  proveCloserOnlyHeadDelta,
} from '../src/head-closer-commit-suppression.mjs';
import { pickAdversarialGateStatus } from '../src/adversarial-gate-status.mjs';
import {
  evaluateHammerRetryCap,
  markHammerRetryCapExhausted,
  readHammerRetryCapLedger,
  recordHammerRetryDispatch,
  resetHammerSeriesForNonCloserHead,
} from '../src/ama/hammer-retry-cap.mjs';

const CLOSER = { name: 'Fixture Closer', email: '1000001+the-hammer-lacey[bot]@users.noreply.github.com' };
const BUILDER = { name: 'Fixture Builder', email: 'builder@example.invalid' };
const REBASER = { name: 'Fixture Rebaser', email: 'rebaser@example.invalid' };

function closerMessage(reviewedHead) {
  return [
    'HAM remediate synthetic findings',
    '',
    'Worker-Class: hammer',
    'Worker-Ticket: HAM',
    `Reviewed-Head: ${reviewedHead}`,
    'Closed-By: hammer (adversarial-pipe-mode)',
  ].join('\n');
}

function makeRepo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rebasetrailer-01-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (args, who = BUILDER, extraEnv = {}) => execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email,
      GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email,
      ...extraEnv,
    },
  }).trim();
  git(['init', '-q', '-b', 'main']);
  const commit = (file, message, who = BUILDER) => {
    writeFileSync(join(dir, file), `${file}:${message.length}:${Math.random()}\n`);
    git(['add', file], who);
    git(['commit', '-q', '-m', message], who);
    return git(['rev-parse', 'HEAD']);
  };
  return { dir, git, commit };
}

// The incident shape, synthetic: base -> reviewed builder head -> closer commit;
// main moves on; a non-closer rebases the branch, replaying the closer commit.
function rebasedCloserFixture(t) {
  const repo = makeRepo(t);
  const { git, commit } = repo;
  commit('base.txt', 'base');
  git(['checkout', '-q', '-b', 'feature']);
  const reviewed = commit('feature.txt', 'builder change');
  const closerHead = commit('fix.txt', closerMessage(reviewed), CLOSER);
  git(['checkout', '-q', 'main']);
  commit('main.txt', 'main moves on');
  git(['checkout', '-q', 'feature']);
  git(['rebase', '-q', 'main'], REBASER);
  const rebasedHead = git(['rev-parse', 'HEAD']);
  return { ...repo, reviewed, closerHead, rebasedHead };
}

function stubGh({ authorLogin = null, committerLogin = null, authorEmail = null, committerEmail = null, message = '' } = {}) {
  const calls = [];
  const impl = async ({ args }) => {
    calls.push(args.join(' '));
    if (String(args[1]).includes('/issues/')) return { stdout: '[[]]' };
    return { stdout: JSON.stringify({ sha: args[1].split('/').pop(), message, authorLogin, committerLogin,
      authorEmail, committerEmail, commit: { verification: { verified: false } } }) };
  };
  impl.calls = calls;
  return impl;
}

test('a closer push: the head commit was produced by the closer and is suppressed', async t => {
  const { dir, closerHead } = rebasedCloserFixture(t);
  const commit = await fetchVerifiedCommitFromLocalGit({ repoPath: dir, prNumber: 7, headSha: closerHead });
  assert.equal(commit.author.email, CLOSER.email.toLowerCase());
  assert.equal(commit.committer.email, CLOSER.email.toLowerCase());
  const gh = stubGh();
  const decision = await getHeadCloserCommitSuppression({ repoPath: dir, prNumber: 7, headSha: closerHead,
    execGhWithRetryImpl: gh });
  assert.deepEqual([decision.suppressed, decision.reason], [true, 'closer-commit-trailer']);
  assert.equal(gh.calls.length, 0, 'a closer head is decided from local git alone');
});

test('a non-closer rebase that replays a closer commit produces a non-closer head', async t => {
  const { dir, rebasedHead, closerHead } = rebasedCloserFixture(t);
  assert.notEqual(rebasedHead, closerHead);
  const commit = await fetchVerifiedCommitFromLocalGit({ repoPath: dir, prNumber: 7, headSha: rebasedHead });
  // The replayed commit still carries the closer trailer and the closer author.
  assert.match(commit.message, /Closed-By: hammer/);
  assert.equal(commit.author.email, CLOSER.email.toLowerCase());
  assert.equal(commit.committer.email, REBASER.email);
  assert.equal(closerCommitReplayedByOtherProducer(commit), true);
  assert.equal(isTerminalCloserCommitIdentity(commit).suppressed, false);
  // The remote fallback sees the same producer facts and reaches the same answer.
  const gh = stubGh({ authorLogin: 'the-hammer-lacey[bot]', message: commit.message,
    authorEmail: CLOSER.email, committerEmail: REBASER.email });
  const decision = await getHeadCloserCommitSuppression({ repoPath: dir, prNumber: 7, headSha: rebasedHead,
    execGhWithRetryImpl: gh });
  assert.equal(decision.suppressed, false, 'review refresh is not suppressed for the rebased head');
});

test('a hammer committer on its own noreply identity is still the closer', () => {
  const message = closerMessage('a'.repeat(40));
  assert.equal(isTerminalCloserCommitIdentity({ message,
    author: { login: null, email: 'someone@example.invalid' },
    committer: { login: null, email: '2000002+merge-agent-lacey@users.noreply.github.com' } }).suppressed, true);
  // Without email evidence the historical trailer rule is unchanged.
  assert.equal(isTerminalCloserCommitIdentity({ message }).suppressed, true);
  // A linked committer login is judged by the linked-identity rule, not by email.
  assert.equal(closerCommitReplayedByOtherProducer({ message,
    author: { login: 'the-hammer-lacey[bot]' }, committer: { login: 'web-flow', email: 'noreply@github.com' } }), false);
});

test('a mixed range since the reviewed head is a non-closer head', async t => {
  const { git, commit, dir } = makeRepo(t);
  commit('base.txt', 'base');
  const reviewed = commit('feature.txt', 'builder change');
  const closerCommit = commit('fix.txt', closerMessage(reviewed), CLOSER);
  const builderTip = commit('later.txt', 'builder pushes after the closer');
  const gh = stubGh({ message: 'builder pushes after the closer', authorEmail: BUILDER.email, committerEmail: BUILDER.email });
  const options = { repoPath: dir, prNumber: 7, execGhWithRetryImpl: gh };
  assert.equal(await proveCloserOnlyHeadDelta({ ...options, reviewedHead: reviewed, currentHead: closerCommit }), true);
  assert.equal(await proveCloserOnlyHeadDelta({ ...options, reviewedHead: reviewed, currentHead: builderTip }), false);
  // A closer tip over a builder commit is not a closer-only range either.
  git(['reset', '-q', '--hard', reviewed]);
  commit('middle.txt', 'builder change in the middle');
  const closerTip = commit('fix2.txt', closerMessage(reviewed), CLOSER);
  assert.equal(await proveCloserOnlyHeadDelta({ ...options, reviewedHead: reviewed, currentHead: closerTip }), false);
});

const HEAD = 'c'.repeat(40);
const REVIEWED = 'a'.repeat(40);
const staleRow = { repo: 'fixture/repo', pr_number: 7, review_status: 'posted', reviewer_head_sha: REVIEWED,
  review_body: '## Verdict\nComment only' };

test('the gate does not wait for a re-review of a closer-produced head', () => {
  const closer = pickAdversarialGateStatus({ reviewRow: staleRow, headSha: HEAD, env: {},
    closerProducedHead: { suppressed: true, reason: 'closer-commit-trailer' } });
  assert.deepEqual([closer.state, closer.reason], ['pending', 'closer-produced-head']);
  assert.match(closer.description, /closer produced this head/);

  for (const closerProducedHead of [null, { suppressed: false, reason: null },
    { suppressed: true, reason: 'closer-commit-trailer', headSha: 'd'.repeat(40) },
    { suppressed: true, reason: 'remediation-round-budget-exhausted' }]) {
    const decision = pickAdversarialGateStatus({ reviewRow: staleRow, headSha: HEAD, env: {}, closerProducedHead });
    assert.deepEqual([decision.state, decision.reason], ['pending', 'stale-review-head'], JSON.stringify(closerProducedHead));
  }
});

test('the hammer series keeps its cap for a head the shared classifier calls closer-produced', t => {
  const identity = { repo: 'fixture/repo', prNumber: 7 };
  const seed = () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'rebasetrailer-01-cap-'));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    for (let i = 0; i < 2; i += 1) {
      recordHammerRetryDispatch(rootDir, identity, { jobKey: REVIEWED, headSha: REVIEWED,
        launchRequestId: `lrq_fixture_${i}`, now: `2026-11-01T00:0${i}:00Z` });
    }
    markHammerRetryCapExhausted(rootDir, identity, { jobKey: REVIEWED, headSha: REVIEWED, attemptCount: 2,
      alertEmitted: true, now: '2026-11-01T00:05:00Z' });
    return rootDir;
  };
  const headProof = { proven: false, reason: 'hammer-app-attestation-missing', currentHeadHammerAttested: false,
    reviewedHead: REVIEWED, currentHead: HEAD };
  const capExhausted = rootDir => evaluateHammerRetryCap(readHammerRetryCapLedger(rootDir, identity),
    { jobKey: REVIEWED, headSha: HEAD }).capExhausted;

  const closerRoot = seed();
  const refused = resetHammerSeriesForNonCloserHead(closerRoot, identity, { jobKey: REVIEWED, headSha: HEAD, headProof,
    headProducer: { suppressed: true, reason: 'closer-commit-trailer' }, now: '2026-11-01T01:00:00Z' });
  assert.deepEqual(refused, { reset: false, reason: 'closer-produced-head' });
  assert.equal(capExhausted(closerRoot), true);

  const rebasedRoot = seed();
  const reset = resetHammerSeriesForNonCloserHead(rebasedRoot, identity, { jobKey: REVIEWED, headSha: HEAD, headProof,
    headProducer: { suppressed: false, reason: null }, now: '2026-11-01T01:00:00Z' });
  assert.equal(reset.reset, true);
  assert.equal(capExhausted(rebasedRoot), false);
});
