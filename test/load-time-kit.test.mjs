import test from 'node:test';
import assert from 'node:assert/strict';
import {
  underMaxLoad, assertTimerCeiling, assertScaledOnce, FakeClock, runConcurrently, MAX_TIMER_DELAY_MS,
} from './helpers/load-time-kit.mjs';
import { loadAwareTimeoutMs } from '../src/load-aware-timeout.mjs';

for (const maxMultiplier of [1, 6, 17.5, 20]) {
  test(`maximum load reaches the real scaler at configured maximum ${maxMultiplier}`, t => {
    const multiplier = underMaxLoad(t, { maxMultiplier });
    assertScaledOnce(loadAwareTimeoutMs(100), { baseMs: 100, multiplier });
    assertScaledOnce(loadAwareTimeoutMs(1_000_000), { baseMs: 1_000_000, multiplier });
    for (const invalid of [0, 21, NaN, Infinity]) {
      assert.throws(() => underMaxLoad(t, { maxMultiplier: invalid }), /between 1 and 20/);
    }
  });
}

test('maximum-load mocks and cached policy do not leak into the next test', () => {
  assert.equal(loadAwareTimeoutMs(100), 100);
});

test('ceiling and scale-once assertions reject overflow and hidden repeated scaling', () => {
  assertTimerCeiling(MAX_TIMER_DELAY_MS, { ceilingMs: MAX_TIMER_DELAY_MS });
  assert.throws(() => assertTimerCeiling(MAX_TIMER_DELAY_MS + 1, { ceilingMs: 1e10 }), /timer ceiling/);
  assert.throws(() => assertTimerCeiling(3_600_001), /policy ceiling/);
  for (const invalid of [-1, NaN, Infinity]) assert.throws(() => assertTimerCeiling(invalid), /finite/);
  assertScaledOnce(4, { baseMs: 1.1, multiplier: 3.5 });
  assertScaledOnce(4_000_001, { baseMs: 4_000_000.1, multiplier: 6 });
  assertScaledOnce(20, { baseMs: 20, multiplier: 6, ceilingMs: 5 });
  assertScaledOnce(MAX_TIMER_DELAY_MS, { baseMs: MAX_TIMER_DELAY_MS + 100, multiplier: 20 });
  assert.throws(() => assertScaledOnce(360, { baseMs: 10, multiplier: 6 }), /one scaling/);
  assert.throws(() => assertScaledOnce(3_600_000, {
    baseMs: 1_000_000, multiplier: 6, scaleInputs: [1_000_000, 3_600_000],
  }), /exactly one/);
  assert.throws(() => assertScaledOnce(1, { baseMs: 1, multiplier: 0 }), /multiplier/);
});

for (const [name, source] of [
  ['context', t => t], ['tracker', t => t.mock], ['container', t => ({ mock: t.mock })],
]) {
  test(`fake minutes and wall adjustments have independent timelines (${name})`, async t => {
    const clock = new FakeClock(source(t), { monotonic: 10, wall: 1000 });
    let fired = 0;
    const interval = setInterval(() => { fired++; }, 60_000);
    setTimeout(() => { fired++; }, 60_000);
    await clock.advance(0, { wallMs: -900 });
    assert.equal(Date.now(), 100);
    assert.equal(new Date().getTime(), 100);
    assert.equal(new Date(123).getTime(), 123);
    assert.equal(clock.monotonic(), 10);
    assert.equal(fired, 0);
    await clock.advance(60_000);
    assert.equal(fired, 2);
    assert.equal(clock.monotonic(), 60_010);
    assert.equal(Date.now(), clock.time());
    clearInterval(interval);
    await clock.advance(60_000);
    assert.equal(fired, 2);
    await assert.rejects(clock.advance(-1), /finite/);
    await assert.rejects(clock.advance(1, { wallMs: NaN }), /finite/);
  });
}

test('mock timers and Date are restored between tests', () => {
  assert.ok(Math.abs(Date.now() - new Date().getTime()) < 1000);
  assert.ok(Date.now() > 1_000_000);
});

test('small jobs share a barrier, follow checkpoints and retain input order', async () => {
  const events = [];
  const result = await runConcurrently([
    async at => { await at('a'); events.push('a'); await at('a-done'); return 1; },
    async at => { await at('b'); events.push('b'); await at('b-done'); return 2; },
  ], { schedule: ['b', 'b-done', 'a', 'a-done'] });
  assert.deepEqual(events, ['b', 'a']);
  assert.deepEqual(result, [1, 2]);
});

test('worker errors, invalid schedules and deadlines fail boundedly under fake time', async t => {
  new FakeClock(t);
  await assert.rejects(runConcurrently([async () => { throw new Error('synthetic failure'); }]), /synthetic failure/);
  await assert.rejects(runConcurrently([async () => 1], { schedule: ['missing'] }), /not consumed/);
  await assert.rejects(runConcurrently([async at => at('unknown')]), /unknown checkpoint/);
  await assert.rejects(runConcurrently([async at => { await at('a'); await at('a'); }], { schedule: ['a'] }), /already consumed/);
  await assert.rejects(runConcurrently([], { schedule: ['a'] }), /requires actions/);
  await assert.rejects(runConcurrently([], { timeoutMs: 0 }), /positive timeout/);
  await assert.rejects(runConcurrently([], { schedule: ['a', 'a'] }), /unique/);
  await assert.rejects(runConcurrently([async at => at('later')], {
    schedule: ['missing', 'later'], timeoutMs: 20,
  }), /deadline/);
});
