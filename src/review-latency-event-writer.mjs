const REVIEW_LATENCY_EVENT_TYPES = Object.freeze(new Set([
  'pr_observed', 'queue_eligible', 'row_claimed', 'reviewer_started',
  'reviewer_first_output', 'reviewer_post_attempt', 'reviewer_post_success',
  'reviewer_post_failure', 'reviewer_reaped', 'reviewer_reattached',
  'settlement_completed', 'follow_up_created', 'clean_verdict', 'rereview_wake',
  'hammer_wake', 'merge_completed', 'deploy_observed', 'smoke_result',
  'cache_hit', 'cache_miss', 'cache_stale', 'cache_coalesced',
  'cache_invalidated', 'fallback_route', 'review_mode_selected',
]));

const REVIEW_LATENCY_EVENT_STAGE_BY_TYPE = Object.freeze({
  pr_observed: 'watcher', queue_eligible: 'admission', row_claimed: 'admission',
  reviewer_started: 'reviewer-runtime', reviewer_first_output: 'reviewer-runtime',
  reviewer_post_attempt: 'reviewer-runtime', reviewer_post_success: 'reviewer-runtime',
  reviewer_post_failure: 'reviewer-runtime', reviewer_reaped: 'reviewer-recovery',
  reviewer_reattached: 'reviewer-recovery', settlement_completed: 'watcher',
  follow_up_created: 'follow-up', clean_verdict: 'merge', rereview_wake: 'rereview',
  hammer_wake: 'merge', merge_completed: 'merge', deploy_observed: 'deploy', smoke_result: 'smoke',
  cache_hit: 'diagnostics', cache_miss: 'diagnostics', cache_stale: 'diagnostics',
  cache_coalesced: 'diagnostics', cache_invalidated: 'diagnostics',
  fallback_route: 'diagnostics', review_mode_selected: 'diagnostics',
});

function recordReviewLatencyEvent(db, {
  repo = null, prNumber = null, domainId = null, subjectExternalId = null,
  revisionRef = null, eventType, stage = null, at = new Date().toISOString(),
  source = 'unknown', sourceRef = null, idempotencyKey = null, reason = null, payload = {},
} = {}) {
  const normalizedType = String(eventType || '').trim();
  if (!REVIEW_LATENCY_EVENT_TYPES.has(normalizedType)) {
    throw new TypeError(`Invalid review latency event_type: ${eventType}`);
  }
  const normalizedAt = at instanceof Date ? at.toISOString() : new Date(at).toISOString();
  const normalizedRepo = repo ? String(repo) : null;
  const normalizedPrNumber = prNumber == null ? null : Number(prNumber);
  const normalizedPayload = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? JSON.stringify(payload)
    : '{}';
  db.prepare(
    `INSERT OR IGNORE INTO review_latency_events (
       repo, pr_number, domain_id, subject_external_id, revision_ref, event_type,
       stage, at, source, source_ref, idempotency_key, reason, payload_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    normalizedRepo, Number.isInteger(normalizedPrNumber) ? normalizedPrNumber : null,
    domainId || null, subjectExternalId || null, revisionRef || null, normalizedType,
    String(stage || REVIEW_LATENCY_EVENT_STAGE_BY_TYPE[normalizedType] || 'unknown'),
    normalizedAt, String(source || 'unknown'), sourceRef || null, idempotencyKey || null,
    reason || null, normalizedPayload
  );
  return db.prepare(
    `SELECT * FROM review_latency_events
      WHERE event_type = ? AND ((? IS NOT NULL AND idempotency_key = ?) OR
        (? IS NULL AND repo IS ? AND pr_number IS ? AND domain_id IS ?
          AND subject_external_id IS ? AND at = ?))
      ORDER BY event_id DESC LIMIT 1`
  ).get(
    normalizedType, idempotencyKey || null, idempotencyKey || null, idempotencyKey || null,
    normalizedRepo, Number.isInteger(normalizedPrNumber) ? normalizedPrNumber : null,
    domainId || null, subjectExternalId || null, normalizedAt
  ) || null;
}

export { recordReviewLatencyEvent };
