import test from 'node:test';
import assert from 'node:assert/strict';
import { proveCommentOnlyFinalRoundHead } from '../src/comment-only-final-round.mjs';

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
