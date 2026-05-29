import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createReviewerMemoryAdmissionSampler,
  resolveFirstPassReviewerPoolConfig,
  reserveReviewerMemoryAdmission,
  runBoundedReviewerDispatchQueue,
  sortReviewerDispatchCandidates,
} from '../src/watcher-reviewer-pool.mjs';
import {
  PROJECTED_HEADROOM_FLOOR_MB,
  decideReviewerMemoryAdmission,
  peakReviewerMemoryMbFor,
} from '../src/watcher-memory-pressure.mjs';

function candidate(prNumber, run, createdAt = `2026-05-01T00:00:${String(prNumber).padStart(2, '0')}.000Z`) {
  return {
    repoPath: 'laceyenterprises/adversarial-review',
    prNumber,
    subject: { createdAt },
    current: null,
    run,
  };
}

test('reviewer pool respects the configured concurrency cap', async () => {
  let active = 0;
  let maxActive = 0;
  const tasks = Array.from({ length: 6 }, (_unused, index) => candidate(index + 1, async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
  }));

  const summary = await runBoundedReviewerDispatchQueue(tasks, {
    maxConcurrent: 3,
    logger: { error() {} },
  });

  assert.equal(summary.dispatched, 6);
  assert.equal(summary.maxObservedConcurrency, 3);
  assert.equal(maxActive, 3);
});

test('reviewer pool starts another PR while an older review is slow', async () => {
  const events = [];
  let releaseSlow;
  const slowStarted = new Promise((resolve) => {
    releaseSlow = resolve;
  });
  let runPromise;
  const secondStarted = new Promise((resolve) => {
    const tasks = [
      candidate(1, async () => {
        events.push('start:1');
        await slowStarted;
        events.push('done:1');
      }, '2026-05-01T00:00:00.000Z'),
      candidate(2, async () => {
        events.push('start:2');
        resolve();
      }, '2026-05-01T00:00:01.000Z'),
    ];
    runPromise = runBoundedReviewerDispatchQueue(tasks, {
      maxConcurrent: 2,
      logger: { error() {} },
    });
  });

  await secondStarted;
  assert.deepEqual(events.slice(0, 2), ['start:1', 'start:2']);
  releaseSlow();
  await runPromise;
});

test('reviewer dispatch candidates sort oldest pending PR first', () => {
  const sorted = sortReviewerDispatchCandidates([
    candidate(20, async () => {}, '2026-05-03T00:00:00.000Z'),
    candidate(10, async () => {}, '2026-05-01T00:00:00.000Z'),
    candidate(15, async () => {}, '2026-05-02T00:00:00.000Z'),
  ]);

  assert.deepEqual(sorted.map((item) => item.prNumber), [10, 15, 20]);
});

test('reviewer memory gate refuses a spawn when one more reviewer cannot fit', () => {
  const decision = decideReviewerMemoryAdmission({
    reviewerModel: 'codex',
    sample: {
      pressureLevel: 'nominal',
      availableMb: 1500,
      swapUsedPct: 10,
    },
  });

  assert.equal(decision.admit, false);
  assert.equal(decision.reason, 'memory_pressure_projected_headroom_low');
});

test('reviewer memory estimates keep browser-backed reviewers conservative', () => {
  assert.equal(peakReviewerMemoryMbFor('claude-code'), 512);
  assert.equal(peakReviewerMemoryMbFor('claude'), 512);
  assert.equal(peakReviewerMemoryMbFor('gemini'), 512);
  assert.equal(peakReviewerMemoryMbFor('codex'), 1024);
});

