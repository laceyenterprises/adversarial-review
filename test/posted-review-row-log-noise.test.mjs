import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PostedReviewStepDeadlineError,
  handlePostedReviewRow,
  resolveMergeAgentCoexistenceStepDeadlineMs,
  timePostedReviewStep,
} from '../src/posted-review-row.mjs';
import { createLogChangeGate } from '../src/log-change-gate.mjs';
import {
  DEFAULT_POSTED_REVIEW_BOUNDED_EXPENSIVE_STEP_COUNT,
  DEFAULT_POSTED_REVIEW_PHASE_HANDLER_CAPACITY,
  derivePostedReviewExpensiveStepBudgetMs,
  resolvePostedReviewHandlerHeadroomMs,
  resolvePostedReviewHandlerTimeoutMs,
  resolvePostedReviewPhaseBudgetMs,
  resolvePostedReviewReviewerPressurePhaseBudgetMs,
} from '../src/watcher-poll-fairness.mjs';

// Drive handlePostedReviewRow straight to the AMA `ama-pending` retained-ownership
// branch with fully injected collaborators, then assert the LOG-ONLY line is
// emitted once per retained-worker state transition rather than every tick.
function baseArgs(overrides = {}) {
  const logs = [];
  const args = {
    rootDir: '/tmp/adversarial-review-log-noise',
    repoPath: 'laceyenterprises/agent-os',
    prNumber: 4242,
    existing: { body_md: null },
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
  assert.equal(phaseBudgetMs, handlerTimeoutMs * DEFAULT_POSTED_REVIEW_PHASE_HANDLER_CAPACITY);
  assert.equal(deadlineMs, 87_500);
  assert.ok(deadlineMs > 80_000, 'live HAM candidate/coexistence tails have exceeded 75s under load');
  assert.ok(
    (deadlineMs * DEFAULT_POSTED_REVIEW_BOUNDED_EXPENSIVE_STEP_COUNT) + headroomMs <= handlerTimeoutMs,
    'the two bounded expensive steps must still fit inside one handler watchdog',
  );
});

test('RVHAND-10: invalid posted-review phase budget falls back to capacity-expanded default', () => {
  const env = { ADVERSARIAL_WATCHER_POSTED_REVIEW_PHASE_BUDGET_MS: 'invalid' };
  const handlerTimeoutMs = resolvePostedReviewHandlerTimeoutMs(env);
  assert.equal(
    resolvePostedReviewPhaseBudgetMs(env),
    handlerTimeoutMs * DEFAULT_POSTED_REVIEW_PHASE_HANDLER_CAPACITY,
  );
});

test('RVHAND-11: reviewer-pressure posted-review phase budget has a bounded default and override', () => {
  assert.equal(resolvePostedReviewReviewerPressurePhaseBudgetMs({}), 180_000);
  assert.equal(
    resolvePostedReviewReviewerPressurePhaseBudgetMs({
      ADVERSARIAL_WATCHER_POSTED_REVIEW_REVIEWER_PRESSURE_PHASE_BUDGET_MS: '90000',
    }),
    90_000,
  );
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
