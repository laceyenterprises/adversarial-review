// FSR-06B: the watcher honours a fleet-self-repair trailer-only re-review
// request only after re-deriving the premise from its own git store, and
// declines (never parks) a request it will not spawn.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  FLEET_SELF_REPAIR_REREVIEW_DECLINED_MARKER,
  FLEET_SELF_REPAIR_TRAILER_ONLY_REREVIEW_MARKER,
  buildFleetSelfRepairRereviewDeclinedReason,
  declineFleetSelfRepairTrailerOnlyRereview,
  isFleetSelfRepairRereviewDeclinedReason,
  isFleetSelfRepairTrailerOnlyRereview,
  isFleetSelfRepairTrailerOnlyRereviewReason,
  parseFleetSelfRepairTrailerOnlyRereviewReason,
  resolveFleetSelfRepairTrailerOnlyRereview,
  verifyTrailerOnlyHeadDelta,
} from '../src/fleet-self-repair-rereview.mjs';
import { isExplicitOperatorReviewRetrigger } from '../src/first-pass-review-suppression.mjs';
import { ensureReviewStateSchema, openReviewStateDb } from '../src/review-state.mjs';

const REPO = 'laceyenterprises/agent-os';
const PR = 6059;
const quietLogger = { log() {}, warn() {}, debug() {}, error() {} };

// The exact shape modules/fleet-self-repair writes (pinned on the agent-os side
// by test_review_head_trailer_only.py): marker sentence + both full SHAs.
function fsrReason(reviewed, live) {
  return `FSR-06B: trailer-only head move detected; request fresh adversarial review. reviewed=${reviewed} live=${live}`;
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// A daemon-clone-shaped repo under `<hqRoot>/repos/<name>` with a reviewed
// head and a trailer-only (or substantive) commit on top of it.
function makeDaemonClone({ substantiveMove = false } = {}) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'fsr-06b-clone-'));
  const hqRoot = path.join(tmp, 'hq');
  const clone = path.join(hqRoot, 'repos', 'agent-os');
  mkdirSync(clone, { recursive: true });
  git(clone, 'init', '-q');
  git(clone, 'config', 'user.email', 'fixture@example.invalid');
  git(clone, 'config', 'user.name', 'Fixture');
  git(clone, 'commit', '-q', '--allow-empty', '-m', 'Base');
  execFileSync('bash', ['-c', "printf 'reviewed\\n' > code.py"], { cwd: clone });
  git(clone, 'add', 'code.py');
  git(clone, 'commit', '-q', '-m', 'Implement ticket');
  const reviewed = git(clone, 'rev-parse', 'HEAD');
  if (substantiveMove) {
    execFileSync('bash', ['-c', "printf 'changed\\n' > code.py"], { cwd: clone });
    git(clone, 'add', 'code.py');
    git(clone, 'commit', '-q', '-m', 'Add provenance trailer\n\nReviewed-by: codex');
  } else {
    git(clone, 'commit', '-q', '--allow-empty', '-m', 'Add provenance trailer\n\nReviewed-by: codex');
  }
  const live = git(clone, 'rev-parse', 'HEAD');
  return { tmp, hqRoot, clone, reviewed, live };
}

function insertPendingFsrRow(db, { reviewed, live, reason = fsrReason(reviewed, live) }) {
  db.prepare(
    `INSERT INTO reviewed_prs (
       repo, pr_number, reviewed_at, reviewer, pr_state, review_status, review_attempts,
       revision_ref, reviewer_head_sha, posted_at, rereview_requested_at, rereview_reason
     ) VALUES (?, ?, ?, ?, 'open', 'pending', 2, ?, NULL, NULL, ?, ?)`
  ).run(REPO, PR, '2026-09-02T12:00:00Z', 'codex', live, '2026-09-03T12:00:00Z', reason);
}

