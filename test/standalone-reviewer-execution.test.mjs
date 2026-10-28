// Each fresh process obtains its own app registry snapshot. Host config and
// filesystem rosters cannot replace governed models or hide transport outages.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PROBE = `
const h = (await import(process.env.AR_ROOT + '/src/reviewer-harness.mjs')).__test__;
const r = await import(process.env.AR_ROOT + '/src/adapters/agent-runtime/local/remediation.mjs');
const quiet = { info() {}, warn() {}, error() {} };
const { dispatchReadTransport } = await import(process.env.AR_ROOT + '/src/dispatch-read-client.mjs');
let connects = 0;
dispatchReadTransport.sdk = () => ({
  async connect(config) {
    connects++;
    return { sessionToken: 'fixture-session', endpoint_url: config.endpoint_url };
  },
  async readSessionHostServices(request, options) {
    if (request.action !== 'worker_registry' || options.session_token !== 'fixture-session') throw Error('session required');
    if (process.env.REGISTRY_DOWN === '1') throw Error('fixture transport down');
    return {schema_version: 1, status: 'found', data: {classes: {
      'codex-reviewer': {defaultModel: 'governed-codex', defaultReasoningLevel: 'high'},
      'claude-reviewer': {defaultModel: 'governed-claude'},
      'gemini-reviewer': {defaultModel: 'governed-gemini'},
    }}};
  },
  readHostServicesSync() { throw Error('sync transport must never run'); },
});
try {
  if (process.env.REGISTRY_ENTRY === 'grounding') {
    const { readAfhReviewerGrounding } = await import(process.env.AR_ROOT + '/src/afh-reviewer-fallback.mjs');
    await readAfhReviewerGrounding({env: process.env,
      execFileImpl: async () => ({stdout: JSON.stringify({providerStatuses: []})}),
      selectReviewerTokenAccountImpl: async () => null, retryDelaysMs: []});
  } else if (process.env.REGISTRY_ENTRY === 'security') {
    const { createDefaultArgusReviewDeps } = await import(process.env.AR_ROOT + '/src/argus-security-review-deps.mjs');
    const deps = createDefaultArgusReviewDeps({rootDir: process.env.AR_ROOT, env: process.env,
      logger: quiet, evidenceIo: {}, agyLease: {legacy: true},
      identityPool: {plan: () => ({hqOwner: true})},
      reviewWithGeminiImpl: async () => {
        const execution = h.resolveReviewerExecution('gemini', {env: process.env, log: quiet});
        if (execution.model !== 'governed-gemini') throw Error('ungoverned security model');
        return {reviewText: 'fixture review'};
      }});
    await deps.runReviewerModel({model: 'gemini', prompt: 'fixture', cwd: process.env.AR_ROOT, diff: ''});
  } else await h.resolveReviewerExecutionAsync('codex', {env: process.env, log: quiet});
  const codex = h.resolveCodexExecOverrides({env: process.env, log: quiet});
  const claude = r.resolveRemediationModel('claude-reviewer', {env: process.env});
  const gemini = r.resolveRemediationModel('gemini-reviewer', {env: process.env});
  process.stdout.write(JSON.stringify({connects, codex, claude, gemini}));
} catch (error) {
  process.stdout.write(JSON.stringify({connects, code: error.code, failureClass: error.failureClass,
    retryable: error.retryable, isOAuthError: error.isOAuthError === true, message: error.message}));
}
`;

function standaloneRun(t, { codexConfig = null, down = false, entry = 'reviewer' } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'ar-standalone-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const arRoot = path.join(root, 'adversarial-review');
  mkdirSync(arRoot);
  // Copy the runtime layout a standalone install ships (sources, domain/prompt config), not tests or data.
  for (const entry of ['src', 'domains', 'prompts', 'templates', 'config', 'modules', 'config.yaml', 'config.json', 'package.json']) {
    if (existsSync(path.join(repoRoot, entry))) {
      cpSync(path.join(repoRoot, entry), path.join(arRoot, entry), { recursive: true });
    }
  }
  symlinkSync(path.join(repoRoot, 'node_modules'), path.join(arRoot, 'node_modules'), 'dir');
  const home = path.join(root, 'home');
  mkdirSync(path.join(home, '.codex'), { recursive: true });
  if (codexConfig) writeFileSync(path.join(home, '.codex', 'config.toml'), codexConfig);
  const probePath = path.join(root, 'probe.mjs');
  writeFileSync(probePath, PROBE);
  // Deliberately minimal env: nothing from an Agent OS host leaks in.
  const env = { HOME: home, PATH: process.env.PATH, AR_ROOT: arRoot, TMPDIR: root, REGISTRY_DOWN: down ? '1' : '0', REGISTRY_ENTRY: entry };
  const result = spawnSync(process.execPath, [probePath], { env, cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `standalone probe failed:\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

test('fresh standalone process establishes its own app session before synchronous resolution', t => {
  const out = standaloneRun(t);
  assert.equal(out.connects, 1);
  assert.equal(out.codex.model, 'governed-codex');
  assert.equal(out.codex.modelSource, 'producer');
  assert.equal(out.claude.resolvedModel, 'governed-claude');
  assert.equal(out.gemini.resolvedModel, 'governed-gemini');
});

test('standalone host model cannot replace the governed registry model', t => {
  const out = standaloneRun(t, {codexConfig: 'model = "host-model"\nmodel_reasoning_effort = "medium"\n'});
  assert.equal(out.codex.model, 'governed-codex');
  assert.equal(out.codex.reasoningEffort, 'high');
  assert.equal(out.codex.modelSource, 'producer');
});

test('fresh standalone registry outage is retryable infrastructure without an OAuth notice', t => {
  const out = standaloneRun(t, {down: true});
  assert.equal(out.connects, 1);
  assert.equal(out.code, 'registry-unavailable');
  assert.equal(out.failureClass, 'reviewer-model-unresolved');
  assert.equal(out.retryable, true);
  assert.equal(out.isOAuthError, false);
  assert.doesNotMatch(out.message, /re-authenticate|OAuth credentials unavailable/);
});


test('fresh quota grounding process establishes its own registry without a watcher', t => {
  const out = standaloneRun(t, {entry: 'grounding'});
  assert.equal(out.connects, 1);
  assert.equal(out.codex.model, 'governed-codex');
  assert.equal(out.claude.resolvedModel, 'governed-claude');
});

test('fresh quota grounding process preserves the registry outage classification', t => {
  const out = standaloneRun(t, {entry: 'grounding', down: true});
  assert.equal(out.failureClass, 'reviewer-model-unresolved');
  assert.equal(out.retryable, true);
  assert.equal(out.isOAuthError, false);
});


test('fresh security reviewer process establishes its own registry without a watcher', t => {
  const out = standaloneRun(t, {entry: 'security'});
  assert.equal(out.connects, 1);
  assert.equal(out.gemini.resolvedModel, 'governed-gemini');
});

test('fresh security reviewer process preserves the registry outage classification', t => {
  const out = standaloneRun(t, {entry: 'security', down: true});
  assert.equal(out.failureClass, 'reviewer-model-unresolved');
  assert.equal(out.retryable, true);
  assert.equal(out.isOAuthError, false);
});
