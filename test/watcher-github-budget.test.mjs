import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLowBudgetWatcherPoll } from '../src/watcher-github-budget.mjs';
import { withGitHubBudgetScope } from '../src/rate-limit-throttle.mjs';

for (const names of [['hold', 'do-not-merge', 'operator-approved', 'retrigger-review', 'retrigger-remediation'], []]) {
  test(`low-budget poll passes label names to posted-row controls and objects to gate projection: ${names}`, async t => {
    const rootDir = mkdtempSync(join(tmpdir(), 'watcher-budget-labels-'));
    const keys = ['PATH', 'GHO_RATE_LIMIT_SHARED_STATE_PATH', 'GHO_RATE_LIMIT_THROTTLE_FLOOR'];
    const previous = keys.map(key => process.env[key]);
    t.after(() => {
      keys.forEach((key, i) => {
        if (previous[i] === undefined) delete process.env[key];
        else process.env[key] = previous[i];
      });
      rmSync(rootDir, { recursive: true, force: true });
    });
    const head = 'a'.repeat(40);
    const budgetPath = join(rootDir, 'budget.json');
    process.env.PATH = `${rootDir}:${process.env.PATH}`;
    process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH = budgetPath;
    process.env.GHO_RATE_LIMIT_THROTTLE_FLOOR = '200';
    writeFileSync(budgetPath, JSON.stringify({ version: 1, buckets: { core: {
      resource: 'core', remaining: 100, observedAt: new Date().toISOString(),
      resetAt: new Date(Date.now() + 60_000).toISOString(),
    }, graphql: { resource: 'graphql', remaining: 100, observedAt: new Date().toISOString(), resetAt: new Date(Date.now() + 60_000).toISOString() } } }));
    const gateDir = join(rootDir, 'data', 'adversarial-gate-status');
    mkdirSync(gateDir, { recursive: true });
    writeFileSync(join(gateDir, `fixture__repo-pr-42-${head}.json`), JSON.stringify({ state: 'success' }));
    const labels = names.map(name => ({ node_id: `LA_${name}`, name, color: 'ff0000' }));
    writeFileSync(join(rootDir, 'gh'), `#!${process.execPath}
import assert from 'node:assert/strict';
assert.deepEqual(process.argv.slice(2), ['api', 'repos/fixture/repo/pulls/42']);
console.log(${JSON.stringify(JSON.stringify({ state: 'open', head: { sha: head }, labels }))});
`, { mode: 0o755 });
    const row = { repo: 'fixture/repo', pr_number: 42, reviewer_head_sha: head, review_status: 'posted' };
    let handled = 0, projected = 0;
    await withGitHubBudgetScope({}, async scope => {
      assert.equal(await runLowBudgetWatcherPoll({
        db: { prepare: () => ({ all: () => [row] }) }, activeRepos: ['fixture/repo'], rootDir, domainId: 'code-pr',
        handlePostedReviewRow: async ({ labelNames, projectGateStatusSafe }) => {
          handled++;
          assert.deepEqual(labelNames, names);
          assert.equal(labelNames.includes('hold'), names.length > 0);
          assert.equal(new Set(labelNames).has('do-not-merge'), names.length > 0);
          await projectGateStatusSafe(row);
        },
        createWatcherOperatorSurface: () => ({}),
        projectAdversarialGateStatus: async (_root, options) => {
          projected++;
          assert.deepEqual(options.labels, labels.map(label => ({ id: label.node_id, name: label.name, color: label.color })));
        },
        markMerged: () => assert.fail('open PR must not be marked merged'),
        markClosed: () => assert.fail('open PR must not be marked closed'),
      }), true);
      assert.equal(scope.deferred, true);
    });
    assert.equal(handled, 1);
    assert.equal(projected, 1);
  });
}
