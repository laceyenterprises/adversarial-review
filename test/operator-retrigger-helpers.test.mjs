import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  ROUND_BUDGET_BY_RISK_CLASS,
  createFollowUpJob,
  readFollowUpJob,
  requeueFollowUpJobForNextRound,
  writeFollowUpJob,
} from '../src/follow-up-jobs.mjs';
import { bumpRemediationBudget, findLatestFollowUpJob } from '../src/operator-retrigger-helpers.mjs';

function makeJob(rootDir, overrides = {}) {
  const created = createFollowUpJob({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 238,
    reviewerModel: 'claude',
    reviewBody: '## Summary\nsummary',
    reviewPostedAt: '2026-05-05T04:00:00.000Z',
    critical: true,
    maxRemediationRounds: 2,
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

function makeAuditEntry(idempotencyKey, requestFingerprint = `fp:${idempotencyKey}`) {
  return {
    ts: '2026-05-05T05:00:00.000Z',
    verb: 'hq.adversarial.retrigger-remediation',
    reason: 'operator retry',
    requestFingerprint,
    idempotencyKey,
    auditRow: { idempotencyKey },
  };
}

test('bumpRemediationBudget returns no-job when no follow-up record exists', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'operator-helpers-'));
  const result = bumpRemediationBudget({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 238,
    bumpBudget: 1,
    auditEntry: makeAuditEntry('idem:no-job'),
  });
  assert.deepEqual(result, { bumped: false, reason: 'no-job' });
});

test('bumpRemediationBudget refuses pending jobs without mutating them', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'operator-helpers-'));
  const { jobPath } = makeJob(rootDir, { status: 'pending' });
  const before = readFileSync(jobPath, 'utf8');
  const result = bumpRemediationBudget({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 238,
    bumpBudget: 1,
    auditEntry: makeAuditEntry('idem:pending'),
  });
  assert.equal(result.bumped, false);
  assert.equal(result.reason, 'job-active');
  assert.equal(readFileSync(jobPath, 'utf8'), before);
});

test('bumpRemediationBudget refuses inProgress jobs without mutating them', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'operator-helpers-'));
  const { jobPath } = makeJob(rootDir, { status: 'inProgress' });
  const before = readFileSync(jobPath, 'utf8');
  const result = bumpRemediationBudget({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 238,
    bumpBudget: 1,
    auditEntry: makeAuditEntry('idem:inprogress'),
  });
  assert.equal(result.bumped, false);
  assert.equal(result.reason, 'job-active');
  assert.equal(readFileSync(jobPath, 'utf8'), before);
});

test('bumpRemediationBudget bumps terminal job budgets atomically', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'operator-helpers-'));
  const { jobPath } = makeJob(rootDir, {
    status: 'failed',
    failedAt: '2026-05-05T04:05:00.000Z',
  });
  const result = bumpRemediationBudget({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 238,
    bumpBudget: 2,
    auditEntry: makeAuditEntry('idem:bump'),
  });
  assert.equal(result.bumped, true);
  assert.equal(result.priorMaxRounds, 2);
  assert.equal(result.newMaxRounds, 4);
  const persisted = JSON.parse(readFileSync(jobPath, 'utf8'));
  assert.equal(persisted.remediationPlan.maxRounds, 4);
});

test('bumpRemediationBudget falls back to the job risk-class budget when maxRounds is missing', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'operator-helpers-'));
  const { jobPath } = makeJob(rootDir, {
    status: 'failed',
    failedAt: '2026-05-05T04:05:00.000Z',
    riskClass: 'critical',
    remediationPlan: {
      currentRound: 0,
      rounds: [],
      stop: null,
      nextAction: null,
    },
  });
  const persistedBefore = JSON.parse(readFileSync(jobPath, 'utf8'));
  delete persistedBefore.remediationPlan.maxRounds;
  if (persistedBefore.recommendedFollowUpAction) {
    delete persistedBefore.recommendedFollowUpAction.maxRounds;
  }
  writeFileSync(jobPath, `${JSON.stringify(persistedBefore, null, 2)}\n`, 'utf8');
  const normalizedMissingMaxRounds = readFollowUpJob(jobPath);

  const result = bumpRemediationBudget({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 238,
    bumpBudget: 1,
    auditEntry: makeAuditEntry('idem:risk-fallback'),
  });

  assert.ok(
    normalizedMissingMaxRounds.remediationPlan.maxRounds >= ROUND_BUDGET_BY_RISK_CLASS.medium,
    'missing maxRounds should normalize to a non-zero risk-tier budget'
  );
  assert.equal(result.priorMaxRounds, normalizedMissingMaxRounds.remediationPlan.maxRounds);
  assert.equal(result.newMaxRounds, normalizedMissingMaxRounds.remediationPlan.maxRounds + 1);
});

