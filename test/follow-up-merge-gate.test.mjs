import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  claimNextFollowUpJob,
  createFollowUpJob,
  markFollowUpJobSpawned,
} from '../src/follow-up-jobs.mjs';
import {
  consumeNextFollowUpJob,
  reconcileFollowUpJob,
  reconcileInProgressFollowUpJobs,
} from '../src/follow-up-remediation.mjs';
import {
  ensureReviewStateSchema,
  fetchLivePRLifecycle,
  openReviewStateDb,
  resolvePRLifecycle,
} from '../src/review-state.mjs';

// Small factory so each test has an isolated rootDir + a freshly-
// claimable pending job.
function setupPendingJob(rootDir, overrides = {}) {
  return createFollowUpJob({
    rootDir,
    repo: overrides.repo || 'laceyenterprises/clio',
    prNumber: overrides.prNumber || 42,
    reviewerModel: 'codex',
    linearTicketId: null,
    reviewBody: '## Summary\nNothing useful.\n## Verdict\nRequest changes',
    reviewPostedAt: '2026-05-02T10:00:00.000Z',
    critical: false,
    ...overrides,
  });
}

function findStoppedJobOnDisk(rootDir, jobId) {
  // Linear scan across stopped/. Tests run with at most one job, so
  // O(n) is fine and avoids depending on the exact filename mangling.
  const stoppedDir = path.join(rootDir, 'data', 'follow-up-jobs', 'stopped');
  let entries;
  try {
    entries = readdirSync(stoppedDir);
  } catch {
    return null;
  }
  for (const name of entries) {
    const candidate = path.join(stoppedDir, name);
    const json = JSON.parse(readFileSync(candidate, 'utf8'));
    if (json.jobId === jobId) return { jobPath: candidate, json };
  }
  return null;
}

function noopSpawn() {
  return { pid: 0, unref() {} };
}

// ── consume path ─────────────────────────────────────────────────────────────

test('consumeNextFollowUpJob short-circuits to stopped/operator-merged-pr when live lookup reports merged', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const created = setupPendingJob(rootDir, { prNumber: 100 });

  let spawnFired = false;
  let cloneFired = false;

  const result = await consumeNextFollowUpJob({
    rootDir,
    promptTemplate: 'unused',
    execFileImpl: async (command, args) => {
      if (command === 'gh' && args[0] === 'repo' && args[1] === 'clone') {
        cloneFired = true;
      }
      return { stdout: '', stderr: '' };
    },
    spawnImpl: () => {
      spawnFired = true;
      return { pid: 9999, unref() {} };
    },
    now: () => '2026-05-02T11:00:00.000Z',
    resolvePRLifecycleImpl: async () => ({
      source: 'live',
      prState: 'merged',
      mergedAt: '2026-05-02T10:30:00.000Z',
      closedAt: null,
    }),
  });

  assert.equal(result.consumed, false);
  assert.equal(result.reason, 'pr-merged');
  assert.equal(spawnFired, false, 'must NOT spawn a worker when the PR is already merged');
  assert.equal(cloneFired, false, 'must NOT clone the repo when the PR is already merged');

  const stopped = findStoppedJobOnDisk(rootDir, created.job.jobId);
  assert.ok(stopped, 'job must land in stopped/');
  assert.equal(stopped.json.status, 'stopped');
  assert.equal(stopped.json.remediationPlan.stop.code, 'operator-merged-pr');
  assert.match(stopped.json.remediationPlan.stop.reason, /merged before remediation could run/);
  assert.match(stopped.json.remediationPlan.stop.reason, /mergedAt=2026-05-02T10:30:00\.000Z/);
  assert.match(stopped.json.remediationPlan.stop.reason, /source=live/);
  assert.equal(stopped.json.remediationWorker.state, 'never-spawned');
});

