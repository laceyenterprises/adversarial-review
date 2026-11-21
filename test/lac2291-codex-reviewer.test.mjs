import './helpers/review-cli-resolver-fixture.mjs';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createCliDirectReviewerRuntimeAdapter } from '../src/adapters/reviewer-runtime/cli-direct/index.mjs';
import { probeCodexCli } from '../src/adapters/reviewer-runtime/cli-direct/discovery.mjs';
import { classifyReviewerFailure } from '../src/adapters/reviewer-runtime/cli-direct/classification.mjs';
import { summarizeCodexReviewExecFailure } from '../src/codex-review-exec-diagnostic.mjs';
import { dispatchReadTransport } from '../src/dispatch-read-client.mjs';
import { infraRecoverableFailureClass, unknownReviewerCommandFailureClass } from '../src/reviewer-failure-classification.mjs';
import { reviewWithCodex } from '../src/reviewer-harness.mjs';
import { writeDummyCodexAuth } from './helpers/codex-service-fixture.mjs';

const model = 'gpt-6.2-sol';
const bearer = 'fixture-only-sensitive-bearer';
const warning = 'Under-development features enabled: code_mode. '.repeat(24);
const capabilityWarning = `Code Mode is enabled in configuration, but model \`${model}\` does not advertise Code Mode support.`;
// The capability-bearing entry uses the native CLI's bundled gpt-6.1-sol
// tooling values. The exact incident slug is independently tested without
// assigning it capabilities that are absent from its fixture catalog entry.
const catalog = { models: [{ slug: model },
  { slug: 'gpt-6.1-sol', tool_mode: 'code_mode_only', supports_search_tool: true }] };

