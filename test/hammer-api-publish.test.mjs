import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { publishHammerTree } from '../src/ama/hammer-api-publish.mjs';
import { fleetCommitIdentityMatches, fetchHammerHeadRange } from '../src/ama/hammer-head-validation.mjs';
const apiCommit = JSON.parse(readFileSync(new URL('./fixtures/hammer-commits/api.json', import.meta.url)));
const gitCommit = JSON.parse(readFileSync(new URL('./fixtures/hammer-commits/git.json', import.meta.url)));
const options = { repo: 'fixture/repo', branch: 'worker', expectedHead: 'before', localTree: 'tree', message: 'HAM\ntrailers',
  changes: [{ path: 'file', mode: '100644', contents: 'YQ==' }] };
test('real API fixture proves fleet identity; real git fixture and foreign author require re-review', async () => {
  assert.equal(fleetCommitIdentityMatches(apiCommit), true);
  for (const commit of [apiCommit, gitCommit, { ...apiCommit, author: { login: 'foreign' } }]) {
    const range = await fetchHammerHeadRange({ repo: 'fixture/repo', reviewedHead: 'reviewed', currentHead: commit.sha, env: {},
      get: async path => path.endsWith('/commits/main') ? { sha: 'base' } : { status: 'ahead', total_commits: 1, commits: [commit] } });
    assert.equal(range?.verified === true, commit === apiCommit);
  }
});
test('publication pins expected head and proves identical tree', async () => {
  const calls = [];
  const result = await publishHammerTree({ ...options, api: async (path, input) => {
    calls.push({ path, input });
    return input ? { data: { createCommitOnBranch: { commit: { oid: 'published' } } } } : { commit: { tree: { sha: 'tree' } } };
  } });
  assert.equal(result.route, 'published');
  assert.equal(calls[0].input.variables.input.expectedHeadOid, 'before');
  assert.deepEqual(calls[0].input.variables.input.fileChanges.additions, options.changes.map(({ path, contents }) => ({ path, contents })));
});
test('tree mismatch and API errors use re-review, preserving lease head for git fallback', async () => {
  const mismatch = await publishHammerTree({ ...options, api: async (_path, input) => input
    ? { data: { createCommitOnBranch: { commit: { oid: 'published' } } } } : { commit: { tree: { sha: 'different' } } } });
  assert.equal(mismatch.route, 're-review');
  assert.equal(mismatch.fallbackHead, 'published');
  assert.match(mismatch.reason, /tree mismatch/);
  const error = await publishHammerTree({ ...options, api: async () => { throw new Error('offline'); } });
  assert.equal(error.route, 're-review');
  assert.equal(error.fallbackHead, 'before');
});
test('file modes, symlinks and submodules fall back without calling API', async () => {
  for (const mode of ['100755', '120000', '160000']) {
    const result = await publishHammerTree({ ...options, changes: [{ path: 'file', mode }], api: () => assert.fail('API called') });
    assert.equal(result.route, 're-review');
  }
});
