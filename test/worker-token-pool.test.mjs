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
import { poolConflictFixture } from './helpers/pool-conflict-fixture.mjs';

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

test('ITPROLEPOOL-01 canonical selectors let pooled hammer reach the account owner', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'canonical-pool-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const topPath = join(dir, 'config.yaml');
  const wire = wireFor('hammer');
  writeFileSync(topPath, JSON.stringify({ version: 1, oauth: wire.oauth, roles: {
    remediator: 'codex', merge_agent_worker_class: 'hammer', build_pack_default_worker_class: 'codex',
    adversarial: { merge_authority: { worker_class: 'hammer' } },
  } }));
  let proposals = 0;
  const result = await pool.selectWorkerTokenAccount({ identity: 'hammer', model: 'gpt-6',
    env: { AGENT_OS_CONFIG_PATH: topPath }, ownerImpl: async request => {
      proposals++;
      assert.equal(request.identity, 'hammer');
      return wire;
    } });
  assert.equal(proposals, 1);
  assert.equal(result.tokenAccountId, wire.selection.account_id);
  assert.equal(result.hold, false);
});

for (const invalidAccounts of [false, true]) {
  test(`ITPPOOLCONFLICT-01 undeclared workers retain class routing with invalidAccounts=${invalidAccounts}`, async t => {
    const fixture = poolConflictFixture(t, { invalidAccounts });
    const selectAccountImpl = request => pool.selectWorkerTokenAccount({ ...request, env: fixture.env,
      ownerImpl: () => assert.fail('undeclared pool must not read account evidence') });
    for (const identity of ['hammer', 'remediator-codex']) {
      assert.equal(await selectAccountImpl({ identity, model: 'gpt-6' }), null);
      assert.equal(await pool.selectWorkerTokenAccount({ identity, model: 'gpt-6', oauth: fixture.oauth,
        ownerImpl: () => assert.fail('membership precedes wire validation') }), null);
    }
    const closer = await resolveCloserDispatchHarness({ workerClass: 'hammer', env: {},
      codexAccountPolicy: 'pinned', selectAccountImpl, execFileImpl: async () => ({ stdout: '{}' }) });
    assert.equal(closer.workerClass, 'hammer');
    assert.equal(Boolean(closer.hold), false);
    const remediator = await resolveRemediationWorkerClassWithFallback({ primary: 'codex', env: {},
      codexAccountPolicy: 'pinned', selectAccountImpl, execFileImpl: async () => ({ stdout: '{}' }) });
    assert.equal(remediator.workerClass, 'codex');
    assert.equal(remediator.hold, false);
  });
}

test('ITPPOOLCONFLICT-01 declared hammer conflicts are diagnostic and warn once per key', async t => {
  const fixture = poolConflictFixture(t, { identities: ['codex', 'hammer', 'remediator-codex'] });
  const messages = [];
  t.mock.method(console, 'warn', message => messages.push(message));
  const selectAccountImpl = request => pool.selectWorkerTokenAccount({ ...request, env: fixture.env,
    ownerImpl: () => assert.fail('a conflict cannot propose an account') });
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await resolveCloserDispatchHarness({ workerClass: 'hammer',
      fallbackWorkerClasses: ['hammer-claude'], selectAccountImpl, env: {},
      execFileImpl: () => assert.fail('a conflict keeps its class path without a quota read') });
    assert.equal(result.workerClass, 'hammer');
    assert.equal(result.hold, false);
    assert.equal(result.fellBack, false);
    assert.equal(result.reason, 'pool-config-conflict');
    assert.equal(result.conflictKey, 'roles.build_pack_default_worker_class');
    assert.equal(result.tokenAccountId, undefined);
    assert.equal(await pool.resolvePooledWorkerRouting({ primary: 'codex', kind: 'remediator',
      selectAccountImpl, modelForClass: () => 'gpt-6' }), null);
  }
  assert.deepEqual(messages, [
    'pool-config-conflict: roles.build_pack_default_worker_class',
    'pool-config-conflict: roles.codex_worker_account_order',
  ]);
});

