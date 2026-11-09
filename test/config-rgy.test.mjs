import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config-loader.mjs';
import test from 'node:test';

test('independent grader budget and arm declarations are closed and opt-in', () => {
  const schema = JSON.parse(readFileSync(new URL('../src/osg-config-schema.v1.json', import.meta.url)));
  const grader = schema.__keys.rgy.__keys.grader;
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