test('consumeNextFollowUpJob short-circuits to stopped/operator-closed-pr when live lookup reports closed unmerged', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const created = setupPendingJob(rootDir, { prNumber: 110 });

  let spawnFired = false;

  const result = await consumeNextFollowUpJob({
    rootDir,
    promptTemplate: 'unused',
    execFileImpl: async () => ({ stdout: '', stderr: '' }),
    spawnImpl: () => {
      spawnFired = true;
      return { pid: 9999, unref() {} };
    },
    now: () => '2026-05-02T11:00:00.000Z',
    resolvePRLifecycleImpl: async () => ({
      source: 'live',
      prState: 'closed',
      mergedAt: null,
      closedAt: '2026-05-02T10:45:00.000Z',
    }),
  });

  assert.equal(result.consumed, false);
  assert.equal(result.reason, 'pr-closed');
  assert.equal(spawnFired, false, 'must NOT spawn a worker on a closed PR');

  const stopped = findStoppedJobOnDisk(rootDir, created.job.jobId);
  assert.ok(stopped, 'job must land in stopped/');
  assert.equal(stopped.json.remediationPlan.stop.code, 'operator-closed-pr');
  assert.match(stopped.json.remediationPlan.stop.reason, /closed before remediation could run/);
  assert.match(stopped.json.remediationPlan.stop.reason, /closedAt=2026-05-02T10:45:00\.000Z/);
  assert.equal(stopped.json.remediationWorker.state, 'never-spawned');
});

// Helper for the "lifecycle gate did NOT fire" assertions below. The
// downstream path throws (OAuth or workspace prep), which proves the
// gate let the flow through. We capture the thrown error and confirm
// the job landed in failed/, not stopped/.
async function expectLifecycleGateAllowedThrough(promise) {
  let caught;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, 'expected the downstream path to throw (proving the lifecycle gate did not short-circuit)');
  assert.match(
    caught.followUpJobPath || '',
    /\/failed\//,
    'job should land in failed/, NOT stopped/'
  );
  return caught;
}

test('consumeNextFollowUpJob proceeds normally when resolvePRLifecycle returns null (no signal at all)', async () => {
  // Backward-compat: missing live + missing mirror must NOT block consume.
  // The gate is positive opt-in.
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  setupPendingJob(rootDir, { prNumber: 101 });

  await expectLifecycleGateAllowedThrough(consumeNextFollowUpJob({
    rootDir,
    promptTemplate: 'unused',
    execFileImpl: async () => {
      throw new Error('Codex auth file not configured for this test');
    },
    spawnImpl: noopSpawn,
    now: () => '2026-05-02T11:00:00.000Z',
    resolvePRLifecycleImpl: async () => null,
  }));
});

test('consumeNextFollowUpJob proceeds normally when live lookup reports open', async () => {
  // An open PR must NEVER be skipped — that would silently halt the queue.
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  setupPendingJob(rootDir, { prNumber: 102 });

  await expectLifecycleGateAllowedThrough(consumeNextFollowUpJob({
    rootDir,
    promptTemplate: 'unused',
    execFileImpl: async () => {
      throw new Error('Codex auth file not configured for this test');
    },
    spawnImpl: noopSpawn,
    now: () => '2026-05-02T11:00:00.000Z',
    resolvePRLifecycleImpl: async () => ({
      source: 'live',
      prState: 'open',
      mergedAt: null,
      closedAt: null,
    }),
  }));
});

test('consumeNextFollowUpJob proceeds normally when resolvePRLifecycle throws (lookup unavailable)', async () => {
  // Defensive: a resolver throw must not block consume. The gate is
  // best-effort — when we can't tell, we proceed and let downstream
  // logic handle the (rare) merged-but-spawned race.
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  setupPendingJob(rootDir, { prNumber: 103 });

  await expectLifecycleGateAllowedThrough(consumeNextFollowUpJob({
    rootDir,
    promptTemplate: 'unused',
    execFileImpl: async () => {
      throw new Error('Codex auth file not configured for this test');
    },
    spawnImpl: noopSpawn,
    now: () => '2026-05-02T11:00:00.000Z',
    resolvePRLifecycleImpl: async () => {
      throw new Error('lifecycle resolver crashed');
    },
  }));
});

// ── reconcile path ───────────────────────────────────────────────────────────

function spawnedJobFixture(rootDir, prNumber) {
  setupPendingJob(rootDir, { prNumber });
  const claimed = claimNextFollowUpJob({ rootDir, claimedAt: '2026-05-02T11:00:00.000Z' });
  const workspaceDir = path.join(rootDir, 'data', 'follow-up-jobs', 'workspaces', claimed.job.jobId);
  const artifactDir = path.join(workspaceDir, '.adversarial-follow-up');
  mkdirSync(artifactDir, { recursive: true });
  const spawned = markFollowUpJobSpawned({
    jobPath: claimed.jobPath,
    spawnedAt: '2026-05-02T11:01:00.000Z',
    worker: {
      processId: 9876,
      workspaceDir: path.relative(rootDir, workspaceDir),
      outputPath: path.relative(rootDir, path.join(artifactDir, 'codex-last-message.md')),
      logPath: path.relative(rootDir, path.join(artifactDir, 'codex-worker.log')),
      promptPath: path.relative(rootDir, path.join(artifactDir, 'prompt.md')),
    },
  });
  return spawned;
}

