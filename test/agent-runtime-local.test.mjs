import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_LOCAL_RUN_CAP,
  createLocalAgentRuntime,
  deriveSessionUuid,
} from '../src/adapters/agent-runtime/local/index.mjs';
import {
  evaluateBudgetCap,
  evaluateLocalAdmission,
  evaluateQuotaHold,
} from '../src/adapters/agent-runtime/local/admission.mjs';
import {
  readReviewerRunRecord,
  writeReviewerRunRecord,
} from '../src/adapters/reviewer-runtime/run-state.mjs';

const noopPreflight = async ({ model }) => (
  String(model || '').toLowerCase().includes('codex')
    ? { codexCli: '/tmp/fake-codex' }
    : { claudeCli: '/tmp/fake-claude' }
);

function makeRoot() {
  return mkdtempSync(join(tmpdir(), 'agent-runtime-local-'));
}

function reviewerRequest(overrides = {}) {
  return {
    role: { id: 'reviewer:claude', kind: 'reviewer', model: 'claude', forbiddenFallbacks: ['api-key'] },
    promptSet: 'code-pr',
    promptStage: 'first',
    subjectContent: {
      ref: { domainId: 'code-pr', subjectExternalId: 'pr-14', revisionRef: 'feature/x' },
      representation: 'diff --git a b',
      observedAt: '2026-05-11T20:00:00.000Z',
    },
    idempotencyKey: 'code-pr:pr-14:feature/x:review:reviewer:1',
    budget: { maxTokens: 500_000, maxWallMs: 600_000 },
    timeoutMs: 100,
    ...overrides,
  };
}

// -- port shape / round-trips -------------------------------------------------

