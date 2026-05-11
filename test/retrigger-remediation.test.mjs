import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
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
    '--audit-root-dir', rootDir,
  ], { stdout: makeCaptureStream(), stderr: err });

  assert.equal(rc, 1);
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
    '--audit-root-dir', rootDir,
  ], { stdout: makeCaptureStream(), stderr: err });

  assert.equal(rc, 1);
  assert.match(err.text(), /refused:job-active/);
});

test('retrigger-remediation returns runtime exit code when refused-path audit append fails', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-remediation-'));
  const err = makeCaptureStream();
  const rc = main([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'extra round',
    '--root-dir', rootDir,
  ], {
    stdout: makeCaptureStream(),
    stderr: err,
    appendAuditRow: () => {
      throw new Error('disk full');
    },
  });

  assert.equal(rc, 4);
  assert.match(err.text(), /error: could not append operator mutation audit row: disk full/);
  assert.doesNotMatch(err.text(), /\n\s+at\s/);
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
    '--audit-root-dir', rootDir,
  ], { stdout: out, stderr: makeCaptureStream() });

  assert.equal(rc, 0);
  const row = JSON.parse(out.text());
  assert.equal(row.outcome, 'bumped');
  assert.equal(row.newMaxRounds, 2);
  const latest = findLatestFollowUpJob(rootDir, { repo: 'laceyenterprises/agent-os', prNumber: 238 });
  assert.equal(latest.job.status, 'pending');
  assert.equal(latest.job.remediationPlan.maxRounds, 2);
});

test('retrigger-remediation requeues stopped:review-settled jobs for explicit operator requests', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-remediation-'));
  makeJob(rootDir, {
    status: 'stopped',
    stoppedAt: '2026-05-05T04:05:00.000Z',
    remediationPlan: {
      maxRounds: 2,
      currentRound: 1,
      stop: { code: 'review-settled', reason: 'Comment-only review settled the automatic loop' },
      nextAction: null,
    },
  });

  const out = makeCaptureStream();
  const rc = main([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'address non-blocking review flags',
    '--root-dir', rootDir,
    '--audit-root-dir', rootDir,
  ], { stdout: out, stderr: makeCaptureStream() });

  assert.equal(rc, 0);
  const row = JSON.parse(out.text());
  assert.equal(row.outcome, 'bumped');
  assert.equal(row.newMaxRounds, 3);
  const latest = findLatestFollowUpJob(rootDir, { repo: 'laceyenterprises/agent-os', prNumber: 238 });
  assert.equal(latest.job.status, 'pending');
  assert.equal(latest.job.remediationPlan.maxRounds, 3);
});

test('retrigger-remediation refuses stopped jobs that encode operator intent or blocked re-review state', () => {
  for (const stopCode of ['operator-stop', 'rereview-blocked']) {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-remediation-'));
    makeJob(rootDir, {
      status: 'stopped',
      stoppedAt: '2026-05-05T04:05:00.000Z',
      remediationPlan: {
        maxRounds: 1,
        currentRound: 0,
        stop: { code: stopCode, reason: stopCode },
        nextAction: null,
      },
    });

    const err = makeCaptureStream();
    const rc = main([
      '--repo', 'laceyenterprises/agent-os',
      '--pr', '238',
      '--reason', 'grant one more round',
      '--root-dir', rootDir,
      '--audit-root-dir', rootDir,
    ], { stdout: makeCaptureStream(), stderr: err });

    assert.equal(rc, 1);
    assert.match(err.text(), new RegExp(`refused:not-eligible: laceyenterprises/agent-os#238 \\(stopped:${stopCode}\\)`));
    const latest = findLatestFollowUpJob(rootDir, { repo: 'laceyenterprises/agent-os', prNumber: 238 });
    assert.equal(latest.job.status, 'stopped');
  }
});

test('retrigger-remediation writes the audit ledger under data/operator-mutations by default', () => {
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

  const rc = main([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'grant one more round',
    '--root-dir', rootDir,
  ], { stdout: makeCaptureStream(), stderr: makeCaptureStream() });

  assert.equal(rc, 0);
  assert.equal(existsSync(path.join(rootDir, 'data', 'operator-mutations')), true);
});

