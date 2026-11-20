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
  for (const manifest of [{ checks: [], 'path-glob': {} }, { checks: {} , 'path-glob': {} },
    { checks: { id: { ...entry, paths: 'src/**' } } }, { checks: { id: { ...entry, runs: ['unknown'] } } },
    { checks: { id: { ...entry, path_order: [] } } }]) assert.throws(() => parse(manifest));
  assert.deepEqual(mapping(parse({ checks: { id: { ...entry, ci: { job: 'build' } } } })), { reason: 'invalid-ci-mapping' });
});

test('legacy explicit mapping and conflicting duplicate names stay conservative', () => {
  assert.deepEqual(mapping(parse({ 'path-glob': { '*': [{ name: 'old', command: 'old', ci_jobs: ['build'] }] } })),
    { jobs: ['build'] });
  assert.deepEqual(mapping(parse({ checks: { one: entry, two: { ...entry, ci: { job: 'other', name: 'Other' } } } })),
    { reason: 'ambiguous-ci-mapping' });
});
