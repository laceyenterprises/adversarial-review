# OVERLOADDEFER-01 — helper load timeouts retain closer custody

An actual helper timeout under a load multiplier above one produces
`overload-deferred`. The version 1 wire adapter matches Agent OS's
`agent_os_core.overload_deferral`: phase, deadline, scaled budget, load evidence,
same owner, persistent deferral count, retry time and `host-overload` alert key.
Identical v1 wire vectors qualify both implementations. This repository
remains independently testable without Python or Agent OS.

Read helpers have one local retry with backoff. Mutation helpers preserve their
partial receipts and execute once. Exhausted load timeouts write a deferred
audit, release the merge lease through the existing retryable-abort path and
keep closer retry custody. Generic wrapper failures preserve that observation;
authoritative safety refusals keep their precedence.

The retry ledger retains overload debt across replacement launches. Backoff is
30, 60, 120 and 240 seconds; the fifth deferral stops automatic replacements,
retains ownership and requests overload attention. The existing closure-wait
store coalesces that attention across PRs using one durable host alert latch.
Policy errors, red checks, moved heads, lost ownership and all merge predicates
remain unchanged.

After normal deployment and separately authorized activation, SRE observes
natural helper timeouts under comparable load. Retain receipts showing deferred
closers later completing with the same PR owner, bounded counters and at most
one host overload alert. Terminal failures of this kind should approach zero.
The companion Agent OS PR owns the provisioning/rescue/sweep changes and SEV1
report. This source change authorizes no live mutation or service restart.
