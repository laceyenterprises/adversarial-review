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

## Reopened acceptance follow-up (2026-10-22)

This follow-up is `lrq_e1cc6874-41ef-4128-9bbf-e3a534162aeb`, worker
`codex-rescue-lac-2081-followup`, in its separately provisioned adversarial-review
workspace. The original RCA launch is canonical terminal succeeded at
15:22:12Z; it was not redispatched. The issue and latest rescue comments were
read before investigation. The core acceptance observations were collected by
approximately 19:46Z; validation and the lease/budget recheck followed.

### Publication and deployment

Source PR [#1453](https://github.com/laceyenterprises/adversarial-review/pull/1453)
merged at 17:17:22Z as `e8c049bfa4073cb87c78892957ef36af6be8d8f5`.
Both the deployed parent gitlink and checked-out submodule were independently
read as `66a90efaf7a903682979c8d602631feaf25a840d`, which contains that merge.
These facts establish publication and deployed source, separately from loaded
behavior or incident recovery.

### Loaded applicability

The canonical watcher log contains native `ama_closer.pre_receipt_reconciled`
events for the exact incident heads:

| PR / head | Native observation | Fixed diagnostic deadline | Result |
| --- | --- | --- | --- |
| #8918 / `fc01d661d0c0abd842b7b285c59ca43c729490f3` | 17:40:37Z | 11:01:52.118Z | `inspection-required`, `legacy-intent-without-key` |
| #8924 / `1560377865d73174152317303e4de06a36e14329` | 17:40:19Z | 18:14:51.338Z | Initially `unknown`; `inspection-required` at 18:19:21Z, same reason |

This is positive evidence that the running watcher executed the repair for
both intents, beyond merely finding the source on disk. The system launchd
service and canonical HQ heartbeat also agreed on watcher PID 66740; the
heartbeat advanced through 19:45:38Z. No restart was performed or needed to
explain these records. This evidence establishes the repair's loaded behavior;
it does not fingerprint every module in the running process.

Neither legacy intent has `dispatchIdempotencyKey` or `dispatchPhase`. The
native owner therefore cannot recover an exact keyed receipt or prove the
prepared-before-submission boundary. It correctly retains unknown custody.
The diagnostic is `preReceiptReconciliation`, not `lastObservedAt` or
`lastError`: those fields can remain null while the repair is working. Thus the
19:28Z rescue projection of `dispatching` with null receipt/liveness fields did
not establish that reconciliation had never run.

Mergeability and custody are separate. The log records `hammer_wake` skips
with `pr-not-mergeable` for both heads, while subsequent background AMA passes
settle as `existing-dispatch-unknown`, including the 19:29Z passes. The native
`maybeDispatchAmaCloser` wrapper reconciles same-PR intents across heads before
its admission attempt; the capacity reconciler also treats every `dispatching`
intent as in progress. These heads reached that repair despite the wake refusal.
Other orchestration holds need not invoke admission, so absence of a diagnostic
alone still warrants the documented reconciliation dry-run, not a launch or an
assumed runtime version. A live GitHub read at approximately 19:46Z reported
both PRs open at these exact heads, with `mergeable` and `mergeStateStatus`
`UNKNOWN`; that later reading cannot replace the earlier observed gate result.

### Actual recovery and external custody change

Read-only inspection found both incident records already changed to
`no-dispatch` at 19:32:38Z by another session. Their embedded annotations say
`legacy-no-launch-proven`, attribute settlement to “Main Loop 6 SRE session”,
and claim operator authorization and negative ledger evidence. The annotations
retain the previous native `inspection-required` objects, last observed at
19:31:27Z. These are assertions in the changed records, not independently
verified authorization or proof that no subprocess could still enqueue.
This follow-up neither performed nor adopts that settlement as native recovery.
The shipped native repair does not emit `legacy-no-launch-proven`.

By the 19:37Z and 19:42Z watcher passes, both exact heads instead returned
`hammer-retry-cap-exhausted`. No budget reset or additional closer was attempted.
No natural receipt recovery was established. The verified native outcome before
the external change was safe, explicit unknown custody; publication, deployment
and this diagnostic result must not be reported as a recovered or merged PR.
Incident closure remains with the incident owner after assessing the external
settlement and current ownership against canonical evidence.

### Bounded inspection and operator action

The existing reconciliation CLI ran as the dispatch directory owner with
`--dry-run`, the explicit deployed `--root-dir`, canonical `--hq-root`, and the
watcher's explicit PostgreSQL `--ledger-target`. It exited zero within a
45-second command bound: 3,024 records scanned, three proposed changes, 632
unreadable results, and pre-receipt counts recovered 0 / no-launch 0 / unknown 0 /
held 1. These are fleet totals; the two incident records were already
`no-dispatch` and were not pre-receipt candidates. SHA-256 comparisons of all
eight existing target intent, lease and retry-budget JSON files were unchanged
across the dry-run. Unreadable results do not prove missing launches.

The [LAC-2081 interrupted-dispatch operator procedure](./follow-up-runbook.md#interrupted-dispatch-intents-lac-2081)
remains applicable: inspect the complete intent and its bounded diagnostic,
use owner-qualified canonical dry-run first, preserve same-PR custody and
scratch evidence, and obtain exact current-attempt receipt/submission evidence
when a legacy key is absent. A missing key cannot be repaired retroactively by
reusing a predecessor LRQ, elapsed time or an empty listing. Do not apply against
#8918 under the original source-fix authorization. For the externally settled
records, the incident owner must assess that separate action and the subsequent
cap refusal; this follow-up grants no authority to rewrite either record or
budget, force a closer, restart active services, or remediate/merge either PR.
The lease/budget recheck still found #8924's exact-head pending lease with no
LRQ, acquired at 17:38:03Z under watcher PID 46625; #8918 had no closer lease
JSON. The earlier #8924 head's terminal lease cannot resolve the pending
attempt. Both per-PR budget ledgers were suppressed, with recorded lifetime
counts three (#8918) and four (#8924). Lease absence, a different watcher PID
and budget suppression supply no current-attempt launch-absence proof.

No follow-up runtime fix is justified by the observed applicability. This PR
records acceptance evidence only and must use ordinary cross-model convergence.
HCP memory search initially timed out; a later documentation-scope search was
available and returned zero records. Linear shared field notes returned
`Tool get_agent_context not found`; local runbooks supplied the missing context.

The focused offline run passed 185 tests across pre-receipt interruption,
reconciliation and watcher claim-loop suites. Disposable native replays of both
incident shapes, with conflicting PR metadata, returned inspection-required
unknown custody with their original timeout deadlines, zero launches and
unchanged retry counts. A future observation retained PR exclusion without a
fleet-capacity reservation. An initial exploratory assertion incorrectly assumed
the load-scaled capacity window had already expired for #8924 at 19:28Z; the
future observation avoids that unsupported timing assumption. Lint passed with
zero errors (existing warnings), contract typechecking passed, and the offline
research-finding walkthrough converged with byte-stable deliveries.
The required full offline run completed in 849 seconds with exit 1: 12,787
tests, 12,779 passed, six skipped, two failed. The failures were
`LEASEFAIR-02: ci-disjoint` in `test/hammer-self-rebase.test.mjs` and
`four same-head pending CI launches retain charges within the gate cap` in
`test/leasepark-ci-wait.test.mjs` (a 20-second subprocess timeout). All runtime
and test files were identical to `origin/main` at `66a90efa`; the only change
was this document. These are failures in the unchanged baseline, not a green
full-suite claim. They were not repaired or masked in this acceptance follow-up.
