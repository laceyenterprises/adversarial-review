import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  CANONICAL_OAUTH_STRIP_ENV as ACPX_CANONICAL_OAUTH_STRIP_ENV,
  assertCodexOAuthLayers,
  buildAcpxCodexArgs,
  classifyAcpxFailure,
  createAcpxReviewerRuntimeAdapter,
  domainRequiresMcpOAuth,
  resolveAcpxCliPath,
} from '../src/adapters/reviewer-runtime/acpx/index.mjs';

import {
  createAgentOsHqReviewerRuntimeAdapter,
  createReviewerRuntimeAdapterForDomain,
  recoverReviewerRunRecords,
  resolveReviewerRuntimeName,
} from '../src/adapters/reviewer-runtime/index.mjs';
import { createCliDirectReviewerRuntimeAdapter } from '../src/adapters/reviewer-runtime/cli-direct/index.mjs';
import {
  CANONICAL_OAUTH_STRIP_ENV as CLI_DIRECT_CANONICAL_OAUTH_STRIP_ENV,
  resolveProgressTimeoutForModel,
} from '../src/adapters/reviewer-runtime/cli-direct/index.mjs';
import { AgentOSConfigError, resetConfigCache } from '../src/config-loader.mjs';
import { probeCodexCli, resolveCliBinary } from '../src/adapters/reviewer-runtime/cli-direct/discovery.mjs';
import {
  readActiveReviewerRunRecords,
  readRecoverableReviewerRunRecords,
  readReviewerRunRecord,
  pruneReviewerRunRecords,
  removeReviewerRunArtifacts,
  removeReviewerRunRecord,
  reviewerRunSideChannelPaths,
  reviewerRunStatePath,
  settleReviewerRunRecord,
  writeReviewerRunRecord,
} from '../src/adapters/reviewer-runtime/run-state.mjs';
import { ensureReviewStateSchema } from '../src/review-state.mjs';
import { PROVIDER_OVERLOADED_FAILURE_CLASS } from '../src/adapters/reviewer-runtime/cli-direct/classification.mjs';
import { QUOTA_EXHAUSTED_FAILURE_CLASS } from '../src/quota-exhaustion.mjs';

const noopPreflight = async ({ model }) => (
  String(model || '').toLowerCase().includes('codex')
    ? { codexCli: '/tmp/fake-codex' }
    : { claudeCli: '/tmp/fake-claude' }
);
const TEST_HQ_PARENT_SESSION = 'session:test:hq';
const TEST_HQ_PROJECT = 'adversarial-review';

function makeRoot() {
  const rootDir = mkdtempSync(join(tmpdir(), 'reviewer-runtime-'));
  mkdirSync(join(rootDir, 'domains'), { recursive: true });
  return rootDir;
}