test('FSR-06B marker is recognised only on an armed row and is not the operator marker', () => {
  const reviewed = 'a'.repeat(40);
  const live = 'b'.repeat(40);
  assert.equal(FLEET_SELF_REPAIR_TRAILER_ONLY_REREVIEW_MARKER, 'FSR-06B');
  assert.equal(isFleetSelfRepairTrailerOnlyRereviewReason(fsrReason(reviewed, live)), true);
  assert.equal(isFleetSelfRepairTrailerOnlyRereviewReason('  fsr-06b: lower-case marker'), true);
  assert.equal(isFleetSelfRepairTrailerOnlyRereviewReason('retrigger-review: operator'), false);
  assert.equal(isFleetSelfRepairTrailerOnlyRereviewReason('FSR-06B declined: x'), false);
  assert.equal(isFleetSelfRepairTrailerOnlyRereviewReason(null), false);

  const armed = { rereview_requested_at: '2026-09-03T12:00:00Z', rereview_reason: fsrReason(reviewed, live) };
  assert.equal(isFleetSelfRepairTrailerOnlyRereview(armed), true);
  assert.equal(isFleetSelfRepairTrailerOnlyRereview({ ...armed, rereview_requested_at: null }), false);
  // Automation never inherits the operator bypass.
  assert.equal(isExplicitOperatorReviewRetrigger(armed), false);

  assert.deepEqual(parseFleetSelfRepairTrailerOnlyRereviewReason(fsrReason(reviewed, live)), {
    marker: true,
    reviewedHeadSha: reviewed,
    liveHeadSha: live,
  });
  assert.deepEqual(parseFleetSelfRepairTrailerOnlyRereviewReason('FSR-06B: no heads'), {
    marker: true,
    reviewedHeadSha: null,
    liveHeadSha: null,
  });
  assert.deepEqual(parseFleetSelfRepairTrailerOnlyRereviewReason('retrigger-review: x'), {
    marker: false,
    reviewedHeadSha: null,
    liveHeadSha: null,
  });
});

test('declined reason carries the marker, the cause, and both heads', () => {
  const reason = buildFleetSelfRepairRereviewDeclinedReason({
    reason: 'terminal-closer-head:closer-commit-trailer',
    reviewedHeadSha: 'a'.repeat(40),
    liveHeadSha: 'b'.repeat(40),
  });
  assert.equal(
    reason,
    `${FLEET_SELF_REPAIR_REREVIEW_DECLINED_MARKER}: terminal-closer-head:closer-commit-trailer; reviewed=${'a'.repeat(40)} live=${'b'.repeat(40)}`
  );
  assert.equal(isFleetSelfRepairRereviewDeclinedReason(reason), true);
  assert.equal(isFleetSelfRepairTrailerOnlyRereviewReason(reason), false);
});

test('verifyTrailerOnlyHeadDelta verifies an empty delta from the daemon clone', async () => {
  const fixture = makeDaemonClone();
  try {
    const result = await verifyTrailerOnlyHeadDelta({
      repoPath: REPO,
      prNumber: PR,
      reviewedHeadSha: fixture.reviewed,
      currentHeadSha: fixture.live,
      hqRoot: fixture.hqRoot,
      logger: quietLogger,
    });
    assert.equal(result.verified, true, JSON.stringify(result));
    assert.equal(result.reason, 'empty-delta');
    assert.equal(result.commitCount, 1);
  } finally {
    rmSync(fixture.tmp, { recursive: true, force: true });
  }
});

test('verifyTrailerOnlyHeadDelta refuses a substantive move, a non-ancestor, and a same head', async () => {
  const fixture = makeDaemonClone({ substantiveMove: true });
  try {
    const substantive = await verifyTrailerOnlyHeadDelta({
      repoPath: REPO,
      prNumber: PR,
      reviewedHeadSha: fixture.reviewed,
      currentHeadSha: fixture.live,
      hqRoot: fixture.hqRoot,
      logger: quietLogger,
    });
    assert.equal(substantive.verified, false);
    assert.equal(substantive.reason, 'non-empty-delta');

    // Reverse the heads: the "reviewed" head is not an ancestor of "live".
    const notAncestor = await verifyTrailerOnlyHeadDelta({
      repoPath: REPO,
      prNumber: PR,
      reviewedHeadSha: fixture.live,
      currentHeadSha: fixture.reviewed,
      hqRoot: fixture.hqRoot,
      logger: quietLogger,
    });
    assert.equal(notAncestor.verified, false);
    assert.equal(notAncestor.reason, 'reviewed-head-not-ancestor');

    const same = await verifyTrailerOnlyHeadDelta({
      repoPath: REPO,
      prNumber: PR,
      reviewedHeadSha: fixture.live,
      currentHeadSha: fixture.live,
      hqRoot: fixture.hqRoot,
      logger: quietLogger,
    });
    assert.equal(same.verified, false);
    assert.equal(same.reason, 'reviewed-head-is-current-head');
  } finally {
    rmSync(fixture.tmp, { recursive: true, force: true });
  }
});

