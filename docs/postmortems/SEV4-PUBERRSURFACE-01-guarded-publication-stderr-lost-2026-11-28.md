# SEV4 | Guarded remediation publication lost GitHub's refusal

On 2026-11-28 at 11:18:51 UTC, the guarded publisher refused the remediation
for Agent OS PR #11805. The candidate `1019cde80e` was a fast-forward of
`b6f0f26165`. The attempt recorded `remediation-publication-auth-rejected`
and stopped with `remediation-owner-auth-hold`. The publication-failure
sidecar and stop reason gave only “GitHub rejected the guarded publisher
credentials.” PR #11804 had published successfully two minutes earlier.

The local remediation was retained. Operators could see the hold but could
not tell whether it came from a transient credential failure or a permission
change. The earlier success does not establish why #11805 was refused.
[PR #11805](https://github.com/laceyenterprises/agent-os/pull/11805)

## Cause

The child-process runner had captured stderr and the exit code. The
publisher's authentication classification replaced the error with fixed text
and dropped the captured diagnostics. The follow-up daemon then generated the
stop reason from the fixed reply blocker, which has a separate public-facing
purpose.

This was the fourth instance in the “real error hidden” family, following
RESCUEERRBANNER-01 (a config banner masked the helper's error),
LEGACYPRWRITE-01 (a catch-all hid the underlying error message), and the
rescue dispatch-closer banner masking case.

## Correction

The publisher carries the exit code, available GitHub HTTP status and a
redacted stderr tail of at most 2 KiB into the refusal records and operator
stop reason. HTTP 401 can retry once with a fresh credential for the same
route and lease. HTTP 403 and branch protection go straight to the hold.
If a refreshed credential is rejected, the retained source and its diagnostics
stay with the owner. Offline fixtures exercise the retry, hold, stderr
truncation and redaction with synthetic credentials.
