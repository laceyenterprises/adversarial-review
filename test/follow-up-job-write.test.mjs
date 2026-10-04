import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { writeFollowUpJob, withFollowUpJobLock } from '../src/follow-up-job-write.mjs';

test('stale daemon snapshots preserve the recovery intent on terminal jobs', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'job-write-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'stopped', 'job.json');
  mkdirSync(join(root, 'stopped'));
  const intent = { headSha: 'a'.repeat(40), requestedAt: '2026-10-04T00:00:00Z' };
  writeFollowUpJob(path, { jobId: 'job', completion: { withheldHeadReReview: intent } });
  writeFollowUpJob(path, { jobId: 'job', daemonField: 'new', completion: { anotherField: true } });
  const current = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(current.completion.withheldHeadReReview, intent);
  assert.equal(current.completion.anotherField, true);
  assert.equal(current.daemonField, 'new');
});

test('cross-process writer contention defers without overwriting a job', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'job-lock-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'stopped', 'job.json');
  mkdirSync(join(root, 'stopped'));
  writeFollowUpJob(path, { jobId: 'job' });
  withFollowUpJobLock(root, () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { writeFollowUpJob } from ${JSON.stringify(new URL('../src/follow-up-job-write.mjs', import.meta.url).href)};
      try { writeFollowUpJob(${JSON.stringify(path)}, { jobId: 'changed' }); process.exit(1); }
      catch (error) { if (!['EAGAIN', 'EWOULDBLOCK'].includes(error.code)) throw error; }
    `], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
  });
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).jobId, 'job');
  writeFollowUpJob(path, { jobId: 'after-release' });
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).jobId, 'after-release');
});
