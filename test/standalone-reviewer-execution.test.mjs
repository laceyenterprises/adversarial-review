// Standalone contract: adversarial-review must run without an Agent OS installation.
// No HQ_ROOT, no AGENT_OS_* env, and no worker-class roster reachable from the module
// root. Reviewer model/effort then fall back to the host codex config or the CLI defaults,
// and nothing throws. The sources are copied into an isolated directory so the roster's
// upward search cannot find an enclosing Agent OS checkout, wherever this repo lives.
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
  await h.resolveReviewerExecutionAsync('codex', {env: process.env, log: quiet});
  const codex = h.resolveCodexExecOverrides({env: process.env, log: quiet});
  const claude = r.resolveRemediationModel('claude-reviewer', {env: process.env});
  const gemini = r.resolveRemediationModel('gemini-reviewer', {env: process.env});
  process.stdout.write(JSON.stringify({connects, codex, claude, gemini}));
} catch (error) {
  process.stdout.write(JSON.stringify({connects, code: error.code, failureClass: error.failureClass,
    retryable: error.retryable, isOAuthError: error.isOAuthError === true, message: error.message}));
}
`;

function standaloneRun(t, { codexConfig = null, down = false } = {}) {
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
  const env = { HOME: home, PATH: process.env.PATH, AR_ROOT: arRoot, TMPDIR: root, REGISTRY_DOWN: down ? '1' : '0' };
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
