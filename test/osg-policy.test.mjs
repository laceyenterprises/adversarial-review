import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const vectors = JSON.parse(readFileSync(new URL('./fixtures/osg-policy.v1.json', import.meta.url)));
for (const vector of vectors.cases) {
  test(`OSG-18 policy: ${vector.name}`, async () => {
    const { readPolicy } = await import('../src/osg-policy.mjs');
    if (vector.valid) assert.deepEqual(readPolicy(vector.policy), vector.policy);
    else assert.throws(() => readPolicy(vector.policy));
  });
}

test('promotion selects only one stratum; reverting restores current route', async () => {
  const { resolveDefault } = await import('../src/osg-policy.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'policy-'));
  try {
    const policyPath = join(dir, 'policy.json');
    const current = { reviewer: 'fixture-current', account: 'pool-selected', nested: { unchanged: true } };
    const bytes = JSON.stringify(current);
    const stratum = { task_type: 'fix', size: 'small' };
    for (const vector of [vectors.cases[0], vectors.cases[1], vectors.cases[0]]) {
      writeFileSync(policyPath, JSON.stringify(vector.policy));
      const options = { enabled: true, mode: 'apply', policyPath, role: 'builder', stratum, current, allowArm: () => true };
      const expected = vector.policy.entries[0].arm === 'current' ? current : vector.policy.entries[0].arm;
      assert.deepEqual(resolveDefault(options).arm, expected);
      assert.equal(resolveDefault({ ...options, role: 'reviewer' }).arm, current);
      assert.equal(resolveDefault({ ...options, stratum: { ...stratum, size: 'large' } }).arm, current);
      for (const inactive of [{ enabled: false }, { mode: 'off' }, { mode: 'shadow' }]) {
        let calls = 0;
        const result = resolveDefault({ ...options, ...inactive, load: () => { calls++; throw Error(); } });
        assert.equal(calls, 0);
        assert.equal(result.arm, current);
        assert.equal(JSON.stringify(result.arm), bytes);
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('read/validation/availability failures preserve route and return safe reason', async () => {
  const { resolveDefault } = await import('../src/osg-policy.mjs');
  const current = {};
  const options = { enabled: true, mode: 'apply', policyPath: 'unused', role: 'builder',
    stratum: { task_type: 'fix', size: 'small' }, current, load: () => vectors.cases[1].policy };
  for (const patch of [ { load: () => { throw Error('synthetic private diagnostic'); } },
    { allowArm: () => false }, { allowArm: () => { throw Error('synthetic private diagnostic'); } }, {} ]) {
    const result = resolveDefault({ ...options, ...patch });
    assert.equal(result.arm, current);
    assert.ok(['policy-error', 'policy-unavailable'].includes(result.reason));
  }
});

test('file reader rejects missing, oversized, non-UTF8, BOM and invalid JSON inputs', async () => {
  const { loadPolicy } = await import('../src/osg-policy.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'policy-invalid-'));
  try {
    const path = join(dir, 'policy.json');
    assert.throws(() => loadPolicy(path));
    assert.throws(() => loadPolicy(dir));
    for (const bytes of [Buffer.from('{'), Buffer.from([255]), Buffer.from('\ufeff' + JSON.stringify(vectors.cases[0].policy)), Buffer.alloc(131073, 32)]) {
      writeFileSync(path, bytes);
      assert.throws(() => loadPolicy(path));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('file and injected loaders enforce the same policy contract', async () => {
  const { loadPolicy, resolveDefault } = await import('../src/osg-policy.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'policy-contract-'));
  const current = {};
  try {
    const policyPath = join(dir, 'policy.json');
    for (const vector of vectors.cases) {
      writeFileSync(policyPath, JSON.stringify(vector.policy));
      const options = { enabled: true, mode: 'apply', policyPath, role: 'builder',
        stratum: { task_type: 'fix', size: 'small' }, current, allowArm: () => true };
      const expected = !vector.valid ? { arm: current, reason: 'policy-error' }
        : vector.policy.entries[0].arm === 'current' ? { arm: current, reason: 'policy-current' }
          : { arm: vector.policy.entries[0].arm, reason: 'policy-promoted' };
      for (const load of [undefined, loadPolicy, () => vector.policy]) {
        assert.deepEqual(resolveDefault({ ...options, load }), expected, vector.name);
      }
      if (!vector.valid) {
        assert.throws(() => loadPolicy(policyPath), vector.name);
      } else {
        const policy = loadPolicy(policyPath);
        assert.deepEqual(policy, vector.policy);
        const assertFrozen = value => {
          if (value !== null && typeof value === 'object') {
            assert.ok(Object.isFrozen(value));
            for (const child of Object.values(value)) assertFrozen(child);
          }
        };
        assertFrozen(policy);
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
