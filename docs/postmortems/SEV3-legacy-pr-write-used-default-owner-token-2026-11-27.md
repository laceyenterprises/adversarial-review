# SEV3 legacy PR writes failed for an external GitHub owner

Ticket `LEGACYPRWRITE-01`

On November 27, 2026 at approximately 12:56 UTC, rescue remediation for two
external-owner PRs exited 75 on three attempts per PR. Each attempt reported
`legacy PR write unavailable; reconcile before retry`. A separate repair had
already restored the rescue authorship read for external repositories.

## Failure

The legacy PR writer reads the current PR identity before issuing a command
under the repository and base branch lock. Its shared metered GitHub reader
can request an external installation, but its implicit role lookup recognizes
reviewer credentials. A rescue merge-agent credential can therefore be refused
before the read begins. Even if the live identity read succeeds, the wrapped
command inherits the default GitHub credential. The CLI printed either child
stderr or a fixed fallback, dropping the exception message in both cases.

The synthetic regression supplied a successful external identity read and made
the command reject the default token. Before the fix, the command received
`synthetic-default-token`, exited through the wrapper with status 75, and
produced the same fixed fallback. This reproduces the code defects independently
of the original incident. The suppressed production exception remains unknown.

## Repair

The wrapper selects the target-owner installation through the existing GitHub
owner selector with the merge-agent role. It uses the resulting credential for
both the live identity lookup and the wrapped command. The home owner keeps its
existing credential. The CLI includes the exception message and a redacted,
bounded stderr tail and preserves the existing exit status contract.

Offline tests verify both owner routes and the failure output. The tests use
synthetic owners, commands, and credentials.
