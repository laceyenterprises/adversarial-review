import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PostedReviewStepDeadlineError,
  handlePostedReviewRow,
  resolveMergeAgentCoexistenceOperationTimeoutMs,
  resolveMergeAgentCoexistenceStepDeadlineMs,
  runQueuedReviewAdoptionPhase,
  timePostedReviewStep,
} from '../src/posted-review-row.mjs';
import { createLogChangeGate } from '../src/log-change-gate.mjs';
import {
  DEFAULT_POSTED_REVIEW_BOUNDED_EXPENSIVE_STEP_COUNT,
  DEFAULT_POSTED_REVIEW_HANDLER_HEADROOM_MS,
  DEFAULT_POSTED_REVIEW_PHASE_BUDGET_MS,
  DEFAULT_POSTED_REVIEW_PHASE_HANDLER_CAPACITY,
  DEFAULT_POSTED_REVIEW_REVIEWER_PRESSURE_HANDLER_CAPACITY,
  derivePostedReviewExpensiveStepBudgetMs,
  enforcePostedReviewReviewerPressureBudgetFloor,
  resolvePostedReviewHandlerHeadroomMs,
  resolvePostedReviewHandlerTimeoutMs,
  resolvePostedReviewPhaseBudgetMs,
  resolvePostedReviewReviewerPressurePhaseBudgetMs,
  runPostedReviewHandlersFairly,
} from '../src/watcher-poll-fairness.mjs';

// Drive handlePostedReviewRow straight to the AMA `ama-pending` retained-ownership
// branch with fully injected collaborators, then assert the LOG-ONLY line is
// emitted once per retained-worker state transition rather than every tick.
function baseArgs(overrides = {}) {
  const logs = [];
  const existing = overrides.existing || { body_md: null, review_status: 'posted' };
  const args = {
    rootDir: '/tmp/adversarial-review-log-noise',
    repoPath: 'laceyenterprises/agent-os',
    prNumber: 4242,
    existing,
    subjectRef: null,
    currentRevisionRef: 'headsha-1',
    labelNames: [],
    projectGateStatusSafe: async () => {},
    fetchMergeAgentCandidateImpl: async () => ({ merged: false, prState: 'open' }),
    buildMergeAgentDispatchJobImpl: () => ({}),
    resolveMergeAgentCoexistenceForWatcherImpl: async () => ({
      outcome: 'ama-pending',
      amaClosureResult: {
        reason: 'daemon-failed-closed',
        launchRequestId: 'lrq_stuck',
        workerClass: 'hammer',
      },
    }),
    latestFollowUpJobFinder: () => null,
    latestPostedReviewBodyFinder: () => null,
    reviewBodyHasScopeViolationFindingImpl: () => false,
    currentReviewRowReader: () => existing,
    operatorSurface: null,
    logger: { log: (m) => logs.push(String(m)) },
    ...overrides,
  };
  return { args, logs };
}

const retained = (logs) => logs.filter((m) => /AMA hammer route retained ownership/.test(m));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('RVHAND-06: bounded posted-review step budgets fit under the handler cap', () => {
  const env = {
    ADVERSARIAL_WATCHER_POSTED_REVIEW_PHASE_BUDGET_MS: '330000',
    ADVERSARIAL_WATCHER_RESOLVE_MERGE_AGENT_COEXISTENCE_DEADLINE_MS: '300000',
  };

  const phaseBudgetMs = resolvePostedReviewPhaseBudgetMs(env);
  const handlerTimeoutMs = resolvePostedReviewHandlerTimeoutMs(env);
  const headroomMs = resolvePostedReviewHandlerHeadroomMs(env);
  const deadlineMs = resolveMergeAgentCoexistenceStepDeadlineMs(env);
  const derivedDeadlineMs = derivePostedReviewExpensiveStepBudgetMs(handlerTimeoutMs, { headroomMs });
  const boundedStepBudgetTotalMs = derivedDeadlineMs * DEFAULT_POSTED_REVIEW_BOUNDED_EXPENSIVE_STEP_COUNT;

  assert.equal(phaseBudgetMs, 330_000);
  assert.equal(handlerTimeoutMs, 180_000);
  assert.equal(deadlineMs, 87_500);
  assert.ok(deadlineMs < phaseBudgetMs);
  assert.ok(
    boundedStepBudgetTotalMs + headroomMs <= handlerTimeoutMs,
    `step budgets (${boundedStepBudgetTotalMs}ms) + headroom (${headroomMs}ms) ` +
      `must fit under handler cap (${handlerTimeoutMs}ms)`,
  );
});

test('RVHAND-10: posted-review HAM step budget admits observed live tails without exceeding the handler cap', () => {
  const handlerTimeoutMs = resolvePostedReviewHandlerTimeoutMs({});
  const phaseBudgetMs = resolvePostedReviewPhaseBudgetMs({});
  const headroomMs = resolvePostedReviewHandlerHeadroomMs({});
  const deadlineMs = resolveMergeAgentCoexistenceStepDeadlineMs({});

  assert.equal(handlerTimeoutMs, 180_000);
  assert.equal(phaseBudgetMs, DEFAULT_POSTED_REVIEW_PHASE_BUDGET_MS);
  assert.ok(phaseBudgetMs >= handlerTimeoutMs * DEFAULT_POSTED_REVIEW_PHASE_HANDLER_CAPACITY);
  assert.equal(deadlineMs, 87_500);
  assert.ok(deadlineMs > 80_000, 'live HAM candidate/coexistence tails have exceeded 75s under load');
  assert.ok(
    (deadlineMs * DEFAULT_POSTED_REVIEW_BOUNDED_EXPENSIVE_STEP_COUNT) + headroomMs <= handlerTimeoutMs,
    'the two bounded expensive steps must still fit inside one handler watchdog',
  );
});

test('RVHAND-10: invalid posted-review phase budget falls back to bounded default', () => {
  const env = { ADVERSARIAL_WATCHER_POSTED_REVIEW_PHASE_BUDGET_MS: 'invalid' };
  assert.equal(
    resolvePostedReviewPhaseBudgetMs(env),
    DEFAULT_POSTED_REVIEW_PHASE_BUDGET_MS,
  );
});

