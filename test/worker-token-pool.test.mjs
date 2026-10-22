import { resolveOsgRemediatorRoute } from '../src/osg-remediator.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFollowUpJob } from '../src/follow-up-jobs.mjs';
import { consumeNextFollowUpJob } from '../src/follow-up-remediation.mjs';
import { resolveCloserDispatchHarness } from '../src/ama/harness-fallback.mjs';
import { resolveRemediationWorkerClassWithFallback } from '../src/remediation-worker-class-fallback.mjs';
import { selectCodexWorkerAccount } from '../src/codex-account-routing.mjs';
import { codexAccountFixture } from './helpers/codex-account-fixture.mjs';
import { buildLegacyHqRemediationDispatchArgs } from '../src/remediation-dispatch-mode.mjs';
import { resolveRemediationModel } from '../src/adapters/agent-runtime/local/remediation.mjs';
import { resolveConfiguredNonBlockingCodexModel } from '../src/adapters/agent-runtime/local/non-blocking-codex-model.mjs';
import { remediationWorkerGitIdentity } from '../src/remediation-worker-provenance.mjs';

const pool = await import('../src/worker-token-pool.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
const defaults = JSON.parse(readFileSync(new URL('./fixtures/identity-token-selection.v1.json', import.meta.url))).defaults;
function wireFor(identity, index = 0) {
  const value = structuredClone(defaults);
  const family = identity.includes('claude') ? 'claude' : 'codex';
  const members = family === 'codex' ? ['openai-corporate', 'openai-primary'] : ['anthropic-corporate', 'anthropic-primary'];
  value.oauth.identity_token_pools[identity] = members;
  value.request.identity = value.request.snapshot.identity = identity;
  value.request.family = family;
  value.request.identity_models = value.request.requested_models = value.request.snapshot.requested_models = [family === 'codex' ? 'gpt-6' : 'opus'];
  value.selection = { version: 1, identity, generation: value.request.generation,
    status: 'selected', account_id: members[index], reason: index ? 'fallback-ready' : 'preferred-ready',
    considered: members.slice(0, index + 1).map((id, i) => ({ account_id: id,
      reason: i === index ? 'ready' : 'quota-exhausted', component: i === index ? null : 'quota' })) };
  return value;
}

for (const identity of ['hammer', 'hammer-claude', 'remediator-codex', 'remediator-claude']) {
  for (const index of [0, 1]) test(`ITP-14 ${identity} account ${index} keeps canonical privileged dispatch`, async () => {
    assert.equal(typeof pool.selectWorkerTokenAccount, 'function');
    const wire = wireFor(identity, index);
    const selected = await pool.selectWorkerTokenAccount({ identity, oauth: wire.oauth,
      model: wire.request.requested_models[0], env: {}, ownerImpl: async request => {
        assert.equal(request.identity, identity);
        assert.equal(request.operation, 'propose');
        assert.equal(request.taskKind, identity.startsWith('hammer') ? 'merge' : 'coding');
        return wire;
      } });
    assert.equal(selected.hold, false);
    assert.equal(selected.workerClass, identity);
    assert.equal(selected.tokenAccountId, wire.selection.account_id);
    assert.equal(selected.brokerProvider, wire.oauth.token_accounts[wire.selection.account_id].broker_provider);
    assert.equal(selected.lease, undefined, 'dispatcher owns acquisition');
    const selectAccountImpl = async requested => {
      assert.equal(requested.identity, identity);
      return selected;
    };
    const routed = identity.startsWith('hammer')
      ? await resolveCloserDispatchHarness({ workerClass: identity, selectAccountImpl, env: {}, execFileImpl: () => assert.fail('no legacy quota read') })
      : await resolveRemediationWorkerClassWithFallback({ primary: identity, selectAccountImpl, env: {}, execFileImpl: () => assert.fail('no legacy quota read') });
    assert.equal(routed.workerClass, identity);
    assert.equal(routed.tokenAccountId, selected.tokenAccountId);
    assert.equal(routed.fellBack, false);
    if (identity.startsWith('remediator')) {
      assert.ok(remediationWorkerGitIdentity(identity, {}).name);
      const args = buildLegacyHqRemediationDispatchArgs({ workerClass: routed.workerClass });
      assert.equal(args[args.indexOf('--worker-class') + 1], identity);
      assert.equal(args.includes('--harness'), false);
    }
  });
}

test('ITP-14 exhausted hammer pool retains only declared cross-family hammer edge', async () => {
  const seen = [];
  const result = await resolveCloserDispatchHarness({ workerClass: 'hammer',
    fallbackWorkerClasses: ['hammer-corp', 'claude-code', 'hammer-claude'], env: {},
    selectAccountImpl: async ({ identity }) => {
      seen.push(identity);
      return { pooled: true, identity, workerClass: identity, hold: identity === 'hammer',
        status: identity === 'hammer' ? 'unavailable' : 'selected', reason: 'accounts-unavailable' };
    }, execFileImpl: () => assert.fail('no legacy quota read') });
  assert.equal(result.workerClass, 'hammer-claude');
  assert.deepEqual(seen, ['hammer', 'hammer-claude']);
  assert.equal(result.fellBack, true);
});

test('ITP-14 unknown primary holds before any fallback; remediation family exclusion precedes account read', async () => {
  const seen = [];
  const run = status => resolveRemediationWorkerClassWithFallback({ primary: 'codex',
    fallbackWorkerClasses: ['remediator-codex-corp', 'remediator-claude'], reviewerModels: ['claude'], env: {},
    selectAccountImpl: async ({ identity }) => {
      seen.push(identity);
      return { pooled: true, identity, workerClass: identity, hold: true, status, reason: 'evidence-unknown' };
    }, execFileImpl: () => assert.fail('no legacy quota read') });
  assert.equal((await run('held')).hold, true);
  assert.deepEqual(seen, ['remediator-codex']);
  seen.length = 0;
  assert.equal((await run('unavailable')).hold, true);
  assert.deepEqual(seen, ['remediator-codex']);
});

test('ITP-14 default Codex worker order is corporate-first and unknown preferred evidence holds', () => {
  assert.equal(selectCodexWorkerAccount(codexAccountFixture()).provider, 'codex-corp');
  const fixture = codexAccountFixture();
  delete fixture.brokerAuth.provider_states['codex-corp'];
  assert.equal(selectCodexWorkerAccount(fixture).hold, true);
});

for (const family of ['codex', 'claude']) for (const index of [0, 1]) for (const experiment of [false, true]) test(`${experiment ? 'OSG-14 assigned arm' : 'ITP-14'} real ${family} remediation claim account ${index} dispatches remediator without local credentials`, async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'itp14-claim-'));
  const hqRoot = join(rootDir, 'hq');
  const workspaceDir = join(rootDir, 'worker');
  mkdirSync(hqRoot); mkdirSync(workspaceDir);
  const overrides = { AGENT_OS_CONFIG_PATH: '/dev/null', AGENT_OS_ROLES_REMEDIATOR: 'adversarial',
    ADVERSARIAL_REVIEW_DEFAULT_REMEDIATOR: undefined,
    AGENT_OS_ROLES_ADVERSARIAL_ORCHESTRATION_MODE: 'native', ADV_WITH_HQ_INTEGRATION: '1',
    HQ_ROOT: hqRoot, HQ_PARENT_SESSION: 'synthetic-parent', HQ_PROJECT: 'synthetic-project',
    CODEX_AUTH_PATH: join(rootDir, 'absent-auth.json') };
  const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  const apply = values => { for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } };
  apply(overrides);
  t.after(() => { apply(previous); rmSync(rootDir, { recursive: true, force: true }); });
  createFollowUpJob({ branch: 'fixture/remediation', rootDir, repo: 'sample/project', prNumber: 42, builderTag: family === 'codex' ? 'claude-code' : 'codex',
    reviewerModel: 'gemini', reviewBody: '## Verdict\nRequest changes', critical: true,
    reviewPostedAt: '2026-10-19T00:00:00Z' });
  const dispatches = [];
  const identity = `remediator-${family}`;
  const wire = wireFor(identity, index);
  const result = await consumeNextFollowUpJob({ rootDir, promptTemplate: 'Synthetic remediation prompt.',
    guardStackedBaseImpl: async () => null, resolvePRLifecycleImpl: async () => null,
    ...(experiment ? { resolveOsgRemediatorRouteImpl: options => {
      const arm = { role: 'remediator', harness: family, worker_class: identity,
        model: wire.request.requested_models[0], effort: 'low', account: wire.selection.account_id };
      return resolveOsgRemediatorRoute({ ...options, mode: 'apply',
        ownerImpl: async () => ({ reason: 'assigned', worker_class: identity, arm, effort: 'low',
          assignment: { assignment_id: 'fixture-assignment', ticket_key: 'fixture/T-1',
            mode: 'apply', experiment: 'remediator', arm, propensity: 0.5 } }),
        selectAccountImpl: async () => ({ pooled: true, status: 'selected', identity,
          hold: false, tokenAccountId: arm.account }), recordImpl: () => {} });
    } } : {}),
    resolveRemediationWorkerClassImpl: args => resolveRemediationWorkerClassWithFallback({ ...args,
      selectAccountImpl: request => pool.selectWorkerTokenAccount({ ...request, oauth: wire.oauth,
        model: wire.request.requested_models[0], ownerImpl: async () => wire }),
      execFileImpl: async () => ({ stdout: '{}' }) }),
    execFileImpl: async (command, args) => {
      if (command === 'gh' && args[0] === 'api' && args[1].endsWith('/pulls/42')) return { stdout: JSON.stringify({
        base: { ref: 'main' }, head: { ref: 'fixture-branch', repo: { full_name: 'sample/project' } } }) };
      if (args[0] === 'dispatch' && args[1] === 'status') return { stdout: JSON.stringify({ status: 'running', workspaceDir }) };
      if (args[0] === 'dispatch') {
        dispatches.push(args);
        return { stdout: JSON.stringify({ dispatchId: 'fixture-dispatch', launchRequestId: 'fixture-lrq' }) };
      }
      return { stdout: '' };
    }, spawnImpl: () => assert.fail('managed dispatch required'),
    postCommentImpl: async () => {}, deliverAlertImpl: async () => {},
    log: { info() {}, warn() {}, log() {}, error() {} } });
  assert.equal(result.consumed, true, JSON.stringify(result));
  assert.equal(result.job.remediationWorker.workerClass, identity);
  assert.equal(result.job.remediationWorker.accountProposal.tokenAccountId, wire.selection.account_id);
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0][dispatches[0].indexOf('--worker-class') + 1], identity);
  assert.equal(dispatches[0].includes('--harness'), false);
  if (experiment) {
    assert.equal(dispatches[0][dispatches[0].indexOf('--model') + 1], wire.request.requested_models[0]);
    assert.equal(dispatches[0][dispatches[0].indexOf('--reasoning-level') + 1], 'low');
    assert.equal(result.job.remediationWorker.osgRemediator.reason, 'assigned');
  }
});

