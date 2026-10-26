# Stacked base holds

Owner: AMA closure and remediation. Store: `data/stacked-base-holds/`.
Source of truth: `src/ama/stacked-base.mjs`.

Each filename is the SHA-256 of `lowercase-repository#PR`, plus `.json`.
`repo` and `prNumber` identify the PR. `reason` is `stacked-base-merged` or
`stacked-base-read-failed`; a successful recheck clears it to null and
records `clearedAt` as an ISO timestamp. Read failures also store `readError` as
`timeout`, `auth`, `5xx`, `parse`, or `unknown`; success clears that field to null.
A new read-failure hold or changed error class logs one timestamped warning
after successful receipt persistence, never raw errors, credentials or response
bodies. Unchanged persisted holds do
not repeat the warning; clearing the hold re-arms it. An omitted `readError` in
a comment receipt is equivalent to null and does not trigger a rewrite. `auth`
means a typed auth outage or HTTP 401; HTTP 403/429 use `unknown`. HTTP 5xx, including 504, takes
precedence over free-text timeout matching. `commentedAt` records successful
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

`inspectStackedBase` and `guardStackedBase` accept optional `baseBranch` and
`defaultBranch`. Matching nonempty strings, with the base supplied from live PR
evidence, authorize an immediate success without a GitHub read; successful guard calls still clear the local hold.
Successful PR reads cache the repository default for 60 seconds, scoped to the
injected transport and repository. A caller supplying only the base can use
that cached default; an absent or expired default falls back to the existing
live read. A caller without a base always reads. Non-default bases retain the
live PR read, bounded parent-history search and existing comment/receipt flow.
Watcher candidates carry the learned default through closer dispatch and daemon
merge admission; remediation forwards only the live base/default pair read
during hydration, never a persisted job base. Unhydrated jobs retain the live
read even with a cached default. The daemon and closer inline merge callbacks
omit both fields to force a live base read immediately before merging.


HOLDCONTRACT-01 adds the validated shared `holdVersion: 1` contract. Merged-parent
holds name `owner: operator`, await a successful stacked-base inspection and use
an immediate deadline with the existing retarget-comment marker as `onDeadline`.
Read failures name `closure-recovery` and retain the one-minute retry predicate
and deadline. Legacy readers retain comment receipts and normalize their owner
and horizon. The poll sweep evaluates discovered open subjects without a new API
read; the guard still owns authoritative inspection and comment delivery. See the
[shared closer hold contract](closer-holds.md).