test('RVCOEX-01: coexistence operation timeout stays inside the step deadline', () => {
  const env = {
    ADVERSARIAL_WATCHER_RESOLVE_MERGE_AGENT_COEXISTENCE_DEADLINE_MS: '87500',
  };

  assert.equal(resolveMergeAgentCoexistenceOperationTimeoutMs(env, { stepDeadlineMs: 87_500 }), 60_000);
  assert.equal(
    resolveMergeAgentCoexistenceOperationTimeoutMs(
      { ...env, ADVERSARIAL_WATCHER_RESOLVE_MERGE_AGENT_COEXISTENCE_OPERATION_TIMEOUT_MS: '87000' },
      { stepDeadlineMs: 87_500 },
    ),
    87_000,
  );
  assert.equal(
    resolveMergeAgentCoexistenceOperationTimeoutMs(
      { ...env, ADVERSARIAL_WATCHER_RESOLVE_MERGE_AGENT_COEXISTENCE_OPERATION_TIMEOUT_MS: '999999' },
      { stepDeadlineMs: 87_500 },
    ),
    87_499,
  );
});

test('RVPRESS-02: reviewer-pressure budget keeps a multi-handler capacity floor', () => {
  const env = {
    ADVERSARIAL_WATCHER_POSTED_REVIEW_HANDLER_TIMEOUT_MS: '180000',
    ADVERSARIAL_WATCHER_POSTED_REVIEW_REVIEWER_PRESSURE_PHASE_BUDGET_MS: '180000',
  };
  const handlerTimeoutMs = resolvePostedReviewHandlerTimeoutMs(env);
  const pressureBudgetMs = resolvePostedReviewReviewerPressurePhaseBudgetMs(env);
  const minimumCapacity = 2;

  assert.equal(pressureBudgetMs, 360_000);
  assert.ok(
    pressureBudgetMs >= handlerTimeoutMs * minimumCapacity,
    `reviewer-pressure phase budget (${pressureBudgetMs}ms) must admit at least ` +
      `${minimumCapacity} handler windows (${handlerTimeoutMs}ms each)`,
  );
  assert.equal(
    pressureBudgetMs,
    handlerTimeoutMs * DEFAULT_POSTED_REVIEW_REVIEWER_PRESSURE_HANDLER_CAPACITY,
  );
});

test('RVHAND-11: reviewer-pressure posted-review phase budget has a bounded default and override', () => {
  assert.equal(resolvePostedReviewReviewerPressurePhaseBudgetMs({}), 360_000);
  assert.equal(
    resolvePostedReviewReviewerPressurePhaseBudgetMs({
      ADVERSARIAL_WATCHER_POSTED_REVIEW_HANDLER_TIMEOUT_MS: '60000',
    }),
    360_000,
  );
  assert.equal(
    resolvePostedReviewReviewerPressurePhaseBudgetMs({
      ADVERSARIAL_WATCHER_POSTED_REVIEW_REVIEWER_PRESSURE_PHASE_BUDGET_MS: '90000',
    }),
    360_000,
  );
  assert.equal(
    resolvePostedReviewReviewerPressurePhaseBudgetMs({
      ADVERSARIAL_WATCHER_POSTED_REVIEW_HANDLER_TIMEOUT_MS: '60000',
      ADVERSARIAL_WATCHER_POSTED_REVIEW_REVIEWER_PRESSURE_PHASE_BUDGET_MS: '240000',
    }),
    240_000,
  );
  assert.equal(
    resolvePostedReviewReviewerPressurePhaseBudgetMs({
      ADVERSARIAL_WATCHER_POSTED_REVIEW_PHASE_BUDGET_MS: '300000',
      ADVERSARIAL_WATCHER_POSTED_REVIEW_HANDLER_TIMEOUT_MS: '180000',
      ADVERSARIAL_WATCHER_POSTED_REVIEW_REVIEWER_PRESSURE_PHASE_BUDGET_MS: '900000',
    }),
    300_000,
  );
});

test('RVPRESS-02: call-site pressure budget guard raises direct low values', () => {
  const warnings = [];
  const minimumStartBudgetMs = derivePostedReviewExpensiveStepBudgetMs(180_000);

  assert.equal(
    enforcePostedReviewReviewerPressureBudgetFloor({
      pressureBudgetMs: 180_000,
      handlerTimeoutMs: 180_000,
      minimumHandlerStartBudgetMs: minimumStartBudgetMs,
      logger: { warn: (...args) => warnings.push(args.join(' ')) },
    }),
    360_000,
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /raised to handler-capacity floor/);
});

test('RVHAND-11: production default path warns when configured reviewer-pressure budget is below floor', async () => {
  const previousBudget = process.env.ADVERSARIAL_WATCHER_POSTED_REVIEW_REVIEWER_PRESSURE_PHASE_BUDGET_MS;
  const previousTimeout = process.env.ADVERSARIAL_WATCHER_POSTED_REVIEW_HANDLER_TIMEOUT_MS;
  const warnings = [];
  let observedBudgetMs;

  try {
    process.env.ADVERSARIAL_WATCHER_POSTED_REVIEW_HANDLER_TIMEOUT_MS = '180000';
    process.env.ADVERSARIAL_WATCHER_POSTED_REVIEW_REVIEWER_PRESSURE_PHASE_BUDGET_MS = '180000';

    await runQueuedReviewAdoptionPhase({
      drainReviewerDispatchCandidates: async () => ({ dispatched: 1, deferred: 0 }),
      retryPendingMergeAgentLifecycleCleanupsImpl: async () => {},
      syncPRLifecycleImpl: async () => {},
      retryPendingDagAutowalkOnMergeImpl: async () => {},
      retryPendingTriageSyncsImpl: async () => ({ attempted: 0, synced: 0, pending: 0 }),
      retryPendingMergeCloseoutsImpl: async () => {},
      retryPendingRetriggerAckCommentsImpl: async () => ({ attempted: 0, posted: 0 }),
      retryPendingRetriggerReviewAckCommentsImpl: async () => ({ attempted: 0, posted: 0 }),
      noProgressLaneGate: { shouldRun: () => true, recordResult: () => {} },
      postedReviewHandlers: [],
      postReviewMaintenanceHandlers: [],
      runPostedReviewHandlersFairlyImpl: async ({ budgetMs }) => {
        observedBudgetMs = budgetMs;
        return { executed: [], deferred: [], timedOut: null };
      },
      logger: { warn: (message) => warnings.push(String(message)) },
    });
  } finally {
    if (previousBudget === undefined) {
      delete process.env.ADVERSARIAL_WATCHER_POSTED_REVIEW_REVIEWER_PRESSURE_PHASE_BUDGET_MS;
    } else {
      process.env.ADVERSARIAL_WATCHER_POSTED_REVIEW_REVIEWER_PRESSURE_PHASE_BUDGET_MS = previousBudget;
    }
    if (previousTimeout === undefined) {
      delete process.env.ADVERSARIAL_WATCHER_POSTED_REVIEW_HANDLER_TIMEOUT_MS;
    } else {
      process.env.ADVERSARIAL_WATCHER_POSTED_REVIEW_HANDLER_TIMEOUT_MS = previousTimeout;
    }
  }

  assert.equal(observedBudgetMs, 360_000);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /posted-review phase budget capped under reviewer pressure/);
});