async function waitFor(assertion, { timeoutMs = 5_000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      return assertion();
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  throw lastError || new Error('waitFor timed out');
}

function makeHqRoot(ownerUser = process.env.USER || 'test-user') {
  const hqRoot = mkdtempSync(join(tmpdir(), 'reviewer-runtime-hq-'));
  mkdirSync(join(hqRoot, '.hq'), { recursive: true });
  writeFileSync(join(hqRoot, '.hq', 'config.json'), `${JSON.stringify({ ownerUser })}\n`);
  return hqRoot;
}

function makeHqEnv(hqRoot, overrides = {}) {
  return {
    HQ_ROOT: hqRoot,
    HQ_PARENT_SESSION: TEST_HQ_PARENT_SESSION,
    HQ_PROJECT: TEST_HQ_PROJECT,
    USER: process.env.USER || 'test-user',
    ...overrides,
  };
}

function validReviewBody(verdict = 'Comment only') {
  return [
    '## Summary',
    '',
    'The reviewed change is acceptable.',
    '',
    '## Verdict',
    verdict,
    '',
  ].join('\n');
}

test('loads reviewer runtime by name from domain config with cli-direct default', () => {
  assert.equal(resolveReviewerRuntimeName({}), 'cli-direct');
  assert.equal(resolveReviewerRuntimeName({ reviewerRuntime: 'fixture-stub' }), 'fixture-stub');

  const rootDir = makeRoot();
  try {
    const adapter = createReviewerRuntimeAdapterForDomain({
      rootDir,
      domainId: 'research-finding',
      domainConfig: { id: 'research-finding', reviewerRuntime: 'fixture-stub' },
      reviewerBodies: ['## Verdict\nComment only'],
    });
    assert.equal(adapter.describe().id, 'fixture-stub');
    assert.equal(
      createReviewerRuntimeAdapterForDomain({
        rootDir,
        domainId: 'code-pr',
        domainConfig: { id: 'code-pr', reviewerRuntime: 'agent-os-hq' },
        env: { HQ_ROOT: rootDir, USER: process.env.USER || 'test-user' },
        hqBin: '/bin/hq',
      }).describe().id,
      'agent-os-hq',
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('resolveReviewerRuntimeName forces agent-os-hq only in agentos mode', () => {
  assert.equal(
    resolveReviewerRuntimeName(
      { reviewerRuntime: 'cli-direct' },
      { orchestrationMode: 'agentos' },
    ),
    'agent-os-hq',
  );
  assert.equal(
    resolveReviewerRuntimeName({}, { orchestrationMode: 'native' }),
    'cli-direct',
  );
  assert.equal(
    resolveReviewerRuntimeName(
      { reviewerRuntime: 'acpx' },
      { orchestrationMode: 'native' },
    ),
    'acpx',
  );
});

test('createReviewerRuntimeAdapterForDomain applies orchestration override without mutating domain JSON', () => {
  const rootDir = makeRoot();
  const domainPath = join(rootDir, 'domains', 'code-pr.json');
  const domainBody = JSON.stringify({
    id: 'code-pr',
    reviewerRuntime: 'cli-direct',
  }, null, 2);
  writeFileSync(domainPath, `${domainBody}\n`);
  try {
    const agentOsAdapter = createReviewerRuntimeAdapterForDomain({
      rootDir,
      domainId: 'code-pr',
      orchestrationMode: 'agentos',
      env: { HQ_ROOT: rootDir, USER: process.env.USER || 'test-user' },
      hqBin: '/bin/hq',
    });
    assert.equal(agentOsAdapter.describe().id, 'agent-os-hq');

    const nativeAdapter = createReviewerRuntimeAdapterForDomain({
      rootDir,
      domainId: 'code-pr',
      orchestrationMode: 'native',
    });
    assert.equal(nativeAdapter.describe().id, 'cli-direct');
    assert.equal(readFileSync(domainPath, 'utf8'), `${domainBody}\n`);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('createReviewerRuntimeAdapterForDomain preserves explicit native non-default reviewerRuntime', () => {
  const rootDir = makeRoot();
  try {
    const adapter = createReviewerRuntimeAdapterForDomain({
      rootDir,
      domainId: 'code-pr',
      domainConfig: { id: 'code-pr', reviewerRuntime: 'acpx' },
      orchestrationMode: 'native',
      env: { CODEX_HOME: rootDir },
    });
    assert.equal(adapter.describe().id, 'acpx');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('agent-os-hq dispatches via hq with artifact completion and stripped fallback env', async () => {
  const rootDir = makeRoot();
  const hqRoot = makeHqRoot(process.env.USER || 'test-user');
  const calls = [];
  try {
    const adapter = createAgentOsHqReviewerRuntimeAdapter({
      rootDir,
      hqBin: '/bin/hq',
      env: {
        ...makeHqEnv(hqRoot),
        OPENAI_API_KEY: 'must-not-propagate',
        ANTHROPIC_API_KEY: 'must-not-propagate',
        PATH: '/usr/bin:/bin',
      },
      execFileImpl: async (command, args, options) => {
        calls.push({ command, args, env: options.env });
        if (args[0] === 'dispatch' && args[1] !== 'status') {
          const promptPath = args[args.indexOf('--prompt') + 1];
          const prompt = readFileSync(promptPath, 'utf8');
          const artifactPath = prompt.match(/^Artifact path: (.+)$/m)?.[1];
          assert.ok(artifactPath, 'prompt should name the artifact path');
          writeFileSync(artifactPath, validReviewBody('Approved'));
          return {
            stdout: JSON.stringify({ dispatchId: 'lrq_lac_566', launchRequestId: 'lrq_lac_566' }),
            stderr: '',
          };
        }
        if (args[0] === 'dispatch' && args[1] === 'status') {
          return { stdout: JSON.stringify({ status: 'succeeded', health: 'ok' }), stderr: '' };
        }
        throw new Error(`unexpected hq call: ${args.join(' ')}`);
      },
      now: () => '2026-05-11T20:00:00.000Z',
    });

    const result = await adapter.spawnReviewer({
      model: 'codex',
      prompt: 'Review the PR.',
      subjectContext: { domainId: 'code-pr', repo: 'lacey/repo', prNumber: 14, linearTicketId: 'LAC-566' },
      timeoutMs: 100,
      sessionUuid: 'agent-hq-dispatch-session',
      forbiddenFallbacks: ['api-key', 'anthropic-api-key'],
      tokenBudget: 12345,
    });

    assert.equal(result.ok, true);
    assert.match(result.reviewBody, /^## Summary/m);
    assert.match(result.reviewBody, /^## Verdict\nApproved/m);
    assert.equal(result.stderrTail, null);
    assert.equal(calls.length, 2);
    const promptArg = calls[0].args[calls[0].args.indexOf('--prompt') + 1];
    assert.deepEqual(calls[0].args, [
      'dispatch',
      '--ticket', 'LAC-566',
      '--worker-class', 'codex',
      '--prompt', promptArg,
      '--completion-shape', 'artifact',
      '--parent-session', TEST_HQ_PARENT_SESSION,
      '--project', TEST_HQ_PROJECT,
      '--task-kind', 'analysis',
      '--token-budget', '12345',
      '--root', hqRoot,
    ]);
    assert.equal(Object.hasOwn(calls[0].env, 'OPENAI_API_KEY'), false);
    assert.equal(Object.hasOwn(calls[0].env, 'ANTHROPIC_API_KEY'), false);
    assert.equal(calls[0].env.HQ_ROOT, hqRoot);
    assert.equal(calls[0].env.HQ_PARENT_SESSION, TEST_HQ_PARENT_SESSION);
    assert.equal(calls[0].env.HQ_PROJECT, TEST_HQ_PROJECT);
    assert.deepEqual(calls[1].args, ['dispatch', 'status', 'lrq_lac_566', '--root', hqRoot]);
    assert.equal(Object.hasOwn(calls[1].env, 'OPENAI_API_KEY'), false);
    assert.equal(Object.hasOwn(calls[1].env, 'ANTHROPIC_API_KEY'), false);
    const record = readReviewerRunRecord(rootDir, 'agent-hq-dispatch-session');
    assert.deepEqual(record.subjectContext.agentOsHq.forbiddenFallbacks, ['api-key', 'anthropic-api-key']);
    assert.equal(record.subjectContext.agentOsHq.parentSession, TEST_HQ_PARENT_SESSION);
    assert.equal(record.subjectContext.agentOsHq.project, TEST_HQ_PROJECT);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(hqRoot, { recursive: true, force: true });
  }
});

test('agent-os-hq reports owner mismatch as configuration error without invoking hq', async () => {
  const rootDir = makeRoot();
  const hqRoot = makeHqRoot('somebody-else');
  let invoked = false;
  try {
    const adapter = createAgentOsHqReviewerRuntimeAdapter({
      rootDir,
      hqBin: '/bin/hq',
      env: makeHqEnv(hqRoot),
      execFileImpl: async () => {
        invoked = true;
        throw new Error('should not run');
      },
    });
    const result = await adapter.spawnReviewer({
      model: 'codex',
      prompt: '',
      subjectContext: { domainId: 'code-pr', repo: 'lacey/repo', prNumber: 14 },
      timeoutMs: 100,
      sessionUuid: 'agent-hq-owner-mismatch',
      forbiddenFallbacks: ['api-key'],
    });
    assert.equal(invoked, false);
    assert.equal(result.ok, false);
    assert.equal(result.failureClass, 'bug');
    assert.equal(result.configurationError, true);
    assert.match(result.stderrTail, /HQ owner mismatch/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(hqRoot, { recursive: true, force: true });
  }
});

test('agent-os-hq rejects missing ticket references before dispatch', async () => {
  const rootDir = makeRoot();
  const hqRoot = makeHqRoot(process.env.USER || 'test-user');
  let invoked = false;
  try {
    const adapter = createAgentOsHqReviewerRuntimeAdapter({
      rootDir,
      hqBin: '/bin/hq',
      env: makeHqEnv(hqRoot),
      execFileImpl: async () => {
        invoked = true;
        return { stdout: '', stderr: '' };
      },
    });
    const result = await adapter.spawnReviewer({
      model: 'codex',
      prompt: '',
      subjectContext: { domainId: 'code-pr', repo: 'lacey/repo', prNumber: 14 },
      timeoutMs: 100,
      sessionUuid: 'agent-hq-missing-ticket',
      forbiddenFallbacks: ['api-key'],
    });
    assert.equal(invoked, false);
    assert.equal(result.ok, false);
    assert.equal(result.failureClass, 'bug');
    assert.equal(result.configurationError, true);
    assert.match(result.stderrTail, /requires subjectContext\.linearTicketId or subjectContext\.subjectExternalId/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(hqRoot, { recursive: true, force: true });
  }
});

test('agent-os-hq rejects missing HQ_PARENT_SESSION before dispatch', async () => {
  const rootDir = makeRoot();
  const hqRoot = makeHqRoot(process.env.USER || 'test-user');
  let invoked = false;
  try {
    const adapter = createAgentOsHqReviewerRuntimeAdapter({
      rootDir,
      hqBin: '/bin/hq',
      env: makeHqEnv(hqRoot, { HQ_PARENT_SESSION: '' }),
      execFileImpl: async () => {
        invoked = true;
        return { stdout: '', stderr: '' };
      },
    });
    const result = await adapter.spawnReviewer({
      model: 'codex',
      prompt: '',
      subjectContext: { domainId: 'code-pr', repo: 'lacey/repo', prNumber: 14, linearTicketId: 'LAC-566' },
      timeoutMs: 100,
      sessionUuid: 'agent-hq-missing-parent-session',
      forbiddenFallbacks: ['api-key'],
    });
    assert.equal(invoked, false);
    assert.equal(result.ok, false);
    assert.equal(result.failureClass, 'bug');
    assert.equal(result.configurationError, true);
    assert.match(result.stderrTail, /requires HQ_PARENT_SESSION/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(hqRoot, { recursive: true, force: true });
  }
});

test('agent-os-hq rejects missing HQ_PROJECT before dispatch', async () => {
  const rootDir = makeRoot();
  const hqRoot = makeHqRoot(process.env.USER || 'test-user');
  let invoked = false;
  try {
    const adapter = createAgentOsHqReviewerRuntimeAdapter({
      rootDir,
      hqBin: '/bin/hq',
      env: makeHqEnv(hqRoot, { HQ_PROJECT: '' }),
      execFileImpl: async () => {
        invoked = true;
        return { stdout: '', stderr: '' };
      },
    });
    const result = await adapter.spawnReviewer({
      model: 'codex',
      prompt: '',
      subjectContext: { domainId: 'code-pr', repo: 'lacey/repo', prNumber: 14, linearTicketId: 'LAC-566' },
      timeoutMs: 100,
      sessionUuid: 'agent-hq-missing-project',
      forbiddenFallbacks: ['api-key'],
    });
    assert.equal(invoked, false);
    assert.equal(result.ok, false);
    assert.equal(result.failureClass, 'bug');
    assert.equal(result.configurationError, true);
    assert.match(result.stderrTail, /requires HQ_PROJECT/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(hqRoot, { recursive: true, force: true });
  }
});

test('agent-os-hq rejects unknown model fallback without explicit worker class', async () => {
  const rootDir = makeRoot();
  const hqRoot = makeHqRoot(process.env.USER || 'test-user');
  let invoked = false;
  try {
    const adapter = createAgentOsHqReviewerRuntimeAdapter({
      rootDir,
      hqBin: '/bin/hq',
      env: makeHqEnv(hqRoot),
      execFileImpl: async () => {
        invoked = true;
        return { stdout: '', stderr: '' };
      },
    });
    const result = await adapter.spawnReviewer({
      model: 'claude-3.7',
      prompt: '',
      subjectContext: { domainId: 'code-pr', repo: 'lacey/repo', prNumber: 14, linearTicketId: 'LAC-566' },
      timeoutMs: 100,
      sessionUuid: 'agent-hq-unknown-model',
      forbiddenFallbacks: ['api-key'],
    });
    assert.equal(invoked, false);
    assert.equal(result.ok, false);
    assert.equal(result.failureClass, 'bug');
    assert.equal(result.configurationError, true);
    assert.match(result.stderrTail, /does not know how to map model/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(hqRoot, { recursive: true, force: true });
  }
});

test('agent-os-hq fails loud when HQ_ROOT is missing', async () => {
  const rootDir = makeRoot();
  try {
    const adapter = createAgentOsHqReviewerRuntimeAdapter({
      rootDir,
      hqBin: '/bin/hq',
      env: { HQ_PARENT_SESSION: TEST_HQ_PARENT_SESSION, HQ_PROJECT: TEST_HQ_PROJECT, USER: process.env.USER || 'test-user' },
    });
    const result = await adapter.spawnReviewer({
      model: 'codex',
      prompt: '',
      subjectContext: { domainId: 'code-pr', repo: 'lacey/repo', prNumber: 14, linearTicketId: 'LAC-566' },
      timeoutMs: 100,
      sessionUuid: 'agent-hq-missing-root',
      forbiddenFallbacks: ['api-key'],
    });
    assert.equal(result.ok, false);
    assert.equal(result.failureClass, 'bug');
    assert.equal(result.configurationError, true);
    assert.match(result.stderrTail, /set HQ_ROOT or use cli-direct\/acpx/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('agent-os-hq fails loud when hq binary is missing', async () => {
  const rootDir = makeRoot();
  const hqRoot = makeHqRoot(process.env.USER || 'test-user');
  try {
    const adapter = createAgentOsHqReviewerRuntimeAdapter({
      rootDir,
      env: makeHqEnv(hqRoot, { PATH: '' }),
    });
    const result = await adapter.spawnReviewer({
      model: 'codex',
      prompt: '',
      subjectContext: { domainId: 'code-pr', repo: 'lacey/repo', prNumber: 14, linearTicketId: 'LAC-566' },
      timeoutMs: 100,
      sessionUuid: 'agent-hq-missing-bin',
      forbiddenFallbacks: ['api-key'],
    });
    assert.equal(result.ok, false);
    assert.equal(result.failureClass, 'bug');
    assert.equal(result.configurationError, true);
    assert.match(result.stderrTail, /hq binary not found/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(hqRoot, { recursive: true, force: true });
  }
});

test('agent-os-hq polling uses 30s cadence plus jitter', async () => {
  const rootDir = makeRoot();
  const hqRoot = makeHqRoot(process.env.USER || 'test-user');
  const sleeps = [];
  let statusCount = 0;
  try {
    const adapter = createAgentOsHqReviewerRuntimeAdapter({
      rootDir,
      hqBin: '/bin/hq',
      env: makeHqEnv(hqRoot),
      jitterImpl: () => 1234,
      sleepImpl: async (ms) => { sleeps.push(ms); },
      execFileImpl: async (_command, args) => {
        if (args[0] === 'dispatch' && args[1] !== 'status') {
          return { stdout: JSON.stringify({ launchRequestId: 'lrq_polling' }), stderr: '' };
        }
        statusCount += 1;
        if (statusCount < 3) {
          return { stdout: JSON.stringify({ status: 'running', health: 'ok', lastProgressAt: `t${statusCount}` }), stderr: '' };
        }
        const recordPath = join(rootDir, 'data', 'reviewer-runs', 'agent-hq-polling.agent-os-hq.review.md');
        writeFileSync(recordPath, validReviewBody());
        return { stdout: JSON.stringify({ status: 'succeeded', health: 'ok' }), stderr: '' };
      },
    });
    const result = await adapter.spawnReviewer({
      model: 'codex',
      prompt: '',
      subjectContext: { domainId: 'code-pr', repo: 'lacey/repo', prNumber: 14, linearTicketId: 'LAC-566' },
      timeoutMs: 120_000,
      sessionUuid: 'agent-hq-polling',
      forbiddenFallbacks: ['api-key'],
    });
    assert.equal(result.ok, true);
    assert.deepEqual(sleeps, [31_234, 31_234]);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(hqRoot, { recursive: true, force: true });
  }
});

test('agent-os-hq sustained lease_expired is surfaced with trace guidance', async () => {
  const rootDir = makeRoot();
  const hqRoot = makeHqRoot(process.env.USER || 'test-user');
  let elapsed = 0;
  try {
    const adapter = createAgentOsHqReviewerRuntimeAdapter({
      rootDir,
      hqBin: '/bin/hq',
      env: makeHqEnv(hqRoot),
      jitterImpl: () => 0,
      sleepImpl: async (ms) => { elapsed += ms; },
      nowMs: () => elapsed,
      execFileImpl: async (_command, args) => {
        if (args[0] === 'dispatch' && args[1] !== 'status') {
          return { stdout: JSON.stringify({ launchRequestId: 'lrq_lease_expired' }), stderr: '' };
        }
        return {
          stdout: JSON.stringify({
            status: 'running',
            health: 'lease_expired',
            phase: 'running',
            lastProgressAt: '2026-05-11T20:00:00.000Z',
            lastProgressSummary: 'same',
          }),
          stderr: '',
        };
      },
    });
    const result = await adapter.spawnReviewer({
      model: 'codex',
      prompt: '',
      subjectContext: { domainId: 'code-pr', repo: 'lacey/repo', prNumber: 14, linearTicketId: 'LAC-566' },
      timeoutMs: 120_000,
      sessionUuid: 'agent-hq-lease-expired',
      forbiddenFallbacks: ['api-key'],
    });
    assert.equal(result.ok, false);
    assert.equal(result.failureClass, 'lease-expired');
    assert.match(result.stderrTail, /hq dispatch trace lrq_lease_expired/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(hqRoot, { recursive: true, force: true });
  }
});

test('agent-os-hq validates missing and malformed artifacts', async () => {
  const rootDir = makeRoot();
  const hqRoot = makeHqRoot(process.env.USER || 'test-user');
  try {
    const adapter = createAgentOsHqReviewerRuntimeAdapter({
      rootDir,
      hqBin: '/bin/hq',
      env: makeHqEnv(hqRoot),
      execFileImpl: async (_command, args) => {
        if (args[0] === 'dispatch' && args[1] !== 'status') {
          const promptPath = args[args.indexOf('--prompt') + 1];
          const prompt = readFileSync(promptPath, 'utf8');
          const artifactPath = prompt.match(/^Artifact path: (.+)$/m)?.[1];
          if (artifactPath?.includes('malformed-artifact')) {
            writeFileSync(artifactPath, 'not a review at all');
          }
          return { stdout: JSON.stringify({ launchRequestId: 'lrq_bad_artifact' }), stderr: '' };
        }
        return { stdout: JSON.stringify({ status: 'succeeded', health: 'ok' }), stderr: '' };
      },
    });
    const missing = await adapter.spawnReviewer({
      model: 'codex',
      prompt: '',
      subjectContext: { domainId: 'code-pr', repo: 'lacey/repo', prNumber: 14, linearTicketId: 'LAC-566' },
      timeoutMs: 100,
      sessionUuid: 'agent-hq-missing-artifact',
      forbiddenFallbacks: ['api-key'],
    });
    assert.equal(missing.ok, false);
    assert.equal(missing.failureClass, 'reviewer-output');
    assert.match(missing.stderrTail, /review artifact missing/);

    const malformed = await adapter.spawnReviewer({
      model: 'codex',
      prompt: '',
      subjectContext: { domainId: 'code-pr', repo: 'lacey/repo', prNumber: 15, linearTicketId: 'LAC-567' },
      timeoutMs: 100,
      sessionUuid: 'agent-hq-malformed-artifact',
      forbiddenFallbacks: ['api-key'],
    });
    assert.equal(malformed.ok, false);
    assert.equal(malformed.failureClass, 'reviewer-output');
    assert.match(malformed.stderrTail, /recognizable review sections|review artifact/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(hqRoot, { recursive: true, force: true });
  }
});

test('agent-os-hq enforces timeoutMs and cancels the dispatch on expiry', async () => {
  const rootDir = makeRoot();
  const hqRoot = makeHqRoot(process.env.USER || 'test-user');
  const calls = [];
  let elapsed = 0;
  try {
    const adapter = createAgentOsHqReviewerRuntimeAdapter({
      rootDir,
      hqBin: '/bin/hq',
      env: makeHqEnv(hqRoot),
      jitterImpl: () => 0,
      sleepImpl: async (ms) => { elapsed += ms; },
      nowMs: () => elapsed,
      execFileImpl: async (_command, args, options) => {
        calls.push({ args, timeout: options.timeout });
        if (args[0] === 'dispatch' && args[1] !== 'status' && args[1] !== 'cancel') {
          return { stdout: JSON.stringify({ launchRequestId: 'lrq_timeout' }), stderr: '' };
        }
        if (args[0] === 'dispatch' && args[1] === 'status') {
          return { stdout: JSON.stringify({ status: 'running', health: 'ok' }), stderr: '' };
        }
        if (args[0] === 'dispatch' && args[1] === 'cancel') {
          return { stdout: JSON.stringify({ canceled: true }), stderr: '' };
        }
        throw new Error(`unexpected hq call: ${args.join(' ')}`);
      },
    });
    const result = await adapter.spawnReviewer({
      model: 'codex',
      prompt: '',
      subjectContext: { domainId: 'code-pr', repo: 'lacey/repo', prNumber: 14, linearTicketId: 'LAC-566' },
      timeoutMs: 50_000,
      sessionUuid: 'agent-hq-timeout',
      forbiddenFallbacks: ['api-key'],
    });
    assert.equal(result.ok, false);
    assert.equal(result.failureClass, 'reviewer-timeout');
    assert.equal(result.reattachToken, 'lrq_timeout');
    assert.match(result.stderrTail, /exceeded reviewer timeout/);
    const timeoutPromptArg = calls[0].args[calls[0].args.indexOf('--prompt') + 1];
    assert.deepEqual(calls.map(({ args }) => args), [
      ['dispatch', '--ticket', 'LAC-566', '--worker-class', 'codex', '--prompt', timeoutPromptArg, '--completion-shape', 'artifact', '--parent-session', TEST_HQ_PARENT_SESSION, '--project', TEST_HQ_PROJECT, '--task-kind', 'analysis', '--root', hqRoot],
      ['dispatch', 'status', 'lrq_timeout', '--root', hqRoot],
      ['dispatch', 'status', 'lrq_timeout', '--root', hqRoot],
      ['dispatch', 'cancel', 'lrq_timeout', '--root', hqRoot],
    ]);
    assert.equal(calls[0].timeout, 50_000);
    assert.equal(calls[1].timeout, 50_000);
    assert.equal(calls[2].timeout, 20_000);
    assert.equal(calls[3].timeout, 1_000);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(hqRoot, { recursive: true, force: true });
  }
});

test('agent-os-hq cancel does not overwrite terminal completed records', async () => {
  const rootDir = makeRoot();
  const hqRoot = makeHqRoot(process.env.USER || 'test-user');
  let cancelCalls = 0;
  try {
    writeReviewerRunRecord(rootDir, {
      sessionUuid: 'agent-hq-completed',
      domain: 'code-pr',
      runtime: 'agent-os-hq',
      state: 'completed',
      spawnedAt: '2026-05-11T20:00:00.000Z',
      lastHeartbeatAt: '2026-05-11T20:05:00.000Z',
      reattachToken: 'lrq_completed',
      subjectContext: {
        domainId: 'code-pr',
        linearTicketId: 'LAC-566',
        agentOsHq: { hqRoot, hqBin: '/bin/hq' },
      },
    });
    const adapter = createAgentOsHqReviewerRuntimeAdapter({
      rootDir,
      hqBin: '/bin/hq',
      env: makeHqEnv(hqRoot),
      execFileImpl: async () => {
        cancelCalls += 1;
        return { stdout: '', stderr: '' };
      },
    });
    await adapter.cancel('agent-hq-completed');
    assert.equal(cancelCalls, 0);
    assert.equal(readReviewerRunRecord(rootDir, 'agent-hq-completed').state, 'completed');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(hqRoot, { recursive: true, force: true });
  }
});

test('agent-os-hq reattaches by polling persisted launch request id', async () => {
  const rootDir = makeRoot();
  const hqRoot = makeHqRoot(process.env.USER || 'test-user');
  const artifactPath = join(rootDir, 'data', 'reviewer-runs', 'agent-hq-reattach.agent-os-hq.review.md');
  try {
    mkdirSync(dirname(artifactPath), { recursive: true });
    writeFileSync(artifactPath, validReviewBody('Comment only'));
    writeReviewerRunRecord(rootDir, {
      sessionUuid: 'agent-hq-reattach',
      domain: 'code-pr',
      runtime: 'agent-os-hq',
      state: 'heartbeating',
      spawnedAt: '2026-05-11T20:00:00.000Z',
      lastHeartbeatAt: '2026-05-11T20:00:30.000Z',
      reattachToken: 'lrq_reattach',
      subjectContext: {
        domainId: 'code-pr',
        agentOsHq: { artifactPath, hqRoot, hqBin: '/bin/hq' },
      },
    });
    const adapter = createAgentOsHqReviewerRuntimeAdapter({
      rootDir,
      hqBin: '/bin/hq',
      env: makeHqEnv(hqRoot),
      execFileImpl: async (_command, args) => {
        assert.deepEqual(args, ['dispatch', 'status', 'lrq_reattach', '--root', hqRoot]);
        return { stdout: JSON.stringify({ status: 'succeeded', health: 'ok' }), stderr: '' };
      },
    });
    const record = readRecoverableReviewerRunRecords(rootDir)[0];
    const result = await adapter.reattach(record);
    assert.equal(result.ok, true);
    assert.match(result.reviewBody, /^## Verdict\nComment only/m);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(hqRoot, { recursive: true, force: true });
  }
});

test('agent-os-hq reattach classifies never-dispatched records as daemon-bounce', async () => {
  const rootDir = makeRoot();
  const hqRoot = makeHqRoot(process.env.USER || 'test-user');
  try {
    const adapter = createAgentOsHqReviewerRuntimeAdapter({
      rootDir,
      hqBin: '/bin/hq',
      env: makeHqEnv(hqRoot),
    });
    const result = await adapter.reattach({
      sessionUuid: 'agent-hq-never-dispatched',
      reattachToken: 'agent-hq-never-dispatched',
      spawnedAt: '2026-05-11T20:00:00.000Z',
      subjectContext: { domainId: 'code-pr' },
    });
    assert.equal(result.ok, false);
    assert.equal(result.failureClass, 'daemon-bounce');
    assert.match(result.stderrTail, /no launch request id/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(hqRoot, { recursive: true, force: true });
  }
});

test('cli-direct delegates failure classification to the runtime adapter', async () => {
  const rootDir = makeRoot();
  try {
    const adapter = createCliDirectReviewerRuntimeAdapter({
      rootDir,
      preflightImpl: noopPreflight,
      spawnCapturedImpl: async () => {
        const err = new Error('reviewer failed');
        err.stderr = 'LiteLLM retry pool: all upstream attempts failed';
        err.exitCode = 1;
        throw err;
      },
      now: () => '2026-05-11T20:00:00.000Z',
    });

    const result = await adapter.spawnReviewer({
      model: 'codex',
      prompt: '',
      subjectContext: { domainId: 'code-pr', repo: 'lacey/repo', prNumber: 1 },
      timeoutMs: 100,
      sessionUuid: 'classification-session',
      forbiddenFallbacks: ['api-key'],
    });

    assert.equal(result.ok, false);
    assert.equal(result.failureClass, 'cascade');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('cli-direct classifies quota text from stdout even when stderr has wrapper noise', async () => {
  const rootDir = makeRoot();
  try {
    const adapter = createCliDirectReviewerRuntimeAdapter({
      rootDir,
      preflightImpl: noopPreflight,
      spawnCapturedImpl: async () => {
        const err = new Error('Command failed with code 1');
        err.stdout = "You've hit your weekly limit · resets Jun 27 at 3am (America/Los_Angeles)";
        err.stderr = '[reviewer] DEBUG: fetching diff...\n[reviewer] ERROR STACK: Error: Command failed with code 1';
        err.exitCode = 1;
        throw err;
      },
      now: () => '2026-06-23T00:39:39.000Z',
    });

    const result = await adapter.spawnReviewer({
      model: 'claude',
      prompt: '',
      subjectContext: { domainId: 'code-pr', repo: 'lacey/repo', prNumber: 2454 },
      timeoutMs: 100,
      sessionUuid: 'classification-quota-stdout-session',
      forbiddenFallbacks: ['api-key'],
    });

    assert.equal(result.ok, false);
    assert.equal(result.failureClass, QUOTA_EXHAUSTED_FAILURE_CLASS);
    assert.match(result.stdoutTail, /weekly limit/);
    assert.match(result.stderrTail, /ERROR STACK/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('cli-direct classifies provider overload text from stdout even when stderr has wrapper noise', async () => {
  const rootDir = makeRoot();
  try {
    const adapter = createCliDirectReviewerRuntimeAdapter({
      rootDir,
      preflightImpl: noopPreflight,
      spawnCapturedImpl: async () => {
        const err = new Error('Command failed with code 1');
        err.stdout = 'API Error 529: overloaded_error from provider backend';
        err.stderr = '[reviewer] DEBUG: fetching diff...\n[reviewer] ERROR STACK: Error: Command failed with code 1';
        err.exitCode = 1;
        throw err;
      },
      now: () => '2026-06-23T00:39:39.000Z',
    });

    const result = await adapter.spawnReviewer({
      model: 'claude',
      prompt: '',
      subjectContext: { domainId: 'code-pr', repo: 'lacey/repo', prNumber: 2454 },
      timeoutMs: 100,
      sessionUuid: 'classification-provider-overload-stdout-session',
      forbiddenFallbacks: ['api-key'],
    });

    assert.equal(result.ok, false);
    assert.equal(result.failureClass, PROVIDER_OVERLOADED_FAILURE_CLASS);
    assert.match(result.stdoutTail, /529/);
    assert.match(result.stderrTail, /ERROR STACK/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('cli-direct does not classify generated stdout review prose as a bug', async () => {
  const rootDir = makeRoot();
  try {
    const adapter = createCliDirectReviewerRuntimeAdapter({
      rootDir,
      preflightImpl: noopPreflight,
      spawnCapturedImpl: async () => {
        const err = new Error('Command failed with code 1');
        err.stdout = 'Review draft: blocking issue mentions SyntaxError in the submitted code.';
        err.stderr = '';
        err.exitCode = 1;
        throw err;
      },
      now: () => '2026-06-23T00:39:39.000Z',
    });

    const result = await adapter.spawnReviewer({
      model: 'claude',
      prompt: '',
      subjectContext: { domainId: 'code-pr', repo: 'lacey/repo', prNumber: 2454 },
      timeoutMs: 100,
      sessionUuid: 'classification-stdout-prose-session',
      forbiddenFallbacks: ['api-key'],
    });

    assert.equal(result.ok, false);
    assert.equal(result.failureClass, 'unknown');
    assert.match(result.stdoutTail, /SyntaxError/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('acpx classifies quota text from stdout even when stderr has wrapper noise', async () => {
  const rootDir = makeRoot();
  try {
    const adapter = createAcpxReviewerRuntimeAdapter({
      rootDir,
      resolveAcpxCliImpl: async () => '/bin/acpx',
      execFileImpl: async () => ({ stdout: '[]\n', stderr: '' }),
      spawnCapturedImpl: async () => {
        const err = new Error('Command failed with code 1');
        err.stdout = "You've hit your weekly limit · resets Jun 27 at 3am (America/Los_Angeles)";
        err.stderr = '[reviewer] DEBUG: acpx review failed';
        err.exitCode = 1;
        throw err;
      },
      now: () => '2026-06-23T00:39:39.000Z',
    });

    const result = await adapter.spawnReviewer({
      model: 'codex',
      prompt: '',
      subjectContext: { domainId: 'code-pr', repo: 'lacey/repo', prNumber: 2454 },
      timeoutMs: 100,
      sessionUuid: 'acpx-classification-quota-stdout-session',
      forbiddenFallbacks: ['api-key'],
    });

    assert.equal(result.ok, false);
    assert.equal(result.failureClass, QUOTA_EXHAUSTED_FAILURE_CLASS);
    assert.match(result.stdoutTail, /weekly limit/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('acpx does not classify generated stdout review prose as a bug', async () => {
  const rootDir = makeRoot();
  try {
    const adapter = createAcpxReviewerRuntimeAdapter({
      rootDir,
      resolveAcpxCliImpl: async () => '/bin/acpx',
      execFileImpl: async () => ({ stdout: '[]\n', stderr: '' }),
      spawnCapturedImpl: async () => {
        const err = new Error('Command failed with code 1');
        err.stdout = 'Review draft: blocking issue mentions TypeError in the submitted code.';
        err.stderr = '';
        err.exitCode = 1;
        throw err;
      },
      now: () => '2026-06-23T00:39:39.000Z',
    });

    const result = await adapter.spawnReviewer({
      model: 'codex',
      prompt: '',
      subjectContext: { domainId: 'code-pr', repo: 'lacey/repo', prNumber: 2454 },
      timeoutMs: 100,
      sessionUuid: 'acpx-classification-stdout-prose-session',
      forbiddenFallbacks: ['api-key'],
    });

    assert.equal(result.ok, false);
    assert.equal(result.failureClass, 'unknown');
    assert.match(result.stdoutTail, /TypeError/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('cli-direct Codex preflight ignores ambient MCP OAuth unless the domain requires MCP', async () => {
  const calls = [];
  const execFileImpl = async (_command, args) => {
    calls.push(args);
    if (args[0] === '--version') return { stdout: 'codex 1.0.0\n', stderr: '' };
    if (args[0] === 'sessions') return { stdout: '[]\n', stderr: '' };
    if (args[0] === 'mcp') return { stdout: 'autok  Not logged in\n', stderr: '' };
    throw new Error(`unexpected Codex probe: ${args.join(' ')}`);
  };

  await probeCodexCli({
    env: { PATH: '/bin', CODEX_CLI: '/bin/codex' },
    cwd: '/tmp',
    execFileImpl,
  });
  assert.deepEqual(calls.map((args) => args.join(' ')), [
    '--version',
    'sessions list',
  ]);

  await assert.rejects(
    () => probeCodexCli({
      env: { PATH: '/bin', CODEX_CLI: '/bin/codex' },
      cwd: '/tmp',
      execFileImpl,
      requireMcpOAuth: true,
    }),
    /Codex MCP-server OAuth state is broken/,
  );
});

test('cli-direct derives Codex MCP OAuth requirement from adapter domainConfig', async () => {
  const calls = [];
  const rootDir = makeRoot();

  try {
    const adapter = createCliDirectReviewerRuntimeAdapter({
      rootDir,
      domainConfig: { id: 'code-pr', requiredMcpServers: ['linear'] },
      preflightImpl: async (input) => {
        calls.push(input);
        throw new Error('stop after preflight');
      },
      spawnCapturedImpl: async () => {
        throw new Error('spawn should not run after preflight stub');
      },
      now: () => '2026-05-11T20:00:00.000Z',
    });
    const result = await adapter.spawnReviewer({
      model: 'codex',
      prompt: '',
      subjectContext: { domainId: 'code-pr', repo: 'lacey/repo', prNumber: 1 },
      timeoutMs: 100,
      sessionUuid: 'cli-direct-domain-config-mcp',
      forbiddenFallbacks: ['api-key'],
    });

    assert.equal(result.ok, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].requireMcpOAuth, true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('cli-direct disables the no-output progress watchdog for non-streaming reviewer CLIs', () => {
  assert.equal(
    resolveProgressTimeoutForModel('codex', { ADVERSARIAL_REVIEWER_PROGRESS_TIMEOUT_MS: '900000' }),
    0,
  );
  assert.equal(
    resolveProgressTimeoutForModel('claude', { ADVERSARIAL_REVIEWER_PROGRESS_TIMEOUT_MS: '1234' }),
    0,
  );
});

test('cli-direct writes atomic reviewer run records and refuses double-spawn for a session', async () => {
  const rootDir = makeRoot();
  let release;
  let spawnCount = 0;
  try {
    const adapter = createCliDirectReviewerRuntimeAdapter({
      rootDir,
      preflightImpl: noopPreflight,
      spawnCapturedImpl: async (_command, _args, options) => {
        spawnCount += 1;
        options.onSpawn({ pgid: 4242 });
        await new Promise((resolve) => { release = resolve; });
        return { stdout: 'posted\n', stderr: '' };
      },
      now: () => '2026-05-11T20:00:00.000Z',
    });

    const req = {
      model: 'claude',
      prompt: '',
      subjectContext: { domainId: 'code-pr', repo: 'lacey/repo', prNumber: 2 },
      timeoutMs: 100,
      sessionUuid: 'double-spawn-session',
      forbiddenFallbacks: ['api-key'],
    };
    const first = adapter.spawnReviewer(req);
    await new Promise((resolve) => setImmediate(resolve));
    const duplicate = await adapter.spawnReviewer(req);
    assert.equal(duplicate.ok, false);
    assert.equal(duplicate.failureClass, 'daemon-bounce');
    assert.equal(spawnCount, 1);

    const active = readActiveReviewerRunRecords(rootDir);
    assert.equal(active.length, 1);
    assert.equal(active[0].state, 'heartbeating');
    assert.equal(active[0].pgid, 4242);

    release();
    const completed = await first;
    assert.equal(completed.ok, true);
    assert.equal(existsSync(reviewerRunStatePath(rootDir, req.sessionUuid)), true);

    const terminalDuplicate = await adapter.spawnReviewer(req);
    assert.equal(terminalDuplicate.ok, false);
    assert.equal(terminalDuplicate.failureClass, 'bug');
    assert.match(terminalDuplicate.stderrTail, /terminal state completed/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('cli-direct preserves cancelled state across abort races', async () => {
  const rootDir = makeRoot();
  let release;
  try {
    const adapter = createCliDirectReviewerRuntimeAdapter({
      rootDir,
      preflightImpl: noopPreflight,
      spawnCapturedImpl: async (_command, _args, options) => {
        options.onSpawn({ pgid: 4243 });
        await new Promise((resolve) => { release = resolve; });
        const err = new Error('aborted');
        err.code = 'ABORT_ERR';
        err.signal = 'SIGTERM';
        throw err;
      },
      now: () => '2026-05-11T20:00:00.000Z',
    });

    const req = {
      model: 'claude',
      prompt: '',
      subjectContext: { domainId: 'code-pr', repo: 'lacey/repo', prNumber: 2 },
      timeoutMs: 100,
      sessionUuid: 'cancelled-session',
      forbiddenFallbacks: ['api-key'],
    };
    const run = adapter.spawnReviewer(req);
    await new Promise((resolve) => setImmediate(resolve));
    await adapter.cancel(req.sessionUuid);
    release();

    const cancelled = await run;
    assert.equal(cancelled.ok, false);
    assert.equal(cancelled.failureClass, 'unknown');
    assert.equal(existsSync(reviewerRunStatePath(rootDir, req.sessionUuid)), true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('cli-direct strips forbidden API-key fallback env before spawning', async () => {
  const rootDir = makeRoot();
  const previousOpenAi = process.env.OPENAI_API_KEY;
  const previousAnthropic = process.env.ANTHROPIC_API_KEY;
  const previousAnthropicBaseUrl = process.env.ANTHROPIC_BASE_URL;
  const previousClaudeBedrock = process.env.CLAUDE_CODE_USE_BEDROCK;
  const previousClaudeVertex = process.env.CLAUDE_CODE_USE_VERTEX;
  const previousAwsBearerTokenBedrock = process.env.AWS_BEARER_TOKEN_BEDROCK;
  const previousGoogleApiKey = process.env.GOOGLE_API_KEY;
  const previousGeminiApiKey = process.env.GEMINI_API_KEY;
  process.env.OPENAI_API_KEY = 'must-not-propagate';
  process.env.ANTHROPIC_API_KEY = 'must-not-propagate';
  process.env.ANTHROPIC_BASE_URL = 'https://proxy.example.invalid';
  process.env.CLAUDE_CODE_USE_BEDROCK = '1';
  process.env.CLAUDE_CODE_USE_VERTEX = '1';
  process.env.AWS_BEARER_TOKEN_BEDROCK = 'must-not-propagate';
  process.env.GOOGLE_API_KEY = 'must-not-propagate';
  process.env.GEMINI_API_KEY = 'must-not-propagate';
  try {
    let childEnv;
    const adapter = createCliDirectReviewerRuntimeAdapter({
      rootDir,
      preflightImpl: noopPreflight,
      spawnCapturedImpl: async (_command, _args, options) => {
        childEnv = options.env;
        options.onSpawn({ pgid: 5150 });
        return { stdout: 'ok', stderr: '' };
      },
    });
    const result = await adapter.spawnReviewer({
      model: 'claude',
      prompt: '',
      subjectContext: { domainId: 'code-pr', repo: 'lacey/repo', prNumber: 3 },
      timeoutMs: 100,
      sessionUuid: 'oauth-strip-session',
      forbiddenFallbacks: ['api-key', 'anthropic-api-key', 'bedrock', 'vertex'],
    });
    assert.equal(result.ok, true);
    assert.equal(Object.hasOwn(childEnv, 'OPENAI_API_KEY'), false);
    assert.equal(Object.hasOwn(childEnv, 'ANTHROPIC_API_KEY'), false);
    assert.equal(Object.hasOwn(childEnv, 'ANTHROPIC_BASE_URL'), false);
    assert.equal(Object.hasOwn(childEnv, 'CLAUDE_CODE_USE_BEDROCK'), false);
    assert.equal(Object.hasOwn(childEnv, 'CLAUDE_CODE_USE_VERTEX'), false);
    assert.equal(Object.hasOwn(childEnv, 'AWS_BEARER_TOKEN_BEDROCK'), false);
    assert.equal(Object.hasOwn(childEnv, 'GOOGLE_API_KEY'), false);
    assert.equal(Object.hasOwn(childEnv, 'GEMINI_API_KEY'), false);
  } finally {
    if (previousOpenAi === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAi;
    if (previousAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousAnthropic;
    if (previousAnthropicBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = previousAnthropicBaseUrl;
    if (previousClaudeBedrock === undefined) delete process.env.CLAUDE_CODE_USE_BEDROCK;
    else process.env.CLAUDE_CODE_USE_BEDROCK = previousClaudeBedrock;
    if (previousClaudeVertex === undefined) delete process.env.CLAUDE_CODE_USE_VERTEX;
    else process.env.CLAUDE_CODE_USE_VERTEX = previousClaudeVertex;
    if (previousAwsBearerTokenBedrock === undefined) delete process.env.AWS_BEARER_TOKEN_BEDROCK;
    else process.env.AWS_BEARER_TOKEN_BEDROCK = previousAwsBearerTokenBedrock;
    if (previousGoogleApiKey === undefined) delete process.env.GOOGLE_API_KEY;
    else process.env.GOOGLE_API_KEY = previousGoogleApiKey;
    if (previousGeminiApiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousGeminiApiKey;
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('cli-direct returns Codex JSON token usage from reviewer stdout', async () => {
  const rootDir = makeRoot();
  try {
    const adapter = createCliDirectReviewerRuntimeAdapter({
      rootDir,
      preflightImpl: noopPreflight,
      spawnCapturedImpl: async (_command, _args, options) => {
        options.onSpawn({ pgid: 5152 });
        return {
          stdout: [
            JSON.stringify({
              type: 'turn.completed',
              usage: {
                input_tokens: 123,
                cached_input_tokens: 45,
                output_tokens: 6,
                total_tokens: 129,
              },
            }),
            '',
          ].join('\n'),
          stderr: '',
        };
      },
    });
    const result = await adapter.spawnReviewer({
      model: 'codex',
      prompt: '',
      subjectContext: { domainId: 'code-pr', repo: 'lacey/repo', prNumber: 3 },
      timeoutMs: 100,
      sessionUuid: 'codex-json-token-session',
      forbiddenFallbacks: ['api-key'],
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.tokenUsage, {
      input: 123,
      output: 6,
      cacheRead: 45,
      cacheWrite: 0,
      total: 129,
      source: 'codex-json',
      usageTag: 'guardrail',
      guardrail: 129,
    });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('cli-direct returns Codex JSON token usage from failed reviewer stdout', async () => {
  const rootDir = makeRoot();
  try {
    const adapter = createCliDirectReviewerRuntimeAdapter({
      rootDir,
      preflightImpl: noopPreflight,
      spawnCapturedImpl: async (_command, _args, options) => {
        options.onSpawn({ pgid: 5252 });
        const err = new Error('reviewer timed out');
        err.signal = 'SIGTERM';
        err.killed = true;
        err.stdout = [
          JSON.stringify({
            type: 'turn.completed',
            usage: {
              input_tokens: 456,
              cached_input_tokens: 78,
              output_tokens: 9,
              total_tokens: 465,
            },
          }),
          '',
        ].join('\n');
        err.stderr = 'timeout after reviewer subprocess grace window';
        throw err;
      },
    });
    const result = await adapter.spawnReviewer({
      model: 'codex',
      prompt: '',
      subjectContext: { domainId: 'code-pr', repo: 'lacey/repo', prNumber: 3 },
      timeoutMs: 100,
      sessionUuid: 'codex-json-token-failure-session',
      forbiddenFallbacks: ['api-key'],
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.tokenUsage, {
      input: 456,
      output: 9,
      cacheRead: 78,
      cacheWrite: 0,
      total: 465,
      source: 'codex-json',
      usageTag: 'guardrail',
      guardrail: 465,
    });
    assert.equal(result.tokenUsageNoUsageReason, null);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('cli-direct records typed no-usage reason for unparseable failed Codex stdout', async () => {
  const rootDir = makeRoot();
  try {
    const adapter = createCliDirectReviewerRuntimeAdapter({
      rootDir,
      preflightImpl: noopPreflight,
      spawnCapturedImpl: async (_command, _args, options) => {
        options.onSpawn({ pgid: 5253 });
        const err = new Error('reviewer killed');
        err.signal = 'SIGTERM';
        err.killed = true;
        err.stdout = '{"type":"turn.completed","usage":';
        err.stderr = 'killed before JSON completed';
        throw err;
      },
    });
    const result = await adapter.spawnReviewer({
      model: 'codex',
      prompt: '',
      subjectContext: { domainId: 'code-pr', repo: 'lacey/repo', prNumber: 3 },
      timeoutMs: 100,
      sessionUuid: 'codex-json-token-unparseable-failure-session',
      forbiddenFallbacks: ['api-key'],
    });
    assert.equal(result.ok, false);
    assert.equal(result.tokenUsage, null);
    assert.equal(result.tokenUsageNoUsageReason, 'unparseable-stdout');
    assert.match(result.stdoutTail, /turn\.completed/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('cli-direct threads cross-model waiver fields into reviewer process args', async () => {
  const rootDir = makeRoot();
  try {
    let reviewerArgs = null;
    const adapter = createCliDirectReviewerRuntimeAdapter({
      rootDir,
      preflightImpl: noopPreflight,
      spawnCapturedImpl: async (_command, args, options) => {
        reviewerArgs = JSON.parse(args[1]);
        options.onSpawn({ pgid: 5151 });
        return { stdout: validReviewBody(), stderr: '' };
      },
    });

    const result = await adapter.spawnReviewer({
      model: 'claude',
      prompt: '',
      subjectContext: {
        domainId: 'code-pr',
        repo: 'lacey/repo',
        prNumber: 3,
        crossModelReviewWaived: true,
        crossModelReviewWaiverReason: 'operator pin forced same-family reviewer',
      },
      timeoutMs: 100,
      sessionUuid: 'waiver-audit-session',
      forbiddenFallbacks: ['api-key'],
    });

    assert.equal(result.ok, true);
    assert.equal(reviewerArgs.crossModelReviewWaived, true);
    assert.equal(
      reviewerArgs.crossModelReviewWaiverReason,
      'operator pin forced same-family reviewer',
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('cli-direct returns Codex token usage from reviewer token side-channel marker', async () => {
  const rootDir = makeRoot();
  try {
    const adapter = createCliDirectReviewerRuntimeAdapter({
      rootDir,
      preflightImpl: noopPreflight,
      spawnCapturedImpl: async (_command, _args, options) => {
        options.onSpawn({ pgid: 5153 });
        return {
          stdout: [
            '[reviewer] Starting review: lacey/repo#3 model=codex',
            JSON.stringify({
              type: 'reviewer.token_usage',
              tokenUsage: {
                input: 1000,
                output: 200,
                cacheRead: 300,
                cacheWrite: 0,
                total: 1500,
                source: 'codex-json',
              },
            }),
            '[reviewer] Review generated (42 chars)',
            '',
          ].join('\n'),
          stderr: '',
        };
      },
    });
    const result = await adapter.spawnReviewer({
      model: 'codex',
      prompt: '',
      subjectContext: { domainId: 'code-pr', repo: 'lacey/repo', prNumber: 3 },
      timeoutMs: 100,
      sessionUuid: 'codex-reviewer-marker-token-session',
      forbiddenFallbacks: ['api-key'],
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.tokenUsage, {
      input: 1000,
      output: 200,
      cacheRead: 300,
      cacheWrite: 0,
      total: 1500,
      source: 'codex-json',
      usageTag: 'guardrail',
      guardrail: 1500,
    });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('cli-direct preserves explicit null guardrail from reviewer token side-channel marker', async () => {
  const rootDir = makeRoot();
  try {
    const adapter = createCliDirectReviewerRuntimeAdapter({
      rootDir,
      preflightImpl: noopPreflight,
      spawnCapturedImpl: async (_command, _args, options) => {
        options.onSpawn({ pgid: 5153 });
        return {
          stdout: [
            '[reviewer] Starting review: lacey/repo#3 model=codex',
            JSON.stringify({
              type: 'reviewer.token_usage',
              tokenUsage: {
                input: 1000,
                output: 200,
                total: 1500,
                guardrail: null,
                source: 'session-ledger',
              },
            }),
            '[reviewer] Review generated (42 chars)',
            '',
          ].join('\n'),
          stderr: '',
        };
      },
    });
    const result = await adapter.spawnReviewer({
      model: 'codex',
      prompt: '',
      subjectContext: { domainId: 'code-pr', repo: 'lacey/repo', prNumber: 3 },
      timeoutMs: 100,
      sessionUuid: 'codex-reviewer-marker-null-guardrail-session',
      forbiddenFallbacks: ['api-key'],
    });
    assert.equal(result.ok, true);
    assert.equal(result.tokenUsage.usageTag, 'guardrail');
    assert.equal(result.tokenUsage.guardrail, null);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('cli-direct enforces canonical OAuth strip regardless of forbiddenFallbacks shape', async () => {
  // Regression: the watcher passes only `['api-key', 'anthropic-api-key']` as
  // forbiddenFallbacks. Previously, only OPENAI_API_KEY / ANTHROPIC_API_KEY /
  // GOOGLE_API_KEY / GEMINI_API_KEY got stripped (4 of 8) — the bedrock /
  // vertex / proxy redirectors survived into the reviewer subprocess, so an
  // ANTHROPIC_BASE_URL=https://attacker.invalid in the launchd context could
  // route OAuth bearer traffic through a hostile proxy even though the
  // adapter advertised `oauthStripEnforced: true`. Capability bit MUST mean
  // "the full canonical 8-env set is stripped" no matter what the caller passes.
  const rootDir = makeRoot();
  const previous = {};
  const canonical = [
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'AWS_BEARER_TOKEN_BEDROCK',
    'GOOGLE_API_KEY',
    'GEMINI_API_KEY',
  ];
  for (const k of canonical) {
    previous[k] = process.env[k];
    process.env[k] = 'must-not-propagate';
  }
  try {
    let childEnv;
    const adapter = createCliDirectReviewerRuntimeAdapter({
      rootDir,
      preflightImpl: noopPreflight,
      spawnCapturedImpl: async (_command, _args, options) => {
        childEnv = options.env;
        options.onSpawn({ pgid: 5151 });
        return { stdout: 'ok', stderr: '' };
      },
    });
    const result = await adapter.spawnReviewer({
      model: 'claude',
      prompt: '',
      subjectContext: { domainId: 'code-pr', repo: 'lacey/repo', prNumber: 3 },
      timeoutMs: 100,
      sessionUuid: 'oauth-strip-canonical-session',
      // Production watcher value — narrow alias list, only 'api-key' family.
      forbiddenFallbacks: ['api-key', 'anthropic-api-key'],
    });
    assert.equal(result.ok, true);
    for (const k of canonical) {
      assert.equal(Object.hasOwn(childEnv, k), false, `${k} must be stripped by canonical-OAuth-strip enforcement`);
    }
  } finally {
    for (const k of canonical) {
      if (previous[k] === undefined) delete process.env[k];
      else process.env[k] = previous[k];
    }
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('cli-direct path discovery honors env override, PATH fallback, and clear missing-binary errors', async () => {
  const rootDir = makeRoot();
  try {
    const binDir = join(rootDir, 'bin');
    mkdirSync(binDir, { recursive: true });
    const claudePath = join(binDir, 'claude');
    writeFileSync(claudePath, '#!/bin/sh\nexit 0\n', 'utf8');
    chmodSync(claudePath, 0o755);

    assert.equal(
      await resolveCliBinary({
        binaryName: 'claude',
        envVar: 'CLAUDE_CLI',
        env: { CLAUDE_CLI: '/custom/claude', PATH: binDir },
      }),
      '/custom/claude',
    );
    assert.equal(
      await resolveCliBinary({
        binaryName: 'claude',
        envVar: 'CLAUDE_CLI',
        env: { PATH: binDir },
      }),
      claudePath,
    );
    await assert.rejects(
      () => resolveCliBinary({
        binaryName: 'codex',
        envVar: 'CODEX_CLI',
        env: { PATH: '' },
      }),
      /codex CLI not found.*CODEX_CLI.*developers\.openai\.com\/codex\/cli/i,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('cli-direct Gemini preflight uses Gemini CLI and OAuth instead of Claude', async () => {
  const rootDir = makeRoot();
  const envKeys = [
    'GEMINI_CLI_PATH',
    'GEMINI_CLI',
    'GEMINI_HOME',
    'GEMINI_OAUTH_CREDS_PATH',
    'CLAUDE_CLI',
    'PATH',
  ];
  const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  try {
    const binDir = join(rootDir, 'bin');
    mkdirSync(binDir, { recursive: true });
    const geminiPath = join(binDir, 'gemini');
    writeFileSync(geminiPath, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "gemini 1.0"; exit 0; fi\nexit 0\n', 'utf8');
    chmodSync(geminiPath, 0o755);
    const geminiHome = join(rootDir, '.gemini');
    mkdirSync(geminiHome, { recursive: true });
    writeFileSync(
      join(geminiHome, 'oauth_creds.json'),
      JSON.stringify({ access_token: 'gemini-oauth-token', token_type: 'Bearer' }),
      'utf8',
    );

    process.env.GEMINI_CLI_PATH = geminiPath;
    delete process.env.GEMINI_CLI;
    process.env.GEMINI_HOME = geminiHome;
    delete process.env.GEMINI_OAUTH_CREDS_PATH;
    process.env.CLAUDE_CLI = join(rootDir, 'missing-claude');
    process.env.PATH = '';

    let childEnv;
    const adapter = createCliDirectReviewerRuntimeAdapter({
      rootDir,
      spawnCapturedImpl: async (_command, _args, options) => {
        childEnv = options.env;
        options.onSpawn({ pgid: 6262 });
        return { stdout: 'ok', stderr: '' };
      },
      now: () => '2026-05-11T20:00:00.000Z',
    });

    const result = await adapter.spawnReviewer({
      model: 'gemini',
      prompt: '',
      subjectContext: { domainId: 'code-pr', repo: 'lacey/repo', prNumber: 3 },
      timeoutMs: 100,
      sessionUuid: 'gemini-cli-direct-preflight-session',
      forbiddenFallbacks: ['api-key'],
    });

    assert.equal(result.ok, true);
    assert.equal(childEnv.GEMINI_CLI, geminiPath);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('cli-direct preflight failures are oauth-broken and prevent reviewer spawn', async () => {
  const rootDir = makeRoot();
  let spawnCount = 0;
  try {
    const adapter = createCliDirectReviewerRuntimeAdapter({
      rootDir,
      preflightImpl: async () => {
        const err = new Error('Codex CLI OAuth session probe failed: not logged in');
        err.failureClass = 'oauth-broken';
        err.layer = 'codex-cli-oauth';
        throw err;
      },
      spawnCapturedImpl: async () => {
        spawnCount += 1;
        return { stdout: '', stderr: '' };
      },
      now: () => '2026-05-11T20:00:00.000Z',
    });

    const result = await adapter.spawnReviewer({
      model: 'codex',
      prompt: '',
      subjectContext: { domainId: 'code-pr', repo: 'lacey/repo', prNumber: 3 },
      sessionUuid: 'oauth-broken-session',
      forbiddenFallbacks: ['api-key'],
    });

    assert.equal(result.ok, false);
    assert.equal(result.failureClass, 'oauth-broken');
    assert.match(result.stderrTail, /not logged in/);
    assert.equal(spawnCount, 0);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('cli-direct writes reviewer stdout and stderr to side-channel files', async () => {
  const rootDir = makeRoot();
  try {
    let capturedOptions;
    const adapter = createCliDirectReviewerRuntimeAdapter({
      rootDir,
      preflightImpl: noopPreflight,
      spawnCapturedImpl: async (_command, _args, options) => {
        capturedOptions = options;
        options.onSpawn({ pgid: 5252 });
        writeFileSync(options.stdoutPath, 'stdout on disk\n', 'utf8');
        writeFileSync(options.stderrPath, 'stderr on disk\n', 'utf8');
        return {
          stdout: readFileSync(options.stdoutPath, 'utf8'),
          stderr: readFileSync(options.stderrPath, 'utf8'),
        };
      },
    });

    const result = await adapter.spawnReviewer({
      model: 'claude',
      prompt: '',
      subjectContext: { domainId: 'code-pr', repo: 'lacey/repo', prNumber: 3 },
      timeoutMs: 100,
      sessionUuid: 'side-channel-session',
      forbiddenFallbacks: ['api-key'],
    });

    const paths = reviewerRunSideChannelPaths(rootDir, 'side-channel-session');
    assert.equal(result.ok, true);
    assert.equal(capturedOptions.stdoutPath, paths.stdoutPath);
    assert.equal(capturedOptions.stderrPath, paths.stderrPath);
    assert.equal(readFileSync(paths.stdoutPath, 'utf8'), 'stdout on disk\n');
    assert.equal(readFileSync(paths.stderrPath, 'utf8'), 'stderr on disk\n');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('removeReviewerRunRecord deletes the JSON state file but preserves side-channel forensics', () => {
  const rootDir = makeRoot();
  try {
    writeReviewerRunRecord(rootDir, {
      sessionUuid: 'remove-record-only-session',
      domain: 'code-pr',
      runtime: 'cli-direct',
      state: 'failed',
      spawnedAt: '2026-05-11T20:00:00.000Z',
      lastHeartbeatAt: '2026-05-11T20:00:30.000Z',
      reattachToken: 'remove-record-only-session',
    });
    const paths = reviewerRunSideChannelPaths(rootDir, 'remove-record-only-session');
    writeFileSync(paths.stdoutPath, 'stdout\n', 'utf8');
    writeFileSync(paths.stderrPath, 'stderr\n', 'utf8');

    removeReviewerRunRecord(rootDir, 'remove-record-only-session');

    assert.equal(existsSync(reviewerRunStatePath(rootDir, 'remove-record-only-session')), false);
    // Side-channels are intentionally retained so post-incident triage can
    // still read what the reviewer wrote. `removeReviewerRunArtifacts` is
    // the call for the both-files semantics.
    assert.equal(existsSync(paths.stdoutPath), true);
    assert.equal(existsSync(paths.stderrPath), true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('removeReviewerRunArtifacts deletes the JSON state file AND side-channel files', () => {
  const rootDir = makeRoot();
  try {
    writeReviewerRunRecord(rootDir, {
      sessionUuid: 'remove-artifacts-session',
      domain: 'code-pr',
      runtime: 'cli-direct',
      state: 'failed',
      spawnedAt: '2026-05-11T20:00:00.000Z',
      lastHeartbeatAt: '2026-05-11T20:00:30.000Z',
      reattachToken: 'remove-artifacts-session',
    });
    const paths = reviewerRunSideChannelPaths(rootDir, 'remove-artifacts-session');
    writeFileSync(paths.stdoutPath, 'stdout\n', 'utf8');
    writeFileSync(paths.stderrPath, 'stderr\n', 'utf8');

    removeReviewerRunArtifacts(rootDir, 'remove-artifacts-session');

    assert.equal(existsSync(reviewerRunStatePath(rootDir, 'remove-artifacts-session')), false);
    assert.equal(existsSync(paths.stdoutPath), false);
    assert.equal(existsSync(paths.stderrPath), false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('run-state pruning removes orphan stdout and stderr side-channel files', () => {
  const rootDir = makeRoot();
  try {
    const paths = reviewerRunSideChannelPaths(rootDir, 'orphan-side-channel-session');
    mkdirSync(dirname(paths.stdoutPath), { recursive: true });
    writeFileSync(paths.stdoutPath, 'stdout\n', 'utf8');
    writeFileSync(paths.stderrPath, 'stderr\n', 'utf8');

    const pruned = pruneReviewerRunRecords(rootDir, {
      now: new Date('2026-05-11T20:00:00.000Z'),
      ttlMs: 0,
    });

    assert.deepEqual(pruned, { records: 0, orphanSideChannelFiles: 2, total: 2 });
    assert.equal(existsSync(paths.stdoutPath), false);
    assert.equal(existsSync(paths.stderrPath), false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('cli-direct reattach adopts an alive process group whose identity matches the record', async () => {
  const rootDir = makeRoot();
  const reviewerPath = join(rootDir, 'fixture-reviewer.mjs');
  writeFileSync(
    reviewerPath,
    [
      'console.log("fixture stdout start");',
      'console.error("fixture stderr start");',
      'setInterval(() => {}, 1000);',
    ].join('\n'),
    'utf8',
  );

  try {
    const firstAdapter = createCliDirectReviewerRuntimeAdapter({
      rootDir,
      reviewerProcessPath: reviewerPath,
      preflightImpl: noopPreflight,
      reattachPollIntervalMs: 10,
      now: () => '2026-05-11T20:00:00.000Z',
    });

    const run = firstAdapter.spawnReviewer({
      model: 'claude',
      prompt: '',
      subjectContext: {
        domainId: 'code-pr',
        repo: 'lacey/repo',
        prNumber: 6,
        botTokenEnv: 'GH_TOKEN',
      },
      timeoutMs: 5_000,
      sessionUuid: 'alive-reattach-session',
      forbiddenFallbacks: ['api-key'],
    });

    const record = await waitFor(() => {
      const current = readReviewerRunRecord(rootDir, 'alive-reattach-session');
      assert.equal(current?.state, 'heartbeating');
      assert.equal(Number.isInteger(current.pgid), true);
      return current;
    });

    // Inject a ps probe that returns an lstart matching the recorded
    // spawnedAt within tolerance, simulating "live PGID is the original
    // reviewer." The adapter must adopt in this branch. Derive
    // the lstart from `record.spawnedAt` so the assertion is host-TZ
    // independent: Date.toString round-trips through Date.parse to the
    // same UTC instant.
    const matchingLstart = new Date(record.spawnedAt).toString();
    const restartedAdapter = createCliDirectReviewerRuntimeAdapter({
      rootDir,
      preflightImpl: noopPreflight,
      execFileImpl: async () => ({ stdout: `${matchingLstart}\n` }),
      reattachPollIntervalMs: 10,
      cancelGraceMs: 100,
      cancelPollIntervalMs: 10,
      now: () => '2026-05-11T20:00:01.000Z',
    });
    const reattached = await restartedAdapter.reattach(record);

    assert.equal(reattached.ok, true);
    assert.equal(reattached.failureClass, null);
    const finalRecord = readReviewerRunRecord(rootDir, 'alive-reattach-session');
    assert.equal(finalRecord.state, 'heartbeating');
    assert.equal(finalRecord.adoptedAfterBounce, true);
    try {
      process.kill(-record.pgid, 'SIGKILL');
    } catch (err) {
      if (err?.code !== 'ESRCH') throw err;
    }
    const original = await run;
    assert.equal(original.ok, false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('cli-direct reattach adopts a cancelled record only when its process identity still matches', async () => {
  const rootDir = makeRoot();
  try {
    writeReviewerRunRecord(rootDir, {
      sessionUuid: 'cancelled-live-session',
      domain: 'code-pr',
      runtime: 'cli-direct',
      state: 'cancelled',
      pgid: 4242,
      spawnedAt: '2026-05-11T20:00:00.000Z',
      lastHeartbeatAt: '2026-05-11T20:00:30.000Z',
      reattachToken: 'cancelled-live-session',
    });

    const adapter = createCliDirectReviewerRuntimeAdapter({
      rootDir,
      processKillImpl: (pid, signal) => {
        if (pid === -4242 && signal === 0) return true;
        return process.kill(pid, signal);
      },
      execFileImpl: async () => ({ stdout: `${new Date('2026-05-11T20:00:00.000Z').toString()}\n` }),
      now: () => '2026-05-11T20:01:00.000Z',
    });

    const reattached = await adapter.reattach(readReviewerRunRecord(rootDir, 'cancelled-live-session'));

    assert.equal(reattached.ok, true);
    const finalRecord = readReviewerRunRecord(rootDir, 'cancelled-live-session');
    assert.equal(finalRecord.state, 'heartbeating');
    assert.equal(finalRecord.adoptedAfterBounce, true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('cli-direct reattach does NOT kill a recycled detached pgid (identity mismatch)', async () => {
  const rootDir = makeRoot();
  const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], {
    detached: true,
    stdio: 'ignore',
  });

  try {
    // Record claims this pgid was spawned in 2026; sleeper actually started
    // just now. ps -o lstart= will return a wall-clock time that does NOT
    // parse to within 5s of the fake spawnedAt, so the identity probe must
    // refuse to kill — protecting the bystander process from friendly fire.
    writeReviewerRunRecord(rootDir, {
      sessionUuid: 'recycled-pgid-session',
      domain: 'code-pr',
      runtime: 'cli-direct',
      state: 'heartbeating',
      pgid: sleeper.pid,
      spawnedAt: '2026-05-11T20:00:00.000Z',
      lastHeartbeatAt: '2026-05-11T20:00:30.000Z',
      reattachToken: 'recycled-pgid-session',
    });
    const adapter = createCliDirectReviewerRuntimeAdapter({
      rootDir,
      preflightImpl: noopPreflight,
      reattachPollIntervalMs: 10,
      cancelGraceMs: 100,
      cancelPollIntervalMs: 10,
      now: () => '2026-05-11T20:01:00.000Z',
    });
    const record = readReviewerRunRecord(rootDir, 'recycled-pgid-session');

    const result = await adapter.reattach(record);

    assert.equal(result.ok, false);
    assert.equal(result.failureClass, 'daemon-bounce');
    assert.equal(result.pgid, sleeper.pid);
    assert.match(result.stderrTail, /PID has been recycled, NOT killing/);
    assert.equal(readReviewerRunRecord(rootDir, 'recycled-pgid-session').state, 'failed');
    // Bystander must survive: identity probe rejected, so no SIGTERM/SIGKILL.
    assert.doesNotThrow(() => process.kill(sleeper.pid, 0));
  } finally {
    try {
      process.kill(-sleeper.pid, 'SIGKILL');
    } catch (err) {
      if (err?.code !== 'ESRCH') throw err;
    }
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('cli-direct reattach refuses to kill when ps probe fails', async () => {
  const rootDir = makeRoot();
  let killCalls = 0;
  try {
    writeReviewerRunRecord(rootDir, {
      sessionUuid: 'ps-probe-failure-session',
      domain: 'code-pr',
      runtime: 'cli-direct',
      state: 'heartbeating',
      pgid: 5050,
      spawnedAt: '2026-05-11T20:00:00.000Z',
      lastHeartbeatAt: '2026-05-11T20:00:30.000Z',
      reattachToken: 'ps-probe-failure-session',
    });
    const adapter = createCliDirectReviewerRuntimeAdapter({
      rootDir,
      preflightImpl: noopPreflight,
      processKillImpl: (pid, signal) => {
        if (signal === 0) return true;
        killCalls += 1;
        return true;
      },
      execFileImpl: async () => {
        const err = new Error('ps unavailable');
        err.code = 'ENOENT';
        throw err;
      },
      sleepImpl: async () => {},
      reattachPollIntervalMs: 10,
      cancelGraceMs: 100,
      cancelPollIntervalMs: 10,
      now: () => '2026-05-11T20:01:00.000Z',
    });
    const record = readReviewerRunRecord(rootDir, 'ps-probe-failure-session');

    const result = await adapter.reattach(record);

    assert.equal(result.failureClass, 'daemon-bounce');
    assert.match(result.stderrTail, /PID has been recycled, NOT killing/);
    assert.match(result.stderrTail, /ps probe failed/);
    // No SIGTERM/SIGKILL must fire when identity cannot be verified.
    assert.equal(killCalls, 0);
    assert.equal(readReviewerRunRecord(rootDir, 'ps-probe-failure-session').state, 'failed');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('cli-direct reattach degrades side-channel read errors to daemon-bounce tails', async () => {
  const rootDir = makeRoot();
  try {
    writeReviewerRunRecord(rootDir, {
      sessionUuid: 'bad-tail-session',
      domain: 'code-pr',
      runtime: 'cli-direct',
      state: 'heartbeating',
      pgid: 8888,
      spawnedAt: '2026-05-11T20:00:00.000Z',
      lastHeartbeatAt: '2026-05-11T20:00:30.000Z',
      reattachToken: 'bad-tail-session',
    });
    const paths = reviewerRunSideChannelPaths(rootDir, 'bad-tail-session');
    mkdirSync(paths.stderrPath, { recursive: true });
    let alive = true;
    const adapter = createCliDirectReviewerRuntimeAdapter({
      rootDir,
      processKillImpl: (pid, signal) => {
        assert.equal(pid, -8888);
        if (signal === 0) {
          if (alive) return true;
          const err = new Error('no such process');
          err.code = 'ESRCH';
          throw err;
        }
        alive = false;
        return true;
      },
      sleepImpl: async () => {},
      cancelGraceMs: 1,
      cancelPollIntervalMs: 1,
      now: () => '2026-05-11T20:01:00.000Z',
    });
    const record = readReviewerRunRecord(rootDir, 'bad-tail-session');

    const result = await adapter.reattach(record);

    assert.equal(result.failureClass, 'daemon-bounce');
    assert.match(result.stderrTail, /unable to read reviewer side-channel tails/);
    assert.equal(readReviewerRunRecord(rootDir, 'bad-tail-session').state, 'failed');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('cli-direct cancel sends SIGTERM then SIGKILL and atomically marks cancelled', async () => {
  const rootDir = makeRoot();
  const signals = [];
  let alive = true;
  try {
    writeReviewerRunRecord(rootDir, {
      sessionUuid: 'cancel-pgid-session',
      domain: 'code-pr',
      runtime: 'cli-direct',
      state: 'heartbeating',
      pgid: 7777,
      spawnedAt: '2026-05-11T20:00:00.000Z',
      lastHeartbeatAt: '2026-05-11T20:00:30.000Z',
      reattachToken: 'cancel-pgid-session',
    });

    const adapter = createCliDirectReviewerRuntimeAdapter({
      rootDir,
      processKillImpl: (pid, signal) => {
        assert.equal(pid, -7777);
        if (signal === 0) {
          if (alive) return true;
          const err = new Error('no such process');
          err.code = 'ESRCH';
          throw err;
        }
        signals.push(signal);
        if (signal === 'SIGKILL') alive = false;
        return true;
      },
      sleepImpl: async () => {},
      cancelGraceMs: 1,
      cancelPollIntervalMs: 1,
      now: () => '2026-05-11T20:01:00.000Z',
    });

    await adapter.cancel('cancel-pgid-session');

    assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
    const record = readReviewerRunRecord(rootDir, 'cancel-pgid-session');
    assert.equal(record.state, 'cancelled');
    assert.equal(record.lastHeartbeatAt, '2026-05-11T20:01:00.000Z');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('acpx adapter uses canonical argv shape, strips OAuth fallbacks, and records isolated pgid', async () => {
  const rootDir = makeRoot();
  const previous = {};
  for (const k of ACPX_CANONICAL_OAUTH_STRIP_ENV) {
    previous[k] = process.env[k];
    process.env[k] = 'must-not-propagate';
  }
  previous.ANTHROPIC_AUTH_TOKEN = process.env.ANTHROPIC_AUTH_TOKEN;
  process.env.ANTHROPIC_AUTH_TOKEN = 'preserve-oauth-token';
  try {
    assert.deepEqual(ACPX_CANONICAL_OAUTH_STRIP_ENV, CLI_DIRECT_CANONICAL_OAUTH_STRIP_ENV);

    let capturedOptions;
    let probeCalls = 0;
    const adapter = createAcpxReviewerRuntimeAdapter({
      rootDir,
      domainConfig: { id: 'acpx-smoke' },
      resolveAcpxCliImpl: async () => '/opt/acpx/bin/acpx',
      execFileImpl: async (command, args) => {
        probeCalls += 1;
        assert.equal(command, '/opt/acpx/bin/acpx');
        assert.deepEqual(args, ['codex', 'sessions', 'list']);
        return { stdout: '[]\n', stderr: '' };
      },
      spawnCapturedImpl: async (command, args, options) => {
        capturedOptions = options;
        assert.equal(command, '/opt/acpx/bin/acpx');
        assert.deepEqual(args.slice(0, 4), ['codex', 'exec', '--ephemeral', '--output-last-message']);
        assert.equal(args[5], 'review this fixture');
        assert.equal(args.includes('--cwd'), false);
        assert.equal(Object.hasOwn(options, 'cwd'), false);
        assert.equal(Object.hasOwn(options, 'input'), false);
        options.onSpawn({ pgid: process.pid + 1000 });
        writeFileSync(args[4], '## Verdict\nComment only\n', 'utf8');
        return { stdout: 'acpx ok\n', stderr: '' };
      },
      now: () => '2026-05-11T20:00:00.000Z',
    });

    const result = await adapter.spawnReviewer({
      model: 'codex',
      prompt: 'review this fixture',
      subjectContext: { domainId: 'acpx-smoke', repo: 'lacey/repo', prNumber: 6 },
      timeoutMs: 100,
      sessionUuid: 'acpx-shape-session',
      forbiddenFallbacks: ['api-key'],
    });

    assert.equal(result.ok, true);
    assert.equal(result.reviewBody, '## Verdict\nComment only\n');
    assert.equal(result.pgid, process.pid + 1000);
    assert.equal(probeCalls, 1);
    for (const k of ACPX_CANONICAL_OAUTH_STRIP_ENV) {
      assert.equal(Object.hasOwn(capturedOptions.env, k), false, `${k} must not propagate to acpx`);
    }
    assert.equal(capturedOptions.env.ANTHROPIC_AUTH_TOKEN, 'preserve-oauth-token');

    const record = readReviewerRunRecord(rootDir, 'acpx-shape-session');
    assert.equal(record.runtime, 'acpx');
    assert.equal(record.state, 'completed');
    assert.equal(record.pgid, process.pid + 1000);
    assert.equal(adapter.describe().capabilities.oauthStripEnforced, true);
    assert.equal(adapter.describe().capabilities.heartbeatPersisted, true);
  } finally {
    for (const k of ACPX_CANONICAL_OAUTH_STRIP_ENV) {
      if (previous[k] === undefined) delete process.env[k];
      else process.env[k] = previous[k];
    }
    if (previous.ANTHROPIC_AUTH_TOKEN === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
    else process.env.ANTHROPIC_AUTH_TOKEN = previous.ANTHROPIC_AUTH_TOKEN;
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('acpx adapter persists heartbeat rows while reviewer is running', async () => {
  const rootDir = makeRoot();
  let release;
  let tick = 0;
  try {
    const adapter = createAcpxReviewerRuntimeAdapter({
      rootDir,
      domainConfig: { id: 'acpx-smoke' },
      heartbeatIntervalMs: 5,
      resolveAcpxCliImpl: async () => '/opt/acpx/bin/acpx',
      execFileImpl: async () => ({ stdout: '[]\n', stderr: '' }),
      spawnCapturedImpl: async (_command, args, options) => {
        options.onSpawn({ pgid: 6161 });
        await new Promise((resolve) => { release = () => {
          writeFileSync(args[4], 'heartbeat complete\n', 'utf8');
          resolve();
        }; });
        return { stdout: 'ok\n', stderr: '' };
      },
      now: () => new Date(Date.UTC(2026, 4, 11, 20, 0, tick++)).toISOString(),
    });

    const run = adapter.spawnReviewer({
      model: 'codex',
      prompt: 'keep heartbeating',
      subjectContext: { domainId: 'acpx-smoke', repo: 'lacey/repo', prNumber: 7 },
      timeoutMs: 100,
      sessionUuid: 'acpx-heartbeat-session',
      forbiddenFallbacks: ['api-key'],
    });

    for (let attempt = 0; attempt < 40; attempt += 1) {
      const record = readReviewerRunRecord(rootDir, 'acpx-heartbeat-session');
      if (record?.state === 'heartbeating' && record.lastHeartbeatAt !== '2026-05-11T20:00:01.000Z') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const live = readReviewerRunRecord(rootDir, 'acpx-heartbeat-session');
    assert.equal(live.state, 'heartbeating');
    assert.equal(live.pgid, 6161);
    assert.notEqual(live.lastHeartbeatAt, null);

    release();
    const completed = await run;
    assert.equal(completed.ok, true);
    assert.equal(readReviewerRunRecord(rootDir, 'acpx-heartbeat-session').state, 'completed');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('acpx cancellation does not let heartbeat overwrite the cancelled state', async () => {
  const rootDir = makeRoot();
  let release;
  try {
    const adapter = createAcpxReviewerRuntimeAdapter({
      rootDir,
      domainConfig: { id: 'acpx-smoke' },
      heartbeatIntervalMs: 1,
      resolveAcpxCliImpl: async () => '/opt/acpx/bin/acpx',
      execFileImpl: async () => ({ stdout: '[]\n', stderr: '' }),
      spawnCapturedImpl: async (_command, _args, options) => {
        options.onSpawn({ pgid: 6262 });
        await new Promise((resolve) => { release = resolve; });
        const err = new Error('aborted');
        err.code = 'ABORT_ERR';
        err.signal = 'SIGTERM';
        throw err;
      },
      now: () => '2026-05-11T20:00:00.000Z',
    });

    const run = adapter.spawnReviewer({
      model: 'codex',
      prompt: 'cancel me',
      subjectContext: { domainId: 'acpx-smoke', repo: 'lacey/repo', prNumber: 8 },
      timeoutMs: 100,
      sessionUuid: 'acpx-cancelled-session',
      forbiddenFallbacks: ['api-key'],
    });

    await waitFor(() => {
      const record = readReviewerRunRecord(rootDir, 'acpx-cancelled-session');
      assert.equal(record?.state, 'heartbeating');
      assert.equal(record?.pgid, 6262);
      return record;
    });
    await adapter.cancel('acpx-cancelled-session');
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();

    const cancelled = await run;
    assert.equal(cancelled.ok, false);
    assert.equal(readReviewerRunRecord(rootDir, 'acpx-cancelled-session').state, 'cancelled');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('reviewer run-state remains parseable after SIGKILL during repeated heartbeat writes', async () => {
  const rootDir = makeRoot();
  const runStateUrl = new URL('../src/adapters/reviewer-runtime/run-state.mjs', import.meta.url).href;
  try {
    const child = spawn(process.execPath, [
      '--input-type=module',
      '-e',
      `
        import { updateReviewerRunRecord, writeReviewerRunRecord } from ${JSON.stringify(runStateUrl)};
        const rootDir = ${JSON.stringify(rootDir)};
        let tick = 0;
        let record = writeReviewerRunRecord(rootDir, {
          sessionUuid: 'sigkill-heartbeat-session',
          domain: 'acpx-smoke',
          runtime: 'acpx',
          state: 'spawned',
          pgid: 7171,
          spawnedAt: '2026-05-11T20:00:00.000Z',
          lastHeartbeatAt: null,
          reattachToken: 'acpx:sigkill-heartbeat-session',
        });
        setInterval(() => {
          record = updateReviewerRunRecord(rootDir, record, {
            state: 'heartbeating',
            lastHeartbeatAt: new Date(Date.UTC(2026, 4, 11, 20, 0, tick++)).toISOString(),
          });
        }, 1);
        setInterval(() => {}, 1000);
      `,
    ], { detached: true, stdio: 'ignore' });

    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (existsSync(reviewerRunStatePath(rootDir, 'sigkill-heartbeat-session'))) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(existsSync(reviewerRunStatePath(rootDir, 'sigkill-heartbeat-session')), true);

    process.kill(child.pid, 'SIGKILL');
    await new Promise((resolve) => child.once('close', resolve));

    const raw = readFileSync(reviewerRunStatePath(rootDir, 'sigkill-heartbeat-session'), 'utf8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.sessionUuid, 'sigkill-heartbeat-session');
    assert.match(raw, /\n$/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('acpx discovery uses ACPX_CLI, PATH lookup, fallback path, and a clear missing-binary hint', async () => {
  resetConfigCache();
  assert.equal(
    await resolveAcpxCliPath({
      env: { ACPX_CLI: 'custom-acpx' },
      execFileImpl: async (_command, args) => {
        assert.deepEqual(args, ['custom-acpx']);
        return { stdout: '/usr/local/bin/custom-acpx\n', stderr: '' };
      },
    }),
    '/usr/local/bin/custom-acpx',
  );
  assert.equal(
    await resolveAcpxCliPath({
      env: { HOME: '/no/such/home' },
      execFileImpl: async (command, args) => {
        assert.equal(command, 'which');
        assert.deepEqual(args, ['acpx']);
        return { stdout: '/usr/local/bin/acpx\n', stderr: '' };
      },
    }),
    '/usr/local/bin/acpx',
  );
  const fakeOpenclawRoot = mkdtempSync(join(tmpdir(), 'acpx-openclaw-root-'));
  const fakeHomeRoot = mkdtempSync(join(tmpdir(), 'acpx-home-root-'));
  const fakeAcpx = join(fakeOpenclawRoot, 'tools', 'acpx', 'node_modules', '.bin', 'acpx');
  const fakeHomeAcpx = join(fakeHomeRoot, '.openclaw', 'tools', 'acpx', 'node_modules', '.bin', 'acpx');
  try {
    mkdirSync(dirname(fakeAcpx), { recursive: true });
    writeFileSync(fakeAcpx, '');
    mkdirSync(dirname(fakeHomeAcpx), { recursive: true });
    writeFileSync(fakeHomeAcpx, '');
    assert.equal(
      await resolveAcpxCliPath({
        env: { AGENT_OS_OPENCLAW_INSTALL_ROOT: fakeOpenclawRoot },
        configLoaderImpl: ({ env }) => ({
          get: (key, defaultValue = null) => (
            key === 'openclaw.install_root'
              ? (env?.AGENT_OS_OPENCLAW_INSTALL_ROOT ?? defaultValue)
              : defaultValue
          ),
        }),
        execFileImpl: async () => {
          const err = new Error('not found');
          err.code = 1;
          throw err;
        },
      }),
      fakeAcpx,
    );
    assert.equal(
      await resolveAcpxCliPath({
        env: {},
        configLoaderImpl: () => ({
          get: (key, defaultValue = null) => (key === 'openclaw.install_root' ? fakeOpenclawRoot : defaultValue),
        }),
        execFileImpl: async () => {
          const err = new Error('not found');
          err.code = 1;
          throw err;
        },
      }),
      fakeAcpx,
    );
    assert.equal(
      await resolveAcpxCliPath({
        env: { HOME: fakeHomeRoot },
        configLoaderImpl: () => ({
          get: (_key, defaultValue = null) => defaultValue,
        }),
        execFileImpl: async () => {
          const err = new Error('not found');
          err.code = 1;
          throw err;
        },
      }),
      fakeHomeAcpx,
    );
    assert.equal(
      await resolveAcpxCliPath({
        env: { HOME: fakeHomeRoot },
        configLoaderImpl: () => {
          throw new AgentOSConfigError('bad config');
        },
        execFileImpl: async () => {
          const err = new Error('not found');
          err.code = 1;
          throw err;
        },
      }),
      fakeHomeAcpx,
    );
  } finally {
    rmSync(fakeOpenclawRoot, { recursive: true, force: true });
    rmSync(fakeHomeRoot, { recursive: true, force: true });
    resetConfigCache();
  }
  await assert.rejects(
    resolveAcpxCliPath({
      env: { ACPX_CLI: 'acpx-typo', HOME: '/no/such/home' },
      configLoaderImpl: () => ({
        get: (_key, defaultValue = null) => defaultValue,
      }),
      execFileImpl: async () => {
        const err = new Error('not found');
        err.code = 1;
        throw err;
      },
    }),
    /ACPX CLI not found at ACPX_CLI=acpx-typo.*Install ACPX or set ACPX_CLI/s,
  );
});

test('acpx OAuth probe reports CLI and MCP OAuth failures distinctly', async () => {
  await assert.rejects(
    assertCodexOAuthLayers({
      env: {},
      acpxCli: '/opt/acpx/bin/acpx',
      execFileImpl: async (command, args) => {
        assert.equal(command, '/opt/acpx/bin/acpx');
        assert.deepEqual(args, ['codex', 'sessions', 'list']);
        const err = new Error('auth.json missing');
        err.stderr = 'auth.json missing';
        throw err;
      },
    }),
    (err) => err.layer === 'cli' && /auth\.json/.test(err.message),
  );

  await assert.rejects(
    assertCodexOAuthLayers({
      env: {},
      acpxCli: '/opt/acpx/bin/acpx',
      domainConfig: { mcpServers: ['linear'] },
      execFileImpl: async (_command, args) => {
        if (args[1] === 'sessions') return { stdout: '[]\n', stderr: '' };
        const err = new Error('rmcp::transport::worker TokenRefreshFailed');
        err.stderr = 'rmcp::transport::worker TokenRefreshFailed';
        throw err;
      },
    }),
    (err) => err.layer === 'mcp' && /per-MCP-server OAuth token refresh failed/.test(err.message),
  );

  let calls = 0;
  await assertCodexOAuthLayers({
    env: {},
    domainConfig: { mcpServers: ['github'] },
    execFileImpl: async () => {
      calls += 1;
      return { stdout: 'ok\n', stderr: '' };
    },
  });
  assert.equal(calls, 2);
  assert.equal(domainRequiresMcpOAuth({ codexMcpServers: ['autok'] }), true);
  assert.equal(domainRequiresMcpOAuth({ mcpServers: ['github'] }), true);
});

test('acpx spawnReviewer reports missing binary with install guidance', async () => {
  const rootDir = makeRoot();
  try {
    const adapter = createAcpxReviewerRuntimeAdapter({
      rootDir,
      domainConfig: { id: 'acpx-smoke' },
      resolveAcpxCliImpl: async () => {
        throw new Error('ACPX CLI not found. Install ACPX or set ACPX_CLI');
      },
      execFileImpl: async () => {
        throw new Error('OAuth probe should not run without acpx');
      },
      spawnCapturedImpl: async () => {
        throw new Error('spawn should not run without acpx');
      },
      now: () => '2026-05-11T20:00:00.000Z',
    });

    const result = await adapter.spawnReviewer({
      model: 'codex',
      prompt: 'review',
      subjectContext: { domainId: 'acpx-smoke', repo: 'lacey/repo', prNumber: 9 },
      timeoutMs: 100,
      sessionUuid: 'acpx-missing-binary-session',
      forbiddenFallbacks: ['api-key'],
    });

    assert.equal(result.ok, false);
    assert.equal(result.failureClass, 'bug');
    assert.match(result.stderrTail, /ACPX CLI not found/);
    assert.match(result.stderrTail, /Install ACPX or set ACPX_CLI/);
    assert.equal(readReviewerRunRecord(rootDir, 'acpx-missing-binary-session').state, 'failed');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('acpx spawnReviewer fails when ACPX exits 0 without a review body', async () => {
  const rootDir = makeRoot();
  try {
    const cases = [
      { name: 'missing', content: null },
      { name: 'empty', content: '' },
      { name: 'whitespace', content: ' \n\t ' },
    ];

    for (const [index, fixture] of cases.entries()) {
      const adapter = createAcpxReviewerRuntimeAdapter({
        rootDir,
        domainConfig: { id: 'acpx-smoke' },
        resolveAcpxCliImpl: async () => '/opt/acpx/bin/acpx',
        execFileImpl: async () => ({ stdout: '[]\n', stderr: '' }),
        spawnCapturedImpl: async (_command, args, options) => {
          options.onSpawn({ pgid: 6363 + index });
          const outputPath = args[args.indexOf('--output-last-message') + 1];
          if (fixture.content !== null) writeFileSync(outputPath, fixture.content);
          return { stdout: 'ok\n', stderr: `${fixture.name} last message\n` };
        },
        now: () => '2026-05-11T20:00:00.000Z',
      });

      const sessionUuid = `acpx-empty-output-${fixture.name}-session`;
      const result = await adapter.spawnReviewer({
        model: 'codex',
        prompt: 'review',
        subjectContext: { domainId: 'acpx-smoke', repo: 'lacey/repo', prNumber: 10 },
        timeoutMs: 100,
        sessionUuid,
        forbiddenFallbacks: ['api-key'],
      });

      assert.equal(result.ok, false);
      assert.equal(result.failureClass, 'bug');
      assert.match(result.stderrTail, /produced no review body/i);
      assert.equal(readReviewerRunRecord(rootDir, sessionUuid).state, 'failed');
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('acpx spawnReviewer releases the active claim when tmpdir allocation throws', async () => {
  const rootDir = makeRoot();
  let attempts = 0;
  try {
    const adapter = createAcpxReviewerRuntimeAdapter({
      rootDir,
      domainConfig: { id: 'acpx-smoke' },
      resolveAcpxCliImpl: async () => '/opt/acpx/bin/acpx',
      mkdtempImpl: () => {
        attempts += 1;
        throw new Error('disk full');
      },
      execFileImpl: async () => {
        throw new Error('OAuth probe should not run after mkdtemp failure');
      },
      spawnCapturedImpl: async () => {
        throw new Error('spawn should not run after mkdtemp failure');
      },
      now: () => '2026-05-11T20:00:00.000Z',
    });

    const req = {
      model: 'codex',
      prompt: 'review',
      subjectContext: { domainId: 'acpx-smoke', repo: 'lacey/repo', prNumber: 11 },
      timeoutMs: 100,
      sessionUuid: 'acpx-mkdtemp-failure-session',
      forbiddenFallbacks: ['api-key'],
    };
    const first = await adapter.spawnReviewer(req);
    const second = await adapter.spawnReviewer(req);

    assert.equal(first.ok, false);
    assert.equal(first.failureClass, 'unknown');
    assert.equal(second.ok, false);
    assert.equal(second.failureClass, 'bug');
    assert.equal(attempts, 1);
    assert.equal(adapter.__activeRuns.has(req.sessionUuid), false);
    assert.equal(readReviewerRunRecord(rootDir, req.sessionUuid).state, 'failed');
    assert.match(second.stderrTail, /terminal state failed/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('acpx spawnReviewer maps OAuth probe failures to oauth-broken with layer-specific text', async () => {
  const rootDir = makeRoot();
  try {
    const cliAdapter = createAcpxReviewerRuntimeAdapter({
      rootDir,
      domainConfig: { id: 'acpx-smoke' },
      resolveAcpxCliImpl: async () => '/opt/acpx/bin/acpx',
      execFileImpl: async () => {
        const err = new Error('auth.json missing');
        err.stderr = 'auth.json missing';
        throw err;
      },
      spawnCapturedImpl: async () => {
        throw new Error('spawn should not run after failed CLI OAuth probe');
      },
      now: () => '2026-05-11T20:00:00.000Z',
    });
    const cliResult = await cliAdapter.spawnReviewer({
      model: 'codex',
      prompt: 'review',
      subjectContext: { domainId: 'acpx-smoke', repo: 'lacey/repo', prNumber: 12 },
      timeoutMs: 100,
      sessionUuid: 'acpx-oauth-cli-session',
      forbiddenFallbacks: ['api-key'],
    });
    assert.equal(cliResult.ok, false);
    assert.equal(cliResult.failureClass, 'oauth-broken');
    assert.match(cliResult.stderrTail, /codex cli OAuth unavailable/i);
    assert.match(cliResult.stderrTail, /auth\.json/);

    const mcpAdapter = createAcpxReviewerRuntimeAdapter({
      rootDir,
      domainConfig: { id: 'acpx-smoke', mcpServers: ['linear'] },
      resolveAcpxCliImpl: async () => '/opt/acpx/bin/acpx',
      execFileImpl: async (_command, args) => {
        if (args[1] === 'sessions') return { stdout: '[]\n', stderr: '' };
        const err = new Error('rmcp::transport::worker TokenRefreshFailed');
        err.stderr = 'rmcp::transport::worker TokenRefreshFailed';
        throw err;
      },
      spawnCapturedImpl: async () => {
        throw new Error('spawn should not run after failed MCP OAuth probe');
      },
      now: () => '2026-05-11T20:00:00.000Z',
    });
    const mcpResult = await mcpAdapter.spawnReviewer({
      model: 'codex',
      prompt: 'review',
      subjectContext: { domainId: 'acpx-smoke', repo: 'lacey/repo', prNumber: 13 },
      timeoutMs: 100,
      sessionUuid: 'acpx-oauth-mcp-session',
      forbiddenFallbacks: ['api-key'],
    });
    assert.equal(mcpResult.ok, false);
    assert.equal(mcpResult.failureClass, 'oauth-broken');
    assert.match(mcpResult.stderrTail, /codex mcp OAuth unavailable/i);
    assert.match(mcpResult.stderrTail, /per-MCP-server OAuth token refresh failed/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('acpx remediator records enrich subjectContext consistently with reviewer records', async () => {
  const rootDir = makeRoot();
  try {
    const adapter = createAcpxReviewerRuntimeAdapter({
      rootDir,
      domainConfig: { id: 'acpx-smoke' },
      resolveAcpxCliImpl: async () => '/opt/acpx/bin/acpx',
      execFileImpl: async () => ({ stdout: '[]\n', stderr: '' }),
      spawnCapturedImpl: async (_command, args, options) => {
        options.onSpawn({ pgid: 6464 });
        writeFileSync(args[4], 'patched remediation\n', 'utf8');
        return { stdout: 'ok\n', stderr: '' };
      },
      now: () => '2026-05-11T20:00:00.000Z',
    });

    const result = await adapter.spawnRemediator({
      model: 'codex',
      prompt: 'fix it',
      subjectContext: { repo: 'lacey/repo', prNumber: 14 },
      timeoutMs: 100,
      sessionUuid: 'acpx-remediator-session',
      forbiddenFallbacks: ['api-key'],
    });

    assert.equal(result.ok, true);
    const record = readReviewerRunRecord(rootDir, 'acpx-remediator-session');
    assert.equal(record.subjectContext.domainId, 'acpx-smoke');
    assert.equal(record.subjectContext.reviewerSessionUuid, 'acpx-remediator-session');
    assert.equal(record.subjectContext.sessionUuid, 'acpx-remediator-session');
    assert.equal(record.subjectContext.model, 'codex');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('acpx spawnReviewer rejects non-integer pgids as isolation failures', async () => {
  const rootDir = makeRoot();
  try {
    const adapter = createAcpxReviewerRuntimeAdapter({
      rootDir,
      domainConfig: { id: 'acpx-smoke' },
      resolveAcpxCliImpl: async () => '/opt/acpx/bin/acpx',
      execFileImpl: async () => ({ stdout: '[]\n', stderr: '' }),
      spawnCapturedImpl: async (_command, _args, options) => {
        options.onSpawn({ pgid: null });
        return { stdout: 'ok\n', stderr: '' };
      },
      now: () => '2026-05-11T20:00:00.000Z',
    });

    const result = await adapter.spawnReviewer({
      model: 'codex',
      prompt: 'review',
      subjectContext: { domainId: 'acpx-smoke', repo: 'lacey/repo', prNumber: 15 },
      timeoutMs: 100,
      sessionUuid: 'acpx-invalid-pgid-session',
      forbiddenFallbacks: ['api-key'],
    });

    assert.equal(result.ok, false);
    assert.equal(result.failureClass, 'unknown');
    assert.match(result.stderrTail, /invalid pgid/i);
    assert.equal(readReviewerRunRecord(rootDir, 'acpx-invalid-pgid-session').state, 'failed');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('acpx failure classification adds queue and zombie-process handling', () => {
  assert.equal(classifyAcpxFailure('acpx queue full', 1, null), 'queue-back-pressure');
  assert.equal(classifyAcpxFailure('acpx zombie codex-acp processes detected', 1, null), 'queue-back-pressure');
  assert.equal(classifyAcpxFailure('LiteLLM retry pool: all upstream attempts failed', 1, null), 'cascade');
  assert.deepEqual(
    buildAcpxCodexArgs('hello', '/tmp/out.txt'),
    ['codex', 'exec', '--ephemeral', '--output-last-message', '/tmp/out.txt', 'hello'],
  );
});

test('cancelled reviewer run records remain recoverable on next startup', () => {
  const rootDir = makeRoot();
  try {
    writeReviewerRunRecord(rootDir, {
      sessionUuid: 'cancelled-session',
      domain: 'code-pr',
      runtime: 'cli-direct',
      state: 'cancelled',
      pgid: 7070,
      spawnedAt: '2026-05-11T20:00:00.000Z',
      lastHeartbeatAt: '2026-05-11T20:00:30.000Z',
      reattachToken: 'cancelled-session',
    });

    const recoverable = readRecoverableReviewerRunRecords(rootDir);
    assert.equal(recoverable.length, 1);
    assert.equal(recoverable[0].state, 'cancelled');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('settleReviewerRunRecord marks active runs terminal for steady-state recovery cleanup', () => {
  const rootDir = makeRoot();
  try {
    writeReviewerRunRecord(rootDir, {
      sessionUuid: 'settle-session',
      domain: 'code-pr',
      runtime: 'cli-direct',
      state: 'heartbeating',
      pgid: 6060,
      spawnedAt: '2026-05-11T20:00:00.000Z',
      lastHeartbeatAt: '2026-05-11T20:00:30.000Z',
      reattachToken: 'settle-session',
    });

    const settled = settleReviewerRunRecord(rootDir, 'settle-session', {
      state: 'failed',
      settledAt: '2026-05-11T20:01:00.000Z',
    });

    assert.equal(settled.state, 'failed');
    assert.equal(settled.lastHeartbeatAt, '2026-05-11T20:01:00.000Z');
    assert.equal(readRecoverableReviewerRunRecords(rootDir).length, 0);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('bounce recovery adopts active run records and preserves reviewing claims', async () => {
  const rootDir = makeRoot();
  const db = new Database(':memory:');
  ensureReviewStateSchema(db);
  db.prepare(
    `INSERT INTO reviewed_prs
       (repo, pr_number, reviewed_at, reviewer, pr_state, review_status,
        reviewer_session_uuid, reviewer_started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'lacey/repo',
    4,
    '2026-05-11T19:59:00.000Z',
    'codex',
    'open',
    'reviewing',
    'bounce-session',
    '2026-05-11T20:00:00.000Z',
  );
  try {
    const adapter = createCliDirectReviewerRuntimeAdapter({
      rootDir,
      processKillImpl: (pid, signal) => {
        if (pid === -6060 && signal === 0) return true;
        return process.kill(pid, signal);
      },
      execFileImpl: async () => ({ stdout: `${new Date('2026-05-11T20:00:00.000Z').toString()}\n` }),
    });
    writeReviewerRunRecord(rootDir, {
      sessionUuid: 'bounce-session',
      domain: 'code-pr',
      runtime: 'cli-direct',
      state: 'heartbeating',
      pgid: 6060,
      spawnedAt: '2026-05-11T20:00:00.000Z',
      lastHeartbeatAt: '2026-05-11T20:00:30.000Z',
      reattachToken: 'bounce-session',
    });
    const before = db.prepare('SELECT review_status FROM reviewed_prs WHERE reviewer_session_uuid = ?').get('bounce-session');
    assert.equal(before.review_status, 'reviewing');

    const recovered = await recoverReviewerRunRecords({
      rootDir,
      adapter,
      db,
      log: { log() {} },
      now: new Date('2026-05-11T20:01:00.000Z'),
    });
    assert.deepEqual(recovered, { recovered: 0, pruned: 0 });
    const row = db.prepare('SELECT review_status, failure_message FROM reviewed_prs WHERE reviewer_session_uuid = ?').get('bounce-session');
    assert.equal(row.review_status, 'reviewing');
    assert.equal(row.failure_message, null);
    const record = readReviewerRunRecord(rootDir, 'bounce-session');
    assert.equal(record.state, 'heartbeating');
    assert.equal(record.adoptedAfterBounce, true);
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('bounce recovery counts only rows it actually requeued', async () => {
  const rootDir = makeRoot();
  const db = new Database(':memory:');
  ensureReviewStateSchema(db);
  try {
    const adapter = createCliDirectReviewerRuntimeAdapter({ rootDir });
    writeReviewerRunRecord(rootDir, {
      sessionUuid: 'posted-session',
      domain: 'code-pr',
      runtime: 'cli-direct',
      state: 'heartbeating',
      pgid: 6060,
      spawnedAt: '2026-05-11T20:00:00.000Z',
      lastHeartbeatAt: '2026-05-11T20:00:30.000Z',
      reattachToken: 'posted-session',
    });

    const recovered = await recoverReviewerRunRecords({
      rootDir,
      adapter,
      db,
      log: { log() {} },
      now: new Date('2026-05-11T20:01:00.000Z'),
    });
    assert.deepEqual(recovered, { recovered: 0, pruned: 0 });
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('bounce recovery routes reattach through the adapter recorded on each run', async () => {
  const rootDir = makeRoot();
  try {
    writeReviewerRunRecord(rootDir, {
      sessionUuid: 'cli-session',
      domain: 'code-pr',
      runtime: 'cli-direct',
      state: 'heartbeating',
      spawnedAt: '2026-05-11T20:00:00.000Z',
      reattachToken: 'cli-session',
    });
    writeReviewerRunRecord(rootDir, {
      sessionUuid: 'hq-session',
      domain: 'code-pr',
      runtime: 'agent-os-hq',
      state: 'heartbeating',
      spawnedAt: '2026-05-11T20:00:00.000Z',
      reattachToken: 'hq-session',
    });
    const reattached = [];
    const adapters = new Map([
      ['cli-direct', {
        reattach: async (record) => {
          reattached.push(['cli-direct', record.sessionUuid]);
          return {};
        },
      }],
      ['agent-os-hq', {
        reattach: async (record) => {
          reattached.push(['agent-os-hq', record.sessionUuid]);
          return {};
        },
      }],
    ]);

    const recovered = await recoverReviewerRunRecords({
      rootDir,
      adapter: adapters.get('cli-direct'),
      adapterForRecord: (record) => adapters.get(record.runtime),
      log: { log() {} },
      now: new Date('2026-05-11T20:01:00.000Z'),
    });

    assert.deepEqual(recovered, { recovered: 0, pruned: 0 });
    assert.deepEqual(reattached.sort(), [
      ['agent-os-hq', 'hq-session'],
      ['cli-direct', 'cli-session'],
    ]);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('bounce recovery isolates per-record adapter resolution and reattach failures', async () => {
  const rootDir = makeRoot();
  try {
    writeReviewerRunRecord(rootDir, {
      sessionUuid: 'good-session',
      domain: 'code-pr',
      runtime: 'cli-direct',
      state: 'heartbeating',
      spawnedAt: '2026-05-11T20:00:00.000Z',
      reattachToken: 'good-session',
    });
    writeReviewerRunRecord(rootDir, {
      sessionUuid: 'bad-session',
      domain: 'code-pr',
      runtime: 'removed-runtime',
      state: 'heartbeating',
      spawnedAt: '2026-05-11T20:00:00.000Z',
      reattachToken: 'bad-session',
    });
    writeReviewerRunRecord(rootDir, {
      sessionUuid: 'throw-session',
      domain: 'code-pr',
      runtime: 'cli-direct',
      state: 'heartbeating',
      spawnedAt: '2026-05-11T20:00:00.000Z',
      reattachToken: 'throw-session',
    });
    const reattached = [];
    const errors = [];

    const recovered = await recoverReviewerRunRecords({
      rootDir,
      adapter: {
        reattach: async (record) => {
          reattached.push(record.sessionUuid);
          return {};
        },
      },
      adapterForRecord: (record) => {
        if (record.sessionUuid === 'bad-session') {
          throw new Error('unknown stored runtime');
        }
        if (record.sessionUuid === 'throw-session') {
          return {
            reattach: async () => {
              throw new Error('reattach failed');
            },
          };
        }
        return {
          reattach: async (reattachRecord) => {
            reattached.push(reattachRecord.sessionUuid);
            return {};
          },
        };
      },
      log: {
        log() {},
        error(message) {
          errors.push(String(message));
        },
      },
      now: new Date('2026-05-11T20:01:00.000Z'),
    });

    assert.deepEqual(recovered, { recovered: 0, pruned: 0 });
    assert.deepEqual(reattached, ['good-session']);
    assert.equal(errors.length, 2);
    assert.ok(errors.some((message) => /bad-session/.test(message) && /unknown stored runtime/.test(message)));
    assert.ok(errors.some((message) => /throw-session/.test(message) && /reattach failed/.test(message)));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('bounce recovery requeues reviewing rows for cancelled reviewer run records', async () => {
  const rootDir = makeRoot();
  const db = new Database(':memory:');
  ensureReviewStateSchema(db);
  db.prepare(
    `INSERT INTO reviewed_prs
       (repo, pr_number, reviewed_at, reviewer, pr_state, review_status,
        reviewer_session_uuid, reviewer_started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'lacey/repo',
    5,
    '2026-05-11T19:59:00.000Z',
    'codex',
    'open',
    'reviewing',
    'cancelled-recovery-session',
    '2026-05-11T20:00:00.000Z',
  );
  try {
    const adapter = createCliDirectReviewerRuntimeAdapter({ rootDir });
    writeReviewerRunRecord(rootDir, {
      sessionUuid: 'cancelled-recovery-session',
      domain: 'code-pr',
      runtime: 'cli-direct',
      state: 'cancelled',
      pgid: 6061,
      spawnedAt: '2026-05-11T20:00:00.000Z',
      lastHeartbeatAt: '2026-05-11T20:00:30.000Z',
      reattachToken: 'cancelled-recovery-session',
    });

    const recovered = await recoverReviewerRunRecords({
      rootDir,
      adapter,
      db,
      log: { log() {} },
      now: new Date('2026-05-11T20:01:00.000Z'),
      leaseRecoveryEnabled: true,
    });
    assert.deepEqual(recovered, { recovered: 1, pruned: 0 });
    const row = db.prepare('SELECT review_status, review_attempts, failure_message FROM reviewed_prs WHERE reviewer_session_uuid = ?').get('cancelled-recovery-session');
    assert.equal(row.review_status, 'pending');
    assert.equal(row.review_attempts, 1);
    assert.match(row.failure_message, /daemon-bounce/);
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('bounce recovery prunes old terminal run-state files on startup', async () => {
  const rootDir = makeRoot();
  const db = new Database(':memory:');
  ensureReviewStateSchema(db);
  try {
    const adapter = createCliDirectReviewerRuntimeAdapter({ rootDir });
    writeReviewerRunRecord(rootDir, {
      sessionUuid: 'old-terminal-session',
      domain: 'code-pr',
      runtime: 'cli-direct',
      state: 'failed',
      pgid: 6060,
      spawnedAt: '2026-05-09T20:00:00.000Z',
      lastHeartbeatAt: '2026-05-09T20:00:30.000Z',
      reattachToken: 'old-terminal-session',
    });

    const recovered = await recoverReviewerRunRecords({
      rootDir,
      adapter,
      db,
      log: { log() {} },
      now: new Date('2026-05-11T20:01:00.000Z'),
    });
    assert.deepEqual(recovered, { recovered: 0, pruned: 1 });
    assert.equal(existsSync(reviewerRunStatePath(rootDir, 'old-terminal-session')), false);
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
