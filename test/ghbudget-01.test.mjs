import './helpers/load-aware-timeout-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchPollingPrState } from '../src/polling-pr-state.mjs';
import { monitorGitHubBudgets } from '../src/github-budget-monitor.mjs';
import { createRateLimitThrottle, withGitHubBudgetScope, withCloserGitHubBudget,
  githubCredential, registerGitHubInstallationToken } from '../src/rate-limit-throttle.mjs';
import { fetchHammerPr } from '../src/hammer-pr-read.mjs';
import { parseGhDebug } from '../src/metered-gh.mjs';
import { getHeadCloserCommitSuppression } from '../src/head-closer-commit-suppression.mjs';
import { fetchPullRequestHeadAndState } from '../src/github-api.mjs';

function root(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ghbudget-fixture-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('60 unchanged polls cost one initial read; fresh 304 preserves exact head and a changed response becomes terminal', async t => {
  const dir = root(t);
  const oldKillSwitch = process.env.GHO_DISABLE_GRAPHQL_ROLLUP;
  delete process.env.GHO_DISABLE_GRAPHQL_ROLLUP;
  t.after(() => {
    if (oldKillSwitch === undefined) delete process.env.GHO_DISABLE_GRAPHQL_ROLLUP;
    else process.env.GHO_DISABLE_GRAPHQL_ROLLUP = oldKillSwitch;
  });
  let baselineReads = 0;
  for (let i = 0; i < 60; i++) {
    await fetchPullRequestHeadAndState('fixture/repo', 1, {
      env: { AGENT_OS_GITHUB_ADAPTER_AUTO_DISCOVERY: '0' },
      recordApiCallImpl: () => {},
      execFileImpl: async (command, args) => {
        assert.equal(command, 'gh');
        assert.ok(args.includes('graphql'));
        baselineReads++;
        return { stdout: JSON.stringify({ data: { repository: { pullRequest: {
          state: 'OPEN', headRefOid: 'a'.repeat(40), labels: { nodes: [], pageInfo: { hasNextPage: false } },
        } } } }) };
      },
    });
  }
  assert.equal(baselineReads, 60);
  let charged = 0, requests = 0, merged = false;
  const octokit = { rest: { pulls: { get: async params => {
    requests++;
    if (params.headers?.['if-none-match'] === '"fixture-v1"' && !merged) {
      throw Object.assign(new Error('not modified'), { status: 304 });
    }
    charged++;
    return { status: 200, headers: { etag: merged ? '"fixture-v2"' : '"fixture-v1"' },
      data: { state: merged ? 'closed' : 'open', head: { sha: merged ? 'b'.repeat(40) : 'a'.repeat(40) },
        merged_at: merged ? '2026-01-01T01:00:00Z' : null, labels: [{ name: 'hold' }] } };
  } } } };
  for (let i = 0; i < 60; i++) {
    const state = await fetchPollingPrState(octokit, dir, 'fixture/repo', 1);
    assert.equal(state.state, 'OPEN');
    assert.equal(state.headRefOid, 'a'.repeat(40));
    assert.deepEqual(state.labels, [{ name: 'hold' }]);
  }
  assert.equal(requests, 60);
  assert.equal(charged, 1); // before: 60 charged reads; after: 1 (98.3%).
  assert.ok(charged < baselineReads / 2);
  merged = true;
  const terminal = await fetchPollingPrState(octokit, dir, 'fixture/repo', 1);
  assert.equal(terminal.state, 'MERGED');
  assert.equal(terminal.headRefOid, 'b'.repeat(40));
  assert.equal(charged, 2);
});

test('polling defers at the unchanged floor; actual closer preconditions use the reserve, zero fails closed', async t => {
  let now = Date.now();
  const throttle = createRateLimitThrottle({ sharedStatePath: join(root(t), 'budget.json'),
    env: {}, nowMs: () => now, recordApiCallImpl: () => {} });
  await throttle.recordResponseRateLimit({ resource: 'core', credential: 'fixture-installation',
    remaining: 100, limit: 5400, resetAt: now + 3600000 });
  await withGitHubBudgetScope({}, async () => {
    await assert.rejects(throttle.awaitThrottleIfNeeded('core', 'fixture-installation'), { budgetDeferred: true });
    const snapshot = await fetchHammerPr('fixture/repo', 2, { withChecks: false, read: async () => {
      await throttle.awaitThrottleIfNeeded('core', 'fixture-installation');
      return { state: 'open', head: { sha: 'a'.repeat(40) }, labels: [] };
    } });
    assert.equal(snapshot.headRefOid, 'a'.repeat(40));
    let identityReads = 0;
    await getHeadCloserCommitSuppression({
      repoPath: 'fixture/repo', prNumber: 2, headSha: 'a'.repeat(40),
      fetchVerifiedCommitFromLocalGitImpl: async () => null,
      execGhWithRetryImpl: async ({ args }) => {
        identityReads++;
        await throttle.awaitThrottleIfNeeded('core', 'fixture-installation');
        return { stdout: JSON.stringify(args.some(arg => arg.includes('/comments')) ? [] :
          { sha: 'a'.repeat(40), message: 'synthetic builder commit' }) };
      },
    });
    assert.equal(identityReads, 2);
  });
  now++;
  await throttle.recordResponseRateLimit({ resource: 'core', credential: 'fixture-installation',
    remaining: 0, limit: 5400, resetAt: now + 3600000 });
  await withCloserGitHubBudget(async () => {
    await assert.rejects(throttle.awaitThrottleIfNeeded('core', 'fixture-installation'), { budgetDeferred: true });
  });
});

test('one sustained installation deficit alert across polls and monitor restarts; recovery rearms', async t => {
  const dir = root(t);
  const start = Date.now();
  const alerts = [], lines = [];
  const bucket = resource => ({ credential: 'installation-12-34', resource, remaining: 100,
    limit: 5400, resetAt: new Date(start + 3600000).toISOString() });
  const budgets = { core: bucket('core'), graphql: bucket('graphql') };
  const run = now => monitorGitHubBudgets({ rootDir: dir, budgets, now,
    deliverAlert: async (...args) => alerts.push(args), logger: { log: line => lines.push(line) } });
  await run(start);
  await run(start + 15 * 60000);
  assert.equal(alerts.length, 0);
  await run(start + 15 * 60000 + 1);
  await run(start + 20 * 60000);
  assert.equal(alerts.length, 1);
  assert.equal(lines.length, 4); // one line per installation per poll.
  budgets.core.remaining = budgets.graphql.remaining = 1000;
  await run(start + 21 * 60000);
  budgets.core.remaining = 100;
  await run(start + 22 * 60000);
  await run(start + 38 * 60000);
  assert.equal(alerts.length, 2);
  budgets.core.resetAt = new Date(start + 2 * 3600000).toISOString();
  await run(start + 61 * 60000);
  assert.equal(alerts.length, 2, 'a new exhausted window is not a recovered installation');
});

test('broker-verified installation identity survives token rotation without conflating foreign credentials', () => {
  registerGitHubInstallationToken('synthetic-token-one', '12', '34');
  registerGitHubInstallationToken('synthetic-token-two', '12', '34');
  assert.equal(githubCredential({ token: 'synthetic-token-one' }), 'installation-12-34');
  assert.equal(githubCredential({ token: 'synthetic-token-two' }), 'installation-12-34');
  assert.notEqual(githubCredential({ token: 'synthetic-foreign' }), 'installation-12-34');
});

test('HTTP attribution counts paginated responses and 304 without retaining bodies', () => {
  const trace = [200, 304].map(status => `* Request at fixture\n* Request to https://api.github.com/repos/fixture/repo/pulls\n< HTTP/2.0 ${status}\n< X-Ratelimit-Resource: core\n\nprivate body\n* Request took 1ms\n`).join('');
  const parsed = parseGhDebug(trace);
  assert.deepEqual(parsed.requests, [{ status: 200, resource: 'core', requestCategory: 'pr_list' },
    { status: 304, resource: 'core', requestCategory: 'pr_list' }]);
  assert.ok(!parsed.stderr.includes('private body'));
});
