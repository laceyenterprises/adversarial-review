import test from 'node:test';
import assert from 'node:assert/strict';
import { coverageDeclarations } from '../src/ama/hammer-validation-coverage.mjs';

const entry = { name: 'check', command: 'python3 check.py', runs: ['ci', 'pre-push'],
  paths: ['src/**'], ci: { job: 'build', name: 'Run check' } };
const parse = manifest => coverageDeclarations(JSON.stringify(manifest));
const mapping = value => [...value.values()][0];

test('current checks registries preserve exact command and step mapping', () => {
  const checks = parse({ checks: { id: entry } });
  assert.deepEqual([...checks.keys()], [JSON.stringify(['check', 'python3 check.py'])]);
  assert.deepEqual(mapping(checks), { jobs: [{ job: 'build', step: 'Run check' }] });
  const { paths, ...scoped } = entry;
  assert.deepEqual(mapping(parse({ checks: { id: { ...scoped, suite: { paths } } } })), mapping(checks));
});

test('current local-only, advisory and unmapped contributions retain local work', () => {
  for (const fields of [{ advisory: true }, { local_only: true }, { 'ratchet-placement': { scope: 'local-only' } },
    { local_advisory_arg: '--advisory' }]) {
    assert.deepEqual(mapping(parse({ checks: { id: { ...entry, ...fields } } })), { reason: 'local-only' });
  }
  assert.deepEqual(mapping(parse({ checks: { id: { ...entry, runs: ['pre-push'] } } })), { reason: 'no-ci-mapping' });
  assert.equal(parse({ checks: { id: { ...entry, runs: ['ci'] } } }).size, 0);
});

test('malformed or mixed registry schemas cannot lend coverage', () => {
  for (const manifest of [{ checks: [], 'path-glob': {} }, { checks: {} , 'path-glob': {} }]) {
    assert.throws(() => parse(manifest));
  }
  assert.deepEqual(mapping(parse({ checks: { id: { ...entry, ci: { job: 'build' } } } })), { reason: 'invalid-ci-mapping' });
});

test('unrelated lanes and malformed entries do not collapse valid registry mappings', () => {
  for (const fields of [{ paths: 'src/**' }, { paths: null }, { path_order: [] }, { runs: null },
    { runs: { includes: 'invalid' } }, { runs: ['pre-push', 42] }]) {
    const checks = parse({ checks: { good: entry, bad: { ...entry, name: 'bad', ...fields }, absent: null } });
    assert.deepEqual(checks.get(JSON.stringify(['check', entry.command])), { jobs: [{ job: 'build', step: 'Run check' }] });
    assert.deepEqual(checks.get(JSON.stringify(['bad', entry.command])), { reason: 'invalid-ci-mapping' });
  }
  const { paths, ...withoutPaths } = entry;
  assert.ok(paths);
  for (const fields of [{ runs: ['ci', 'pre-push', 'nightly'] }, withoutPaths]) {
    assert.deepEqual(mapping(parse({ checks: { id: { ...withoutPaths, ...fields } } })),
      { jobs: [{ job: 'build', step: 'Run check' }] });
  }
  assert.equal(parse({ checks: { unrelated: { runs: ['nightly'], paths: 'invalid' } } }).size, 0);
});

test('legacy explicit mapping and conflicting duplicate names stay conservative', () => {
  assert.deepEqual(mapping(parse({ 'path-glob': { '*': [{ name: 'old', command: 'old', ci_jobs: ['build'] }] } })),
    { jobs: ['build'] });
  assert.deepEqual(mapping(parse({ checks: { one: entry, two: { ...entry, ci: { job: 'other', name: 'Other' } } } })),
    { reason: 'ambiguous-ci-mapping' });
});
