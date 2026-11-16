# SEV1 — Restricted reviewer PATH disabled the Claude review lane

Ticket: REVIEWCLIPATH-01. This report uses synthetic descriptions only.
Disposition: source correction; deployed recovery has not been verified.

## Impact and evidence

The incident report describes approximately 21 hours without a posted Claude
review. Affected work waited for reviewer spillover or accumulated transient
backoff and `pending-upstream` state. This was a complete lane outage, not merely
slow review throughput. No incorrect verdict or unauthorized merge is established.

A controlled environment comparison reproduced the failure: the restricted
reviewer PATH yielded ENOENT while the service environment resolved the CLI.
This evidence distinguishes deterministic command discovery failure from load.
No service output, host paths, account names or repository identifiers are
retained here.

## Cause and detection gap

The Claude harness passed its restricted execution environment to the shared
resolver. With no HQ_BIN override, that resolver spawned bare `hq` using the
reviewer PATH, which excluded the service's command installation. The resolver
never reached CLI selection or reviewer authentication.

The transient classification was wrong for ENOENT. Retry and backoff could not
make an absent command discoverable, and treating every prerequisite failure as
transient concealed an unavailable lane. REVIEWRESOLVECAP-01's load-aware retry
addresses contention; it does not address this deterministic failure. Its timeout
and protocol retry behavior remains compatible with this correction.

## Correction and prevention

Both resolver variants resolve their control command to an absolute path using
caller HQ_BIN, service HQ_BIN, or the service PATH. They continue passing the
reviewer environment to that command. Lookup and spawn errors immediately retain
the existing terminal `reviewer-configuration-error` class through discovery,
runtime and stored failure handling, and queue a configuration alert on the
existing alert bus. Genuine transient failures retain their bounded retry policy.

Synthetic offline tests cover restricted environments, override precedence,
absolute invocation, missing commands, spawn errors, classification, terminal
settlement and alert delivery. No CI gate or live state change is introduced.

A lane that only ever fails “transiently” for hours is down. Classify by error
kind, not by assumption. Deployment and observation of a newly posted Claude
review belong to normal service operations; this source change does not assert
recovery or reset stranded work.
