import './helpers/registry-session-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyReviewerArm, applyReviewerArmEffectiveRoute, reviewerArmExecution, reviewerArmOwner } from '../src/osg-reviewer-arm.mjs';
import { resolveAgentOsPython } from '../src/agent-os-python.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
import { __test__ as harness } from '../src/reviewer-harness.mjs';

const current = { builderClass: 'claude-code', tag: 'claude-code', reviewerModel: 'codex', botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN' };
const arm = { role: 'reviewer', harness: 'codex', worker_class: 'codex-reviewer', model: 'gpt-6-luna', effort: 'low', account: 'fixture-account' };
const quiet = { info() {}, warn() {} };

function ownerFixture(t, source) {
  const root = mkdtempSync(join(tmpdir(), 'osg-owner-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const moduleDir = join(root, 'modules/worker-pool/lib/python/cwp_dispatch');
  mkdirSync(moduleDir, { recursive: true });
  writeFileSync(join(moduleDir, '__init__.py'), '');
  if (source !== null) writeFileSync(join(moduleDir, 'osg_reviewer.py'), source);
  // Resolve a test interpreter only; no production owner or ledger is invoked.
  const python = execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim();
  mkdirSync(join(root, 'runtime/python/bin'), { recursive: true });
  symlinkSync(python, join(root, 'runtime/python/bin/python3'));
  return { env: { PATH: process.env.PATH, AGENT_OS_DEPLOY_CHECKOUT: root, PYTHONPATH: '/synthetic/ignored' }, root, python };
}

test('resolved runtime and explicit package roots import a synthetic owner without ambient Python paths', async t => {
  const fixture = ownerFixture(t, 'import json, sys\nvalue = json.load(sys.stdin)\nprint(json.dumps({"reason": value["mode"]}))');
  const launch = resolveAgentOsPython({ env: fixture.env });
  assert.equal(launch.python, join(fixture.root, 'runtime/python/bin/python3'));
  assert.equal(launch.cwd, fixture.root);
  assert.ok(launch.env.PYTHONPATH.split(delimiter).every(isAbsolute));
  assert.ok(!launch.env.PYTHONPATH.includes('/synthetic/ignored'));
  assert.equal(resolveAgentOsPython({ env: { ...fixture.env, HQ_PYTHON3: fixture.python, AGENT_OS_PY: 'unused' } }).python, fixture.python);
  assert.equal(resolveAgentOsPython({ env: { ...fixture.env, AGENT_OS_PY: fixture.python } }).python, fixture.python);
  assert.equal(resolveAgentOsPython({ env: {}, root: fixture.root }).cwd, fixture.root);
  assert.throws(() => resolveAgentOsPython({ env: {}, root: 'relative' }));
  assert.deepEqual(await reviewerArmOwner({ mode: 'shadow' }, { env: fixture.env }), { reason: 'shadow' });
});

test('deployment config fallback honors each supplied environment without changing process.env', async t => {
  const ambientConfigPath = process.env.AGENT_OS_CONFIG_PATH;
  const ambientDeployRoot = process.env.AGENT_OS_DEPLOY_CHECKOUT;
  for (let i = 0; i < 2; i++) {
    const fixture = ownerFixture(t, 'print(\'{"reason":"shadow"}\')');
    const configPath = join(fixture.root, 'config.yaml');
    writeFileSync(configPath, JSON.stringify({ version: 1, roots: { deploy: fixture.root } }));
    const { AGENT_OS_DEPLOY_CHECKOUT: _root, ...env } = fixture.env;
    env.AGENT_OS_CONFIG_PATH = configPath;
    const launch = resolveAgentOsPython({ env });
    assert.equal(launch.cwd, fixture.root);
    assert.equal(launch.python, join(fixture.root, 'runtime/python/bin/python3'));
    assert.equal(launch.env.AGENT_OS_CONFIG_PATH, configPath);
    assert.deepEqual(await reviewerArmOwner({}, { env }), { reason: 'shadow' });
  }
  assert.equal(process.env.AGENT_OS_CONFIG_PATH, ambientConfigPath);
  assert.equal(process.env.AGENT_OS_DEPLOY_CHECKOUT, ambientDeployRoot);
});

test('owner transport failures have stable private reasons and preserve default routing in apply and shadow', async t => {
  for (const [reason, source, patch] of [
    ['error-owner-import', null, {}],
    ['error-owner-import', 'from cwp_dispatch import synthetic_private_diagnostic', {}],
    ['error-owner-timeout', 'import time\ntime.sleep(60)', { timeoutMs: 100 }],
    ['error-owner-invalid-json', 'print("invalid")', {}],
    ['error-owner-exit', 'import sys\nsys.stderr.write("synthetic private diagnostic")\nsys.exit(2)', {}],
    ['error-owner-spawn', '', { missingInterpreter: true }],
  ]) {
    const fixture = ownerFixture(t, source);
    if (patch.missingInterpreter) fixture.env.HQ_PYTHON3 = join(fixture.root, 'absent-python');
    const owner = value => reviewerArmOwner(value, { env: fixture.env, timeoutMs: 5000, ...patch });
    const started = performance.now();
    await assert.rejects(owner({}), { message: reason });
    if (reason === 'error-owner-timeout') assert.ok(performance.now() - started < 3000);
    for (const mode of ['apply', 'shadow']) {
      const lines = [];
      assert.equal(await applyReviewerArm({ baseRoute: current, domainId: 'code-pr',
        config: { mode }, owner, log: { info: line => lines.push(line) } }), current);
      assert.ok(lines.some(line => line.endsWith(`reason=${reason}`)));
      assert.ok(lines.every(line => !line.includes('synthetic private diagnostic')));
      assert.ok(lines.every(line => !line.includes('synthetic_private_diagnostic')));
    }
  }
});

test('the default budget admits a synthetic owner slower than the former ceiling', async t => {
  const fixture = ownerFixture(t, 'import time\ntime.sleep(1.6)\nprint(\'{"reason":"shadow"}\')');
  assert.deepEqual(await reviewerArmOwner({}, { env: fixture.env }), { reason: 'shadow' });
});

test('assigned arm keeps review identity and carries model and effort to execution', async () => {
  const route = await applyReviewerArm({ baseRoute: current, domainId: 'code-pr', config: { mode: 'apply' },
    owner: async () => ({ arm, reason: 'assigned', assignment: { propensity: 0.5 } }), log: quiet });
  assert.equal(route.reviewerModel, current.reviewerModel);
  assert.equal(route.botTokenEnv, current.botTokenEnv);
  assert.deepEqual(reviewerArmExecution(route), { reviewerArm: arm });
  const execution = harness.resolveReviewerExecution('codex', { modelPin: arm.model, reasoningPin: arm.effort, env: {}, log: quiet });
  assert.equal(execution.model, arm.model);
  assert.equal(execution.effort, 'low');
});

test('cross-family refusal wins over selected arms including Gemini builders', async () => {
  for (const family of ['codex', 'claude', 'gemini']) {
    const builder = family === 'claude' ? 'claude-code' : family;
    const baseRoute = { ...current, builderClass: builder };
    const result = await applyReviewerArm({ baseRoute, domainId: 'code-pr', config: { mode: 'apply' },
      owner: async () => ({ arm: { ...arm, harness: family, worker_class: `${family}-reviewer` }, reason: 'assigned' }), log: quiet });
    assert.equal(result, baseRoute);
  }
});

test('off is byte-identical and performs no owner or availability reads', async () => {
  const before = JSON.stringify(current);
  const route = await applyReviewerArm({ baseRoute: current, domainId: 'code-pr', config: { mode: 'off' },
    owner() { throw Error('must not run'); }, log: quiet });
  assert.equal(route, current);
  assert.equal(JSON.stringify(route), before);
  assert.deepEqual(reviewerArmExecution(route), {});
});

test('owner errors, shadow and non-code domains preserve the default', async () => {
  for (const patch of [
    { owner: async () => { throw Error('private diagnostic'); } },
    { config: { mode: 'shadow' }, owner: async () => ({ arm, reason: 'shadow' }) },
    { domainId: 'research', owner: async () => { throw Error('must not run'); } },
  ]) {
    assert.equal(await applyReviewerArm({ baseRoute: current, domainId: 'code-pr', config: { mode: 'apply' }, log: quiet, ...patch }), current);
  }
});

test('a failed reason logger cannot interrupt default routing', async () => {
  assert.equal(await applyReviewerArm({ baseRoute: current, domainId: 'code-pr', config: { mode: 'apply' },
    owner: async () => { throw Error('synthetic diagnostic'); }, log: { info() { throw Error('logger unavailable'); } } }), current);
});

test('the assignment owner sees the actual effective incumbent', async () => {
  let incumbent;
  await applyReviewerArm({ baseRoute: current, domainId: 'code-pr', config: { mode: 'apply' }, reviewerMode: 'always-on',
    owner: async value => { incumbent = value.reviewerModel; return { arm: null, reason: 'default-unavailable' }; }, log: quiet });
  assert.equal(incumbent, 'gemini');
});

test('later family fallback drops the experiment execution pins', () => {
  assert.deepEqual(reviewerArmExecution({ ...current, reviewerArm: arm, reviewerModel: 'claude' }), {});
});

test('an assigned arm overrides Gemini default selection but retains its integrity guard and resolved default fallback', async () => {
  const selected = await applyReviewerArm({ baseRoute: current, domainId: 'code-pr', config: { mode: 'apply' },
    reviewerMode: 'always-on', owner: async () => ({ arm, reason: 'assigned' }), log: quiet });
  const route = applyReviewerArmEffectiveRoute({ builderClass: current.builderClass, baseRoute: selected, mode: 'always-on' });
  assert.equal(route.reviewerModel, 'codex');
  assert.equal(route.reviewerArmDefaultRoute.reviewerModel, 'gemini');
  assert.equal(route.reviewerArmDefaultRoute, selected.reviewerArmDefaultRoute);
  const refused = applyReviewerArmEffectiveRoute({ builderClass: 'codex',
    baseRoute: { ...selected, builderClass: 'codex' }, mode: 'always-on' });
  assert.notEqual(refused.reviewerModel, 'codex');
});

test('owner receives fully qualified repository identity for same-named forks', async () => {
  const repos = [];
  for (const repoPath of ['upstream/project', 'fork/project']) {
    await applyReviewerArm({ baseRoute: current, domainId: 'code-pr', repoPath, prNumber: 7,
      config: { mode: 'shadow' }, log: quiet,
      owner: async value => { repos.push(value.repo); return { reason: 'shadow' }; } });
  }
  assert.deepEqual(repos, ['upstream/project', 'fork/project']);
});

test('incumbent integrity resolution honors the supplied domain route table', async () => {
  const domainRoute = { reviewerModel: 'claude', botTokenEnv: 'GH_DOMAIN_REVIEWER_TOKEN' };
  let incumbent;
  const route = await applyReviewerArm({
    baseRoute: { ...current, builderClass: 'gemini', reviewerModel: 'gemini' },
    domainId: 'code-pr', routeTable: { gemini: domainRoute }, config: { mode: 'apply' }, log: quiet,
    owner: async value => { incumbent = value.reviewerModel; return { arm, reason: 'assigned' }; },
  });
  assert.equal(incumbent, 'claude');
  assert.equal(route.reviewerArmDefaultRoute.reviewerModel, 'claude');
  assert.equal(route.reviewerArmDefaultRoute.botTokenEnv, domainRoute.botTokenEnv);
});
