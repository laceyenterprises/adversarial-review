import assert from 'node:assert/strict';
import test from 'node:test';
import { remediationSubjectRefusal, resolveClaimedRemediatorRouting,
  resolveRemediationWorkerClassWithFallback, remediationLaneRuntimeMode,
  remediationLaneModeRefusal } from '../src/remediation-worker-class-fallback.mjs';
import { normalizeRemediationWorkerClass, hqRemediationWorkerClass } from '../src/remediation-worker-class.mjs';
import { remediationWorkerTrailerClass, remediationWorkerGitIdentity } from '../src/remediation-worker-provenance.mjs';
import { selectWorkerTokenAccount } from '../src/worker-token-pool.mjs';
import { AgentOSConfigError, loadConfig } from '../src/config-loader.mjs';
import { findingBatchDispatchArgs } from '../src/findings-batch.mjs';
import { pickRemediationWorkerClass, resolveReconcileWorkerClass } from '../src/remediation-worker-routing.mjs';
import { remediatorClassForQuotaLabel, remediatorQuotaEvidence } from '../src/remediation-quota-evidence.mjs';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildRemediationOutcomeCommentBody } from '../src/adapters/comms/github-pr-comments/pr-comments.mjs';
import { recoverGithubAuthOperationalBlocker } from '../src/github-auth-recovery.mjs';
import { stopClaimedJobForRefusedSubject } from '../src/remediation-claimed-requeue.mjs';
import { createFollowUpJob, claimNextFollowUpJob, readFollowUpJob } from '../src/follow-up-jobs.mjs';
import { consumeNextFollowUpJob } from '../src/follow-up-remediation.mjs';

const env = { AGENT_OS_CONFIG_PATH: '/dev/null', HQ_ROOT: tmpdir() };
const loaderImpl = () => ({ get: (key, fallback) =>
  ['grok.enabled', 'grok.remediator.enabled'].includes(key) ? true : fallback });
const options = { env, loaderImpl };

test('both batch launch shapes replace a Grok pin when builder provenance is unavailable', () => {
  const config = { env, loaderImpl: () => ({ get: (key, fallback) =>
    key === 'roles.remediator' ? 'remediator-grok'
      : ['grok.enabled', 'grok.remediator.enabled'].includes(key) ? true : fallback }) };
  const workerClass = pickRemediationWorkerClass({ repo: 'sample/project' }, config);
  assert.equal(workerClass, 'remediator-grok');
  for (const branch of [null, 'fixture/batch']) {
    for (const candidate of [workerClass, 'grok-api', 'grok-remediation', 'remediator-claude-corp']) {
      const args = findingBatchDispatchArgs({
        batch: { batch_id: 'fixture', repo: 'sample/project' },
        workerClass: candidate, promptPath: '/fixture/prompt.md', env, branch,
      });
      assert.equal(args[args.indexOf('--worker-class') + 1],
        candidate === 'remediator-claude-corp' ? candidate : 'codex');
      assert.equal(args[args.indexOf('--completion-shape') + 1], branch ? 'pr' : 'decision-only');
    }
  }
});

test('consumer requeues config failure arising after initial Grok selection', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'grok-config-retry-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  createFollowUpJob({ rootDir, repo: 'sample/project', prNumber: 42,
    branch: 'fixture/remediation', builderTag: 'codex', reviewerModel: 'gemini',
    reviewBody: '## Blocking issues\n- Synthetic finding\n\n## Verdict\nRequest changes',
    critical: true, reviewPostedAt: '2026-10-19T00:00:00Z' });
  let configFailed = false;
  const error = new AgentOSConfigError('configuration changed during routing', { key: 'grok.enabled' });
  await assert.rejects(consumeNextFollowUpJob({
    rootDir, promptTemplate: 'Synthetic remediation prompt.',
    loaderImpl: () => {
      if (configFailed) throw error;
      return { get: (key, fallback) => key === 'roles.remediator' ? 'remediator-grok'
        : ['grok.enabled', 'grok.remediator.enabled'].includes(key) ? true : fallback };
    },
    healthRouter: { getMode: () => 'local' },
    ensureWorkerRegistryReadyImpl: async () => {},
    resolvePRLifecycleImpl: async () => null,
    resolveRemediationWorkerClassImpl: async args => {
      assert.equal(args.primary, 'remediator-grok');
      configFailed = true;
      return { workerClass: args.primary, hold: false };
    },
    execFileImpl: () => assert.fail('config failure must not execute a subprocess'),
    spawnImpl: () => assert.fail('config failure must not spawn'),
    log: { error() {}, warn() {} },
  }), caught => {
    assert.equal(caught, error);
    assert.equal(caught.isRemediationConfigError, true);
    assert.equal(caught.followUpJobRequeued, true);
    const job = readFollowUpJob(caught.followUpJobPath);
    assert.equal(job.status, 'pending');
    assert.equal(job.remediationPlan.currentRound, 0);
    assert.equal(job.remediationPlan.stop, null);
    return true;
  });
});

