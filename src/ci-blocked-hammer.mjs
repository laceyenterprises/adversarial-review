// ── CI-blocked with no remediation job left → hammer owner ───────────────────
//
// CIBLOCKHAM-01 (SEV1). agent-os PR 8007: remediation round 2 of 2 pushed a
// head, repo-guards failed on it, and every later poll logged
// `ci-regression-no-job` and held the re-review. Remediation rounds were spent,
// the re-review was parked, and the hammer was never dispatched, so nobody
// owned the red head. Operator decision, 2026-10-10: "Hammers judgement is
// final".
//
// When the CI admission guard reports failed external CI with no remediation
// job left (`hammerOwner: true`: no follow-up job, or the rounds are spent),
// the re-review stays parked and the PR goes to the hammer through the
// hammer-owner route it shares with CYCLECAPHAM-01. Reviewer admission still
// requires green external CI; the hammer's dispatch does not. The closer's
// per-head retry cap bounds attempts, and only a final no-merge decision or an
// exhausted retry cap pages the operator.
import { recentReviewCycleVerdicts } from './review-cycle-cap.mjs';
import { routeToHammerOwner } from './hammer-owner-route.mjs';

// The head the latest posted adversarial review actually read. The parked row's
// reviewer_head_sha is the unreviewed red head, and a CI-regression requeue
// rewrites the follow-up job's revisionRef to that head too, so neither is used.
export function latestReviewedHeadSha({ db, repoPath, prNumber } = {}) {
  try {
    const pass = db?.prepare(
      `SELECT head_sha
         FROM reviewer_passes
        WHERE repo = ?
          AND pr_number = ?
          AND pass_kind IN ('first-pass', 'rereview')
          AND head_sha IS NOT NULL AND TRIM(head_sha) <> ''
          AND gh_comment_id IS NOT NULL AND TRIM(CAST(gh_comment_id AS TEXT)) <> ''
        ORDER BY COALESCE(body_captured_at, ended_at, started_at) DESC, pass_id DESC
        LIMIT 1`
    ).get(repoPath, prNumber);
    if (pass?.head_sha) return String(pass.head_sha);
  } catch {
    // Older review DBs lack the capture columns; fall through.
  }
  try {
    return recentReviewCycleVerdicts(db, { repo: repoPath, prNumber, limit: 1 }).at(-1)?.head_sha || null;
  } catch {
    return null;
  }
}

export async function maybeRouteCiBlockedToHammer({
  ciAdmission,
  rootDir,
  db,
  repoPath,
  prNumber,
  ...routeOptions
} = {}) {
  if (ciAdmission?.hammerOwner !== true) {
    return { handled: false, reason: 'not-ci-blocked-hammer-owner' };
  }
  return routeToHammerOwner({
    ...routeOptions,
    route: 'ci-blocked',
    rootDir,
    db,
    repoPath,
    prNumber,
    reviewedHeadSha: latestReviewedHeadSha({ db, repoPath, prNumber }),
    dispatchJobFields: {
      ciFailedChecks: Array.isArray(ciAdmission.ciGate?.failedChecks) ? ciAdmission.ciGate.failedChecks : [],
      ciBlockedReason: ciAdmission.reason,
    },
  });
}
