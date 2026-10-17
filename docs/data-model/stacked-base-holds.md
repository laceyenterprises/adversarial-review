# Stacked base holds

Owner: AMA closure and remediation. Store: `data/stacked-base-holds/`.
Source of truth: `src/ama/stacked-base.mjs`.

Each filename is the SHA-256 of `lowercase-repository#PR`, plus `.json`.
`repo` and `prNumber` identify the PR. `reason` is `stacked-base-merged` or
`stacked-base-read-failed`; a successful live recheck clears it to null and
records `clearedAt` as an ISO timestamp. `commentedAt` records successful
retarget-comment delivery. That receipt survives head and base changes.

An exclusive `.lock` claim serializes comment delivery, with a 60-second stale
claim escape. The GitHub marker `<!-- ama:stacked-base-merged -->` recovers a
posted comment after a crash before the local receipt write. Failed comment
reads/posts retain the hold and retry delivery later. Successful rechecks do not
delete the comment receipt. The hold grants no retarget or force-push authority.