test('local runtime round-trips a spawn into a completed RunResult with usage', async () => {
  const rootDir = makeRoot();
  const spawnCalls = [];
  try {
    const runtime = createLocalAgentRuntime({
      rootDir,
      admissionContext: { sample: null }, // bypass OS memory sampling deterministically
      cliDirectOptions: {
        preflightImpl: noopPreflight,
        now: () => '2026-05-11T20:00:00.000Z',
        spawnCapturedImpl: async (_command, _args, options) => {
          spawnCalls.push('spawned');
          options.onSpawn({ pgid: 5150 });
          return {
            stdout: `${JSON.stringify({
              type: 'turn.completed',
              usage: { input_tokens: 123, cached_input_tokens: 45, output_tokens: 6, total_tokens: 129 },
            })}\n`,
            stderr: '',
          };
        },
      },
    });

    const req = reviewerRequest({
      role: { id: 'reviewer:codex', kind: 'reviewer', model: 'codex', forbiddenFallbacks: ['api-key'] },
    });
    const handle = await runtime.run(req);
    assert.equal(handle.mode, 'local');
    assert.equal(handle.runRef, req.idempotencyKey);
    assert.equal(runtime.describe().id, 'local');
    assert.equal(runtime.describe().mode, 'local');
    assert.equal(runtime.describe().capabilities.oauthStripEnforced, true);

    const result = await handle.await();
    assert.equal(spawnCalls.length, 1);
    assert.equal(result.status, 'completed');
    assert.equal(result.runtimeMode, 'local');
    assert.equal(result.failureClass, null);
    assert.equal(result.artifact.kind, 'review');
    assert.equal(result.usage.total, 129);
    assert.equal(result.usage.input, 123);

    // Atomic run record was written under data/reviewer-runs/ and reached a
    // terminal state — the cli-direct behaviour the port must preserve.
    const record = readReviewerRunRecord(rootDir, deriveSessionUuid(req.idempotencyKey));
    assert.equal(record.state, 'completed');
    assert.equal(record.pgid, 5150);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('local runtime cancel round-trips into a cancelled RunResult', async () => {
  const rootDir = makeRoot();
  let release;
  const killed = new Set();
  const processKillImpl = (target, signal) => {
    const pgid = Math.abs(target);
    if (signal === 0) {
      if (killed.has(pgid)) {
        const err = new Error('no such process');
        err.code = 'ESRCH';
        throw err;
      }
      return true;
    }
    killed.add(pgid);
    return true;
  };
  try {
    const runtime = createLocalAgentRuntime({
      rootDir,
      admissionContext: { sample: null },
      cliDirectOptions: {
        preflightImpl: noopPreflight,
        now: () => '2026-05-11T20:00:00.000Z',
        processKillImpl,
        sleepImpl: async () => {},
        spawnCapturedImpl: async (_command, _args, options) => {
          options.onSpawn({ pgid: 4243 });
          await new Promise((resolve) => { release = resolve; });
          const err = new Error('aborted');
          err.code = 'ABORT_ERR';
          err.signal = 'SIGTERM';
          throw err;
        },
      },
    });

    const req = reviewerRequest({ idempotencyKey: 'code-pr:pr-14:feature/x:review:reviewer:cancel' });
    const handle = await runtime.run(req);
    await new Promise((resolve) => setImmediate(resolve));
    await handle.cancel();
    release();

    const result = await handle.await();
    assert.equal(result.status, 'cancelled');
    assert.equal(result.runtimeMode, 'local');
    const record = readReviewerRunRecord(rootDir, deriveSessionUuid(req.idempotencyKey));
    assert.equal(record.state, 'cancelled');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('local runtime reattach round-trips an in-flight record into a completed RunResult', async () => {
  const rootDir = makeRoot();
  const sessionUuid = deriveSessionUuid('code-pr:pr-14:feature/x:review:reviewer:reattach');
  try {
    // A heartbeating record left behind by a pre-restart local run.
    writeReviewerRunRecord(rootDir, {
      sessionUuid,
      domain: 'code-pr',
      runtime: 'cli-direct',
      state: 'heartbeating',
      pgid: 6001,
      spawnedAt: '2026-05-11T20:00:00.000Z',
      lastHeartbeatAt: '2026-05-11T20:00:30.000Z',
      reattachToken: sessionUuid,
      subjectContext: { domainId: 'code-pr' },
    });

    const runtime = createLocalAgentRuntime({
      rootDir,
      cliDirectOptions: {
        preflightImpl: noopPreflight,
        now: () => '2026-05-11T20:01:00.000Z',
        // pgid 6001 is alive.
        processKillImpl: (target, signal) => {
          if (signal === 0) return true;
          return true;
        },
        // Identity probe: report a start time that matches the record's spawnedAt.
        execFileImpl: async (_command, args) => {
          assert.equal(args.includes('lstart='), true);
          return { stdout: '2026-05-11T20:00:00.000Z\n', stderr: '' };
        },
      },
    });

    const record = readReviewerRunRecord(rootDir, sessionUuid);
    const result = await runtime.reattach(record);
    assert.equal(result.status, 'completed');
    assert.equal(result.runtimeMode, 'local');
    assert.equal(result.artifact.pgid, 6001);
    // cli-direct adopts the live group after a bounce.
    assert.equal(readReviewerRunRecord(rootDir, sessionUuid).adoptedAfterBounce, true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('local runtime reattach infers remediator artifacts when the durable record has no role', async () => {
  const runtime = createLocalAgentRuntime({
    cliDirect: {
      async reattach() { return { ok: true, remediationBody: 'fixed patch' }; },
    },
  });
  const result = await runtime.reattach({ sessionUuid: 'remediator-after-bounce' });
  assert.equal(result.status, 'completed');
  assert.equal(result.artifact.kind, 'remediation');
  assert.equal(result.artifact.body, 'fixed patch');
});

test('session UUIDs remain distinct when filesystem normalization collides', () => {
  const slash = deriveSessionUuid('domain:pr-14:feature/x:review:reviewer:1');
  const dash = deriveSessionUuid('domain:pr-14:feature-x:review:reviewer:1');
  assert.notEqual(slash, dash);
  assert.doesNotMatch(slash, /[\\/]/);
  assert.doesNotMatch(dash, /[\\/]/);
});

test('local runtime applies default caps and forwards token budgets to both roles', async () => {
  const calls = [];
  const cliDirect = {
    spawnReviewer(req) { calls.push(req); return Promise.resolve({ ok: true, reviewBody: 'ok' }); },
    spawnRemediator(req) { calls.push(req); return Promise.resolve({ ok: true, remediationBody: 'fixed' }); },
  };
  const runtime = createLocalAgentRuntime({
    cliDirect,
    admissionContext: { memoryAdmission: { admit: true } },
  });
  await (await runtime.run(reviewerRequest({ budget: undefined, timeoutMs: undefined }))).await();
  await (await runtime.run(reviewerRequest({
    role: { kind: 'remediator', model: 'codex' },
    idempotencyKey: 'remediator-budget-forwarding',
    budget: { maxTokens: 1234, maxWallMs: 5678 },
    timeoutMs: undefined,
  }))).await();
  assert.equal(calls[0].tokenBudget, DEFAULT_LOCAL_RUN_CAP.maxTokens);
  assert.equal(calls[0].timeoutMs, DEFAULT_LOCAL_RUN_CAP.maxWallMs);
  assert.equal(calls[1].tokenBudget, 1234);
  assert.equal(calls[1].timeoutMs, 5678);
});

test('local runtime maps synchronous spawn errors into failed RunResults', async () => {
  for (const kind of ['reviewer', 'remediator']) {
    const runtime = createLocalAgentRuntime({
      cliDirect: {
        spawnReviewer() { throw new Error('synchronous reviewer failure'); },
        spawnRemediator() { throw new Error('synchronous remediator failure'); },
      },
      admissionContext: { memoryAdmission: { admit: true } },
    });
    const handle = await runtime.run(reviewerRequest({
      role: { kind, model: 'codex' },
      idempotencyKey: `synchronous-${kind}-failure`,
    }));
    const result = await handle.await();
    assert.equal(result.status, 'failed');
    assert.equal(result.failureClass, 'bug');
    assert.equal(result.detail, `synchronous ${kind} failure`);
  }
});

test('local runtime cancellation tolerates an injected adapter without cancel', async () => {
  const runtime = createLocalAgentRuntime({
    cliDirect: {
      spawnReviewer() { return Promise.resolve({ ok: true, reviewBody: 'ok' }); },
    },
    admissionContext: { memoryAdmission: { admit: true } },
  });
  const handle = await runtime.run(reviewerRequest({ idempotencyKey: 'cancel-without-inner-method' }));
  await handle.cancel();
  const result = await handle.await();
  assert.equal(result.status, 'completed');
});

// -- admission refusals -------------------------------------------------------

test('local runtime refuses admission under critical memory pressure', async () => {
  const rootDir = makeRoot();
  let spawned = false;
  try {
    const runtime = createLocalAgentRuntime({
      rootDir,
      admissionContext: {
        // A pre-parsed critical memory-pressure sample drives the real
        // decideReviewerMemoryAdmission gate to refuse.
        sample: { pressureLevel: 'critical', availableMb: 128, swapUsedPct: 99 },
      },
      cliDirectOptions: {
        preflightImpl: noopPreflight,
        spawnCapturedImpl: async () => { spawned = true; return { stdout: '', stderr: '' }; },
      },
    });

    const handle = await runtime.run(reviewerRequest());
    const result = await handle.await();
    assert.equal(spawned, false, 'must not spawn when admission refuses');
    assert.equal(result.status, 'failed');
    assert.equal(result.failureClass, 'local-admission-refused');
    assert.match(result.detail, /memory/);
    assert.match(result.detail, /memory_pressure_critical/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('local runtime refuses admission while a quota-exhaustion hold is active', async () => {
  const rootDir = makeRoot();
  let spawned = false;
  const nowMs = Date.parse('2026-06-23T00:39:39.000Z');
  try {
    const runtime = createLocalAgentRuntime({
      rootDir,
      admissionContext: {
        sample: null, // memory gate is not what we are testing
        nowMs,
        quotaState: {
          review_status: 'failed',
          failed_at: '2026-06-23T00:00:00.000Z',
          quota_reset_at_utc: '2026-06-23T03:00:00.000Z', // reset still in the future
          failure_message: "[quota-exhausted] You've hit your weekly limit",
        },
      },
      cliDirectOptions: {
        preflightImpl: noopPreflight,
        spawnCapturedImpl: async () => { spawned = true; return { stdout: '', stderr: '' }; },
      },
    });

    const handle = await runtime.run(reviewerRequest());
    const result = await handle.await();
    assert.equal(spawned, false, 'must not spawn while quota hold is active');
    assert.equal(result.status, 'failed');
    assert.equal(result.failureClass, 'local-admission-refused');
    assert.match(result.detail, /quota_exhausted_hold/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('local runtime refuses a run whose requested budget exceeds the local cap', async () => {
  const rootDir = makeRoot();
  let spawned = false;
  try {
    const runtime = createLocalAgentRuntime({
      rootDir,
      admissionContext: { sample: null },
      cliDirectOptions: {
        preflightImpl: noopPreflight,
        spawnCapturedImpl: async () => { spawned = true; return { stdout: '', stderr: '' }; },
      },
    });
    const handle = await runtime.run(reviewerRequest({
      budget: { maxTokens: DEFAULT_LOCAL_RUN_CAP.maxTokens + 1 },
    }));
    const result = await handle.await();
    assert.equal(spawned, false);
    assert.equal(result.status, 'failed');
    assert.equal(result.failureClass, 'local-admission-refused');
    assert.match(result.detail, /budget_token_cap_exceeded/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

// -- admission unit coverage --------------------------------------------------

test('evaluateBudgetCap enforces token and wall-time ceilings independently', () => {
  assert.equal(evaluateBudgetCap({ maxTokens: 10 }, { maxTokens: 100 }).admit, true);
  assert.equal(evaluateBudgetCap({ maxTokens: 200 }, { maxTokens: 100 }).reason, 'budget_token_cap_exceeded');
  assert.equal(evaluateBudgetCap({ maxWallMs: 200 }, { maxWallMs: 100 }).reason, 'budget_time_cap_exceeded');
  const defaulted = evaluateBudgetCap({}, DEFAULT_LOCAL_RUN_CAP);
  assert.equal(defaulted.admit, true);
  assert.equal(defaulted.requestedTokens, DEFAULT_LOCAL_RUN_CAP.maxTokens);
  assert.equal(defaulted.requestedWallMs, DEFAULT_LOCAL_RUN_CAP.maxWallMs);
});

test('evaluateQuotaHold releases once the provider reset has elapsed', () => {
  const state = {
    failed_at: '2026-06-23T00:00:00.000Z',
    quota_reset_at_utc: '2026-06-23T03:00:00.000Z',
  };
  const held = evaluateQuotaHold(state, { nowMs: Date.parse('2026-06-23T01:00:00.000Z') });
  assert.equal(held.admit, false);
  assert.equal(held.reason, 'quota_exhausted_hold');
  const released = evaluateQuotaHold(state, { nowMs: Date.parse('2026-06-23T04:00:00.000Z') });
  assert.equal(released.admit, true);
  // No quota state at all → admitted.
  assert.equal(evaluateQuotaHold(null, { nowMs: 0 }).admit, true);
});

test('evaluateLocalAdmission short-circuits on the cheapest failing gate (budget before memory)', async () => {
  let memoryProbed = false;
  const decision = await evaluateLocalAdmission({
    reviewerModel: 'claude',
    budget: { maxTokens: 9_000_000 },
    cap: DEFAULT_LOCAL_RUN_CAP,
    checkMemoryImpl: async () => { memoryProbed = true; return { admit: true }; },
  });
  assert.equal(decision.admit, false);
  assert.equal(decision.reason, 'budget_token_cap_exceeded');
  assert.equal(memoryProbed, false, 'must not sample memory once the budget gate has already refused');
});
