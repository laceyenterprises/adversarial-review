import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyNoCiConfigured } from '../src/ama/no-ci-configured.mjs';

function fixture({ workflow = false, rules = [], protectedBranch = false, protection = {}, truncated = false, configPaths = [], suites = 0, statuses = 0, rulePages = null } = {}) {
  return async (path, options) => {
    if (path.includes('/git/trees/')) return { truncated, tree: [...(workflow ? ['.github/workflows/ci.yml'] : []), ...configPaths].map(path => ({ path, type: 'blob' })) };
    if (path.includes('/check-suites')) return { total_count: suites, check_suites: [] };
    if (path.includes('/status?')) return { total_count: statuses, statuses: [] };
    if (path.includes('/rules/')) {
      assert.equal(options?.paginate, true);
      return rulePages ?? [rules];
    }
    if (path.endsWith('/protection')) return protection;
    return { protected: protectedBranch, commit: { sha: 'base-head' } };
  };
}
const args = { repo: 'fixture/repo', base: 'main', head: 'reviewed-head' };
test('live no-workflow/no-required-check proof includes both refs', async () => {
  const paths = [];
  const get = fixture();
  const proof = await verifyNoCiConfigured({ ...args, get: async (path, options) => { paths.push(path); return get(path, options); } });
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

for (const path of ['.circleci/config.yml', '.buildkite/pipeline.yml', 'Jenkinsfile', '.travis.yml',
  'azure-pipelines.yml', '.gitlab-ci.yml', 'vercel.json', 'netlify.toml']) {
  test(`external CI config refuses exception: ${path}`, async () => {
    assert.equal(await verifyNoCiConfigured({ ...args, get: fixture({ configPaths: [path] }) }), null);
  });
}
for (const config of [{ suites: 1 }, { statuses: 1 },
  { rulePages: [Array.from({ length: 30 }, () => ({ type: 'non_creation' })), [{ type: 'required_status_checks' }]] }]) {
  test(`CI activity or later rule page refuses exception: ${JSON.stringify(config)}`, async () => {
    assert.equal(await verifyNoCiConfigured({ ...args, get: fixture(config) }), null);
  });
}
test('malformed CI activity or paginated rules never authorize closure', async () => {
  for (const target of ['/check-suites', '/status?', '/rules/']) {
    const get = fixture();
    await assert.rejects(verifyNoCiConfigured({ ...args,
      get: async (path, options) => path.includes(target) ? {} : get(path, options),
    }));
  }
});