test('RVPRESS-02: reviewer-pressure cap preserves the operator normal budget in logs', async () => {
  const previousPhaseBudget = process.env.ADVERSARIAL_WATCHER_POSTED_REVIEW_PHASE_BUDGET_MS;
  const previousPressureBudget = process.env.ADVERSARIAL_WATCHER_POSTED_REVIEW_REVIEWER_PRESSURE_PHASE_BUDGET_MS;
  const previousTimeout = process.env.ADVERSARIAL_WATCHER_POSTED_REVIEW_HANDLER_TIMEOUT_MS;
  const warnings = [];
  let observedBudgetMs;

  try {
    process.env.ADVERSARIAL_WATCHER_POSTED_REVIEW_PHASE_BUDGET_MS = '1800000';
    process.env.ADVERSARIAL_WATCHER_POSTED_REVIEW_HANDLER_TIMEOUT_MS = '180000';
    delete process.env.ADVERSARIAL_WATCHER_POSTED_REVIEW_REVIEWER_PRESSURE_PHASE_BUDGET_MS;

    await runQueuedReviewAdoptionPhase({
      drainReviewerDispatchCandidates: async () => ({ dispatched: 1, deferred: 1 }),
      retryPendingMergeAgentLifecycleCleanupsImpl: async () => {},
      syncPRLifecycleImpl: async () => {},
      retryPendingDagAutowalkOnMergeImpl: async () => {},
      retryPendingTriageSyncsImpl: async () => ({ attempted: 0, synced: 0, pending: 0 }),
      retryPendingMergeCloseoutsImpl: async () => {},
      retryPendingRetriggerAckCommentsImpl: async () => ({ attempted: 0, posted: 0 }),
      retryPendingRetriggerReviewAckCommentsImpl: async () => ({ attempted: 0, posted: 0 }),
      noProgressLaneGate: { shouldRun: () => true, recordResult: () => {} },
      postedReviewHandlers: [],
      postReviewMaintenanceHandlers: [],
      runPostedReviewHandlersFairlyImpl: async ({ budgetMs }) => {
        observedBudgetMs = budgetMs;
        return { executed: [], deferred: [], timedOut: null };
      },
      logger: { warn: (message) => warnings.push(String(message)) },
    });
  } finally {
    if (previousPhaseBudget === undefined) {
      delete process.env.ADVERSARIAL_WATCHER_POSTED_REVIEW_PHASE_BUDGET_MS;
    } else {
      process.env.ADVERSARIAL_WATCHER_POSTED_REVIEW_PHASE_BUDGET_MS = previousPhaseBudget;
    }
    if (previousPressureBudget === undefined) {
      delete process.env.ADVERSARIAL_WATCHER_POSTED_REVIEW_REVIEWER_PRESSURE_PHASE_BUDGET_MS;
    } else {
      process.env.ADVERSARIAL_WATCHER_POSTED_REVIEW_REVIEWER_PRESSURE_PHASE_BUDGET_MS = previousPressureBudget;
    }
    if (previousTimeout === undefined) {
      delete process.env.ADVERSARIAL_WATCHER_POSTED_REVIEW_HANDLER_TIMEOUT_MS;
    } else {
      process.env.ADVERSARIAL_WATCHER_POSTED_REVIEW_HANDLER_TIMEOUT_MS = previousTimeout;
    }
  }

  assert.equal(observedBudgetMs, 360_000);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /budget_ms=360000/);
  assert.match(warnings[0], /normal_budget_ms=1800000/);
});

