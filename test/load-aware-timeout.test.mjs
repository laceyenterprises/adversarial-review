import './helpers/load-aware-timeout-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import {
  CPU_BUSY_THRESHOLD_PERCENT,
  corroboratedLoadAwareMultiplier,
  createCpuBusySampler,
  loadAwareMultiplier,
  loadAwareTimeoutMs,
  loadAwareTimeoutSeconds,
  MIN_MULTIPLIER,
  MAX_MULTIPLIER,
  DEFAULT_MAX_TIMEOUT_SECONDS,
} from '../src/load-aware-timeout.mjs';

test('shared load-aware multiplier parity table', () => {
  // Inputs and expected multipliers match the platform configuration contract.
  const cases = [
    // lpc, CPU busy percent (null = unavailable), cap, enabled, multiplier
    [0.5, 100, 6, true, '1.000'],
    [2.0, 85, 6, true, '3.500'],
    [3.0, 85, 6, true, '6.000'],
    [3.0, 42.5, 6, true, '3.500'],
    [2.51, 22.9, 6, true, '2.017'],
    [3.0, null, 6, true, '6.000'],
    [10.0, 100, 6, true, '6.000'],
    [10.0, 100, 20, true, '20.000'],
    [3.0, 100, 6, false, '1.000'],
  ];
  for (const [lpc, cpuBusyPercent, maxMultiplier, enabled, expected] of cases) {
    const multiplier = corroboratedLoadAwareMultiplier(lpc, cpuBusyPercent, maxMultiplier, enabled);
    const label = JSON.stringify({ lpc, cpuBusyPercent, maxMultiplier, enabled });
    assert.equal(multiplier.toFixed(3), expected, label);
    const opts = { loadAvg1m: lpc * 4, cpuCount: 4, cpuBusyPercent, maxMultiplier, enabled };
    assert.equal(loadAwareTimeoutSeconds(100, opts), Math.ceil(100 * multiplier), label);
    assert.equal(loadAwareTimeoutMs(100, opts), Math.ceil(100 * multiplier), label);
  }
});

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
  assert.equal(
    loadAwareTimeoutSeconds(360, { loadAvg1m: 16, cpuCount: 8, cpuBusyPercent: 95 }),
    1260,
  );
});

test('heavy contention caps at MAX_MULTIPLIER, not unbounded', () => {
  // loadPerCore = 48/8 = 6 → 6x → 2160
  assert.equal(
    loadAwareTimeoutSeconds(360, { loadAvg1m: 48, cpuCount: 8, cpuBusyPercent: 95 }),
    2160,
  );
});

test('high loadavg with low real CPU gets graded, not zero, patience', () => {
  // CONTRACT CHANGE 2026-09-05, with evidence.
  //
  // This previously asserted the nominal timeout: an uncorroborated loadavg
  // bought no patience at all. That rule is correct for ADMISSION control,
  // where acting on inflated load adds work and can harm the host. It is the
  // wrong trade for a TIMEOUT, where the costs are asymmetric: over-patience
  // delays hang detection, under-patience throws away a completed-but-slow
  // run and pays for the whole thing again.
  //
  // Measured on the production host: loadavg/core 2.51 at 22.9% CPU busy
  // suppressed a 4.78x extension entirely, and gemini reviewers died at their
  // nominal timeout -- observed attempt=2/4 and 3/4 across four PRs while the
  // merge queue grew to 18 open with 2 merges/hour. The host is blocked on
  // disk, so it never reaches the 85% gate and never earns any patience.
  //
  // Graded corroboration keeps hang detection bounded (relief is proportional
  // to measured CPU, and the 3600s clamp still applies) while ending the
  // all-or-nothing cliff.
  const graded = loadAwareTimeoutSeconds(360, {
    loadAvg1m: 80,
    cpuCount: 18,
    cpuBusyPercent: 37,
  });
  assert.ok(graded > 360, 'low-but-real CPU should buy some patience');
  const full = loadAwareTimeoutSeconds(360, {
    loadAvg1m: 80,
    cpuCount: 18,
    cpuBusyPercent: 85,
  });
  assert.ok(graded < full, 'partial corroboration must stay below full corroboration');
});

test('corroboration endpoints are unchanged', () => {
  // At/above the threshold the full multiplier still applies...
  assert.equal(
    loadAwareTimeoutSeconds(360, { loadAvg1m: 48, cpuCount: 8, cpuBusyPercent: 95 }),
    2160,
  );
  // ...and zero measured CPU still buys nothing.
  assert.equal(
    loadAwareTimeoutSeconds(360, { loadAvg1m: 80, cpuCount: 18, cpuBusyPercent: 0 }),
    360,
  );
});

test('an idle host keeps a tight cap even with full corroboration', () => {
  assert.equal(
    loadAwareTimeoutSeconds(360, { loadAvg1m: 0.5, cpuCount: 18, cpuBusyPercent: 90 }),
    360,
  );
});

