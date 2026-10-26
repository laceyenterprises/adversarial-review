// HOLDOWNER-01: observation only. No admission, retries or routing live here.
import { isOperatorHeld } from './operator-hold-labels.mjs';
import { readAmaCloserLease, readAmaCloserDispatchLease } from './ama/closer-lease.mjs';
import { readAmaCloserDispatchRecordsForPR } from './ama/dispatch-record-read.mjs';
import { readHammerStopForHead, readHammerStopHoldForHead } from './ama/hammer-stop-hold.mjs';
import { listFollowUpJobsInDir } from './follow-up-jobs.mjs';
import { launchRequestInFlight } from './ama/launch-request-status.mjs';

export const OWNERLESS_GRACE_MINUTES = 7; // five-minute poll plus two-minute margin
const time = value => Date.parse(value || '');
const RELEASE_CONDITIONS = new Set(['hammer-inputs-change', 'quota-reset-time']);

function holdDeclineReason(hold) {
  if (hold.releasedAt) return 'released';
  if (!RELEASE_CONDITIONS.has(hold.releaseCondition)) return 'no machine-checkable release condition';
  if (!Number.isFinite(time(hold.deadline))) return 'no deadline';
  return 'deadline expired';
}

/** Exactly one selected owner, or a diagnostic naming every declined lane. */
export function resolveTtmOwner({ labels = [], review = {}, closers = [], holds = [] } = {}, nowIso) {
  if (isOperatorHeld(labels)) return { owner: 'operator-hold', reason: 'operator hold label' };
  if (closers.some(closer => closer.live === true)) return { owner: 'live-closer', reason: 'non-terminal closer or remediator' };
  const activeHold = holds.find(hold => RELEASE_CONDITIONS.has(hold.releaseCondition) && Number.isFinite(time(hold.deadline))
    && time(hold.deadline) > time(nowIso) && !hold.releasedAt);
  if (activeHold) return { owner: 'hold', reason: activeHold.reason, hold: activeHold };
  if (review.live || (!review.suppressed && ['pending', 'pending-upstream', 'ci-blocked', 'reviewing'].includes(review.status))) {
    return { owner: 'review-lane', reason: `review ${review.status}` };
  }
  return { owner: null, reason: [
    review.suppressed ? `review suppressed: ${review.reason}` : `review declined: ${review.status || 'missing'}`,
    'no live closer',
    holds.length ? holds.map(hold => `hold ${hold.reason}: ${holdDeclineReason(hold)}`).join('; ') : 'no hold',
    'no operator hold',
  ].join('; ') };
}

