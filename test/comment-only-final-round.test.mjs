import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  hasCompletedCommentOnlyFinalRound,
  hasSettledCommentOnlyReviewHead,
  proveCommentOnlyFinalRoundHead,
} from '../src/comment-only-final-round.mjs';

const oldHead = '1'.repeat(40);
const newHead = '2'.repeat(40);

test('completed final round requires matching review and proven descendant', async () => {
  const calls = [];
  const args = {
    repo: 'example/repo', reviewedHead: oldHead, currentHead: newHead,
    completedRevisionRefs: [oldHead],
    execFileImpl: async (_command, argv) => { calls.push(argv); return { stdout: 'ahead\n' }; },
  };
  assert.equal(await proveCommentOnlyFinalRoundHead(args), true);
  assert.equal(calls.length, 1);
  assert.equal(await proveCommentOnlyFinalRoundHead({ ...args, completedRevisionRefs: [] }), false);
  assert.equal(await proveCommentOnlyFinalRoundHead({ ...args, execFileImpl: async () => ({ stdout: 'diverged\n' }) }), false);
  assert.equal(await proveCommentOnlyFinalRoundHead({ ...args, currentHead: oldHead }), true);
});

test('ancestry proof retries transient gh failures and propagates operational failures', async () => {
  const args = {
    repo: 'example/repo', reviewedHead: oldHead, currentHead: newHead,
    completedRevisionRefs: [oldHead], logger: { warn: () => {} }, sleep: async () => {},
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
  writeFileSync(join(pendingDir, `${prefix}1.json`), JSON.stringify({
    repo: 'example/repo', prNumber: 42, revisionRef: oldHead,
    reviewBody: '## Verdict\nComment only',
  }));
  writeFileSync(join(completedDir, `${prefix}1.json`), JSON.stringify({
    repo: 'example/repo', prNumber: 42, status: 'completed', finalRound: 'comment-only',
    reReview: { suppressed: 'comment-only-final-round' },
  }));
  assert.equal(hasSettledCommentOnlyReviewHead(rootDir, {
    repo: 'example/repo', prNumber: 42, headSha: oldHead,
  }), true);
  assert.equal(hasCompletedCommentOnlyFinalRound(rootDir, {
    repo: 'example/repo', prNumber: 42,
  }), true);
});
