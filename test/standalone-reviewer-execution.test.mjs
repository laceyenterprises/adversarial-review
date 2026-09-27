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
const codex = h.resolveCodexExecOverrides({ env: process.env, log: quiet });
const claude = r.resolveRemediationModel('claude-reviewer', { env: process.env, fallbackModel: null });
const gemini = r.resolveRemediationModel('gemini-reviewer', { env: process.env, fallbackModel: null });
process.stdout.write(JSON.stringify({
  codex: { model: codex.model, effort: codex.reasoningEffort, modelSource: codex.modelSource, effortSource: codex.effortSource, cfg: codex.configOverrides },
  claude: { model: claude.resolvedModel, effort: claude.resolvedReasoningLevel },
  gemini: { model: gemini.resolvedModel, effort: gemini.resolvedReasoningLevel },
  claudeArgs: h.buildClaudeReviewArgs('PROMPT', { model: claude.resolvedModel, effort: claude.resolvedReasoningLevel }),
}));
`;

function standaloneRun(t, { codexConfig = null } = {}) {
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
  const env = { HOME: home, PATH: process.env.PATH, AR_ROOT: arRoot, TMPDIR: root };
  const result = spawnSync(process.execPath, [probePath], { env, cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `standalone probe failed:\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

test('standalone without a host codex config: reviewers use CLI defaults and nothing throws', (t) => {
  const out = standaloneRun(t);
  assert.equal(out.codex.model, null);
  assert.equal(out.codex.effort, null);
  assert.equal(out.codex.modelSource, 'cli-default');
  assert.equal(out.codex.effortSource, 'none');
  assert.deepEqual(out.codex.cfg, []);
  assert.equal(out.claude.model, null);
  assert.equal(out.gemini.model, null);
  assert.ok(!out.claudeArgs.includes('--model') && !out.claudeArgs.includes('--effort'),
    'an unresolved claude reviewer must not pass --model/--effort');
});

test('standalone with a host codex config: the codex reviewer keeps the host model and effort', (t) => {
  const out = standaloneRun(t, { codexConfig: 'model = "gpt-5.5"\nmodel_reasoning_effort = "medium"\n' });
  assert.equal(out.codex.model, 'gpt-5.5');
  assert.equal(out.codex.effort, 'medium');
  assert.equal(out.codex.modelSource, 'host-config');
  assert.equal(out.codex.effortSource, 'host-config');
  assert.deepEqual(out.codex.cfg, [{ key: 'model_reasoning_effort', value: 'medium' }]);
});
