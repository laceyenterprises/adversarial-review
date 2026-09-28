import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { classifyReviewerFailure } from '../src/adapters/reviewer-runtime/cli-direct/classification.mjs';
import { createCliDirectReviewerRuntimeAdapter } from '../src/adapters/reviewer-runtime/cli-direct/index.mjs';
import {
  INFRA_RUNTIME_MISSING_LIBRARY_FAILURE_CLASS,
  hasMissingRuntimeLibrarySignal,
} from '../src/runtime-missing-library.mjs';
import { infraRecoverableFailureClass } from '../src/reviewer-failure-classification.mjs';
import { readCascadeState, recordCascadeFailure } from '../src/reviewer-cascade.mjs';
import { ensureReviewStateSchema } from '../src/review-state.mjs';
import { settleReviewerAttempt } from '../src/watcher.mjs';
import { createFollowUpJob, claimNextFollowUpJob, markFollowUpJobSpawned } from '../src/follow-up-jobs.mjs';
import { reconcileFollowUpJob } from '../src/follow-up-reconcile.mjs';

// NODEPIN-01 (agent-os SEV1 2026-09-28): a Homebrew upgrade moved
// /opt/homebrew/opt/ada-url to 4.0.0 under a watcher still running node
// 26.3.0. Every reviewer child died in dyld before running a line of JS; each
// was logged `failure-class=unknown`, spent review_attempts, and 5 PRs stranded
// at review_status=failed. This is the stderr those children printed.
const DYLD_STDERR = [
  'dyld[48213]: Library not loaded: /opt/homebrew/opt/ada-url/lib/libada.3.dylib',
  '  Referenced from: <5B3F0A63-6E0C-3A4B-9E8B-2D6F1C0A9B41> /opt/homebrew/Cellar/node/26.3.0/bin/node',
  "  Reason: tried: '/opt/homebrew/opt/ada-url/lib/libada.3.dylib' (no such file), "
    + "'/opt/homebrew/Cellar/ada-url/4.0.0/lib/libada.3.dylib' (no such file)",
].join('\n');
const CLASS = INFRA_RUNTIME_MISSING_LIBRARY_FAILURE_CLASS;
const REPO = 'laceyenterprises/agent-os';
const PR = 7285;

let previousHqRoot;
let previousMaxRetries;

beforeEach(() => {
  previousHqRoot = process.env.HQ_ROOT;
  previousMaxRetries = process.env.ADVERSARIAL_REMEDIATION_MAX_TRANSIENT_RETRIES;
  process.env.HQ_ROOT = mkdtempSync(path.join(tmpdir(), 'nodepin-hq-'));
});

afterEach(() => {
  rmSync(process.env.HQ_ROOT, { recursive: true, force: true });
  if (previousHqRoot === undefined) delete process.env.HQ_ROOT;
  else process.env.HQ_ROOT = previousHqRoot;
  if (previousMaxRetries === undefined) delete process.env.ADVERSARIAL_REMEDIATION_MAX_TRANSIENT_RETRIES;
  else process.env.ADVERSARIAL_REMEDIATION_MAX_TRANSIENT_RETRIES = previousMaxRetries;
});

// ── classification ──────────────────────────────────────────────────

test('a dyld "Library not loaded" crash is infra-runtime-missing-library, not unknown', () => {
  assert.equal(CLASS, 'infra-runtime-missing-library');
  assert.equal(classifyReviewerFailure(DYLD_STDERR, null), CLASS);
  // The pre-dyld4 shape has no pid bracket.
  assert.equal(classifyReviewerFailure('dyld: Library not loaded: @rpath/libnode.147.dylib', 134), CLASS);
  // It wins over signals the crash text happens to contain.
  assert.equal(
    classifyReviewerFailure(`Command failed with code null signal SIGABRT\n${DYLD_STDERR}\ncannot find module`, 1),
    CLASS,
  );
});

test('unrelated loader-ish text does not match', () => {
  for (const text of [
    'Error: Cannot find module "js-yaml"',
    'library not loaded yet, retrying',
    'dyld cache rebuilt',
    'Command failed with code 1',
  ]) {
    assert.equal(hasMissingRuntimeLibrarySignal(text), false, text);
    assert.notEqual(classifyReviewerFailure(text, 1), CLASS, text);
  }
});

