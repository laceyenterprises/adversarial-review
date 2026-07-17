import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  loadDomainRegistry,
  resolveEnabledDomainIds,
  validateDomainConfig,
} from '../src/domain-registry.mjs';
import { createReviewerRuntimeAdapterForDomain } from '../src/adapters/reviewer-runtime/index.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function baseConfig(id, overrides = {}) {
  return {
    id,
    enabled: true,
    subjectChannel: 'markdown-file',
    commsChannel: 'slack-thread',
    reviewerRuntime: 'fixture-stub',
    promptSet: id,
    riskClasses: { low: { maxRemediationRounds: 1 } },
    ...overrides,
  };
}

function makeRoot(domains) {
  const root = mkdtempSync(join(tmpdir(), 'domain-registry-'));
  mkdirSync(join(root, 'domains'), { recursive: true });
  for (const [fileId, config] of Object.entries(domains)) {
    writeFileSync(
      join(root, 'domains', `${fileId}.json`),
      typeof config === 'string' ? config : JSON.stringify(config, null, 2),
      'utf8',
    );
  }
  return root;
}

test('production domains/ registers every config, enables only code-pr', () => {
  const registry = loadDomainRegistry(REPO_ROOT);
  const registered = registry.domains.map((d) => d.id).sort();
  // code-pr-security (ARC-04) is registered but gated OFF: it must appear in the
  // registered set yet stay out of the enabled (actively polled) set.
  assert.deepEqual(registered, ['acpx-smoke', 'code-pr', 'code-pr-security', 'research-finding']);
  assert.deepEqual(resolveEnabledDomainIds(registry), ['code-pr']);
});

test('two enabled domains are both surfaced; disabled domains are excluded', () => {
  const root = makeRoot({
    'domain-a': baseConfig('domain-a', { enabled: true }),
    'domain-b': baseConfig('domain-b', { enabled: true, reviewerRuntime: 'cli-direct' }),
    'domain-c': baseConfig('domain-c', { enabled: false }),
  });
  try {
    const registry = loadDomainRegistry(root);
    assert.deepEqual(registry.domains.map((d) => d.id), ['domain-a', 'domain-b', 'domain-c']);
    assert.deepEqual(resolveEnabledDomainIds(registry), ['domain-a', 'domain-b']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('registry loader fails loud on a missing enabled flag', () => {
  const cfg = baseConfig('domain-a');
  delete cfg.enabled;
  const root = makeRoot({ 'domain-a': cfg });
  try {
    assert.throws(() => loadDomainRegistry(root), /missing the explicit boolean "enabled" flag/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('registry loader fails loud on a non-boolean enabled flag', () => {
  const root = makeRoot({ 'domain-a': baseConfig('domain-a', { enabled: 'yes' }) });
  try {
    assert.throws(() => loadDomainRegistry(root), /missing the explicit boolean "enabled" flag/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('registry loader fails loud when id does not match the filename', () => {
  const root = makeRoot({ 'domain-a': baseConfig('mismatched-id') });
  try {
    assert.throws(() => loadDomainRegistry(root), /must match the domains\/<id>\.json filename/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('registry loader fails loud on a missing required channel field', () => {
  const cfg = baseConfig('domain-a');
  delete cfg.subjectChannel;
  const root = makeRoot({ 'domain-a': cfg });
  try {
    assert.throws(() => loadDomainRegistry(root), /missing required string field "subjectChannel"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('registry loader fails loud on malformed JSON', () => {
  const root = makeRoot({ 'domain-a': '{ this is not json' });
  try {
    assert.throws(() => loadDomainRegistry(root), /failed to read domains\/domain-a\.json/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('registry loader fails loud when no domain configs are present', () => {
  const root = mkdtempSync(join(tmpdir(), 'domain-registry-empty-'));
  mkdirSync(join(root, 'domains'), { recursive: true });
  try {
    assert.throws(() => loadDomainRegistry(root), /no domains\/\*\.json configs found/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('validateDomainConfig rejects a non-object riskClasses', () => {
  assert.throws(
    () => validateDomainConfig('domain-a', baseConfig('domain-a', { riskClasses: 'low' })),
    /non-object "riskClasses" field/,
  );
});

test('two-domain run pumps each domain through its own isolated adapter set', () => {
  // Two enabled domains declaring different reviewer runtimes must resolve to
  // distinct, config-driven adapter instances — the precondition for the poll
  // loop pumping each registered domain through its own adapter set without any
  // cross-domain state bleed.
  const root = makeRoot({
    'domain-a': baseConfig('domain-a', { reviewerRuntime: 'fixture-stub' }),
    'domain-b': baseConfig('domain-b', { reviewerRuntime: 'cli-direct' }),
  });
  try {
    const registry = loadDomainRegistry(root);
    const adapterSets = registry.enabledDomains.map((domain) => ({
      domainId: domain.id,
      domainConfig: domain.config,
      reviewerRuntimeAdapter: createReviewerRuntimeAdapterForDomain({
        rootDir: root,
        domainId: domain.id,
        domainConfig: domain.config,
      }),
    }));

    const [setA, setB] = adapterSets;
    assert.equal(setA.domainId, 'domain-a');
    assert.equal(setB.domainId, 'domain-b');

    // Config-driven runtime selection: each domain got the adapter its config named.
    assert.equal(setA.reviewerRuntimeAdapter.describe().id, 'fixture-stub');
    assert.equal(setB.reviewerRuntimeAdapter.describe().id, 'cli-direct');

    // No shared adapter instance and no shared config object across domains.
    assert.notEqual(setA.reviewerRuntimeAdapter, setB.reviewerRuntimeAdapter);
    assert.notEqual(setA.domainConfig, setB.domainConfig);

    // Mutating one domain's resolved config cannot bleed into the other's.
    setA.domainConfig.promptSet = 'mutated-a';
    assert.equal(setB.domainConfig.promptSet, 'domain-b');
    assert.equal(registry.enabledDomains[1].config.promptSet, 'domain-b');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
