import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  createAgentOsHqReviewerRuntimeAdapter,
  createReviewerRuntimeAdapterForDomain,
  recoverReviewerRunRecords,
  resolveReviewerRuntimeName,
} from '../src/adapters/reviewer-runtime/index.mjs';
import { createCliDirectReviewerRuntimeAdapter } from '../src/adapters/reviewer-runtime/cli-direct/index.mjs';
import { resolveCliBinary } from '../src/adapters/reviewer-runtime/cli-direct/discovery.mjs';
import {
  readActiveReviewerRunRecords,
  readRecoverableReviewerRunRecords,
  readReviewerRunRecord,
  reviewerRunSideChannelPaths,
  reviewerRunStatePath,
  writeReviewerRunRecord,
} from '../src/adapters/reviewer-runtime/run-state.mjs';
import { ensureReviewStateSchema } from '../src/review-state.mjs';

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
      timeoutMs: 100,
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

test('cli-direct reattach waits on an alive reviewer pgid and reads side-channel output', async () => {
  const rootDir = makeRoot();
  const reviewerPath = join(rootDir, 'fixture-reviewer.mjs');
  writeFileSync(
    reviewerPath,
    [
      'console.log("fixture stdout start");',
      'console.error("fixture stderr start");',
      'setTimeout(() => {',
      '  console.log("fixture stdout done");',
      '  console.error("fixture stderr done");',
      '}, 150);',
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

    const restartedAdapter = createCliDirectReviewerRuntimeAdapter({
      rootDir,
      preflightImpl: noopPreflight,
      reattachPollIntervalMs: 10,
      now: () => '2026-05-11T20:00:01.000Z',
    });
    const reattached = await restartedAdapter.reattach(record);
    const original = await run;

    assert.equal(reattached.ok, true);
    assert.match(reattached.stdoutTail, /fixture stdout done/);
    assert.match(reattached.stderrTail, /fixture stderr done/);
    assert.equal(original.ok, true);
    const finalRecord = readReviewerRunRecord(rootDir, 'alive-reattach-session');
    assert.equal(finalRecord.state, 'completed');
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

test('bounce recovery reattaches active run records and requeues reviewing rows', async () => {
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
    const adapter = createCliDirectReviewerRuntimeAdapter({ rootDir });
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
    assert.deepEqual(recovered, { recovered: 1, pruned: 0 });
    const row = db.prepare('SELECT review_status, failure_message FROM reviewed_prs WHERE reviewer_session_uuid = ?').get('bounce-session');
    assert.equal(row.review_status, 'failed');
    assert.match(row.failure_message, /daemon-bounce/);
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
    });
    assert.deepEqual(recovered, { recovered: 1, pruned: 0 });
    const row = db.prepare('SELECT review_status, failure_message FROM reviewed_prs WHERE reviewer_session_uuid = ?').get('cancelled-recovery-session');
    assert.equal(row.review_status, 'failed');
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
