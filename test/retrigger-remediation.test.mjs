import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { main } from '../src/retrigger-remediation.mjs';
import { createFollowUpJob, writeFollowUpJob } from '../src/follow-up-jobs.mjs';
import { findLatestFollowUpJob } from '../src/operator-retrigger-helpers.mjs';

function makeCaptureStream() {
  const chunks = [];
  return {
    write(chunk) { chunks.push(String(chunk)); return true; },
    text() { return chunks.join(''); },
  };
}

function makeJob(rootDir, overrides = {}) {
  const created = createFollowUpJob({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 238,
    reviewerModel: 'claude',
    reviewBody: '## Summary\nsummary',
    reviewPostedAt: '2026-05-05T04:00:00.000Z',
    critical: true,
    maxRemediationRounds: 1,
  });
  const job = {
    ...created.job,
    ...overrides,
    remediationPlan: {
      ...created.job.remediationPlan,
      ...(overrides.remediationPlan || {}),
    },
  };
  writeFollowUpJob(created.jobPath, job);
  return { jobPath: created.jobPath, job };
}

test('retrigger-remediation refuses when no job exists', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-remediation-'));
  const err = makeCaptureStream();
  const rc = main([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'extra round',
    '--root-dir', rootDir,
    '--hq-root', rootDir,
  ], { stdout: makeCaptureStream(), stderr: err });

  assert.equal(rc, 2);
  assert.match(err.text(), /refused:no-job/);
});

test('retrigger-remediation refuses active jobs', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-remediation-'));
  makeJob(rootDir, { status: 'inProgress' });
  const err = makeCaptureStream();
  const rc = main([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'extra round',
    '--root-dir', rootDir,
    '--hq-root', rootDir,
  ], { stdout: makeCaptureStream(), stderr: err });

  assert.equal(rc, 2);
  assert.match(err.text(), /refused:job-active/);
});

test('retrigger-remediation bumps and requeues eligible stopped jobs', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-remediation-'));
  makeJob(rootDir, {
    status: 'stopped',
    stoppedAt: '2026-05-05T04:05:00.000Z',
    remediationPlan: {
      maxRounds: 1,
      currentRound: 1,
      stop: { code: 'max-rounds-reached', reason: 'cap' },
      nextAction: null,
    },
  });

  const out = makeCaptureStream();
  const rc = main([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'grant one more round',
    '--root-dir', rootDir,
    '--hq-root', rootDir,
  ], { stdout: out, stderr: makeCaptureStream() });

  assert.equal(rc, 0);
  const row = JSON.parse(out.text());
  assert.equal(row.outcome, 'bumped');
  assert.equal(row.newMaxRounds, 2);
  const latest = findLatestFollowUpJob(rootDir, { repo: 'laceyenterprises/agent-os', prNumber: 238 });
  assert.equal(latest.job.status, 'pending');
  assert.equal(latest.job.remediationPlan.maxRounds, 2);
});
