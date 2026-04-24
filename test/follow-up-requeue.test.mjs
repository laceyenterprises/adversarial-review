import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, resolveTerminalJobPath } from '../src/follow-up-requeue.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('resolveTerminalJobPath accepts completed and failed follow-up job records under the repo root', () => {
  const completedPath = resolveTerminalJobPath(ROOT, 'data/follow-up-jobs/completed/job.json');
  const failedPath = resolveTerminalJobPath(ROOT, 'data/follow-up-jobs/failed/job.json');

  assert.match(completedPath, /data\/follow-up-jobs\/completed\/job\.json$/);
  assert.match(failedPath, /data\/follow-up-jobs\/failed\/job\.json$/);
});

test('resolveTerminalJobPath rejects paths outside allowed terminal job directories', () => {
  assert.throws(
    () => resolveTerminalJobPath(ROOT, 'data/follow-up-jobs/pending/job.json'),
    /Job path must point to a completed or failed follow-up job JSON/
  );
  assert.throws(
    () => resolveTerminalJobPath(ROOT, '../outside.json'),
    /Job path must point to a completed or failed follow-up job JSON/
  );
});

test('parseArgs resolves the job path and default reason', () => {
  const parsed = parseArgs(['data/follow-up-jobs/completed/job.json']);

  assert.match(parsed.jobPath, /data\/follow-up-jobs\/completed\/job\.json$/);
  assert.equal(parsed.reason, 'Additional remediation round requested.');
});