test('verifyTrailerOnlyHeadDelta fails CLOSED on a git error, a missing checkout, or a missing object', async () => {
  const fixture = makeDaemonClone();
  try {
    const noCheckout = await verifyTrailerOnlyHeadDelta({
      repoPath: REPO,
      prNumber: PR,
      reviewedHeadSha: fixture.reviewed,
      currentHeadSha: fixture.live,
      hqRoot: path.join(fixture.tmp, 'no-such-hq'),
      logger: quietLogger,
    });
    assert.equal(noCheckout.verified, false);
    assert.equal(noCheckout.reason, 'no-local-checkout');

    // The postmortem rule: a failed diff read is NOT an empty diff.
    let calls = 0;
    const brokenDiff = await verifyTrailerOnlyHeadDelta({
      repoPath: REPO,
      prNumber: PR,
      reviewedHeadSha: fixture.reviewed,
      currentHeadSha: fixture.live,
      hqRoot: fixture.hqRoot,
      logger: quietLogger,
      execFileImpl: async (file, args, options) => {
        calls += 1;
        if (args.includes('diff')) {
          const err = new Error('fatal: unable to read tree');
          err.code = 128;
          err.stderr = 'fatal: unable to read tree';
          throw err;
        }
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        return promisify(execFile)(file, args, options);
      },
    });
    assert.equal(brokenDiff.verified, false);
    assert.equal(brokenDiff.reason, 'git-error');
    assert.ok(calls > 0);

    const missingObject = await verifyTrailerOnlyHeadDelta({
      repoPath: REPO,
      prNumber: PR,
      reviewedHeadSha: fixture.reviewed,
      currentHeadSha: 'c'.repeat(40),
      hqRoot: fixture.hqRoot,
      logger: quietLogger,
      fetchVerifiedCommitFromLocalGitImpl: async ({ headSha }) => (headSha === fixture.reviewed ? { sha: headSha } : null),
    });
    assert.equal(missingObject.verified, false);
    assert.equal(missingObject.reason, 'commit-unavailable-locally');

    const unresolved = await verifyTrailerOnlyHeadDelta({
      repoPath: REPO,
      prNumber: PR,
      reviewedHeadSha: 'not-a-sha',
      currentHeadSha: fixture.live,
      hqRoot: fixture.hqRoot,
      logger: quietLogger,
    });
    assert.equal(unresolved.verified, false);
    assert.equal(unresolved.reason, 'heads-unresolved');
  } finally {
    rmSync(fixture.tmp, { recursive: true, force: true });
  }
});

test('resolveFleetSelfRepairTrailerOnlyRereview honours only a verified, current-head request', async () => {
  const fixture = makeDaemonClone();
  try {
    const row = {
      rereview_requested_at: '2026-09-03T12:00:00Z',
      rereview_reason: fsrReason(fixture.reviewed, fixture.live),
      revision_ref: fixture.live,
    };
    const honored = await resolveFleetSelfRepairTrailerOnlyRereview({
      reviewRow: row,
      repoPath: REPO,
      prNumber: PR,
      currentHeadSha: fixture.live,
      hqRoot: fixture.hqRoot,
      logger: quietLogger,
    });
    assert.equal(honored.requested, true);
    assert.equal(honored.honored, true);
    assert.equal(honored.stale, false);
    assert.equal(honored.reason, 'verified-empty-delta');
    assert.equal(honored.reviewedHeadSha, fixture.reviewed);

    // The head moved again after the request: stale, ordinary policy applies.
    const stale = await resolveFleetSelfRepairTrailerOnlyRereview({
      reviewRow: row,
      repoPath: REPO,
      prNumber: PR,
      currentHeadSha: 'd'.repeat(40),
      hqRoot: fixture.hqRoot,
      logger: quietLogger,
    });
    assert.equal(stale.requested, true);
    assert.equal(stale.honored, false);
    assert.equal(stale.stale, true);
    assert.equal(stale.reason, 'request-head-moved');

    // A request without heads cannot be verified and gets no bypass.
    const headless = await resolveFleetSelfRepairTrailerOnlyRereview({
      reviewRow: { ...row, rereview_reason: 'FSR-06B: trailer-only head move detected', revision_ref: null },
      repoPath: REPO,
      prNumber: PR,
      currentHeadSha: fixture.live,
      hqRoot: fixture.hqRoot,
      logger: quietLogger,
    });
    assert.equal(headless.requested, true);
    assert.equal(headless.honored, false);
    assert.equal(headless.reason, 'reviewed-head-missing-from-request');

    // Not an FSR row at all.
    const operator = await resolveFleetSelfRepairTrailerOnlyRereview({
      reviewRow: { ...row, rereview_reason: 'retrigger-review: operator requested re-review' },
      repoPath: REPO,
      prNumber: PR,
      currentHeadSha: fixture.live,
      hqRoot: fixture.hqRoot,
      logger: quietLogger,
    });
    assert.deepEqual(operator, { requested: false, honored: false, stale: false, reason: null });
  } finally {
    rmSync(fixture.tmp, { recursive: true, force: true });
  }
});

