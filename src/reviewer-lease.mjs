// ARP-02 first-pass reviewer lease + recovery, graduated to ON by default.
// A watcher bounce mid-review — continuous under CI/CD-driven main-catchup
// deploys — leaves the reviewed_prs row 'reviewing'. On restart the reconciler
// must re-arm it to 'pending' (reclaimable by the claim CAS) rather than the
// sticky 'failed' state, which the CAS never re-picks-up and which silently
// orphans the ticket (rev=none forever). Override per-deploy with
// ADVERSARIAL_REVIEWER_LEASE_RECOVERY_ENABLED / watcherConfig.
const DEFAULT_REVIEWER_LEASE_RECOVERY_ENABLED = true;
const DEFAULT_REVIEWER_LEASE_RECOVERY_MAX_ATTEMPTS = 3;

function parseBooleanFlag(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function resolveReviewerLeaseRecoveryEnabled({
  env = process.env,
  watcherConfig = {},
} = {}) {
  const configuredEnabled = watcherConfig.firstPassReviewerLeaseRecoveryEnabled
    ?? watcherConfig.reviewerLeaseRecoveryEnabled
    ?? DEFAULT_REVIEWER_LEASE_RECOVERY_ENABLED;
  return parseBooleanFlag(
    env.ADVERSARIAL_FIRST_PASS_REVIEWER_LEASE_RECOVERY_ENABLED
      ?? env.ADVERSARIAL_REVIEWER_LEASE_RECOVERY_ENABLED,
    Boolean(configuredEnabled)
  );
}

function computeReviewerLeaseExpiryAt(startedAt, timeoutMs) {
  const startedAtMs = Date.parse(String(startedAt || ''));
  const boundedTimeoutMs = Number(timeoutMs);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(boundedTimeoutMs) || boundedTimeoutMs <= 0) {
    return null;
  }
  return new Date(startedAtMs + Math.floor(boundedTimeoutMs)).toISOString();
}

// Extend only the session that built the plan. A delayed child must never
// change a replacement claim or a terminal review row.
function extendReviewerLeaseForPlan(db, { repo, prNumber, sessionUuid, timeoutMs }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError('Invalid reviewer timeout');
  const row = db.prepare(`SELECT reviewer_started_at, reviewer_timeout_ms FROM reviewed_prs
    WHERE repo = ? AND pr_number = ? AND reviewer_session_uuid = ?
      AND review_status = 'reviewing' AND COALESCE(pr_state, 'open') = 'open'`).get(repo, prNumber, sessionUuid);
  if (!row) return false;
  if (row.reviewer_timeout_ms >= timeoutMs) return true;
  const expiry = computeReviewerLeaseExpiryAt(row.reviewer_started_at, timeoutMs);
  if (!expiry) throw new Error('Missing reviewer start time for chunk plan');
  return db.prepare(`UPDATE reviewed_prs SET reviewer_timeout_ms = ?, reviewer_lease_expires_at = ?
    WHERE repo = ? AND pr_number = ? AND reviewer_session_uuid = ?
      AND review_status = 'reviewing' AND COALESCE(pr_state, 'open') = 'open'
      AND reviewer_started_at = ? AND reviewer_timeout_ms < ?`).run(
    timeoutMs, expiry, repo, prNumber, sessionUuid, row.reviewer_started_at, timeoutMs,
  ).changes === 1;
}

function reviewerLeaseExpiryForRow(row, {
  reviewerTimeoutMs = null,
} = {}) {
  if (row?.reviewer_lease_expires_at) {
    const persistedExpiryMs = Date.parse(String(row.reviewer_lease_expires_at));
    if (Number.isFinite(persistedExpiryMs)) {
      return new Date(persistedExpiryMs).toISOString();
    }
  }

  const persistedTimeoutMs = Number(row?.reviewer_timeout_ms);
  const effectiveTimeoutMs = Number.isInteger(persistedTimeoutMs) && persistedTimeoutMs > 0
    ? persistedTimeoutMs
    : Number.isInteger(Number(reviewerTimeoutMs)) && Number(reviewerTimeoutMs) > 0
      ? Number(reviewerTimeoutMs)
      : null;
  if (effectiveTimeoutMs === null) return null;

  return computeReviewerLeaseExpiryAt(
    row?.reviewer_started_at || row?.last_attempted_at || null,
    effectiveTimeoutMs
  );
}

function isReviewerLeaseExpired(row, now = new Date(), options = {}) {
  const leaseExpiryAt = reviewerLeaseExpiryForRow(row, options);
  if (!leaseExpiryAt) return false;
  return Date.parse(leaseExpiryAt) <= now.getTime();
}

export {
  DEFAULT_REVIEWER_LEASE_RECOVERY_ENABLED,
  DEFAULT_REVIEWER_LEASE_RECOVERY_MAX_ATTEMPTS,
  computeReviewerLeaseExpiryAt,
  extendReviewerLeaseForPlan,
  isReviewerLeaseExpired,
  resolveReviewerLeaseRecoveryEnabled,
  reviewerLeaseExpiryForRow,
};
