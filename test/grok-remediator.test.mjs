import assert from 'node:assert/strict';
import test from 'node:test';
import { remediationSubjectRefusal, resolveClaimedRemediatorRouting,
  resolveRemediationWorkerClassWithFallback, remediationLaneRuntimeMode,
  remediationLaneModeRefusal } from '../src/remediation-worker-class-fallback.mjs';
import { normalizeRemediationWorkerClass, hqRemediationWorkerClass } from '../src/remediation-worker-class.mjs';
import { remediationWorkerTrailerClass, remediationWorkerGitIdentity } from '../src/remediation-worker-provenance.mjs';
import { selectWorkerTokenAccount } from '../src/worker-token-pool.mjs';
import { loadConfig } from '../src/config-loader.mjs';
import { pickRemediationWorkerClass, resolveReconcileWorkerClass } from '../src/remediation-worker-routing.mjs';
import { remediatorClassForQuotaLabel, remediatorQuotaEvidence } from '../src/remediation-quota-evidence.mjs';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildRemediationOutcomeCommentBody } from '../src/adapters/comms/github-pr-comments/pr-comments.mjs';
import { recoverGithubAuthOperationalBlocker } from '../src/github-auth-recovery.mjs';

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
  assert.equal(remediationWorkerGitIdentity('remediator-grok', {}).email,
    'grok-remediation-worker@laceyenterprises.com');
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

test('enabled Grok pin routes Grok-built PRs to their non-Grok default before account selection', async () => {
  const pinnedLoader = () => ({ get: (key, fallback) =>
    key === 'roles.remediator' ? 'remediator-grok' : loaderImpl().get(key, fallback) });
  assert.equal(pickRemediationWorkerClass({ builderTag: 'codex' }, {
    env, loaderImpl: pinnedLoader,
  }), 'remediator-grok');
  for (const builderTag of ['grok', 'grok-api', 'grok-remediation', 'remediator-grok', 'hammer-grok']) {
    const job = { builderTag };
    const primary = pickRemediationWorkerClass(job, { env, loaderImpl: pinnedLoader });
    assert.equal(primary, 'remediator-codex');
    const seen = [];
    const result = await resolveRemediationWorkerClassWithFallback({
      primary, job, env, loaderImpl: pinnedLoader,
      ensureWorkerRegistryReadyImpl: async () => {}, modelForClass: () => 'synthetic-model',
      selectAccountImpl: async ({ identity }) => {
        seen.push(identity);
        return { identity, workerClass: identity, pooled: true, hold: false, status: 'selected' };
      },
      execFileImpl: () => assert.fail('selected pool must not read fleet status'),
    });
    assert.equal(result.workerClass, 'remediator-codex');
    assert.equal(result.hold, false);
    assert.deepEqual(seen, ['remediator-codex']);
  }
});

test('unpooled Grok quota holds reroute on the next claim without fleet evidence', async () => {
  const nowMs = Date.parse('2026-11-10T00:00:00Z');
  for (const label of ['remediator-grok', 'grok', 'grok-remediation']) {
    assert.equal(remediatorClassForQuotaLabel(label), 'remediator-grok');
    const job = { builderTag: 'codex', remediationPlan: { retryHistory: [{
      requeuedAt: '2026-11-09T23:55:00Z',
      retryMetadata: { code: 'quota-exhausted', workerClass: label,
        providerResetAt: '2026-11-11T00:00:00Z' },
    }] } };
    assert.equal(remediatorQuotaEvidence(job, { nowMs }).get('remediator-grok').pastHoldWindow, true);
    const result = await resolveRemediationWorkerClassWithFallback({
      primary: 'remediator-grok', fallbackWorkerClasses: ['claude-code'], job, nowMs, ...options,
      ensureWorkerRegistryReadyImpl: async () => {}, modelForClass: () => 'synthetic-model',
      selectAccountImpl: async () => null, execFileImpl: null,
    });
    assert.equal(result.workerClass, 'claude-code');
    assert.equal(result.fellBack, true);
    assert.equal(result.hold, false);
    assert.equal(result.capSource, 'provider-reset-past-hold-window');
  }
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
    ]) {
      writeFileSync(topPath, 'version: 1\ngrok:\n  enabled: true\n  hammer:\n    enabled: true\nroles:\n' + selection);
      assert.throws(() => loadConfig({ topPath, env: {} }), /grok-closer-pending-merge-authority-v2/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Grok pin bypass survives reconciliation comments and auth recovery', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'grok-reconcile-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const overrides = { AGENT_OS_CONFIG_PATH: '/dev/null',
    AGENT_OS_ROLES_REMEDIATOR: 'remediator-grok',
    ADVERSARIAL_REVIEW_DEFAULT_REMEDIATOR: 'remediator-grok',
    AGENT_OS_GROK_ENABLED: 'true', AGENT_OS_GROK_REMEDIATOR_ENABLED: 'true' };
  const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  t.after(() => { for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  for (const builderTag of ['grok', 'grok-api', 'grok-remediation']) {
    const worker = { model: 'remediator-codex', resolvedModel: 'synthetic-codex' };
    const job = { builderTag, jobId: 'synthetic', repo: 'fixture/repo', prNumber: 1,
      branch: 'fixture', finalRound: 'comment-only', remediationWorker: worker };
    assert.equal(resolveReconcileWorkerClass(job, worker), 'remediator-codex');
    assert.equal(resolveReconcileWorkerClass(job, {}), 'remediator-codex');
    const body = buildRemediationOutcomeCommentBody({ job, worker, action: 'completed',
      workerClass: resolveReconcileWorkerClass(job, worker) });
    assert.match(body, /## Remediation Worker \(remediator-codex\)/);
    assert.match(body, /> Remediator: codex · synthetic-codex/);
    let recoveryClass;
    const result = await recoverGithubAuthOperationalBlocker({
      reply: { operationalBlockers: [{ title: 'github-auth', finding: 'Expired credential',
        commitSha: 'a'.repeat(40), expectedRemoteSha: 'b'.repeat(40) }] },
      hqRoot: rootDir, workspaceDir: rootDir, rootDir, job, worker,
      completedAt: '2026-11-10T00:00:00Z', resolveWorkerClass: resolveReconcileWorkerClass,
      execFileImpl: async () => ({ stdout: '', stderr: '' }),
      retryGithubAuthPushOnceImpl: async ({ workerClass }) => {
        recoveryClass = workerClass;
        return { retried: true, pushed: false };
      },
    });
    assert.equal(result.operationalBlockerRecovery.rescue.preserved, true);
    assert.equal(recoveryClass, 'remediator-codex');
  }
  assert.equal(resolveReconcileWorkerClass({ builderTag: 'codex' }, {}), 'remediator-grok');
});
