import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  SCHEDULED_HARD_EXIT_MS,
  armScheduledHardExit,
  main,
  reportScheduledFailure,
} from '../scripts/adversarial-runtime-canary.mjs';

function passingFallback() {
  return {
    ok: true,
    durationMs: 1_000,
    status: { status: 'pass', detail: 'fixture healthy' },
  };
}

test('scheduled canary refreshes the agent-runtime settle smoke', async () => {
  let settleCalls = 0;
  let output = '';
  const code = await main(
    ['--fixture', '--settle-smoke', '--root', '/fixture'],
    {
      stdout: { write: (value) => { output += value; } },
      stderr: { write() {} },
      createLocalRuntimeImpl: () => ({ run() {} }),
      createFixtureReviewerImpl: () => ({ run() {} }),
      runFallbackCanaryImpl: async () => passingFallback(),
      runSettleSmokeImpl: async ({ rootDir, runtime }) => {
        settleCalls += 1;
        assert.equal(rootDir, '/fixture');
        assert.equal(runtime, 'agent-runtime');
        return {
          ok: true,
          smoke: { status: 'pass', detail: 'settled with attribution' },
        };
      },
    },
  );

  assert.equal(code, 0);
  assert.equal(settleCalls, 1);
  assert.match(output, /fallback canary: PASS/);
  assert.match(output, /agent-runtime settle smoke: PASS/);
});

test('scheduled canary fails when settle smoke does not pass', async () => {
  const code = await main(
    ['--fixture', '--settle-smoke'],
    {
      stdout: { write() {} },
      stderr: { write() {} },
      createLocalRuntimeImpl: () => ({ run() {} }),
      createFixtureReviewerImpl: () => ({ run() {} }),
      runFallbackCanaryImpl: async () => passingFallback(),
      runSettleSmokeImpl: async () => ({
        ok: false,
        smoke: { status: 'fail', detail: 'missing worker attribution' },
      }),
    },
  );

  assert.equal(code, 1);
});

test('scheduled entry point arms an unreferenced hard-exit deadline', () => {
  let callback;
  let delay;
  let unrefCalls = 0;
  let exitCode = null;
  let stderr = '';

  armScheduledHardExit({
    setTimeoutImpl: (fn, timeoutMs) => {
      callback = fn;
      delay = timeoutMs;
      return { unref: () => { unrefCalls += 1; } };
    },
    exitImpl: (code) => { exitCode = code; },
    getExitCode: () => 0,
    stderr: { write: (value) => { stderr += value; } },
  });

  assert.equal(delay, SCHEDULED_HARD_EXIT_MS);
  assert.equal(unrefCalls, 1);
  callback();
  assert.equal(exitCode, 1);
  assert.match(stderr, /exceeded hard deadline/);
});

test('scheduled entry point renders a rejected canary promise as a clean failure', () => {
  let stderr = '';
  const code = reportScheduledFailure(new Error('settle smoke write failed'), {
    stderr: { write: (value) => { stderr += value; } },
  });

  assert.equal(code, 1);
  assert.equal(stderr, 'error: settle smoke write failed\n');
});

test('airlock LaunchAgent schedules daily settle-smoke renewal', () => {
  const plist = readFileSync(
    new URL('../launchd/ai.laceyenterprises.adversarial-runtime-canary.airlock.plist', import.meta.url),
    'utf8',
  );

  assert.match(plist, /<key>StartCalendarInterval<\/key>/);
  assert.match(plist, /<string>--settle-smoke<\/string>/);
});
