import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { ensureReviewStateSchema, openReviewStateDb } from '../src/review-state.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SCRIPT = join(REPO_ROOT, 'src', 'diagnose-stuck-rereview.mjs');
const execFileAsync = promisify(execFile);

function makeRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'diagnose-stuck-rereview-'));
  mkdirSync(join(root, 'data'), { recursive: true });
  mkdirSync(join(root, 'data', 'follow-up-jobs', 'completed'), { recursive: true });
  mkdirSync(join(root, 'data', 'follow-up-jobs', 'pending'), { recursive: true });
  if (t && typeof t.after === 'function') {
    t.after(() => rmSync(root, { recursive: true, force: true }));
  }
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

test('not stuck when no rereview_requested_at is set', async (t) => {
  const root = makeRoot(t);
  seedReviewedPRsRow(root, { rereview_requested_at: null });
  const result = await runDiagnose(root);
  assert.equal(result.code, 0, `expected exit 0; got ${result.code}\nstderr:\n${result.stderr}`);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.stuckCount, 0);
  assert.equal(payload.totalCandidates, 0); // SQL filter excludes null rereview_requested_at
});

test('not stuck when last_attempted_at >= rereview_requested_at (spawn already happened)', async (t) => {
  const root = makeRoot(t);
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

test('not stuck when rereview is younger than threshold', async (t) => {
  const root = makeRoot(t);
  const recent = new Date(Date.now() - 60_000).toISOString(); // 1 min ago
  seedReviewedPRsRow(root, { rereview_requested_at: recent, last_attempted_at: '2026-05-29T22:00:00.000Z' });
  const result = await runDiagnose(root, '--threshold-minutes', '5');
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.stuckCount, 0);
});

test('stuck when rereview_requested_at is older than threshold and no spawn happened', async (t) => {
  const root = makeRoot(t);
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

test('hint surfaced when latest job is not completed', async (t) => {
  const root = makeRoot(t);
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

test('1067-shaped fixture (the actual outage state) is classified stuck', async (t) => {
  // Reproduce the precise state observed on PR #1067 at 2026-05-30 02:00Z:
  //   review_status = 'pending'
  //   review_attempts = 1
  //   last_attempted_at = '23:21Z' (first-pass start)
  //   posted_at = NULL (cleared by requestReviewRereview)
  //   rereview_requested_at = '00:41Z' (after remediation)
  //   completed job with reReview.requested=true exists
  //   job revisionRef = old head SHA (worker pushed new commit)
  const root = makeRoot(t);
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

test('exits 2 when --pr is passed without --repo', async (t) => {
  const root = makeRoot(t);
  seedReviewedPRsRow(root, { rereview_requested_at: '2026-05-29T22:00:00.000Z' });
  const result = await runDiagnose(root, '--pr', '1067');
  assert.equal(result.code, 2);
  assert.match(result.stderr, /must be passed together/);
});

test('exits 2 when --pr is not a positive integer', async (t) => {
  const root = makeRoot(t);
  seedReviewedPRsRow(root, { rereview_requested_at: '2026-05-29T22:00:00.000Z' });
  const result = await runDiagnose(root, '--repo', 'laceyenterprises/agent-os', '--pr', 'abc');
  assert.equal(result.code, 2);
  assert.match(result.stderr, /positive integer/);
});

test('exits 2 when --threshold-minutes is negative', async (t) => {
  const root = makeRoot(t);
  seedReviewedPRsRow(root, { rereview_requested_at: '2026-05-29T22:00:00.000Z' });
  // Use '=' form so node:util parseArgs does not misread the leading '-'
  // as the start of another option.
  const result = await runDiagnose(root, '--threshold-minutes=-1');
  assert.equal(result.code, 2);
  assert.match(result.stderr, /non-negative finite number/);
});

test('--threshold-minutes 0 flags every pending rereview row (does not coerce to default)', async (t) => {
  const root = makeRoot(t);
  // rereview_requested_at is "now" so a default-of-5 threshold would treat
  // this as not-stuck; only an honored 0 threshold flags it.
  const now = new Date().toISOString();
  seedReviewedPRsRow(root, {
    rereview_requested_at: now,
    last_attempted_at: '2026-05-29T21:00:00.000Z',
  });
  const result = await runDiagnose(root, '--threshold-minutes', '0');
  assert.equal(result.code, 4, `expected exit 4 (stuck found); got ${result.code}\nstderr:\n${result.stderr}`);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.thresholdMinutes, 0);
  assert.equal(payload.stuckCount, 1);
});

test('exits 3 when reviews.db is missing', async (t) => {
  // Use a root with no DB seeded; the CLI must refuse to bootstrap one.
  const root = mkdtempSync(join(tmpdir(), 'diagnose-stuck-rereview-nodb-'));
  mkdirSync(join(root, 'data'), { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = await runDiagnose(root);
  assert.equal(result.code, 3);
  assert.match(result.stderr, /reviews\.db not found/);
});

test('readonly: diagnostic does not create reviews.db-wal or reviews.db-shm sidecars', async (t) => {
  const root = makeRoot(t);
  // Seed a fresh-pending row (no rereview_requested_at) so the SQL scan
  // returns zero candidates and the test focuses on the open-mode invariant
  // rather than the classification logic exercised elsewhere.
  seedReviewedPRsRow(root, { rereview_requested_at: null });
  // Pre-clean any WAL/SHM left by the seed open (better-sqlite3 closes them
  // when the writeable handle is closed in journal-mode=delete, but be
  // defensive in case the local sqlite is WAL-by-default).
  for (const sidecar of ['reviews.db-wal', 'reviews.db-shm']) {
    rmSync(join(root, 'data', sidecar), { force: true });
  }
  const result = await runDiagnose(root);
  assert.equal(result.code, 0, `expected exit 0; got ${result.code}\nstderr:\n${result.stderr}`);
  const { existsSync } = await import('node:fs');
  assert.equal(existsSync(join(root, 'data', 'reviews.db-wal')), false,
    'diagnostic must not create reviews.db-wal (would re-introduce the cross-user WAL footgun)');
  assert.equal(existsSync(join(root, 'data', 'reviews.db-shm')), false,
    'diagnostic must not create reviews.db-shm (would re-introduce the cross-user SHM footgun)');
});

test('parse-failed files are not surfaced for unrelated PRs', async (t) => {
  const root = makeRoot(t);
  seedReviewedPRsRow(root, {
    rereview_requested_at: '2026-05-29T22:00:00.000Z',
    last_attempted_at: '2026-05-29T21:00:00.000Z',
  });
  // Garbage file for an unrelated PR — its prefix should not match the
  // diagnostic's PR-1000 lookup, so it must not appear as a parse-failed hit.
  writeFileSync(
    join(root, 'data', 'follow-up-jobs', 'completed', 'laceyenterprises__agent-os-pr-9999-other.json'),
    'this is not valid json {{{',
    'utf8'
  );
  const result = await runDiagnose(root, '--threshold-minutes', '5');
  // The stuck row exists; we're checking that the unrelated parse-failed
  // does not bubble into its jobInfo report.
  assert.equal(result.code, 4);
  const payload = JSON.parse(result.stdout);
  const buckets = payload.rows[0].jobInfo.byBucket || {};
  for (const entries of Object.values(buckets)) {
    for (const entry of entries) {
      assert.notEqual(entry.error, 'parse-failed',
        'unrelated PR-9999 parse failure should not appear in PR-1000 diagnostic');
    }
  }
});