test('ITP-14 pooled routing preserves the declared infrastructure fallback', async () => {
  const result = await resolveRemediationWorkerClassWithFallback({ primary: 'codex', env: {},
    execFileImpl: () => assert.fail('no legacy quota read'),
    fallbackWorkerClasses: ['remediator-codex-corp', 'remediator-claude'],
    job: { remediationPlan: { currentRound: 1, retryHistory: [{ round: 1,
      retryMetadata: { code: 'infrastructure-refund', workerClass: 'remediator-codex',
        harnessSpecific: true, reason: 'codex-tool-host-unavailable' } }] } },
    selectAccountImpl: async ({ identity }) => ({ identity, workerClass: identity,
      pooled: true, hold: false, status: 'selected', reason: 'preferred-ready' }) });
  assert.equal(result.workerClass, 'remediator-claude');
  assert.equal(result.reason, 'infrastructure-fallback');
});

test('ITP-14 invalid owner requests/results and unreadable configuration hold without fallback', async () => {
  for (const mutate of [
    w => { w.request.identity = 'codex'; },
    w => { w.request.family = 'claude'; },
    w => { w.selection.version = 2; },
    w => { w.selection.account_id = 'undeclared'; },
    w => { w.selection.access_token = 'synthetic-secret-sentinel'; },
  ]) {
    const wire = wireFor('remediator-codex'); mutate(wire);
    const result = await pool.selectWorkerTokenAccount({ identity: 'remediator-codex',
      oauth: wire.oauth, model: 'gpt-6', env: {}, ownerImpl: async () => wire });
    assert.equal(result.hold, true);
    assert.equal(result.status, 'held');
    assert.equal(result.tokenAccountId, undefined);
    assert.equal(JSON.stringify(result).includes('synthetic-secret'), false);
  }
  const result = await pool.selectWorkerTokenAccount({ identity: 'hammer', env: {},
    resolvePoolsImpl: () => { throw new Error('synthetic unreadable configuration'); },
    ownerImpl: () => assert.fail('must not read owner') });
  assert.equal(result.hold, true);
});

