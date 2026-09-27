import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_LOCAL_RUN_CAP,
  createLocalAgentRuntime,
  deriveSessionUuid,
  toRunResult,
} from '../src/adapters/agent-runtime/local/index.mjs';
import {
  evaluateBudgetCap,
  evaluateLocalAdmission,
  evaluateQuotaHold,
} from '../src/adapters/agent-runtime/local/admission.mjs';
import {
  cancelLocalRemediationWorker,
  prepareCodexRemediationStartupEnv,
  resolveRemediationModel,
  resolveNonBlockingCodexModel,
  spawnClaudeCodeRemediationWorker,
  spawnCodexRemediationWorker,
  spawnGeminiRemediationWorker,
  waitForLocalRemediationExit,
} from '../src/adapters/agent-runtime/local/remediation.mjs';
import {
  readReviewerRunRecord,
  writeReviewerRunRecord,
} from '../src/adapters/reviewer-runtime/run-state.mjs';

test('non-blocking Codex model and effort require the remediator allowlists', () => {
  const root = mkdtempSync(join(tmpdir(), 'remwaste-model-'));
  try {
    mkdirSync(join(root, 'registry'), { recursive: true });
    writeFileSync(join(root, 'registry', 'worker-classes.json'), JSON.stringify({
      'remediator-codex': { allowedModels: ['gpt-6-sol', 'gpt-6-luna'] },
    }));
    const env = { HQ_ROOT: root };
    assert.deepEqual(resolveNonBlockingCodexModel({ model: 'gpt-6-luna', reasoningEffort: 'medium', env, hqRoot: root }), {
      resolvedModel: 'gpt-6-luna', resolvedReasoningLevel: 'medium',
      modelSource: 'non-blocking-config', reasoningSource: 'non-blocking-config',
    });
    const invalid = resolveNonBlockingCodexModel({ model: 'unknown', reasoningEffort: 'max', env, hqRoot: root });
    assert.equal(invalid.resolvedModel, 'gpt-6-sol');
    assert.equal(invalid.resolvedReasoningLevel, 'low');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const noopPreflight = async ({ model }) => (
  String(model || '').toLowerCase().includes('codex')
    ? { codexCli: '/tmp/fake-codex' }
    : { claudeCli: '/tmp/fake-claude' }
);

function makeRoot() {
  return mkdtempSync(join(tmpdir(), 'agent-runtime-local-'));
}

function withEnv(overrides, fn) {
  const prior = new Map();
  for (const key of Object.keys(overrides)) {
    prior.set(key, process.env[key]);
    if (overrides[key] === undefined) delete process.env[key];
    else process.env[key] = overrides[key];
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function countOpenFds() {
  try {
    return readdirSync('/dev/fd').length;
  } catch {
    return null;
  }
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
    idempotencyKey: 'explicit-null-budget-defaults-to-local-cap',
    budget: { maxTokens: null, maxWallMs: null },
    timeoutMs: undefined,
  }))).await();
  await (await runtime.run(reviewerRequest({
    role: { kind: 'remediator', model: 'codex' },
    idempotencyKey: 'remediator-budget-forwarding',
    budget: { maxTokens: 1234, maxWallMs: 5678 },
    timeoutMs: undefined,
  }))).await();
  assert.equal(calls[0].tokenBudget, DEFAULT_LOCAL_RUN_CAP.maxTokens);
  assert.equal(calls[0].timeoutMs, DEFAULT_LOCAL_RUN_CAP.maxWallMs);
  assert.equal(calls[1].tokenBudget, DEFAULT_LOCAL_RUN_CAP.maxTokens);
  assert.equal(calls[1].timeoutMs, DEFAULT_LOCAL_RUN_CAP.maxWallMs);
  assert.equal(calls[2].tokenBudget, 1234);
  assert.equal(calls[2].timeoutMs, 5678);
  assert.equal(calls[2].subjectContext.agentRoleKind, 'remediator');
});

test('local runtime maps cli-direct reviewer timeout into AgentRuntime timeout class', () => {
  const result = toRunResult({
    ok: false,
    failureClass: 'reviewer-timeout',
    error: 'reviewer wall-clock exceeded',
  });
  assert.equal(result.status, 'timeout');
  assert.equal(result.failureClass, 'timeout');
  assert.equal(result.detail, 'reviewer wall-clock exceeded');
});

