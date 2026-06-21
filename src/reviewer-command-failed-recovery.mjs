function parseTime(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function hasReviewProbeEvidence(row, { resolveReviewerLogin = null } = {}) {
  if (!row?.reviewer_session_uuid || parseTime(row?.reviewer_started_at) === null) {
    return false;
  }
  if (typeof resolveReviewerLogin === 'function') {
    return Boolean(resolveReviewerLogin(row.reviewer));
  }
  return true;
}

async function reconcileReviewerCommandFailedBeforeRetry({
  row,
  findPostedReview,
  markPosted,
  settleRunRecord = async () => {},
  resolveReviewerLogin = null,
  log = console,
} = {}) {
  if (!hasReviewProbeEvidence(row, { resolveReviewerLogin })) {
    log.warn?.(
      `[watcher] Skipping reviewer-command-failed auto-recovery for ${row?.repo || 'unknown'}#${row?.pr_number || 'unknown'}: ` +
        'missing reviewer session/start/login evidence needed to prove no GitHub review was posted'
    );
    return { handled: true, action: 'missing-review-probe-evidence' };
  }

  let postedReview = null;
  try {
    postedReview = await findPostedReview(row, { refresh: true });
  } catch (err) {
    log.warn?.(
      `[watcher] Skipping reviewer-command-failed auto-recovery for ${row.repo}#${row.pr_number}: ` +
        `GitHub review reconciliation probe failed: ${err?.message || err}`
    );
    return { handled: true, action: 'review-probe-failed', error: err };
  }

  if (!postedReview) {
    return { handled: false, action: 'no-posted-review-found' };
  }

  const postedAt = postedReview.submitted_at || new Date().toISOString();
  // CAS BEFORE settling. `markPosted` must atomically match the exact failed row
  // + reviewer session this probe inspected and return the number of rows it
  // changed. If the row moved on between the async GitHub probe and now — a newer
  // claim flipped it to `reviewing`, a newer failure replaced the session, or an
  // operator changed it — the CAS matches 0 rows. In that case we must NOT force
  // `posted` (which would clear failure evidence, reset attempts, and settle a
  // stale session's run record over the live one); leave the row untouched for
  // the next poll. Only settle the run record once the CAS provably won.
  const casChanges = markPosted({ row, postedAt, postedReview });
  if (casChanges !== 1) {
    log.warn?.(
      `[watcher] Skipping reviewer-command-failed auto-recovery for ${row.repo}#${row.pr_number}: ` +
        `the failed row changed since the GitHub review probe (posted-reconcile CAS matched ${casChanges} row(s)); ` +
        'leaving evidence intact for the next poll'
    );
    return { handled: true, action: 'reconcile-cas-lost', casChanges };
  }
  await settleRunRecord({
    sessionUuid: row.reviewer_session_uuid,
    state: 'completed',
    settledAt: postedAt,
    reason: 'posted-review-recovered-before-command-failed-retry',
  });
  log.log?.(
    `[watcher] Recovered reviewer-command-failed row ${row.repo}#${row.pr_number}: ` +
      `reviewer session ${row.reviewer_session_uuid} already posted GitHub review at ${postedAt}; ` +
      'marked review_status=posted instead of retrying'
  );
  return { handled: true, action: 'marked-posted', postedAt };
}

export {
  hasReviewProbeEvidence,
  reconcileReviewerCommandFailedBeforeRetry,
};
