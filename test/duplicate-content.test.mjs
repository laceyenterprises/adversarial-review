import test from 'node:test';
import assert from 'node:assert/strict';
import { collectDuplicateContent } from '../src/adapters/subject/github-pr/duplicate-content.mjs';

const args = { owner: 'owner', repo: 'repo', prNumber: 1, headSha: 'head' };

test('3000-file cap returns unavailable content instead of partial corroboration', async () => {
  const pages = [];
  const result = await collectDuplicateContent({ ...args, octokit: { rest: { pulls: {
    listFiles: async ({ page }) => {
      pages.push(page);
      return { data: Array.from({ length: 100 }, (_, i) => ({ filename: `src/${page}-${i}.mjs` })) };
    },
    get: async () => { assert.fail('truncated content cannot be head verified'); },
  } } } });
  assert.equal(pages.length, 30);
  assert.deepEqual(result, { headSha: 'head', paths: null, reason: 'content-truncated' });
});

test('transient file and head reads retry with a three-attempt bound', async () => {
  let files = 0;
  let heads = 0;
  const result = await collectDuplicateContent({ ...args, octokit: { rest: { pulls: {
    listFiles: async () => {
      files += 1;
      if (files < 3) throw Object.assign(new Error('upstream'), { status: 502 });
      return { data: [{ filename: 'src/a.mjs' }] };
    },
    get: async () => {
      heads += 1;
      if (heads < 3) throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
      return { data: { head: { sha: 'head' } } };
    },
  } } } });
  assert.deepEqual(result, { headSha: 'head', paths: ['src/a.mjs'] });
  assert.equal(files, 3);
  assert.equal(heads, 3);
});

test('permanent failures retain their original diagnostics without retry and moved heads discard paths', async () => {
  let calls = 0;
  const pulls = {
    listFiles: async () => { calls += 1; throw Object.assign(new Error('not found'), { status: 404 }); },
    get: async () => ({ data: { head: { sha: 'moved' } } }),
  };
  const octokit = { rest: { pulls } };
  await assert.rejects(collectDuplicateContent({ ...args, octokit }), (error) => error.message === 'not found' && error.status === 404);
  assert.equal(calls, 1);
  pulls.listFiles = async () => ({ data: [{ filename: 'src/a.mjs' }] });
  assert.deepEqual(await collectDuplicateContent({ ...args, octokit }), { headSha: 'head', paths: null, reason: 'content-head-moved' });
});
