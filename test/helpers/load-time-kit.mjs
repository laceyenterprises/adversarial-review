// Opt-in review-service twin of the LVR-11 load/time helpers. Units are ms.
import './load-aware-timeout-fixture.mjs';
import assert from 'node:assert/strict';
import os from 'node:os';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as hostSetTimeout, clearTimeout as hostClearTimeout } from 'node:timers';
import {
  DEFAULT_MAX_TIMEOUT_SECONDS, MAX_MULTIPLIER, MAX_TIMER_DELAY_MS,
  resetLoadAwareTimeoutCachesForTesting,
} from '../../src/load-aware-timeout.mjs';

export { MAX_TIMER_DELAY_MS };
const realSetTimeout = hostSetTimeout;
const realClearTimeout = hostClearTimeout;

function nonnegative(value, name) {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be finite and nonnegative`);
  return value;
}

/** Force the real scaler's policy and host readings, without probing the host. */
export function underMaxLoad(t, { maxMultiplier = MAX_MULTIPLIER } = {}) {
  if (!Number.isFinite(maxMultiplier) || maxMultiplier < 1 || maxMultiplier > 20) {
    throw new RangeError('maxMultiplier must be between 1 and 20');
  }
  // The existing fixture owns this temporary config and its lifetime. Register
  // after its beforeEach hook; never write a caller's host configuration.
  const configPath = process.env.AGENT_OS_CONFIG_PATH;
  assert.ok(configPath, 'load-aware timeout fixture must be active');
  const previous = readFileSync(configPath);
  writeFileSync(configPath, `version: 1\nadversarial:\n  reviewer:\n    load_aware:\n      enabled: true\n      max_multiplier: ${maxMultiplier}\n`);
  const cores = os.cpus().length || 1;
  const loadMock = t.mock.method(os, 'loadavg', () => [cores * (1 + 2 * maxMultiplier), 0, 0]);
  const cpuMock = t.mock.method(childProcess, 'execFileSync', command => {
    assert.equal(command, '/bin/ps', 'inject all other subprocess transports');
    return `${cores * 100}\n`;
  });
  syncBuiltinESMExports();
  resetLoadAwareTimeoutCachesForTesting();
  t.after(() => {
    loadMock.mock.restore();
    cpuMock.mock.restore();
    syncBuiltinESMExports();
    // The fixture may already have removed its temporary directory.
    if (existsSync(configPath)) writeFileSync(configPath, previous);
    resetLoadAwareTimeoutCachesForTesting();
  });
  return maxMultiplier;
}

export function assertTimerCeiling(ms, { baseMs = 0, ceilingMs = DEFAULT_MAX_TIMEOUT_SECONDS * 1000 } = {}) {
  nonnegative(ms, 'ms');
  nonnegative(baseMs, 'baseMs');
  nonnegative(ceilingMs, 'ceilingMs');
  assert.ok(ms <= MAX_TIMER_DELAY_MS, 'timeout exceeds timer ceiling');
  assert.ok(ms <= Math.max(Math.ceil(baseMs), ceilingMs), 'timeout exceeds policy ceiling');
}

/** Supply scaleInputs to detect repeated scaling even when a cap hides it. */
export function assertScaledOnce(ms, { baseMs, multiplier, ceilingMs = DEFAULT_MAX_TIMEOUT_SECONDS * 1000, scaleInputs } = {}) {
  nonnegative(baseMs, 'baseMs');
  if (!Number.isFinite(multiplier) || multiplier < 1) throw new RangeError('multiplier must be finite and at least one');
  assertTimerCeiling(ms, { baseMs, ceilingMs });
  const nominal = Math.ceil(baseMs);
  const expected = Math.min(MAX_TIMER_DELAY_MS,
    Math.max(nominal, Math.min(Math.ceil(baseMs * multiplier), Math.max(nominal, ceilingMs))));
  assert.equal(ms, expected, 'expected one scaling');
  if (scaleInputs !== undefined) assert.deepEqual(scaleInputs, [baseMs], 'expected exactly one scaling of the base');
}

export class FakeClock {
  // Accept a test context, { mock }, or MockTracker. Context cleanup restores
  // Date and timers; standalone tracker callers must restore their own mocks.
  constructor(t, { monotonic = 0, wall = 1_700_000_000_000 } = {}) {
    const mock = t?.mock ?? t;
    this.now = nonnegative(monotonic, 'monotonic');
    if (!Number.isFinite(wall)) throw new RangeError('wall must be finite');
    this.wall = wall;
    this.timers = mock.timers;
    // Node implicitly mocks the matching clear APIs; listing clearTimeout or
    // clearInterval explicitly in apis is unsupported (ERR_INVALID_ARG_VALUE).
    this.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const clock = this;
    const NativeDate = Date;
    // Node's mocked Date shares the timer timeline. Keep wall adjustments
    // separate so a backwards wall jump cannot delay a monotonic timer.
    mock.method(NativeDate, 'now', () => clock.wall);
    mock.method(globalThis, 'Date', new Proxy(NativeDate, {
      construct(target, args) { return Reflect.construct(target, args.length ? args : [clock.wall]); },
      apply() { return new NativeDate(clock.wall).toString(); },
    }));
  }
  monotonic() { return this.now; }
  time() { return this.wall; }
  async advance(ms, { wallMs = ms } = {}) {
    nonnegative(ms, 'ms');
    if (!Number.isFinite(wallMs)) throw new RangeError('wallMs must be finite');
    this.now += ms;
    this.wall += wallMs;
    this.timers.tick(ms);
    await this.flush();
  }
  async flush() {
    // tick() cannot run Promise jobs midway: advance loops one interval at a
    // time. This bounded drain matches the LVR-11 twin, not a general scheduler.
    for (let turn = 0; turn < 50; turn++) await Promise.resolve();
  }
}

/** Cooperative async jobs, a start barrier, and ordered unique checkpoints. */
export async function runConcurrently(actions, { schedule = [], timeoutMs = 5000 } = {}) {
  nonnegative(timeoutMs, 'timeoutMs');
  if (!timeoutMs || new Set(schedule).size !== schedule.length) throw new RangeError('positive timeout and unique checkpoint labels required');
  if (!actions.length && schedule.length) throw new RangeError('schedule requires actions');
  let cursor = 0;
  let stopped = false;
  const waiting = new Set();
  const visited = new Set();
  const checkpoint = async label => {
    if (!schedule.includes(label)) throw new Error(`unknown checkpoint: ${label}`);
    if (visited.has(label)) throw new Error('checkpoint already consumed');
    visited.add(label);
    while (!stopped && schedule[cursor] !== label) {
      await new Promise(resolve => waiting.add(resolve));
    }
    if (stopped) throw new Error('checkpoint interrupted');
    cursor++;
    for (const resolve of waiting) resolve();
    waiting.clear();
  };
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = realSetTimeout(() => reject(new Error('concurrent actions exceeded deadline')), timeoutMs);
  });
  try {
    const work = actions.map(async action => { await barrier; return action(checkpoint); });
    release();
    const results = await Promise.race([Promise.all(work), deadline]);
    assert.equal(cursor, schedule.length, 'schedule was not consumed');
    return results;
  } finally {
    stopped = true;
    for (const resolve of waiting) resolve();
    waiting.clear();
    realClearTimeout(timer);
  }
}