test('RVPRESS-02: reviewer-pressure cap is active under the production budget pair', async () => {
  const previousPhaseBudget = process.env.ADVERSARIAL_WATCHER_POSTED_REVIEW_PHASE_BUDGET_MS;
  const previousPressureBudget = process.env.ADVERSARIAL_WATCHER_POSTED_REVIEW_REVIEWER_PRESSURE_PHASE_BUDGET_MS;
  const previousTimeout = process.env.ADVERSARIAL_WATCHER_POSTED_REVIEW_HANDLER_TIMEOUT_MS;
  let observedBudgetMs;

  try {
    process.env.ADVERSARIAL_WATCHER_POSTED_REVIEW_PHASE_BUDGET_MS = '600000';
    process.env.ADVERSARIAL_WATCHER_POSTED_REVIEW_HANDLER_TIMEOUT_MS = '180000';
    delete process.env.ADVERSARIAL_WATCHER_POSTED_REVIEW_REVIEWER_PRESSURE_PHASE_BUDGET_MS;

    await runQueuedReviewAdoptionPhase({
      drainReviewerDispatchCandidates: async () => ({ dispatched: 1, deferred: 0 }),
      retryPendingMergeAgentLifecycleCleanupsImpl: async () => {},
      syncPRLifecycleImpl: async () => {},
      retryPendingDagAutowalkOnMergeImpl: async () => {},
      retryPendingTriageSyncsImpl: async () => ({ attempted: 0, synced: 0, pending: 0 }),
      retryPendingMergeCloseoutsImpl: async () => {},
      retryPendingRetriggerAckCommentsImpl: async () => ({ attempted: 0, posted: 0 }),
      retryPendingRetriggerReviewAckCommentsImpl: async () => ({ attempted: 0, posted: 0 }),
      noProgressLaneGate: { shouldRun: () => true, recordResult: () => {} },
      postedReviewHandlers: [],
      postReviewMaintenanceHandlers: [],
      runPostedReviewHandlersFairlyImpl: async ({ budgetMs }) => {
        observedBudgetMs = budgetMs;
        return { executed: [], deferred: [], timedOut: null };
      },
      logger: { warn: () => {} },
    });
  } finally {
    if (previousPhaseBudget === undefined) {
      delete process.env.ADVERSARIAL_WATCHER_POSTED_REVIEW_PHASE_BUDGET_MS;
    } else {
      process.env.ADVERSARIAL_WATCHER_POSTED_REVIEW_PHASE_BUDGET_MS = previousPhaseBudget;
    }
    if (previousPressureBudget === undefined) {
      delete process.env.ADVERSARIAL_WATCHER_POSTED_REVIEW_REVIEWER_PRESSURE_PHASE_BUDGET_MS;
    } else {
      process.env.ADVERSARIAL_WATCHER_POSTED_REVIEW_REVIEWER_PRESSURE_PHASE_BUDGET_MS = previousPressureBudget;
    }
    if (previousTimeout === undefined) {
      delete process.env.ADVERSARIAL_WATCHER_POSTED_REVIEW_HANDLER_TIMEOUT_MS;
    } else {
      process.env.ADVERSARIAL_WATCHER_POSTED_REVIEW_HANDLER_TIMEOUT_MS = previousTimeout;
    }
  }

  assert.ok(observedBudgetMs < 600_000);
  assert.equal(observedBudgetMs, 360_000);
});

test('RVPRESS-02: reviewer-pressure cap never exceeds operator normal budget', async () => {
  const previousPhaseBudget = process.env.ADVERSARIAL_WATCHER_POSTED_REVIEW_PHASE_BUDGET_MS;
  const previousPressureBudget = process.env.ADVERSARIAL_WATCHER_POSTED_REVIEW_REVIEWER_PRESSURE_PHASE_BUDGET_MS;
  const previousTimeout = process.env.ADVERSARIAL_WATCHER_POSTED_REVIEW_HANDLER_TIMEOUT_MS;
  const warnings = [];
  let observedBudgetMs;

  try {
    process.env.ADVERSARIAL_WATCHER_POSTED_REVIEW_PHASE_BUDGET_MS = '300000';
    process.env.ADVERSARIAL_WATCHER_POSTED_REVIEW_HANDLER_TIMEOUT_MS = '180000';
    process.env.ADVERSARIAL_WATCHER_POSTED_REVIEW_REVIEWER_PRESSURE_PHASE_BUDGET_MS = '180000';

    await runQueuedReviewAdoptionPhase({
      drainReviewerDispatchCandidates: async () => ({ dispatched: 1, deferred: 0 }),
      retryPendingMergeAgentLifecycleCleanupsImpl: async () => {},
      syncPRLifecycleImpl: async () => {},
      retryPendingDagAutowalkOnMergeImpl: async () => {},
      retryPendingTriageSyncsImpl: async () => ({ attempted: 0, synced: 0, pending: 0 }),
      retryPendingMergeCloseoutsImpl: async () => {},
      retryPendingRetriggerAckCommentsImpl: async () => ({ attempted: 0, posted: 0 }),
      retryPendingRetriggerReviewAckCommentsImpl: async () => ({ attempted: 0, posted: 0 }),
      noProgressLaneGate: { shouldRun: () => true, recordResult: () => {} },
      postedReviewHandlers: [],
      postReviewMaintenanceHandlers: [],
      runPostedReviewHandlersFairlyImpl: async ({ budgetMs }) => {
        observedBudgetMs = budgetMs;
        return { executed: [], deferred: [], timedOut: null };
      },
      logger: { warn: (message) => warnings.push(String(message)) },
    });
  } finally {
    if (previousPhaseBudget === undefined) {
      delete process.env.ADVERSARIAL_WATCHER_POSTED_REVIEW_PHASE_BUDGET_MS;
    } else {
      process.env.ADVERSARIAL_WATCHER_POSTED_REVIEW_PHASE_BUDGET_MS = previousPhaseBudget;
    }
    if (previousPressureBudget === undefined) {
      delete process.env.ADVERSARIAL_WATCHER_POSTED_REVIEW_REVIEWER_PRESSURE_PHASE_BUDGET_MS;
    } else {
      process.env.ADVERSARIAL_WATCHER_POSTED_REVIEW_REVIEWER_PRESSURE_PHASE_BUDGET_MS = previousPressureBudget;
    }
    if (previousTimeout === undefined) {
      delete process.env.ADVERSARIAL_WATCHER_POSTED_REVIEW_HANDLER_TIMEOUT_MS;
    } else {
      process.env.ADVERSARIAL_WATCHER_POSTED_REVIEW_HANDLER_TIMEOUT_MS = previousTimeout;
    }
  }

  assert.equal(observedBudgetMs, 300_000);
  assert.equal(warnings.length, 0);
});

