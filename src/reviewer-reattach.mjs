const LEGACY_ORPHAN_FAILURE_MESSAGE =
  'Watcher restarted while review subprocess was in flight. ' +
  'A review may have been posted on GitHub by the orphaned child. ' +
  'Verify the PR before retriggering with `npm run retrigger-review`.';

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
  return REVIEWER_BOT_LOGINS.get(lower) || value;
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

function makeReviewPostedProbe(octokit) {
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
      reviews = typeof octokit.paginate === 'function'
        ? await octokit.paginate(octokit.rest.pulls.listReviews, params)
        : (await octokit.rest.pulls.listReviews(params)).data;
      cache.set(key, Array.isArray(reviews) ? reviews : []);
    }

    const expectedLogin = reviewerBotLogin(row.reviewer);
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

async function reconcileReviewerSessions({
  db,
  octokit,
  now = new Date(),
  log = console,
  statements = prepareStatements(db),
  probeAlive = probePgidAlive,
  killProcessGroup = killPgid,
  fetchHeadSha = (row) => fetchCurrentHeadSha(octokit, row),
  findPostedReview = makeReviewPostedProbe(octokit),
} = {}) {
  const rows = statements.listReviewing.all();
  if (rows.length === 0) return { reconciled: 0 };

  const failureAt = now.toISOString();
  for (const row of rows) {
    if (!row.reviewer_session_uuid) {
      markLegacyOrphan({ statements, row, failureAt, log });
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
    }

    let postedReview = null;
    try {
      postedReview = await findPostedReview(row);
    } catch (err) {
      log.warn(
        `[watcher] reviewer_reattach_review_probe_failed repo=${row.repo} pr=${row.pr_number} ` +
        `session=${row.reviewer_session_uuid} error=${err?.message || err}`
      );
    }

    const alive = probeAlive(row.reviewer_pgid);
    const headChanged = Boolean(
      row.reviewer_head_sha &&
      currentHeadSha &&
      row.reviewer_head_sha !== currentHeadSha
    );

    if (alive) {
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
  killPgid,
  makeReviewPostedProbe,
  probePgidAlive,
  reconcileReviewerSessions,
  reviewerBotLogin,
};
