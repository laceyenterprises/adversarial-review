import './helpers/review-cli-resolver-fixture.mjs';
// EFFORTTUNE-02: the codex reviewer defaults to medium reasoning effort; the
// Claude and Gemini reviewer defaults do not move. The review execution record
// carries the effective effort and where it came from, so review outcomes can
// be compared by effort.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { serviceFixtureExec, writeDummyCodexAuth } from './helpers/codex-service-fixture.mjs';
import { dispatchReadTransport } from '../src/dispatch-read-client.mjs';
import {
  ensureWorkerRegistryReady, readCommittedWorkerModelSeed, resolveRemediationModel,
} from '../src/adapters/agent-runtime/local/remediation.mjs';
import { CODEX_REVIEWER_DEFAULT_EFFORT, codexOAuthRequestBody } from '../src/codex-oauth-responses.mjs';
import { __test__ as harness, resolveReviewerExecution } from '../src/reviewer-harness.mjs';

const seed = readCommittedWorkerModelSeed();
const review = '## Summary\nSynthetic change reviewed.\n\n## Verdict\nComment only';
const quiet = { info() {}, log() {}, warn() {}, error() {} };

function registry(t, name, data) {
  const env = { APP_CONTRACT_ENDPOINT_URL: `https://example.invalid/efforttune-${name}` };
  t.mock.method(dispatchReadTransport, 'sdk', () => ({
    async connect() { return { sessionToken: 'synthetic-session' }; },
    async readSessionHostServices(request) {
      assert.equal(request.action, 'worker_registry');
      if (data instanceof Error) throw data;
      return { schema_version: 1, status: 'found', data };
    },
    readHostServicesSync() { assert.fail('model selection must not invoke the sync transport'); },
  }));
  return { env };
}

