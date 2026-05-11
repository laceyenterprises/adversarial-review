import { execFileSync } from 'node:child_process';

const LEGACY_ORPHAN_FAILURE_MESSAGE =
  'Watcher restarted while review subprocess was in flight. ' +
  'A review may have been posted on GitHub by the orphaned child. ' +
  'Verify the PR before retriggering with `npm run retrigger-review`.';

const NULL_PGID_FAILURE_MESSAGE =
  'Reviewer session was claimed but its pgid was never persisted. ' +
  'The watcher likely died between the claim and spawn callback; operator must verify GitHub before clearing.';
const UNKNOWN_REVIEWER_FAILURE_MESSAGE =
  'Reviewer session has an unknown reviewer value; operator must verify GitHub before retrying.';
const CORRUPT_SESSION_FAILURE_MESSAGE =
  'Reviewer session metadata is corrupt or incomplete; operator must verify GitHub before retrying.';
const PROBE_FAILURE_MESSAGE =
  'Reviewer session reattach probe failed; operator must verify GitHub before retrying.';
const PGID_IDENTITY_FAILURE_MESSAGE =
  'Reviewer process group is alive but does not match the recorded reviewer session; treating as sticky until operator verifies GitHub.';

const REVIEWER_BOT_LOGINS = new Map([
  ['claude', 'claude-reviewer-lacey'],
  ['codex', 'codex-reviewer-lacey'],
]);

function splitRepoPath(repoPath) {
  const [owner, repo] = String(repoPath || '').split('/');
  return { owner, repo };
}

function reviewerBotLogin(reviewer) {
  const value = String(reviewer || '').trim();
  const lower = value.toLowerCase();
  return REVIEWER_BOT_LOGINS.get(lower) || null;
}