test('reviewer memory gate projected headroom uses available minus reserved minus estimate', () => {
  const decision = decideReviewerMemoryAdmission({
    reviewerModel: 'codex',
    reservedMb: 256,
    sample: {
      pressureLevel: 'nominal',
      availableMb: 2300,
      swapUsedPct: 10,
    },
  });

  assert.equal(decision.projectedHeadroomMb, 2300 - 256 - 1024);
  assert.equal(decision.reservedMb, 256);
  assert.equal(decision.projectedHeadroomMb < PROJECTED_HEADROOM_FLOOR_MB, true);
  assert.equal(decision.admit, false);
  assert.equal(decision.reason, 'memory_pressure_projected_headroom_low');
});

test('reviewer memory reservations are visible across concurrent admissions', async () => {
  const reservationState = { reservedMb: 0 };
  const checkAdmission = async ({ reviewerModel, reservedMb }) => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    return decideReviewerMemoryAdmission({
      reviewerModel,
      reservedMb,
      sample: {
        pressureLevel: 'nominal',
        availableMb: 2500,
        swapUsedPct: 10,
      },
    });
  };

  const attempts = await Promise.all([
    reserveReviewerMemoryAdmission({ reviewerModel: 'codex', reservationState, checkAdmission }),
    reserveReviewerMemoryAdmission({ reviewerModel: 'codex', reservationState, checkAdmission }),
    reserveReviewerMemoryAdmission({ reviewerModel: 'codex', reservationState, checkAdmission }),
  ]);

  assert.equal(attempts.filter((attempt) => attempt.admit).length, 1);
  assert.equal(reservationState.reservedMb, 1024);
  for (const attempt of attempts) {
    attempt.release?.();
  }
  assert.equal(reservationState.reservedMb, 0);
});

test('reviewer memory sampler reuses one host sample within a poll tick', async () => {
  let samples = 0;
  const sampleForTick = createReviewerMemoryAdmissionSampler({
    readSample: async () => {
      samples += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return {
        pressureLevel: 'nominal',
        availableMb: 5000,
        swapUsedPct: 10,
      };
    },
    logger: { warn() {} },
  });
  const seenSamples = [];
  const checkAdmission = async ({ reviewerModel, reservedMb, sample }) => {
    seenSamples.push(sample);
    return decideReviewerMemoryAdmission({ reviewerModel, reservedMb, sample });
  };
  const reservationState = { reservedMb: 0 };

  const attempts = await Promise.all([
    reserveReviewerMemoryAdmission({
      reviewerModel: 'codex',
      reservationState,
      checkAdmission,
      getMemoryPressureSample: sampleForTick,
    }),
    reserveReviewerMemoryAdmission({
      reviewerModel: 'claude',
      reservationState,
      checkAdmission,
      getMemoryPressureSample: sampleForTick,
    }),
  ]);

  assert.equal(samples, 1);
  assert.equal(seenSamples.length, 2);
  assert.equal(seenSamples[0], seenSamples[1]);
  assert.equal(attempts.every((attempt) => attempt.admit), true);
  for (const attempt of attempts) {
    attempt.release?.();
  }
  assert.equal(reservationState.reservedMb, 0);
});

test('reviewer memory sampler refreshes stale samples during long poll ticks', async () => {
  let samples = 0;
  let nowMs = 0;
  const sampleForTick = createReviewerMemoryAdmissionSampler({
    sampleTtlMs: 1000,
    now: () => nowMs,
    readSample: async () => {
      samples += 1;
      return {
        pressureLevel: 'nominal',
        availableMb: 5000 + samples,
        swapUsedPct: 10,
      };
    },
    logger: { warn() {} },
  });

  const first = await sampleForTick();
  nowMs = 999;
  const stillFresh = await sampleForTick();
  nowMs = 1000;
  const refreshed = await sampleForTick();

  assert.equal(samples, 2);
  assert.equal(first, stillFresh);
  assert.notEqual(refreshed, first);
  assert.equal(refreshed.availableMb, 5002);
});

