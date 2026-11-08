# SEV2 — resumed hammer lost its Node runtime export

Ticket: HAMNODEBIN-01. Report date: 2026-11-08.
Status: source fix and synthetic regression coverage; deployment and organic
recovery remain unverified.

## Impact and evidence

A resumed hammer finished its work but stopped without merging because its
required second lease-state query could not execute with `HAM_NODE_BIN` unset.
The supplied anonymised audit recorded `lease-state-unavailable`. The incident
scope and frequency are not established by the available evidence.

The mandatory stop protected merge authority when lease state was unavailable.
The fault prevented the read itself; it did not demonstrate a lost lease or
an unsafe merge. This report contains no production identifiers or credentials.

## Root cause and contributing factors

Phase scripts treated an inherited shell variable as durable launch state.
Session continuation can start a shell without that variable. Persisted
`inputs.sh` restored other hammer inputs but did not resolve or export Node.
Publish and merge used bare `"$HAM_NODE_BIN"` calls without startup resolution.
Verify-head resolved it only after earlier helper calls, while other call sites
used local `:-node` fallbacks. Those inconsistent paths hid the missing entry
contract until a later lease query failed.

## Correction

All three phase entrypoints now source one shell resolver before helper calls.
It preserves a valid absolute executable `HAM_NODE_BIN`, otherwise resolves an
unset value through `AGENT_OS_NODE_BIN` or PATH. Invalid explicit values and
missing runtimes stop with `node-runtime-unavailable`. Phase helper calls use
the resolved variable consistently. Persisted resume inputs and the initial
prompt entry source the same resolver and export the result to child shells.

Lease observation, acquisition, owner cleanup, required merge predicates and
mandatory stops retain their existing behavior. No CI check or live state is
added or changed.

## Regression evidence and recovery

Offline fixtures cover each full rendered phase with the variable unset or a
valid explicit executable, child-shell export, invalid relative/missing/directory/
non-executable pins, missing PATH Node, and re-sourcing persisted resume inputs.
A synthetic publication exercises the actual lease-status checks twice before
stopping at a deliberately refused PR read. It cannot publish or merge.
Validation commands and results are recorded in the
[change note](../changes/HAMNODEBIN-01.md).

Publication alone does not establish deployed recovery. Normal review, merge
and deployment must precede observing an organic resumed hammer successfully
read lease state and continue through the existing merge gates. No production
replay or live mutation is part of this change.
