import './helpers/review-cli-resolver-fixture.mjs';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serviceFixtureExec, writeDummyCodexAuth } from './helpers/codex-service-fixture.mjs';
import { createRemediationRuntime } from '../src/follow-up-remediation.mjs';
import assert from 'node:assert/strict';
import { dispatchReadTransport } from '../src/dispatch-read-client.mjs';
import { ensureWorkerRegistryReady, hasRemediationEnvironmentPin, resolveRemediationModel } from '../src/adapters/agent-runtime/local/remediation.mjs';
import { resolveReviewerExecutionAsync, reviewAgyOversizedInChunks, __test__ as harness } from '../src/reviewer-harness.mjs';
import { resolveLocalRemediationMes } from '../src/mes-shadow-hook.mjs';

const quiet = { info() {}, warn() {}, error() {} };
const head = 'a'.repeat(40);
async function fixture(t) {
  const env = { APP_CONTRACT_ENDPOINT_URL: `https://example.invalid/mes-${t.name.replaceAll(' ', '-')}` };
  const classes = {};
  for (const role of ['codex-reviewer', 'claude-reviewer', 'remediator-codex', 'remediator-claude']) {
    classes[role] = { defaultModel: 'static-model', defaultReasoningLevel: 'high',
      allowedModels: ['static-model', 'mes-model', 'arm-model', 'env-model'],
      reasoningLevelsByModel: { 'mes-model': ['low', 'medium'], 'static-model': ['high'],
        'arm-model': ['high'], 'env-model': ['high'] } };
  }
  t.mock.method(dispatchReadTransport, 'sdk', () => ({
    async connect(config) { return { sessionToken: 'synthetic', endpoint_url: config.endpoint_url }; },
    async readSessionHostServices() { return { schema_version: 1, status: 'found', data: { classes } }; },
    readHostServicesSync() { assert.fail('must use prefetched registry'); },
  }));
  await ensureWorkerRegistryReady({ env });
  return { env, classes };
}
function cli(choice, { apply = true, error = null, stdout = null, hang = false } = {}) {
  const requests = [];
  return { requests, exec(file, args, options, callback) {
    requests.push(JSON.parse(args.at(-1)));
    if (!hang) queueMicrotask(() => callback(error, stdout ?? JSON.stringify({ schemaVersion: 1,
      decisionId: 'mesd_synthetic', recorded: true, apply, choice, reason: apply ? 'enforce' : 'kill-switch' }), ''));
    return {};
  } };
}
function review(env, fake, args = {}) {
  return resolveReviewerExecutionAsync(args.family || 'codex', { env, log: quiet, ...args,
    mes: { repo: 'example/fixture', prNumber: 1, headSha: head, diff: '+synthetic',
      restrictedPatterns: [], execFileImpl: fake.exec, timeoutMs: 30, ...args.mes } });
}
const pair = (workerClass = 'codex-reviewer', effort = 'medium') => ({ workerClass, model: 'mes-model', effort });

test('precedence: env pins then OSG arm then MES then registry; explicit source is recorded', async t => {
  const { env } = await fixture(t);
  for (const family of ['codex', 'claude']) {
    const fake = cli(pair(`${family}-reviewer`));
    const selected = await review(env, fake, { family });
    assert.deepEqual(selected, { model: 'mes-model', effort: 'medium', modelSource: 'mes', effortSource: 'mes' });
    const arm = await review(env, fake, { family, modelPin: 'arm-model', reasoningPin: 'high', mes: { reviewerArm: true } });
    assert.equal(arm.model, 'arm-model');
    assert.equal(fake.requests.at(-1).actual.source, 'reviewerArm');
    const pinnedEnv = { ...env, [`ADVERSARIAL_REMEDIATION_${family.toUpperCase()}_MODEL`]: 'env-model',
      [`ADVERSARIAL_REMEDIATION_${family.toUpperCase()}_REASONING_LEVEL`]: 'high' };
    const pinned = await review(pinnedEnv, fake, { family, modelPin: 'arm-model', reasoningPin: 'low', mes: { reviewerArm: true } });
    assert.equal(pinned.model, 'env-model');
    assert.equal(pinned.effort, 'high');
    assert.equal(fake.requests.at(-1).actual.source, 'env');
    const effortPin = await review(env, fake, { family, reasoningPin: 'low' });
    assert.equal(effortPin.model, 'static-model');
    assert.equal(effortPin.effort, 'low');
    const disabled = await review(env, cli(pair(`${family}-reviewer`), { apply: false }), { family });
    assert.equal(disabled.model, 'static-model');
    assert.equal(disabled.effort, 'high');
  }
});