test('RVHAND-11: reviewer-pressure floor leaves time to start one handler', async () => {
  const warnings = [];
  const ran = [];
  const handlerTimeoutMs = 180_000;
  const minimumStartBudgetMs = derivePostedReviewExpensiveStepBudgetMs(handlerTimeoutMs);
  const budgetMs = enforcePostedReviewReviewerPressureBudgetFloor({
    pressureBudgetMs: 10_000,
    handlerTimeoutMs,
    minimumHandlerStartBudgetMs: minimumStartBudgetMs,
    logger: { warn: (...args) => warnings.push(args.join(' ')) },
  });
  const nowValues = [0, 1, 2, 3];

  const summary = await runPostedReviewHandlersFairly({
    handlers: [
      {
        repoPath: 'laceyenterprises/agent-os',
        prNumber: 6528,
        run: async () => ran.push('handler'),
      },
    ],
    budgetMs,
    handlerTimeoutMs,
    minimumHandlerStartBudgetMs: minimumStartBudgetMs,
    nowMs: () => nowValues.shift() ?? 3,
    logger: { warn: (...args) => warnings.push(args.join(' ')) },
  });

  assert.equal(budgetMs, 360_000);
  assert.ok(budgetMs > minimumStartBudgetMs + DEFAULT_POSTED_REVIEW_HANDLER_HEADROOM_MS);
  assert.deepEqual(ran, ['handler']);
  assert.equal(summary.ran, 1);
  assert.equal(summary.deferredByBudget, 0);
  assert.equal(warnings.length, 1);
});

test('RVHAND-12: operator can still lower the HAM coexistence deadline during an incident', () => {
  const env = {
    ADVERSARIAL_WATCHER_RESOLVE_MERGE_AGENT_COEXISTENCE_DEADLINE_MS: '10000',
  };

  assert.equal(resolveMergeAgentCoexistenceStepDeadlineMs(env), 10_000);
});

test('timePostedReviewStep: warns while a step is still pending', async () => {
  const warnings = [];
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });

  const result = timePostedReviewStep(
    'resolve coexistence',
    'laceyenterprises/agent-os#4242',
    { warn: (m) => warnings.push(String(m)) },
    async () => {
      await pending;
      return 'done';
    },
    10,
  );

  await delay(100);

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /still running/);
  assert.match(warnings[0], /resolve coexistence exceeded 10ms/);

  release();
  assert.equal(await result, 'done');
  assert.equal(warnings.length, 2);
  assert.match(warnings[1], /completed/);
  assert.match(warnings[1], /resolve coexistence took \d+ms/);
});

test('timePostedReviewStep: does not warn for fast completed steps', async () => {
  const warnings = [];

  const result = await timePostedReviewStep(
    'project gate',
    'laceyenterprises/agent-os#4242',
    { warn: (m) => warnings.push(String(m)) },
    async () => 'ok',
    50,
  );

  assert.equal(result, 'ok');
  assert.deepEqual(warnings, []);
});

test('timePostedReviewStep: deadline rejects and aborts pending work', async () => {
  const errors = [];
  const warnings = [];
  let sawAbort = false;

  await assert.rejects(
    timePostedReviewStep(
      'resolveMergeAgentCoexistence',
      'laceyenterprises/agent-os#4242',
      {
        warn: (m) => warnings.push(String(m)),
        error: (m) => errors.push(String(m)),
      },
      ({ signal }) => new Promise((_, reject) => {
        signal.addEventListener('abort', () => {
          sawAbort = true;
          reject(signal.reason);
        });
      }),
      1000,
      { deadlineMs: 10 },
    ),
    PostedReviewStepDeadlineError,
  );

  assert.equal(sawAbort, true);
  assert.match(errors[0], /posted-review step deadline exceeded/);
  assert.match(errors[0], /deadline_ms=10/);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /posted-review step aborted after deadline/);
});

test('timePostedReviewStep: soft deadline rejects without aborting pending work', async () => {
  const errors = [];
  let sawAbort = false;
  let completed = false;
  let release;

  await assert.rejects(
    timePostedReviewStep(
      'resolveMergeAgentCoexistence',
      'laceyenterprises/agent-os#4242',
      {
        warn() {},
        error: (m) => errors.push(String(m)),
      },
      ({ signal }) => new Promise((resolve, reject) => {
        release = () => {
          completed = true;
          resolve('late-success');
        };
        signal.addEventListener('abort', () => {
          sawAbort = true;
          reject(signal.reason);
        });
      }),
      1000,
      { deadlineMs: 10, abortOnDeadline: false },
    ),
    PostedReviewStepDeadlineError,
  );

  assert.equal(sawAbort, false, 'soft deadline must not abort the running step');
  assert.match(errors[0], /posted-review step deadline exceeded/);

  release();
  await delay(25);
  assert.equal(completed, true, 'soft-deadlined work can still settle in the background');
});

test('timePostedReviewStep: soft-deadlined background failure is logged as an error', async () => {
  const errors = [];
  const warnings = [];
  let rejectLate;

  await assert.rejects(
    timePostedReviewStep(
      'resolveMergeAgentCoexistence',
      'laceyenterprises/agent-os#4242',
      {
        warn: (m) => warnings.push(String(m)),
        error: (m) => errors.push(String(m)),
      },
      () => new Promise((_, reject) => {
        rejectLate = reject;
      }),
      1000,
      { deadlineMs: 10, abortOnDeadline: false },
    ),
    PostedReviewStepDeadlineError,
  );

  rejectLate(new Error('hq dispatch exited 75'));
  await delay(25);

  assert.equal(warnings.length, 0);
  assert.match(errors[0], /posted-review step deadline exceeded/);
  assert.match(errors.join('\n'), /posted-review step failed in background after deadline/);
  assert.match(errors.join('\n'), /hq dispatch exited 75/);
});

