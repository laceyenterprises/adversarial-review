import './helpers/registry-session-fixture.mjs';
// The corporate Claude hammer is an allowed closer fallback, and HHR selects it
// when both Codex accounts and the personal Claude account are grounded.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config-loader.mjs';
import { validateStartupRoleConfig } from '../src/role-config.mjs';
import { resolveCloserDispatchHarness } from '../src/ama/harness-fallback.mjs';
import { isHammerWorkerClass } from '../src/ama/hammer-worker-class.mjs';
import { isMergeCapableCredentialClass } from '../src/ama/merge-capability-enforcement.mjs';
import { claudeAccountFixture } from './helpers/claude-account-fixture.mjs';

const FALLBACKS = ['hammer-corp', 'hammer-claude', 'hammer-claude-corp'];

function withConfig(t, yaml) {
  const root = mkdtempSync(join(tmpdir(), 'hhr-claude-corp-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const topPath = join(root, 'config.yaml');
  writeFileSync(topPath, yaml);
  return topPath;
}

const fallbackYaml = list => `version: 1\nroles:\n  adversarial:\n    merge_authority:\n      worker_class: hammer\n      worker_class_fallback: [${list.join(', ')}]\n`;

test('the review-service loaders accept the corporate Claude hammer as a closer fallback', t => {
  const topPath = withConfig(t, fallbackYaml(FALLBACKS));
  const cfg = loadConfig({ topPath, modulePaths: [], env: {} });
  assert.deepEqual(cfg.getMergeAuthorityConfig().workerClassFallback, FALLBACKS);
  assert.doesNotThrow(() => validateStartupRoleConfig({ topPath, modulePaths: [], env: {}, warn: () => {} }));
});

test('the default fallback list is unchanged and unknown closers stay refused', t => {
  const topPath = withConfig(t, 'version: 1\n');
  assert.deepEqual(loadConfig({ topPath, modulePaths: [], env: {} }).getMergeAuthorityConfig().workerClassFallback,
    ['hammer-claude']);
  writeFileSync(topPath, fallbackYaml(['hammer-claude', 'unknown-closer']));
  assert.throws(() => loadConfig({ topPath, modulePaths: [], env: {} }));
  assert.throws(() => validateStartupRoleConfig({ topPath, modulePaths: [], env: {}, warn: () => {} }));
});

test('the corporate Claude hammer is a merge-capable hammer class', () => {
  assert.equal(isHammerWorkerClass('hammer-claude-corp'), true);
  assert.equal(isMergeCapableCredentialClass('hammer-claude-corp'), true);
});

// Both Codex accounts are exhausted in every scenario below.
function groundedCodexSnapshot(claude) {
  const fixture = claudeAccountFixture(claude);
  fixture.providerStatuses.push({ provider: 'openai', authPath: 'oauth-corp', state: 'exhausted' });
  return fixture;
}

const closer = (snapshot, fallbackWorkerClasses = FALLBACKS) => resolveCloserDispatchHarness({
  workerClass: 'hammer', codexAccountPolicy: 'pinned', fallbackWorkerClasses,
  execFileImpl: async () => ({ stdout: JSON.stringify(snapshot) }), env: {}, modelForWorkerClass: () => null,
});

test('HHR picks the corporate Claude hammer when Codex and personal Claude are grounded', async () => {
  const decision = await closer(groundedCodexSnapshot({ primary: 'exhausted' }));
  assert.equal(decision.workerClass, 'hammer-claude-corp');
  assert.equal(decision.fellBack, true);
  assert.equal(decision.from, 'hammer');
  assert.equal(decision.fallbackProvider, 'anthropic');
  assert.equal(decision.hold, undefined);
  // Listed on its own, it reaches the same decision.
  assert.equal((await closer(groundedCodexSnapshot({ primary: 'exhausted' }), ['hammer-claude-corp'])).workerClass,
    'hammer-claude-corp');
});

test('the corporate Claude hammer is grounded by the corporate account, not the personal one', async () => {
  // Personal exhaustion does not ground the corporate lane...
  assert.equal((await closer(groundedCodexSnapshot({ primary: 'exhausted', corp: 'ok' }))).workerClass,
    'hammer-claude-corp');
  // ...and corporate exhaustion does: with both Claude accounts grounded the closer holds.
  const held = await closer(groundedCodexSnapshot({ primary: 'exhausted', corp: 'exhausted' }));
  assert.equal(held.hold, true);
  assert.equal(held.reason, 'all-fallbacks-grounded');
  // An unready corporate broker is not admitting either.
  assert.equal((await closer(groundedCodexSnapshot({ primary: 'exhausted', corpReady: false }))).hold, true);
});
