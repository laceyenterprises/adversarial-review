# SEV2 — Review CLI resolution failure falsely isolated healthy reviewer capacity

Ticket: REVIEWCLIJSON-01. Disposition: source fix with offline regression tests;
normal deployment and runtime observation remain required. This report uses
synthetic descriptions only and contains no captured service output.

## Impact and detection

Repeated executable-resolution failures were reported across multiple pull
requests. A healthy reviewer identity was treated as authentication-broken,
reducing a small reviewer lane's available capacity and delaying queued reviews.
The affected PR entered infrastructure recovery after its first failure, while
fallback could find no healthy alternative. Service failure-class and identity
isolation messages exposed the mismatch. This is a SEV2 capacity-loss incident;
there is no evidence here of an incorrect review verdict or merge authorization.

## Causal sequence

1. Before reviewer execution, the client requested a protocol-v1 executable
   resolution from the installed CLI.
2. Resolution failed transiently. Whole-stdout JSON parsing and a fixed
   ten-second deadline offered no tolerance for banners or host contention.
3. The path-preflight wrapper defaulted to `oauth-broken`, even though no
   reviewer authentication had run. The identity lease wrapper isolated the
   seat, and settlement recorded authentication/infrastructure recovery.
4. A subsequent resolution succeeded on the same host. Recovery of executable
   selection did not establish that credentials had ever been faulty.

The precise bytes responsible for the reported parse failures are unknown.
Non-protocol banners are a reproduced failure mode, not a claim about the
unretained incident stdout. Existing tests explicitly expected path-resolution
failure to be authentication failure, so they preserved the incorrect contract.

## Correction and regression evidence

Resolution now has the distinct `cli-resolution-transient` class. Typed errors,
serialized resolver evidence and sanitized error messages retain that class
through discovery, runtime classification, cascade persistence and health.
Reviewer identity wrappers, including sibling security-review lease paths, do
not isolate a seat for it. Genuine reviewer authentication failure remains
`oauth-broken`; the new class never contributes to credential-outage accounting.

Both resolver clients retry once using the shared load-aware timeout helper.
Strict protocol validation remains required. One protocol line with non-JSON
chatter is accepted; multiple JSON responses are refused. Invalid-JSON logs
record only byte length, line count and protocol-line presence.

Before the existing five-consecutive-transient threshold, settlement releases
the matching claim to `pending` without charging review or infrastructure
recovery budgets. Durable cascade backoff still gates retries. At the threshold,
existing bounded `pending-upstream` recovery applies. Models, concurrency,
strictness and merge rules are unchanged.

Synthetic offline regressions exercise malformed output, ambiguity, banner
compatibility, timeout recovery and exhaustion, identity release, threshold
parking, separate health counts and genuine authentication failures. The
change note records validation results. No new CI gate or live action is added.

## Recovery and prevention

After normal submodule float and watcher restart, the service owner should
observe natural resolution retries and their separate health counts. Source
tests do not establish deployed recovery or re-admit already isolated seats.
Any existing isolated-seat recovery remains with the service owner's normal
procedures; this change makes no host configuration or live state edits.

The failure-family lesson is to classify a failed prerequisite at its own
boundary. An executable-selection failure cannot establish credential failure.
Test both the classifier and downstream resource/accounting consequences.
