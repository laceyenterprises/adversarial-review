import { loadRoleConfig } from './role-config.mjs';
import { recordCascadeFailure } from './reviewer-cascade.mjs';
import { DEFAULT_REVIEWER_LEASE_RECOVERY_MAX_ATTEMPTS } from './reviewer-lease.mjs';

const DEFAULT_RUNNING_PASS_TIMEOUT_SECONDS = 3600;
const RUNNING_PASS_TIMEOUT_FAILURE_CLASS = 'reviewer-timeout';
const RUNNING_PASS_TIMEOUT_FAILURE_REASON = 'running-pass-timeout';
const INFRA_AUTO_RECOVER_CAP = DEFAULT_REVIEWER_LEASE_RECOVERY_MAX_ATTEMPTS;

function parseMetadataJson(raw) {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseTimestampMs(value) {
  if (!value) return null;
  const text = String(value);
  const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : `${text}Z`);
  return Number.isFinite(ms) ? ms : null;
}

function reviewerSessionUuidFromPass(row) {
  const metadata = parseMetadataJson(row?.metadata_json);
  const value = metadata.reviewerSessionUuid;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function resolveRunningPassTimeoutSeconds(env = process.env, options = {}) {
  const raw = loadRoleConfig({
    env,
    topPath: options.topPath,
    modulePaths: options.modulePaths,
    loaderImpl: options.loaderImpl,
    contextKey: 'reviewer.running_pass_timeout_seconds',
  }).get(
    'reviewer.running_pass_timeout_seconds',
    DEFAULT_RUNNING_PASS_TIMEOUT_SECONDS
  );
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return DEFAULT_RUNNING_PASS_TIMEOUT_SECONDS;
  }
  return parsed;
}

function buildTimeoutFailureMessage({ thresholdSeconds, ageSeconds, capExhausted = false } = {}) {
  const suffix = capExhausted
    ? `; infra auto-recovery cap exhausted`
    : '';
  return `[${RUNNING_PASS_TIMEOUT_FAILURE_CLASS}] Reviewer pass timed out while still running ` +
    `after ${ageSeconds}s (threshold=${thresholdSeconds}s, reason=${RUNNING_PASS_TIMEOUT_FAILURE_REASON})${suffix}.`;
}

