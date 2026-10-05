import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchCiCost, checkCiCost, evaluateCiCost } from '../src/ama/ci-cost.mjs';
import { checkPrimaryChange, fetchPrimaryChange } from '../src/ama/primary-change.mjs';
import { evaluateMergeEligibility } from '../src/ama/merge-eligibility.mjs';

const head = 'a'.repeat(40), base = 'b'.repeat(40);
const label = 'ci-cost-approved';
const workflow = 'on: [pull_request, push]\njobs:\n  test:\n    runs-on: macos-latest\n    steps:\n      - run: npm test\n';
function fixture({ login = null, type = 'User', failed = false, stale = false } = {}) {
  const pr = { head: { sha: stale ? base : head }, base: { sha: base }, changed_files: 1,
    labels: login ? [{ name: label }] : [] };
  return async (path) => {
    if (path.endsWith('/pulls/1')) return pr;
    if (path.includes('/compare/')) return { merge_base_commit: { sha: base }, commits: [], total_commits: 0 };
    if (path.includes('/files?')) return [{ filename: '.github/workflows/ci.yml', status: 'added' }];
    if (path.includes('/contents/')) return { encoding: 'base64', content: Buffer.from(workflow).toString('base64') };
    if (path.includes('/timeline?')) return [{ event: 'labeled', label: { name: label }, actor: { login, type } }];
    if (path.includes('/check-runs?')) return { check_runs: failed ? [{ name: 'CI-cost guard', status: 'completed', conclusion: 'failure' }] : [] };
    if (path.includes('/statuses?')) return [];
    throw new Error(`unexpected ${path}`);
  };
}
const read = (options = {}) => fetchCiCost({ repo: 'future/repo', prNumber: 1, headSha: head, operators: ['operator'], get: fixture(options) });

test('any repo: new macOS workflow refuses missing, worker, or bot authorization', async () => {
  for (const options of [{}, { login: 'worker' }, { login: 'operator', type: 'Bot' }]) {
    const result = await read(options);
    assert.equal(result.flagged, true);
    assert.equal(result.ok, false);
    assert.ok(result.added_minutes_per_pr_push > 0);
    assert.equal(checkCiCost(result, head).reason, 'ci-cost-unauthorized');
  }
});
test('operator authorization permits cost gate but failed CI remains unconditional', async () => {
  assert.equal(checkCiCost(await read({ login: 'operator' }), head).ok, true);
  assert.equal(checkCiCost(await read({ login: 'operator', failed: true }), head).reason, 'ci-cost-check-failed');
});
test('stale metadata, truncated files and read failures fail closed', async () => {
  assert.equal(checkCiCost(await read({ stale: true }), head).reason, 'ci-cost-read-failed');
  const evidence = await fetchCiCost({ repo: 'future/repo', prNumber: 1, headSha: head, operators: ['operator'], get: async () => { throw new Error('offline'); } });
  assert.equal(checkCiCost(evidence, head).reason, 'ci-cost-read-failed');
  assert.equal(checkCiCost(null, head).ok, false);
});
test('ordinary history without hammer commits still carries mandatory cost evidence', async () => {
  const evidence = await fetchPrimaryChange({ repo: 'future/repo', prNumber: 1, headSha: head, operators: ['operator'], get: fixture() });
  assert.equal(evidence.hasHammerCommits, false);
  assert.equal(checkPrimaryChange(evidence, head).reason, 'ci-cost-unauthorized');
});
test('merge eligibility refuses flagged diff, preserves other gates with approval', async () => {
  const state = { verdict: 'settled-success', requiredChecks: true, mergeable: true,
    branchProtectionRequired: false, candidateHead: head, validatedHead: head, leaseHeld: true, labels: [],
    primaryChange: { headSha: head, hasHammerCommits: false, ciCost: await read() } };
  assert.ok(evaluateMergeEligibility(state).reasons.includes('ci-cost-unauthorized'));
  state.primaryChange.ciCost = await read({ login: 'operator' });
  assert.equal(evaluateMergeEligibility(state).eligible, true);
  state.requiredChecks = false;
  assert.ok(evaluateMergeEligibility(state).reasons.includes('ci-not-green'));
});
test('Linux path-filtered concurrency-preserving change remains clear', () => {
  const old = { on: { pull_request: { paths: ['src/**'] } }, concurrency: { group: 'ci', 'cancel-in-progress': true }, jobs: { lint: { 'runs-on': 'ubuntu-latest', steps: [{ run: 'python lint.py' }] } } };
  const after = structuredClone(old);
  after.jobs.lint.steps.push({ run: 'python check.py' });
  assert.equal(evaluateCiCost({ changes: [{ path: 'ci.yml', before: old, after }], operators: [] }).ok, true);
});
