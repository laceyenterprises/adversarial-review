-- Bounded auto-recovery of reviews that FAILED on an infrastructure-class
-- cause (cascade / reviewer-timeout / launchctl-bootstrap / oauth-broken spawn
-- failure) during a fleet-wide reviewer outage. The watcher re-queues such
-- reviews to 'pending' once the routing tier is healthy again, up to this
-- bounded count; a genuinely-persistent failure exhausts the bound and stays
-- terminal 'failed' (preserving the actionable operator alert).
-- See the 2026-06-13 codex-fleet-spawn incident: a spawn bug mislabeled as
-- oauth-broken left every reviewer-failed PR needing a manual retrigger-review.
ALTER TABLE reviewed_prs ADD COLUMN infra_auto_recover_attempts INTEGER NOT NULL DEFAULT 0;
