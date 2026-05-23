ALTER TABLE reviewed_prs ADD COLUMN fast_merge_authorized_head_sha TEXT;

/*
  pr_state is convention-only TEXT in reviewed_prs; there is no CHECK constraint
  to expand. Fast-merge lane states introduced by FML-01/FML-02 are defined in
  docs/STATE-MACHINE.md#3-fast-merge-skip-lane:

  - fast_merge_skipped: watcher skipped first-pass adversarial review because an
    allowlisted fast-merge label authorized the current PR head and no later
    synchronize / force-push event superseded that label event. Same-timestamp
    synchronize events are redundant only when they name the same SHA.
  - fast_merge_merged: merge-agent completed the authorized fast-merge.
  - fast_merge_closed: merge-agent closed the PR without merging.
  - fast_merge_blocked: merge-agent refused/blocked the fast-merge path.

  Fast-merge audit retry columns are added by ensureReviewStateSchema because
  some live DBs may already have recorded this migration before the retry
  sentinel was introduced on the PR branch.
*/
