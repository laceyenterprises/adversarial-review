import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexAccountFixture } from './helpers/codex-account-fixture.mjs';
import { codexWorkerAccountPolicy } from '../src/role-config.mjs';
import { selectCodexWorkerAccount, selectCodexReviewerAccount } from '../src/codex-account-routing.mjs';
import { resolveCloserDispatchHarness } from '../src/ama/harness-fallback.mjs';
import { resolveMergeAgentDispatchHarness } from '../src/merge-agent-harness.mjs';
import { dispatchMergeAgentForPR } from '../src/follow-up-merge-agent.mjs';
import { resolveClaimedRemediatorRouting, resolveRemediationWorkerClassWithFallback } from '../src/remediation-worker-class-fallback.mjs';
import { createFollowUpJob } from '../src/follow-up-jobs.mjs';
import { consumeNextFollowUpJob } from '../src/follow-up-remediation.mjs';

const env = { AGENT_OS_CONFIG_PATH: '/dev/null' };
const quiet = { info() {}, warn() {}, log() {}, error() {} };
const execFor = snapshot => async () => ({ stdout: JSON.stringify(snapshot) });
const closer = snapshot => resolveCloserDispatchHarness({ workerClass: 'hammer',
  codexAccountPolicy: codexWorkerAccountPolicy('roles.adversarial.merge_authority.worker_class', 'hammer', { env }),
  execFileImpl: execFor(snapshot), modelForWorkerClass: () => 'synthetic-model', env });
const remediator = (snapshot, options = {}) => resolveClaimedRemediatorRouting({ primary: 'codex',
  job: { builderTag: 'claude-code', reviewerModel: 'codex' }, env, log: quiet,
  resolveImpl: args => resolveRemediationWorkerClassWithFallback({ ...args, execFileImpl: execFor(snapshot) }),
  ...options });

for (const [label, mutate, corporate, hold] of [
  ['personal ready', () => {}, false, false],
  ['personal ready, corporate unknown', f => { delete f.reserveFloors['openai-oauth-corp']; delete f.brokerAuth.provider_states['codex-corp']; }, false, false],
  ['personal exhausted', f => { f.providerStatuses[0].state = 'exhausted'; }, true, false],
  ['personal not ready', f => { f.brokerAuth.provider_states.codex.ready = false; }, true, false],
  ['personal cannot serve', f => { f.brokerAuth.provider_states.codex.can_serve = false; }, true, false],
  ['personal measured zero', f => { f.reserveFloors['openai-oauth'].weeklyMeasurement.percentRemaining = 0; }, true, false],
  ['personal model capped', f => { f.providerStatuses[0].models = [{ model: 'synthetic-model', state: 'exhausted' }]; }, true, false],
  ['both unknown', f => { f.reserveFloors = {}; f.brokerAuth = {}; }, false, true],
  ['personal unknown, corporate ready', f => { delete f.reserveFloors['openai-oauth']; }, false, true],
  ['personal stale, corporate ready', f => { f.providerStatuses[0].cachedEvidenceStale = true; }, false, true],
  ['stale personal exhaustion, corporate ready', f => { f.providerStatuses[0].cachedEvidenceStale = true; f.providerStatuses[0].state = 'exhausted'; }, false, true],
  ['personal exhausted, corporate unknown', f => { f.providerStatuses[0].state = 'exhausted'; delete f.brokerAuth.provider_states['codex-corp']; }, false, true],
  ['both exhausted', f => { f.providerStatuses[0].state = 'exhausted'; f.providerStatuses[1].state = 'exhausted'; }, false, true],
]) test(`LANEFAILOVER-01: ${label} uses the same evidence in both worker lanes`, async () => {
  const snapshot = codexAccountFixture(); mutate(snapshot);
  const selected = selectCodexWorkerAccount(snapshot, { model: 'synthetic-model' });
  assert.equal(selected.hold, hold);
  const hammer = await closer(snapshot);
  const remediation = await remediator(snapshot, {
    resolveImpl: args => resolveRemediationWorkerClassWithFallback({ ...args,
      modelForClass: () => 'synthetic-model', execFileImpl: execFor(snapshot) }),
  });
  const recovery = await resolveMergeAgentDispatchHarness({ workerClass: 'hammer', env,
    execFileImpl: execFor(snapshot), logger: quiet,
    resolveHarnessImpl: args => resolveCloserDispatchHarness({ ...args, modelForWorkerClass: () => 'synthetic-model' }) });
  assert.equal(hammer.hold, hold);
  assert.equal(remediation.hold, hold);
  assert.equal(recovery.deferred, hold);
  if (!hold) {
    assert.equal(hammer.workerClass, corporate ? 'hammer-corp' : 'hammer');
    assert.equal(recovery.workerClass, hammer.workerClass);
    assert.equal(remediation.workerClass, corporate ? 'remediator-codex-corp' : 'codex');
  }
});

