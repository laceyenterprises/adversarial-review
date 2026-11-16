import './helpers/rate-limit-state-isolation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchPullRequestHeadAndState } from '../src/github-api.mjs';
import { __test__ as reviewerTest } from '../src/reviewer.mjs';
import { applyReviewScopeGates } from '../src/reviewer-scope-gates.mjs';
import { evaluateLivePackCrossEdits, reviewBodyHasLivePackCrossEditFinding } from '../src/live-pack-cross-edit.mjs';
import { checkLivePackMerge } from '../src/live-pack-merge-check.mjs';

const repo = 'fixture/agent-os';
const prNumber = 10931;
const head = '64940132690815503602fc0fa490df576bc957af';
const base = 'b'.repeat(40);
const approval = 'live-pack-edit-approved';
const packs = ['gym-oss-extraction', 'paddock-web'];
const paths = packs.flatMap(slug => [`projects/${slug}/plan.json`, `projects/${slug}/prompts/edit.md`]);
const reviewText = '## Summary\nCode reviewed.\n\n## Blocking issues\n- None.\n\n## Verdict\nComment only\n';
const log = { error() {}, warn() {} };
const evaluateOptions = {
  fetchFileAtRefImpl: async (_repo, path) => JSON.stringify({
    planId: `${path.split('/')[1]}-v1`, tickets: [{ id: 'PACK-01' }],
  }),
  readActiveDagRunsImpl: async ({ planId }) => ({
    ok: true, runs: [{ run_id: `run-${planId}`, state: 'running' }],
  }),
};

for (const scenario of ['approved', 'removed', 'unreadable']) {
  test(`LAC-2206: posting and preflight agree for two live packs after GraphQL failure (${scenario})`, async () => {
    const currentLabels = scenario === 'approved' ? [{ name: approval }] : [];
    // Deliberately opposite snapshots: neither addition nor removal can use
    // dispatch/context labels as authority after the model has finished.
    const staleLabels = scenario === 'approved' ? [] : [{ name: approval }];
    const pr = { state: 'open', title: 'PUBNOANNOUNCE-01: hold publication',
      head: { sha: head, ref: 'feature/PUBNOANNOUNCE-01' }, base: { sha: base },
      labels: currentLabels, user: { login: 'fixture-builder', type: 'User' } };
    const calls = [];
    const execFileImpl = async (command, args) => {
      assert.equal(command, 'gh');
      if (args.includes('graphql')) {
        calls.push('graphql');
        throw new Error('GraphQL connection timed out');
      }
      const endpoint = args.find(arg => arg.startsWith('repos/'));
      calls.push(endpoint);
      if (endpoint === `repos/${repo}/pulls/${prNumber}`) return { stdout: JSON.stringify(pr) };
      if (endpoint?.startsWith(`repos/${repo}/issues/${prNumber}/labels?`)) {
        if (scenario === 'unreadable') throw new Error('REST labels unavailable');
        return { stdout: JSON.stringify(currentLabels) };
      }
      assert.fail(`Unexpected GitHub read: ${args.join(' ')}`);
    };
    const current = await reviewerTest.fetchCurrentHeadVerdictMode({
      repo, prNumber, reviewerHeadSha: head, log,
      fetchPullRequestHeadAndStateImpl: (r, n, options) => fetchPullRequestHeadAndState(r, n, {
        ...options, execFileImpl, recordApiCallImpl() {},
        env: { AGENT_OS_GITHUB_ADAPTER_AUTO_DISCOVERY: '0' },
      }),
    });
    assert.equal(calls[0], 'graphql');
    assert.ok(calls.includes(`repos/${repo}/pulls/${prNumber}`));
    assert.deepEqual(current.labels, currentLabels);
    assert.equal(current.source, scenario === 'unreadable' ? 'fallback-enforce' : 'current-pr-head');
    const body = await applyReviewScopeGates(reviewText, {
      repo, prNumber, reviewerHeadSha: head, labels: current.labels, log,
      prContext: { title: pr.title, headRefName: pr.head.ref, baseRefName: base, labels: staleLabels },
      evaluateImpl: options => evaluateLivePackCrossEdits({ ...options, ...evaluateOptions, changedPaths: paths }),
    });
    assert.equal(reviewBodyHasLivePackCrossEditFinding(body), scenario !== 'approved');
    if (scenario === 'approved') {
      assert.match(body, /waived `live_pack_cross_edit` for 2 pack\(s\)/);
    } else {
      for (const pack of packs) assert.match(body, new RegExp(`Cross-pack edit of live build pack .${pack}`));
      assert.doesNotMatch(body, /Operator waiver observed/);
    }
    const merge = await checkLivePackMerge({
      repo, prNumber, headSha: head, ...evaluateOptions,
      readPrImpl: async () => {
        if (scenario === 'unreadable') throw new Error('REST unavailable');
        return pr;
      },
      listFilesImpl: async () => paths,
    });
    assert.equal(merge.ok, scenario === 'approved');
    if (scenario === 'approved') assert.equal(merge.waived, true);
  });
}
