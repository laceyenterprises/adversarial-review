import test from 'node:test';
import assert from 'node:assert/strict';
import { fireDagAutowalkOnMerge } from '../src/watcher.mjs';

function makeChild() {
  const errorHandlers = [];
  return {
    unrefCalls: 0,
    errorHandlers,
    unref() {
      this.unrefCalls += 1;
    },
    on(event, handler) {
      if (event === 'error') errorHandlers.push(handler);
      return this;
    },
  };
}

function makeLogger() {
  const logs = [];
  const errors = [];
  return {
    logs,
    errors,
    log: (m) => logs.push(m),
    error: (m) => errors.push(m),
  };
}

test('fireDagAutowalkOnMerge spawns detached hq dag autowalk-on-merge and unrefs', () => {
  const calls = [];
  const child = makeChild();
  const logger = makeLogger();
  const spawnImpl = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return child;
  };
  fireDagAutowalkOnMerge({ repo: 'acme/agent-os', prNumber: 42, spawnImpl, logger });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, [
    'dag', 'autowalk-on-merge', '--repo', 'acme/agent-os', '--pr', '42',
  ]);
  assert.equal(calls[0].opts.detached, true);
  assert.equal(calls[0].opts.stdio, 'ignore');
  assert.equal(child.unrefCalls, 1);
  assert.ok(logger.logs.some((m) => m.includes('autowalk-on-merge fired for acme/agent-os#42')));
});

test('fireDagAutowalkOnMerge swallows a synchronous spawn throw', () => {
  const logger = makeLogger();
  const spawnImpl = () => {
    throw new Error('boom');
  };
  // Must not throw.
  fireDagAutowalkOnMerge({ repo: 'acme/agent-os', prNumber: 7, spawnImpl, logger });
  assert.ok(logger.errors.some((m) => m.includes('spawn threw for acme/agent-os#7')));
});

test('fireDagAutowalkOnMerge swallows an async child error event', () => {
  const child = makeChild();
  const logger = makeLogger();
  const spawnImpl = () => child;
  fireDagAutowalkOnMerge({ repo: 'acme/agent-os', prNumber: 9, spawnImpl, logger });
  // Simulate ENOENT delivered asynchronously.
  assert.equal(child.errorHandlers.length, 1);
  child.errorHandlers[0](new Error('spawn hq ENOENT'));
  assert.ok(logger.errors.some((m) => m.includes('spawn failed for acme/agent-os#9')));
});

test('fireDagAutowalkOnMerge passes the PR number as a string', () => {
  const calls = [];
  const spawnImpl = (cmd, args) => {
    calls.push(args);
    return makeChild();
  };
  fireDagAutowalkOnMerge({ repo: 'acme/agent-os', prNumber: 123, spawnImpl, logger: makeLogger() });
  const prIdx = calls[0].indexOf('--pr');
  assert.equal(typeof calls[0][prIdx + 1], 'string');
  assert.equal(calls[0][prIdx + 1], '123');
});