for (const held of ['evidence-unknown', 'capacity-saturated']) {
  test(`ITPPOOLCONFLICT-01 valid declared hammer retains ${held} hold`, async () => {
    const wire = wireFor('hammer');
    const result = await resolveCloserDispatchHarness({ workerClass: 'hammer', env: {},
      modelForWorkerClass: () => 'gpt-6',
      selectAccountImpl: request => pool.selectWorkerTokenAccount({ ...request, oauth: wire.oauth,
        ownerImpl: async () => ({ held }) }),
      execFileImpl: () => assert.fail('valid pool holds must not read legacy quota') });
    assert.equal(result.hold, true);
    assert.equal(result.reason, held);
  });
}

test('ITPPOOLCONFLICT-01 a conflicting fallback is not a selected account', async () => {
  const result = await pool.resolvePooledWorkerRouting({ primary: 'hammer', kind: 'hammer',
    fallbackWorkerClasses: ['hammer-claude'], modelForClass: () => 'gpt-6',
    selectAccountImpl: async ({ identity }) => ({ identity, pooled: true,
      status: identity === 'hammer' ? 'unavailable' : 'config-conflict',
      reason: identity === 'hammer' ? 'accounts-unavailable' : 'pool-config-conflict',
      hold: identity === 'hammer', conflictKey: 'roles.merge_agent_worker_class' }),
  });
  assert.equal(result.workerClass, 'hammer');
  assert.equal(result.fellBack, false);
  assert.equal(result.hold, true, 'positive primary exhaustion retains its hold');
  assert.equal(result.reason, 'no-available-fallback');
});

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

