import assert from 'node:assert/strict';
import test from 'node:test';
import { remediationSubjectRefusal, resolveClaimedRemediatorRouting,
  resolveRemediationWorkerClassWithFallback, remediationLaneRuntimeMode,
  remediationLaneModeRefusal } from '../src/remediation-worker-class-fallback.mjs';
import { normalizeRemediationWorkerClass, hqRemediationWorkerClass } from '../src/remediation-worker-class.mjs';
import { remediationWorkerTrailerClass, remediationWorkerGitIdentity } from '../src/remediation-worker-provenance.mjs';
import { selectWorkerTokenAccount } from '../src/worker-token-pool.mjs';
import { loadConfig } from '../src/config-loader.mjs';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const env = { AGENT_OS_CONFIG_PATH: '/dev/null', HQ_ROOT: tmpdir() };
const loaderImpl = () => ({ get: (key, fallback) =>
  ['grok.enabled', 'grok.remediator.enabled'].includes(key) ? true : fallback });
const options = { env, loaderImpl };

test('opt-in remediator identity and account-bound HQ dispatch', () => {
  assert.equal(normalizeRemediationWorkerClass('remediator-grok'), 'remediator-grok');
  assert.equal(hqRemediationWorkerClass('remediator-grok'), 'remediator-grok');
  assert.equal(normalizeRemediationWorkerClass('grok-remediation'), 'remediator-grok');
  assert.equal(remediationSubjectRefusal({ builderTag: 'codex' }, 'remediator-grok', options), null);
  assert.equal(remediationSubjectRefusal({ builderTag: 'codex' }, 'remediator-grok', {
    env, loaderImpl: () => ({ get: (_key, fallback) => fallback }),
  }), 'grok-remediator-disabled');
  assert.equal(remediationLaneRuntimeMode('remediator-grok', 'local', { env }), 'os');
  assert.equal(remediationLaneModeRefusal('remediator-grok', 'local', { env: {} }), 'requires-account-bound-hq-dispatch');
  assert.equal(remediationWorkerTrailerClass('remediator-grok'), 'grok-remediation');
  assert.equal(remediationWorkerGitIdentity('remediator-grok', {}).name, 'Grok Remediation Worker');
});

test('original Grok provenance refuses all actor aliases before account selection and after handoff', async () => {
  const aliases = ['grok-remediation', 'grok', 'grok-api', 'grok-reviewer', 'remediator-grok', 'hammer-grok'];
  for (const builderTag of aliases) {
    for (const primary of aliases) {
      const result = await resolveRemediationWorkerClassWithFallback({ primary, job: { builderTag }, ...options,
        ensureWorkerRegistryReadyImpl: () => assert.fail('same-family actor reached account selection') });
      assert.equal(result.hold, true);
    }
    const result = await resolveClaimedRemediatorRouting({ primary: 'codex', job: { builderTag }, ...options,
      ensureWorkerRegistryReadyImpl: async () => {},
      resolveImpl: async () => ({ workerClass: 'remediator-grok', hold: false, authPath: 'api-key' }) });
    assert.equal(result.hold, true);
  }
  assert.equal(remediationSubjectRefusal({}, 'remediator-grok', options), 'unknown-builder-family');
});

test('enabled other-family routing reaches the Grok pool and retains its class', async () => {
  const seen = [];
  const result = await resolveRemediationWorkerClassWithFallback({ primary: 'remediator-grok',
    job: { builderTag: 'codex' }, ...options, modelForClass: () => 'grok-build',
    ensureWorkerRegistryReadyImpl: async () => {},
    selectAccountImpl: async request => { seen.push(request.identity); return {
      status: 'selected', identity: request.identity, workerClass: request.identity, pooled: true, hold: false,
    }; } });
  assert.deepEqual(seen, ['remediator-grok']);
  assert.equal(result.workerClass, 'remediator-grok');
  assert.equal(result.hold, false);
  seen.length = 0;
  const fallback = await resolveRemediationWorkerClassWithFallback({ primary: 'codex',
    fallbackWorkerClasses: ['remediator-grok'], job: { builderTag: 'claude-code' }, ...options,
    modelForClass: () => 'grok-build', ensureWorkerRegistryReadyImpl: async () => {},
    selectAccountImpl: async ({ identity }) => {
      seen.push(identity);
      return { identity, workerClass: identity, pooled: true,
        hold: identity === 'remediator-codex',
        status: identity === 'remediator-codex' ? 'unavailable' : 'selected',
        reason: identity === 'remediator-codex' ? 'accounts-unavailable' : 'preferred-ready' };
    } });
  assert.deepEqual(seen, ['remediator-codex', 'remediator-grok']);
  assert.equal(fallback.workerClass, 'remediator-grok');
  assert.equal(fallback.fellBack, true);
  assert.equal(fallback.fallbackProvider, 'xai');
});

test('Grok pool proposal uses the normalized family for either account kind', async () => {
  for (const kind of ['oauth', 'api-key']) {
    const contract = JSON.parse(readFileSync(new URL('./fixtures/identity-token-pools.v1.json', import.meta.url)));
    const oauth = structuredClone(contract.declarations.find(item => item.name === 'grok-two-subscriptions-and-key').oauth);
    const account = kind === 'oauth' ? 'subscription-a' : 'key-c';
    oauth.identity_token_pools = { 'remediator-grok': [account] };
    // The proposal owner validates the declarations; this fixture verifies family forwarding.
    let family;
    await selectWorkerTokenAccount({ identity: 'remediator-grok', model: 'grok-build', oauth,
      ownerImpl: async request => { family = request.family; return { held: 'capacity-saturated' }; } });
    assert.equal(family, 'grok');
  }
});

test('closer selection is explicitly refused even with both switches enabled', () => {
  const dir = mkdtempSync(join(tmpdir(), 'grok-closer-'));
  try {
    const topPath = join(dir, 'config.yaml');
    for (const selection of [
      '  merge_agent_worker_class: hammer-grok\n',
      '  adversarial:\n    merge_authority:\n      worker_class: hammer-grok\n',
      '  adversarial:\n    merge_authority:\n      worker_class_fallback: [hammer-grok]\n',
    ]) {
      writeFileSync(topPath, 'version: 1\ngrok:\n  enabled: true\n  hammer:\n    enabled: true\nroles:\n' + selection);
      assert.throws(() => loadConfig({ topPath, env: {} }), /grok-closer-pending-merge-authority-v2/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