test('reconcileFollowUpJob short-circuits to stopped/operator-merged-pr when live lookup reports merged', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const spawned = spawnedJobFixture(rootDir, 200);

  let postCommentFired = false;
  let rereviewFired = false;

  const reconciled = await reconcileFollowUpJob({
    rootDir,
    job: spawned.job,
    jobPath: spawned.jobPath,
    now: () => '2026-05-02T11:05:00.000Z',
    isWorkerRunning: () => false,
    postCommentImpl: () => {
      postCommentFired = true;
      return { posted: true };
    },
    requestReviewRereviewImpl: () => {
      rereviewFired = true;
      return { triggered: false, status: 'blocked', reason: 'pr-not-open' };
    },
    resolvePRLifecycleImpl: async () => ({
      source: 'live',
      prState: 'merged',
      mergedAt: '2026-05-02T11:03:00.000Z',
      closedAt: null,
    }),
  });

  assert.equal(reconciled.action, 'stopped');
  assert.equal(reconciled.reason, 'pr-merged');
  assert.equal(reconciled.job.status, 'stopped');
  assert.equal(reconciled.job.remediationPlan.stop.code, 'operator-merged-pr');
  assert.match(reconciled.job.remediationPlan.stop.reason, /merged while the remediation worker was running/);
  assert.equal(reconciled.job.remediationWorker.state, 'completed-pr-already-merged');

  assert.equal(rereviewFired, false, 'rereview reset must not fire on merged PR');
  assert.equal(postCommentFired, false, 'PR comment must not fire on merged PR');
});

test('reconcileFollowUpJob short-circuits to stopped/operator-closed-pr when live lookup reports closed unmerged', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const spawned = spawnedJobFixture(rootDir, 210);

  let postCommentFired = false;
  let rereviewFired = false;

  const reconciled = await reconcileFollowUpJob({
    rootDir,
    job: spawned.job,
    jobPath: spawned.jobPath,
    now: () => '2026-05-02T11:05:00.000Z',
    isWorkerRunning: () => false,
    postCommentImpl: () => {
      postCommentFired = true;
      return { posted: true };
    },
    requestReviewRereviewImpl: () => {
      rereviewFired = true;
      return { triggered: false, status: 'blocked', reason: 'pr-not-open' };
    },
    resolvePRLifecycleImpl: async () => ({
      source: 'live',
      prState: 'closed',
      mergedAt: null,
      closedAt: '2026-05-02T11:04:00.000Z',
    }),
  });

  assert.equal(reconciled.action, 'stopped');
  assert.equal(reconciled.reason, 'pr-closed');
  assert.equal(reconciled.job.status, 'stopped');
  assert.equal(reconciled.job.remediationPlan.stop.code, 'operator-closed-pr');
  assert.match(reconciled.job.remediationPlan.stop.reason, /closed while the remediation worker was running/);
  assert.equal(reconciled.job.remediationWorker.state, 'completed-pr-already-closed');

  // Same invariants as the merged path: closed PRs already refuse the
  // rereview reset and there's no value in posting a comment on a
  // terminated PR.
  assert.equal(rereviewFired, false, 'rereview reset must not fire on closed PR');
  assert.equal(postCommentFired, false, 'PR comment must not fire on closed PR');
});

test('reconcileFollowUpJob proceeds normally when live lookup reports open', async () => {
  // Open PR + missing artifacts → falls through to the existing
  // artifact-missing-completion failure path. Confirms the gate does
  // not change behavior for the common case.
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const spawned = spawnedJobFixture(rootDir, 201);

  const reconciled = await reconcileFollowUpJob({
    rootDir,
    job: spawned.job,
    jobPath: spawned.jobPath,
    now: () => '2026-05-02T11:05:00.000Z',
    isWorkerRunning: () => false,
    postCommentImpl: () => ({ posted: false, reason: 'no-token-mapping' }),
    requestReviewRereviewImpl: () => ({ triggered: false, status: 'no-rereview-requested' }),
    resolvePRLifecycleImpl: async () => ({ source: 'live', prState: 'open', mergedAt: null, closedAt: null }),
  });

  assert.notEqual(reconciled.reason, 'pr-merged');
  assert.notEqual(reconciled.reason, 'pr-closed');
  assert.equal(reconciled.action, 'failed');
});

