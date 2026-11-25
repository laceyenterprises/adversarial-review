import assert from 'node:assert/strict';
import { mkdir, mkdtemp, opendir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createStoppedJobIndex } from '../src/ama/stopped-job-index.mjs';

test('separate readers reuse names and additions invalidate monthly and root partitions', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'stopped-index-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const month = join(dir, 'stopped-archived', '2026-11');
  await mkdir(month, { recursive: true });
  const first = join(month, 'example__repo-pr-1-first.json');
  await writeFile(first, '{}');
  let scans = 0;
  const index = createStoppedJobIndex({ openDirectory: path => { scans++; return opendir(path); } });
  assert.deepEqual((await index(dir, 'example__repo-pr-1-')).paths.map(row => row.path), [first]);
  const initial = scans;
  assert.equal((await index(dir, 'example__repo-pr-1-')).paths.length, 1);
  assert.equal(scans, initial, 'another reader must not enumerate unchanged partitions');
  const second = join(month, 'example__repo-pr-1-second.json');
  await writeFile(second, '{}');
  assert.equal((await index(dir, 'example__repo-pr-1-')).paths.length, 2);
  assert.ok(scans > initial);
  await mkdir(join(dir, 'stopped'));
  await writeFile(join(dir, 'stopped', 'example__repo-pr-1-third.json'), '{}');
  assert.equal((await index(dir, 'example__repo-pr-1-')).paths.length, 3);
  await mkdir(join(dir, 'stopped-archived', '2026-12'));
  await writeFile(join(dir, 'stopped-archived', '2026-12', 'example__repo-pr-1-fourth.json'), '{}');
  assert.equal((await index(dir, 'example__repo-pr-1-')).paths.length, 4);
  const beforeOtherPr = scans;
  assert.equal((await index(dir, 'example__repo-pr-2-')).paths.length, 0);
  assert.ok(scans > beforeOtherPr, 'PR prefixes must have separate entries');
});

test('bounded scans name their limit and never cache partial results', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'stopped-cap-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'stopped'));
  await writeFile(join(dir, 'stopped', 'example__repo-pr-1-first.json'), '{}');
  await writeFile(join(dir, 'stopped', 'example__repo-pr-1-second.json'), '{}');
  const index = createStoppedJobIndex({ maxRecords: 1 });
  await assert.rejects(index(dir, 'example__repo-pr-1-'), /scan capped at 1 matching records/);
  await rm(join(dir, 'stopped', 'example__repo-pr-1-second.json'));
  assert.equal((await index(dir, 'example__repo-pr-1-')).paths.length, 1);
  await assert.rejects(createStoppedJobIndex({ maxEntries: 1 })(dir, 'example__repo-pr-1-')
    .then(async () => {
      await writeFile(join(dir, 'stopped', 'unrelated.json'), '{}');
      return createStoppedJobIndex({ maxEntries: 1 })(dir, 'example__repo-pr-1-');
    }), /scan capped at 1 entries/);
});
