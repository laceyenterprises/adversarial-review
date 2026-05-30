import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

import { ensureReviewStateSchema, openReviewStateDb } from '../src/review-state.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SCRIPT = join(REPO_ROOT, 'src', 'diagnose-stuck-rereview.mjs');
const execFileAsync = promisify(execFile);

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'diagnose-stuck-rereview-'));
  mkdirSync(join(root, 'data'), { recursive: true });
  mkdirSync(join(root, 'data', 'follow-up-jobs', 'completed'), { recursive: true });
  mkdirSync(join(root, 'data', 'follow-up-jobs', 'pending'), { recursive: true });
  return root;
}

function seedReviewedPRsRow(root, fields) {
  const db = openReviewStateDb(root);
  try {
    ensureReviewStateSchema(db);
    const merged = {
      repo: 'laceyenterprises/agent-os',
      pr_number: 1000,
      reviewed_at: '2026-05-29T20:00:00.000Z',
      reviewer: 'claude',
      pr_state: 'open',
      review_status: 'pending',
      review_attempts: 1,
      last_attempted_at: null,
      posted_at: null,
      rereview_requested_at: null,
      rereview_reason: null,
      reviewer_head_sha: null,
      ...fields,
    };
    db.prepare(
      `INSERT INTO reviewed_prs
        (repo, pr_number, reviewed_at, reviewer, pr_state, review_status, review_attempts,
         last_attempted_at, posted_at, rereview_requested_at, rereview_reason, reviewer_head_sha)
       VALUES
        (@repo, @pr_number, @reviewed_at, @reviewer, @pr_state, @review_status, @review_attempts,
         @last_attempted_at, @posted_at, @rereview_requested_at, @rereview_reason, @reviewer_head_sha)`
    ).run(merged);
  } finally {
    db.close();
  }
  return fields;
}

function seedCompletedJob(root, { repo = 'laceyenterprises/agent-os', prNumber = 1000, completedAt = '2026-05-30T00:41:06.559Z', revisionRef = 'sha-old-1234', reReviewRequested = true } = {}) {
  const filename = `${repo.replace('/', '__')}-pr-${prNumber}-2026-05-29T23-24-31-830Z.json`;
  writeFileSync(
    join(root, 'data', 'follow-up-jobs', 'completed', filename),
    JSON.stringify({
      repo,
      prNumber,
      status: 'completed',
      completedAt,
      revisionRef,
      reReview: { requested: reReviewRequested, requestedAt: completedAt, reason: 'fixture' },
    }, null, 2),
    'utf8'
  );
}

async function runDiagnose(root, ...extraArgs) {
  try {
    const { stdout, stderr } = await execFileAsync('node', [SCRIPT, '--root-dir', root, '--json', ...extraArgs]);
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

test('not stuck when no rereview_requested_at is set', async () => {
  const root = makeRoot();
  seedReviewedPRsRow(root, { rereview_requested_at: null });
  const result = await runDiagnose(root);
  assert.equal(result.code, 0, `expected exit 0; got ${result.code}\nstderr:\n${result.stderr}`);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.stuckCount, 0);
  assert.equal(payload.totalCandidates, 0); // SQL filter excludes null rereview_requested_at
});

test('not stuck when last_attempted_at >= rereview_requested_at (spawn already happened)', async () => {
  const root = makeRoot();
  seedReviewedPRsRow(root, {
    rereview_requested_at: '2026-05-29T22:00:00.000Z',
    last_attempted_at: '2026-05-29T22:01:00.000Z',
  });
  const result = await runDiagnose(root);
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.stuckCount, 0);
  assert.equal(payload.totalCandidates, 1);
  assert.match(payload.rows[0].classification.reason, /spawn already happened/);
});

test('not stuck when rereview is younger than threshold', async () => {
  const root = makeRoot();
  const recent = new Date(Date.now() - 60_000).toISOString(); // 1 min ago
  seedReviewedPRsRow(root, { rereview_requested_at: recent, last_attempted_at: '2026-05-29T22:00:00.000Z' });
  const result = await runDiagnose(root, '--threshold-minutes', '5');
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.stuckCount, 0);
});

test('stuck when rereview_requested_at is older than threshold and no spawn happened', async () => {
  const root = makeRoot();
  const old = '2026-05-29T22:00:00.000Z';
  seedReviewedPRsRow(root, {
    rereview_requested_at: old,
    last_attempted_at: '2026-05-29T21:00:00.000Z', // older than rereview = no spawn since
  });
  seedCompletedJob(root, { completedAt: old, reReviewRequested: true });
  const result = await runDiagnose(root, '--threshold-minutes', '5');
  assert.equal(result.code, 4, `expected exit 4 (stuck found); got ${result.code}`);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.stuckCount, 1);
  assert.ok(payload.rows[0].classification.suggestedAction.includes('npm run retrigger-review'));
});

test('hint surfaced when latest job is not completed', async () => {
  const root = makeRoot();
  const old = '2026-05-29T22:00:00.000Z';
  seedReviewedPRsRow(root, {
    rereview_requested_at: old,
    last_attempted_at: '2026-05-29T21:00:00.000Z',
  });
  // Put a job in pending (instead of completed) so the hint fires
  writeFileSync(
    join(root, 'data', 'follow-up-jobs', 'pending', 'laceyenterprises__agent-os-pr-1000-foo.json'),
    JSON.stringify({ repo: 'laceyenterprises/agent-os', prNumber: 1000, status: 'pending', createdAt: old }),
    'utf8'
  );
  const result = await runDiagnose(root, '--threshold-minutes', '5');
  assert.equal(result.code, 4);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.stuckCount, 1);
  assert.ok(payload.rows[0].classification.hints.some((h) => h.includes('latest job status=pending')));
});

test('1067-shaped fixture (the actual outage state) is classified stuck', async () => {
  // Reproduce the precise state observed on PR #1067 at 2026-05-30 02:00Z:
  //   review_status = 'pending'
  //   review_attempts = 1
  //   last_attempted_at = '23:21Z' (first-pass start)
  //   posted_at = NULL (cleared by requestReviewRereview)
  //   rereview_requested_at = '00:41Z' (after remediation)
  //   completed job with reReview.requested=true exists
  //   job revisionRef = old head SHA (worker pushed new commit)
  const root = makeRoot();
  seedReviewedPRsRow(root, {
    pr_number: 1067,
    review_status: 'pending',
    review_attempts: 1,
    last_attempted_at: '2026-05-29T23:21:27.559Z',
    posted_at: null,
    rereview_requested_at: '2026-05-30T00:41:06.559Z',
    reviewer_head_sha: '059a86483ea67fe4c42f96e0690d5d247755113a',
  });
  seedCompletedJob(root, {
    prNumber: 1067,
    completedAt: '2026-05-30T00:41:06.559Z',
    revisionRef: '059a86483ea67fe4c42f96e0690d5d247755113a',
    reReviewRequested: true,
  });
  const result = await runDiagnose(root, '--threshold-minutes', '5');
  assert.equal(result.code, 4);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.stuckCount, 1);
  const stuck = payload.rows[0];
  assert.equal(stuck.row.pr_number, 1067);
  assert.ok(stuck.classification.ageMinutes >= 5);
});