test('handlePostedReviewRow: resolveMergeAgentCoexistence deadline is a soft handled outcome', async () => {
  const oldDeadline = process.env.ADVERSARIAL_WATCHER_RESOLVE_MERGE_AGENT_COEXISTENCE_DEADLINE_MS;
  process.env.ADVERSARIAL_WATCHER_RESOLVE_MERGE_AGENT_COEXISTENCE_DEADLINE_MS = '10';
  const errors = [];
  let sawAbort = false;
  const { args } = baseArgs({
    logger: {
      log() {},
      warn() {},
      error: (m) => errors.push(String(m)),
    },
    resolveMergeAgentCoexistenceForWatcherImpl: ({ signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => {
        sawAbort = true;
        reject(signal.reason);
      });
    }),
  });

  try {
    const result = await handlePostedReviewRow(args);

    assert.equal(sawAbort, false);
    assert.equal(result.handled, true);
    assert.equal(result.outcome, 'coexistence-deadline');
    assert.equal(
      result.amaClosureResult.reason,
      'resolve-merge-agent-coexistence-deadline-exceeded',
    );
    assert.match(errors.join('\n'), /reason=resolve-merge-agent-coexistence-deadline-exceeded/);
    assert.match(errors.join('\n'), /Leaving any in-flight HAM launch to settle/);
  } finally {
    if (oldDeadline === undefined) {
      delete process.env.ADVERSARIAL_WATCHER_RESOLVE_MERGE_AGENT_COEXISTENCE_DEADLINE_MS;
    } else {
      process.env.ADVERSARIAL_WATCHER_RESOLVE_MERGE_AGENT_COEXISTENCE_DEADLINE_MS = oldDeadline;
    }
  }
});

test('RVCOEX-01: resolveMergeAgentCoexistence deadline logs the in-flight operation', async () => {
  const oldDeadline = process.env.ADVERSARIAL_WATCHER_RESOLVE_MERGE_AGENT_COEXISTENCE_DEADLINE_MS;
  process.env.ADVERSARIAL_WATCHER_RESOLVE_MERGE_AGENT_COEXISTENCE_DEADLINE_MS = '10';
  const errors = [];
  const { args } = baseArgs({
    logger: {
      log() {},
      warn() {},
      error: (m) => errors.push(String(m)),
    },
    resolveMergeAgentCoexistenceForWatcherImpl: ({ operationTracker }) => new Promise(() => {
      operationTracker.current = 'ama-hammer-dispatch';
      operationTracker.currentStartedMs = performance.now();
    }),
  });

  try {
    const result = await handlePostedReviewRow(args);

    assert.equal(result.handled, true);
    assert.equal(result.outcome, 'coexistence-deadline');
    assert.match(errors.join('\n'), /in_flight_operation=ama-hammer-dispatch/);
    assert.match(errors.join('\n'), /in_flight_elapsed_ms=\d+/);
  } finally {
    if (oldDeadline === undefined) {
      delete process.env.ADVERSARIAL_WATCHER_RESOLVE_MERGE_AGENT_COEXISTENCE_DEADLINE_MS;
    } else {
      process.env.ADVERSARIAL_WATCHER_RESOLVE_MERGE_AGENT_COEXISTENCE_DEADLINE_MS = oldDeadline;
    }
  }
});

test('handlePostedReviewRow: HAM coexistence deadline does not abort in-flight launch settlement', async () => {
  const oldDeadline = process.env.ADVERSARIAL_WATCHER_RESOLVE_MERGE_AGENT_COEXISTENCE_DEADLINE_MS;
  process.env.ADVERSARIAL_WATCHER_RESOLVE_MERGE_AGENT_COEXISTENCE_DEADLINE_MS = '10';
  const errors = [];
  let sawAbort = false;
  let release;
  let settled = false;
  const { args } = baseArgs({
    logger: {
      log() {},
      warn() {},
      error: (m) => errors.push(String(m)),
    },
    resolveMergeAgentCoexistenceForWatcherImpl: ({ signal }) => new Promise((resolve, reject) => {
      release = () => {
        settled = true;
        resolve({
          outcome: 'ama-pending',
          amaClosureResult: {
            reason: 'dispatch-deferred-transient',
            workerClass: 'hammer',
          },
        });
      };
      signal.addEventListener('abort', () => {
        sawAbort = true;
        reject(signal.reason);
      });
    }),
  });

  try {
    const result = await handlePostedReviewRow(args);

    assert.equal(sawAbort, false);
    assert.equal(result.handled, true);
    assert.equal(result.outcome, 'coexistence-deadline');
    assert.equal(
      result.amaClosureResult.reason,
      'resolve-merge-agent-coexistence-deadline-exceeded',
    );
    assert.match(errors.join('\n'), /Leaving any in-flight HAM launch to settle/);

    release();
    await delay(25);
    assert.equal(settled, true);
  } finally {
    if (oldDeadline === undefined) {
      delete process.env.ADVERSARIAL_WATCHER_RESOLVE_MERGE_AGENT_COEXISTENCE_DEADLINE_MS;
    } else {
      process.env.ADVERSARIAL_WATCHER_RESOLVE_MERGE_AGENT_COEXISTENCE_DEADLINE_MS = oldDeadline;
    }
  }
});

test('handlePostedReviewRow: fetchMergeAgentCandidate deadline returns a named handled outcome', async () => {
  const oldDeadline = process.env.ADVERSARIAL_WATCHER_RESOLVE_MERGE_AGENT_COEXISTENCE_DEADLINE_MS;
  process.env.ADVERSARIAL_WATCHER_RESOLVE_MERGE_AGENT_COEXISTENCE_DEADLINE_MS = '10';
  const errors = [];
  let sawAbort = false;
  const { args } = baseArgs({
    logger: {
      log() {},
      warn() {},
      error: (m) => errors.push(String(m)),
    },
    fetchMergeAgentCandidateImpl: async (repo, prNumber, opts) => new Promise((_, reject) => {
      assert.equal(repo, 'laceyenterprises/agent-os');
      assert.equal(prNumber, 4242);
      opts?.signal?.addEventListener?.('abort', () => {
        sawAbort = true;
        reject(opts.signal.reason);
      });
    }),
  });

  try {
    const result = await handlePostedReviewRow(args);

    assert.equal(sawAbort, true);
    assert.equal(result.handled, true);
    assert.equal(result.outcome, 'candidate-fetch-deadline');
    assert.equal(
      result.amaClosureResult.reason,
      'fetch-merge-agent-candidate-deadline-exceeded',
    );
    assert.match(errors.join('\n'), /reason=fetch-merge-agent-candidate-deadline-exceeded/);
  } finally {
    if (oldDeadline === undefined) {
      delete process.env.ADVERSARIAL_WATCHER_RESOLVE_MERGE_AGENT_COEXISTENCE_DEADLINE_MS;
    } else {
      process.env.ADVERSARIAL_WATCHER_RESOLVE_MERGE_AGENT_COEXISTENCE_DEADLINE_MS = oldDeadline;
    }
  }
});

