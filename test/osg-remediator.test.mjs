import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const seam = await import('../src/osg-remediator.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
const arm = { role: 'remediator', harness: 'codex', worker_class: 'codex',
  model: 'fixture-model', effort: 'low', account: 'fixture-account' };
const assignment = { assignment_id: 'fixture-assignment', ticket_key: 'fixture/T-1',
  experiment: 'remediator', arm, mode: 'apply', propensity: 0.5 };

async function route(options = {}) {
  assert.equal(typeof seam.resolveOsgRemediatorRoute, 'function');
  return seam.resolveOsgRemediatorRoute({ repo: 'example/fixture', prNumber: 7,
    kind: 'hammer', current: { workerClass: 'hammer' }, mode: 'apply',
    ownerImpl: async () => ({ assignment, arm, worker_class: 'hammer', effort: 'low', reason: 'assigned' }),
    selectAccountImpl: async () => ({ pooled: true, status: 'selected', hold: false,
      identity: 'hammer', tokenAccountId: arm.account, evidenceGeneration: 'fixture-generation' }),
    recordImpl: () => {}, env: {}, ...options });
}

test('assigned arm keeps hammer authority and carries model, effort and account', async () => {
  const selected = await route();
  assert.equal(selected.workerClass, 'hammer');
  assert.equal(selected.modelResolution.resolvedModel, arm.model);
  assert.equal(selected.modelResolution.resolvedReasoningLevel, 'low');
  assert.equal(selected.osg.arm.account, arm.account);
  assert.equal(selected.osg.assignment.propensity, 0.5);
  assert.equal(selected.osg.reason, 'assigned');
});

test('effort uses the catalog arm when the owner omits or nulls its override', async () => {
  for (const [effort, catalogEffort, expected] of [
    [undefined, 'low', 'low'], [null, 'high', 'high'], ['medium', 'low', 'medium'],
    [undefined, 'default', 'default'], [undefined, undefined, null],
  ]) {
    const selected = await route({ ownerImpl: async () => ({ assignment,
      arm: { ...arm, effort: catalogEffort }, worker_class: 'hammer', effort, reason: 'assigned' }) });
    assert.equal(selected.modelResolution.resolvedReasoningLevel, expected);
  }
});

test('same-family remediator arms preserve diversity across base, pooled and corporate aliases', async () => {
  for (const [workerClass, reviewer, currentClasses] of [
    ['remediator-codex', 'codex', ['codex', 'codex-corp', 'remediator-codex', 'remediator-codex-corp']],
    ['remediator-claude', 'claude', ['claude-code', 'claude-code-corp', 'remediator-claude', 'remediator-claude-corp']],
  ]) {
    for (const currentClass of currentClasses) {
      const selected = await route({ kind: 'remediator', current: { workerClass: currentClass },
        reviewerModels: [reviewer],
        ownerImpl: async () => ({ assignment, arm, worker_class: workerClass, reason: 'assigned' }),
        selectAccountImpl: async () => ({ pooled: true, status: 'selected', identity: workerClass,
          tokenAccountId: arm.account }),
      });
      assert.equal(selected.workerClass, workerClass, currentClass);
      assert.equal(selected.osg.reason, 'assigned', currentClass);
      assert.equal(selected.modelResolution.resolvedReasoningLevel, arm.effort);
    }
  }
});

test('cross-family remediator arms still exclude the next reviewer family', async () => {
  for (const [currentClass, workerClass, reviewer, otherReviewer] of [
    ['claude-code', 'remediator-codex', 'codex', 'claude'],
    ['codex', 'remediator-claude', 'claude', 'codex'],
  ]) {
    for (const conflict of [true, false]) {
      const selected = await route({ kind: 'remediator', current: { workerClass: currentClass },
        reviewerModels: [conflict ? reviewer : otherReviewer],
        ownerImpl: async () => ({ assignment, arm, worker_class: workerClass, reason: 'assigned' }),
        selectAccountImpl: async () => {
          assert.equal(conflict, false, 'refused arm must not select an account');
          return { pooled: true, status: 'selected', identity: workerClass, tokenAccountId: arm.account };
        },
      });
      assert.equal(selected.osg.reason, conflict ? 'arm-role-unavailable' : 'assigned');
      assert.equal(selected.workerClass, conflict ? currentClass : workerClass);
    }
  }
});

test('unavailable or changed account falls back without holding dispatch', async () => {
  const current = { workerClass: 'hammer', reason: 'preferred-ready' };
  let recorded;
  for (const account of [null, { hold: true }, { pooled: true, status: 'selected',
    identity: 'hammer', tokenAccountId: 'another-account' }]) {
    const result = await route({ current, selectAccountImpl: async () => account,
      recordImpl: value => { recorded = value; } });
    assert.equal(result.workerClass, current.workerClass);
    assert.equal(result.reason, current.reason);
    assert.equal(result.modelResolution, undefined);
    assert.equal(result.hold, undefined);
    assert.equal(recorded.reason, 'arm-account-unavailable');
  }
});

test('off returns the exact original object without config/owner/account/evidence I/O', async () => {
  const current = Object.freeze({ workerClass: 'hammer', reason: 'preferred-ready' });
  const forbidden = () => assert.fail('off touched an experimental dependency');
  assert.equal(await route({ current, mode: 'off', ownerImpl: forbidden,
    selectAccountImpl: forbidden, recordImpl: forbidden }), current);
});

test('omitted mode loads the default off config without owner/account/evidence I/O', async () => {
  const current = Object.freeze({ workerClass: 'hammer', reason: 'preferred-ready' });
  const calls = [];
  const unexpected = name => () => { calls.push(name); throw Error(`unexpected ${name}`); };
  const result = await seam.resolveOsgRemediatorRoute({ current, kind: 'hammer',
    repo: 'example/fixture', prNumber: 7, env: { AGENT_OS_CONFIG_PATH: '/dev/null' },
    ownerImpl: unexpected('owner'), selectAccountImpl: unexpected('account'),
    recordImpl: unexpected('record'), log: { warn: unexpected('warn') } });
  assert.equal(result, current);
  assert.deepEqual(calls, []);
});

test('owner transport deadline does not hold the event loop open', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'osg-owner-unavailable-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const setTimeoutImpl = globalThis.setTimeout;
  let deadline;
  t.mock.method(globalThis, 'setTimeout', (...args) => {
    deadline = setTimeoutImpl(...args);
    return deadline;
  });
  const pending = seam.remediatorProposalOwner({kind:'hammer',repo:'example/repo',prNumber:1}, { env: { HQ_BIN: join(rootDir, 'missing-hq') } });
  assert.equal(deadline.hasRef(), false);
  await assert.rejects(pending, /osg-owner-unavailable/);
});

