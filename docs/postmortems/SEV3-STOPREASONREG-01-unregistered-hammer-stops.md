# SEV3 — unregistered hammer stops caused futile closer retries

Ticket: STOPREASONREG-01. Report date: 2026-11-14.
Status: source correction and offline regression coverage; deployed recovery
has not been verified. This public report uses no production identifiers.

## Impact and evidence

The supplied incident evidence reports four conflict-resolver failures on one
persistently conflicting PR across November 14–15, with one
`retryable-controller-shell-ended` and at least three
`retryable-stop-reason-unregistered` outcomes. Earlier November 13 examples
included checkout failure while a builder worktree held the branch and a
head-change refusal. The ticket describes at least four instances across
reasons since November 13; a fleet-wide count is not established.
These observations come from the dispatch brief; this change does not access
production logs or claim an independent live reproduction.

Local source inspection confirms the causal gap: conflict repair emits
`conflict-resolver-failed` through `ham_conflict_stop`, while the registry
omitted it. The terminal audit substituted `stop-reason-unregistered` with
closer origin, which `hammerPhaseAttempt` projects to `deferred`. Thus the
failed resolution became a retryable closer fault, even though the same head
and base still contained the conflict. Merge eligibility continued to refuse
unsafe merges; the observed harm was repeated work and misleading health data.

## Root cause and correction

The emitter and the origin table evolved independently. The old sync test
read literal phase assignments and selected JavaScript calls, but missed
shell stop-helper calls, merge audit reasons, and generated helper-step codes.
The extended ordinary unit test inspects those sinks, helper step names,
procedure step names, and forwarded terminal review-proof reasons. Success
phases are excluded. Controller process-registration diagnostics are a separate
vocabulary; only their terminal-audit emissions are stop-origin inputs.

The registry now includes every enumerated missing stop. Unresolved conflict,
source/head custody, failed conflict replay/submodule repair, validation and
live merge fences are world conditions: a generic closer retry supplies no
new resolution or authority. Missing private state, helper setup, unpublished
audit and malformed commit-message construction are closer faults. Failed PR,
Git object or review-evidence reads, remote dismissal, and helper deadlines
are infrastructure failures that may recover. Existing origins remain intact.

Unknown runtime codes still become `stop-reason-unregistered`; optional
`originalReason` preserves the validated input in the durable attempt.
Existing `reasonDetail` remains available. No historical record is rewritten.

## Related head-change observation

`head-changed` was already registered as world. The separate closing-status /
reconciliation path can preserve a generic reason in `reasonDetail` after a
head refusal. CLOSERHEADPIN-01 already covers that precedence and mid-run
supersession family in `test/closerheadpin-01.test.mjs`. Adding another
`head-changed` registration would not fix that path; it is outside this change.

## Regression evidence and recovery

Synthetic tests prove conflict-resolver failure records world origin and
`failed-without-merge` without closer correction, unknown codes retain their
original input, and current stop emitters remain registered. The existing
origin table, correction, projection and refund tests run in the same file.
See the [change note](../changes/STOPREASONREG-01.md) for validation results.
The memory search was available and returned no matching records; supplied
hardening history informed the procedure-to-script seam coverage.

No live changes, new CI jobs, gates or override labels are included. After
normal review and deployment, an organic unresolved conflict should record
its world reason rather than an unregistered closer deferral. This PR neither
replays a production closer nor certifies that deployment has occurred.
