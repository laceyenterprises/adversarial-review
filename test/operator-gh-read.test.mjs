import { FakeClock } from './helpers/load-time-kit.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  githubCredential, currentGitHubBudgetScope, recordResponseRateLimit, readGitHubBudgetBucketsSync,
} from '../src/rate-limit-throttle.mjs';

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

test('a gh child that never exits is killed at the budget with the typed reason', async t => {
  const clock = new FakeClock(t);
  const stderr = capture();
  const seen = [];
  let childSignal;
  const rejected = assert.rejects(
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

  await clock.flush();
  await clock.advance(150);
  await rejected;
  assert.equal(childSignal.aborted, true, 'the gh child is signalled');
  assert.deepEqual(seen, [{ totalTimeoutMs: 150, timeoutMs: 75 }]);
  assert.equal(stderr.text(), '[github-read] start head lookup for example/repo#7: `gh pr view` (budget 0.2s)\n');
});

test('a wait that never reaches gh (metering admission) is bounded too', async t => {
  const clock = new FakeClock(t);
  let admissionSignal;
  let calls = 0;
  let settled = false;
  const rejected = assert.rejects(
    runOperatorGhRead({
      args: ['pr', 'view'],
      label: 'head lookup',
      timeoutReason: 'head-lookup-timeout',
      budgetMs: 100,
      execGhWithRetryImpl: ({ signal }) => {
        admissionSignal = signal;
        return new Promise(() => {});
      },
      execFileImpl: () => { calls += 1; assert.fail('admission must not spawn gh'); },
    }).finally(() => { settled = true; }),
    (err) => err.reason === 'head-lookup-timeout' && err.phase === 'admission' && err.attempts === 0
      && /waiting for GitHub metering\/budget admission before spawning `gh pr view`/.test(err.message),
  );

  await clock.flush();
  assert.ok(admissionSignal instanceof AbortSignal);
  await clock.advance(99);
  assert.equal(settled, false);
  assert.equal(admissionSignal.aborted, false);
  await clock.advance(1);
  await rejected;
  assert.equal(admissionSignal.aborted, true);
  assert.equal(calls, 0);
});

test('a killed gh attempt retains the execution phase when it rejects', async () => {
  const cause = Object.assign(new Error('Command failed: gh'), { killed: true, signal: 'SIGTERM' });
  await assert.rejects(
    runOperatorGhRead({
      args: ['pr', 'view'],
      label: 'head lookup',
      timeoutReason: 'head-lookup-timeout',
      budgetMs: 10_000,
      retries: 0,
      execFileImpl: async () => { throw cause; },
    }),
    (err) => {
      assert.ok(err instanceof OperatorGhReadTimeoutError);
      assert.equal(err.phase, 'gh');
      assert.equal(err.attempts, 1);
      assert.equal(err.cause, cause);
      assert.match(err.message, /waiting for `gh pr view` to exit/);
      return true;
    },
  );
});

test('a successful gh response followed by stalled metering retains the record phase', async t => {
  const clock = new FakeClock(t);
  const rejected = assert.rejects(
    runOperatorGhRead({
      args: ['pr', 'view'],
      label: 'head lookup',
      timeoutReason: 'head-lookup-timeout',
      budgetMs: 100,
      execFileImpl: async () => ({ stdout: 'head-sha\n', stderr: '' }),
      execGhWithRetryImpl: async ({ execFileImpl }) => {
        await execFileImpl('gh', ['pr', 'view'], {});
        return new Promise(() => {});
      },
    }),
    (err) => {
      assert.ok(err instanceof OperatorGhReadTimeoutError);
      assert.equal(err.phase, 'record');
      assert.equal(err.attempts, 1);
      assert.match(err.message, /waiting for GitHub metering to record the `gh pr view` response/);
      return true;
    },
  );

  await clock.flush();
  await clock.advance(100);
  await rejected;
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

test('a hanging fake gh process exits with the typed timeout inside the absolute budget', async () => {
  const execute = promisify(execFile);
  const started = performance.now();
  let signal;
  await assert.rejects(runOperatorGhRead({
    args: ['pr', 'view', '7'],
    label: 'synthetic lookup',
    timeoutReason: 'synthetic-lookup-timeout',
    budgetMs: 200,
    retries: 0,
    env: {},
    execFileImpl: (_command, _args, options) => {
      signal = options.signal;
      return execute(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options);
    },
  }), err => err instanceof OperatorGhReadTimeoutError && err.reason === 'synthetic-lookup-timeout');
  assert.ok(performance.now() - started < 2_000);
  assert.equal(signal.aborted, true);
});

test('credential-less operator reads have an isolated budget identity; tokens retain theirs', async t => {
  const root = mkdtempSync(join(tmpdir(), 'operator-budget-'));
  const previousPath = process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH;
  process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH = join(root, 'budget.json');
  t.after(() => {
    if (previousPath === undefined) delete process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH;
    else process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH = previousPath;
    rmSync(root, { recursive: true, force: true });
  });
  for (const resource of ['core', 'graphql']) {
    await recordResponseRateLimit({
      resource, credential: 'default', remaining: 0, limit: 60,
      resetAt: new Date(Date.now() + 60_000).toISOString(),
    });
  }
  const unscoped = githubCredential({ env: {} });
  assert.equal(unscoped, 'default');
  const tokenEnv = { GH_TOKEN: 'synthetic-operator-token' };
  const authenticated = githubCredential({ env: tokenEnv });
  await Promise.all([{}, tokenEnv].map(env => runOperatorGhRead({
    args: ['api', 'user'],
    label: 'synthetic lookup',
    timeoutReason: 'synthetic-lookup-timeout',
    env,
    execFileImpl: async (_command, _args, options) => {
      assert.ok(currentGitHubBudgetScope());
      assert.equal(githubCredential({ env: options.env }), env.GH_TOKEN ? authenticated : 'operator-cli');
      await Promise.resolve();
      assert.equal(githubCredential({ env: options.env }), env.GH_TOKEN ? authenticated : 'operator-cli');
      return { stdout: '{}', stderr: [
        '* Request at synthetic',
        '< HTTP/2.0 200',
        '< x-ratelimit-resource: core',
        '< x-ratelimit-limit: 60',
        '< x-ratelimit-remaining: 59',
        `< x-ratelimit-reset: ${Math.floor(Date.now() / 1000) + 60}`,
        '* Request took 1ms',
      ].join('\n') };
    },
  })));
  assert.equal(currentGitHubBudgetScope(), undefined);
  assert.equal(githubCredential({ env: {} }), unscoped);
  const buckets = readGitHubBudgetBucketsSync();
  assert.equal(buckets.core.remaining, 0, 'operator telemetry does not overwrite the default bucket');
  assert.equal(buckets['operator-cli/core'].remaining, 59);
});