test('the reviewer adapter reports the class for a reviewer that died in dyld', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'nodepin-adapter-'));
  mkdirSync(path.join(rootDir, 'domains'), { recursive: true });
  try {
    const adapter = createCliDirectReviewerRuntimeAdapter({
      rootDir,
      preflightImpl: async () => ({ codexCli: '/tmp/fake-codex' }),
      spawnCapturedImpl: async () => {
        const err = new Error('Command failed with code null signal SIGABRT');
        err.stderr = DYLD_STDERR;
        err.signal = 'SIGABRT';
        throw err;
      },
      now: () => '2026-09-28T07:30:00.000Z',
    });
    const result = await adapter.spawnReviewer({
      model: 'codex',
      prompt: '',
      subjectContext: { domainId: 'code-pr', repo: REPO, prNumber: PR },
      timeoutMs: 100,
      sessionUuid: 'nodepin-dyld-session',
      forbiddenFallbacks: ['api-key'],
    });
    assert.equal(result.ok, false);
    assert.equal(result.failureClass, CLASS);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

// ── watcher settle: retried on infra recovery, never charged to review_attempts ──

function setupReviewDb({ infraAttempts = 0 } = {}) {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'nodepin-settle-'));
  mkdirSync(path.join(rootDir, 'data'), { recursive: true });
  const db = new Database(path.join(rootDir, 'data', 'reviews.db'));
  ensureReviewStateSchema(db);
  db.prepare(
    `INSERT INTO reviewed_prs
       (repo, pr_number, reviewed_at, reviewer, pr_state, review_status, review_attempts, infra_auto_recover_attempts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(REPO, PR, '2026-09-28T07:00:00.000Z', 'codex', 'open', 'reviewing', 1, infraAttempts);
  // Same SQL as the production statements in src/review-state-db.mjs.
  const statements = {
    markPosted: db.prepare(
      "UPDATE reviewed_prs SET review_status = 'posted', posted_at = ?, review_attempts = review_attempts + 1 WHERE repo = ? AND pr_number = ?",
    ),
    markFailed: db.prepare(
      "UPDATE reviewed_prs SET review_status = 'failed', failed_at = ?, failure_message = ?, review_attempts = review_attempts + 1 WHERE repo = ? AND pr_number = ?",
    ),
    releaseReviewLease: db.prepare(
      "UPDATE reviewed_prs SET review_status = 'pending', failed_at = ?, failure_message = ?, review_attempts = review_attempts + 1 WHERE repo = ? AND pr_number = ? AND review_status = 'reviewing'",
    ),
    markCascadeFailed: db.prepare(
      "UPDATE reviewed_prs SET review_status = 'failed', failed_at = ?, failure_message = ?, reviewer_lease_expires_at = NULL WHERE repo = ? AND pr_number = ?",
    ),
    markPendingUpstream: db.prepare(
      "UPDATE reviewed_prs SET review_status = 'pending-upstream', failed_at = ?, failure_message = ?, reviewer_lease_expires_at = NULL, reviewer_session_uuid = NULL, reviewer_pgid = NULL, infra_auto_recover_attempts = COALESCE(infra_auto_recover_attempts, 0) + 1 WHERE repo = ? AND pr_number = ?",
    ),
    markOutageTransient: db.prepare(
      "UPDATE reviewed_prs SET review_status = 'pending-upstream', failed_at = ?, failure_message = ?, quota_reset_at_utc = ? WHERE repo = ? AND pr_number = ? AND review_status = 'reviewing'",
    ),
    getReviewRow: db.prepare('SELECT * FROM reviewed_prs WHERE repo = ? AND pr_number = ?'),
  };
  return { rootDir, db, statements };
}

function settleDyldFailure({ rootDir, statements }, failureAt = '2026-09-28T07:31:00.000Z') {
  const lines = [];
  settleReviewerAttempt({
    rootDir,
    repoPath: REPO,
    prNumber: PR,
    reviewerModel: 'codex',
    result: {
      ok: false,
      failureClass: CLASS,
      error: 'Command failed with code null signal SIGABRT',
      stderr: DYLD_STDERR,
      stdout: '',
    },
    failureAt,
    maxRemediationRounds: 2,
    statements,
    log: { log: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m) },
  });
  return lines;
}

test('a dyld reviewer failure goes pending-upstream on infra recovery and keeps review_attempts', () => {
  const fixture = setupReviewDb();
  try {
    const lines = settleDyldFailure(fixture);
    const row = fixture.statements.getReviewRow.get(REPO, PR);
    assert.equal(row.review_status, 'pending-upstream');
    assert.equal(row.review_attempts, 1, 'a host fault must not spend the review attempt budget');
    assert.equal(row.infra_auto_recover_attempts, 1);
    assert.match(row.failure_message, /^\[infra-runtime-missing-library\] /);
    assert.match(lines.join('\n'), /failure-class=infra-runtime-missing-library/);
    const cascade = readCascadeState(fixture.rootDir, { repo: REPO, prNumber: PR });
    assert.equal(cascade.transientFailureBreakdown[CLASS], 1, 'recorded under its own class, not folded into cascade');
    assert.equal(cascade.transientFailureBreakdown.cascade, undefined);
  } finally {
    fixture.db.close();
    rmSync(fixture.rootDir, { recursive: true, force: true });
  }
});

test('at the infra cap the row goes terminal with evidence, still without charging review_attempts', () => {
  const fixture = setupReviewDb({ infraAttempts: 3 });
  try {
    settleDyldFailure(fixture);
    const row = fixture.statements.getReviewRow.get(REPO, PR);
    assert.equal(row.review_status, 'failed');
    assert.equal(row.review_attempts, 1);
    assert.match(row.failure_message, /^\[infra-runtime-missing-library\] /);
    assert.match(row.failure_message, /infra auto-recovery cap exhausted/);
    // The next poll still recognises the stored row as infra-recoverable.
    assert.equal(infraRecoverableFailureClass(row), CLASS);
  } finally {
    fixture.db.close();
    rmSync(fixture.rootDir, { recursive: true, force: true });
  }
});

test('stored rows: tagged and legacy [unknown] dyld rows are infra-recoverable as this class', () => {
  assert.equal(
    infraRecoverableFailureClass({ failure_message: `[${CLASS}] Command failed\n${DYLD_STDERR}` }),
    CLASS,
  );
  // A row stranded before this fix, with the dyld stderr in its diagnostics.
  assert.equal(
    infraRecoverableFailureClass({
      failure_message: `[unknown] Command failed with code null signal SIGABRT\nstderr tail:\n${DYLD_STDERR}`,
    }),
    CLASS,
  );
  // A plain command failure keeps its existing bounded class.
  assert.equal(
    infraRecoverableFailureClass({ failure_message: '[unknown] Command failed with code 1' }),
    'reviewer-command-failed',
  );
});

test('cascade state keeps the class instead of collapsing it into cascade', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'nodepin-cascade-'));
  try {
    const state = recordCascadeFailure(rootDir, {
      repo: REPO,
      prNumber: PR,
      failedAt: '2026-09-28T07:31:00.000Z',
      failureClass: CLASS,
      reviewerModel: 'codex',
    });
    assert.deepEqual(state.transientFailureBreakdown, { [CLASS]: 1 });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

// ── remediation: a worker CLI that died in dyld is requeued, not failed ──

async function reconcileDeadWorker(logText) {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'nodepin-job-'));
  createFollowUpJob({
    rootDir, repo: REPO, prNumber: PR,
    reviewerModel: 'claude', reviewBody: '## Summary\nFix the finding.',
    reviewPostedAt: '2026-09-28T06:00:00.000Z', critical: true,
  });
  const claimed = claimNextFollowUpJob({ rootDir, claimedAt: '2026-09-28T07:00:00.000Z' });
  const workspaceDir = path.join(rootDir, 'data', 'follow-up-jobs', 'workspaces', claimed.job.jobId);
  const artifactDir = path.join(workspaceDir, '.adversarial-follow-up');
  mkdirSync(artifactDir, { recursive: true });
  const logPath = path.join(artifactDir, 'codex-worker.log');
  const outputPath = path.join(artifactDir, 'codex-last-message.md');
  writeFileSync(logPath, logText);
  const spawned = markFollowUpJobSpawned({
    jobPath: claimed.jobPath, spawnedAt: '2026-09-28T07:01:00.000Z',
    worker: {
      processId: 8123, model: 'codex',
      workspaceDir: path.relative(rootDir, workspaceDir),
      outputPath: path.relative(rootDir, outputPath),
      logPath: path.relative(rootDir, logPath),
      promptPath: path.relative(rootDir, path.join(artifactDir, 'prompt.md')),
    },
  });
  const result = await reconcileFollowUpJob({
    rootDir, jobPath: spawned.jobPath,
    now: () => '2026-09-28T07:05:00.000Z',
    isProcessAliveImpl: () => false,
    resolvePRLifecycleImpl: async () => null,
  });
  rmSync(rootDir, { recursive: true, force: true });
  return result;
}

test('a remediation worker that died in dyld is requeued on the transient budget without spending the round', async () => {
  const result = await reconcileDeadWorker(`${DYLD_STDERR}\n`);
  assert.equal(result.reconciled, false);
  assert.equal(result.reason, CLASS);
  assert.equal(result.job.status, 'pending');
  assert.equal(result.job.remediationPlan.transientRetries, 1);
  assert.equal(result.job.remediationPlan.currentRound, 0, 'the requeue gives the round back');
  assert.equal(result.job.remediationPlan.retryHistory.at(-1).retryMetadata.code, CLASS);
});

test('once the transient budget is spent the job fails with the class, not as an artifact failure', async () => {
  process.env.ADVERSARIAL_REMEDIATION_MAX_TRANSIENT_RETRIES = '0';
  const result = await reconcileDeadWorker(`${DYLD_STDERR}\n`);
  assert.equal(result.reconciled, true);
  assert.equal(result.outcome, 'failed');
  assert.equal(result.job.failure.code, CLASS);
  assert.deepEqual(result.job.failure.transientRetryBudget, { attempted: 0, max: 0, currentRound: 1 });
});