export function ensureTtmOwnerSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS ttm_owner_state (
    repo TEXT NOT NULL, pr_number INTEGER NOT NULL, head_sha TEXT NOT NULL,
    review_suppressed INTEGER NOT NULL DEFAULT 0, review_reason TEXT,
    observed_at TEXT NOT NULL, ownerless_since TEXT,
    PRIMARY KEY (repo, pr_number)
  );
  CREATE TABLE IF NOT EXISTS ttm_stuck_pages (
    repo TEXT NOT NULL, pr_number INTEGER NOT NULL, head_sha TEXT NOT NULL,
    paged_at TEXT NOT NULL, PRIMARY KEY (repo, pr_number, head_sha)
  );`);
}

// Called only with decisions already made by the reviewer gates. A diagnostic
// write failure cannot change the caller's routing decision.
export function observeTtmReviewLane(db, { repo, prNumber, headSha, suppressed, reason = null,
  observedAt = new Date().toISOString() }, logger = console) {
  if (!headSha) return;
  try {
    ensureTtmOwnerSchema(db);
    db.prepare(`INSERT INTO ttm_owner_state
      (repo, pr_number, head_sha, review_suppressed, review_reason, observed_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(repo, pr_number) DO UPDATE SET
      ownerless_since = CASE WHEN head_sha = excluded.head_sha THEN ownerless_since ELSE NULL END,
      review_suppressed = CASE WHEN ? AND head_sha = excluded.head_sha THEN review_suppressed ELSE excluded.review_suppressed END,
      review_reason = CASE WHEN ? AND head_sha = excluded.head_sha THEN review_reason ELSE excluded.review_reason END,
      head_sha = excluded.head_sha, observed_at = excluded.observed_at`)
      .run(repo, prNumber, headSha, Number(Boolean(suppressed)), reason, observedAt, Number(suppressed === undefined), Number(suppressed === undefined));
  } catch (error) { logger.warn?.(`[ttm-owner] observation failed: ${error.message}`); }
}

function readState(db, row) {
  try { return db.prepare('SELECT * FROM ttm_owner_state WHERE repo = ? AND pr_number = ?').get(row.repo, row.prNumber); }
  catch (error) { if (/no such table/.test(error.message)) return null; throw error; }
}

export function readTtmOwnerEvidence(rootDir, row, state, { hqRoot } = {}) {
  const headSha = state?.head_sha || row.headSha;
  const identity = { repo: row.repo, prNumber: row.prNumber, headSha };
  const closers = [];
  const holds = [];
  if (rootDir && headSha) {
    const lease = readAmaCloserLease(rootDir, identity);
    const records = readAmaCloserDispatchRecordsForPR(rootDir, identity);
    // Dispatches remain keyed to the original head when the closer pushes.
    for (const record of records) {
      const linkedLease = readAmaCloserDispatchLease(rootDir, record);
      const live = launchRequestInFlight({ ok: true, row: { status: record.terminalLaunchStatus || record.lastObservedStatus } });
      closers.push({ live: live === true && linkedLease?.status !== 'terminal'
        || live !== false && ['pending', 'dispatched'].includes(linkedLease?.status) });
    }
    const currentRecord = records.find(record => record.headSha === headSha);
    if (!currentRecord || lease?.status === 'pending' && !lease.lrqId) {
      closers.push({ live: ['pending', 'dispatched'].includes(lease?.status) });
    }
    for (const { job } of listFollowUpJobsInDir(rootDir, 'inProgress', { ...identity, caseInsensitiveRepo: true })) {
      const worker = job.remediationWorker;
      if (worker) closers.push({ live: !job.completion && launchRequestInFlight({ ok: true,
        row: { status: worker.status || worker.lastObservedStatus || (worker.state === 'spawned' ? 'running' : worker.state) } }) === true });
    }
    const stop = readHammerStopForHead({ ...identity, hqRoot, reviewedSha: row.reviewedHeadSha });
    if (stop) {
      const hold = readHammerStopHoldForHead({ ...identity, rootDir, stopKey: stop.stopKey });
      if (hold && !hold.releasedAt) holds.push({ reason: stop.predicate,
        releaseCondition: hold.inputs ? 'hammer-inputs-change' : null,
        deadline: hold.retryAfter || hold.deadline, releasedAt: hold.releasedAt });
    }
  }
  if (row.quotaResetAt) holds.push({ reason: 'review quota reset', releaseCondition: 'quota-reset-time', deadline: row.quotaResetAt });
  return { labels: row.labels, closers, holds,
    review: { status: row.reviewStatus,
      live: row.reviewStatus === 'reviewing' && time(row.reviewerLeaseExpiresAt) > time(row.observedAt),
      suppressed: Boolean(state?.review_suppressed) || row.reviewerLeaseExpiredMinutes != null,
      reason: state?.review_reason || (row.reviewerLeaseExpiredMinutes != null ? 'reviewer-lease-expired' : null) } };
}

export function attachTtmOwnership(db, rows, { observedAt, rootDir, hqRoot, readEvidence = readTtmOwnerEvidence }) {
  return rows.map(row => {
    if (row.prState !== 'open' || row.mergedAt) return row;
    const state = readState(db, row);
    const headSha = state?.head_sha || row.headSha;
    let ownership;
    try {
      ownership = resolveTtmOwner(readEvidence(rootDir, { ...row, observedAt }, state, { hqRoot }), observedAt);
    } catch (error) {
      // One unreadable local record must not swallow every other PR's STUCK
      // flags. Unknown evidence cannot prove ownership; report the gap.
      ownership = isOperatorHeld(row.labels) ? { owner: 'operator-hold', reason: 'operator hold label' }
        : { owner: null, reason: `ownership evidence unreadable: ${error.code || error.name}` };
    }
    return { ...row, headSha, ownership,
      ownerlessSince: ownership.owner ? null : state?.ownerless_since || observedAt,
      ownerlessMinutes: !ownership.owner && state?.ownerless_since
        ? Math.max(0, (time(observedAt) - time(state.ownerless_since)) / 60_000) : 0 };
  });
}

export function syncTtmOwnership(db, rows, observedAt) {
  ensureTtmOwnerSchema(db);
  db.transaction(() => {
    for (const row of rows) {
      if (!row.ownership) continue;
      db.prepare(`INSERT INTO ttm_owner_state (repo, pr_number, head_sha, observed_at, ownerless_since)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(repo, pr_number) DO UPDATE SET ownerless_since = excluded.ownerless_since`)
        .run(row.repo, row.prNumber, row.headSha || '', observedAt, row.ownerlessSince);
    }
    db.prepare(`UPDATE ttm_owner_state SET ownerless_since = NULL WHERE NOT EXISTS
      (SELECT 1 FROM reviewed_prs r WHERE r.repo = ttm_owner_state.repo AND r.pr_number = ttm_owner_state.pr_number
       AND r.pr_state = 'open' AND r.merged_at IS NULL)`).run();
  })();
}

export async function pageTtmStuckFlags(db, flags, { deliverAlertFn, observedAt, logger = console }) {
  if (typeof deliverAlertFn !== 'function') return;
  const attempted = new Set();
  for (const flag of flags.filter(flag => flag.progressClass === 'stuck')) {
    const key = JSON.stringify([flag.repo, flag.prNumber]);
    if (attempted.has(key)) continue;
    attempted.add(key);
    const head = flag.details.headSha || '';
    if (db.prepare('SELECT 1 FROM ttm_stuck_pages WHERE repo = ? AND pr_number = ? AND head_sha = ?')
      .get(flag.repo, flag.prNumber, head)) continue;
    const siblings = flags.filter(other => other.progressClass === 'stuck' && other.repo === flag.repo && other.prNumber === flag.prNumber);
    try {
      await deliverAlertFn(`Adversarial-watcher: ${flag.repo}#${flag.prNumber} head=${head || 'unknown'} STUCK: `
        + siblings.map(other => `${other.flagKind}: ${other.details.stallReason}`).join('; '), {
        event: 'adversarial_review.pr_progress_stalled', payload: { repo: flag.repo, prNumber: flag.prNumber, headSha: head, flags: siblings },
      });
      db.prepare('INSERT OR IGNORE INTO ttm_stuck_pages (repo, pr_number, head_sha, paged_at) VALUES (?, ?, ?, ?)')
        .run(flag.repo, flag.prNumber, head, observedAt);
    } catch (error) { logger.error?.(`[ttm-owner] STUCK page failed: ${error.message}`); }
  }
}
