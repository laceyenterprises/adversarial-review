# Review Body Persistence

`reviewer_passes` now carries four additive body-capture columns:

- `verdict`: normalized reviewer verdict for first-pass and rereview rows only.
- `body_md`: markdown captured from the matched GitHub review or remediation comment.
- `gh_comment_id`: GitHub node id for the matched review/comment artifact. Non-null values are unique.
- `body_captured_at`: ISO-8601 UTC timestamp for when the scraper captured `body_md`.

`pr_merge_closeouts` stores one row per merged `(repo, pr_number)` with:

- `repo`, `pr_number`, `created_at`
- `closeout_body_md`, `closeout_authors_json`, `closeout_posted_at`, `body_captured_at`
- `scrape_last_checked_at`, `empty_confirmed_at`, `merged_at`, `gh_artifact_refs`

`closeout_authors_json` and `gh_artifact_refs` are JSON arrays when present. `empty_confirmed_at` is the terminal no-body outcome and is mutually exclusive with `closeout_body_md`.

Remediation verdicts stay `NULL` by design. Only `pass_kind IN ('first-pass', 'rereview')` rows carry a normalized reviewer verdict. `pass_kind = 'remediation'` rows capture the public reply body and GitHub artifact id, but `verdict IS NULL`.

Join merged PRs to closeouts with:

```sql
SELECT p.pr_number, p.linear_ticket, c.closeout_body_md, c.empty_confirmed_at
FROM reviewed_prs p
LEFT JOIN pr_merge_closeouts c USING (repo, pr_number)
WHERE p.pr_state = 'merged';
```

Useful postmortem queries:

```sql
SELECT pr_number
FROM reviewer_passes
WHERE pass_kind IN ('first-pass', 'rereview')
  AND body_md LIKE '%race%';
```

```sql
SELECT review.pass_id AS review_pass_id,
       review.attempt_number,
       review.body_md AS review_body_md,
       remediation.pass_id AS remediation_pass_id,
       remediation.body_md AS remediation_body_md
FROM reviewer_passes review
LEFT JOIN reviewer_passes remediation
  ON remediation.repo = review.repo
 AND remediation.pr_number = review.pr_number
 AND remediation.attempt_number = review.attempt_number
 AND remediation.pass_kind = 'remediation'
WHERE review.repo = ?
  AND review.pr_number = ?
  AND review.pass_kind IN ('first-pass', 'rereview')
ORDER BY review.attempt_number, review.pass_id;
```

```sql
SELECT review.repo, review.pr_number, review.attempt_number
FROM reviewer_passes review
LEFT JOIN reviewer_passes remediation
  ON remediation.repo = review.repo
 AND remediation.pr_number = review.pr_number
 AND remediation.attempt_number = review.attempt_number
 AND remediation.pass_kind = 'remediation'
LEFT JOIN pr_merge_closeouts closeout
  ON closeout.repo = review.repo
 AND closeout.pr_number = review.pr_number
WHERE review.pass_kind IN ('first-pass', 'rereview')
  AND review.verdict = 'request-changes'
  AND remediation.pass_id IS NULL
  AND closeout.closeout_body_md IS NULL;
```

```sql
SELECT closeout_body_md
FROM pr_merge_closeouts
WHERE repo = ?
  AND pr_number = ?;
```

```sql
SELECT SUM(CASE WHEN max_attempt = 2 THEN 1 ELSE 0 END) AS converged_in_one_rereview,
       COUNT(*) AS total_request_changes_prs
FROM (
  SELECT repo, pr_number, MAX(attempt_number) AS max_attempt
  FROM reviewer_passes
  WHERE pass_kind IN ('first-pass', 'rereview')
    AND verdict = 'request-changes'
  GROUP BY repo, pr_number
);
```

Backfill is handled by `scripts/backfill-review-bodies.mjs`. It defaults to `--dry-run`; use `--apply` to write. Re-running is safe: pass-body rows with `body_md IS NOT NULL` are skipped, and empty closeout checks never erase a previously captured closeout body. Operators can redirect the structured stdout logs to a file when running against a copied DB, for example:

```sh
node scripts/backfill-review-bodies.mjs --dry-run --pass all > backfill-review-bodies.log
```
