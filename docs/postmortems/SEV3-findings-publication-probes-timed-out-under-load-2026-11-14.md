# SEV3 — findings publication probes timed out under load

Date: 2026-11-14. Ticket: FINDINGSSTATUSTIMEOUT-01. Severity: SEV3.
Status: source repair with offline synthetic qualification; deployment and
organic recovery remain unverified.

scars: merge.finding-remediation-and-authoritative-terminal

## Impact and evidence

Supplied anonymised evidence describes one prepared findings batch whose
decision launch had pushed a remediation branch and ended blocked on publication.
Every collection pass since approximately 17:00 UTC failed at the status probe,
before publication logic could run. Its recorded error contained only a
117-character command-failure echo, without stderr, signal or exit code.

A manual read with the same arguments reportedly succeeded in 9.2 seconds at
approximately 100 load average. The reported afternoon load was mostly 130–140.
The error shape is consistent with the 15-second child timeout, but the missing
termination metadata prevents proving the cause of each historical failure.
The batch remained unpublished and exposed to the existing 24-hour stale-release
policy, which requeues findings but abandons their prepared remediation.
The supplied evidence does not establish that this batch actually reached release.

No live database, batch artifacts or launch ledger were inspected or changed for
this repair. All reproduction fixtures use synthetic identities and temporary
stores.

## Root cause and sequence

1. Preparation produced applied outcomes and a pushed head.
2. The collector acquired its publication lock, then invoked `hq dispatch status`
   with a fixed 15,000 ms timeout.
3. Under load, this prerequisite could exhaust its timeout before the collector
   reached branch/PR verification or decision-publication handoff.
4. The next keyed launch probe also had a fixed 15,000 ms bound, creating a
   second bottleneck even if status succeeded.
5. Status failures preferred stderr or the generic command echo; killed/signal
   metadata never entered the bounded row. Thrown keyed-probe failures became
   a generic receipt-unavailable error. Repeated transport failure therefore
   obscured the reason publication could not progress.

Publisher dispatch already used a load-aware 900,000 ms nominal bound. Its
prerequisite reads had not adopted that policy. The earlier publication-intent
and decision-handoff repairs could not help while these reads failed first.

## Correction and safety

Both publication probes now receive one effective read-scale bound with a
30,000 ms nominal, matching hammer launch reads. Publisher dispatch retains its
900,000 ms provisioning nominal. The existing
`adversarial.reviewer.load_aware` configuration controls scaling; there is no
new configuration key. Each probe receives the computed bound unchanged.

Killed or timed-out probes record the operation and effective timeout first;
signalled probes include the signal. Output-limit failures are classified before
kills and reported as `output exceeded limit`. Signal-only termination is described as
termination rather than asserted to be a timeout. The diagnostic takes
precedence over command echoes and stderr before existing redaction and
300-character truncation. Typed timeout results from the keyed read adapter
also retain their cause. Full captured stderr remains in the redacted log.

Read failures remain retryable collection errors, spend no preparation attempt,
and do not become terminal preparation failures. Existing stale-release limits,
identity checks, keyed custody checks, publisher intent fencing, single bounded
resubmission and decision-publication handoff remain in force. A later readable
pass must still prove publication authority before dispatch.

Sibling inspection covered the release helper's ledger reads and GitHub probes.
Their separate stale-release and GitHub retry contracts are unchanged. The
earned-scar search for publication probe timeouts returned no matching records;
the supplied failure-family history reinforces retaining authoritative custody
checks and making unreadable prerequisites explicit.

## Qualification and follow-up

Synthetic tests model 20-second status and keyed reads under a known load-scaled
bound and verify that publication proceeds. They exercise killed children,
explicit timeouts, timeout codes, output-limit kills, signal-only termination and typed keyed read
timeouts, checking bounded row/log diagnostics, unspent attempts, retained
outcomes and successful retry on the next pass. Existing PUBLISHINTENTSTRAND-01
and FINDINGSDECISIONHOLD-01 cases run in the same touched test file.
See the [change note](../changes/FINDINGSSTATUSTIMEOUT-01.md) for observed results.

After normal deployment, the runtime owner can observe the next organic
collection pass for an eligible batch and retain evidence of successful reads,
publisher receipt and eventual normal PR review. Longer read bounds also delay
hang detection under load. A hung probe holds the entire findings pass and
subsequent hourly settlement until all workers finish; per-publication waits
can accumulate three read bounds, the decision handoff and dispatch, plus
GitHub reads. See the closure runbook for scaled budgets. This source repair performs no restart or backlog
recovery and does not claim production recovery.