test('ITPREMEDHOLD-01 unknown primary uses legacy routing; exhausted pools retain reviewer-family exclusion', async () => {
  const seen = [];
  const run = status => resolveRemediationWorkerClassWithFallback({ primary: 'codex',
    codexAccountPolicy: 'pinned',
    fallbackWorkerClasses: ['remediator-codex-corp', 'remediator-claude'], reviewerModels: ['claude'], env: {},
    selectAccountImpl: async ({ identity }) => {
      seen.push(identity);
      return { pooled: true, identity, workerClass: identity, hold: true, status,
        reason: status === 'held' ? 'evidence-unknown' : 'accounts-unavailable' };
    }, execFileImpl: async () => ({ stdout: '{}' }) });
  const unknown = await run('held');
  assert.equal(unknown.hold, false);
  assert.equal(unknown.workerClass, 'codex');
  assert.equal(unknown.pooled, undefined);
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

for (const family of ['codex', 'claude']) for (const index of [0, 1]) for (const experiment of [false, true]) for (const local of (experiment ? [false] : [false, true])) test(`${experiment ? 'OSG-14 assigned arm' : 'ITPREMEDHOLD-01'} ${family} remediation claim account ${index} local=${local} dispatches remediator without local credentials`, async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'itp14-claim-'));
  const hqRoot = join(rootDir, 'hq');
  const workspaceDir = join(rootDir, 'worker');
  mkdirSync(hqRoot); mkdirSync(workspaceDir);
  const overrides = { AGENT_OS_CONFIG_PATH: '/dev/null', AGENT_OS_ROLES_REMEDIATOR: 'adversarial',
    ADVERSARIAL_REVIEW_DEFAULT_REMEDIATOR: undefined,
    AGENT_OS_ROLES_ADVERSARIAL_ORCHESTRATION_MODE: 'native', ADV_WITH_HQ_INTEGRATION: local ? '0' : '1',
    HQ_ROOT: hqRoot, HQ_PARENT_SESSION: 'synthetic-parent', HQ_PROJECT: 'synthetic-project',
    CODEX_BROKER_PROVIDER: 'codex-corp',
    CODEX_AUTH_PATH: join(rootDir, 'absent-auth.json') };
  const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  const apply = values => { for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } };
  apply(overrides);
  t.after(() => { apply(previous); rmSync(rootDir, { recursive: true, force: true }); });
  createFollowUpJob({ branch: 'fixture/remediation', rootDir, repo: 'sample/project', prNumber: 42, builderTag: experiment || family === 'codex' ? 'claude-code' : 'codex',
    reviewerModel: 'gemini', reviewBody: '## Verdict\nRequest changes', critical: true,
    reviewPostedAt: '2026-10-19T00:00:00Z' });
  const dispatches = [];
  const identity = `remediator-${family}`;
  const wire = wireFor(identity, index);
  const result = await consumeNextFollowUpJob({ rootDir, promptTemplate: 'Synthetic remediation prompt.',
    // An OSG assignment is reached only on the existing OS path. A pooled
    // default must override both local config and a local health-router result.
    ...(local && !experiment ? { healthRouter: { getMode: () => 'local' } } : {}),
    guardStackedBaseImpl: async () => null, resolvePRLifecycleImpl: async () => null,
    ...(experiment ? { resolveOsgRemediatorRouteImpl: options => {
      assert.equal(options.current.pooled, false);
      assert.equal(options.env.CODEX_BROKER_PROVIDER, 'codex-corp');
      const arm = { role: 'remediator', harness: family, worker_class: identity,
        model: wire.request.requested_models[0], effort: 'low', account: wire.selection.account_id };
      return resolveOsgRemediatorRoute({ ...options, mode: 'apply',
        ownerImpl: async () => ({ reason: 'assigned', worker_class: identity, arm, effort: 'low',
          assignment: { assignment_id: 'fixture-assignment', ticket_key: 'fixture/T-1',
            mode: 'apply', experiment: 'remediator', arm, propensity: 0.5 } }),
        selectAccountImpl: async () => ({ pooled: true, status: 'selected', identity,
          hold: false, tokenAccountId: arm.account }), recordImpl: () => {} });
    } } : {}),
    resolveRemediationWorkerClassImpl: args => experiment
      ? { workerClass: 'remediator-codex-corp', pooled: false, hold: false }
      : resolveRemediationWorkerClassWithFallback({ ...args,
      selectAccountImpl: request => pool.selectWorkerTokenAccount({ ...request, oauth: wire.oauth,
        model: wire.request.requested_models[0], ownerImpl: async () => wire }),
      execFileImpl: async () => ({ stdout: '{}' }) }),
    execFileImpl: async (command, args, options) => {
      if (command === 'gh' && args[0] === 'api' && args[1].endsWith('/pulls/42')) return { stdout: JSON.stringify({
        base: { ref: 'main' }, head: { ref: 'fixture-branch', repo: { full_name: 'sample/project' } } }) };
      if (args[0] === 'dispatch' && args[1] === 'status') return { stdout: JSON.stringify({ status: 'running', workspaceDir }) };
      if (args[0] === 'dispatch') {
        assert.equal(Object.hasOwn(options.env, 'CODEX_BROKER_PROVIDER'), false,
          'pooled dispatch must discard inherited or pre-OSG legacy provider settings');
        dispatches.push(args);
        return { stdout: JSON.stringify({ dispatchId: 'fixture-dispatch', launchRequestId: 'fixture-lrq' }) };
      }
      return { stdout: '' };
    }, spawnImpl: () => assert.fail('managed dispatch required'),
    postCommentImpl: async () => {}, deliverAlertImpl: async () => {},
    log: { info() {}, warn() {}, log() {}, error() {} } });
  assert.equal(result.consumed, true, JSON.stringify(result));
  assert.equal(process.env.CODEX_BROKER_PROVIDER, 'codex-corp', 'claim environment is isolated');
  assert.equal(result.job.remediationWorker.workerClass, identity);
  assert.equal(result.job.remediationWorker.accountProposal.tokenAccountId, wire.selection.account_id);
  assert.equal(result.job.remediationPlan.dispatchPath, 'hq');
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

test('ITPREMEDHOLD-01 a codex-only declaration leaves an undeclared remediator on the legacy class path', async () => {
  const wire = wireFor('remediator-codex');
  wire.oauth.identity_token_pools = { codex: wire.oauth.identity_token_pools.codex };
  let legacyReads = 0;
  const result = await resolveRemediationWorkerClassWithFallback({ primary: 'codex', env: {},
    codexAccountPolicy: 'pinned', modelForClass: () => 'gpt-6',
    selectAccountImpl: request => pool.selectWorkerTokenAccount({ ...request, oauth: wire.oauth,
      ownerImpl: () => assert.fail('undeclared identity must not request evidence') }),
    execFileImpl: async () => { legacyReads++; return { stdout: '{}' }; } });
  assert.equal(legacyReads, 1);
  assert.equal(result.workerClass, 'codex');
  assert.equal(result.pooled, undefined);
  assert.equal(result.hold, false);
});

