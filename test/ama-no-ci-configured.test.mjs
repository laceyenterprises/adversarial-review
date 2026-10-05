import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyNoCiConfigured } from '../src/ama/no-ci-configured.mjs';

function fixture({ workflow = false, rules = [], protectedBranch = false, protection = {}, truncated = false } = {}) {
  return async (path) => {
    if (path.includes('/git/trees/')) return { truncated, tree: workflow ? [{ path: '.github/workflows/ci.yml', type: 'blob' }] : [] };
    if (path.includes('/rules/')) return rules;
    if (path.endsWith('/protection')) return protection;
    return { protected: protectedBranch, commit: { sha: 'base-head' } };
  };
}
const args = { repo: 'fixture/repo', base: 'main', head: 'reviewed-head' };
test('live no-workflow/no-required-check proof includes both refs', async () => {
  const paths = [];
  const get = fixture();
  const proof = await verifyNoCiConfigured({ ...args, get: async (path) => { paths.push(path); return get(path); } });
  assert.equal(proof.reason, 'no CI configured');
  assert.ok(paths.some((p) => p.includes('base-head')));
  assert.ok(paths.some((p) => p.includes('reviewed-head')));
});
for (const config of [
  { workflow: true }, { rules: [{ type: 'required_status_checks' }] },
  { rules: [{ type: 'workflows' }] },
  { protectedBranch: true, protection: { required_status_checks: { contexts: ['ci'] } } },
]) {
  test(`configured CI rejects exception ${JSON.stringify(config)}`, async () => {
    assert.equal(await verifyNoCiConfigured({ ...args, get: fixture(config) }), null);
  });
}
test('lookup failures and truncated trees fail closed', async () => {
  await assert.rejects(verifyNoCiConfigured({ ...args, get: async () => { throw new Error('offline'); } }));
  await assert.rejects(verifyNoCiConfigured({ ...args, get: fixture({ truncated: true }) }));
});
test('protected branch without required status checks must return complete protection metadata', async () => {
  await assert.rejects(verifyNoCiConfigured({ ...args, get: fixture({ protectedBranch: true }) }));
  const proof = await verifyNoCiConfigured({ ...args,
    get: fixture({ protectedBranch: true, protection: { url: 'fixture://protection', required_status_checks: null } }),
  });
  assert.equal(proof.reason, 'no CI configured');
});
