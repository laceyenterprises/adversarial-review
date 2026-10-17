import test from 'node:test';
import assert from 'node:assert/strict';
import { channel } from 'node:diagnostics_channel';
import { EventEmitter } from 'node:events';
import { createWatcherLatencyMonitor, observeSynchronousChild } from '../src/watcher-latency.mjs';

function fixture(t) {
  const logs = [];
  const histogram = { count: 1, percentile: p => p * 1e6, reset() {}, enable() {}, disable() {} };
  const monitor = createWatcherLatencyMonitor({ logger: { log: line => logs.push(line) }, histogram });
  t.after(() => monitor.stop());
  return { monitor, logs };
}

test('WATCHERLAG-01: poll summary emits event-loop p50/p99 and child spawn/wall times by command', t => {
  const { monitor, logs } = fixture(t);
  const child = new EventEmitter();
  channel('child_process').publish({ process: child });
  child.spawnfile = '/synthetic/bin/gh';
  child.spawnargs = ['secret-must-not-appear'];
  child.emit('spawn'); child.emit('close');
  observeSynchronousChild('psql', () => 'result');
  const summary = monitor.summary();
  assert.deepEqual(summary.event_loop, { p50_ms: 50, p99_ms: 99 });
  assert.equal(summary.children.gh.count, 1);
  assert.equal(summary.children.gh.completed, 1);
  assert.ok(summary.children.gh.spawn.p99_ms > 0);
  assert.ok(summary.children.psql.wall.p99_ms > 0);
  assert.match(logs[0], /poll latency summary/);
  assert.doesNotMatch(logs[0], /secret|synthetic/);
  assert.deepEqual(monitor.summary().children, {});
});

test('WATCHERLAG-01: a child spanning polls reports completion in its completion poll', t => {
  const { monitor } = fixture(t);
  const child = new EventEmitter();
  channel('child_process').publish({ process: child });
  child.spawnfile = 'hq'; child.emit('spawn');
  assert.equal(monitor.summary().children.hq.count, 1);
  child.emit('close');
  const next = monitor.summary().children.hq;
  assert.equal(next.count, 0);
  assert.equal(next.completed, 1);
});

test('WATCHERLAG-01: every poll emits a lag summary, including early return and error', async t => {
  const { monitor, logs } = fixture(t);
  assert.equal(await monitor.poll(async () => 'early'), 'early');
  await assert.rejects(monitor.poll(async () => { throw new Error('synthetic failure'); }), /synthetic failure/);
  assert.equal(logs.filter(line => line.includes('poll latency summary')).length, 2);
});