test('ITP-14 enrolling a pool cannot silently reinterpret an existing personal class pin', async () => {
  const wire = wireFor('hammer');
  const result = await pool.selectWorkerTokenAccount({ identity: 'hammer', oauth: wire.oauth,
    model: 'gpt-6', env: {}, legacyAccountPinned: true,
    ownerImpl: () => assert.fail('operator must resolve legacy pin first') });
  assert.equal(result.hold, true);
  assert.equal(result.reason, 'legacy-account-pin-requires-migration');
  assert.equal(result.tokenAccountId, undefined);
});

test('ITP-14 model/selection failures hold before closer legacy error recovery', async () => {
  for (const failModel of [false, true]) {
    const result = await resolveCloserDispatchHarness({ workerClass: 'hammer', env: {},
      modelForWorkerClass: () => { if (failModel) throw new Error('synthetic model unavailable'); return 'gpt-6'; },
      selectAccountImpl: async () => { throw new Error('synthetic owner unavailable'); },
      execFileImpl: () => assert.fail('no legacy fleet read') });
    assert.equal(result.hold, true);
    assert.equal(result.reason, 'evidence-unknown');
  }
});

for (const primary of ['remediator-codex', 'remediator-claude']) {
  for (const modelForClass of [undefined, null, () => 'synthetic-model']) {
    test(`direct pooled ${primary} resolves models with ${typeof modelForClass} callback`, async t => {
      const hqRoot = mkdtempSync(join(tmpdir(), 'itp14-model-'));
      t.after(() => rmSync(hqRoot, { recursive: true, force: true }));
      mkdirSync(join(hqRoot, 'registry'));
      writeFileSync(join(hqRoot, 'registry', 'worker-classes.json'), JSON.stringify({ classes: {
        [primary]: { defaultModel: primary.includes('codex') ? 'gpt-6' : 'opus' },
      } }));
      const env = { HQ_ROOT: hqRoot, AGENT_OS_CONFIG_PATH: '/dev/null' };
      const wire = wireFor(primary);
      const expected = modelForClass?.(primary)
        ?? resolveRemediationModel(primary, { env, fallbackModel: null }).resolvedModel;
      assert.ok(expected);
      for (const account of Object.values(wire.oauth.token_accounts)) {
        account.allowed_models = [...new Set([...account.allowed_models, expected])];
      }
      wire.request.identity_models = wire.request.requested_models = wire.request.snapshot.requested_models = [expected];
      let ownerCalls = 0;
      const result = await resolveRemediationWorkerClassWithFallback({ primary, env, modelForClass,
        selectAccountImpl: request => pool.selectWorkerTokenAccount({ ...request, oauth: wire.oauth,
          ownerImpl: async request => {
            ownerCalls++;
            assert.equal(request.model, expected);
            return wire;
          } }),
        execFileImpl: () => assert.fail('no legacy fleet read') });
      assert.equal(ownerCalls, 1);
      assert.equal(result.hold, false);
      assert.equal(result.workerClass, primary);
    });
  }
}

