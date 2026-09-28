import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  captureFinalRoundWorkerPushedHead,
  hasCompletedCommentOnlyFinalRound,
  hasSettledCommentOnlyReviewHead,
  proveCommentOnlyFinalRoundHead,
} from '../src/comment-only-final-round.mjs';

const oldHead = '1'.repeat(40);
const newHead = '2'.repeat(40);

test('worker push proof requires local HEAD to match a fresh live PR head', async () => {
  const args = {
    rootDir: '/tmp/final-round', repo: 'example/repo', prNumber: 42, jobId: 'job-42',
    workspaceDir: '/tmp/final-round/workspace',
    execFileImpl: async (_command, argv) => ({
      stdout: argv.includes('show') ? 'Worker-Job-Id: job-42\n' : `${newHead}\n`,
    }),
    log: { warn: () => {} },
  };
  assert.equal(await captureFinalRoundWorkerPushedHead({
    ...args, resolvePRLifecycleImpl: async () => ({ source: 'live', headSha: newHead }),
  }), newHead);
  assert.equal(await captureFinalRoundWorkerPushedHead({
    ...args, resolvePRLifecycleImpl: async () => ({ source: 'live', headSha: '3'.repeat(40) }),
  }), null);
  assert.equal(await captureFinalRoundWorkerPushedHead({
    ...args, resolvePRLifecycleImpl: async () => ({ source: 'mirror', headSha: newHead }),
  }), null);
  assert.equal(await captureFinalRoundWorkerPushedHead({
    ...args,
    execFileImpl: async (_command, argv) => ({
      stdout: argv.includes('show') ? 'Worker-Job-Id: somebody-else\n' : `${newHead}\n`,
    }),
    resolvePRLifecycleImpl: async () => ({ source: 'live', headSha: newHead }),
  }), null);
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
  assert.equal(hasCompletedCommentOnlyFinalRound(rootDir, {
    repo: 'example/repo', prNumber: 42, headSha: newHead,
  }), true);
  assert.equal(hasCompletedCommentOnlyFinalRound(rootDir, {
    repo: 'example/repo', prNumber: 42, headSha: '3'.repeat(40),
  }), false);
});