test('owner failure, budget fallback and audit failure keep a usable default', async () => {
  const current = { workerClass: 'hammer' };
  for (const ownerImpl of [async () => { throw Error('private diagnostic'); },
    async () => ({ assignment, reason: 'quota-trial-share' })]) {
    const result = await route({ current, ownerImpl });
    assert.equal(result.workerClass, 'hammer');
    assert.equal(result.modelResolution, undefined);
    assert.doesNotMatch(JSON.stringify(result), /private diagnostic/);
  }
  assert.equal((await route({ current, recordImpl: () => { throw Error('disk unavailable'); } })).workerClass, 'hammer');
  assert.equal((await route({ current, recordImpl: () => { throw Error('disk unavailable'); } })).modelResolution, undefined);
});

test('shadow and another role cannot override the current route', async () => {
  assert.equal((await route({ mode: 'shadow' })).modelResolution, undefined);
  assert.equal((await route({ ownerImpl: async () => ({ assignment: { ...assignment,
    experiment: 'builder' }, arm, worker_class: 'hammer', effort: 'low', reason: 'assigned' }) })).modelResolution, undefined);
});

test('evidence persists the assignment and fallback with no provider text', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'osg-remediator-'));
  try {
    await route({ rootDir, recordImpl: undefined, ownerImpl: async () => ({ assignment, reason: 'quota-trial-share' }) });
    const files = readdirSync(join(rootDir, 'data', 'osg-remediator'));
    assert.equal(files.length, 1);
    const value = JSON.parse(readFileSync(join(rootDir, 'data', 'osg-remediator', files[0])));
    assert.equal(value.assignment.assignment_id, assignment.assignment_id);
    assert.equal(value.reason, 'quota-trial-share');
    assert.equal(value.repo, 'example/fixture');
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test('evidence respects the configured state directory without writing repository data', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'osg-remediator-root-'));
  const stateDir = mkdtempSync(join(tmpdir(), 'osg-remediator-state-'));
  try {
    await route({ rootDir, env: { ADVERSARIAL_REVIEW_STATE_DIR: stateDir }, recordImpl: undefined });
    const files = readdirSync(join(stateDir, 'osg-remediator'));
    assert.equal(files.length, 1);
    const value = JSON.parse(readFileSync(join(stateDir, 'osg-remediator', files[0])));
    assert.equal(value.reason, 'assigned');
    assert.equal(existsSync(join(rootDir, 'data')), false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});