for (const account of ['personal', 'corporate', 'unknown']) test(`real remediation claim: ${account}`, async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'codex-remediator-dispatch-'));
  const hqRoot = join(rootDir, 'hq');
  const authHome = join(rootDir, '.codex');
  const workspaceDir = join(rootDir, 'worker');
  for (const dir of [hqRoot, authHome, workspaceDir]) mkdirSync(dir);
  writeFileSync(join(authHome, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt',
    tokens: { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh' } }));
  const overrides = { ...env, AGENT_OS_ROLES_REMEDIATOR: 'adversarial',
    ADVERSARIAL_REVIEW_DEFAULT_REMEDIATOR: undefined,
    AGENT_OS_ROLES_ADVERSARIAL_ORCHESTRATION_MODE: 'native', ADV_WITH_HQ_INTEGRATION: '1',
    HQ_ROOT: hqRoot, HQ_PARENT_SESSION: 'synthetic-parent', HQ_PROJECT: 'synthetic-project',
    CODEX_AUTH_PATH: join(authHome, 'auth.json'), CODEX_HOME: authHome };
  const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  const restore = values => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  };
  restore(overrides);
  t.after(() => { restore(previous); rmSync(rootDir, { recursive: true, force: true }); });
  createFollowUpJob({ rootDir, repo: 'sample/project', prNumber: 42, builderTag: 'claude-code',
    reviewerModel: 'gemini', reviewBody: '## Verdict\nRequest changes', critical: true,
    reviewPostedAt: '2026-10-19T00:00:00Z' });
  const snapshot = account === 'unknown' ? {} : codexAccountFixture({ primary: account === 'corporate' ? 'exhausted' : 'ok' });
  const logs = []; const dispatches = [];
  const result = await consumeNextFollowUpJob({ rootDir, promptTemplate: 'Synthetic remediation prompt.',
    guardStackedBaseImpl: async () => null, resolvePRLifecycleImpl: async () => null,
    resolveRemediationWorkerClassImpl: args => resolveRemediationWorkerClassWithFallback({ ...args, execFileImpl: execFor(snapshot) }),
    execFileImpl: async (command, args, options) => {
      if (command === 'gh' && args[0] === 'api' && args[1].endsWith('/pulls/42')) {
        return { stdout: JSON.stringify({ base: { ref: 'main' },
          head: { ref: 'synthetic-branch', repo: { full_name: 'sample/project' } } }) };
      }
      if (args[0] === 'dispatch' && args[1] === 'status') return { stdout: JSON.stringify({ status: 'running', workspaceDir }) };
      if (args[0] === 'dispatch') {
        dispatches.push({ args, env: options.env });
        return { stdout: JSON.stringify({ dispatchId: 'synthetic-dispatch', launchRequestId: 'synthetic-lrq' }) };
      }
      return { stdout: '' };
    },
    spawnImpl: () => { throw new Error('HQ mode must not spawn a local worker'); },
    postCommentImpl: async () => {}, deliverAlertImpl: async () => {},
    log: { ...quiet, info: line => logs.push(line) },
  });
  if (account === 'unknown') {
    assert.equal(result.consumed, false);
    assert.equal(result.reason, 'remediator-capped-hold');
    assert.equal(result.job.status, 'pending');
    assert.equal(result.job.remediationPlan.currentRound, 0);
    assert.equal(result.job.remediationPlan.transientRetries, 0);
    assert.equal(dispatches.length, 0);
    assert.equal(logs.filter(line => line.includes('codex_account=')).length, 0);
  } else {
    assert.equal(result.consumed, true, JSON.stringify(result));
    const workerClass = account === 'corporate' ? 'remediator-codex-corp' : 'codex';
    assert.equal(result.job.remediationWorker.model, workerClass);
    assert.equal(dispatches.length, 1);
    assert.equal(dispatches[0].args[dispatches[0].args.indexOf('--worker-class') + 1], workerClass);
    assert.equal(dispatches[0].env.CODEX_BROKER_PROVIDER, account === 'corporate' ? 'codex-corp' : 'codex');
    const choices = logs.filter(line => line.includes('codex_account='));
    assert.equal(choices.length, 1);
    assert.match(choices[0], new RegExp(`codex_account=${account} .*reason=`));
  }
});