for (const failure of ['transport', 'malformed', 'unknown', 'stale', 'generation', 'undeclared']) {
  test(`ITPREMEDHOLD-01 ${failure} remediator pool evidence takes the legacy path`, async () => {
    const wire = wireFor('remediator-codex');
    if (failure === 'malformed') wire.selection.version = 2;
    if (['unknown', 'stale', 'generation', 'undeclared'].includes(failure)) {
      const reasons = { unknown: 'evidence-unknown', stale: 'evidence-stale',
        generation: 'evidence-generation-mismatch', undeclared: 'pool-undeclared' };
      wire.selection = { ...wire.selection, account_id: null, considered: [],
        status: failure === 'undeclared' ? 'unavailable' : 'held', reason: reasons[failure] };
    }
    let legacyReads = 0;
    const result = await resolveRemediationWorkerClassWithFallback({ primary: 'codex', env: {},
      codexAccountPolicy: 'pinned', modelForClass: () => 'gpt-6',
      selectAccountImpl: request => pool.selectWorkerTokenAccount({ ...request, oauth: wire.oauth,
        ownerImpl: async () => {
          if (failure === 'transport') throw new Error('synthetic owner unavailable');
          return wire;
        } }),
      execFileImpl: async () => { legacyReads++; return { stdout: '{}' }; } });
    assert.equal(legacyReads, 1);
    assert.equal(result.workerClass, 'codex');
    assert.equal(result.pooled, undefined);
    assert.equal(result.hold, false);
  });
}

test('ITPREMEDHOLD-01 selector exceptions keep legacy remediation routing', async () => {
  const result = await resolveRemediationWorkerClassWithFallback({ primary: 'codex', env: {},
    codexAccountPolicy: 'pinned', selectAccountImpl: async () => { throw new Error('synthetic failure'); },
    execFileImpl: async () => ({ stdout: '{}' }) });
  assert.equal(result.workerClass, 'codex');
  assert.equal(result.pooled, undefined);
  assert.equal(result.hold, false);
});

test('ITPREMEDHOLD-01 all accounts unavailable produces a hold with the pool reason', async t => {
  const wire = wireFor('remediator-codex');
  wire.selection = { ...wire.selection, status: 'unavailable', account_id: null,
    reason: 'accounts-unavailable',
    considered: wire.oauth.identity_token_pools['remediator-codex'].map(account_id => ({
      account_id, reason: 'quota-exhausted', component: 'quota',
    })) };
  const result = await resolveRemediationWorkerClassWithFallback({ primary: 'codex', env: {},
    codexAccountPolicy: 'pinned', fallbackWorkerClasses: [], modelForClass: () => 'gpt-6',
    nowMs: Date.parse('2026-10-20T10:00:00Z'),
    selectAccountImpl: request => pool.selectWorkerTokenAccount({ ...request, oauth: wire.oauth,
      ownerImpl: async () => wire }),
    execFileImpl: () => assert.fail('positive pool exhaustion must not take the legacy path') });
  assert.equal(result.hold, true);
  assert.equal(result.pooled, true);
  assert.equal(result.capSource, 'accounts-unavailable');
  assert.equal(result.holdUntil, '2026-10-20T11:00:00.000Z');
  const rootDir = mkdtempSync(join(tmpdir(), 'pool-exhaustion-claim-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  createFollowUpJob({ rootDir, branch: 'fixture/remediation', repo: 'sample/project',
    prNumber: 42, builderTag: 'claude-code', reviewerModel: 'gemini',
    reviewBody: '## Verdict\nRequest changes', critical: true,
    reviewPostedAt: '2026-10-20T09:00:00Z' });
  const lines = [];
  const held = await consumeNextFollowUpJob({ rootDir, promptTemplate: 'Synthetic prompt.',
    now: () => '2026-10-20T10:00:00.000Z', resolvePRLifecycleImpl: async () => null,
    resolveRemediationWorkerClassImpl: async () => result,
    execFileImpl: () => assert.fail('exhausted pool must hold before dispatch'),
    spawnImpl: () => assert.fail('exhausted pool must not spawn'),
    log: { log: line => lines.push(line), info() {}, warn() {}, error() {} } });
  assert.equal(held.reason, 'remediator-capped-hold');
  assert.equal(held.job.status, 'pending');
  assert.equal(held.job.remediationPlan.currentRound, 0);
  assert.equal(held.job.remediationPlan.retryHistory.at(-1).retryMetadata.capSource, 'accounts-unavailable');
  assert.match(lines.join('\n'), /pool unavailable \(accounts-unavailable\)/);
  assert.doesNotMatch(lines.join('\n'), /undefined/);
});
