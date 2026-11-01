# SEV2 — a closer studied its own procedure for five hours instead of resolving a trivial conflict

Date: 2026-10-31. Ticket: HAMPROMPT-01. Severity: SEV2.
Status: instruction correction and offline regression coverage; live acceptance
belongs to SRE after normal deployment. This report uses generic descriptions
and synthetic examples only.

scars: merge.finding-remediation-and-authoritative-terminal

This existing contract requires remediation to reach an authoritative terminal
outcome through the closer's merge/audit path. Here the closer remained active
without executing the next remediation step or recording a named stop. The
instruction changes preserve the contract's exact-head checks, lease,
strict-mode rules, author-change preservation and provenance.

## Impact and evidence

One closer spent approximately 4 hours 45 minutes and 96 million tokens on a
conflicting pull request without resolving its remaining conflict. Findings
were already fixed and 271 targeted tests were green. The remaining conflict
was in a hand-written, append-only JSON catalog: separate changes added distinct
keys, so the correct source resolution retained both additions.

The transcript analysis counted 257 shell commands. Of those, 176 read or
searched the rendered verify-head, publish and merge scripts; eight ran tests.
None ran a local rebase, the generated-conflict resolver, or the documented
conflict block. Twelve progress messages repeatedly described the same intended
action; eight repeated it during the later portion of the run. The run produced
neither conflict resolution nor a confirmed merge.

No unsafe merge is evidenced by this incident. The failure was prolonged
non-execution, delayed delivery and excessive resource consumption.

## Causes

The prompt used an ambiguous instruction to check phase scripts. The intended
file-existence check became repeated source inspection. The rendered prompt
exceeded a thousand lines and contained dozens of prohibitions, with the
publication, conflict, validation and lease sequence spread across sections.

The conflict procedure required lease release, but supplied no concise way to
observe lease state. The closer repeatedly examined implementations to infer
whether local conflict work was allowed. It also lacked a single exit-code
table identifying the conflict block and the point to re-enter after repair.

The instructions had no rule connecting repeated announcements to immediate
execution or a terminal stop. Generic advice to preserve both sides' intent
did not provide a simple playbook for a hand-written append-only map, distinct
from a registered generated output.

## Correction

The first approximately 150 lines now contain the goal, executable existence
checks, state machine, phase exit-code table, lease query, stop conditions and
act-or-stop rule. Rare dispute, documentation-currency, base/provenance,
check-failure/dependency and identity-repair procedures render in full into a private reference appendix;
the main prompt retains their mandatory rules and consultation conditions,
within its existing 60 KiB budget. The
renderer prints the applicable next action/appendix after each phase while
preserving its exit status.

The read-only lease query reports `held`, `released` or `none` for a PR/head.
It treats an unreleased holder for the same PR conservatively across head
changes; expiry alone does not establish release. Unreadable evidence produces
a named failure and no state. The query does not acquire, release, reclaim or
authorize a merge.

Exit 21 directs the closer to query/release the lease, run the conflict block,
publish the repaired commit, validate outside the lease and re-enter verify-head.
Audit publication and the exact-head predicate are rebuilt before merge.

The map playbook requires proof that both sides only added keys relative to
the merge base, retains both distinct-key values and the existing ordering,
and validates JSON and unique keys. Conflicting same-key values or changed base
entries need deliberate semantic resolution. Registered generated outputs
continue to use only the deployed committed-generated-files resolver.

After announcing the same next action twice without executing it, the closer
must execute it or record a named terminal reason through the existing audit
helper. It must not keep reading procedure files.

## Validation and follow-through

Offline regressions cover rendered prompt instructions and retained safety
contracts, phase outcome routing without exit-status changes, read-only lease
observations including malformed evidence, and a real local rebase of a
synthetic append-only map conflict to the union of keys.

SRE live receipt remains outstanding: on the next conflicting pull request,
the closer should execute the conflict block within roughly its first 20
commands, read phase scripts fewer than five times, and either merge or stop
with a named reason. This change adds no CI check, gate or timeout. The separate
HAMPROGRESS-01 work owns the runtime timeout backstop.
