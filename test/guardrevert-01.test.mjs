import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchPrimaryChange, checkPrimaryChange } from '../src/ama/primary-change.mjs';

const base = 'a'.repeat(40), approved = 'b'.repeat(40), head = 'c'.repeat(40);
const guard = 'Reject generated catalog edits in PRs';
const path = 'docs/CATALOG.md';
const index = { filename: path, status: 'modified', additions: 1, deletions: 1,
  patch: '@@ -1 +1 @@\n-Base catalog\n+Regenerated catalog' };
const report = { filename: 'docs/report.md', status: 'added', additions: 1, deletions: 0,
  patch: '@@ -0,0 +1 @@\n+Synthetic incident report' };

function fixture(options = {}) {
  const hammer = { sha: head, parents: [{ sha: approved }],
    author: { login: 'hammer-worker' }, committer: { login: 'hammer-worker' },
    commit: { message: 'Repair generated catalog\n\nWorker-Class: hammer\nWorker-Ticket: HAM\nClosed-By: hammer (adversarial-pipe-mode)' } };
  const failed = { id: 11, name: guard, head_sha: approved, app: { id: 7 },
    status: 'completed', conclusion: 'failure', output: {} };
  const passing = { ...failed, id: 12, head_sha: head, conclusion: 'success' };
  const responses = {
    'pulls/1': { head: { sha: head }, base: { sha: base, ref: 'main' } },
    [`compare/${base}...${head}`]: { total_commits: 2, commits: [
      { sha: approved, commit: { message: 'Add reports' } }, hammer],
    merge_base_commit: { sha: base }, files: [report], filesComplete: true },
    [`compare/${base}...${approved}`]: { merge_base_commit: { sha: base }, files: [report, index], filesComplete: true },
    'branches/main/protection/required_status_checks': { checks: [{ context: guard, app_id: 7 }] },
    [`commits/${approved}/check-runs?per_page=100&page=1`]: { check_runs: [failed] },
    [`commits/${head}/check-runs?per_page=100&page=1`]: { check_runs: [passing] },
    'check-runs/11/annotations?per_page=100&page=1': [{ path, message: 'This file is forbidden in pull requests.' }],
    ...options.responses,
  };
  const calls = [];
  const args = { repo: 'fixture/repository', prNumber: 1, headSha: head,
    get: async endpoint => {
      const key = endpoint.replace('repos/fixture/repository/', ''); calls.push(key);
      if (!(key in responses)) throw new Error(`Unexpected fixture endpoint: ${key}`);
      return structuredClone(responses[key]);
    } };
  return { args, responses, calls, failed, passing };
}

async function evidenceFor(f) {
  return fetchPrimaryChange(f.args, { fetchCiCostImpl: async () => ({ headSha: head, ok: true }) });
}

test('GUARDREVERT-01: required guard authorizes only its named path restored to base', async () => {
  const f = fixture();
  const evidence = await evidenceFor(f);
  const result = checkPrimaryChange(evidence, head);
  assert.equal(result.ok, true);
  assert.deepEqual(result.guardReversals, [{ authorization: `Reversal-Authorized-By: guard:${guard}`,
    paths: [path], failedCheckRun: 11, passingCheckRun: 12, failedHead: approved, passingHead: head }]);
  // Removing another author change remains a refusal, even with valid guard authority.
  evidence.finalFiles = [];
  const unrelated = checkPrimaryChange(evidence, head);
  assert.equal(unrelated.reason, 'primary-change-reverted');
  assert.equal(unrelated.path, 'docs/report.md');
});

test('GUARDREVERT-01: failed, optional, stale, unnamed and partial restorations never gain guard authority', async () => {
  for (const mutate of [
    f => { f.responses['branches/main/protection/required_status_checks'] = { contexts: [] }; },
    f => { f.responses[`commits/${head}/check-runs?per_page=100&page=1`].check_runs[0].conclusion = 'failure'; },
    f => { f.responses[`commits/${head}/check-runs?per_page=100&page=1`].check_runs[0].head_sha = approved; },
    f => { f.responses[`commits/${head}/check-runs?per_page=100&page=1`].check_runs[0].app.id = 8; },
    f => { f.responses['check-runs/11/annotations?per_page=100&page=1'][0].path = 'docs/unrelated.md'; },
    f => { f.responses['check-runs/11/annotations?per_page=100&page=1'][0].message = 'Lint error.'; },
    f => { f.responses[`compare/${base}...${head}`].files.push({ ...index,
      patch: '@@ -1 +1 @@\n-Base catalog\n+Partially reverted catalog' }); },
  ]) {
    const control = await evidenceFor(fixture());
    assert.equal(checkPrimaryChange(control, head).ok, true);
    const f = fixture(); mutate(f);
    const result = checkPrimaryChange(await evidenceFor(f), head);
    assert.equal(result.ok && result.guardReversals?.length > 0, false);
  }
});
