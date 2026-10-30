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

export function pendingExplicitReviewIntent(db, { repo, prNumber, headSha, now = new Date().toISOString() }) {
  return db.prepare(`SELECT * FROM explicit_review_intents WHERE repo = ? AND pr_number = ?
    AND head_sha = ? AND state = 'pending' AND expires_at > ?`)
    .get(repo, prNumber, headSha, now);
}

// Called inside requestReviewRereview's IMMEDIATE transaction. Concurrent
// requests coalesce onto the pending receipt without extending its deadline.
export function recordExplicitReviewIntent(db, { repo, prNumber, headSha, requestId, actor, requestedAt }) {
  db.prepare(`UPDATE explicit_review_intents SET state = 'refused', settled_at = ?,
    reason = 'reviewer-unavailable-before-dispatch-deadline'
    WHERE repo = ? AND pr_number = ? AND state = 'pending' AND expires_at <= ?`)
    .run(requestedAt, repo, prNumber, requestedAt);
  const existing = db.prepare(`SELECT * FROM explicit_review_intents WHERE repo = ?
    AND pr_number = ? AND head_sha = ? AND state = 'pending'`).get(repo, prNumber, headSha);
  const waitSeconds = resolveReviewMaxWaitSeconds('rereview') || REREVIEW_MAX_WAIT_SECONDS;
  const expiresAt = new Date(Date.parse(requestedAt) + waitSeconds * 1000).toISOString();
  db.prepare(`INSERT INTO explicit_review_intents
    (repo, pr_number, request_id, head_sha, actor, requested_at, expires_at, state, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(repo, prNumber, requestId, headSha, actor,
    requestedAt, existing?.expires_at || expiresAt, existing ? 'coalesced' : 'pending',
    existing ? `coalesced:${existing.request_id}` : null);
  return existing || findExplicitReviewRequest(db, { repo, prNumber, requestId });
}

export function settleExplicitReviewIntent(db, intent, reason, now = new Date().toISOString()) {
  return db.prepare(`UPDATE explicit_review_intents SET state = 'refused', settled_at = ?, reason = ?
    WHERE repo = ? AND pr_number = ? AND request_id = ? AND state = 'pending'`)
    .run(now, reason, intent.repo, intent.pr_number, intent.request_id).changes === 1;
}

// Consumption shares the reviewing claim's identity and an IMMEDIATE write
// lock. Capacity deferrals never reach this function and never spend intent.
export function consumeExplicitReviewIntent(db, intent, { headSha, sessionUuid, now = new Date().toISOString() }) {
  return db.prepare(`UPDATE explicit_review_intents SET state = 'consumed',
    settled_at = ?, reviewer_session_uuid = ?
    WHERE repo = ? AND pr_number = ? AND request_id = ? AND head_sha = ?
      AND state = 'pending' AND expires_at > ?
      AND EXISTS (SELECT 1 FROM reviewed_prs WHERE repo = ? AND pr_number = ?
        AND review_status = 'reviewing' AND reviewer_session_uuid = ?
        AND reviewer_head_sha = ?)`)
    .run(now, sessionUuid, intent.repo, intent.pr_number, intent.request_id, headSha, now,
      intent.repo, intent.pr_number, sessionUuid, headSha).changes === 1;
}

export function refuseFailedExplicitReviewDispatch(db, intent, sessionUuid, now = new Date().toISOString()) {
  return db.prepare(`UPDATE explicit_review_intents SET state = 'refused', settled_at = ?,
    reason = 'reviewer-dispatch-failed' WHERE repo = ? AND pr_number = ? AND request_id = ?
      AND state = 'consumed' AND reviewer_session_uuid = ?`)
    .run(now, intent.repo, intent.pr_number, intent.request_id, sessionUuid).changes === 1;
}

// Run before admission gates, including credential holds. Persist refusals
// before delivery, and retry failed notice delivery on subsequent ticks.
export async function reconcileExplicitReviewIntents(db, {
  repo, prNumber, headSha, terminal = false, now = new Date().toISOString(), notify, logger = console,
}) {
  db.prepare(`UPDATE explicit_review_intents SET state = 'refused', settled_at = ?,
    reason = CASE WHEN ? THEN 'pr-terminal' WHEN head_sha != ? THEN 'head-changed'
      ELSE 'reviewer-unavailable-before-dispatch-deadline' END
    WHERE repo = ? AND pr_number = ? AND state = 'pending'
      AND (? OR (? IS NOT NULL AND head_sha != ?) OR expires_at <= ?)`)
    .run(now, Number(terminal), headSha, repo, prNumber, Number(terminal), headSha, headSha, now);
  const notices = db.prepare(`SELECT * FROM explicit_review_intents WHERE repo = ? AND pr_number = ?
    AND state = 'refused' AND notified_at IS NULL`).all(repo, prNumber);
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
  return `### Re-review could not run\n\nThe accepted explicit re-review request for head `
    + `\`${intent.head_sha}\` could not dispatch: **${intent.reason}**. `
    + `Request: \`${String(intent.request_id).replace(/[<>\r\n`]/g, '')}\`. `
    + 'Apply `retrigger-review` again after resolving the blocker to request a fresh review.';
}
