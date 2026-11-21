import test from 'node:test';
import { spawn } from 'node:child_process';
import { fixtureLifetime } from '../helpers/fixture-child.mjs';

// The guard's post-kill watchdog must be cancelled once the child closes.
// Track cancellation in this disposable worker rather than imposing a timing assertion.
const watchdogs = new Set();
let scheduled = 0;
const { setTimeout: schedule, clearTimeout: cancel } = globalThis;
globalThis.setTimeout = (callback, delay, ...args) => {
  const timer = schedule(callback, delay, ...args);
  if (delay === 2_000) {
    scheduled++;
    watchdogs.add(timer);
  }
  return timer;
};
globalThis.clearTimeout = timer => {
  watchdogs.delete(timer);
  cancel(timer);
};
process.once('beforeExit', () => {
  console.log(`KILL_WATCHDOGS_SCHEDULED=${scheduled} UNCANCELLED_KILL_WATCHDOGS=${watchdogs.size}`);
});

test('deliberately leaked detached child', () => {
  const child = spawn(process.execPath, ['-e', `${fixtureLifetime} setInterval(() => {}, 1_000);`], {
    detached: true,
    stdio: 'ignore',
  });
  console.log(`LEAKED_FIXTURE_PID=${child.pid}`);
});