function reapRunningPassTimeouts({ db, rootDir = process.cwd(), log = console } = {}) {
  const thresholdSeconds = resolveRunningPassTimeoutSeconds();
  const rows = db.prepare(
    `SELECT pass_id, repo, pr_number, attempt_number, pass_kind, reviewer_class, reviewer_model,
            started_at, metadata_json, head_sha
       FROM reviewer_passes
      WHERE status = 'running'
        AND ended_at IS NULL
        AND datetime(started_at) < datetime('now', '-' || ? || ' seconds')`
  ).all(thresholdSeconds);

  const getReviewRow = db.prepare(
    `SELECT review_status, reviewer_session_uuid, reviewer_started_at, reviewer_head_sha,
            infra_auto_recover_attempts
       FROM reviewed_prs
      WHERE repo = ?
        AND pr_number = ?`
  );
  const releaseReviewClaim = db.prepare(
    `UPDATE reviewed_prs
        SET review_status = 'pending-upstream',
            failed_at = ?,
            failure_message = ?,
            reviewer_lease_expires_at = NULL,
            infra_auto_recover_attempts = COALESCE(infra_auto_recover_attempts, 0) + 1
      WHERE repo = ?
        AND pr_number = ?
        AND review_status = 'reviewing'
        AND (
          (? IS NOT NULL AND reviewer_session_uuid = ?) OR
          (
            COALESCE(reviewer_started_at, '') = COALESCE(?, '') AND
            (? IS NULL OR reviewer_head_sha IS NULL OR reviewer_head_sha = ?)
          )
        )
        AND COALESCE(infra_auto_recover_attempts, 0) < ?`
  );
  const failReviewClaimAtCap = db.prepare(
    `UPDATE reviewed_prs
        SET review_status = 'failed',
            failed_at = ?,
            failure_message = ?,
            reviewer_lease_expires_at = NULL
      WHERE repo = ?
        AND pr_number = ?
        AND review_status = 'reviewing'
        AND (
          (? IS NOT NULL AND reviewer_session_uuid = ?) OR
          (
            COALESCE(reviewer_started_at, '') = COALESCE(?, '') AND
            (? IS NULL OR reviewer_head_sha IS NULL OR reviewer_head_sha = ?)
          )
        )
        AND COALESCE(infra_auto_recover_attempts, 0) >= ?`
  );
  const updatePass = db.prepare(
    `UPDATE reviewer_passes
        SET ended_at = ?,
            status = 'failed',
            metadata_json = ?
      WHERE pass_id = ?
        AND status = 'running'
        AND ended_at IS NULL`
  );

  const settleTimedOutPass = db.transaction(({ row, endedAt, metadataJson, failureMessage, capFailureMessage }) => {
    const current = getReviewRow.get(row.repo, row.pr_number);
    if (current?.review_status === 'reviewing') {
      const infraAttempts = Number(current.infra_auto_recover_attempts || 0);
      const reviewerSessionUuid = reviewerSessionUuidFromPass(row);
      const statement = infraAttempts >= INFRA_AUTO_RECOVER_CAP
        ? failReviewClaimAtCap
        : releaseReviewClaim;
      const reviewResult = statement.run(
        endedAt,
        infraAttempts >= INFRA_AUTO_RECOVER_CAP ? capFailureMessage : failureMessage,
        row.repo,
        row.pr_number,
        reviewerSessionUuid,
        reviewerSessionUuid,
        row.started_at,
        row.head_sha || null,
        row.head_sha || null,
        INFRA_AUTO_RECOVER_CAP
      );
      if (reviewResult.changes === 0) {
        return { passChanged: false, reviewChanged: false, reviewStatus: 'reviewing-owner-mismatch' };
      }
    }

    const passResult = updatePass.run(endedAt, metadataJson, row.pass_id);
    return {
      passChanged: passResult.changes > 0,
      reviewChanged: current?.review_status === 'reviewing',
      reviewStatus: current?.review_status || null,
    };
  });

  let reaped = 0;
  let reviewClaimsReleased = 0;
  let reviewClaimsFailed = 0;
  for (const row of rows) {
    try {
      const startedMs = parseTimestampMs(row.started_at);
      if (startedMs == null) continue;
      const endedAt = new Date().toISOString();
      const ageSeconds = Math.floor((Date.now() - startedMs) / 1000);
      const failureMessage = buildTimeoutFailureMessage({ thresholdSeconds, ageSeconds });
      const capFailureMessage = buildTimeoutFailureMessage({
        thresholdSeconds,
        ageSeconds,
        capExhausted: true,
      });
      const metadata = {
        ...parseMetadataJson(row.metadata_json),
        failureClass: RUNNING_PASS_TIMEOUT_FAILURE_CLASS,
        failureReason: RUNNING_PASS_TIMEOUT_FAILURE_REASON,
        timeoutThresholdSeconds: thresholdSeconds,
      };
      const result = settleTimedOutPass({
        row,
        endedAt,
        metadataJson: JSON.stringify(metadata),
        failureMessage,
        capFailureMessage,
      });
      if (!result.passChanged) {
        log.warn?.(
          `[watcher] reviewer-pass reaper skipped ${row.repo}#${row.pr_number} pass_id=${row.pass_id}: ` +
          `active review claim no longer matches pass start/head evidence`
        );
        continue;
      }
      if (result.reviewChanged) {
        const reviewRow = getReviewRow.get(row.repo, row.pr_number);
        if (reviewRow?.review_status === 'pending-upstream') {
          recordCascadeFailure(rootDir, {
            repo: row.repo,
            prNumber: row.pr_number,
            failedAt: endedAt,
            failureClass: RUNNING_PASS_TIMEOUT_FAILURE_CLASS,
          });
          reviewClaimsReleased++;
        } else if (reviewRow?.review_status === 'failed') {
          reviewClaimsFailed++;
        }
      }
      log.log(
        `[watcher] reviewer-pass reaper: pr=${row.repo}#${row.pr_number} reviewer=${row.reviewer_model || row.reviewer_class}\n` +
        `          pass_id=${row.pass_id} status running->failed reason=${RUNNING_PASS_TIMEOUT_FAILURE_REASON}\n` +
        `          age=${ageSeconds}s threshold=${thresholdSeconds}s review_claim=${result.reviewChanged ? 'settled' : 'unchanged'}`
      );
      reaped++;
    } catch (err) {
      log.error(`[watcher] reviewer-pass reaper failed for ${row.repo}#${row.pr_number}:`, err);
    }
  }
  return { reaped, reviewClaimsReleased, reviewClaimsFailed };
}

export {
  DEFAULT_RUNNING_PASS_TIMEOUT_SECONDS,
  resolveRunningPassTimeoutSeconds,
  reapRunningPassTimeouts,
};
