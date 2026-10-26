import './helpers/rate-limit-state-isolation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchMergeAgentCandidate } from '../src/merge-agent-candidate.mjs';

test('fetchMergeAgentCandidate honors the injected branch-protection reader', async () => {
  const branchProtectionCache = new Map();
  const env = { GITHUB_TOKEN: 'test-token' };
  const execFileImpl = async () => { throw new Error('unexpected subprocess'); };
  const calls = [];
  const candidate = await fetchMergeAgentCandidate('fixture/project', 401, {
    preparedSnapshot: { state: 'OPEN', baseRefName: 'main', headRefOid: 'injected-head' },
    guardStackedBaseImpl: async () => null,
    branchProtectionCache, env, execFileImpl,
    fetchCachedAdversarialGateBranchProtectionImpl: async (options) => {
      calls.push(options);
      return { ok: true, reason: 'injected-protection', context: 'custom/gate',
        requiredContexts: ['custom/gate', 'ci/test'] };
    },
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    cache: branchProtectionCache, repoPath: 'fixture/project', baseBranch: 'main',
    execFileImpl, env,
  });
  assert.equal(calls[0].cache, branchProtectionCache);
  assert.equal(calls[0].env, env);
  assert.deepEqual(candidate.branchProtection, {
    ok: true, reason: 'injected-protection', requiredContext: 'custom/gate',
    requiredContexts: ['custom/gate', 'ci/test'],
  });
});


test('CIBLOCKINFRA-01 candidate retains bounded exact-head job evidence for closure', async () => {
  const calls = [];
  const candidate = await fetchMergeAgentCandidate('example/fixture', 42, {
    preparedSnapshot: { state: 'OPEN', headRefOid: 'a'.repeat(40),
      statusCheckRollup: [{ name: 'unit', conclusion: 'FAILURE',
        detailsUrl: 'https://github.com/example/fixture/actions/runs/10/job/1' }] },
    guardStackedBaseImpl: async () => null,
    execFileImpl: async (bin, args) => {
      calls.push({ bin, args });
      return { stdout: JSON.stringify({ jobs: [{ id: 1, head_sha: 'a'.repeat(40), conclusion: 'failure', steps: [] }] }) };
    },
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(candidate.statusCheckRollup[0].steps, []);
  assert.equal(candidate.checksConclusion, 'FAILURE', 'infrastructure still refuses merge');
});
