import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FINAL_ROUND_REPLAY_PROOF,
  hasCommentOnlyFinalRoundPush,
  hasUnprovenCommentOnlyFinalRoundHead,
  hasInProgressCommentOnlyFinalRound,
  hasSettledCommentOnlyReviewHead,
  proveCommentOnlyFinalRoundHead,
  proveFinalRoundWorkerPush,
} from '../src/comment-only-final-round.mjs';

const oldHead = '1'.repeat(40);
const newHead = '2'.repeat(40);

// COMMENTCLOSE-01: the push proof runs real git against a workspace fixture.
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};
const JOB_ID = 'job-42';
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: GIT_ENV }).trim();
function commitFile(dir, file, content, message) {
  writeFileSync(join(dir, file), content);
  git(dir, 'add', file);
  git(dir, 'commit', '-q', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}
const workerCommit = (dir, file = 'fix.txt') => commitFile(dir, file, 'fix\n', `Fix the typo\n\nWorker-Job-Id: ${JOB_ID}`);
function advanceBase(dir, file = 'trunk.txt') {
  git(dir, 'checkout', '-q', 'main');
  commitFile(dir, file, 'trunk moved\n', 'unrelated trunk change');
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(dir, 'checkout', '-q', 'pr');
}
function prFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'final-round-git-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, 'init', '-q', '-b', 'main');
  commitFile(dir, 'base.txt', 'base\n', 'base');
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(dir, 'checkout', '-q', '-b', 'pr');
  commitFile(dir, 'feature.txt', 'feature\n', 'feature one');
  const reviewed = commitFile(dir, 'feature2.txt', 'feature two\n', 'feature two');
  return { dir, reviewed };
}
function proofArgs(dir, reviewed, { live = null, warnings = [] } = {}) {
  return {
    repo: 'example/repo', prNumber: 42, jobId: JOB_ID, reviewedHead: reviewed, baseBranch: 'main', workspaceDir: dir,
    log: { warn: (line) => warnings.push(line) },
    execFileImpl: async (command, argv) => command === 'gh'
      ? { stdout: `${live || git(dir, 'rev-parse', 'HEAD')}\n` }
      : { stdout: execFileSync(command, argv, { encoding: 'utf8', env: GIT_ENV }) },
  };
}

test('a worker commit on top of the reviewed head is proven as a descendant', async (t) => {
  const { dir, reviewed } = prFixture(t);
  const pushed = workerCommit(dir);
  const result = await proveFinalRoundWorkerPush(proofArgs(dir, reviewed));
  assert.equal(result.workerPushedHeadSha, pushed);
  assert.equal(result.reason, 'descendant');
  assert.deepEqual(result.proof, { method: FINAL_ROUND_REPLAY_PROOF, reviewedCommitsReplayed: 0, workerCommits: 1 });
});

test('the mandatory base rebase is proven by replay, not rejected as diverged (#7293, #7311)', async (t) => {
  const { dir, reviewed } = prFixture(t);
  advanceBase(dir);
  git(dir, 'rebase', '-q', 'origin/main');
  const pushed = workerCommit(dir);
  assert.throws(() => git(dir, 'merge-base', '--is-ancestor', reviewed, pushed), 'fixture must diverge like a real rebase');
  const result = await proveFinalRoundWorkerPush(proofArgs(dir, reviewed));
  assert.equal(result.workerPushedHeadSha, pushed);
  assert.equal(result.reason, 'replayed-onto-base');
  assert.deepEqual(result.proof, { method: FINAL_ROUND_REPLAY_PROOF, reviewedCommitsReplayed: 2, workerCommits: 1 });
});