test('retrigger-remediation re-evaluates retries after a refused row with the same idempotency key', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-remediation-'));
  const args = [
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'extra round',
    '--idempotency-key', 'shared-key',
    '--root-dir', rootDir,
  ];

  const firstErr = makeCaptureStream();
  assert.equal(main(args, { stdout: makeCaptureStream(), stderr: firstErr }), 1);
  assert.match(firstErr.text(), /refused:no-job/);

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
  const secondRc = main(args, { stdout: out, stderr: makeCaptureStream() });
  assert.equal(secondRc, 0);
  assert.equal(JSON.parse(out.text()).outcome, 'bumped');
});

test('retrigger-remediation returns reason-input exit code for unreadable reason file', () => {
  const err = makeCaptureStream();
  const rc = main([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason-file', '/path/does/not/exist.txt',
  ], { stdout: makeCaptureStream(), stderr: err });

  assert.equal(rc, 3);
  assert.match(err.text(), /could not read reason/);
});

test('retrigger-remediation help documents stable exit codes', () => {
  const out = makeCaptureStream();
  const rc = main(['--help'], {
    stdout: out,
    stderr: makeCaptureStream(),
  });

  assert.equal(rc, 0);
  assert.match(out.text(), /Required:/);
  assert.match(out.text(), /Optional:/);
  assert.match(out.text(), /Exit codes:/);
  assert.match(out.text(), /0 success/);
  assert.match(out.text(), /4 runtime error/);
});

test('retrigger-remediation rejects legacy --hq-root', () => {
  const err = makeCaptureStream();
  const rc = main([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'extra round',
    '--hq-root', '/tmp/hq-root',
  ], { stdout: makeCaptureStream(), stderr: err });

  assert.equal(rc, 2);
  assert.match(err.text(), /--hq-root is no longer supported/);
});

test('retrigger-remediation returns runtime exit code with concise stderr when terminal audit append fails after requeue succeeds', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-remediation-'));
  const { jobPath } = makeJob(rootDir, {
    status: 'stopped',
    stoppedAt: '2026-05-05T04:05:00.000Z',
    remediationPlan: {
      maxRounds: 1,
      currentRound: 1,
      stop: { code: 'max-rounds-reached', reason: 'cap' },
      nextAction: null,
    },
  });

  const err = makeCaptureStream();
  const rc = main([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'grant one more round',
    '--root-dir', rootDir,
  ], {
    stdout: makeCaptureStream(),
    stderr: err,
    appendAuditRow: () => {
      throw new Error('disk full');
    },
  });

  assert.equal(rc, 4);
  const job = JSON.parse(readFileSync(jobPath, 'utf8'));
  assert.equal(job.status, 'pending');
  assert.equal(job.remediationPlan.maxRounds, 2);
  assert.match(err.text(), /error: could not append operator mutation audit row: disk full/);
  assert.doesNotMatch(err.text(), /Error: disk full/);
  assert.doesNotMatch(err.text(), /\n\s+at\s/);
});

test('retrigger-remediation treats same-key replay after a lost terminal audit row as success', () => {
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
  const args = [
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'grant one more round',
    '--idempotency-key', 'shared-key',
    '--root-dir', rootDir,
  ];

  assert.equal(main(args, {
    stdout: makeCaptureStream(),
    stderr: makeCaptureStream(),
    appendAuditRow: () => {
      throw new Error('disk full');
    },
  }), 4);

  let requeueCalls = 0;
  const out = makeCaptureStream();
  const rc = main(args, {
    stdout: out,
    stderr: makeCaptureStream(),
    requeueImpl: () => {
      requeueCalls += 1;
      throw new Error('should not retry requeue');
    },
  });

  assert.equal(rc, 0);
  assert.equal(requeueCalls, 0);
  assert.equal(JSON.parse(out.text()).outcome, 'bumped');
});

