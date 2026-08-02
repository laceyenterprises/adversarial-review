import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { main } from '../scripts/adversarial-runtime-canary.mjs';

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

test('airlock LaunchAgent schedules daily settle-smoke renewal with a hard bound', () => {
  const plist = readFileSync(
    new URL('../launchd/ai.laceyenterprises.adversarial-runtime-canary.airlock.plist', import.meta.url),
    'utf8',
  );

  assert.match(plist, /<key>StartCalendarInterval<\/key>/);
  assert.match(plist, /<string>--settle-smoke<\/string>/);
  assert.match(plist, /<key>ExitTimeOut<\/key>\s*<integer>660<\/integer>/);
});
