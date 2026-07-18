import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { reconcileReviewerSessions } from './reviewer-reattach.mjs';
import { resolveReviewerTimeoutMs } from './reviewer-timeout.mjs';
import {
  DEFAULT_REVIEWER_LEASE_RECOVERY_MAX_ATTEMPTS,
  computeReviewerLeaseExpiryAt,
  isReviewerLeaseExpired,
  resolveReviewerLeaseRecoveryEnabled,
} from './reviewer-lease.mjs';
import {
  readReviewerRunRecord,
  settleReviewerRunRecord,
} from './adapters/reviewer-runtime/run-state.mjs';
import {
  db,
  stmtListFailedOrphanAutoReclaimCandidates,
  stmtAutoReclaimFailedOrphan,
  stmtMarkPosted,
  stmtMarkReviewerPgid,
} from './review-state-db.mjs';

const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// ARC-18: REVIEWER_LEASE_RECOVERY_ENABLED and INFRA_AUTO_RECOVER_CAP remain
// watcher module consts referenced elsewhere in watcher.mjs; they are re-derived
// here from the same inputs (config.json + reviewer-lease defaults) so this leaf
// module avoids a src->watcher circular import while preserving their values.
const REVIEWER_LEASE_RECOVERY_ENABLED = resolveReviewerLeaseRecoveryEnabled({
  watcherConfig: JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8')),
});
const INFRA_AUTO_RECOVER_CAP = DEFAULT_REVIEWER_LEASE_RECOVERY_MAX_ATTEMPTS;

// ── Reviewer session reconciliation (startup) ────────────────────────────────
//
// On startup, find any rows still in 'reviewing' from a previous
// watcher run that exited (watchdog timeout, crash, OOM, launchd
// restart) before transitioning them to 'posted' or 'failed'. Those
// rows mean a reviewer subprocess was in flight when the parent died
// — and may have posted a review to GitHub the parent never recorded.
//
// Rows created before reviewer handles existed still fall through to
// sticky failed-orphan so pollOnce skips them and the operator gets a
// clear, durable record. Rows with handles are probed first: a live,
// current reviewer remains 'reviewing', a dead reviewer with a posted
// GitHub review is recovered to 'posted', and dead/stale sessions move
// to retryable 'failed'.
//
//   1. Inspect the GitHub PR to see whether a review was already posted.
//   2. If yes: leave the row alone (it's effectively done) — or use
//      the operator tooling to mark it posted; either way the row
//      stops blocking.
//   3. If no: run `npm run retrigger-review --repo <slug> --pr <n>
//      --reason "verified no orphan review present"` to clear the
//      sticky state and re-arm review_status='pending'.
//
// This remains the durable half of the duplicate-review guard; the
// cross-process claim CAS below is still the only place new reviewer
// subprocesses are admitted.
export async function reconcileOrphanedReviewing(octokit) {
  return reconcileReviewerSessions({
    db,
    octokit,
    leaseRecoveryEnabled: REVIEWER_LEASE_RECOVERY_ENABLED,
    leaseRecoveryMaxAttempts: INFRA_AUTO_RECOVER_CAP,
    onTerminalDeadSession: ({ row, state, settledAt }) => settleDurableReviewerRunState({
      sessionUuid: row?.reviewer_session_uuid,
      state,
      settledAt,
    }),
  });
}

export function shouldReconcileStaleReviewerSession(row, now, {
  reviewerTimeoutMs = resolveReviewerTimeoutMs(),
  leaseRecoveryEnabled = REVIEWER_LEASE_RECOVERY_ENABLED,
} = {}) {
  if (leaseRecoveryEnabled && isReviewerLeaseExpired(row, now, { reviewerTimeoutMs })) {
    return true;
  }
  const persistedTimeoutMs = Number(row?.reviewer_timeout_ms);
  const effectiveTimeoutMs = Number.isInteger(persistedTimeoutMs) && persistedTimeoutMs > 0
    ? persistedTimeoutMs
    : reviewerTimeoutMs;
  const startedAtMs = Date.parse(row?.reviewer_started_at || '');
  if (!Number.isFinite(startedAtMs)) {
    const claimedAtMs = Date.parse(row?.last_attempted_at || '');
    if (Number.isFinite(claimedAtMs)) {
      return (claimedAtMs + effectiveTimeoutMs) <= now.getTime();
    }
    return true;
  }
  return (startedAtMs + effectiveTimeoutMs) <= now.getTime();
}

export function shouldReconcileAdoptedReviewerSession(row, {
  rootDir = ROOT,
  log = console,
} = {}) {
  if (!row?.reviewer_session_uuid) return false;
  try {
    const record = readReviewerRunRecord(rootDir, row.reviewer_session_uuid);
    return record?.adoptedAfterBounce === true;
  } catch (err) {
    log.warn?.(
      `[watcher] reviewer_run_state_read_failed session=${row.reviewer_session_uuid} ` +
      `error=${err?.message || err}`
    );
    return false;
  }
}

