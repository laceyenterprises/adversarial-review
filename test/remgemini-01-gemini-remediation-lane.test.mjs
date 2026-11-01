import './helpers/review-cli-resolver-fixture.mjs';
import './helpers/dispatch-files-preload.mjs';
// REMGEMINI-01: the Gemini remediation lane runs on the Antigravity harness, and
// remediator fallback walks the configured order per launch: a busy,
// quota-held or unresolvable candidate is skipped for that launch only.
// Synthetic fixtures only: no live config, accounts, registry or spawns.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { seedWorkerRegistry } from './helpers/dispatch-files-fixture.mjs';
import {
  RegistryUnavailableError,
  readCommittedWorkerModelSeed,
  spawnGeminiRemediationWorker,
} from '../src/adapters/agent-runtime/local/remediation.mjs';
import { resolveRemediationWorkerClassWithFallback } from '../src/remediation-worker-class-fallback.mjs';
import { resolvePooledWorkerRouting } from '../src/worker-token-pool.mjs';

const ORDER = Object.freeze(['gemini', 'claude-code']);
const OPENAI_CAPPED = { provider: 'openai', authPath: 'oauth', state: 'exhausted' };
const GOOGLE_OK = { provider: 'google', authPath: 'agy', state: 'ok' };
const ANTHROPIC_OK = { provider: 'anthropic', authPath: 'oauth', state: 'ok' };
const SYNTHETIC_AGY_MODELS = ['Synthetic Gemini (High)', 'Synthetic Gemini (Low)'];

function fleet(rows) {
  return async () => ({ stdout: JSON.stringify({ providerStatuses: rows }) });
}

function withdrawnGeminiError() {
  return new RegistryUnavailableError('remediator-gemini',
    'readable registry has no class; committed seed cannot restore a withdrawn class');
}

// The routed primary (codex) is capped, so the configured fallback order decides.
function launch({ rows, fallbackWorkerClasses = ORDER, modelForClass = () => 'synthetic-model', ...rest } = {}) {
  return resolveRemediationWorkerClassWithFallback({
    primary: 'codex',
    codexAccountPolicy: 'pinned',
    env: { AGENT_OS_CONFIG_PATH: '/dev/null' },
    ensureWorkerRegistryReadyImpl: async () => true,
    selectAccountImpl: async () => null,
    fallbackWorkerClasses,
    modelForClass,
    execFileImpl: fleet(rows),
    ...rest,
  });
}

test('order [gemini, claude-code] with gemini resolvable and available selects gemini', async () => {
  const result = await launch({ rows: [OPENAI_CAPPED, GOOGLE_OK, ANTHROPIC_OK] });
  assert.equal(result.workerClass, 'gemini');
  assert.equal(result.fellBack, true);
  assert.equal(result.hold, false);
  assert.deepEqual(result.skipped, []);
});

for (const [label, rows, modelForClass, reason] of [
  ['busy (provider not ok)', [OPENAI_CAPPED, { ...GOOGLE_OK, state: 'degraded' }, ANTHROPIC_OK], undefined,
    'unavailable:degraded'],
  ['quota-held', [OPENAI_CAPPED, { ...GOOGLE_OK, state: 'exhausted' }, ANTHROPIC_OK], undefined,
    'capped:provider-grounded'],
  ['unresolvable', [OPENAI_CAPPED, GOOGLE_OK, ANTHROPIC_OK], (workerClass) => {
    if (workerClass === 'gemini') throw withdrawnGeminiError();
    return 'synthetic-model';
  }, 'model-unresolvable'],
]) {
  test(`gemini ${label} => claude-code for that launch, gemini recorded in skipped[]`, async () => {
    const result = await launch({ rows, ...(modelForClass ? { modelForClass } : {}) });
    assert.equal(result.workerClass, 'claude-code');
    assert.equal(result.hold, false);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].workerClass, 'gemini');
    assert.equal(result.skipped[0].reason, reason);
  });
}

test('the next launch with gemini available selects gemini again; the order is never rewritten', async () => {
  const order = [...ORDER];
  const busy = await launch({ fallbackWorkerClasses: order,
    rows: [OPENAI_CAPPED, { ...GOOGLE_OK, state: 'exhausted' }, ANTHROPIC_OK] });
  assert.equal(busy.workerClass, 'claude-code');
  const recovered = await launch({ fallbackWorkerClasses: order, rows: [OPENAI_CAPPED, GOOGLE_OK, ANTHROPIC_OK] });
  assert.equal(recovered.workerClass, 'gemini');
  assert.deepEqual(order, ORDER);
});

test('a withdrawn remediator-gemini registry class skips gemini instead of aborting the selection', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'remgemini-registry-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // Readable registry without remediator-gemini: the observed production state.
  seedWorkerRegistry(root, {
    'remediator-codex': { defaultModel: 'synthetic-codex', allowedModels: ['synthetic-codex'] },
    'remediator-claude': { defaultModel: 'synthetic-claude', allowedModels: ['synthetic-claude'] },
  });
  const result = await resolveRemediationWorkerClassWithFallback({
    primary: 'codex', codexAccountPolicy: 'pinned', env: { HQ_ROOT: root, AGENT_OS_CONFIG_PATH: '/dev/null' },
    ensureWorkerRegistryReadyImpl: async () => true, selectAccountImpl: async () => null,
    fallbackWorkerClasses: ['gemini', 'remediator-grok', 'claude-code'],
    execFileImpl: fleet([OPENAI_CAPPED, GOOGLE_OK, ANTHROPIC_OK]),
  });
  assert.equal(result.workerClass, 'claude-code');
  assert.deepEqual(result.skipped.map(({ workerClass, reason }) => ({ workerClass, reason })), [
    { workerClass: 'gemini', reason: 'model-unresolvable' },
    // A Grok slot listed before its class is connected is skipped the same way.
    { workerClass: 'remediator-grok', reason: 'provider-untracked' },
  ]);
  assert.match(result.skipped[0].detail, /readable registry has no class/);
});

