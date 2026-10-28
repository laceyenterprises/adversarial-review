import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchReadTransport } from '../src/dispatch-read-client.mjs';
import {
  ensureWorkerRegistryReady, readCommittedWorkerModelSeed, resolveRemediationModel,
  resolveClaudeRemediationModel, resolveCodexRemediationModel, resolveGeminiRemediationModel,
  RegistryUnavailableError,
} from '../src/adapters/agent-runtime/local/remediation.mjs';
import { __test__ as harness } from '../src/reviewer-harness.mjs';

const seed = readCommittedWorkerModelSeed();
const classes = ['remediator-codex', 'remediator-claude', 'remediator-gemini',
  'codex-reviewer', 'claude-reviewer', 'gemini-reviewer'];
const review = '## Summary\nSynthetic change reviewed.\n\n## Verdict\nComment only';

function registry(t, name, data) {
  const env = { APP_CONTRACT_ENDPOINT_URL: `https://example.invalid/remodel-${name}` };
  t.mock.method(dispatchReadTransport, 'sdk', () => ({
    async connect() { return { sessionToken: 'synthetic-session' }; },
    async readSessionHostServices(request, options) {
      assert.equal(request.action, 'worker_registry');
      assert.equal(options.session_token, 'synthetic-session');
      if (data instanceof Error) throw data;
      return { schema_version: 1, status: 'found', data };
    },
    readHostServicesSync() { assert.fail('model selection must not invoke the sync transport'); },
  }));
  const messages = { warnings: [], infos: [], errors: [] };
  const log = {
    warn: message => messages.warnings.push(message),
    info: message => messages.infos.push(message),
    error: message => messages.errors.push(message),
  };
  return { env, log, messages };
}

test('committed seed uses the registry classes/defaultModel/allowedModels shape for every covered class', () => {
  assert.deepEqual(Object.keys(seed.classes).sort(), [...classes].sort());
  for (const spec of Object.values(seed.classes)) {
    assert.equal(typeof spec.defaultModel, 'string');
    assert.ok(spec.defaultModel.trim());
    assert.ok(!spec.defaultModel.startsWith('-'));
    assert.ok(Array.isArray(spec.allowedModels));
    assert.ok(spec.allowedModels.includes(spec.defaultModel));
    assert.ok(spec.allowedModels.every(model => typeof model === 'string' && model.trim()));
  }
});

for (const className of classes) {
  test(`${className}: registry default and env pin take precedence with validated provenance`, async t => {
    const f = registry(t, className, { classes: {
      [className]: { defaultModel: 'synthetic-default', allowedModels: ['synthetic-default', 'synthetic-pin'] },
    } });
    assert.equal(await ensureWorkerRegistryReady({ env: f.env }), true);
    const resolved = resolveRemediationModel(className, { ...f });
    assert.equal(resolved.resolvedModel, 'synthetic-default');
    assert.equal(resolved.modelSource, 'registry');
    assert.equal(resolveRemediationModel(className, { ...f, pin: 'synthetic-pin' }).modelSource, 'env-pin');
    assert.equal(f.messages.warnings.length, 0);
    assert.match(f.messages.infos.join('\n'), /modelSource=registry/);
    assert.match(f.messages.infos.join('\n'), /modelSource=env-pin/);
    assert.throws(() => resolveRemediationModel(className, { ...f, pin: 'outside-allowlist' }),
      { code: 'registry-unavailable', retryable: true, modelSource: 'unresolved' });
  });

  test(`${className}: unavailable registry uses the committed default and warns visibly`, async t => {
    const f = registry(t, `outage-${className}`, new Error('synthetic registry outage'));
    assert.equal(await ensureWorkerRegistryReady({ env: f.env }), false);
    const resolved = resolveRemediationModel(className, { ...f });
    assert.equal(resolved.resolvedModel, seed.classes[className].defaultModel);
    assert.equal(resolved.modelSource, 'committed-seed');
    assert.match(f.messages.warnings.join('\n'), /WARNING.*modelSource=committed-seed/);
    const pinned = resolveRemediationModel(className, { ...f, pin: seed.classes[className].defaultModel });
    assert.equal(pinned.modelSource, 'env-pin');
  });

  test(`${className}: no registry or seed is retryable infrastructure, never a legacy constant`, async t => {
    const f = registry(t, `unresolved-${className}`, new Error('synthetic registry outage'));
    await ensureWorkerRegistryReady({ env: f.env });
    for (const missing of [null, {}, { classes: {} }, { classes: [] }]) {
      assert.throws(() => resolveRemediationModel(className, {
        ...f, seed: missing, fallbackModel: 'forbidden-legacy-fallback',
      }), error => {
        assert.ok(error instanceof RegistryUnavailableError);
        assert.equal(error.retryable, true);
        assert.equal(error.modelSource, 'unresolved');
        assert.match(error.message, /modelSource=unresolved.*no valid class defaultModel/);
        assert.ok(!error.isOAuthError);
        return true;
      });
    }
    assert.match(f.messages.errors.join('\n'), /modelSource=unresolved/);
    assert.equal(resolveRemediationModel(className, { ...f, seed: null, pin: 'synthetic-explicit' }).modelSource, 'env-pin');
  });
}

test('invalid registry or seed defaults and malformed allowlists fail closed as retryable infrastructure', async t => {
  const className = 'codex-reviewer';
  for (const spec of [
    { defaultModel: 'synthetic-outside', allowedModels: ['synthetic-allowed'] },
    { defaultModel: 'synthetic-default', allowedModels: [] },
    { defaultModel: 'synthetic-default', allowedModels: 'synthetic-default' },
    { defaultModel: '-invalid-option' },
    { defaultModel: '' },
  ]) {
    const f = registry(t, `invalid-${JSON.stringify(spec)}`, { classes: { [className]: spec } });
    await ensureWorkerRegistryReady({ env: f.env });
    assert.throws(() => resolveRemediationModel(className, { ...f }), { retryable: true, modelSource: 'unresolved' });
    assert.throws(() => resolveRemediationModel(className, {
      env: { APP_CONTRACT_ENDPOINT_URL: 'https://example.invalid/no-snapshot' },
      seed: { classes: { [className]: spec } }, log: f.log,
    }), { retryable: true, modelSource: 'unresolved' });
  }
});

