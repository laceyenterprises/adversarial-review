import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, resolveFollowUpJobPath } from '../src/follow-up-stop.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('resolveFollowUpJobPath accepts stoppable follow-up job records under the repo root', () => {
  const pendingPath = resolveFollowUpJobPath(ROOT, 'data/follow-up-jobs/pending/job.json');
  const inProgressPath = resolveFollowUpJobPath(ROOT, 'data/follow-up-jobs/in-progress/job.json');
  const completedPath = resolveFollowUpJobPath(ROOT, 'data/follow-up-jobs/completed/job.json');
  const failedPath = resolveFollowUpJobPath(ROOT, 'data/follow-up-jobs/failed/job.json');

  assert.match(pendingPath, /data\/follow-up-jobs\/pending\/job\.json$/);
  assert.match(inProgressPath, /data\/follow-up-jobs\/in-progress\/job\.json$/);
  assert.match(completedPath, /data\/follow-up-jobs\/completed\/job\.json$/);
  assert.match(failedPath, /data\/follow-up-jobs\/failed\/job\.json$/);
});

test('resolveFollowUpJobPath rejects non-job or disallowed follow-up paths', () => {
  assert.throws(
    () => resolveFollowUpJobPath(ROOT, 'data/follow-up-jobs/stopped/job.json'),
    /Job path must point to a pending, in-progress, completed, or failed follow-up job JSON/
  );
  assert.throws(
    () => resolveFollowUpJobPath(ROOT, '../outside.json'),
    /Job path must point to a pending, in-progress, completed, or failed follow-up job JSON/
  );
});

test('parseArgs resolves the stop job path and default reason', () => {
  const parsed = parseArgs(['data/follow-up-jobs/in-progress/job.json']);

  assert.match(parsed.jobPath, /data\/follow-up-jobs\/in-progress\/job\.json$/);
  assert.equal(parsed.reason, 'Operator requested stop.');
});