test('handlePostedReviewRow: skips stale posted snapshot when the row is no longer posted', async () => {
  let projected = false;
  let fetched = false;
  const { args, logs } = baseArgs({
    currentReviewRowReader: () => ({ review_status: 'pending' }),
    projectGateStatusSafe: async () => {
      projected = true;
    },
    fetchMergeAgentCandidateImpl: async () => {
      fetched = true;
      return { merged: false, prState: 'open' };
    },
  });

  const result = await handlePostedReviewRow(args);

  assert.equal(result.handled, true);
  assert.equal(result.outcome, 'stale-posted-review-snapshot');
  assert.equal(result.reason, 'review-status-pending');
  assert.equal(result.stage, 'projectGateStatusSafe');
  assert.equal(projected, false);
  assert.equal(fetched, false);
  assert.match(logs.join('\n'), /snapshot no longer current/);
});

test('handlePostedReviewRow: operator-skip-label hard-stops merge closeout', async () => {
  let fetched = false;
  let resolvedCoexistence = false;
  const gateDecision = {
    state: 'failure',
    reason: 'operator-skip-label',
    description: 'Explicit operator skip label blocks adversarial gate.',
  };
  const { args, logs } = baseArgs({
    projectGateStatusSafe: async () => ({ decision: gateDecision }),
    fetchMergeAgentCandidateImpl: async () => {
      fetched = true;
      return { merged: false, prState: 'open' };
    },
    resolveMergeAgentCoexistenceForWatcherImpl: async () => {
      resolvedCoexistence = true;
      return {
        outcome: 'ama-pending',
        amaClosureResult: { reason: 'daemon-failed-closed', workerClass: 'hammer' },
      };
    },
  });

  const result = await handlePostedReviewRow(args);

  assert.equal(fetched, false);
  assert.equal(resolvedCoexistence, false);
  assert.equal(result.handled, true);
  assert.equal(result.outcome, 'operator-skip-label');
  assert.equal(result.reason, 'operator-skip-label');
  assert.equal(result.amaClosureResult.skipMergeAgent, true);
  assert.deepEqual(result.gateDecision, gateDecision);
  assert.match(logs.join('\n'), /operator-skip-label blocks merge\/hammer closeout/);
});

test('handlePostedReviewRow: rechecks review row after candidate fetch before merge work', async () => {
  let reads = 0;
  let fetched = false;
  let resolvedCoexistence = false;
  const { args, logs } = baseArgs({
    projectGateStatusSafe: async () => ({
      decision: { state: 'success', reason: 'review-settled' },
    }),
    currentReviewRowReader: () => {
      reads += 1;
      return reads === 1
        ? { review_status: 'posted', reviewer_head_sha: 'headsha-1' }
        : { review_status: 'pending', reviewer_head_sha: null };
    },
    fetchMergeAgentCandidateImpl: async () => {
      fetched = true;
      return { merged: false, prState: 'open' };
    },
    resolveMergeAgentCoexistenceForWatcherImpl: async () => {
      resolvedCoexistence = true;
      return {
        outcome: 'ama-pending',
        amaClosureResult: { reason: 'daemon-failed-closed', workerClass: 'hammer' },
      };
    },
  });

  const result = await handlePostedReviewRow(args);

  assert.equal(reads, 2);
  assert.equal(fetched, true);
  assert.equal(resolvedCoexistence, false);
  assert.equal(result.handled, true);
  assert.equal(result.outcome, 'stale-posted-review-snapshot');
  assert.equal(result.reason, 'review-status-pending');
  assert.equal(result.stage, 'resolveMergeAgentCoexistence');
  assert.deepEqual(result.gateDecision, { state: 'success', reason: 'review-settled' });
  assert.match(logs.join('\n'), /snapshot no longer current/);
});

test('handlePostedReviewRow: threads a fresh merge-agent request when the tick label snapshot is stale', async () => {
  const mergeAgentRequest = {
    id: 'label-event-1',
    label: 'merge-agent-requested',
    actor: 'VirtualPaul',
    createdAt: '2026-09-10T21:39:43.000Z',
    headSha: 'headsha-1',
  };
  const observedOverrides = [];
  let candidateInputMergeAgentRequestEvent = 'not-called';
  let candidateMergeAgentRequestEvent;
  let coexistenceMergeAgentRequestEvent;
  const { args } = baseArgs({
    labelNames: [],
    operatorSurface: {
      observeOperatorApproved: async () => null,
      observeMergeAgentOverride: async (subjectRef, revisionRef) => {
        observedOverrides.push({ subjectRef, revisionRef });
        return mergeAgentRequest;
      },
      observeLabelControl: async () => null,
    },
    fetchMergeAgentCandidateImpl: async (repo, prNumber, options = {}) => {
      candidateInputMergeAgentRequestEvent = options.mergeAgentRequestEvent;
      candidateMergeAgentRequestEvent = mergeAgentRequest;
      return { repo, prNumber, merged: false, prState: 'open', mergeAgentRequestEvent: mergeAgentRequest };
    },
    resolveMergeAgentCoexistenceForWatcherImpl: async (options = {}) => {
      coexistenceMergeAgentRequestEvent = options.mergeAgentRequestEvent;
      return {
        outcome: 'await-operator',
        amaClosureResult: {
          reason: 'not-eligible',
          namedReason: 'not-eligible:test',
          reasons: ['test'],
        },
      };
    },
  });

  const result = await handlePostedReviewRow(args);

  assert.equal(result.outcome, 'await-operator');
  assert.equal(observedOverrides.length, 0);
  assert.equal(candidateInputMergeAgentRequestEvent, undefined);
  assert.equal(candidateMergeAgentRequestEvent?.id, 'label-event-1');
  assert.equal(candidateMergeAgentRequestEvent?.label, 'merge-agent-requested');
  assert.equal(candidateMergeAgentRequestEvent?.headSha, 'headsha-1');
  assert.equal(coexistenceMergeAgentRequestEvent?.id, 'label-event-1');
});

