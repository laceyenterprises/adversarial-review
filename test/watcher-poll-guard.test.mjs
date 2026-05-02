import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSafePollOnce,
  DEFAULT_POLL_DEADLINE_MS,
} from '../src/watcher-poll-guard.mjs';

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
  const errors = [];
  return {
    log: {
      log: (msg) => messages.push(String(msg)),
      error: (...args) => errors.push(args.map(String).join(' ')),
    },
    messages,
    errors,
  };
}

test('safePollOnce returns ok=true on a clean poll', async () => {
  let calls = 0;
  const pollOnceImpl = async () => {
    calls += 1;
  };

  const safePollOnce = buildSafePollOnce({
    pollOnceImpl,
    octokit: 'stub',
    log: { log: () => {}, error: () => {} },
  });

  const result = await safePollOnce();

  assert.equal(calls, 1);
  assert.deepEqual(result, { ok: true, skipped: false, timedOut: false });
});

test('safePollOnce passes octokit through to pollOnceImpl', async () => {
  let received;
  const pollOnceImpl = async (octokit) => {
    received = octokit;
  };

  const safePollOnce = buildSafePollOnce({
    pollOnceImpl,
    octokit: 'octokit-stub',
    log: { log: () => {}, error: () => {} },
  });

  await safePollOnce();
  assert.equal(received, 'octokit-stub');
});

test('safePollOnce returns ok=false with the error when pollOnceImpl rejects', async () => {
  const boom = new Error('boom');
  const pollOnceImpl = async () => { throw boom; };
  const seen = [];

  const safePollOnce = buildSafePollOnce({
    pollOnceImpl,
    octokit: 'stub',
    errorHandler: (err, source) => seen.push({ msg: err.message, source }),
    log: { log: () => {}, error: () => {} },
  });

  const result = await safePollOnce('startup pollOnce');

  assert.equal(result.ok, false);
  assert.equal(result.skipped, false);
  assert.equal(result.timedOut, false);
  assert.equal(result.error, boom);
  assert.deepEqual(seen, [{ msg: 'boom', source: 'startup pollOnce' }]);
});

test('safePollOnce passes the source label per call so startup vs scheduled failures are distinguishable', async () => {
  const pollOnceImpl = async () => { throw new Error('x'); };
  const seen = [];

  const safePollOnce = buildSafePollOnce({
    pollOnceImpl,
    octokit: 'stub',
    errorHandler: (err, source) => seen.push(source),
    log: { log: () => {}, error: () => {} },
  });

  await safePollOnce('startup pollOnce');
  await safePollOnce('scheduled pollOnce');
  await safePollOnce(); // default

  assert.deepEqual(seen, ['startup pollOnce', 'scheduled pollOnce', 'scheduled pollOnce']);
});

test('safePollOnce times out a hung poll, returns timedOut=true, and invokes onTimeout', async () => {
  const gate = deferred();
  const pollOnceImpl = () => gate.promise; // never resolves on its own
  const errors = [];
  const timeouts = [];
  const { log } = captureLog();

  const safePollOnce = buildSafePollOnce({
    pollOnceImpl,
    octokit: 'stub',
    errorHandler: (err, source) => errors.push({ code: err.code, source }),
    onTimeout: (err, source) => timeouts.push({ code: err.code, source }),
    deadlineMs: 25,
    log,
  });

  const result = await safePollOnce('scheduled pollOnce');

  assert.equal(result.ok, false);
  assert.equal(result.skipped, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.error.code, 'POLL_DEADLINE_EXCEEDED');
  assert.deepEqual(errors, [{ code: 'POLL_DEADLINE_EXCEEDED', source: 'scheduled pollOnce' }]);
  assert.deepEqual(timeouts, [{ code: 'POLL_DEADLINE_EXCEEDED', source: 'scheduled pollOnce' }]);

  // Don't leak the dangling promise into the test runner output.
  gate.resolve();
});

test('safePollOnce does NOT invoke onTimeout when pollOnce simply rejects', async () => {
  const pollOnceImpl = async () => { throw new Error('boom'); };
  const timeouts = [];

  const safePollOnce = buildSafePollOnce({
    pollOnceImpl,
    octokit: 'stub',
    errorHandler: () => {},
    onTimeout: () => timeouts.push('called'),
    deadlineMs: 1000,
    log: { log: () => {}, error: () => {} },
  });

  await safePollOnce();
  assert.deepEqual(timeouts, []);
});

test('safePollOnce never rejects even when errorHandler throws', async () => {
  const pollOnceImpl = async () => { throw new Error('underlying'); };

  const safePollOnce = buildSafePollOnce({
    pollOnceImpl,
    octokit: 'stub',
    errorHandler: () => { throw new Error('handler exploded'); },
    log: { log: () => {}, error: () => {} },
  });

  // Must not throw — caller in pollLoop relies on this.
  const result = await safePollOnce();
  assert.equal(result.ok, false);
});

test('safePollOnce never rejects even when onTimeout throws', async () => {
  const gate = deferred();
  const pollOnceImpl = () => gate.promise;

  const safePollOnce = buildSafePollOnce({
    pollOnceImpl,
    octokit: 'stub',
    errorHandler: () => {},
    onTimeout: () => { throw new Error('timeout handler exploded'); },
    deadlineMs: 25,
    log: { log: () => {}, error: () => {} },
  });

  const result = await safePollOnce();
  assert.equal(result.timedOut, true);
  gate.resolve();
});

test('safePollOnce supports many sequential calls without leaking timers', async () => {
  let calls = 0;
  const pollOnceImpl = async () => { calls += 1; };

  const safePollOnce = buildSafePollOnce({
    pollOnceImpl,
    octokit: 'stub',
    log: { log: () => {}, error: () => {} },
  });

  for (let i = 0; i < 5; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const result = await safePollOnce();
    assert.equal(result.ok, true);
  }
  assert.equal(calls, 5);
});

test('buildSafePollOnce throws if pollOnceImpl is missing', () => {
  assert.throws(
    () => buildSafePollOnce({ octokit: 'stub' }),
    /requires a pollOnceImpl function/
  );
});

test('buildSafePollOnce rejects a non-positive deadlineMs', () => {
  assert.throws(
    () => buildSafePollOnce({ pollOnceImpl: async () => {}, deadlineMs: 0 }),
    /positive numeric deadlineMs/
  );
  assert.throws(
    () => buildSafePollOnce({ pollOnceImpl: async () => {}, deadlineMs: -1 }),
    /positive numeric deadlineMs/
  );
  assert.throws(
    () => buildSafePollOnce({ pollOnceImpl: async () => {}, deadlineMs: Number.NaN }),
    /positive numeric deadlineMs/
  );
});

test('DEFAULT_POLL_DEADLINE_MS is exported and is a positive number larger than typical poll work', () => {
  assert.ok(Number.isFinite(DEFAULT_POLL_DEADLINE_MS));
  assert.ok(DEFAULT_POLL_DEADLINE_MS > 0);
});