test('worker recovery returns to personal; reviewers remain corporate-first', async () => {
  const snapshot = codexAccountFixture({ primary: 'exhausted' });
  assert.equal((await closer(snapshot)).workerClass, 'hammer-corp');
  assert.equal((await remediator(snapshot)).workerClass, 'remediator-codex-corp');
  snapshot.providerStatuses[0].state = 'ok';
  assert.equal((await closer(snapshot)).workerClass, 'hammer');
  assert.equal((await remediator(snapshot)).workerClass, 'codex');
  assert.equal(selectCodexReviewerAccount(snapshot).provider, 'codex-corp');
});

test('worker resolvers default to personal-first without a declared cross-model fallback', async () => {
  const snapshot = codexAccountFixture({ primary: 'exhausted' });
  const execFileImpl = execFor(snapshot);
  assert.equal((await resolveCloserDispatchHarness({ workerClass: 'hammer', execFileImpl, env })).workerClass, 'hammer-corp');
  assert.equal((await resolveRemediationWorkerClassWithFallback({ primary: 'codex', execFileImpl, env })).workerClass, 'remediator-codex-corp');
});

test('job-local exhaustion remains account-scoped during automatic remediation routing', async () => {
  const nowMs = Date.parse('2026-10-19T00:00:00Z');
  const localHold = workerClass => ({ round: 1, requeuedAt: '2026-10-18T23:00:00Z',
    worker: { model: workerClass }, retryMetadata: { code: 'quota-exhausted', workerClass,
      harness: 'codex', providerResetAt: '2026-10-20T00:00:00Z' } });
  const job = { builderTag: 'claude-code', remediationPlan: { retryHistory: [localHold('codex')] } };
  const snapshot = codexAccountFixture();
  assert.equal((await remediator(snapshot, { job, nowMs })).workerClass, 'remediator-codex-corp');
  job.remediationPlan.retryHistory.push(localHold('remediator-codex-corp'));
  assert.equal((await remediator(snapshot, { job, nowMs })).hold, true);
});

test('an unreadable fleet snapshot defers both automatic worker lanes', async () => {
  for (const execFileImpl of [async () => { throw new Error('synthetic outage'); },
    execFor({}), execFor({ providerStatuses: {} }), execFor({ providerStatuses: [null] }),
    async () => ({ stdout: 'synthetic malformed JSON' })]) {
    const hammer = await resolveMergeAgentDispatchHarness({ workerClass: 'hammer', env, execFileImpl, logger: quiet });
    assert.equal(hammer.deferred, true);
    const remediation = await remediator(null, {
      resolveImpl: args => resolveRemediationWorkerClassWithFallback({ ...args, execFileImpl }),
    });
    assert.equal(remediation.hold, true);
    assert.ok(remediation.holdUntil);
  }
});

