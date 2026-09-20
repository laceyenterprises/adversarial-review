-- RPL-02: reviewer capacity covers model/post execution, not downstream settlement.
ALTER TABLE reviewed_prs ADD COLUMN reviewer_admission_state TEXT NOT NULL DEFAULT 'released';
ALTER TABLE reviewed_prs ADD COLUMN review_settlement_status TEXT NOT NULL DEFAULT 'completed';
ALTER TABLE reviewed_prs ADD COLUMN review_settlement_started_at TEXT;
ALTER TABLE reviewed_prs ADD COLUMN review_settlement_completed_at TEXT;

UPDATE reviewed_prs
   SET reviewer_admission_state = CASE WHEN review_status = 'reviewing' THEN 'active' ELSE 'released' END,
       review_settlement_status = CASE
         WHEN review_status = 'reviewing' THEN 'pending'
         WHEN review_status IN ('pending', 'pending-upstream') AND failed_at IS NOT NULL THEN 'retry'
         WHEN review_status IN ('failed', 'failed-orphan') THEN 'failed'
         ELSE 'completed'
       END,
       review_settlement_started_at = CASE
         WHEN review_status = 'reviewing' THEN COALESCE(reviewer_started_at, last_attempted_at)
         ELSE NULL
       END,
       review_settlement_completed_at = CASE
         WHEN review_status = 'reviewing' THEN NULL
         ELSE COALESCE(posted_at, failed_at, last_attempted_at)
       END;