function withProcessEnv(t, overrides) {
  const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test('packaged seed: codex reviewer defaults to medium; Claude and Gemini reviewer defaults are unchanged', () => {
  assert.equal(CODEX_REVIEWER_DEFAULT_EFFORT, 'medium');
  assert.deepEqual(seed.classes['codex-reviewer'], {
    defaultModel: 'gpt-6-sol', allowedModels: ['gpt-6-sol', 'gpt-6.1-sol', 'gpt-6-luna'],
    defaultReasoningLevel: 'medium',
  });
  assert.deepEqual(seed.classes['claude-reviewer'], {
    defaultModel: 'claude-opus-5-5', allowedModels: ['claude-opus-5-5'], defaultReasoningLevel: 'high',
  });
  assert.deepEqual(seed.classes['gemini-reviewer'], {
    defaultModel: 'gemini-2.5-pro', allowedModels: ['gemini-2.5-pro', 'gemini-2.5-flash'],
  });
  // Remediators are not reviewers; their effort stays where it was.
  assert.equal(seed.classes['remediator-codex'].defaultReasoningLevel, 'high');
  assert.equal(seed.classes['remediator-claude'].defaultReasoningLevel, 'high');
});

test('registry outage: codex reviewer resolves medium, Claude and Gemini resolve their unchanged seed effort', async t => {
  const f = registry(t, 'outage', new Error('synthetic outage'));
  assert.equal(await ensureWorkerRegistryReady({ env: f.env }), false);
  assert.deepEqual(resolveReviewerExecution('codex', { env: f.env, log: quiet }), {
    model: 'gpt-6-sol', effort: 'medium', modelSource: 'committed-seed', effortSource: 'committed-seed',
  });
  assert.deepEqual(resolveReviewerExecution('claude', { env: f.env, log: quiet }), {
    model: 'claude-opus-5-5', effort: 'high', modelSource: 'committed-seed', effortSource: 'committed-seed',
  });
  assert.deepEqual(resolveReviewerExecution('gemini', { env: f.env, log: quiet }), {
    model: 'gemini-2.5-pro', effort: null, modelSource: 'committed-seed', effortSource: 'none',
  });
});

test('a governed registry level and an explicit pin still take precedence over the codex seed default', async t => {
  const f = registry(t, 'governed', { classes: {
    'codex-reviewer': { defaultModel: 'gpt-6-sol', allowedModels: ['gpt-6-sol'], defaultReasoningLevel: 'xhigh' },
  } });
  assert.equal(await ensureWorkerRegistryReady({ env: f.env }), true);
  const governed = resolveRemediationModel('codex-reviewer', { env: f.env, log: quiet });
  assert.equal(governed.resolvedReasoningLevel, 'xhigh');
  assert.equal(governed.reasoningSource, 'registry');
  const pinned = resolveRemediationModel('codex-reviewer', { env: f.env, reasoningPin: 'low', log: quiet });
  assert.equal(pinned.resolvedReasoningLevel, 'low');
  assert.equal(pinned.reasoningSource, 'env');
});

test('OAuth Responses transport defaults the codex reviewer to medium effort', () => {
  assert.deepEqual(codexOAuthRequestBody({ prompt: 'review', model: 'gpt-6-sol' }).reasoning,
    { effort: 'medium', summary: 'auto' });
});

for (const recovery of [false, true]) {
  test(`codex review execution records effective effort and its source (OAuth recovery=${recovery})`, async t => {
    const f = registry(t, `codex-${recovery}`, new Error('synthetic outage'));
    const authRoot = mkdtempSync(join(tmpdir(), 'efforttune-auth-'));
    t.after(() => rmSync(authRoot, { recursive: true, force: true }));
    withProcessEnv(t, { ...f.env, AGENT_OS_CODEX_PER_WORKER_AUTH: '0', CODEX_BROKER_PROVIDER: 'codex',
      CODEX_REVIEWER_AUTH_PROVIDER: '', CODEX_HOME: '', CODEX_AUTH_PATH: writeDummyCodexAuth(join(authRoot, 'auth.json')) });
    assert.equal(await ensureWorkerRegistryReady(), false);
    let sentEffort = null;
    const result = await harness.reviewWithCodex('+synthetic diff', '', {
      log: quiet, codexCli: process.execPath, assertCodexOAuthImpl: async () => {},
      execFileSyncImpl: serviceFixtureExec,
      spawnCodexReviewImpl: async ({ configOverrides }) => {
        sentEffort = configOverrides.find(item => item.key === 'model_reasoning_effort')?.value;
        if (recovery) throw Object.assign(new Error('synthetic no progress'), { progressTimedOut: true });
        return { stdout: review, stderr: '' };
      },
      reviewWithCodexOAuthResponsesImpl: async (_prompt, { reasoningEffort }) => {
        sentEffort = reasoningEffort;
        return { reviewText: review, tokenUsage: null };
      },
    });
    assert.equal(sentEffort, 'medium');
    assert.equal(result.execution.effort, 'medium');
    assert.equal(result.execution.effortSource, 'committed-seed');
  });
}

test('OAuth recovery without resolved effort records the medium transport default and its source', async t => {
  const f = registry(t, 'codex-transport-default', { classes: {
    'codex-reviewer': { defaultModel: 'gpt-6-sol', allowedModels: ['gpt-6-sol'] },
  } });
  const authRoot = mkdtempSync(join(tmpdir(), 'efforttune-auth-'));
  t.after(() => rmSync(authRoot, { recursive: true, force: true }));
  withProcessEnv(t, { ...f.env, AGENT_OS_CODEX_PER_WORKER_AUTH: '0', CODEX_BROKER_PROVIDER: 'codex',
    CODEX_REVIEWER_AUTH_PROVIDER: '', CODEX_HOME: '', CODEX_AUTH_PATH: writeDummyCodexAuth(join(authRoot, 'auth.json')) });
  assert.equal(await ensureWorkerRegistryReady(), true);
  assert.equal(harness.resolveCodexExecOverrides({ log: quiet }).reasoningEffort, null);
  let recoveryCalls = 0;
  const result = await harness.reviewWithCodex('+synthetic diff', '', {
    log: quiet, codexCli: process.execPath, assertCodexOAuthImpl: async () => {},
    execFileSyncImpl: serviceFixtureExec,
    spawnCodexReviewImpl: async ({ configOverrides }) => {
      assert.equal(configOverrides.some(item => item.key === 'model_reasoning_effort'), false);
      throw Object.assign(new Error('synthetic no progress'), { progressTimedOut: true });
    },
    reviewWithCodexOAuthResponsesImpl: async (_prompt, { reasoningEffort }) => {
      recoveryCalls += 1;
      assert.equal(reasoningEffort, 'medium');
      return { reviewText: review, tokenUsage: null };
    },
  });
  assert.equal(recoveryCalls, 1);
  assert.equal(result.execution.effort, 'medium');
  assert.equal(result.execution.effortSource, 'transport-default');
});

test('Claude review execution records its unchanged effort and its source', async t => {
  const f = registry(t, 'claude', new Error('synthetic outage'));
  withProcessEnv(t, f.env);
  assert.equal(await ensureWorkerRegistryReady(), false);
  let sentEffort = null;
  const result = await harness.reviewWithClaude('+synthetic diff', '', {
    logger: quiet, platform: 'linux',
    assertClaudeOAuthImpl: async () => ({ env: {}, transport: 'keychain' }),
    spawnClaudeImpl: async args => {
      sentEffort = args[args.indexOf('--effort') + 1];
      return { stdout: JSON.stringify({ result: review, usage: {} }), stderr: '' };
    },
  });
  assert.equal(sentEffort, 'high');
  assert.equal(result.execution.effort, 'high');
  assert.equal(result.execution.effortSource, 'committed-seed');
});
