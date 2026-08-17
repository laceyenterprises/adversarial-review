import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import {
  loadAwareMultiplier,
  loadAwareTimeoutSeconds,
  MIN_MULTIPLIER,
  MAX_MULTIPLIER,
  DEFAULT_MAX_TIMEOUT_SECONDS,
} from '../src/load-aware-timeout.mjs';

test('multiplier is 1x at or below one core of load (tight cap when idle)', () => {
  assert.equal(loadAwareMultiplier(0), 1);
  assert.equal(loadAwareMultiplier(0.5), 1);
  assert.equal(loadAwareMultiplier(1), 1);
});

test('multiplier ramps between load-per-core 1 and 3', () => {
  // factor = (2-1)/2 = 0.5 → 1 + 0.5*5 = 3.5x
  assert.equal(loadAwareMultiplier(2), 3.5);
});

test('multiplier saturates at MAX_MULTIPLIER (6x) for load-per-core >= 3', () => {
  assert.equal(loadAwareMultiplier(3), MAX_MULTIPLIER);
  assert.equal(loadAwareMultiplier(10), MAX_MULTIPLIER);
});

test('multiplier never drops below MIN_MULTIPLIER and tolerates junk', () => {
  assert.equal(loadAwareMultiplier(-5), MIN_MULTIPLIER);
  assert.equal(loadAwareMultiplier(NaN), MIN_MULTIPLIER);
  assert.equal(loadAwareMultiplier(undefined), MIN_MULTIPLIER);
});

test('idle host keeps the nominal timeout (1x)', () => {
  assert.equal(
    loadAwareTimeoutSeconds(360, { loadAvg1m: 2, cpuCount: 8 }), // loadPerCore 0.25
    360,
  );
});

test('contended host inflates the timeout so the first run has headroom', () => {
  // loadPerCore = 16/8 = 2 → 3.5x → ceil(360*3.5) = 1260
  assert.equal(loadAwareTimeoutSeconds(360, { loadAvg1m: 16, cpuCount: 8 }), 1260);
});

test('heavy contention caps at MAX_MULTIPLIER, not unbounded', () => {
  // loadPerCore = 48/8 = 6 → 6x → 2160
  assert.equal(loadAwareTimeoutSeconds(360, { loadAvg1m: 48, cpuCount: 8 }), 2160);
});

test('effective timeout is clamped to maxSeconds', () => {
  assert.equal(
    loadAwareTimeoutSeconds(1000, { loadAvg1m: 48, cpuCount: 8, maxSeconds: 1500 }),
    1500,
  );
});

test('never returns below the nominal even with a fractional base', () => {
  const out = loadAwareTimeoutSeconds(90.4, { loadAvg1m: 0, cpuCount: 8 });
  assert.ok(out >= 91, `expected >= ceil(90.4), got ${out}`);
});

test('DEFAULT_MAX_TIMEOUT_SECONDS is the fallback clamp', () => {
  const out = loadAwareTimeoutSeconds(2000, { loadAvg1m: 48, cpuCount: 8 });
  assert.equal(out, DEFAULT_MAX_TIMEOUT_SECONDS); // 2000*6=12000 clamped to 3600
});

test('default maxSeconds does not shrink a nominal timeout above the cap', () => {
  assert.equal(loadAwareTimeoutSeconds(7200, { loadAvg1m: 0, cpuCount: 8 }), 7200);
});

test('throws on a non-positive or unparseable base', () => {
  assert.throws(() => loadAwareTimeoutSeconds(0), /positive number/);
  assert.throws(() => loadAwareTimeoutSeconds(-1), /positive number/);
  assert.throws(() => loadAwareTimeoutSeconds('nope'), /positive number/);
});

test('CLI prints usage context for missing and help arguments while staying bounded', () => {
  for (const args of [[], ['--help'], ['-h']]) {
    const result = spawnSync(
      process.execPath,
      ['bin/load-aware-timeout.mjs', ...args],
      {
        cwd: new URL('..', import.meta.url),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '600');
    assert.match(result.stderr, /Usage: node bin\/load-aware-timeout\.mjs <nominalSeconds>/);
  }
});

test('is pure given inputs — same args, same output, no clock/randomness', () => {
  const a = loadAwareTimeoutSeconds(300, { loadAvg1m: 12, cpuCount: 6 });
  const b = loadAwareTimeoutSeconds(300, { loadAvg1m: 12, cpuCount: 6 });
  assert.equal(a, b);
});