test('every candidate unavailable keeps the existing hold', async () => {
  const result = await launch({ rows: [OPENAI_CAPPED, { ...GOOGLE_OK, state: 'exhausted' },
    { ...ANTHROPIC_OK, state: 'exhausted' }] });
  assert.equal(result.hold, true);
  assert.equal(result.workerClass, 'codex');
  assert.equal(result.reason, 'no-available-fallback');
  assert.ok(result.holdUntil);
  assert.deepEqual(result.skipped.map((entry) => entry.workerClass), ['gemini', 'claude-code']);
});

test('an unresolvable routed primary falls back, and keeps its typed deferral when nothing can run', async () => {
  const modelForClass = (workerClass) => {
    if (workerClass === 'gemini') throw withdrawnGeminiError();
    return 'synthetic-model';
  };
  const fellBack = await resolveRemediationWorkerClassWithFallback({
    primary: 'gemini', codexAccountPolicy: 'pinned', env: { AGENT_OS_CONFIG_PATH: '/dev/null' },
    ensureWorkerRegistryReadyImpl: async () => true, fallbackWorkerClasses: ['claude-code'], modelForClass,
    execFileImpl: fleet([GOOGLE_OK, ANTHROPIC_OK]),
  });
  assert.equal(fellBack.workerClass, 'claude-code');
  assert.equal(fellBack.capSource, 'model-unresolvable');
  await assert.rejects(() => resolveRemediationWorkerClassWithFallback({
    primary: 'gemini', codexAccountPolicy: 'pinned', env: { AGENT_OS_CONFIG_PATH: '/dev/null' },
    ensureWorkerRegistryReadyImpl: async () => true, fallbackWorkerClasses: [], modelForClass,
    execFileImpl: fleet([GOOGLE_OK]),
  }), { code: 'registry-unavailable' });
});

test('a pooled fallback whose model is unresolvable is skipped, not thrown', async () => {
  const result = await resolvePooledWorkerRouting({
    primary: 'codex', fallbackWorkerClasses: ['remediator-claude'], kind: 'remediator', env: {},
    modelForClass: (role) => {
      if (role === 'remediator-claude') throw withdrawnGeminiError();
      return 'synthetic-model';
    },
    selectAccountImpl: async ({ identity }) => ({ identity, pooled: true, hold: true,
      status: 'unavailable', reason: 'accounts-unavailable' }),
  });
  assert.equal(result.hold, true);
  assert.deepEqual(result.skipped, [{ workerClass: 'remediator-claude', reason: 'model-unresolvable' }]);
});

test('the committed remediator-gemini seed names an Antigravity display-name model', () => {
  const spec = readCommittedWorkerModelSeed().classes['remediator-gemini'];
  assert.match(spec.defaultModel, /^Gemini \d/);
  assert.ok(spec.allowedModels.includes(spec.defaultModel));
  assert.ok(spec.allowedModels.every((model) => /^Gemini \d/.test(model)));
});

test('remediator-gemini resolves from the registry and spawns the Antigravity harness (stubbed agy records argv)', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'remgemini-spawn-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  seedWorkerRegistry(root, { 'remediator-gemini': {
    defaultModel: SYNTHETIC_AGY_MODELS[0], allowedModels: SYNTHETIC_AGY_MODELS,
  } });
  const argvPath = join(root, 'agy-argv.txt');
  const agyStub = join(root, 'agy');
  writeFileSync(agyStub, `#!/bin/sh\nfor arg in "$@"; do printf '%s\\n' "$arg"; done > ${JSON.stringify(argvPath)}\n`);
  chmodSync(agyStub, 0o700);
  const promptPath = join(root, 'prompt.md');
  writeFileSync(promptPath, 'synthetic remediation prompt');
  const worker = spawnGeminiRemediationWorker({
    workspaceDir: root,
    promptPath,
    outputPath: join(root, 'out.txt'),
    logPath: join(root, 'worker.log'),
    hqRoot: root,
    replyPath: join(root, 'reply.json'),
    launchRequestId: 'lrq_synthetic_remgemini',
    enforceHarnessIdentity: false,
    sourceEnv: { HQ_ROOT: root, HOME: root, PATH: '/usr/bin:/bin', AGY_CLI_PATH: agyStub },
  });
  await new Promise((resolve, reject) => {
    worker.child.once('exit', resolve);
    worker.child.once('error', reject);
  });
  const argv = readFileSync(argvPath, 'utf8').trimEnd().split('\n');
  assert.equal(worker.command[0], agyStub);
  assert.equal(worker.runtime, 'antigravity');
  assert.equal(worker.modelSource, 'registry');
  assert.equal(worker.resolvedModel, SYNTHETIC_AGY_MODELS[0]);
  assert.deepEqual(argv.slice(0, 2), ['--model', SYNTHETIC_AGY_MODELS[0]]);
  assert.deepEqual(argv.slice(-2), ['--print', 'synthetic remediation prompt']);
  assert.ok(argv.includes('--dangerously-skip-permissions'));
  for (const legacy of ['--approval-mode', 'yolo', '--skip-trust', '-m']) {
    assert.equal(argv.includes(legacy), false, legacy);
  }
});