test('reconcileInProgressFollowUpJobs surfaces stopped count in aggregate stats', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  spawnedJobFixture(rootDir, 220);

  const summary = await reconcileInProgressFollowUpJobs({
    rootDir,
    now: () => '2026-05-02T11:05:00.000Z',
    isWorkerRunning: () => false,
    postCommentImpl: () => ({ posted: true }),
    requestReviewRereviewImpl: () => ({ triggered: false }),
    resolvePRLifecycleImpl: async () => ({
      source: 'live',
      prState: 'merged',
      mergedAt: '2026-05-02T11:03:00.000Z',
      closedAt: null,
    }),
  });

  assert.equal(summary.scanned, 1);
  assert.equal(summary.stopped, 1, 'stopped counter must be exposed in summary');
  assert.equal(summary.completed, 0);
  assert.equal(summary.failed, 0);
  assert.equal(summary.results[0].action, 'stopped');
  assert.equal(summary.results[0].reason, 'pr-merged');
});

// ── stale-mirror coverage ────────────────────────────────────────────────────

test('consumeNextFollowUpJob trusts live lookup over a stale mirror that still says open', async () => {
  // The core race the patch is supposed to close: watcher mirror still
  // says `open`, but GitHub actually shows `merged`. The gate must
  // trust the live result and stop, not be fooled by the mirror.
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const created = setupPendingJob(rootDir, { prNumber: 130 });

  // Seed a stale `open` mirror row by going through the real schema
  // path; this exercises the same DB the daemon runs against.
  const db = openReviewStateDb(rootDir);
  ensureReviewStateSchema(db);
  db.prepare(
    'INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, pr_state, review_status) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(created.job.repo, 130, '2026-05-02T10:00:00.000Z', 'codex', 'open', 'posted');
  db.close();

  let spawnFired = false;

  // Use the real resolvePRLifecycle so the live-vs-mirror precedence
  // is genuinely exercised (not stubbed away). The injected execFile
  // simulates `gh pr view` returning MERGED while the mirror still
  // says open.
  const result = await consumeNextFollowUpJob({
    rootDir,
    promptTemplate: 'unused',
    execFileImpl: async (command, args) => {
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'view') {
        return {
          stdout: JSON.stringify({
            state: 'MERGED',
            mergedAt: '2026-05-02T10:30:00.000Z',
            closedAt: null,
          }),
          stderr: '',
        };
      }
      throw new Error(`unexpected execFile call: ${command} ${args.join(' ')}`);
    },
    spawnImpl: () => {
      spawnFired = true;
      return { pid: 0, unref() {} };
    },
    now: () => '2026-05-02T11:00:00.000Z',
  });

  assert.equal(result.consumed, false);
  assert.equal(result.reason, 'pr-merged');
  assert.equal(spawnFired, false);
});

test('consumeNextFollowUpJob falls back to mirror when live lookup fails', async () => {
  // GitHub down / `gh` missing / network blip → live lookup fails. We
  // must still trust a `merged` row in the SQLite mirror so the gate
  // doesn't silently disappear when GitHub is flaky.
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const created = setupPendingJob(rootDir, { prNumber: 140 });

  const db = openReviewStateDb(rootDir);
  ensureReviewStateSchema(db);
  db.prepare(
    'INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, pr_state, merged_at, review_status) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(created.job.repo, 140, '2026-05-02T10:00:00.000Z', 'codex', 'merged', '2026-05-02T10:30:00.000Z', 'posted');
  db.close();

  let spawnFired = false;

  const result = await consumeNextFollowUpJob({
    rootDir,
    promptTemplate: 'unused',
    execFileImpl: async (command, args) => {
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'view') {
        // Simulate a `gh` failure (auth, network, etc.).
        const err = new Error('gh: HTTP 503');
        throw err;
      }
      throw new Error(`unexpected execFile call: ${command} ${args.join(' ')}`);
    },
    spawnImpl: () => {
      spawnFired = true;
      return { pid: 0, unref() {} };
    },
    now: () => '2026-05-02T11:00:00.000Z',
  });

  assert.equal(result.consumed, false);
  assert.equal(result.reason, 'pr-merged');
  assert.equal(spawnFired, false);

  const stopped = findStoppedJobOnDisk(rootDir, created.job.jobId);
  assert.ok(stopped);
  assert.match(stopped.json.remediationPlan.stop.reason, /source=mirror/);
});

