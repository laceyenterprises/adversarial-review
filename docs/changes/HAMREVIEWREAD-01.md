# HAMREVIEWREAD-01

## Summary

Closers fetch and display complete reviews through one canonical helper instead
of composing a review-read command. Local shell construction errors defer for
retry rather than creating a terminal `review-read-failed` stop.

## Interface changes

`bin/hammer-pr-read.mjs OWNER/REPO PR --full-review` writes
`$HAM_RUN_DIR/reviews-full.json` atomically and prints the same complete JSON.
It reuses the existing paginated, metered, load-aware reader without check reads.
The prompt requires it for both full final reviews and truncated context.

Read-only syntax diagnostics and command-not-found errors get at most two
attempts and then return 75 with `hammer-command-error`. The controller catches
script parser errors before execution. This reason uses the existing retryable
closer outcome contract; real read failures and merge predicates are unchanged.
The companion dispatcher change fails a `failed-without-merge` audit through the
existing `no_work_done` failure class.

## Verification

Scoped offline tests cover pagination and complete bodies, prompt helper usage,
unquoted Python passed to Bash eval, bounded command-error retries, missing
executables, corrected reads, real read refusals and controller preflight.
The helper-step file passes 21 tests, PR-read passes 19, and controller passes
110 with one platform-specific skip. Each file ran separately through
`cwp_dispatch.worker_validation` with a 600-second bound and netguard.
`npm run lint` passes with zero errors (152 existing warnings),
`npm run typecheck:contracts` passes, and the offline research-finding demo
passes with three byte-stable deliveries. The prompt remains within its
unchanged 60 KiB rendered budget. The full suite was not run on the host,
as required by the ticket.

## Activation check

After normal submodule float and the follow-up/watcher and dispatcher reloads,
SRE passively verifies that clean PRs produce no new
`hammer_stop_hold_released` events with predicate `review-read-failed`, and
closer launches stopping without merge on `failed-without-merge` audits show
`status=failed` and a failure class in `launch_requests`.
Retain deployed revisions and natural launch/event receipts. Offline tests do
not establish activation. No live changes are part of this patch.
