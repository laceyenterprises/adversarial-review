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

Final comment-only remediation preserves actionable failure diagnostics:
helper retries retain child stderr and now emit direct spawn errors with the
missing executable name; controller syntax preflight emits Bash's captured
parser output before returning 75. Retry budgets, lifecycle states, durable
store shapes and smoke promises remain unchanged.

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

Final-round targeted validation adds assertions for diagnostics on both helper
attempts (eval syntax errors, unexpected EOF, command-not-found and direct
ENOENT), and for the controller's preflight line number and parser token.
`node --test test/hammer-helper-step.test.mjs` passes all 21 tests.
`node --test --test-name-pattern='controller rejects a malformed' test/hammer-controller.test.mjs`
passes the preflight regression. Both ran offline through `bin/run-bounded.sh`
with 60-second limits. `npm run lint` passes (zero errors, 152 existing
warnings), `npm run typecheck:contracts` passes, the bounded offline
`bash demo/research-finding-walkthrough.sh` passes with three byte-stable
deliveries, and `git diff --check` passes. The full local suite was not run.

The PR-update repairs the stale REVIEWSIMPLE-01 template expectation: either
truncation flag must lead to the canonical full-review helper. Advice remains
separate from findings and verdict authority, with its existing audit reporting.
No runtime interface or CI configuration changes are part of this update.
`test/simplicity-note-prompts.test.mjs` passes 6 tests,
`test/ama-hammer-merge-protocol-prompt.test.mjs` passes 45,
`test/hammer-pr-read.test.mjs` passes 19,
`test/hammertrim-contract.test.mjs` passes 53, and
`test/merge-agent-doc-contract.test.mjs` passes 4. Each file ran individually
through `cwp_dispatch.worker_validation` with a 600-second limit and netguard.
Changed-file ESLint, repository lint (zero errors, 152 existing warnings),
contract typechecking and the offline research-finding demo also pass.
The reported Node 22 CI timeout after 900 seconds is tracked separately as
ARSUITETIMEOUT-01; the suite cap and CI jobs are unchanged.

## Activation check

After normal submodule float and the follow-up/watcher and dispatcher reloads,
SRE passively verifies that clean PRs produce no new
`hammer_stop_hold_released` events with predicate `review-read-failed`, and
closer launches stopping without merge on `failed-without-merge` audits show
`status=failed` and a failure class in `launch_requests`.
Retain deployed revisions and natural launch/event receipts. Offline tests do
not establish activation. No live changes are part of this patch.
