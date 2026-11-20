import assert from 'node:assert/strict';
import test from 'node:test';
import { withTransientGitRetries } from '../src/reviewer-git-retries.mjs';

test('retry exhaustion names the operation and retains its original cause', async () => {
  const failure = Object.assign(new Error('RPC failed'), { code: 'ECONNRESET' });
  let calls = 0;
  await assert.rejects(withTransientGitRetries(async () => { calls++; throw failure; }, 'fixture fetch'),
    error => error.message === 'fixture fetch failed after 3 attempts' && error.cause === failure);
  assert.equal(calls, 3);
});

test('permanent Git errors retain their original identity without retry', async () => {
  const failure = new Error('repository not found');
  let calls = 0;
  await assert.rejects(withTransientGitRetries(async () => { calls++; throw failure; }, 'fixture fetch'),
    error => error === failure);
  assert.equal(calls, 1);
});
