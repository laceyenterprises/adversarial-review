# LAC-2081: interrupted AMA intent without a durable receipt

Severity: SEV3. Source-fix scope: adversarial-review only.
[Incident and authorization](https://linear.app/laceyenterprises/issue/LAC-2081).
Contract: native pre-receipt closer intent ownership. Regression:
`test/ama-pre-receipt-intent.test.mjs` (SIGKILL, receipt recovery, no-submission,
unknown evidence, deterministic interleaving and lock fixtures).

Related registered contracts are `adversarial-pipeline.no-action-on-terminal-pr`
and `merge.finding-remediation-and-authoritative-terminal`. Required finding
remediation, authoritative PR terminal-state checks, finalization and shared
merge predicates remain unchanged. The config multi-loader parity scar does not
apply: no configuration key is added or renamed.

## Evidence and limits

The incident ticket records agent-os#8918 at head
`fc01d661d0c0abd842b7b285c59ca43c729490f3`, worker
`hammer-ama-pr-8918-fc01d661d0c0`, in `dispatching` from
2026-10-22 10:18:18 UTC. Its JSON mtime is 10:18:22 UTC, recorded dispatch timeout
2,614,118 ms (43.6 minutes), launch IDs and dispatch time null, and no last
observation or error. It remained unchanged through the ticket's 13:42 UTC
observation. This investigation read the retained deployed file and confirmed
those bytes and timestamps. There was no current-head JSON lease at the expected
path; a `.reclaim.lock` sidecar existed. No production record was changed.

The provisioned source, fetched origin/main and deployed adversarial-review
checkout were all `98879da99e3ff0eadcfef30bfbbe73488b6e1759` at inspection.
The native reconciler at that revision unconditionally skipped `dispatching`
records. No already-landed equivalent repair was found in fetched history.

The ticket reports the preceding head's
`lrq_5c963902-8e8c-45db-bc0e-e4c02668d7d7` as terminal succeeded. That does not
establish the current attempt's launch outcome. Read-only `hq dispatch status
<preceding-LRQ> --json` and a worker-ID status probe returned “no dispatch ...
(or owned by another account)”; the canonical worker-list response had no
matching entry. These are not authoritative absence proofs. The canonical
ledger adapter's inferred target refused PostgreSQL-configured/legacy-SQLite
resolution. With the explicit PostgreSQL database name returned by `hq config
get session_ledger.database_name --json`, the read-only query was refused at the
local socket by worker permissions. No fallback database or raw SQL edit was
used. HCP memory searches were available and returned zero records for three
symptom/scope searches; Linear shared field notes were unavailable (`Tool
get_agent_context not found`). Local owner runbooks supplied contract context.

The precise production interruption signal and whether HQ accepted an
unreceipted current-head launch remain unknown. The retained shape proves a
lost local completion transition; it does not prove the launch never happened.

## Root cause

The local ownership protocol persisted intent before invoking HQ, but persisted
the launch receipt only after the subprocess returned. Process interruption
between these writes left no durable correlation key or submission-phase proof.
`dispatchTimeoutMs` bounded a running subprocess invocation; it was not a
restart recovery timer for a JSON record left by a dead caller.

The capacity/CLI reconciler deliberately skipped intent records because retries
could retain a predecessor LRQ. Its safety concern was valid, but it had no
separate native correlation/unknown-evidence repair. Sibling paths attempted to
reclaim presumed phantom attempts using age, caller death or a later wake
refusal. Those observations cannot rule out a child that already enqueued or
continues after caller interruption. Thus automatic progress was either missing
or based on insufficient negative evidence.

## Repair and deterministic reproduction

New intents persist a unique HQ idempotency key and a prepared/submitting phase
boundary under a nonblocking per-PR native flock. The same key is passed to HQ.
The existing HQ producer was inspected read-only: `cwp_dispatch/dispatch.py`
accepts explicit safe keys, stores them on `LaunchRequestRecord`, and uses them
for existing-request lookup. Terminal duplicate keys can exist; the reader
therefore requires exactly one matching row rather than assuming uniqueness.
No agent-os producer change or new configuration key is required.

Native reconciliation recovers an exact matching canonical receipt, settles
only a provably unsubmitted prepared attempt with a matching dead local owner,
or keeps unknown ownership with a fixed inspection deadline. It never queries a
retained predecessor LRQ as proof of the replacement attempt. Read failures,
multiple/foreign rows, absent leases, live/foreign owners and replacement
records hold. Launch receipt recovery and ordinary receipt persistence charge a
native key once; existing caps and suppression remain authoritative. A proven
unsubmitted intent rolls back only its own pre-increment. Lease and record
persistence interruptions resume idempotently. Unknown ownership preserves its
PR exclusion after bounded fleet capacity expires. Later wake refusal and the
stale-lease reaper no longer clear that uncertainty.

Three offline fixtures kill an actual synthetic process with SIGKILL while it
holds the native flock: after prepared persistence, after submitting persistence
without a receipt, and after committing a synthetic canonical receipt before
local receipt persistence. They respectively establish no-launch settlement,
retained unknown ownership, and receipt recovery, with no launcher invocation.
Controlled yielding lookups cover replaced/deleted records, replaced leases and
competing reconciliation; these are deterministic interleavings, not a
probabilistic race fix.

A separate deterministic replay loaded the unmodified origin/main dispatcher
from revision `98879da9` and the patched native reconciler against two disposable
fixtures (prepared/no-submission and accepted/unreceipted). Baseline: **2/2
unresolved**; patched: **0/2 unresolved**, with **2/2 correct resolutions**. The
baseline module and replay roots were removed after measurement. The committed
SIGKILL tests preserve the more extensive repeatable regression.

## Remaining boundary and release separation

Legacy #8918 has no native key or submission phase. This source change cannot
retroactively prove its absence or adopt an unrelated predecessor receipt. It
retains explicit inspection-required ownership. An eventual separately authorized
incident owner must obtain canonical current-attempt receipt/submission evidence;
failed lookups or elapsed time remain insufficient.

Publication of this source PR is separate from cross-model convergence, green
GitHub checks, merge, deployment and incident recovery. The source PR must pass
the ordinary gatekeeper review/CI path; no admin merge is authorized. A deployment
owner must verify native reconciliation in owner-qualified dry-run with the
canonical ledger target, confirm the new key/phase appears on future intents,
and inspect bounded unknown diagnostics before considering apply. LAC-2081 does
not authorize an apply pass, new closer, teardown, remediation or merge for
agent-os#8918. This worker performed none of those actions, changed no deployed
source/configuration/credentials, and claims no actual incident recovery.

## Validation record

The focused fence/recovery/lifecycle run passed 258 tests, including the
SIGKILL and same-timestamp owner replacement regressions. The watcher claim-loop
suite passed all 128 tests. Lint reports zero errors (existing warnings), kernel
contract typechecking passes, and the research-finding walkthrough converges
with byte-stable offline deliveries. A first full run completed 12,746 tests
with 13 failures against intermediate fixtures; the source/fixture regressions
were corrected and covered by focused reruns. The final full suite exited zero: 12,746 tests, 12,740 passed, six skipped,
zero failed (830 seconds). Managed publication evidence is recorded with the
source PR and incident link. These are source validation, not deployment or
incident-recovery evidence.
