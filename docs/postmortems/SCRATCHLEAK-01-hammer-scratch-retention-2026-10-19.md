# SCRATCHLEAK-01 — terminal hammer scratch retention

Incident date: 2026-10-19. Status: repair prepared; deployment and independent
disk-reclamation verification pending. This report uses generic runtime paths
and synthetic identities. No production state was inspected or changed by the
repair worker.

## Reported evidence and impact

The closer prompt directory contained 124 `hammer-scratch-*` directories,
approximately 13.7 GB in total, with the oldest six days old. The largest was
2.3 GB, almost entirely a `pytest-of-<runtime-user>` tree, belonging to a run
whose PR closed the previous evening. Its close and closing-comment files were
present. There were 71 pytest temp trees across scratch directories.

The extra files caused disk churn on a space-constrained runtime host. Deploy
discovery also scanned fixture service manifests in those trees and emitted
warnings. Repeated cleanup-deferred messages accompanied the accumulation.
A sibling daemon's recursive `lsof +D` probe timed out after roughly five
seconds on large trees. That observation does not establish that the closer
used that exact command or timeout.

## Cause established from the repair baseline

Hammer dispatch exports `TMPDIR` as its private scratch directory. Without an
explicit pytest base, pytest's default per-user retention leaves up to three
test temp trees inside each independently retained scratch directory. Those
directories amplify a cleanup failure into gigabytes of retained data.

The current baseline already includes terminal writer/reconciliation cleanup,
transitive retry-chain protection and a startup sweep. It also already replaced
recursive `lsof +D` with a UID-wide open-file census. The reported production
backlog alone cannot identify which revision produced every retained run.

Two remaining indefinite-deferral mechanisms are confirmed in that baseline:

1. Any unreadable process census, including a subprocess timeout, aborts the
   entire deletion pass without a terminal-age escape. Scanning every open file
   still scales with test activity, even without recursive filesystem traversal.
2. Before considering ownership, the sweep recursively sizes the entire tree
   and checks its newest mtime. A large tree can consume the scan deadline on
   every pass; the next pass restarts that tree walk. Terminal reclamation
   therefore depends on finishing work proportional to the leaked tree.

Immediate terminal cleanup also lacked a recorded-process guard: cancellation
can mark a run terminal before its subprocess finishes draining. Removing files
at that point would trade the leak for a scratch-use race. Existing admission
deferral for live fleet retries must remain intact.

## Repair

The dispatch environment appends a private `tmp-tests` base and retention count
one to pytest options. Terminal cleanup removes that tree with scratch, preserves
recorded live processes and launch lease holders, and recognizes merged, closed,
failed, superseded and no-merge outcomes without changing merge authority.
Existing retry-chain and admission-race protections remain in place.

The sweep checks process identity/environment, cwd, recorded worker PIDs, live
leases and fresh terminal ledger/retry state. Its `lsof` invocation selects cwd
only. A cwd timeout retries while the terminal run is recent; after the existing
two-hour idle bound plus twice the larger launch/lease window, an aged terminal
run can be reclaimed with readable `ps` and no positive holder evidence.
Incomplete retry evidence, nonterminal runs, live processes/leases, unreadable
`ps` and orphans do not take that escape. Partial cwd evidence still protects
known holders. No new config, CI check, override label or merge refusal is added.

For terminal owners, age comes from directory and terminal observation time;
nested fixture mtimes do not renew ownership. Byte accounting has a small budget
and explicitly reports a lower bound if incomplete. The existing startup and
continuation sweep reclaims the old terminal backlog after deploy, with per-run
removal and summary logs. Dispatch records and retained prompts remain evidence.

## Regression coverage and deployment verification

Synthetic offline tests cover terminal cleanup and test-tree removal, draining
process retention, live leases and retries, terminal timeout recovery across a
fresh module import, positive holder evidence during timeout, and large-tree
accounting that cannot starve deletion. The existing scratch admission-race
suite remains part of validation. The sandbox smoke handoff also exercises
terminal temp lifetime and timeout recovery.

After normal deployment, verify the closer restart, startup sweep progress and
bounded timeout reclamation. The prompt directory should retain only live,
protected or recent scratch, and disk use should drop by roughly 13 GB. Observe
a day of subsequent runs for stable scratch size and disappearance of fixture
manifest warnings. Those host acceptance results remain pending; this PR does
not perform live cleanup or claim disk space has already been recovered.