for (const source of ['loader', 'path']) {
  test(`consumer retains ${source} config throughout initial Grok routing`, async t => {
    const rootDir = mkdtempSync(join(tmpdir(), 'grok-initial-config-'));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const topPath = join(rootDir, 'config.yaml');
    writeFileSync(topPath, JSON.stringify({ version: 1, roles: { remediator: 'remediator-grok' },
      grok: { enabled: true, remediator: { enabled: true } } }));
    const injectedLoader = args => {
      assert.equal(args.topPath, topPath);
      return { get: (key, fallback) => key === 'roles.remediator' ? 'remediator-grok'
        : ['grok.enabled', 'grok.remediator.enabled'].includes(key) ? true : fallback };
    };
    const config = { topPath, ...(source === 'loader' ? { loaderImpl: injectedLoader } : {}) };
    // Make ambient defaults disagree, so dropping either option changes the route.
    const overrides = { AGENT_OS_CONFIG_PATH: '/dev/null',
      AGENT_OS_ROLES_REMEDIATOR: undefined,
      ADVERSARIAL_REVIEW_DEFAULT_REMEDIATOR: undefined };
    const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    t.after(() => { for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    } });
    createFollowUpJob({ rootDir, repo: 'sample/project', prNumber: 42,
      branch: 'fixture/remediation', builderTag: 'codex', reviewerModel: 'gemini',
      reviewBody: '## Blocking issues\n- Synthetic finding\n\n## Verdict\nRequest changes',
      critical: true, reviewPostedAt: '2026-10-19T00:00:00Z' });
    let routed = false;
    const result = await consumeNextFollowUpJob({ rootDir, ...config,
      promptTemplate: 'Synthetic remediation prompt.',
      ensureWorkerRegistryReadyImpl: async () => {},
      resolvePRLifecycleImpl: async () => null,
      healthRouter: { getMode: () => 'local' },
      resolveRemediationWorkerClassImpl: async args => {
        routed = true;
        assert.equal(args.primary, 'remediator-grok');
        assert.equal(args.topPath, topPath);
        assert.equal(args.loaderImpl, config.loaderImpl);
        return { workerClass: args.primary, hold: true, reason: 'accounts-unavailable' };
      },
      execFileImpl: () => assert.fail('held lane must not execute a subprocess'),
      spawnImpl: () => assert.fail('held lane must not spawn'),
      log: { error() {}, warn() {} },
    });
    assert.equal(routed, true);
    assert.equal(result.reason, 'remediator-capped-hold');
    assert.equal(result.job.status, 'pending');
    assert.equal(result.job.remediationPlan.currentRound, 0);
  });
}

test('subject stop ignores absent routing classes before touching job state', () => {
  for (const routing of [undefined, null, {}, { workerClass: null }, { workerClass: '' }]) {
    assert.equal(stopClaimedJobForRefusedSubject({ routing }), null);
  }
});

test('subject stop ignores missing claimed job containers', () => {
  for (const claimed of [undefined, null, {}, { job: null }]) {
    assert.equal(stopClaimedJobForRefusedSubject({
      claimed, routing: { workerClass: 'remediator-grok' },
      loaderImpl: () => assert.fail('missing job must not load configuration'),
    }), null);
  }
});

for (const source of ['loader', 'path']) for (const enabled of [true, false]) {
  test(`subject stop retains ${source} config with Grok enabled=${enabled}`, t => {
    const rootDir = mkdtempSync(join(tmpdir(), 'grok-subject-config-'));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const topPath = join(rootDir, 'config.yaml');
    writeFileSync(topPath, JSON.stringify({ version: 1, grok: {
      enabled, remediator: { enabled },
    } }));
    createFollowUpJob({ rootDir, repo: 'sample/project', prNumber: 42, builderTag: 'codex',
      branch: 'fixture/remediation', reviewerModel: 'gemini', critical: true,
      reviewBody: '## Verdict\nRequest changes', reviewPostedAt: '2026-10-19T00:00:00Z' });
    const claimed = claimNextFollowUpJob({ rootDir });
    assert.ok(claimed && !claimed.stopped);
    const configEnv = { AGENT_OS_CONFIG_PATH: '/dev/null',
      ...(source === 'loader' ? {
        AGENT_OS_GROK_ENABLED: String(!enabled),
        AGENT_OS_GROK_REMEDIATOR_ENABLED: String(!enabled),
      } : {}) };
    let loads = 0;
    const injectedLoader = args => {
      loads++;
      assert.equal(args.topPath, topPath);
      assert.deepEqual(args.env, configEnv);
      return { get: (key, fallback) =>
        ['grok.enabled', 'grok.remediator.enabled'].includes(key) ? enabled : fallback };
    };
    const result = stopClaimedJobForRefusedSubject({
      rootDir, claimed, routing: { workerClass: 'remediator-grok' }, env: configEnv,
      topPath, ...(source === 'loader' ? { loaderImpl: injectedLoader } : {}),
      log: { error() {} },
    });
    assert.equal(loads, source === 'loader' ? 1 : 0);
    if (enabled) {
      assert.equal(result, null);
      assert.equal(readFollowUpJob(claimed.jobPath).status, 'in_progress');
    } else {
      assert.equal(result.reason, 'subject-refused');
      assert.equal(result.job.status, 'stopped');
      assert.match(result.job.remediationPlan.stop.reason, /grok-remediator-disabled/);
    }
  });
}

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
