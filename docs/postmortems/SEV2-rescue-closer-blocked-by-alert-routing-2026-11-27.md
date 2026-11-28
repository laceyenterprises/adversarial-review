# SEV2 — missing alert routing blocked closer rescue

November 27, 2026 · RESCUEALERTENV-01

## Impact

The build session reported two PRs stuck at `dispatch-closer
(budget-exhausted-closure)` after approximately 13:00 UTC. Repeated
`hq merge-agent rescue --apply` attempts failed with `ALERT_TO must be
configured for alert delivery`, leaving the affected PRs without a closer
and blocking dependent work. The timeline comes from the incident report.
Reproduction used synthetic PR, head and lease records.

## Cause

The watcher’s launch script reads the configured 1Password reference at
startup and exports `ALERT_TO` into the watcher’s environment. Operator and
peer rescue shells often lack that variable.

During an exhausted-cycle closer dispatch, the executor can observe a
predecessor whose launch evidence is unavailable. Once the evidence wait
expires, it tries to page the operator before continuing custody
reconciliation. `deliverAlert` rejected for missing `ALERT_TO`. Closure-wait
refunded the page reservation, then propagated the exception into closer
admission. In a synthetic reproduction with an expired evidence wait on a
previous head, admission threw before dispatch. Stubbing a successful alert
sink in the same fixture yielded one acknowledged closer launch.

## Repair

Closer admission now records failed custody-evidence alerts in the dispatch
result and audit, refunds the page reservation and continues reconciling
ownership. An eligible closer still launches, while a live or uncertain owner
can still hold admission.

When `ALERT_TO` is absent, alert delivery tries the configured reference using
the watcher’s 1Password helper. The subprocess output stays private and the
lookup is bounded. Missing, unreadable or empty routing leaves the alert
undelivered with `alert-routing-unconfigured`.

## Verification

Offline fixtures cover the previously failing launch, the audit entry, the
page reservation refund, both reference aliases, preservation of explicit
`ALERT_TO` routing and omission of the destination from diagnostics.
[Commands and results](../changes/RESCUEALERTENV-01.md)
