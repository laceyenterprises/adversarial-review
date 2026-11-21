import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config-loader.mjs';
import { schemaV1 } from '../src/config-schema.mjs';
import test from 'node:test';

test('independent grader schema declares strict keys, budget defaults and opt-in arms', () => {
  const grader = schemaV1().__keys.osg.__keys.rgy.__keys.grader;
  assert.equal(grader.__strict, true);
  assert.equal(grader.__keys.run_cost_cap_usd.__default, 10);
  assert.equal(grader.__keys.day_cost_cap_usd.__default, 25);
  assert.equal(grader.__keys.max_call_cost_usd.__default, 0.1);
  assert.deepEqual(grader.__keys.arms.__default, []);
  assert.deepEqual(Object.keys(grader.__keys.arms.__item.__keys).sort(),
    ['effort', 'harness', 'model', 'name', 'prompt', 'worker_class']);
});


test('grader config is accepted and negative budget rejected by Node reader', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rgy-config-'));
  const topPath = join(dir, 'config.yaml');
  try {
    writeFileSync(topPath, JSON.stringify({ version: 1, osg: { rgy: { grader: {
      run_cost_cap_usd: 2, day_cost_cap_usd: 3,
    } } } }));
    assert.equal(loadConfig({ topPath, env: {} }).get('osg.rgy.grader.run_cost_cap_usd'), 2);
    writeFileSync(topPath, JSON.stringify({ version: 1, osg: { rgy: { grader: {
      day_cost_cap_usd: -1,
    } } } }));
    assert.throws(() => loadConfig({ topPath, env: {} }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('grader arms validate supplied fields and reject unknown keys like the Python loader', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rgy-arms-'));
  const topPath = join(dir, 'config.yaml');
  const arm = { name: 'independent', worker_class: 'codex', harness: 'codex',
    model: 'fixture-model', effort: 'high', prompt: 'Grade this finding.\nReturn evidence.' };
  const loadArm = value => {
    writeFileSync(topPath, JSON.stringify({ version: 1, osg: { rgy: { grader: { arms: [value] } } } }));
    return loadConfig({ topPath, env: {} }).get('osg.rgy.grader.arms');
  };
  try {
    assert.deepEqual(loadArm(arm), [arm]);
    for (const field of Object.keys(arm)) {
      assert.throws(() => loadArm({ ...arm, [field]: '' }), error =>
        error.message.includes(`osg.rgy.grader.arms[0].${field}`), `invalid ${field}`);
    }
    // ONS-07: same as Python — an unknown key fails, a metadata key is skipped.
    assert.throws(() => loadArm({ ...arm, unexpected: true }),
      /osg\.rgy\.grader\.arms\[0\]\.unexpected: unknown key \(strict schema\)/);
    assert.deepEqual(loadArm({ ...arm, __unexpected: true }), [arm]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
