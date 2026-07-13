// ARP-02 first-pass reviewer lease + recovery, graduated to ON by default.
// A watcher bounce mid-review — continuous under CI/CD-driven main-catchup
// deploys — leaves the reviewed_prs row 'reviewing'. On restart the reconciler
// must re-arm it to 'pending' (reclaimable by the claim CAS) rather than the
// sticky 'failed' state, which the CAS never re-picks-up and which silently
// orphans the ticket (rev=none forever). Override per-deploy with
// ADVERSARIAL_REVIEWER_LEASE_RECOVERY_ENABLED / watcherConfig.
const DEFAULT_REVIEWER_LEASE_RECOVERY_ENABLED = true;

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
  computeReviewerLeaseExpiryAt,
  isReviewerLeaseExpired,
  resolveReviewerLeaseRecoveryEnabled,
  reviewerLeaseExpiryForRow,
};
