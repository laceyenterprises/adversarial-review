# AMA dispatch configuration receipts

Owner: AMA closer dispatch. Store: `data/ama-dispatch-configuration/`.
Source of truth: `src/ama/dispatch-configuration-refusal.mjs`.

Each filename is the SHA-256 of the lowercase repository full name, plus `.json`.
`repo` identifies the repository, `refusal` is `repo_unregistered`, and
`alertedAt` is the supplied dispatch timestamp, falling back to the current ISO
timestamp when none is supplied, so a successful page always has a durable
delivery marker. A companion `.lock`
file serializes delivery across PRs and processes; claims older than 60 seconds
can be reclaimed. Failed delivery leaves no receipt and retries on a later walk.
A process-local delivery set also prevents repeated paging if receipt writes fail.
Receipts persist across successful dispatches to retain the once-per-repository
page contract. Per-PR blockers clear independently on successful dispatch.
No repository registration or other host configuration is performed here.