test('applied effort reaches Codex config and Claude --effort argv', async t => {
  const { env } = await fixture(t);
  const codex = await review(env, cli(pair()));
  const overrides = harness.resolveCodexExecOverrides({ env, execution: codex, log: quiet });
  const args = harness.buildCodexReviewArgs({ outputPath: '/synthetic/output', prompt: 'synthetic',
    model: overrides.model, configOverrides: overrides.configOverrides });
  assert.equal(args[args.indexOf('--model') + 1], 'mes-model');
  assert.ok(args.includes('model_reasoning_effort="medium"'));
  const claude = await review(env, cli(pair('claude-reviewer', 'low')), { family: 'claude' });
  const claudeArgs = harness.buildClaudeReviewArgs('synthetic', claude);
  assert.equal(claudeArgs[claudeArgs.indexOf('--model') + 1], 'mes-model');
  assert.equal(claudeArgs[claudeArgs.indexOf('--effort') + 1], 'low');
});

test('invalid policy and CLI failures retain the static pair', async t => {
  const { env } = await fixture(t);
  const invalid = [null, {}, pair('remediator-codex'), pair('codex-reviewer-corp'), pair('claude-reviewer'),
    { ...pair(), model: 'unknown' }, pair('codex-reviewer', 'high'), pair('codex-reviewer', 'max'),
    pair('codex-reviewer', 'ultra')];
  const fakes = invalid.map(choice => cli(choice));
  fakes.push(cli(pair(), { stdout: 'garbage' }), cli(pair(), { error: new Error('CLI exit') }),
    cli(pair(), { error: Object.assign(new Error('missing'), { code: 'ENOENT' }) }), cli(pair(), { hang: true }));
  for (const fake of fakes) {
    const execution = await review(env, fake);
    assert.equal(execution.model, 'static-model');
    assert.equal(execution.effort, 'high');
  }
  const cold = resolveRemediationModel('codex-reviewer', { env: {}, log: quiet,
    mesDecision: { recorded: true, decision: { apply: true, choice: pair() } } });
  assert.equal(cold.modelSource, 'committed-seed');
});

test('local remediation decides before launch and preserves explicit request sources', async t => {
  const { env } = await fixture(t);
  const job = { repo: 'example/fixture', prNumber: 2, revisionRef: head, reviewBody: '',
    remediationPlan: { currentRound: 1, maxRounds: 3 } };
  for (const [workerClass, registryClass] of [['codex', 'remediator-codex'], ['claude-code', 'remediator-claude']]) {
    const fake = cli(pair(registryClass));
    const args = { env, job, workerClass, execFileImpl: fake.exec, log: quiet };
    const applied = await resolveLocalRemediationMes(args);
    assert.equal(applied.resolvedModel, 'mes-model');
    assert.equal(applied.resolvedReasoningLevel, 'medium');
    assert.equal(fake.requests.length, 1);
    for (const source of ['osg-remediator', 'non-blocking-config']) {
      const explicit = { resolvedModel: 'arm-model', resolvedReasoningLevel: 'high',
        modelSource: 'env-pin', reasoningSource: 'env', source };
      assert.equal(await resolveLocalRemediationMes({ ...args, modelResolution: explicit }), explicit);
      assert.equal(fake.requests.at(-1).actual.source, source === 'osg-remediator' ? 'osg-apply' : 'env');
    }
    const disabled = await resolveLocalRemediationMes({ ...args, execFileImpl: cli(pair(registryClass), { apply: false }).exec });
    assert.equal(disabled.resolvedModel, 'static-model');
    assert.equal(disabled.resolvedReasoningLevel, 'high');
  }
});