test('a push that carries a foreign commit, drops a reviewed commit, or merges fails closed with a logged reason', async (t) => {
  const foreign = prFixture(t);
  const human = commitFile(foreign.dir, 'human.txt', 'unreviewed\n', 'human change');
  workerCommit(foreign.dir);
  const warnings = [];
  const foreignResult = await proveFinalRoundWorkerPush(proofArgs(foreign.dir, foreign.reviewed, { warnings }));
  assert.equal(foreignResult.workerPushedHeadSha, null);
  assert.equal(foreignResult.reason, `foreign-commit-in-push ${human.slice(0, 12)}`);
  assert.match(warnings.join('\n'), /Withholding final-round push proof for example\/repo#42: foreign-commit-in-push/);

  const dropped = prFixture(t);
  git(dropped.dir, 'reset', '-q', '--hard', `${dropped.reviewed}~1`);
  workerCommit(dropped.dir);
  const droppedResult = await proveFinalRoundWorkerPush(proofArgs(dropped.dir, dropped.reviewed));
  assert.equal(droppedResult.reason, `reviewed-commit-not-replayed ${dropped.reviewed.slice(0, 12)}`);

  const merged = prFixture(t);
  git(merged.dir, 'checkout', '-q', '-b', 'side', 'origin/main');
  commitFile(merged.dir, 'side.txt', 'side\n', 'side branch');
  git(merged.dir, 'checkout', '-q', 'pr');
  git(merged.dir, 'merge', '-q', '--no-ff', 'side', '-m', 'merge side');
  workerCommit(merged.dir);
  const mergedResult = await proveFinalRoundWorkerPush(proofArgs(merged.dir, merged.reviewed));
  assert.equal(mergedResult.reason, 'merge-commit-in-push');
});

test('the proof needs the live PR head, the worker trailer on HEAD, and an actual push', async (t) => {
  const { dir, reviewed } = prFixture(t);
  const noPush = await proveFinalRoundWorkerPush(proofArgs(dir, reviewed));
  assert.deepEqual(noPush, { workerPushedHeadSha: null, liveHeadSha: reviewed, reason: 'no-push' });

  workerCommit(dir);
  const other = '3'.repeat(40);
  const moved = await proveFinalRoundWorkerPush(proofArgs(dir, reviewed, { live: other }));
  assert.equal(moved.workerPushedHeadSha, null);
  assert.equal(moved.liveHeadSha, other);
  assert.match(moved.reason, /^live-head-mismatch/);

  commitFile(dir, 'untrailed.txt', 'x\n', 'no trailer on HEAD');
  assert.equal((await proveFinalRoundWorkerPush(proofArgs(dir, reviewed))).reason, 'head-not-worker-commit');

  const audited = await proveFinalRoundWorkerPush({ ...proofArgs(dir, reviewed), withheldBecause: 'branch-contamination-audit-failed' });
  assert.equal(audited.reason, 'branch-contamination-audit-failed');
  assert.equal(audited.liveHeadSha, git(dir, 'rev-parse', 'HEAD'));
});

test('worker proof retries a transient live lookup and remains re-entrant after exhaustion', async (t) => {
  const { dir, reviewed } = prFixture(t);
  const pushed = workerCommit(dir);
  let attempts = 0;
  const base = proofArgs(dir, reviewed);
  const args = {
    ...base, sleep: async () => {},
    execFileImpl: async (command, argv) => {
      if (command === 'gh') {
        attempts += 1;
        if (attempts < 3) throw Object.assign(new Error('TLS handshake timeout'), { code: 'ETIMEDOUT' });
      }
      return base.execFileImpl(command, argv);
    },
  };
  assert.equal((await proveFinalRoundWorkerPush(args)).workerPushedHeadSha, pushed);
  assert.equal(attempts, 3);
  await assert.rejects(proveFinalRoundWorkerPush({
    ...args, execFileImpl: async (command, argv) => {
      if (command === 'gh') throw Object.assign(new Error('TLS handshake timeout'), { code: 'ETIMEDOUT' });
      return base.execFileImpl(command, argv);
    },
  }), /TLS handshake timeout/);
});

test('completed final round requires matching review and proven descendant', async () => {
  const calls = [];
  const args = {
    repo: 'example/repo', reviewedHead: oldHead, currentHead: newHead,
    completedRevisionRefs: [oldHead],
    completedPushedHeads: [{ reviewedHead: oldHead, workerPushedHeadSha: newHead }],
    execFileImpl: async (_command, argv) => { calls.push(argv); return { stdout: 'ahead\n' }; },
  };
  assert.equal(await proveCommentOnlyFinalRoundHead(args), true);
  assert.equal(calls.length, 1);
  assert.equal(await proveCommentOnlyFinalRoundHead({ ...args, completedRevisionRefs: [] }), false);
  assert.equal(await proveCommentOnlyFinalRoundHead({ ...args, currentHead: '3'.repeat(40) }), false);
  assert.equal(await proveCommentOnlyFinalRoundHead({ ...args, execFileImpl: async () => ({ stdout: 'diverged\n' }) }), false);
  assert.equal(await proveCommentOnlyFinalRoundHead({ ...args, currentHead: oldHead }), false);
  // COMMENTCLOSE-01: a replay-proven push is diverged by construction.
  const replayed = { ...args, completedPushedHeads: [{ reviewedHead: oldHead, workerPushedHeadSha: newHead, pushProof: FINAL_ROUND_REPLAY_PROOF }] };
  assert.equal(await proveCommentOnlyFinalRoundHead({ ...replayed, execFileImpl: async () => ({ stdout: 'diverged\n' }) }), true);
  assert.equal(await proveCommentOnlyFinalRoundHead({ ...replayed, execFileImpl: async () => ({ stdout: 'behind\n' }) }), false);
});

test('ancestry proof retries transient gh failures and propagates operational failures', async () => {
  const args = {
    repo: 'example/repo', reviewedHead: oldHead, currentHead: newHead,
    completedRevisionRefs: [oldHead], logger: { warn: () => {} }, sleep: async () => {},
    completedPushedHeads: [{ reviewedHead: oldHead, workerPushedHeadSha: newHead }],
  };
  let calls = 0;
  assert.equal(await proveCommentOnlyFinalRoundHead({
    ...args,
    execFileImpl: async () => {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error('TLS handshake timeout'), { code: 'ETIMEDOUT' });
      return { stdout: 'ahead\n' };
    },
  }), true);
  assert.equal(calls, 3);

  calls = 0;
  await assert.rejects(proveCommentOnlyFinalRoundHead({
    ...args,
    execFileImpl: async () => {
      calls += 1;
      throw new Error('repository access denied');
    },
  }), /repository access denied/);
  assert.equal(calls, 1);

  calls = 0;
  await assert.rejects(proveCommentOnlyFinalRoundHead({
    ...args,
    refreshGhAuthImpl: async () => ({ skipped: 'broker disabled' }),
    execFileImpl: async () => {
      calls += 1;
      throw Object.assign(new Error('gh: Bad credentials (HTTP 401)'), { stderr: 'Bad credentials' });
    },
  }), (err) => err.authOutage === true);
  assert.equal(calls, 1);
});