test('handlePostedReviewRow: retained-ownership logs once and is suppressed on unchanged repeats', async () => {
  const logGate = createLogChangeGate();
  const { args, logs } = baseArgs({ logGate });

  await handlePostedReviewRow(args);
  await handlePostedReviewRow(args);
  await handlePostedReviewRow(args);

  const lines = retained(logs);
  assert.equal(lines.length, 1, `expected one retained-ownership log, got ${lines.length}`);
  assert.match(lines[0], /laceyenterprises\/agent-os#4242/);
  assert.match(lines[0], /daemon-failed-closed/);
});

test('handlePostedReviewRow: retained-ownership re-logs when the head advances', async () => {
  const logGate = createLogChangeGate();
  const first = baseArgs({ logGate, currentRevisionRef: 'headsha-1' });
  const second = baseArgs({ logGate, currentRevisionRef: 'headsha-2' });

  await handlePostedReviewRow(first.args);
  await handlePostedReviewRow(first.args); // suppressed (same head + reason)
  await handlePostedReviewRow(second.args); // new head -> logs again

  assert.equal(retained(first.logs).length, 1);
  assert.equal(retained(second.logs).length, 1);
});

test('handlePostedReviewRow: retained-ownership re-logs when the reason changes on the same head', async () => {
  const logGate = createLogChangeGate();
  const a = baseArgs({
    logGate,
    resolveMergeAgentCoexistenceForWatcherImpl: async () => ({
      outcome: 'ama-pending',
      amaClosureResult: { reason: 'daemon-failed-closed', launchRequestId: 'lrq', workerClass: 'hammer' },
    }),
  });
  const b = baseArgs({
    logGate,
    resolveMergeAgentCoexistenceForWatcherImpl: async () => ({
      outcome: 'ama-pending',
      amaClosureResult: { reason: 'hammer-retry-cap-pending', launchRequestId: 'lrq', workerClass: 'hammer' },
    }),
  });

  await handlePostedReviewRow(a.args);
  await handlePostedReviewRow(a.args); // suppressed
  await handlePostedReviewRow(b.args); // changed reason -> logs again

  assert.equal(retained(a.logs).length, 1);
  assert.equal(retained(b.logs).length, 1);
  assert.match(retained(b.logs)[0], /hammer-retry-cap-pending/);
});

test('handlePostedReviewRow: retained-ownership re-logs when a new launch request appears', async () => {
  const logGate = createLogChangeGate();
  const a = baseArgs({
    logGate,
    resolveMergeAgentCoexistenceForWatcherImpl: async () => ({
      outcome: 'ama-pending',
      amaClosureResult: {
        reason: 'daemon-failed-closed',
        launchRequestId: 'lrq_old',
        dispatchId: 'dispatch_old',
        workerClass: 'hammer',
      },
    }),
  });
  const b = baseArgs({
    logGate,
    resolveMergeAgentCoexistenceForWatcherImpl: async () => ({
      outcome: 'ama-pending',
      amaClosureResult: {
        reason: 'daemon-failed-closed',
        launchRequestId: 'lrq_new',
        dispatchId: 'dispatch_new',
        workerClass: 'hammer',
      },
    }),
  });

  await handlePostedReviewRow(a.args);
  await handlePostedReviewRow(a.args); // suppressed
  await handlePostedReviewRow(b.args); // changed worker identity -> logs again

  assert.equal(retained(a.logs).length, 1);
  assert.equal(retained(b.logs).length, 1);
  assert.match(retained(a.logs)[0], /lrq=lrq_old/);
  assert.match(retained(b.logs)[0], /lrq=lrq_new/);
});

test('handlePostedReviewRow: retained-ownership logs suppressed poll count on transition', async () => {
  const logGate = createLogChangeGate();
  const a = baseArgs({
    logGate,
    resolveMergeAgentCoexistenceForWatcherImpl: async () => ({
      outcome: 'ama-pending',
      amaClosureResult: { reason: 'daemon-failed-closed', launchRequestId: 'lrq', workerClass: 'hammer' },
    }),
  });
  const b = baseArgs({
    logGate,
    resolveMergeAgentCoexistenceForWatcherImpl: async () => ({
      outcome: 'ama-pending',
      amaClosureResult: { reason: 'hammer-retry-cap-pending', launchRequestId: 'lrq', workerClass: 'hammer' },
    }),
  });

  await handlePostedReviewRow(a.args);
  await handlePostedReviewRow(a.args);
  await handlePostedReviewRow(a.args);
  await handlePostedReviewRow(b.args);

  assert.match(retained(b.logs)[0], /after 2 suppressed identical polls/);
});

test('handlePostedReviewRow: await-operator returns the AMA closure result', async () => {
  const amaClosureResult = {
    reason: 'not-eligible',
    namedReason: 'not-eligible:blocking-findings-present',
    reasons: ['blocking-findings-present'],
  };
  const { args, logs } = baseArgs({
    resolveMergeAgentCoexistenceForWatcherImpl: async () => ({
      outcome: 'await-operator',
      amaClosureResult,
    }),
  });

  const result = await handlePostedReviewRow(args);

  assert.equal(result.outcome, 'await-operator');
  assert.equal(result.amaClosureResult, amaClosureResult);
  assert.match(logs.at(-1), /not-eligible:blocking-findings-present/);
});

test('handlePostedReviewRow: terminal PR result returns AMA closure details', async () => {
  const amaClosureResult = {
    reason: 'pr-merged',
    daemonCleanMerge: { merged: true, disposition: 'merged' },
  };
  const { args } = baseArgs({
    resolveMergeAgentCoexistenceForWatcherImpl: async () => ({
      outcome: 'pr-terminal',
      terminalReason: 'merged',
      amaClosureResult,
    }),
  });

  const result = await handlePostedReviewRow(args);

  assert.equal(result.prTerminal, true);
  assert.equal(result.amaClosureResult, amaClosureResult);
});