function fixture(t, terminal, selectedModel = model) {
  const root = mkdtempSync(join(tmpdir(), 'lac2291-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = writeDummyCodexAuth(join(root, 'source', 'auth.json'));
  const sentry = join(root, 'exec.json');
  const binary = join(root, 'codex');
  writeFileSync(binary, `#!${process.execPath}
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const home = process.env.CODEX_HOME;
const config = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'auth.json'))).auth_mode, 'chatgpt');
const modelLine = 'model = ' + JSON.stringify(${JSON.stringify(selectedModel)});
assert.ok(config.split('\\n').includes(modelLine));
function recordCatalog(pathLiteral) {
  const selectedCatalog = JSON.parse(fs.readFileSync(JSON.parse(pathLiteral)));
  fs.writeFileSync(${JSON.stringify(sentry)}, JSON.stringify({ home, selectedCatalog }));
}
if (args[0] === 'login') {
  assert.deepEqual(args, ['login', 'status']);
  console.error('Logged in using ChatGPT');
} else if (args[0] === 'debug') {
  assert.deepEqual(args, ['debug', 'models']);
  console.log(${JSON.stringify(JSON.stringify(catalog))});
} else if (args[0] === '--version' || args[0] === 'sessions') {
  const pin = config.split('\\n').find(line => line.startsWith('model_catalog_json = '));
  recordCatalog(pin.slice('model_catalog_json = '.length));
  console.log(args[0] === '--version' ? 'codex-cli 0.169.0' : '[]');
} else {
  assert.equal(args[0], 'exec');
  assert.equal(args[args.indexOf('--model') + 1], ${JSON.stringify(selectedModel)});
  assert.ok(args.includes('--ignore-user-config'));
  assert.ok(args.includes('features.code_mode.enabled=true'));
  assert.ok(args.includes('features.shell_tool=true'));
  assert.ok(args.includes('features.unified_exec=true'));
  assert.ok(args.includes('features.apps=false'));
  assert.ok(args.includes('features.plugins=false'));
  assert.ok(args.includes('features.hooks=false'));
  assert.ok(!args.some(arg => arg.startsWith('model_provider=')));
  assert.doesNotMatch(config, /^model_provider\\s*=/m);
  const pin = args.find(arg => arg.startsWith('model_catalog_json='));
  recordCatalog(pin.slice('model_catalog_json='.length));
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'fixture' }));
  for (const message of ${JSON.stringify([warning, capabilityWarning])}) {
    console.log(JSON.stringify({ type: 'item.completed', item: { type: 'error', message } }));
  }
  ${terminal}
  process.exitCode = 1;
}
`, { mode: 0o700 });
  const previous = { CODEX_AUTH_PATH: process.env.CODEX_AUTH_PATH, APP_CONTRACT_ENDPOINT_URL: process.env.APP_CONTRACT_ENDPOINT_URL };
  process.env.CODEX_AUTH_PATH = source;
  process.env.APP_CONTRACT_ENDPOINT_URL = `https://example.invalid/${root.split('/').at(-1)}`;
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  t.mock.method(dispatchReadTransport, 'sdk', () => ({
    async connect(config) { return { sessionToken: 'offline-fixture', endpoint_url: config.endpoint_url }; },
    async readSessionHostServices(request) {
      assert.equal(request.action, 'worker_registry');
      return { schema_version: 1, status: 'found', data: { classes: {
        'codex-reviewer': { defaultModel: selectedModel, allowedModels: [selectedModel], defaultReasoningLevel: 'medium' },
      } } };
    },
  }));
  const run = () => reviewWithCodex('+fixture\n', '', {
    promptOverride: 'fixture review', reviewerSubprocessCwd: root,
    codexCli: binary, assertCodexOAuthImpl: async () => {},
    materializePerWorkerCodexAuthImpl: () => null,
    reviewWithCodexOAuthResponsesImpl: async () => assert.fail('exec failure must not switch transport'),
    log: { info() {}, warn() {} },
  });
  return { root, binary, run, readReceipt() {
    const receipt = JSON.parse(readFileSync(sentry));
    assert.equal(existsSync(receipt.home), false, 'service home is removed after the child exits');
    assert.equal(existsSync(source), true, 'fixture auth source survives cleanup');
    return receipt;
  } };
}

for (const [name, terminal, expected, failureClass] of [
  ['structured terminal error', `console.log(JSON.stringify({ type: 'turn.failed', error: {
    message: 'Provider refused reviewer initialization: cannot find runtime slot. Bearer ${bearer} ' + 'x'.repeat(1500) } }));`,
  /Provider refused reviewer initialization: cannot find runtime slot/, 'reviewer-command-failed'],
  ['nested error event', `console.log(JSON.stringify({ type: 'error', error: {
    message: 'Provider refused reviewer initialization: cannot find runtime slot. Bearer ${bearer} ' + 'x'.repeat(1500) } }));`,
  /Provider refused reviewer initialization: cannot find runtime slot/, 'reviewer-command-failed'],
  ['stderr terminal error', `console.error('Error: API Error 503 upstream unavailable. Bearer ${bearer}');`,
    /API Error 503 upstream unavailable/, 'cascade'],
  ['startup warnings alone', '', /Command failed with code 1/, 'reviewer-command-failed'],
]) {
  test(`LAC-2291 preserves ${name} through the caller`, async t => {
    const f = fixture(t, terminal);
    const adapter = createCliDirectReviewerRuntimeAdapter({
      rootDir: f.root, preflightImpl: async () => ({}),
      // Relay exactly the message/stack fields emitted by reviewer.mjs, as
      // stderr on the caller side. The inner Codex subprocess runs for real.
      spawnCapturedImpl: () => f.run().catch(err => {
        throw Object.assign(new Error('Command failed with code 1'), { exitCode: 1,
          stderr: `[reviewer] AI review failed for fixture/repo#1: ${err.message}\n[reviewer] ERROR STACK: ${err.stack}` });
      }),
    });
    const result = await adapter.spawnReviewer({
      model: 'codex', prompt: '', timeoutMs: 5000, sessionUuid: 'lac2291-fixture',
      subjectContext: { domainId: 'code-pr', repo: 'fixture/repo', prNumber: 1, promptStage: 'first' },
      forbiddenFallbacks: ['api-key'],
    });
    assert.equal(result.ok, false);
    assert.match(result.stderrTail, expected);
    f.readReceipt();
    assert.doesNotMatch(result.stderrTail, /Under-development features|does not advertise Code Mode support/);
    assert.ok(!result.error.includes(bearer));
    assert.ok(!result.stderrTail.includes(bearer));
    assert.ok(!result.stderrTail.includes('x'.repeat(320)), 'terminal detail is bounded');
    assert.equal(result.failureClass, failureClass);
    assert.equal(infraRecoverableFailureClass({ failure_message: `[${result.failureClass}] ${result.error}` }), failureClass);
    if (failureClass === 'reviewer-command-failed') {
      assert.equal(unknownReviewerCommandFailureClass({ failure_message: result.error }), 'unknown');
      assert.equal(infraRecoverableFailureClass({ failure_message: `[forbidden-fallback] ${result.error}` }), null);
    }
  });
}

test('LAC-2291 passes authoritative tool capabilities to the selected reviewer CLI', async t => {
  const f = fixture(t, '');
  await assert.rejects(f.run, /Native Codex exec failed/);
  assert.deepEqual(f.readReceipt().selectedCatalog, catalog);
});

test('LAC-2291 discovery preserves the capability-bearing selected model', async t => {
  const f = fixture(t, '', 'gpt-6.1-sol');
  await probeCodexCli({ env: { ...process.env, CODEX_CLI_PATH: f.binary }, cwd: f.root });
  assert.deepEqual(f.readReceipt().selectedCatalog, catalog);
});

test('LAC-2291 preserves terminal auth rejection without emitting credential fields', async t => {
  const f = fixture(t, `console.log(JSON.stringify({ type: 'error',
    message: 'Unexpected status 401 Unauthorized {"access_token":"${bearer}"}' }));`);
  await assert.rejects(f.run, err => {
    assert.equal(err.isOAuthError, true);
    assert.match(err.message, /status 401 Unauthorized/);
    assert.ok(!err.message.includes(bearer));
    return true;
  });
  f.readReceipt();
});

test('LAC-2291 extracts nested error diagnostics before stderr fallback and redacts auth fields', () => {
  const message = `Unexpected status 401 Unauthorized {"access_token":"${bearer}"}`;
  const result = summarizeCodexReviewExecFailure({
    message: 'Command failed with code 1',
    stdout: JSON.stringify({ type: 'error', error: { message }, message: 'flat fallback' }),
    stderr: 'unrelated fallback',
  });
  assert.equal(result.authRejected, true);
  assert.match(result.diagnostic, /status 401 Unauthorized/);
  assert.doesNotMatch(result.diagnostic, /flat fallback|unrelated fallback/);
  assert.ok(!result.diagnostic.includes(bearer));
});

test('LAC-2291 retains flat error messages when the nested message is empty', () => {
  const result = summarizeCodexReviewExecFailure({
    message: 'Command failed with code 1',
    stdout: JSON.stringify({ type: 'error', error: { message: '' }, message: 'flat diagnostic' }),
  });
  assert.match(result.diagnostic, /flat diagnostic/);
});

test('LAC-2291 classifies native exec failures with logger prefixes and retains specific failure precedence', () => {
  for (const prefix of ['', '  ', '2026-11-21T08:26:21Z ERROR [pgid=9456] ']) {
    for (const wrapper of ['', '[reviewer] AI review failed for fixture/repo#1: ', '[reviewer] ERROR STACK: Error: ']) {
      const line = `${prefix}${wrapper}Native Codex exec failed: Command failed with code 1`;
      assert.equal(classifyReviewerFailure(line, 1), 'reviewer-command-failed', line);
      assert.equal(classifyReviewerFailure(`${line} | cannot find runtime slot`, 1), 'reviewer-command-failed', line);
      assert.equal(classifyReviewerFailure(line, 127), 'bug', 'caller exit 127 still wins');
      assert.equal(classifyReviewerFailure(line, 1, 'ENOENT'), 'bug', 'caller error code still wins');
      assert.equal(classifyReviewerFailure(`${line} | API Error 503 upstream unavailable`, 1), 'cascade');
      assert.equal(classifyReviewerFailure(line, 1, null, { timedOut: true }), 'reviewer-timeout');
    }
  }
  assert.equal(classifyReviewerFailure('ERROR cannot find caller module', 1), 'bug');
});
