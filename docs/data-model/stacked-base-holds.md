# Stacked base holds

Owner: AMA closure and remediation. Store: `data/stacked-base-holds/`.
Source of truth: `src/ama/stacked-base.mjs`.

Each filename is the SHA-256 of `lowercase-repository#PR`, plus `.json`.
`repo` and `prNumber` identify the PR. `reason` is `stacked-base-merged` or
`stacked-base-read-failed`; a successful live recheck clears it to null and
records `clearedAt` as an ISO timestamp. `commentedAt` records successful
retarget-comment delivery. That receipt survives head and base changes.

An exclusive `.lock` claim serializes comment delivery, with a 300-second stale
claim escape covering bounded API retries. Each API call allows two transient
retries with 500/1000 ms backoff and a 15-second per-attempt timeout. Before
retrying a POST, a bounded comment-history probe checks whether GitHub already
accepted it; an unreadable receipt never authorizes another POST. Permanent
errors fail immediately. An omitted root directory defaults to the current
working directory for both hold writes and successful recheck cleanup.
The GitHub marker `<!-- ama:stacked-base-merged -->` recovers a
posted comment after a crash before the local receipt write. Failed comment
reads/posts retain the hold and retry delivery later. Successful rechecks do not
delete the comment receipt. The hold grants no retarget or force-push authority.
Directory creation or receipt-write failures retain the in-memory hold result;
initial persistence failures log a warning and defer comment delivery until a
later observation can persist safely.