test('direct pooled Codex resolver preserves the job non-blocking model', async () => {
  const env = { AGENT_OS_CONFIG_PATH: '/dev/null' };
  const expected = resolveConfiguredNonBlockingCodexModel(env).resolvedModel;
  let selected = false;
  const result = await resolveRemediationWorkerClassWithFallback({ primary: 'codex', env,
    job: { nonBlockingOnly: true },
    selectAccountImpl: async ({ identity, model }) => {
      selected = true;
      assert.equal(model, expected);
      return { pooled: true, workerClass: identity, status: 'selected', hold: false };
    }, execFileImpl: () => assert.fail('no legacy fleet read') });
  assert.equal(selected, true);
  assert.equal(result.hold, false);
});

test('local pooled remediation defers a full minute after an aged claim without spending a round', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'itp14-local-hold-'));
  const overrides = { AGENT_OS_CONFIG_PATH: '/dev/null', AGENT_OS_ROLES_REMEDIATOR: 'adversarial',
    ADVERSARIAL_REVIEW_DEFAULT_REMEDIATOR: undefined,
    AGENT_OS_ROLES_ADVERSARIAL_ORCHESTRATION_MODE: 'native', ADV_WITH_HQ_INTEGRATION: '0' };
  const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  const apply = values => { for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } };
  apply(overrides);
  t.after(() => { apply(previous); rmSync(rootDir, { recursive: true, force: true }); });
  createFollowUpJob({ branch: 'fixture/remediation', rootDir, repo: 'sample/project', prNumber: 42, builderTag: 'claude-code',
    reviewerModel: 'gemini', reviewBody: '## Verdict\nRequest changes', critical: true,
    reviewPostedAt: '2026-10-19T00:00:00Z' });
  let clockMs = Date.parse('2026-10-21T10:00:00Z');
  const result = await consumeNextFollowUpJob({ rootDir, promptTemplate: 'Synthetic remediation prompt.',
    now: () => new Date(clockMs).toISOString(),
    resolvePRLifecycleImpl: async () => null,
    resolveRemediationWorkerClassImpl: async () => {
      clockMs += 5 * 60_000;
      return { pooled: true, workerClass: 'remediator-codex', hold: false };
    },
    execFileImpl: () => assert.fail('must hold before workspace preparation'),
    spawnImpl: () => assert.fail('must not spawn an unleased proposal'),
    log: { info() {}, warn() {}, log() {}, error() {} } });
  assert.equal(result.consumed, false);
  assert.equal(result.reason, 'remediator-capped-hold');
  assert.equal(result.job.status, 'pending');
  assert.equal(result.job.remediationPlan.currentRound, 0);
  assert.equal(result.job.remediationPlan.retryAfter, new Date(clockMs + 60_000).toISOString());
  assert.equal(result.job.pendingAt, new Date(clockMs).toISOString());
  assert.equal(result.job.remediationPlan.retryHistory.at(-1).retryMetadata.fallbackReason,
    'pooled-remediation-requires-dispatch');
});