function parseTime(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function probePgidAlive(pgid) {
  const numericPgid = Number(pgid);
  if (!Number.isInteger(numericPgid) || numericPgid <= 0) return false;
  try {
    process.kill(-numericPgid, 0);
    return true;
  } catch (err) {
    if (err?.code === 'ESRCH') return false;
    if (err?.code === 'EPERM') return true;
    return false;
  }
}

function probeReviewerSession({ pgid, sessionUuid, probeAlive = probePgidAlive } = {}) {
  const alive = probeAlive(pgid);
  if (!alive) return { alive: false, matched: false };

  const numericPgid = Number(pgid);
  if (!Number.isInteger(numericPgid) || numericPgid <= 0 || !sessionUuid) {
    return { alive: true, matched: false };
  }

  try {
    const stdout = execFileSync('ps', ['-p', String(numericPgid), '-o', 'command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2_000,
    });
    return { alive: true, matched: stdout.includes(String(sessionUuid)) };
  } catch {
    return { alive: true, matched: false };
  }
}

function killPgid(pgid, signal = 'SIGKILL') {
  const numericPgid = Number(pgid);
  if (!Number.isInteger(numericPgid) || numericPgid <= 0) return false;
  try {
    process.kill(-numericPgid, signal);
    return true;
  } catch (err) {
    if (err?.code === 'ESRCH') return false;
    try {
      process.kill(numericPgid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

function makeReviewPostedProbe(octokit, { log = console } = {}) {
  const cache = new Map();

  return async function reviewPostedAfter(row) {
    const startedAtMs = parseTime(row.reviewer_started_at);
    if (startedAtMs === null) return null;

    const { owner, repo } = splitRepoPath(row.repo);
    const key = `${row.repo}#${row.pr_number}`;
    let reviews = cache.get(key);
    if (!reviews) {
      const params = {
        owner,
        repo,
        pull_number: row.pr_number,
        per_page: 100,
      };
      if (typeof octokit.paginate === 'function') {
        reviews = await octokit.paginate(octokit.rest.pulls.listReviews, params);
      } else {
        reviews = (await octokit.rest.pulls.listReviews(params)).data;
        if (Array.isArray(reviews) && reviews.length === params.per_page) {
          log.warn(
            `[watcher] reviewer_reattach_review_probe_truncated repo=${row.repo} pr=${row.pr_number} ` +
            'octokit.paginate unavailable and first page is full'
          );
        }
      }
      cache.set(key, Array.isArray(reviews) ? reviews : []);
    }

    const expectedLogin = reviewerBotLogin(row.reviewer);
    if (!expectedLogin) return null;
    return cache.get(key)
      .filter((review) => review?.user?.login === expectedLogin)
      .filter((review) => {
        const submittedAtMs = parseTime(review?.submitted_at);
        return submittedAtMs !== null && submittedAtMs >= startedAtMs;
      })
      .sort((a, b) => Date.parse(a.submitted_at) - Date.parse(b.submitted_at))[0] || null;
  };
}

async function fetchCurrentHeadSha(octokit, row) {
  const { owner, repo } = splitRepoPath(row.repo);
  const { data } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: row.pr_number,
  });
  return data?.head?.sha || null;
}

function prepareStatements(db) {
  return {
    listReviewing: db.prepare(
      `SELECT repo, pr_number, reviewer, review_attempts, last_attempted_at,
              reviewer_session_uuid, reviewer_pgid, reviewer_started_at,
              reviewer_head_sha
         FROM reviewed_prs
        WHERE review_status = 'reviewing'`
    ),
    markOrphan: db.prepare(
      "UPDATE reviewed_prs SET review_status = 'failed-orphan', failed_at = ?, failure_message = ?, review_attempts = review_attempts + 1 WHERE repo = ? AND pr_number = ?"
    ),
    markFailed: db.prepare(
      "UPDATE reviewed_prs SET review_status = 'failed', failed_at = ?, failure_message = ?, review_attempts = review_attempts + 1 WHERE repo = ? AND pr_number = ?"
    ),
    markPosted: db.prepare(
      "UPDATE reviewed_prs SET review_status = 'posted', posted_at = ?, failed_at = NULL, failure_message = NULL, review_attempts = review_attempts + 1 WHERE repo = ? AND pr_number = ?"
    ),
  };
}

function markLegacyOrphan({ statements, row, failureAt, log }) {
  statements.markOrphan.run(failureAt, LEGACY_ORPHAN_FAILURE_MESSAGE, row.repo, row.pr_number);
  log.warn(
    `[watcher] Orphan reviewer detected for ${row.repo}#${row.pr_number} ` +
    `(last_attempted_at=${row.last_attempted_at || 'unknown'}); ` +
    `marked review_status='failed-orphan'. Operator must verify GitHub before clearing.`
  );
}

function markStickyOrphan({ statements, row, failureAt, message, log, event }) {
  statements.markOrphan.run(failureAt, message, row.repo, row.pr_number);
  log.warn(
    `[watcher] ${event} repo=${row.repo} pr=${row.pr_number} ` +
    `session=${row.reviewer_session_uuid || 'unknown'} pgid=${row.reviewer_pgid || 'unknown'}`
  );
}

async function reconcileReviewerSessions({
  db,
  octokit,
  now = new Date(),
  log = console,
  statements = prepareStatements(db),
  probeAlive = probePgidAlive,
  probeSession,
  killProcessGroup = killPgid,
  fetchHeadSha = (row) => fetchCurrentHeadSha(octokit, row),
  findPostedReview = makeReviewPostedProbe(octokit),
  shouldReconcileRow = () => true,
} = {}) {
  const rows = statements.listReviewing.all().filter((row) => shouldReconcileRow(row, now));
  if (rows.length === 0) return { reconciled: 0 };

  const failureAt = now.toISOString();
  for (const row of rows) {
    if (!row.reviewer_session_uuid) {
      markLegacyOrphan({ statements, row, failureAt, log });
      continue;
    }

    if (row.reviewer_pgid === null || row.reviewer_pgid === undefined || row.reviewer_pgid === '') {
      markStickyOrphan({
        statements,
        row,
        failureAt,
        message: NULL_PGID_FAILURE_MESSAGE,
        log,
        event: 'reviewer_reattach_missing_pgid',
      });
      continue;
    }

    if (!reviewerBotLogin(row.reviewer)) {
      markStickyOrphan({
        statements,
        row,
        failureAt,
        message: `${UNKNOWN_REVIEWER_FAILURE_MESSAGE} reviewer=${row.reviewer || 'unknown'}`,
        log,
        event: 'reviewer_reattach_unknown_reviewer',
      });
      continue;
    }

    if (parseTime(row.reviewer_started_at) === null) {
      markStickyOrphan({
        statements,
        row,
        failureAt,
        message: `${CORRUPT_SESSION_FAILURE_MESSAGE} reviewer_started_at=${row.reviewer_started_at || 'missing'}`,
        log,
        event: 'reviewer_reattach_corrupt_started_at',
      });
      continue;
    }

    let currentHeadSha = null;
    try {
      currentHeadSha = await fetchHeadSha(row);
    } catch (err) {
      log.warn(
        `[watcher] reviewer_reattach_head_probe_failed repo=${row.repo} pr=${row.pr_number} ` +
        `session=${row.reviewer_session_uuid} error=${err?.message || err}`
      );
      markStickyOrphan({
        statements,
        row,
        failureAt,
        message: `${PROBE_FAILURE_MESSAGE} head probe failed: ${err?.message || err}`,
        log,
        event: 'reviewer_reattach_probe_failed',
      });
      continue;
    }

    let postedReview = null;
    try {
      postedReview = await findPostedReview(row);
    } catch (err) {
      log.warn(
        `[watcher] reviewer_reattach_review_probe_failed repo=${row.repo} pr=${row.pr_number} ` +
        `session=${row.reviewer_session_uuid} error=${err?.message || err}`
      );
      markStickyOrphan({
        statements,
        row,
        failureAt,
        message: `${PROBE_FAILURE_MESSAGE} review probe failed: ${err?.message || err}`,
        log,
        event: 'reviewer_reattach_probe_failed',
      });
      continue;
    }

    const sessionProbe = typeof probeSession === 'function'
      ? probeSession(row)
      : probeReviewerSession({
        pgid: row.reviewer_pgid,
        sessionUuid: row.reviewer_session_uuid,
        probeAlive,
      });
    const alive = typeof sessionProbe === 'boolean' ? sessionProbe : sessionProbe?.alive === true;
    const sessionMatched = typeof sessionProbe === 'boolean' ? sessionProbe : sessionProbe?.matched === true;
    const headChanged = Boolean(
      row.reviewer_head_sha &&
      currentHeadSha &&
      row.reviewer_head_sha !== currentHeadSha
    );

    if (alive) {
      if (!sessionMatched) {
        markStickyOrphan({
          statements,
          row,
          failureAt,
          message: PGID_IDENTITY_FAILURE_MESSAGE,
          log,
          event: 'reviewer_reattach_identity_mismatch',
        });
        continue;
      }

      if (headChanged) {
        killProcessGroup(row.reviewer_pgid, 'SIGKILL');
        statements.markFailed.run(
          failureAt,
          `Reviewer session ${row.reviewer_session_uuid} invalidated: PR head changed from ${row.reviewer_head_sha} to ${currentHeadSha}.`,
          row.repo,
          row.pr_number
        );
        log.warn(
          `[watcher] reviewer_reattach_invalidated repo=${row.repo} pr=${row.pr_number} ` +
          `session=${row.reviewer_session_uuid} pgid=${row.reviewer_pgid} ` +
          `spawn_head=${row.reviewer_head_sha} current_head=${currentHeadSha}`
        );
        continue;
      }

      if (postedReview) {
        statements.markOrphan.run(
          failureAt,
          `Reviewer session ${row.reviewer_session_uuid} posted a GitHub review at ${postedReview.submitted_at} but process group ${row.reviewer_pgid} is still alive. Operator must inspect before retrying.`,
          row.repo,
          row.pr_number
        );
        log.warn(
          `[watcher] reviewer_reattach_orphan repo=${row.repo} pr=${row.pr_number} ` +
          `session=${row.reviewer_session_uuid} pgid=${row.reviewer_pgid} posted_at=${postedReview.submitted_at}`
        );
        continue;
      }

      log.log(
        `[watcher] reviewer_reattach_alive repo=${row.repo} pr=${row.pr_number} ` +
        `reattached to reviewer session=${row.reviewer_session_uuid} pgid=${row.reviewer_pgid}`
      );
      continue;
    }

    if (postedReview) {
      statements.markPosted.run(postedReview.submitted_at, row.repo, row.pr_number);
      log.log(
        `[watcher] reviewer_reattach_recovered repo=${row.repo} pr=${row.pr_number} ` +
        `session=${row.reviewer_session_uuid} pgid=${row.reviewer_pgid || 'unknown'} posted_at=${postedReview.submitted_at}`
      );
      continue;
    }

    statements.markFailed.run(
      failureAt,
      `Reviewer session ${row.reviewer_session_uuid} is no longer alive and no GitHub review was found from ${reviewerBotLogin(row.reviewer)} since ${row.reviewer_started_at || 'unknown start time'}.`,
      row.repo,
      row.pr_number
    );
    log.warn(
      `[watcher] reviewer_reattach_dead repo=${row.repo} pr=${row.pr_number} ` +
      `session=${row.reviewer_session_uuid} pgid=${row.reviewer_pgid || 'unknown'}`
    );
  }

  return { reconciled: rows.length };
}

export {
  LEGACY_ORPHAN_FAILURE_MESSAGE,
  NULL_PGID_FAILURE_MESSAGE,
  PGID_IDENTITY_FAILURE_MESSAGE,
  killPgid,
  makeReviewPostedProbe,
  probePgidAlive,
  probeReviewerSession,
  reconcileReviewerSessions,
  reviewerBotLogin,
};
