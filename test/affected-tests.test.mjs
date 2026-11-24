import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildReverseGraph, planAffectedTests, selectAffectedTests } from './helpers/affected-tests.mjs';
import { planPrShards } from './helpers/parallel-plan.mjs';

const files = ['test/api.test.mjs', 'test/cli.test.mjs', 'test/other.test.mjs'];
const fixtureGraph = new Map([
  ['src/core.mjs', new Set(['src/public.mjs'])],
  ['src/public.mjs', new Set(['src/core.mjs', 'bin/example.mjs', files[0]])],
  ['bin/example.mjs', new Set([files[1]])],
]);
const change = (file, status = 'M') => ({ file, status });

test('affected tests follow transitive dependencies, handle cycles and retain changed tests', () => {
  assert.deepEqual(selectAffectedTests(files, [change('src/core.mjs')], () => fixtureGraph).files,
    files.slice(0, 2));
  assert.deepEqual(selectAffectedTests(files, [change(files[2], 'A')], () => fixtureGraph).files, [files[2]]);
});

test('empty and prose-only diffs select no tests without reading the graph', () => {
  for (const changes of [[], [change('README.md'), change('docs/guide.txt', 'D')]]) {
    const plan = selectAffectedTests(files, changes, () => assert.fail('graph read for prose'));
    assert.equal(plan.mode, 'none');
    assert.deepEqual(plan.files, []);
  }
});

test('harness, workflow, dependency, shared fixture and deleted source changes select the full suite', () => {
  for (const input of [
    change('test/run-tests.mjs'), change('test/helpers/shared.mjs'), change('test/fixtures/input.txt'),
    change('src/node-test-concurrency.mjs'), change('package.json'), change('package-lock.json'),
    change('.github/workflows/test.yml'), change('src/core.mjs', 'D'),
  ]) {
    const plan = selectAffectedTests(files, [input], () => assert.fail('graph read for full fallback'));
    assert.equal(plan.mode, 'full', input.file);
    assert.deepEqual(plan.files, files);
  }
  assert.equal(selectAffectedTests(files, [change('src/unmapped.mjs')], () => fixtureGraph).mode, 'full');
});

test('reads the committed diff and follows real imports and literal executable paths', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'affected-tests-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (name, contents) => writeFileSync(path.join(root, name), contents);
  for (const directory of ['src', 'bin', 'scripts', 'test']) mkdirSync(path.join(root, directory));
  mkdirSync(path.join(root, 'test', 'helpers'));
  write('src/core.mjs', 'export const answer = 1;\n');
  write('src/public.mjs', 'export { answer } from "./core.mjs";\n');
  write('bin/example.mjs', 'await import("../src/public.mjs?fixture=1");\n');
  write('scripts/example.sh', 'node bin/example.mjs\n');
  write(files[0], 'import "../src/public.mjs";\n');
  write(files[1], 'const script = ["scripts", "example.sh"];\n');
  write('test/helpers/parallel-plan.mjs', 'export const first = "test/api.test.mjs";\n');
  write(files[2], 'import "./helpers/parallel-plan.mjs";\n// import "../src/core.mjs";\n');
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10_000 });
  const author = ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false'];
  const commit = () => {
    git('add', 'src', 'bin', 'scripts', 'test');
    git(...author, 'commit', '--quiet', '-m', 'Synthetic fixture');
  };
  git('init', '--quiet', '--template=', '--initial-branch=base');
  commit();
  git('switch', '--quiet', '-c', 'topic');
  write('src/core.mjs', 'export const answer = 2;\n');
  commit();
  git('switch', '--quiet', 'base');
  write('src/base-only.mjs', 'export const onBase = true;\n');
  commit();
  git(...author, 'merge', '--quiet', '--no-ff', '-m', 'Synthetic merge', 'topic');
  const graph = buildReverseGraph(root);
  assert.deepEqual([...graph.get('src/core.mjs')], ['src/public.mjs']);
  const plan = planAffectedTests(root, files, 'HEAD^1');
  assert.deepEqual(plan.changes, [change('src/core.mjs')]);
  assert.deepEqual(plan.files, files.slice(0, 2));
  assert.equal(planAffectedTests(root, files, 'missing-base').mode, 'full');
  write(files[0], 'import ;\n');
  assert.match(planAffectedTests(root, files, 'HEAD^1').reason, /cannot scan test\/api\.test\.mjs/);
});

test('small selections run on both versions and large selections split deterministically', () => {
  const suite = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const durations = { a: 7, b: 6, c: 5, d: 4, e: 3, f: 2, g: 1 };
  assert.equal(planPrShards(['c'], suite, durations), null);
  assert.equal(planPrShards(['f', 'g'], suite, durations), null);
  assert.deepEqual(planPrShards(['b', 'a'], suite, durations), [['a'], ['b']]);
  const shards = planPrShards(suite, suite, durations);
  assert.deepEqual(shards, [['a', 'd', 'e'], ['b', 'c', 'f', 'g']]);
  assert.deepEqual(shards.flat().sort(), suite);
  assert.deepEqual(planPrShards([...suite].reverse(), suite, durations), shards);
});

test('PR selection settings stay in the outer runner', () => {
  assert.equal(process.env.AR_TEST_PR_BASE, undefined);
  assert.equal(process.env.AR_TEST_PR_SHARD, undefined);
});
