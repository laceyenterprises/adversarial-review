import { loadAwareTimeoutSeconds } from './load-aware-timeout.mjs';
import { resolveReviewMaxWaitSeconds, REREVIEW_MAX_WAIT_SECONDS } from './review-queue-depth.mjs';

// RETRIGGERDEDUP-01: request receipts live beside review rows, never in a
// process-local flag or in the human-readable rereview_reason.
export function ensureExplicitReviewIntentSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS explicit_review_intents (
    repo TEXT NOT NULL, pr_number INTEGER NOT NULL, request_id TEXT NOT NULL,
    head_sha TEXT NOT NULL, actor TEXT NOT NULL, requested_at TEXT NOT NULL,
    expires_at TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
    settled_at TEXT, reason TEXT, reviewer_session_uuid TEXT, notified_at TEXT,
    PRIMARY KEY (repo, pr_number, request_id)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS explicit_review_intent_pending_head
    ON explicit_review_intents(repo, pr_number, head_sha) WHERE state = 'pending'`);
}

export function findExplicitReviewRequest(db, { repo, prNumber, requestId }) {
  return db.prepare(`SELECT * FROM explicit_review_intents
    WHERE repo = ? AND pr_number = ? AND request_id = ?`).get(repo, prNumber, requestId);
}

export function pendingExplicitReviewIntent(db, { repo, prNumber, headSha }) {
  return db.prepare(`SELECT * FROM explicit_review_intents WHERE repo = ? AND pr_number = ?
    AND head_sha = ? AND state = 'pending'`)
    .get(repo, prNumber, headSha);
}

// Called inside requestReviewRereview's IMMEDIATE transaction. Concurrent
// requests coalesce onto the pending receipt without changing its wait observation.
export function recordExplicitReviewIntent(db, {
  repo, prNumber, headSha, requestId, actor, requestedAt, waitOptions = {},
}) {
  const existing = db.prepare(`SELECT * FROM explicit_review_intents WHERE repo = ?
    AND pr_number = ? AND head_sha = ? AND state = 'pending'`).get(repo, prNumber, headSha);
  // Retain the legacy column as an informational threshold, never an expiry.
  const waitSeconds = loadAwareTimeoutSeconds(
    resolveReviewMaxWaitSeconds('rereview') || REREVIEW_MAX_WAIT_SECONDS,
    { ...waitOptions, maxSeconds: Infinity });
  const expiresAt = new Date(Date.parse(requestedAt) + waitSeconds * 1000).toISOString();
  db.prepare(`INSERT INTO explicit_review_intents
    (repo, pr_number, request_id, head_sha, actor, requested_at, expires_at, state, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(repo, prNumber, requestId, headSha, actor,
    requestedAt, existing?.expires_at || expiresAt, existing ? 'coalesced' : 'pending',
    existing ? `coalesced:${existing.request_id}` : null);
  return existing || findExplicitReviewRequest(db, { repo, prNumber, requestId });
}

export function settleExplicitReviewIntent(db, intent, reason, now = new Date().toISOString()) {
  return db.prepare(`UPDATE explicit_review_intents SET state = 'refused', settled_at = ?, notified_at = NULL, reason = ?
    WHERE repo = ? AND pr_number = ? AND request_id = ? AND state = 'pending'`)
    .run(now, reason, intent.repo, intent.pr_number, intent.request_id).changes === 1;
}

// Consumption shares the reviewing claim's identity and an IMMEDIATE write
// lock. Capacity deferrals never reach this function and never spend intent.
export function consumeExplicitReviewIntent(db, intent, { headSha, sessionUuid, now = new Date().toISOString() }) {
  return db.prepare(`UPDATE explicit_review_intents SET state = 'consumed',
    settled_at = ?, reviewer_session_uuid = ?
    WHERE repo = ? AND pr_number = ? AND request_id = ? AND head_sha = ?
      AND state = 'pending'
      AND EXISTS (SELECT 1 FROM reviewed_prs WHERE repo = ? AND pr_number = ?
        AND review_status = 'reviewing' AND reviewer_session_uuid = ?
        AND reviewer_head_sha = ?)`)
    .run(now, sessionUuid, intent.repo, intent.pr_number, intent.request_id, headSha,
      intent.repo, intent.pr_number, sessionUuid, headSha).changes === 1;
}

export function refuseFailedExplicitReviewDispatch(db, intent, sessionUuid, now = new Date().toISOString()) {
  return db.prepare(`UPDATE explicit_review_intents SET state = 'refused', settled_at = ?, notified_at = NULL,
    reason = 'reviewer-dispatch-failed' WHERE repo = ? AND pr_number = ? AND request_id = ?
      AND state = 'consumed' AND reviewer_session_uuid = ?`)
    .run(now, intent.repo, intent.pr_number, intent.request_id, sessionUuid).changes === 1;
}

// Only a launch positively known not to have started may return its receipt.
// The session CAS prevents an old launch from rearming a newer review.
export function requeueUnstartedExplicitReviewDispatch(db, intent, sessionUuid) {
  return db.prepare(`UPDATE explicit_review_intents SET state = 'pending',
    settled_at = NULL, reviewer_session_uuid = NULL, reason = NULL
    WHERE repo = ? AND pr_number = ? AND request_id = ?
      AND state = 'consumed' AND reviewer_session_uuid = ?
      AND EXISTS (SELECT 1 FROM reviewed_prs WHERE repo = ? AND pr_number = ?
        AND review_status = 'reviewing' AND reviewer_session_uuid = ?
        AND reviewer_head_sha = ?)`)
    .run(intent.repo, intent.pr_number, intent.request_id, sessionUuid,
      intent.repo, intent.pr_number, sessionUuid, intent.head_sha).changes === 1;
}

// Run before admission gates, including credential holds. Long waits are
// informational; only head movement or terminal state settles pending work.
export async function reconcileExplicitReviewIntents(db, {
  repo, prNumber, headSha, terminal = false, now = new Date().toISOString(), notify, logger = console,
}) {
  db.prepare(`UPDATE explicit_review_intents SET state = 'refused', settled_at = ?, notified_at = NULL,
    reason = CASE WHEN ? THEN 'pr-terminal' WHEN head_sha != ? THEN 'head-changed'
      ELSE reason END
    WHERE repo = ? AND pr_number = ? AND state = 'pending'
      AND (? OR (? IS NOT NULL AND head_sha != ?))`)
    .run(now, Number(terminal), headSha, repo, prNumber, Number(terminal), headSha, headSha);
  const notices = db.prepare(`SELECT * FROM explicit_review_intents WHERE repo = ? AND pr_number = ?
    AND (state = 'refused' OR (state = 'pending' AND expires_at <= ?))
    AND notified_at IS NULL`).all(repo, prNumber, now);
  for (const intent of notices) {
    try {
      await notify(intent);
      db.prepare(`UPDATE explicit_review_intents SET notified_at = ?
        WHERE repo = ? AND pr_number = ? AND request_id = ? AND notified_at IS NULL`)
        .run(now, repo, prNumber, intent.request_id);
    } catch (error) {
      logger.warn?.(`[watcher] explicit re-review notice deferred for ${repo}#${prNumber}: ${error.message}`);
    }
  }
}

export function explicitReviewRefusalBody(intent) {
  if (intent.state === 'pending') {
    return `### Re-review queued\n\nRe-review queued for head \`${intent.head_sha}\`; `
      + `reviewer capacity busy since ${intent.requested_at}. The watcher will retry automatically.`;
  }
  return `### Re-review could not run\n\nThe accepted explicit re-review request for head `
    + `\`${intent.head_sha}\` could not dispatch: **${intent.reason}**. `
    + `Request: \`${String(intent.request_id).replace(/[<>\r\n`]/g, '')}\`. `
    + 'This request has settled; the watcher continues to track the PR lifecycle.';
}
