import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSafePollOnce, SKIP_LOG_EVERY_N } from '../src/watcher-poll-guard.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function captureLog() {
  const messages = [];
  return {
    log: { log: (msg) => messages.push(String(msg)) },
    messages,
  };
}

test('safePollOnce serializes overlapping invocations', async () => {
  const calls = [];
  const gate = deferred();

  const pollOnceImpl = (octokit) => {
    calls.push(octokit);
    return gate.promise;
  };

  const { log, messages } = captureLog();
  const safePollOnce = buildSafePollOnce({
    pollOnceImpl,
    octokit: 'octokit-stub',
    log,
  });

  const first = safePollOnce();

  // While the first poll is still in-flight (gate not resolved), a
  // second invocation must not call pollOnceImpl again.
  const secondResult = await safePollOnce();
  const thirdResult = await safePollOnce();

  assert.equal(calls.length, 1, 'only the first invocation reaches pollOnceImpl');
  assert.deepEqual(secondResult, { skipped: true, skipCount: 1 });
  assert.deepEqual(thirdResult, { skipped: true, skipCount: 2 });

  gate.resolve();
  const firstResult = await first;
  assert.equal(firstResult.skipped, false);
  assert.equal(firstResult.skippedDuringPriorRun, 2);

  // First skip logged immediately; subsequent skips throttled.
  assert.ok(
    messages.some((m) => m.includes('skip count: 1')),
    'first skip is logged immediately'
  );
});

test('safePollOnce releases the in-flight flag after the underlying poll resolves', async () => {
  let calls = 0;
  const pollOnceImpl = async () => {
    calls += 1;
  };

  const safePollOnce = buildSafePollOnce({
    pollOnceImpl,
    octokit: 'stub',
    log: { log: () => {} },
  });

  await safePollOnce();
  await safePollOnce();
  await safePollOnce();

  assert.equal(calls, 3, 'sequential calls all reach pollOnceImpl');
});

test('safePollOnce releases the in-flight flag even when pollOnce throws', async () => {
  let calls = 0;
  const errors = [];
  const pollOnceImpl = async () => {
    calls += 1;
    throw new Error(`boom-${calls}`);
  };
  const errorHandler = (err) => errors.push(err.message);

  const safePollOnce = buildSafePollOnce({
    pollOnceImpl,
    octokit: 'stub',
    errorHandler,
    log: { log: () => {} },
  });

  await safePollOnce();
  await safePollOnce();

  assert.equal(calls, 2, 'a throw does not leave the flag stuck');
  assert.deepEqual(errors, ['boom-1', 'boom-2']);
});

test('safePollOnce throttles repeated skip log lines during a single long-running poll', async () => {
  const gate = deferred();
  const pollOnceImpl = () => gate.promise;
  const { log, messages } = captureLog();

  const safePollOnce = buildSafePollOnce({
    pollOnceImpl,
    octokit: 'stub',
    log,
  });

  safePollOnce();

  for (let i = 0; i < SKIP_LOG_EVERY_N + 1; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await safePollOnce();
  }

  gate.resolve();

  // First skip logged + one more at SKIP_LOG_EVERY_N. Anything between
  // is throttled, so the count of log lines is much smaller than the
  // count of skips.
  const skipLines = messages.filter((m) => m.includes('Skipping scheduled poll'));
  assert.equal(skipLines.length, 2, 'first skip + every-Nth skip = 2 log lines');
  assert.ok(skipLines[0].includes('skip count: 1'));
  assert.ok(skipLines[1].includes(`skip count: ${SKIP_LOG_EVERY_N}`));
});

test('safePollOnce reports skippedDuringPriorRun on the next successful run', async () => {
  const gate1 = deferred();
  let next = gate1;
  const pollOnceImpl = () => next.promise;

  const safePollOnce = buildSafePollOnce({
    pollOnceImpl,
    octokit: 'stub',
    log: { log: () => {} },
  });

  const first = safePollOnce();
  await safePollOnce();
  await safePollOnce();
  const gate2 = deferred();
  next = gate2;
  gate1.resolve();
  const firstResult = await first;
  assert.equal(firstResult.skippedDuringPriorRun, 2);

  // After a clean run, the skip counter resets, so the next poll
  // begins with a fresh window.
  const second = safePollOnce();
  gate2.resolve();
  const secondResult = await second;
  assert.equal(secondResult.skippedDuringPriorRun, 0);
});

test('buildSafePollOnce throws if pollOnceImpl is missing', () => {
  assert.throws(
    () => buildSafePollOnce({ octokit: 'stub' }),
    /requires a pollOnceImpl function/
  );
});