test('full Codex pass retains applied model and effort after OAuth preparation', async t => {
  const { env } = await fixture(t);
  const root = mkdtempSync(join(tmpdir(), 'mes-review-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const previous = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  });
  Object.assign(process.env, env, { AGENT_OS_CODEX_PER_WORKER_AUTH: '0', CODEX_BROKER_PROVIDER: 'codex',
    CODEX_REVIEWER_AUTH_PROVIDER: '', CODEX_HOME: '', CODEX_AUTH_PATH: writeDummyCodexAuth(join(root, 'auth.json')) });
  const fake = cli(pair());
  let sent;
  const result = await harness.reviewWithCodex('+synthetic', '', {
    log: quiet, codexCli: process.execPath, assertCodexOAuthImpl: async () => {}, execFileSyncImpl: serviceFixtureExec,
    mes: { repo: 'example/fixture', prNumber: 3, headSha: head, diff: '+synthetic',
      restrictedPatterns: [], execFileImpl: fake.exec },
    spawnCodexReviewImpl: async ({ model, configOverrides }) => {
      sent = { model, effort: configOverrides.find(item => item.key === 'model_reasoning_effort')?.value };
      return { stdout: '## Summary\nSynthetic.\n\n## Verdict\nComment only', stderr: '' };
    },
  });
  assert.deepEqual(sent, { model: 'mes-model', effort: 'medium' });
  assert.equal(result.execution.modelSource, 'mes');
  assert.equal(fake.requests.length, 1);
});

test('local Claude runtime selects before model auth and spawns the selected pair', async t => {
  const { env } = await fixture(t);
  const root = mkdtempSync(join(tmpdir(), 'mes-remediation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const promptPath = join(root, 'prompt.md');
  writeFileSync(promptPath, 'Synthetic remediation');
  const events = [];
  const fake = cli(pair('remediator-claude', 'low'));
  const runtime = createRemediationRuntime({ env: { ...process.env, ...env },
    mesExecFileImpl: fake.exec, execFileSyncImpl: serviceFixtureExec,
    prepareLocalModelAuth: async resolution => events.push(['auth', resolution.resolvedModel]),
    spawnImpl: (_file, args) => { events.push(['spawn', args]); return { pid: 123, unref() {}, once() {} }; },
  });
  const handle = await runtime.run({ mode: 'local', role: { workerClass: 'claude-code' },
    workspaceDir: root, promptPath, outputPath: join(root, 'output'), logPath: join(root, 'log'),
    replyPath: join(root, 'reply'), mesJob: { repo: 'example/fixture', prNumber: 4, revisionRef: head,
      reviewBody: '', remediationPlan: { currentRound: 1, maxRounds: 3 } } });
  assert.deepEqual(events[0], ['auth', 'mes-model']);
  assert.equal(events[1][0], 'spawn');
  assert.deepEqual(events[1][1].slice(-4), ['--model', 'mes-model', '--effort', 'low']);
  assert.equal(handle.worker.modelSource, 'mes');
  assert.equal(fake.requests.length, 1);
});

test('standalone Claude runtime resolves defaults before auth and preserves explicit pairs', async t => {
  const { env } = await fixture(t);
  const root = mkdtempSync(join(tmpdir(), 'mes-standalone-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const promptPath = join(root, 'prompt.md');
  writeFileSync(promptPath, 'Synthetic remediation');
  const explicit = { resolvedModel: 'arm-model', resolvedReasoningLevel: 'high',
    modelSource: 'env-pin', reasoningSource: 'env', source: 'osg-remediator' };
  for (const [modelResolution, pins, model, effort] of [
    [undefined, {}, 'static-model', 'high'],
    [null, {}, 'static-model', 'high'],
    [undefined, { CLAUDE_REMEDIATION_MODEL: 'env-model', CLAUDE_REMEDIATION_REASONING_LEVEL: 'high' }, 'env-model', 'high'],
    [explicit, {}, 'arm-model', 'high'],
  ]) {
    const events = [];
    let authResolution;
    const runtime = createRemediationRuntime({ env: { ...process.env, ...env, ...pins },
      mesExecFileImpl: () => assert.fail('standalone runtime must not request MES'),
      execFileSyncImpl: serviceFixtureExec,
      prepareLocalModelAuth: async resolution => {
        authResolution = resolution;
        events.push('auth');
      },
      spawnImpl: (_file, args) => {
        events.push('spawn');
        assert.deepEqual(args.slice(-4), ['--model', model, '--effort', effort]);
        return { pid: 123, unref() {}, once() {} };
      },
    });
    const handle = await runtime.run({ mode: 'local', role: { workerClass: 'claude-code' },
      modelResolution, workspaceDir: root, promptPath, outputPath: join(root, 'output'),
      logPath: join(root, 'log'), replyPath: join(root, 'reply') });
    assert.deepEqual(events, ['auth', 'spawn']);
    assert.equal(authResolution?.resolvedModel, model);
    assert.equal(authResolution.resolvedReasoningLevel, effort);
    assert.equal(handle.worker.resolvedModel, model);
    if (modelResolution) assert.equal(authResolution, modelResolution);
  }
});

test('environment pin predicate accepts local aliases and governed class names', () => {
  for (const [aliases, keys] of [
    [['codex', 'codex-reviewer', 'remediator-codex', 'remediator-codex-corp'],
      ['ADVERSARIAL_REMEDIATION_CODEX_MODEL', 'CODEX_REMEDIATION_MODEL', 'CODEX_MODEL_ID',
        'ADVERSARIAL_REMEDIATION_CODEX_REASONING_LEVEL', 'CODEX_REMEDIATION_REASONING_LEVEL']],
    [['claude-code', 'claude-reviewer', 'remediator-claude', 'remediator-claude-corp'],
      ['ADVERSARIAL_REMEDIATION_CLAUDE_MODEL', 'CLAUDE_REMEDIATION_MODEL',
        'ADVERSARIAL_REMEDIATION_CLAUDE_REASONING_LEVEL', 'CLAUDE_REMEDIATION_REASONING_LEVEL',
        'CLAUDE_CODE_REMEDIATION_REASONING_LEVEL']],
  ]) {
    for (const workerClass of aliases) {
      assert.equal(hasRemediationEnvironmentPin(workerClass, {}), false);
      for (const key of keys) {
        assert.equal(hasRemediationEnvironmentPin(workerClass, { [key]: 'selected' }), true, `${workerClass}: ${key}`);
        assert.equal(hasRemediationEnvironmentPin(workerClass, { [key]: '  ' }), false);
      }
    }
  }
  for (const workerClass of ['gemini', 'unknown', undefined]) {
    assert.equal(hasRemediationEnvironmentPin(workerClass, { CODEX_MODEL_ID: 'selected', CLAUDE_REMEDIATION_MODEL: 'selected' }), false);
  }
});


test('Claude review auth and spawn share the MES pair', async t => {
  const { env } = await fixture(t);
  const previous = process.env.APP_CONTRACT_ENDPOINT_URL;
  process.env.APP_CONTRACT_ENDPOINT_URL = env.APP_CONTRACT_ENDPOINT_URL;
  t.after(() => { if (previous === undefined) delete process.env.APP_CONTRACT_ENDPOINT_URL;
    else process.env.APP_CONTRACT_ENDPOINT_URL = previous; });
  const fake = cli(pair('claude-reviewer', 'low'));
  let authModel, argv;
  await harness.reviewWithClaude('+synthetic', '', { logger: quiet, platform: 'linux',
    mes: { repo: 'example/fixture', prNumber: 9, headSha: head, diff: '+synthetic',
      restrictedPatterns: [], execFileImpl: fake.exec },
    assertClaudeOAuthImpl: async options => { authModel = options.model; return { env: {}, transport: 'keychain' }; },
    resolveClaudeLaunchctlUidImpl: async () => null,
    spawnClaudeImpl: async args => { argv = args; return { stdout: JSON.stringify({ type: 'result', result: '## Summary\nSynthetic.\n\n## Verdict\nComment only' }), stderr: '' }; },
  });
  assert.equal(authModel, 'mes-model');
  assert.equal(argv[argv.indexOf('--model') + 1], authModel);
  assert.equal(argv[argv.indexOf('--effort') + 1], 'low');
  assert.equal(fake.requests.length, 1);
});

test('local env pins supersede an OSG pair and malformed registry effort metadata fails open', async t => {
  const { env, classes } = await fixture(t);
  const job = { repo: 'example/fixture', prNumber: 2, reviewBody: '',
    remediationPlan: { currentRound: 1, maxRounds: 3 } };
  const fake = cli(pair('remediator-codex'));
  const execution = await resolveLocalRemediationMes({ env: { ...env, CODEX_MODEL_ID: 'env-model' },
    job, workerClass: 'codex', execFileImpl: fake.exec, log: quiet,
    modelResolution: { resolvedModel: 'arm-model', resolvedReasoningLevel: 'high',
      modelSource: 'env-pin', reasoningSource: 'env', source: 'osg-remediator' } });
  assert.equal(execution.resolvedModel, 'env-model');
  assert.equal(fake.requests[0].actual.source, 'env');
  classes['codex-reviewer'].reasoningLevelsByModel['mes-model'] = 'medium';
  // Refresh under a new endpoint so the fixture is physically reread.
  const next = { ...env, APP_CONTRACT_ENDPOINT_URL: env.APP_CONTRACT_ENDPOINT_URL + '-malformed' };
  await ensureWorkerRegistryReady({ env: next });
  assert.equal((await review(next, cli(pair()))).modelSource, 'registry');
});

test('chunked review decides once and carries the MES pair to every subsequent chunk', async () => {
  const seen = [];
  const mes = { repo: 'example/fixture', prNumber: 1, headSha: head };
  const selected = { model: 'mes-model', effort: 'medium', modelSource: 'mes', effortSource: 'mes' };
  await reviewAgyOversizedInChunks('diff --git a/sample.mjs b/sample.mjs\n--- a/sample.mjs\n+++ b/sample.mjs\n@@ -0,0 +1,9000 @@\n'
    + '+synthetic content\n'.repeat(9000), '', { reviewerModel: 'codex', maxBytes: 70000, env: {}, mes,
    dispatchReviewerModelImpl: async (_family, _diff, _context, options) => {
      seen.push(options);
      return { reviewText: '## Summary\nSynthetic.\n\n## Blocking issues\n- None.\n\n## Verdict\nComment only', execution: selected };
    } });
  assert.ok(seen.length > 2);
  assert.equal(seen[0].mes, mes);
  for (const options of seen.slice(1)) {
    assert.equal(options.mes, undefined);
    assert.deepEqual(options.reviewerArm, { harness: 'codex', model: 'mes-model', effort: 'medium' });
  }
});