test('comment-only job scans tolerate files moved after directory listing', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'comment-only-jobs-'));
  const pendingDir = join(rootDir, 'data', 'follow-up-jobs', 'pending');
  const completedDir = join(rootDir, 'data', 'follow-up-jobs', 'completed');
  mkdirSync(pendingDir, { recursive: true });
  mkdirSync(completedDir, { recursive: true });
  const prefix = 'example__repo-pr-42-';
  symlinkSync(join(rootDir, 'moved-away.json'), join(pendingDir, `${prefix}0.json`));
  symlinkSync(join(rootDir, 'moved-away.json'), join(completedDir, `${prefix}0.json`));
  writeFileSync(join(pendingDir, `${prefix}bad.json`), '{broken');
  writeFileSync(join(completedDir, `${prefix}bad.json`), '{broken');
  writeFileSync(join(pendingDir, `${prefix}1.json`), JSON.stringify({
    repo: 'example/repo', prNumber: 42, revisionRef: oldHead,
    reviewBody: '## Verdict\nComment only',
  }));
  writeFileSync(join(completedDir, `${prefix}1.json`), JSON.stringify({
    repo: 'example/repo', prNumber: 42, status: 'completed', finalRound: 'comment-only',
    reReview: { suppressed: 'comment-only-final-round' },
    completion: { workerPushedHeadSha: newHead },
  }));
  assert.equal(hasSettledCommentOnlyReviewHead(rootDir, {
    repo: 'example/repo', prNumber: 42, headSha: oldHead,
  }), true);
  assert.equal(hasCommentOnlyFinalRoundPush(rootDir, {
    repo: 'example/repo', prNumber: 42, headSha: newHead,
  }), true);
  assert.equal(hasCommentOnlyFinalRoundPush(rootDir, {
    repo: 'example/repo', prNumber: 42, headSha: '3'.repeat(40),
  }), false);
  const inProgressDir = join(rootDir, 'data', 'follow-up-jobs', 'in-progress');
  mkdirSync(inProgressDir, { recursive: true });
  writeFileSync(join(inProgressDir, `${prefix}1.json`), JSON.stringify({
    repo: 'example/repo', prNumber: 42, revisionRef: oldHead, finalRound: 'comment-only',
  }));
  assert.equal(hasInProgressCommentOnlyFinalRound(rootDir, {
    repo: 'example/repo', prNumber: 42, reviewedHead: oldHead,
  }), true);
});