test('explicit file and env pins preserve personal and corporate classes', async t => {
  assert.equal(codexWorkerAccountPolicy('roles.remediator', 'codex', {
    loaderImpl: () => ({ get: () => 'codex',
      resolutionTrace: () => [{ source: 'module:synthetic-config', value: 'codex' }] }),
  }), 'pinned', 'a concrete module-file setting is also an explicit pin');
  const root = mkdtempSync(join(tmpdir(), 'codex-worker-pins-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const topPath = join(root, 'config.yaml');
  for (const [hammerClass, remediatorClass] of [['hammer', 'codex'], ['hammer-corp', 'remediator-codex-corp']]) {
    // The recovery-role schema supports a personal hammer pin; the AMA role
    // additionally supports the corporate hammer pin.
    writeFileSync(topPath, `version: 1\nroles:\n${hammerClass === 'hammer' ? '  merge_agent_worker_class: hammer\n  remediator: codex\n' : '  registry:\n    remediator:\n      workerClass: remediator-codex-corp\n'}  adversarial:\n    merge_authority:\n      worker_class: ${hammerClass}\n`);
    const pinnedEnv = { AGENT_OS_CONFIG_PATH: topPath };
    for (const key of ['roles.merge_agent_worker_class', 'roles.adversarial.merge_authority.worker_class']) {
      assert.equal(codexWorkerAccountPolicy(key, hammerClass, { env: pinnedEnv }), 'pinned');
    }
    const snapshot = codexAccountFixture();
    if (hammerClass === 'hammer') snapshot.brokerAuth.provider_states.codex.ready = false;
    const recovery = await resolveMergeAgentDispatchHarness({ workerClass: hammerClass, env: pinnedEnv,
      execFileImpl: execFor(snapshot), logger: quiet });
    assert.equal(recovery.workerClass, hammerClass);
    const routed = await remediator(snapshot, { primary: remediatorClass, env: pinnedEnv });
    assert.equal(routed.workerClass, remediatorClass);
    if (hammerClass === 'hammer') {
      assert.equal(codexWorkerAccountPolicy('roles.merge_agent_worker_class', hammerClass, {
        env: { ...env, AGENT_OS_ROLES_MERGE_AGENT_WORKER_CLASS: hammerClass },
      }), 'pinned');
    }
  }
});

for (const corporate of [false, true]) test(`real recovery dispatch logs ${corporate ? 'corporate' : 'personal'} once`, async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'codex-worker-dispatch-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const snapshot = codexAccountFixture({ primary: corporate ? 'exhausted' : 'ok' });
  const logs = []; const calls = [];
  const execFileImpl = async (command, args) => {
    calls.push(args);
    return { stdout: JSON.stringify(args[0] === 'fleet' ? snapshot : { dispatchId: 'synthetic-dispatch', lrq: 'synthetic-lrq' }) };
  };
  const result = await dispatchMergeAgentForPR({ rootDir, repo: 'sample/project', prNumber: 42,
    branch: 'synthetic-branch', baseBranch: 'main', headSha: 'a'.repeat(40), lastVerdict: 'Comment only',
    mergeable: 'MERGEABLE', checksConclusion: 'SUCCESS', labels: [],
    latestFollowUpJobStatus: 'completed', remediationCurrentRound: 1, remediationMaxRounds: 1,
    blockingFindingCount: 0, blockingFindingState: 'known', env,
    // The dispatch fixture supplies the logical default without an operator pin.
    resolveMergeAgentHarnessImpl: args => resolveMergeAgentDispatchHarness({ ...args, workerClass: 'hammer' }),
    hqPath: 'synthetic-hq', execFileImpl, ghExecFileImpl: async () => ({ stdout: '' }),
    agentOsDetectImpl: () => ({ present: true, source: 'test' }),
    prepareOriginalWorkerImpl: async () => ({ decision: 'ready', reason: 'no-derived-worker-id' }),
    logger: { ...quiet, info: line => logs.push(line) },
  });
  assert.equal(result.decision, 'dispatch', JSON.stringify(result));
  const dispatch = calls.find(args => args[0] === 'dispatch');
  assert.equal(dispatch[dispatch.indexOf('--worker-class') + 1], corporate ? 'hammer-corp' : 'hammer');
  const accountLogs = logs.filter(line => line.includes('codex_account='));
  assert.equal(accountLogs.length, 1);
  assert.match(accountLogs[0], new RegExp(`codex_account=${corporate ? 'corporate' : 'personal'} .*reason=`));
});
