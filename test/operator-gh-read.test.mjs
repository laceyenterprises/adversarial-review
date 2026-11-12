import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OPERATOR_GH_READ_MAX_BUDGET_MS,
  OPERATOR_GH_READ_NOMINAL_BUDGET_MS,
  OperatorGhReadTimeoutError,
  resolveOperatorGhReadBudgetMs,
  runOperatorGhRead,
} from '../src/operator-gh-read.mjs';

function capture() {
  const chunks = [];
  return { write(chunk) { chunks.push(String(chunk)); return true; }, text: () => chunks.join('') };
}

const loadPolicy = { enabled: true, maxMultiplier: 6, cpuBusyPercent: 100, cpuCount: 4 };

// execGhWithRetry stand-in: it calls the guarded execFile once and never
// returns on its own, the way a metering wait or a hung gh would.
function hungRead(seen) {
  return async ({ execFileImpl, signal, totalTimeoutMs, timeoutMs }) => {
    seen.push({ totalTimeoutMs, timeoutMs });
    return execFileImpl('gh', ['pr', 'view'], {});
  };
}

test('budget is load-aware but never exceeds the absolute cap; an override replaces it', () => {
  assert.equal(resolveOperatorGhReadBudgetMs({ ...loadPolicy, loadAvg1m: 0 }), OPERATOR_GH_READ_NOMINAL_BUDGET_MS);
  // load_per_core=11 is the incident load: the old path scaled a 30s timeout 6x.
  assert.equal(resolveOperatorGhReadBudgetMs({ ...loadPolicy, loadAvg1m: 44 }), OPERATOR_GH_READ_MAX_BUDGET_MS);
  assert.equal(OPERATOR_GH_READ_MAX_BUDGET_MS, 60_000);
  assert.equal(resolveOperatorGhReadBudgetMs({ overrideMs: 5_000, ...loadPolicy, loadAvg1m: 44 }), 5_000);
  assert.equal(resolveOperatorGhReadBudgetMs({ overrideMs: 120_000 }), 120_000);
  assert.throws(() => resolveOperatorGhReadBudgetMs({ overrideMs: 0 }), RangeError);
});

test('a gh child that never exits is killed at the budget with the typed reason', async () => {
  const stderr = capture();
  const seen = [];
  let childSignal;
  const started = Date.now();
  await assert.rejects(
    runOperatorGhRead({
      args: ['pr', 'view', '7', '--repo', 'example/repo'],
      label: 'head lookup for example/repo#7',
      timeoutReason: 'head-lookup-timeout',
      budgetMs: 150,
      stderr,
      execGhWithRetryImpl: hungRead(seen),
      execFileImpl: (_cmd, _args, options) => {
        childSignal = options.signal;
        return new Promise(() => {});
      },
    }),
    (err) => {
      assert.ok(err instanceof OperatorGhReadTimeoutError);
      assert.equal(err.reason, 'head-lookup-timeout');
      assert.equal(err.phase, 'gh');
      assert.equal(err.attempts, 1);
      assert.match(err.message, /did not finish within its 0\.2s budget \(waiting for `gh pr view` to exit; 1 attempt\)/);
      return true;
    },
  );
  assert.ok(Date.now() - started < 2_000);
  assert.equal(childSignal.aborted, true, 'the gh child is signalled');
  assert.deepEqual(seen, [{ totalTimeoutMs: 150, timeoutMs: 75 }]);
  assert.equal(stderr.text(), '[github-read] start head lookup for example/repo#7: `gh pr view` (budget 0.2s)\n');
});

test('a wait that never reaches gh (metering admission) is bounded too', async () => {
  await assert.rejects(
    runOperatorGhRead({
      args: ['pr', 'view'],
      label: 'head lookup',
      timeoutReason: 'head-lookup-timeout',
      budgetMs: 100,
      execGhWithRetryImpl: () => new Promise(() => {}),
    }),
    (err) => err.reason === 'head-lookup-timeout' && err.phase === 'admission' && err.attempts === 0
      && /waiting for GitHub metering\/budget admission before spawning `gh pr view`/.test(err.message),
  );
});

test('retries are reported on stderr and share the one budget', async () => {
  const stderr = capture();
  let calls = 0;
  const result = await runOperatorGhRead({
    args: ['pr', 'view', '7'],
    label: 'head lookup',
    timeoutReason: 'head-lookup-timeout',
    budgetMs: 10_000,
    backoffMs: 1,
    stderr,
    sleepImpl: async () => {},
    execFileImpl: async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('HTTP 502'), { stderr: 'HTTP 502 Bad Gateway' });
      return { stdout: 'abc\n', stderr: '' };
    },
  });
  assert.equal(result.stdout, 'abc\n');
  const lines = stderr.text().trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^\[github-read\] start head lookup: `gh pr view` \(budget 10s\)$/);
  assert.match(lines[1], /^\[github-read\] retry 1\/2 head lookup in 0s after HTTP 502 Bad Gateway \(.+ of 10s used\)$/);
});

test('a real GitHub failure is passed through, not relabelled as a timeout', async () => {
  await assert.rejects(
    runOperatorGhRead({
      args: ['pr', 'view', '7'],
      label: 'head lookup',
      timeoutReason: 'head-lookup-timeout',
      budgetMs: 10_000,
      execFileImpl: async () => {
        throw Object.assign(new Error('no pull requests found'), { stderr: 'no pull requests found' });
      },
    }),
    (err) => !(err instanceof OperatorGhReadTimeoutError) && /no pull requests found/.test(err.message),
  );
});