export function shouldReconcileReviewerSession(row, now, options = {}) {
  return shouldReconcileStaleReviewerSession(row, now, options) ||
    shouldReconcileAdoptedReviewerSession(row, options);
}

export function settleDurableReviewerRunState({
  rootDir = ROOT,
  sessionUuid,
  state,
  settledAt = new Date().toISOString(),
  log = console,
} = {}) {
  if (!sessionUuid || !state) return null;
  try {
    return settleReviewerRunRecord(rootDir, sessionUuid, { state, settledAt });
  } catch (err) {
    log.warn?.(
      `[watcher] reviewer_run_state_settle_failed session=${sessionUuid} state=${state} ` +
      `error=${err?.message || err}`
    );
    return null;
  }
}

function probeReviewerProcessGroupAlive(pgid) {
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

export async function probeReviewerProcessSession({
  pgid,
  sessionUuid,
  execFileImpl = execFileAsync,
  probeGroupAliveImpl = probeReviewerProcessGroupAlive,
} = {}) {
  const alive = probeGroupAliveImpl(pgid);
  if (!alive) return { alive: false, matched: false };

  const numericPgid = Number(pgid);
  if (!Number.isInteger(numericPgid) || numericPgid <= 0 || !sessionUuid) {
    return { alive: true, matched: 'unknown' };
  }

  try {
    const { stdout } = await execFileImpl('ps', ['-ww', '-p', String(numericPgid), '-o', 'command='], {
      encoding: 'utf8',
      timeout: 2_000,
    });
    return { alive: true, matched: stdout.includes(String(sessionUuid)) };
  } catch {
    return { alive: true, matched: 'unknown' };
  }
}

export async function failedOrphanAutoReclaimDecision(row, now = new Date(), {
  cap = INFRA_AUTO_RECOVER_CAP,
  probeSessionImpl = probeReviewerProcessSession,
  reviewerTimeoutMs = resolveReviewerTimeoutMs(),
} = {}) {
  if (!row || row.review_status && row.review_status !== 'failed-orphan') {
    return { reclaim: false, reason: 'not-failed-orphan' };
  }
  if (row.pr_state && row.pr_state !== 'open') {
    return { reclaim: false, reason: 'pr-not-open' };
  }
  const attempts = Number(row.infra_auto_recover_attempts || 0);
  if (attempts >= cap) {
    return { reclaim: false, reason: 'cap-exhausted' };
  }
  if (!isReviewerLeaseExpired(row, now, { reviewerTimeoutMs })) {
    return { reclaim: false, reason: 'lease-active' };
  }

  const sessionProbe = await probeSessionImpl({
    pgid: row.reviewer_pgid,
    sessionUuid: row.reviewer_session_uuid,
  });
  const alive = typeof sessionProbe === 'boolean' ? sessionProbe : sessionProbe?.alive === true;
  const matched = typeof sessionProbe === 'boolean' ? sessionProbe : sessionProbe?.matched;
  if (alive) {
    if (matched === false) {
      return { reclaim: true, reason: 'reviewer-session-mismatch' };
    }
    return {
      reclaim: false,
      reason: matched === true ? 'reviewer-live' : 'reviewer-liveness-unknown',
    };
  }

  return { reclaim: true, reason: 'lease-expired-reviewer-dead' };
}

export async function autoReclaimFailedOrphans({
  now = new Date(),
  cap = INFRA_AUTO_RECOVER_CAP,
  maxRows = 20,
  statements = {
    listCandidates: stmtListFailedOrphanAutoReclaimCandidates,
    reclaim: stmtAutoReclaimFailedOrphan,
    markPosted: stmtMarkPosted,
  },
  probeSessionImpl = probeReviewerProcessSession,
  findPostedReview = null,
  settleRunRecord = ({ sessionUuid, settledAt }) => settleDurableReviewerRunState({
    sessionUuid,
    state: 'cancelled',
    settledAt,
  }),
  log = console,
} = {}) {
  const limit = Number.isInteger(Number(maxRows)) && Number(maxRows) >= 0 ? Number(maxRows) : 20;
  const reclaimedAt = now.toISOString();
  const rows = statements.listCandidates.all(cap, limit);
  let reclaimed = 0;
  let skipped = 0;

  for (const row of rows) {
    const decision = await failedOrphanAutoReclaimDecision(row, now, {
      cap,
      probeSessionImpl,
    });
    if (!decision.reclaim) {
      skipped += 1;
      log.log?.(
        `[watcher] failed_orphan_auto_reclaim_skipped repo=${row.repo} pr=${row.pr_number} ` +
        `reason=${decision.reason} session=${row.reviewer_session_uuid || 'unknown'} ` +
        `pgid=${row.reviewer_pgid || 'unknown'}`
      );
      continue;
    }

    if (typeof findPostedReview === 'function') {
      try {
        const postedReview = await findPostedReview(row, { refresh: true });
        if (postedReview) {
          skipped += 1;
          const postedAt =
            postedReview.submitted_at || postedReview.submittedAt || reclaimedAt;
          const markPosted = statements.markPosted?.run;
          if (typeof markPosted === 'function') {
            const result = markPosted.call(statements.markPosted, postedAt, row.repo, row.pr_number);
            log.warn?.(
              `[watcher] failed_orphan_auto_reclaim_skipped repo=${row.repo} pr=${row.pr_number} ` +
              `reason=posted-review-found-reconciled session=${row.reviewer_session_uuid || 'unknown'} ` +
              `posted_at=${postedAt} mark_changes=${result?.changes ?? 'unknown'}`
            );
          } else {
            log.warn?.(
              `[watcher] failed_orphan_auto_reclaim_skipped repo=${row.repo} pr=${row.pr_number} ` +
              `reason=posted-review-found-mark-posted-unavailable ` +
              `session=${row.reviewer_session_uuid || 'unknown'} posted_at=${postedAt}`
            );
          }
          continue;
        }
      } catch (err) {
        skipped += 1;
        log.warn?.(
          `[watcher] failed_orphan_auto_reclaim_skipped repo=${row.repo} pr=${row.pr_number} ` +
          `reason=posted-review-probe-failed session=${row.reviewer_session_uuid || 'unknown'} ` +
          `error=${err?.message || err}`
        );
        continue;
      }
    }

    const message =
      `[failed-orphan-auto-reclaim] Lease expired and no live reviewer process group was found; ` +
      `re-arming review automatically (infra_auto_recover_attempts ${Number(row.infra_auto_recover_attempts || 0) + 1}/${cap}).`;
    const result = statements.reclaim.run(
      reclaimedAt,
      message,
      reclaimedAt,
      'auto-reclaim failed-orphan after expired lease and dead reviewer process',
      row.repo,
      row.pr_number,
      cap,
      row.reviewer_session_uuid || '',
      row.reviewer_pgid ?? '',
      row.reviewer_lease_expires_at || ''
    );
    if (result.changes !== 1) {
      skipped += 1;
      log.warn?.(
        `[watcher] failed_orphan_auto_reclaim_cas_miss repo=${row.repo} pr=${row.pr_number} ` +
        `session=${row.reviewer_session_uuid || 'unknown'} pgid=${row.reviewer_pgid || 'unknown'}`
      );
      continue;
    }

    reclaimed += 1;
    settleRunRecord({ sessionUuid: row.reviewer_session_uuid, settledAt: reclaimedAt, row });
    log.warn?.(
      `[watcher] failed_orphan_auto_reclaimed repo=${row.repo} pr=${row.pr_number} ` +
      `session=${row.reviewer_session_uuid || 'unknown'} pgid=${row.reviewer_pgid || 'unknown'} ` +
      `attempt=${Number(row.infra_auto_recover_attempts || 0) + 1}/${cap}`
    );
  }

  return { reclaimed, skipped };
}

export function persistReviewerPgid({
  pgid,
  reviewerSessionUuid,
  repoPath,
  prNumber,
  startedAt = new Date().toISOString(),
  reviewerTimeoutMs = resolveReviewerTimeoutMs(),
  log = console,
  handlePollErrorImpl,
}) {
  try {
    const leaseExpiresAt = computeReviewerLeaseExpiryAt(startedAt, reviewerTimeoutMs);
    const result = stmtMarkReviewerPgid.run(
      pgid,
      startedAt,
      leaseExpiresAt,
      reviewerSessionUuid,
      repoPath,
      prNumber
    );
    if (result.changes === 0) {
      log.warn?.(
        `[watcher] reviewer_session_handle_cas_miss repo=${repoPath} pr=${prNumber} ` +
        `session=${reviewerSessionUuid} pgid=${pgid}`
      );
      return false;
    }
    log.log?.(
      `[watcher] reviewer_session_handle_persisted repo=${repoPath} pr=${prNumber} ` +
      `session=${reviewerSessionUuid} pgid=${pgid}`
    );
    return true;
  } catch (err) {
    handlePollErrorImpl(err, 'stmtMarkReviewerPgid');
    log.warn?.(
      `[watcher] reviewer_session_handle_persist_failed repo=${repoPath} pr=${prNumber} ` +
      `session=${reviewerSessionUuid} pgid=${pgid} error=${err?.message || err}`
    );
    return false;
  }
}