test('same idempotency key returns the same audit row on repeated bump', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'operator-helpers-'));
  makeJob(rootDir, {
    status: 'failed',
    failedAt: '2026-05-05T04:05:00.000Z',
  });
  const first = bumpRemediationBudget({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 238,
    bumpBudget: 1,
    auditEntry: makeAuditEntry('idem:shared'),
  });
  const second = bumpRemediationBudget({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 238,
    bumpBudget: 1,
    auditEntry: makeAuditEntry('idem:shared'),
  });
  assert.equal(first.auditRow.idempotencyKey, second.auditRow.idempotencyKey);
});

test('findLatestFollowUpJob skips unreadable job files for unrelated PRs', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'operator-helpers-'));
  makeJob(rootDir, {
    status: 'failed',
    failedAt: '2026-05-05T04:05:00.000Z',
  });

  const brokenDir = path.join(rootDir, 'data', 'follow-up-jobs', 'completed');
  mkdirSync(brokenDir, { recursive: true });
  writeFileSync(path.join(brokenDir, 'broken.json'), '{"jobId":', 'utf8');

  const latest = findLatestFollowUpJob(rootDir, { repo: 'laceyenterprises/agent-os', prNumber: 238 });
  assert.equal(latest.job.prNumber, 238);
});

test('different fingerprint for the same idempotency key is rejected', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'operator-helpers-'));
  makeJob(rootDir, {
    status: 'failed',
    failedAt: '2026-05-05T04:05:00.000Z',
  });
  bumpRemediationBudget({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 238,
    bumpBudget: 1,
    auditEntry: makeAuditEntry('idem:mismatch', 'fp:one'),
  });
  assert.throws(
    () => bumpRemediationBudget({
      rootDir,
      repo: 'laceyenterprises/agent-os',
      prNumber: 238,
      bumpBudget: 1,
      auditEntry: makeAuditEntry('idem:mismatch', 'fp:two'),
    }),
    /IDEMPOTENCY_KEY_MISMATCH/
  );
});

test('requeueFollowUpJobForNextRound accepts terminal stopped:max-rounds-reached', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'operator-helpers-'));
  const { jobPath } = makeJob(rootDir, {
    status: 'stopped',
    stoppedAt: '2026-05-05T04:05:00.000Z',
    remediationPlan: {
      maxRounds: 2,
      currentRound: 1,
      stop: { code: 'max-rounds-reached', reason: 'cap' },
      nextAction: null,
    },
  });
  const requeued = requeueFollowUpJobForNextRound({ rootDir, jobPath });
  assert.equal(requeued.job.status, 'pending');
});

test('requeueFollowUpJobForNextRound accepts terminal stopped:round-budget-exhausted', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'operator-helpers-'));
  const { jobPath } = makeJob(rootDir, {
    status: 'stopped',
    stoppedAt: '2026-05-05T04:05:00.000Z',
    remediationPlan: {
      maxRounds: 3,
      currentRound: 1,
      stop: { code: 'round-budget-exhausted', reason: 'budget' },
      nextAction: null,
    },
  });
  const requeued = requeueFollowUpJobForNextRound({ rootDir, jobPath });
  assert.equal(requeued.job.status, 'pending');
});

test('requeueFollowUpJobForNextRound rejects stopped:abandoned', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'operator-helpers-'));
  const { jobPath } = makeJob(rootDir, {
    status: 'stopped',
    stoppedAt: '2026-05-05T04:05:00.000Z',
    remediationPlan: {
      maxRounds: 3,
      currentRound: 1,
      stop: { code: 'abandoned', reason: 'manual' },
      nextAction: null,
    },
  });
  assert.throws(() => requeueFollowUpJobForNextRound({ rootDir, jobPath }), /stopped:abandoned/);
});

test('requeueFollowUpJobForNextRound rejects pending source jobs', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'operator-helpers-'));
  const { jobPath } = makeJob(rootDir, { status: 'pending' });
  assert.throws(() => requeueFollowUpJobForNextRound({ rootDir, jobPath }), /status pending/);
});

test('atomic job writes do not expose partial JSON to concurrent readers', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'operator-helpers-'));
  const { jobPath } = makeJob(rootDir, {
    status: 'failed',
    failedAt: '2026-05-05T04:05:00.000Z',
  });
  let partialReads = 0;

  const readers = Array.from({ length: 8 }, async () => {
    for (let i = 0; i < 200; i += 1) {
      try {
        JSON.parse(readFileSync(jobPath, 'utf8'));
      } catch {
        partialReads += 1;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });

  const writer = (async () => {
    for (let i = 0; i < 25; i += 1) {
      bumpRemediationBudget({
        rootDir,
        repo: 'laceyenterprises/agent-os',
        prNumber: 238,
        bumpBudget: 1,
        auditEntry: makeAuditEntry(`idem:concurrency:${i}`),
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  })();

  await Promise.all([...readers, writer]);
  assert.equal(partialReads, 0);
});