test('retrigger-remediation maps idempotency mismatches to usage and writes a refusal row', () => {
  const rows = [];
  const err = makeCaptureStream();
  const rc = main([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'grant one more round',
  ], {
    stdout: makeCaptureStream(),
    stderr: err,
    findAuditRow: () => ({
      idempotencyKey: 'shared-key',
      verb: 'hq.adversarial.retrigger-remediation',
      repo: 'laceyenterprises/agent-os',
      pr: 238,
      reason: 'different reason',
      outcome: 'bumped',
    }),
    appendAuditRow: (_rootDir, row) => {
      rows.push(row);
    },
  });

  assert.equal(rc, 2);
  assert.match(err.text(), /refused:idempotency-mismatch/);
  assert.equal(rows.at(-1)?.outcome, 'refused:idempotency-mismatch');
});

test('retrigger-remediation maps job-audit idempotency mismatches to usage on active-job replay', () => {
  const rows = [];
  const err = makeCaptureStream();
  const rc = main([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'grant one more round',
  ], {
    stdout: makeCaptureStream(),
    stderr: err,
    latestJobFinder: () => ({ job: { status: 'pending', jobId: 'job-1', remediationPlan: { maxRounds: 2 } } }),
    bumpBudgetImpl: () => {
      const mismatch = new Error('IDEMPOTENCY_KEY_MISMATCH');
      mismatch.code = 'IDEMPOTENCY_KEY_MISMATCH';
      throw mismatch;
    },
    appendAuditRow: (_rootDir, row) => {
      rows.push(row);
    },
  });

  assert.equal(rc, 2);
  assert.match(err.text(), /refused:idempotency-mismatch/);
  assert.equal(rows.at(-1)?.outcome, 'refused:idempotency-mismatch');
});

test('retrigger-remediation maps job-audit idempotency mismatches to usage after eligibility check', () => {
  const rows = [];
  const err = makeCaptureStream();
  const rc = main([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'grant one more round',
  ], {
    stdout: makeCaptureStream(),
    stderr: err,
    latestJobFinder: () => ({
      job: {
        status: 'stopped',
        jobId: 'job-1',
        remediationPlan: { maxRounds: 2, stop: { code: 'max-rounds-reached' } },
      },
    }),
    bumpBudgetImpl: () => {
      const mismatch = new Error('IDEMPOTENCY_KEY_MISMATCH');
      mismatch.code = 'IDEMPOTENCY_KEY_MISMATCH';
      throw mismatch;
    },
    appendAuditRow: (_rootDir, row) => {
      rows.push(row);
    },
  });

  assert.equal(rc, 2);
  assert.match(err.text(), /refused:idempotency-mismatch/);
  assert.equal(rows.at(-1)?.outcome, 'refused:idempotency-mismatch');
});

test('retrigger-remediation records requeue failures after a successful budget bump', () => {
  const rows = [];
  const err = makeCaptureStream();
  const rc = main([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'grant one more round',
  ], {
    stdout: makeCaptureStream(),
    stderr: err,
    latestJobFinder: () => ({
      job: {
        status: 'stopped',
        jobId: 'job-1',
        remediationPlan: { maxRounds: 1, stop: { code: 'max-rounds-reached' } },
      },
    }),
    bumpBudgetImpl: () => ({
      bumped: true,
      jobPath: '/tmp/job-1.json',
      job: { jobId: 'job-1' },
      priorMaxRounds: 1,
      newMaxRounds: 2,
    }),
    requeueImpl: () => {
      throw new Error('writeFollowUpJob failed');
    },
    appendAuditRow: (_rootDir, row) => {
      rows.push(row);
    },
  });

  assert.equal(rc, 1);
  assert.match(err.text(), /refused:requeue-failed/);
  assert.equal(rows.at(-1)?.outcome, 'refused:requeue-failed');
  assert.equal(rows.at(-1)?.priorMaxRounds, 1);
  assert.equal(rows.at(-1)?.newMaxRounds, 2);
});