test('an env pin uses the authoritative registry allowlist even without a class default', async t => {
  const f = registry(t, 'pin-without-default', { classes: {
    'codex-reviewer': { allowedModels: ['synthetic-new-pin'] },
  } });
  await ensureWorkerRegistryReady({ env: f.env });
  const result = resolveRemediationModel('codex-reviewer', { ...f, pin: 'synthetic-new-pin' });
  assert.equal(result.resolvedModel, 'synthetic-new-pin');
  assert.equal(result.modelSource, 'env-pin');
  assert.equal(f.messages.warnings.length, 0);
});

test('every existing remediation model env name remains an explicit pin', async t => {
  const f = registry(t, 'pin-aliases', new Error('synthetic outage'));
  await ensureWorkerRegistryReady({ env: f.env });
  for (const [className, resolve, names] of [
    ['remediator-codex', resolveCodexRemediationModel,
      ['ADVERSARIAL_REMEDIATION_CODEX_MODEL', 'CODEX_REMEDIATION_MODEL', 'CODEX_MODEL_ID']],
    ['remediator-claude', resolveClaudeRemediationModel,
      ['ADVERSARIAL_REMEDIATION_CLAUDE_MODEL', 'CLAUDE_REMEDIATION_MODEL']],
    ['remediator-gemini', resolveGeminiRemediationModel, ['GEMINI_REMEDIATION_MODEL', 'GEMINI_MODEL']],
  ]) {
    const model = seed.classes[className].defaultModel;
    for (const name of names) {
      const result = resolve({ ...f.env, [name]: model });
      assert.equal(typeof result === 'string' ? result : result.resolvedModel, model);
    }
  }
});

for (const [reviewer, recovery, available] of [
  ['gemini', false, false], ['claude', false, false], ['codex', false, false],
  ['codex', true, false], ['codex', true, true],
]) {
  test(`${reviewer} review completes with validated ${available ? 'registry' : 'seed'} metadata (OAuth recovery=${recovery})`, async t => {
    const source = available ? 'registry' : 'committed-seed';
    const f = registry(t, `review-${reviewer}-${recovery}-${available}`, available
      ? { classes: { 'codex-reviewer': { defaultModel: 'synthetic-recovery-model', allowedModels: ['synthetic-recovery-model'] } } }
      : new Error('synthetic outage'));
    const overrides = { ...f.env, AGENT_OS_CODEX_PER_WORKER_AUTH: '0',
      CODEX_BROKER_PROVIDER: 'codex', GEMINI_REVIEWER_MODEL: '',
      CODEX_REVIEWER_AUTH_PROVIDER: '', CODEX_HOME: '', CODEX_AUTH_PATH: '' };
    const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
    Object.assign(process.env, overrides);
    t.after(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
    // The real reviewer.mjs entry-point uses this same readiness helper.
    assert.equal(await ensureWorkerRegistryReady(), available);
    const expected = available ? 'synthetic-recovery-model' : seed.classes[`${reviewer}-reviewer`].defaultModel;
    let invoked = 0;
    let recovered = 0;
    let result;
    if (reviewer === 'gemini') {
      result = await harness.reviewWithGemini('+synthetic diff', '', {
        log: f.log, resolveGeminiRuntimeImpl: () => 'cli', assertOAuthImpl: async () => {},
        spawnGeminiReviewImpl: async ({ model }) => {
          invoked++;
          assert.equal(model, expected);
          return { stdout: review, stderr: '' };
        },
      });
    } else if (reviewer === 'claude') {
      result = await harness.reviewWithClaude('+synthetic diff', '', {
        logger: f.log, platform: 'linux',
        assertClaudeOAuthImpl: async ({ model }) => {
          assert.equal(model, expected);
          return { env: {}, transport: 'keychain' };
        },
        spawnClaudeImpl: async args => {
          invoked++;
          assert.equal(args[args.indexOf('--model') + 1], expected);
          return { stdout: JSON.stringify({ result: review, usage: {} }), stderr: '' };
        },
      });
    } else {
      result = await harness.reviewWithCodex('+synthetic diff', '', {
        log: f.log, codexCli: process.execPath, assertCodexOAuthImpl: async () => {},
        spawnCodexReviewImpl: async ({ model }) => {
          invoked++;
          assert.equal(model, expected);
          if (recovery) throw Object.assign(new Error('synthetic no progress'), { progressTimedOut: true });
          return { stdout: review, stderr: '' };
        },
        reviewWithCodexOAuthResponsesImpl: async (_prompt, { model }) => {
          recovered++;
          assert.equal(model, expected);
          return { reviewText: review, tokenUsage: null };
        },
      });
    }
    assert.equal(invoked, 1);
    assert.equal(recovered, recovery ? 1 : 0);
    assert.equal(result.reviewText.replace(/\n+/g, "\n"), review.replace(/\n+/g, "\n"));
    assert.equal(result.execution.model, expected);
    assert.equal(result.execution.modelSource, source);
    if (available) assert.equal(f.messages.warnings.length, 0);
    else assert.match(f.messages.warnings.join('\n'), /WARNING.*modelSource=committed-seed/);
    assert.doesNotMatch(f.messages.errors.join('\n'), /reviewer-model-unresolved/);
  });
}