test('local runtime reattach uses durable role kind when result payload is ambiguous', async () => {
  const runtime = createLocalAgentRuntime({
    cliDirect: {
      async reattach() {
        return { ok: true, reviewBody: 'stale reviewer-shaped payload' };
      },
    },
  });
  const result = await runtime.reattach({
    sessionUuid: 'ambiguous-remediator-after-bounce',
    subjectContext: { agentRoleKind: 'remediator' },
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.artifact.kind, 'remediation');
  assert.equal(result.artifact.body, null);
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

test('local remediation spawners retain reply bookkeeping on worker records', () => {
  const rootDir = makeRoot();
  const promptPath = join(rootDir, 'prompt.md');
  const outputPath = join(rootDir, 'out.txt');
  const logPath = join(rootDir, 'worker.log');
  const replyPath = join(rootDir, 'reply.json');
  writeFileSync(promptPath, 'fix the PR', 'utf8');
  const spawnImpl = () => ({ pid: 4141, unref() {} });
  try {
    const shared = {
      workspaceDir: rootDir,
      promptPath,
      outputPath,
      logPath,
      replyPath,
      launchRequestId: 'lrq_local_reply_state',
      spawnImpl,
      now: () => '2026-08-02T17:10:00.000Z',
    };

    const claude = spawnClaudeCodeRemediationWorker(shared);
    assert.equal(claude.replyPath, replyPath);
    assert.equal(claude.launchRequestId, 'lrq_local_reply_state');

    const gemini = spawnGeminiRemediationWorker(shared);
    assert.equal(gemini.replyPath, replyPath);
    assert.equal(gemini.launchRequestId, 'lrq_local_reply_state');

    const codexHome = join(rootDir, 'codex-home');
    const codexAuthDir = join(codexHome, '.codex');
    mkdirSync(codexAuthDir, { recursive: true });
    const codex = withEnv({
      CODEX_AUTH_PATH: join(codexAuthDir, 'auth.json'),
      CODEX_HOME: codexAuthDir,
      HOME: codexHome,
    }, () => spawnCodexRemediationWorker(shared));
    assert.equal(codex.replyPath, replyPath);
    assert.equal(codex.launchRequestId, 'lrq_local_reply_state');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('remediation spawners use governed models and reasoning from the HQ mirror', () => {
  const root = makeRoot();
  const registryDir = join(root, 'registry');
  mkdirSync(registryDir);
  writeFileSync(join(registryDir, 'worker-classes.json'), JSON.stringify({ classes: {
    'remediator-codex': { defaultModel: 'gpt-6-sol', defaultReasoningLevel: 'xhigh' },
    'remediator-claude': { defaultModel: 'claude-opus-5-5', defaultReasoningLevel: 'xhigh' },
    'remediator-gemini': { defaultModel: 'gemini-3-pro', defaultReasoningLevel: 'high' },
  } }));
  const promptPath = join(root, 'prompt.md');
  writeFileSync(promptPath, 'fix the PR');
  const calls = [];
  const shared = {
    workspaceDir: root,
    promptPath,
    outputPath: join(root, 'out.txt'),
    logPath: join(root, 'worker.log'),
    hqRoot: root,
    replyPath: join(root, 'reply.json'),
    launchRequestId: 'lrq_model_fixture',
    sourceEnv: {
      HQ_ROOT: root,
      HOME: root,
      CODEX_AUTH_PATH: join(root, '.codex', 'auth.json'),
      CODEX_HOME: join(root, '.codex'),
    },
    enforceHarnessIdentity: false,
    spawnImpl: (command, args) => {
      calls.push([command, ...args]);
      return { pid: 4141, unref() {} };
    },
  };
  try {
    for (const spawn of [
      spawnCodexRemediationWorker,
      spawnClaudeCodeRemediationWorker,
      spawnGeminiRemediationWorker,
    ]) {
      const record = spawn(shared);
      assert.deepEqual(record.command, calls.at(-1));
      assert.equal(record.modelSource, 'registry-mirror');
      assert.equal(record.reasoningSource, spawn === spawnGeminiRemediationWorker
        ? 'unsupported' : 'registry-mirror');
      if (spawn === spawnGeminiRemediationWorker) {
        assert.equal(record.resolvedReasoningLevel, null);
      }
    }
    assert.deepEqual(calls[0].slice(1, 6), ['exec', '--model', 'gpt-6-sol', '-c', 'model_reasoning_effort=xhigh']);
    assert.deepEqual(calls[1].slice(-4), ['--model', 'claude-opus-5-5', '--effort', 'xhigh']);
    assert.deepEqual(calls[2].slice(-2), ['-m', 'gemini-3-pro']);
    const brokerDefaultOnly = spawnClaudeCodeRemediationWorker({
      ...shared,
      sourceEnv: { ...shared.sourceEnv, CLAUDE_MODEL_ID: 'broker-default' },
    });
    assert.equal(brokerDefaultOnly.resolvedModel, 'claude-opus-5-5');
    const preflightResolution = {
      resolvedModel: 'claude-preflight-model',
      resolvedReasoningLevel: 'high',
      modelSource: 'registry-mirror',
      reasoningSource: 'registry-mirror',
    };
    const sharedResolution = spawnClaudeCodeRemediationWorker({
      ...shared,
      modelResolution: preflightResolution,
    });
    assert.deepEqual(sharedResolution.command.slice(-4), [
      '--model', 'claude-preflight-model', '--effort', 'high',
    ]);
    assert.equal(resolveRemediationModel('remediator-codex', {
      env: { HQ_ROOT: root }, pin: 'gpt-pinned', fallbackModel: 'old',
    }).modelSource, 'env');
    const pinned = spawnCodexRemediationWorker({
      ...shared,
      sourceEnv: { ...shared.sourceEnv, ADVERSARIAL_REMEDIATION_CODEX_MODEL: 'gpt-pinned' },
    });
    assert.equal(pinned.resolvedModel, 'gpt-pinned');
    assert.equal(pinned.modelSource, 'env');
    assert.equal(pinned.resolvedReasoningLevel, null);
    assert.equal(pinned.reasoningSource, 'none');
    assert.ok(!pinned.command.includes('model_reasoning_effort=xhigh'));

    const pinnedWithReasoning = spawnCodexRemediationWorker({
      ...shared,
      sourceEnv: {
        ...shared.sourceEnv,
        ADVERSARIAL_REMEDIATION_CODEX_MODEL: 'gpt-pinned',
        ADVERSARIAL_REMEDIATION_CODEX_REASONING_LEVEL: 'high',
      },
    });
    assert.equal(pinnedWithReasoning.reasoningSource, 'env');
    assert.ok(pinnedWithReasoning.command.includes('model_reasoning_effort=high'));
    const nonBlocking = spawnCodexRemediationWorker({
      ...shared,
      modelResolution: {
        resolvedModel: 'gpt-6-luna', resolvedReasoningLevel: 'low',
        modelSource: 'non-blocking-config', reasoningSource: 'non-blocking-config',
      },
    });
    assert.ok(nonBlocking.command.includes('gpt-6-luna'));
    assert.ok(nonBlocking.command.includes('model_reasoning_effort=low'));

    const pinnedClaude = spawnClaudeCodeRemediationWorker({
      ...shared,
      sourceEnv: { ...shared.sourceEnv, CLAUDE_REMEDIATION_MODEL: 'claude-pinned' },
    });
    assert.equal(pinnedClaude.resolvedModel, 'claude-pinned');
    assert.equal(pinnedClaude.modelSource, 'env');
    assert.equal(pinnedClaude.resolvedReasoningLevel, null);
    assert.deepEqual(pinnedClaude.command.slice(-2), ['--model', 'claude-pinned']);

    const pinnedClaudeWithReasoning = spawnClaudeCodeRemediationWorker({
      ...shared,
      sourceEnv: {
        ...shared.sourceEnv,
        CLAUDE_REMEDIATION_MODEL: 'claude-pinned',
        CLAUDE_REMEDIATION_REASONING_LEVEL: 'max',
      },
    });
    assert.equal(pinnedClaudeWithReasoning.reasoningSource, 'env');
    assert.deepEqual(pinnedClaudeWithReasoning.command.slice(-4), ['--model', 'claude-pinned', '--effort', 'max']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('remediation registry prefers mirror, uses seed, and warns on constant fallback', () => {
  const root = makeRoot();
  const mirror = join(root, 'hq');
  const seed = join(root, 'agent-os', 'modules', 'worker-pool');
  mkdirSync(join(mirror, 'registry'), { recursive: true });
  mkdirSync(seed, { recursive: true });
  const mirrorPath = join(mirror, 'registry', 'worker-classes.json');
  const seedPath = join(seed, 'worker-classes.json');
  writeFileSync(mirrorPath, JSON.stringify({ 'remediator-codex': { defaultModel: 'mirror' } }));
  writeFileSync(seedPath, JSON.stringify({ classes: {
    'remediator-codex': { defaultModel: 'seed' },
    gemini: { defaultModel: 'gemini-seed' },
  } }));
  const env = { HQ_ROOT: mirror, AGENT_OS_REPO_ROOT: join(root, 'agent-os') };
  const options = { env, fallbackModel: 'constant' };
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(message);
  try {
    assert.deepEqual(resolveRemediationModel('remediator-codex', options), {
      resolvedModel: 'mirror',
      resolvedReasoningLevel: null,
      modelSource: 'registry-mirror',
      reasoningSource: 'none',
    });
    rmSync(mirrorPath);
    assert.equal(resolveRemediationModel('remediator-codex', { ...options, nowMs: Date.now() + 61_000 }).modelSource, 'registry-seed');
    assert.equal(resolveRemediationModel('remediator-gemini', options).resolvedModel, 'constant');
    writeFileSync(seedPath, '{bad json');
    const fallback = resolveRemediationModel('remediator-codex', { ...options, nowMs: Date.now() + 122_000 });
    assert.deepEqual(fallback, {
      resolvedModel: 'constant',
      resolvedReasoningLevel: null,
      modelSource: 'fallback-constant',
      reasoningSource: 'none',
    });
    assert.match(warnings.at(-1), /remediator-codex.*unparsable JSON/);
    const warningCount = warnings.length;
    resolveRemediationModel('remediator-codex', { ...options, nowMs: Date.now() + 122_000 });
    assert.equal(warnings.length, warningCount);
    rmSync(seedPath);
    const missing = resolveRemediationModel('remediator-codex', { ...options, nowMs: Date.now() + 183_000 });
    assert.equal(missing.modelSource, 'fallback-constant');
    assert.match(warnings.at(-1), /remediator-codex.*missing file/);
  } finally {
    console.warn = originalWarn;
    rmSync(root, { recursive: true, force: true });
  }
});

test('remediation model resolver keeps legacy seed override and validates cli-specific effort levels', () => {
  const root = makeRoot();
  const mirror = join(root, 'hq', 'registry');
  const seed = join(root, 'agent-os', 'modules', 'worker-pool');
  mkdirSync(mirror, { recursive: true });
  mkdirSync(seed, { recursive: true });
  writeFileSync(join(mirror, 'worker-classes.json'), JSON.stringify({ classes: {
    'remediator-claude': { defaultModel: 'claude-opus-5-5', defaultReasoningLevel: 'extra' },
    'remediator-codex': { defaultModel: 'gpt-6-sol', defaultReasoningLevel: 'high' },
    'remediator-test-invalid': { defaultModel: '-not-a-model' },
  } }));
  writeFileSync(join(seed, 'worker-classes.json'), JSON.stringify({
    'remediator-test-invalid': { defaultModel: '-also-not-a-model' },
  }));
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(message);
  try {
    const claude = resolveRemediationModel('remediator-claude', {
      env: { HQ_ROOT: join(root, 'hq'), AGENT_OS_DEPLOY_CHECKOUT: join(root, 'agent-os') },
      fallbackModel: 'claude-fallback',
    });
    assert.equal(claude.resolvedModel, 'claude-opus-5-5');
    assert.equal(claude.resolvedReasoningLevel, null);
    assert.equal(claude.reasoningSource, 'invalid-registry-mirror');
    assert.match(warnings.at(-1), /remediator-claude.*invalid reasoning level.*extra/);

    const invalidPin = resolveRemediationModel('remediator-codex', {
      env: { HQ_ROOT: join(root, 'hq'), AGENT_OS_DEPLOY_CHECKOUT: join(root, 'agent-os') },
      reasoningPin: 'hgih',
      fallbackModel: 'codex-fallback',
    });
    assert.equal(invalidPin.resolvedReasoningLevel, 'high');
    assert.equal(invalidPin.reasoningSource, 'registry-mirror');

    const invalidModel = resolveRemediationModel('remediator-test-invalid', {
      env: { HQ_ROOT: join(root, 'hq'), AGENT_OS_DEPLOY_CHECKOUT: join(root, 'agent-os') },
      fallbackModel: 'constant',
      nowMs: Date.now() + 61_000,
    });
    assert.deepEqual(invalidModel, {
      resolvedModel: 'constant',
      resolvedReasoningLevel: null,
      modelSource: 'fallback-constant',
      reasoningSource: 'none',
    });
    assert.match(warnings.at(-1), /remediator-test-invalid.*invalid defaultModel/);
  } finally {
    console.warn = originalWarn;
    rmSync(root, { recursive: true, force: true });
  }
});

test('local remediation completion accepts canonical reply artifacts without stdout body', async () => {
  const rootDir = makeRoot();
  const outputPath = join(rootDir, 'empty-output.txt');
  const logPath = join(rootDir, 'worker.log');
  const replyPath = join(rootDir, 'reply.json');
  try {
    writeFileSync(outputPath, '', 'utf8');
    writeFileSync(logPath, 'worker log', 'utf8');
    writeFileSync(replyPath, '{"kind":"adversarial-review-remediation-reply"}', 'utf8');
    const result = await waitForLocalRemediationExit({
      processId: 5151,
      processGroupId: 5151,
      outputPath,
      logPath,
      replyPath,
      launchRequestId: 'lrq_artifact_only',
    }, {
      processKillImpl: () => {
        const err = new Error('not alive');
        err.code = 'ESRCH';
        throw err;
      },
    });
    assert.equal(result.status, 'completed');
    assert.equal(result.artifact.body, null);
    assert.equal(result.artifact.reattachToken, 'lrq_artifact_only');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('codex remediation startup evidence preserves policy violation schema aliases', () => {
  const rootDir = makeRoot();
  const codexHome = join(rootDir, 'codex-home');
  const codexAuthDir = join(codexHome, '.codex');
  mkdirSync(codexAuthDir, { recursive: true });
  try {
    const { startupEvidence } = withEnv({
      CODEX_AUTH_PATH: join(codexAuthDir, 'auth.json'),
      CODEX_HOME: codexAuthDir,
      HOME: codexHome,
    }, () => prepareCodexRemediationStartupEnv());
    assert.deepEqual(startupEvidence.policy_violations, []);
    assert.equal(startupEvidence.policyViolations, startupEvidence.policy_violations);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('codex remediation startup evidence resolves auth owner on Linux home paths', () => {
  const rootDir = makeRoot();
  const linuxHome = join(rootDir, 'home', 'runner');
  const codexAuthDir = join(linuxHome, '.codex');
  mkdirSync(codexAuthDir, { recursive: true });
  try {
    const { startupEvidence } = withEnv({
      CODEX_AUTH_PATH: join(codexAuthDir, 'auth.json'),
      CODEX_HOME: codexAuthDir,
      HOME: linuxHome,
    }, () => prepareCodexRemediationStartupEnv());
    assert.equal(startupEvidence.resolvedStartup.resolvedAuthOwner, 'runner');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('local remediation cancel ignores process exit races after identity verification', async () => {
  for (const code of ['ESRCH', 'EPERM']) {
    const signals = [];
    await cancelLocalRemediationWorker({
      processId: 6262,
      processGroupId: 6262,
      spawnedAt: '2026-08-02T17:10:00.000Z',
    }, {
      execFileImpl: async () => {
        const err = new Error('operation not permitted');
        err.code = 'EPERM';
        throw err;
      },
      processKillImpl: (target, signal) => {
        signals.push([target, signal]);
        if (signal === 0) return true;
        const err = new Error('race during signal');
        err.code = code;
        throw err;
      },
    });
    assert.deepEqual(signals, [[-6262, 0], [-6262, 'SIGTERM']]);
  }
});

test('local remediation cancel succeeds when the identity probe shows the worker is already gone', async () => {
  for (const probeResult of [
    { stdout: '', stderr: '' },
    Object.assign(new Error('process not found'), { code: 'ESRCH' }),
  ]) {
    const signals = [];
    await cancelLocalRemediationWorker({
      processId: 6263,
      processGroupId: 6263,
      spawnedAt: '2026-08-02T17:10:00.000Z',
    }, {
      execFileImpl: async () => {
        if (probeResult instanceof Error) throw probeResult;
        return probeResult;
      },
      processKillImpl: (target, signal) => {
        signals.push([target, signal]);
        return true;
      },
    });
    assert.deepEqual(signals, [[-6263, 0]]);
  }
});

test('local remediation cancel retries transient process identity probe failures', async () => {
  const calls = [];
  const sleeps = [];
  let probes = 0;
  await cancelLocalRemediationWorker({
    processId: 6363,
    processGroupId: 6363,
    spawnedAt: '2026-08-02T17:10:00.000Z',
  }, {
    execFileImpl: async () => {
      calls.push('ps');
      probes += 1;
      if (probes < 3) {
        const err = new Error('resource temporarily unavailable');
        err.code = 'EAGAIN';
        throw err;
      }
      return { stdout: '2026-08-02T17:10:00.000Z\n', stderr: '' };
    },
    processKillImpl: (target, signal) => calls.push(`${target}:${signal}`),
    sleepImpl: async (ms) => sleeps.push(ms),
  });

  assert.deepEqual(sleeps, [50, 100]);
  assert.deepEqual(calls, ['-6363:0', 'ps', 'ps', 'ps', '-6363:SIGTERM']);
});

test('local remediation cancel bounds persistent transient identity probe failures', async () => {
  let probes = 0;
  const sleeps = [];
  await assert.rejects(
    cancelLocalRemediationWorker({
      processId: 6464,
      processGroupId: 6464,
      spawnedAt: '2026-08-02T17:10:00.000Z',
    }, {
      execFileImpl: async () => {
        probes += 1;
        const err = new Error('input/output error');
        err.code = 'EIO';
        throw err;
      },
      processKillImpl: () => true,
      sleepImpl: async (ms) => sleeps.push(ms),
    }),
    /refusing to cancel remediation worker with unconfirmed identity/,
  );
  assert.equal(probes, 4);
  assert.deepEqual(sleeps, [50, 100, 200]);
});

test('gemini and codex remediation spawners close earlier fds when later sync open fails', () => {
  const rootDir = makeRoot();
  const promptPath = join(rootDir, 'prompt.md');
  const missingOutputPath = join(rootDir, 'missing', 'out.txt');
  const logPath = join(rootDir, 'worker.log');
  const missingLogPath = join(rootDir, 'missing', 'worker.log');
  writeFileSync(promptPath, 'fix the PR', 'utf8');
  try {
    for (const [name, spawnWorker, paths] of [
      ['gemini', spawnGeminiRemediationWorker, { outputPath: missingOutputPath, logPath }],
      ['codex', (opts) => {
        const codexHome = join(rootDir, 'codex-home');
        const codexAuthDir = join(codexHome, '.codex');
        mkdirSync(codexAuthDir, { recursive: true });
        return withEnv({
          CODEX_AUTH_PATH: join(codexAuthDir, 'auth.json'),
          CODEX_HOME: codexAuthDir,
          HOME: codexHome,
        }, () => spawnCodexRemediationWorker(opts));
      }, { outputPath: join(rootDir, 'codex-output.txt'), logPath: missingLogPath }],
    ]) {
      const before = countOpenFds();
      assert.throws(() => spawnWorker({
        workspaceDir: rootDir,
        promptPath,
        outputPath: paths.outputPath,
        logPath: paths.logPath,
        replyPath: join(rootDir, `${name}-reply.json`),
        launchRequestId: `lrq_${name}`,
        spawnImpl: () => ({ pid: 7373, unref() {} }),
      }), /ENOENT/);
      const after = countOpenFds();
      if (before !== null && after !== null) {
        assert.equal(after, before, `${name} failed spawn must not leak file descriptors`);
      }
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
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
