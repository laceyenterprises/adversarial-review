import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  captureFinalRoundWorkerPushedHead,
  hasCommentOnlyFinalRoundPush,
  hasInProgressCommentOnlyFinalRound,
  hasSettledCommentOnlyReviewHead,
  proveCommentOnlyFinalRoundHead,
} from '../src/comment-only-final-round.mjs';

const oldHead = '1'.repeat(40);
const newHead = '2'.repeat(40);

test('worker push proof requires local HEAD to match a fresh live PR head', async () => {
  const args = {
    repo: 'example/repo', prNumber: 42, jobId: 'job-42', reviewedHead: oldHead,
    workspaceDir: '/tmp/final-round/workspace',
    execFileImpl: async (_command, argv) => ({
      stdout: argv.includes('show') ? 'Worker-Job-Id: job-42\n'
        : argv.includes('compare') || argv.some((part) => String(part).includes('/compare/')) ? 'ahead\n' : `${newHead}\n`,
    }),
    log: { warn: () => {} },
  };
  assert.equal(await captureFinalRoundWorkerPushedHead(args), newHead);
  assert.equal(await captureFinalRoundWorkerPushedHead({
    ...args, execFileImpl: async (command, argv) => command === 'gh' && argv.includes('view')
      ? { stdout: `${'3'.repeat(40)}\n` } : args.execFileImpl(command, argv),
  }), null);
  assert.equal(await captureFinalRoundWorkerPushedHead({
    ...args, execFileImpl: async (command, argv) => command === 'gh' && argv[0] === 'api'
      ? { stdout: 'diverged\n' } : args.execFileImpl(command, argv),
  }), null);
  assert.equal(await captureFinalRoundWorkerPushedHead({
    ...args,
    execFileImpl: async (command, argv) => argv.includes('show')
      ? { stdout: 'Worker-Job-Id: somebody-else\n' } : args.execFileImpl(command, argv),
  }), null);
});

test('worker proof retries a transient live lookup and remains re-entrant after exhaustion', async () => {
  let attempts = 0;
  const args = {
    repo: 'example/repo', prNumber: 42, jobId: 'job-42', reviewedHead: oldHead,
    workspaceDir: '/tmp/final-round/workspace', sleep: async () => {}, log: { warn: () => {} },
    execFileImpl: async (command, argv) => {
      if (command === 'gh' && argv.includes('view')) {
        attempts += 1;
        if (attempts < 3) throw Object.assign(new Error('TLS handshake timeout'), { code: 'ETIMEDOUT' });
      }
      return { stdout: argv.includes('show') ? 'Worker-Job-Id: job-42\n'
        : command === 'gh' && argv[0] === 'api' ? 'ahead\n' : `${newHead}\n` };
    },
  };
  assert.equal(await captureFinalRoundWorkerPushedHead(args), newHead);
  assert.equal(attempts, 3);
  await assert.rejects(captureFinalRoundWorkerPushedHead({
    ...args, execFileImpl: async (command, argv) => {
      if (command === 'gh') throw Object.assign(new Error('TLS handshake timeout'), { code: 'ETIMEDOUT' });
      return args.execFileImpl(command, argv);
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


test('diverged final-round worker head carries no handoff proof and stays reviewable', async () => {
  const proof = await captureFinalRoundWorkerPushedHead({
    repo: 'example/repo', prNumber: 42, jobId: 'job-42', reviewedHead: oldHead,
    workspaceDir: '/tmp/final-round/workspace', log: { warn: () => {} },
    execFileImpl: async (command, argv) => ({ stdout: argv.includes('show')
      ? 'Worker-Job-Id: job-42\n' : command === 'gh' && argv[0] === 'api'
        ? 'diverged\n' : `${newHead}\n` }),
  });
  assert.equal(proof, null);
  const rootDir = mkdtempSync(join(tmpdir(), 'comment-only-diverged-'));
  const completedDir = join(rootDir, 'data', 'follow-up-jobs', 'completed');
  mkdirSync(completedDir, { recursive: true });
  writeFileSync(join(completedDir, 'example__repo-pr-42-final.json'), JSON.stringify({
    repo: 'example/repo', prNumber: 42, status: 'completed', finalRound: 'comment-only',
    reReview: { suppressed: 'comment-only-final-round' }, completion: {},
  }));
  assert.equal(hasCommentOnlyFinalRoundPush(rootDir, {
    repo: 'example/repo', prNumber: 42, headSha: newHead,
  }), false);
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
