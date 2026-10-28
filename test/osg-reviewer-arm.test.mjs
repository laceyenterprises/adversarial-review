import './helpers/registry-session-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyReviewerArm, applyReviewerArmEffectiveRoute, reviewerArmExecution } from '../src/osg-reviewer-arm.mjs';
import { __test__ as harness } from '../src/reviewer-harness.mjs';

const current = { builderClass: 'claude-code', tag: 'claude-code', reviewerModel: 'codex', botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN' };
const arm = { role: 'reviewer', harness: 'codex', worker_class: 'codex-reviewer', model: 'gpt-6-luna', effort: 'low', account: 'fixture-account' };
const quiet = { info() {}, warn() {} };

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