test('resolveFleetSelfRepairTrailerOnlyRereview withholds the bypass when the delta is not empty', async () => {
  const fixture = makeDaemonClone({ substantiveMove: true });
  try {
    const result = await resolveFleetSelfRepairTrailerOnlyRereview({
      reviewRow: {
        rereview_requested_at: '2026-09-03T12:00:00Z',
        rereview_reason: fsrReason(fixture.reviewed, fixture.live),
        revision_ref: fixture.live,
      },
      repoPath: REPO,
      prNumber: PR,
      currentHeadSha: fixture.live,
      hqRoot: fixture.hqRoot,
      logger: quietLogger,
    });
    assert.equal(result.requested, true);
    assert.equal(result.honored, false);
    assert.equal(result.stale, false);
    assert.equal(result.reason, 'unverified:non-empty-delta');
  } finally {
    rmSync(fixture.tmp, { recursive: true, force: true });
  }
});

test('declineFleetSelfRepairTrailerOnlyRereview restores posted with the declined reason, CAS-guarded', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'fsr-06b-decline-'));
  const db = openReviewStateDb(rootDir);
  try {
    ensureReviewStateSchema(db);
    const reviewed = 'a'.repeat(40);
    const live = 'b'.repeat(40);
    insertPendingFsrRow(db, { reviewed, live });

    const declined = declineFleetSelfRepairTrailerOnlyRereview({
      db,
      repoPath: REPO,
      prNumber: PR,
      reason: 'remediation-round-budget-exhausted',
      reviewedHeadSha: reviewed,
      liveHeadSha: live,
      now: '2026-09-04T00:00:00.000Z',
      logger: quietLogger,
    });
    assert.equal(declined.declined, true);
    const row = db.prepare(
      `SELECT review_status, posted_at, reviewer_head_sha, revision_ref, rereview_requested_at, rereview_reason
         FROM reviewed_prs WHERE repo = ? AND pr_number = ?`
    ).get(REPO, PR);
    assert.equal(row.review_status, 'posted');
    assert.equal(row.posted_at, '2026-09-04T00:00:00.000Z');
    assert.equal(row.reviewer_head_sha, reviewed);
    assert.equal(row.revision_ref, live);
    assert.equal(row.rereview_requested_at, null);
    assert.equal(
      row.rereview_reason,
      `FSR-06B declined: remediation-round-budget-exhausted; reviewed=${reviewed} live=${live}`
    );
    // The declined row is neither an armed FSR request nor an operator retrigger.
    assert.equal(isFleetSelfRepairTrailerOnlyRereview(row), false);
    assert.equal(isExplicitOperatorReviewRetrigger(row), false);

    // Second decline: the row is no longer the armed request → CAS miss.
    const again = declineFleetSelfRepairTrailerOnlyRereview({
      db,
      repoPath: REPO,
      prNumber: PR,
      reason: 'again',
      logger: quietLogger,
    });
    assert.equal(again.declined, false);
    assert.equal(again.changes, 0);

    // An operator-armed pending row is never touched.
    db.prepare(
      `UPDATE reviewed_prs SET review_status = 'pending', rereview_requested_at = ?, rereview_reason = ?
        WHERE repo = ? AND pr_number = ?`
    ).run('2026-09-04T01:00:00Z', 'retrigger-review: operator requested', REPO, PR);
    const operatorRow = declineFleetSelfRepairTrailerOnlyRereview({
      db,
      repoPath: REPO,
      prNumber: PR,
      reason: 'should-not-apply',
      logger: quietLogger,
    });
    assert.equal(operatorRow.declined, false);
    assert.equal(
      db.prepare('SELECT review_status, rereview_reason FROM reviewed_prs WHERE repo = ? AND pr_number = ?').get(REPO, PR).review_status,
      'pending'
    );
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
