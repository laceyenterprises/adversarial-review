import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cancelHqDispatch,
  readHqRemediationDispatchContext,
  isHqCancelRetryable,
} from '../src/remediation-hq-dispatch.mjs';

test('cancelHqDispatch retries transient shell failures before succeeding', async () => {
  const calls = [];
  const sleeps = [];
  const errors = [
    Object.assign(new Error('hq cancel child exited'), { code: 'EIO', stderr: '' }),
    Object.assign(new Error('hq cancel timed out'), { code: 1, stderr: 'timed out waiting for dispatch daemon' }),
  ];

  const result = await cancelHqDispatch({
    worker: {
      dispatchId: 'dispatch_retry_visible',
      hqRoot: '/tmp/hq-root',
    },
    env: {
      HQ_BIN: 'hq-test',
      PATH: process.env.PATH,
    },
    retryDelaysMs: [5, 9],
    sleepImpl: async (ms) => {
      sleeps.push(ms);
    },
    execFileImpl: async (command, args, options) => {
      calls.push({ command, args, options });
      const nextError = errors.shift();
      if (nextError) throw nextError;
      return { stdout: 'cancelled\n', stderr: '' };
    },
  });

  assert.equal(result.cancelled, true);
  assert.equal(result.attempts, 3);
  assert.equal(result.stdout, 'cancelled');
  assert.deepEqual(sleeps, [5, 9]);
  assert.deepEqual(
    calls.map((call) => [call.command, call.args, call.options.env.HQ_ROOT]),
    [
      ['hq-test', ['dispatch', 'cancel', 'dispatch_retry_visible', '--root', '/tmp/hq-root'], '/tmp/hq-root'],
      ['hq-test', ['dispatch', 'cancel', 'dispatch_retry_visible', '--root', '/tmp/hq-root'], '/tmp/hq-root'],
      ['hq-test', ['dispatch', 'cancel', 'dispatch_retry_visible', '--root', '/tmp/hq-root'], '/tmp/hq-root'],
    ],
  );
});

test('cancelHqDispatch stops immediately on non-retryable failures', async () => {
  const calls = [];
  const sleeps = [];

  const result = await cancelHqDispatch({
    worker: {
      dispatchId: 'dispatch_permission_denied',
      hqRoot: '/tmp/hq-root',
    },
    env: {
      HQ_BIN: 'hq-test',
      PATH: process.env.PATH,
    },
    retryDelaysMs: [5, 9],
    sleepImpl: async (ms) => {
      sleeps.push(ms);
    },
    execFileImpl: async (command, args) => {
      calls.push({ command, args });
      throw Object.assign(new Error('hq cancel refused'), {
        code: 2,
        stderr: 'permission denied',
      });
    },
  });

  assert.equal(result.cancelled, false);
  assert.equal(result.attempts, 1);
  assert.equal(result.retryable, false);
  assert.match(result.error, /hq cancel refused/);
  assert.deepEqual(sleeps, []);
  assert.equal(calls.length, 1);
});

test('isHqCancelRetryable treats child-process timeout codes as transient', () => {
  assert.equal(isHqCancelRetryable({ code: 'ETIMEDOUT', message: 'child process failed' }), true);
  assert.equal(isHqCancelRetryable({ code: 1, stderr: 'fatal: permission denied' }), false);
});

test('HQ remediation context preserves required values and validation order', () => {
  assert.deepEqual(readHqRemediationDispatchContext({ HQ_PARENT_SESSION: ' parent ', HQ_PROJECT: ' project ' }),
    { parentSession: 'parent', project: 'project' });
  assert.throws(() => readHqRemediationDispatchContext({}), /HQ_PARENT_SESSION must be set when HQ remediation dispatch is enabled/);
  assert.throws(() => readHqRemediationDispatchContext({ HQ_PARENT_SESSION: 'parent' }), /HQ_PROJECT must be set when HQ remediation dispatch is enabled/);
});