// ── live lookup unit-level coverage ──────────────────────────────────────────

test('fetchLivePRLifecycle parses MERGED state from gh pr view JSON', async () => {
  const lifecycle = await fetchLivePRLifecycle({
    repo: 'laceyenterprises/clio',
    prNumber: 1,
    execFileImpl: async () => ({
      stdout: JSON.stringify({
        state: 'MERGED',
        mergedAt: '2026-05-02T10:30:00.000Z',
        closedAt: null,
      }),
    }),
  });
  assert.deepEqual(lifecycle, {
    source: 'live',
    prState: 'merged',
    mergedAt: '2026-05-02T10:30:00.000Z',
    closedAt: null,
  });
});

test('fetchLivePRLifecycle parses CLOSED state from gh pr view JSON', async () => {
  const lifecycle = await fetchLivePRLifecycle({
    repo: 'laceyenterprises/clio',
    prNumber: 2,
    execFileImpl: async () => ({
      stdout: JSON.stringify({
        state: 'CLOSED',
        mergedAt: null,
        closedAt: '2026-05-02T10:45:00.000Z',
      }),
    }),
  });
  assert.deepEqual(lifecycle, {
    source: 'live',
    prState: 'closed',
    mergedAt: null,
    closedAt: '2026-05-02T10:45:00.000Z',
  });
});

test('fetchLivePRLifecycle returns null when gh throws', async () => {
  const lifecycle = await fetchLivePRLifecycle({
    repo: 'laceyenterprises/clio',
    prNumber: 3,
    execFileImpl: async () => {
      throw new Error('gh: command not found');
    },
  });
  assert.equal(lifecycle, null);
});

test('fetchLivePRLifecycle returns null on malformed JSON', async () => {
  const lifecycle = await fetchLivePRLifecycle({
    repo: 'laceyenterprises/clio',
    prNumber: 4,
    execFileImpl: async () => ({ stdout: 'not-json' }),
  });
  assert.equal(lifecycle, null);
});

test('fetchLivePRLifecycle returns null on unknown state value', async () => {
  const lifecycle = await fetchLivePRLifecycle({
    repo: 'laceyenterprises/clio',
    prNumber: 5,
    execFileImpl: async () => ({ stdout: JSON.stringify({ state: 'DRAFT' }) }),
  });
  assert.equal(lifecycle, null);
});

test('resolvePRLifecycle persists live observation back to the mirror', async () => {
  // Round-tripping the live result into the mirror is what keeps the
  // watcher's view consistent and lets requestReviewRereview's
  // pr_state guardrail see the correct state.
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));

  const db = openReviewStateDb(rootDir);
  ensureReviewStateSchema(db);
  db.prepare(
    'INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, pr_state, review_status) VALUES (?, ?, ?, ?, ?, ?)'
  ).run('laceyenterprises/clio', 150, '2026-05-02T10:00:00.000Z', 'codex', 'open', 'posted');
  db.close();

  await resolvePRLifecycle(rootDir, {
    repo: 'laceyenterprises/clio',
    prNumber: 150,
    execFileImpl: async () => ({
      stdout: JSON.stringify({
        state: 'MERGED',
        mergedAt: '2026-05-02T10:30:00.000Z',
        closedAt: null,
      }),
    }),
  });

  // Confirm the mirror was rewritten with the live observation.
  const verifyDb = openReviewStateDb(rootDir);
  ensureReviewStateSchema(verifyDb);
  const row = verifyDb
    .prepare('SELECT pr_state, merged_at FROM reviewed_prs WHERE repo = ? AND pr_number = ?')
    .get('laceyenterprises/clio', 150);
  verifyDb.close();
  assert.equal(row.pr_state, 'merged');
  assert.equal(row.merged_at, '2026-05-02T10:30:00.000Z');
});