test('a final round with no recorded push suppresses nothing; a withheld moved head is held', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'comment-only-diverged-'));
  const completedDir = join(rootDir, 'data', 'follow-up-jobs', 'completed');
  mkdirSync(completedDir, { recursive: true });
  const job = {
    repo: 'example/repo', prNumber: 42, status: 'completed', finalRound: 'comment-only',
    reReview: { suppressed: 'comment-only-final-round' }, completion: {},
  };
  writeFileSync(join(completedDir, 'example__repo-pr-42-final.json'), JSON.stringify(job));
  const query = { repo: 'example/repo', prNumber: 42, headSha: newHead };
  assert.equal(hasCommentOnlyFinalRoundPush(rootDir, query), false);
  assert.equal(hasUnprovenCommentOnlyFinalRoundHead(rootDir, query), false);
  const stoppedDir = join(rootDir, 'data', 'follow-up-jobs', 'stopped');
  mkdirSync(stoppedDir, { recursive: true });
  writeFileSync(join(stoppedDir, 'example__repo-pr-42-held.json'), JSON.stringify({
    ...job, status: 'stopped', completion: { withheldPushHeadSha: newHead },
  }));
  assert.equal(hasCommentOnlyFinalRoundPush(rootDir, query), false, 'a withheld head is never a proven push');
  assert.equal(hasUnprovenCommentOnlyFinalRoundHead(rootDir, query), true);
});

test('job scan cache refreshes after an atomic job replacement', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'comment-only-cache-'));
  const completedDir = join(rootDir, 'data', 'follow-up-jobs', 'completed');
  mkdirSync(completedDir, { recursive: true });
  const path = join(completedDir, 'example__repo-pr-42-final.json');
  const job = { repo: 'example/repo', prNumber: 42, status: 'completed',
    finalRound: 'comment-only', reReview: { suppressed: 'comment-only-final-round' },
    completion: {} };
  writeFileSync(path, JSON.stringify(job));
  const query = { repo: 'example/repo', prNumber: 42, headSha: newHead };
  assert.equal(hasCommentOnlyFinalRoundPush(rootDir, query), false);
  writeFileSync(`${path}.next`, JSON.stringify({
    ...job, completion: { workerPushedHeadSha: newHead },
  }));
  renameSync(`${path}.next`, path);
  assert.equal(hasCommentOnlyFinalRoundPush(rootDir, query), true);
});