test('reviewer memory sampler can be pinned to one sample with zero ttl', async () => {
  let samples = 0;
  let nowMs = 0;
  const sampleForTick = createReviewerMemoryAdmissionSampler({
    sampleTtlMs: 0,
    now: () => nowMs,
    readSample: async () => {
      samples += 1;
      return { pressureLevel: 'nominal', availableMb: 5000, swapUsedPct: 10 };
    },
    logger: { warn() {} },
  });

  const first = await sampleForTick();
  nowMs = 60_000;
  const second = await sampleForTick();

  assert.equal(samples, 1);
  assert.equal(first, second);
});

test('denied reviewer reservation reports the reservation used for the decision', async () => {
  const reservationState = { reservedMb: 1024 };
  const attempt = await reserveReviewerMemoryAdmission({
    reviewerModel: 'codex',
    reservationState,
    checkAdmission: async ({ reviewerModel, reservedMb }) => decideReviewerMemoryAdmission({
      reviewerModel,
      reservedMb,
      sample: {
        pressureLevel: 'nominal',
        availableMb: 2500,
        swapUsedPct: 10,
      },
    }),
  });

  assert.equal(attempt.admit, false);
  assert.equal(attempt.reservedMbBeforeAdmission, 1024);
  assert.equal(attempt.memoryDecision.reservedMb, 1024);
  assert.equal(reservationState.reservedMb, 1024);
});

test('reviewer pool clamps non-positive concurrency to one worker', async () => {
  let runs = 0;
  const tasks = Array.from({ length: 2 }, (_unused, index) => candidate(index + 1, async () => {
    runs += 1;
  }));

  const summary = await runBoundedReviewerDispatchQueue(tasks, {
    maxConcurrent: 0,
    logger: { error() {} },
  });

  assert.equal(summary.dispatched, 2);
  assert.equal(summary.maxObservedConcurrency, 1);
  assert.equal(runs, 2);
});

test('reviewer pool stops admitting new work after a thrown spawn failure', async () => {
  let started = 0;
  let releaseSecond;
  const secondCanFinish = new Promise((resolve) => {
    releaseSecond = resolve;
  });
  const tasks = [
    candidate(1, async () => {
      started += 1;
      throw new Error('spawn path broken');
    }),
    candidate(2, async () => {
      started += 1;
      await secondCanFinish;
    }),
    candidate(3, async () => {
      started += 1;
    }),
  ];

  const runPromise = runBoundedReviewerDispatchQueue(tasks, {
    maxConcurrent: 2,
    logger: { error() {} },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  releaseSecond();

  await assert.rejects(runPromise, /spawn path broken/);
  assert.equal(started, 2);
});

test('reviewer pool surfaces every concurrent task failure', async () => {
  const tasks = [
    candidate(1, async () => { throw new Error('first failure'); }),
    candidate(2, async () => { throw new Error('second failure'); }),
  ];

  await assert.rejects(
    () => runBoundedReviewerDispatchQueue(tasks, {
      maxConcurrent: 2,
      maxThrownFailures: 2,
      logger: { error() {} },
    }),
    (err) => {
      assert.equal(err instanceof AggregateError, true);
      assert.equal(err.errors.length, 2);
      assert.match(err.errors[0].message, /first failure/);
      assert.match(err.errors[1].message, /second failure/);
      return true;
    }
  );
});

test('reviewer pool flag can fall back to serial mode', () => {
  assert.deepEqual(
    resolveFirstPassReviewerPoolConfig({
      env: { ADVERSARIAL_FIRST_PASS_REVIEWER_POOL_ENABLED: 'false' },
      watcherConfig: { maxConcurrentFirstPassReviewers: 7 },
    }),
    { enabled: false, maxConcurrent: 1 }
  );
});

test('reviewer pool config accepts the first-pass pool concurrency alias', () => {
  assert.deepEqual(
    resolveFirstPassReviewerPoolConfig({
      env: { ADVERSARIAL_FIRST_PASS_REVIEWER_POOL_MAX_CONCURRENT: '5' },
      watcherConfig: {},
    }),
    { enabled: true, maxConcurrent: 5 }
  );
});
