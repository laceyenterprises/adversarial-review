import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSafePollOnce,
  computeWorkloadAwarePollDeadlineMs,
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

test('DEFAULT_POLL_DEADLINE_MS is exported and is large enough for a multi-PR org-wide scan', () => {
  assert.ok(Number.isFinite(DEFAULT_POLL_DEADLINE_MS));
  // Reviewer subprocess timeout is 5m; a single org-wide poll can
  // serialize multiple legitimate slow reviews in one pass. The
  // default must be comfortably larger than that or the watchdog
  // trips on legitimate work and the watcher restarts before
  // finishing the batch.
  const reviewerTimeoutMs = 5 * 60 * 1000;
  assert.ok(
    DEFAULT_POLL_DEADLINE_MS > reviewerTimeoutMs * 2,
    `expected DEFAULT_POLL_DEADLINE_MS (${DEFAULT_POLL_DEADLINE_MS}) > 2 * reviewer timeout (${reviewerTimeoutMs * 2})`
  );
});

test('safePollOnce accepts a deadlineMs function and resolves it per call', async () => {
  let calls = 0;
  const observed = [];
  const pollOnceImpl = async () => { calls += 1; };

  const safePollOnce = buildSafePollOnce({
    pollOnceImpl,
    octokit: 'stub',
    deadlineMs: (source) => {
      observed.push(source);
      return 1000;
    },
    log: { log: () => {}, error: () => {} },
  });

  await safePollOnce('startup pollOnce');
  await safePollOnce('scheduled pollOnce');

  assert.equal(calls, 2);
  assert.deepEqual(observed, ['startup pollOnce', 'scheduled pollOnce']);
});

test('safePollOnce throws when deadlineMs function returns a non-positive value', () => {
  const safePollOnce = buildSafePollOnce({
    pollOnceImpl: async () => {},
    octokit: 'stub',
    deadlineMs: () => 0,
    log: { log: () => {}, error: () => {} },
  });

  // Throws synchronously before pollOnceImpl runs — a misconfigured
  // dynamic deadline is a bug, not a poll-time failure to swallow.
  assert.throws(() => safePollOnce(), /positive finite number/);
});

test('safePollOnce times out using a function-resolved deadline', async () => {
  let resolveGate;
  const gate = new Promise((res) => { resolveGate = res; });

  const safePollOnce = buildSafePollOnce({
    pollOnceImpl: () => gate,
    octokit: 'stub',
    deadlineMs: () => 25,
    onTimeout: () => {},
    log: { log: () => {}, error: () => {} },
  });

  const result = await safePollOnce();
  assert.equal(result.timedOut, true);
  assert.equal(result.error.code, 'POLL_DEADLINE_EXCEEDED');
  resolveGate();
});

test('computeWorkloadAwarePollDeadlineMs scales with active repo count', () => {
  const small = computeWorkloadAwarePollDeadlineMs({ activeRepoCount: 1 });
  const big = computeWorkloadAwarePollDeadlineMs({ activeRepoCount: 12 });
  assert.ok(big > small, `expected ${big}ms > ${small}ms for higher load`);
});

test('computeWorkloadAwarePollDeadlineMs honors a non-trivial floor', () => {
  // A zero-repo or unknown-load case must still get a deadline well
  // above a single reviewer timeout, otherwise even one slow PR can
  // trip the watchdog before finishing.
  const reviewerTimeoutMs = 5 * 60 * 1000;
  const minimal = computeWorkloadAwarePollDeadlineMs({ activeRepoCount: 0 });
  assert.ok(
    minimal > reviewerTimeoutMs * 2,
    `expected workload-aware floor (${minimal}) > 2 * reviewer timeout`
  );
});

test('computeWorkloadAwarePollDeadlineMs covers the worst-case budget for a real org-wide load', () => {
  // The blocking review finding: 10m default fails when 2-3 slow PRs
  // legitimately serialize. With our default, even a 10-repo poll
  // with 5 reviewable PRs each must finish before the deadline.
  const reviewerTimeoutMs = 5 * 60 * 1000;
  const apiSlackMs = 5 * 60 * 1000;
  const repos = 10;
  const prs = 5;
  const worstCase = repos * prs * reviewerTimeoutMs + apiSlackMs;
  const computed = computeWorkloadAwarePollDeadlineMs({
    activeRepoCount: repos,
    maxPrsPerRepo: prs,
  });
  assert.ok(
    computed >= worstCase,
    `expected ${computed}ms >= worst-case ${worstCase}ms`
  );
});

test('safePollOnce keeps the watchdog timer ref\'d so a wedged promise still fires onTimeout', async () => {
  // The reviewer-flagged hang class: pollOnceImpl wedges on a never-
  // resolved promise with no active I/O handles. If the watchdog
  // timer were unref'd, Node could exit silently before firing it
  // and POLL_DEADLINE_EXCEEDED would be lost. With the timer ref'd,
  // the watchdog must still fire and onTimeout must still be called.
  let resolveGate;
  const gate = new Promise((res) => { resolveGate = res; });
  const timeouts = [];

  const safePollOnce = buildSafePollOnce({
    pollOnceImpl: () => gate, // never resolves; no I/O handles
    octokit: 'stub',
    deadlineMs: 25,
    onTimeout: (err, source) => timeouts.push({ code: err.code, source }),
    log: { log: () => {}, error: () => {} },
  });

  const result = await safePollOnce('hung-no-handles pollOnce');
  assert.equal(result.timedOut, true);
  assert.deepEqual(timeouts, [
    { code: 'POLL_DEADLINE_EXCEEDED', source: 'hung-no-handles pollOnce' },
  ]);
  resolveGate();
});