test('unavailable or non-finite CPU uses the load curve and preserves policy controls', () => {
  for (const cpuBusyPercent of [null, undefined, NaN, Infinity, -Infinity]) {
    const opts = { enabled: true, maxMultiplier: 6, loadAvg1m: 28, cpuCount: 4, cpuBusyPercent };
    assert.equal(loadAwareTimeoutSeconds(9, opts), 54);
    assert.equal(loadAwareTimeoutMs(9, opts), 54);
    assert.equal(loadAwareTimeoutSeconds(9, { ...opts, loadAvg1m: 8 }), 32);
    assert.equal(loadAwareTimeoutSeconds(9, { ...opts, maxMultiplier: 2 }), 18);
    assert.equal(loadAwareTimeoutSeconds(9, { ...opts, enabled: false }), 9);
    assert.equal(loadAwareTimeoutSeconds(9, { ...opts, maxSeconds: 20 }), 20);
  }
});

for (const unavailable of [null, '', 'NaN\n', 'Infinity\n', '40\ninvalid\n', '1e308\n1e308\n']) {
  test(`CPU sampler substitutes for unavailable output ${JSON.stringify(unavailable)}`, () => {
    const warnings = [];
    const sample = createCpuBusySampler({ cpuCount: 2, nowMs: () => 0,
      warn: message => warnings.push(message),
      execFileSyncImpl: () => {
        if (unavailable === null) throw new Error('synthetic ps failure');
        return unavailable;
      } });
    assert.equal(sample(), null);
    assert.equal(corroboratedLoadAwareMultiplier(7, sample()), 6);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /using full load-based corroboration/);
  });
}

for (const busy of [0, 42.5, 85]) {
  test(`CPU sampler preserves fresh ${busy}% evidence, expires it, and recovers`, () => {
    let now = 0;
    let calls = 0;
    const warnings = [];
    const sample = createCpuBusySampler({ cpuCount: 2, nowMs: () => now,
      warn: message => warnings.push(message),
      execFileSyncImpl: () => {
        calls++;
        if (calls === 1) return `${busy * 2}\n`;
        if (calls === 5) return '170\n';
        if (calls === 3) return 'NaN\n';
        throw new Error('synthetic ps timeout');
      } });
    assert.equal(sample(), busy);
    now = 5000;
    assert.equal(sample(), busy);
    assert.match(warnings[0], /reusing last good sample/);
    now = 59999;
    assert.equal(sample(), busy);
    assert.equal(calls, 3);
    now = 60000;
    assert.equal(sample(), null, 'expire exactly at 60s, even during cached failure');
    assert.equal(calls, 3, 'failure remains cached for five seconds');
    assert.equal(warnings.length, 1, 'substitution warnings are rate-limited');
    now = 65000;
    assert.equal(sample(), null, 'failed retries must not renew successful evidence');
    assert.match(warnings[1], /using full load-based corroboration/);
    now = 70000;
    assert.equal(sample(), 85, 'a successful retry replaces stale evidence');
    assert.equal(warnings.length, 2);
  });
}

test('slow ps failures have a one-second budget to limit daemon event-loop stalls and cache from completion', () => {
  let now = 0;
  let calls = 0;
  const sample = createCpuBusySampler({ nowMs: () => now, warn() {},
    execFileSyncImpl: (command, args, options) => {
      assert.equal(command, '/bin/ps');
      assert.deepEqual(args, ['-A', '-o', '%cpu=']);
      // Sampling is synchronous on daemon hot paths; safe fallback needs no longer wait.
      assert.equal(options.timeout, 1000);
      calls++;
      now += options.timeout;
      throw new Error('synthetic ps timeout');
    } });
  assert.equal(sample(), null);
  assert.equal(now, 1000);
  for (let i = 0; i < 100; i++) assert.equal(sample(), null);
  now = 5999;
  assert.equal(sample(), null);
  assert.equal(calls, 1);
  now = 6000;
  assert.equal(sample(), null);
  assert.equal(calls, 2);
});

test('effective timeout is clamped to maxSeconds', () => {
  assert.equal(
    loadAwareTimeoutSeconds(1000, {
      loadAvg1m: 48,
      cpuCount: 8,
      cpuBusyPercent: CPU_BUSY_THRESHOLD_PERCENT,
      maxSeconds: 1500,
    }),
    1500,
  );
});

test('never returns below the nominal even with a fractional base', () => {
  const out = loadAwareTimeoutSeconds(90.4, { loadAvg1m: 0, cpuCount: 8 });
  assert.ok(out >= 91, `expected >= ceil(90.4), got ${out}`);
});

test('DEFAULT_MAX_TIMEOUT_SECONDS is the fallback clamp', () => {
  const out = loadAwareTimeoutSeconds(2000, {
    loadAvg1m: 48,
    cpuCount: 8,
    cpuBusyPercent: 95,
  });
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
  const a = loadAwareTimeoutSeconds(300, { loadAvg1m: 12, cpuCount: 6, cpuBusyPercent: 95 });
  const b = loadAwareTimeoutSeconds(300, { loadAvg1m: 12, cpuCount: 6, cpuBusyPercent: 95 });
  assert.equal(a, b);
});
