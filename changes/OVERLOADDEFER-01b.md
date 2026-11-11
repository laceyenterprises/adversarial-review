# OVERLOADDEFER-01b

Supersedes PR 1814. The watcher owns launch-less overload rescue receipts at
startup and every 30 seconds. Each tick scans at most 100 directory entries
asynchronously and drains queued due receipts before advancing its cursor.
One bounded child submits only PR identity to the companion retry-only rescue
entrypoint, which rechecks live head, review, holds and writer custody.
Deploy the companion before this retry owner.

Live AMA enablement/execution switches gate retries. Unchanged successful
rescues and failed children back off per PR from 30 seconds to 30 minutes.
Removed or ineligible receipts after success count as progress. Receipts
untouched for 24 hours are skipped across restarts; fresh writes restore
eligibility. Queued records are revalidated and broken directory cursors reopen.
Signal cleanup shuts down the hammer queue and aborts rescue before reviewer
cleanup, without waiting on rescue. Child pipe settlement is bounded and all
process exits synchronously abort rescue.

Helper exhaustion pages once per PR/head, archives the receipt, and releases
the overload hold to ordinary capped closer selection. Only the same job within
30 minutes of the original exhaustion inherits exhaustion without a refund.
Repeated releases do not extend that incident window. A new job or expired
window gets a fresh bounded cycle within existing lifetime caps. Main's
OVERLOADDEFER-01c true-overload threshold remains authoritative, as do head,
lease, strict review, attestation and terminal-state predicates.

The closure runbook conflict retains both main's lease-liveness/terminal-closeout
section and the overload rescue section. Main's other changes are preserved.
The final predecessor head already repaired its seven review findings; this
rewrite additionally anchors the exhaustion window through repeated release
and follows the dispatch's explicit `changes/` fragment location. Links and
the operator plan follow that location despite the review's canonical-path
recommendation. Generated indexes are unchanged.

After the normal AR float and watcher/follow-up restart, SRE retains deployed
SHAs and PID start times and observes organic receipt progress within a directory
rotation including queued children, bounded execution and applicable backoff.
Grok remediation routing stays opt-in and disabled by default; no remediator-grok
or hammer-grok vault entry is added. The closer stays refused under the narrowed
scope. This PR performs no live repair, configuration write or restart.

Validation for this rewrite: 529 tests passed across the eight scoped Node
files (overload deferral 8, rescue retry 14, closer retry cap 199, GitHub API 77,
watcher fast merge 20, timeout handoff 35, signal cleanup 8, claim loop 168).
Each file ran serially under netguard through runtime Python's worker validation
supervisor with an absolute 600-second process-group deadline. ESLint/formatter
reported zero errors, contract typechecking and the 93-entry data-model catalog
validation passed, and the offline research walkthrough preserved transcript
byte equivalence. The plain-shell CI mirror passed both selected fast checks;
the full suite remains deferred to hosted CI. No full worker-pool suite ran.
