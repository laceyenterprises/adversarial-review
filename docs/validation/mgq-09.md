# MGQ-09 source validation

Scope: read-only canary evidence and generic operator procedure. All scenarios
used disposable stores/Git repositories and fake external boundaries through
the existing test runner under netguard. No production observations, faults,
route changes, restarts, pages or approval were performed.

Final canary/status/shadow-report selection: **28/28 passed**, bounded to 90
seconds per command. Ten additional recovery suites: **305/305 passed**, selected
in a 180-second bounded command (139 seconds observed for that run). Together
these cover 333 distinct cases across 13 selected files. The first aggregate
run also exposed one canary fixture attempting ambiguous issuance after expiry;
it correctly created no intent. The corrected fixture uses a separate valid
entry and passes in the final selection. Earlier projection integration also
exposed owner events being passed to entry metrics; the reader now selects only
acknowledgement/progress events, consistent with the sibling status reader.

Touched-file ESLint with the existing `--fix` tool, contract typecheck, all 77
data-model catalog entries and whitespace validation passed. No CI, required
check, hook, config key or smoke action was added. Broad suites were not run.

| Isolated exercise | Observed outcome in focused regression fixtures |
|---|---|
| Owner restart | Phase/intent crash/reopen retained candidate, sequence and original deadline; unresolved requests blocked takeover. |
| Terminal lease | Terminal reclaim/reaper fixtures released eligible leases while retaining live/uncertain ownership and replacement leases. |
| Duplicate wake | Mixed-source FIFO acknowledged once; overlapping rebase wakes published once. |
| Lost ack | Process exit after commit replayed the durable ack; duplicate submitters returned the same entry/ack. |
| External author push | Expected-old-head publication retained the author's newer SHA. |
| Outside base advance | Invalidated readiness and rebased/retested with original patience. |
| Live hold | Parked without publication/merge; recovery revalidated before tail readmission. |
| Unknown labels | Parked rather than inferred absence of holds. |
| Permission denial | Parked with named permission/author-notice diagnostics. |
| Conflict | Returned to closer without publication. |
| Proof failure | Content/proof mismatches returned; unavailable proof execution parked. |
| Red checks | Returned for repair and blocked final mutation. |
| Missing checks | Never authorized finalization; retained deadline and parked/released once expired. |
| Hung checks | Bounded reads parked/released using original patience. |
| Unreadable checks | Inconclusive required-set/read evidence failed closed and parked. |
| Token expiry | Refresh-only entitled credentials resolved around each operation; ambient credentials could not substitute. |
| Refresh outage | One forced refresh failed closed; early proactive failure retained a still-valid held credential. |
| Ambiguous push | Retained intent until candidate observation/proven drain; no duplicate issuance. |
| Ambiguous merge | Authoritative same-candidate receipt reconciled once; mismatched/unstructured replies refused. |
| Action retry | Lost delivery receipt/restart retained stable key and delivered without another merge. |
| Rollback/reactivation | Missing drain fenced both routes; lost return ack retried after reopening the store; one durable handoff, zero pending returns, stale owners/cached routes refused. |

Existing concurrency fixtures observed 30/30 exclusive owner claims, 20/20
duplicate-submitter pairs with one ack, 10/10 mixed-source FIFO trials, 10/10
author races retaining author SHA, 5/5 overlapping wakes with one publication,
10/10 overlapping finalize races and 10/10 stale-observer races with one merge.
The routing regression reproduced mixed ownership in 30/30 unfixed and 30/30
optimistic controls, then 30/30 consecutive exclusive fenced transfers. These
exercise existing execution mechanisms; this slice changes no concurrency path.

The ten additional files were `ama-closer-launch-liveness.test.mjs` and
`finalization-queue-{routing,owner,handoff,admission,rebase,rebase-proof,checks,check-transport,merge}.test.mjs`.
Final selection was `finalization-queue-canary.test.mjs`,
`finalization-queue-status.test.mjs` and `finalization-shadow-report.test.mjs`.
Each invocation used `node test/run-tests.mjs` with explicit selected files,
command-local netguard variables and a foreground subprocess timeout.

Deployed schema/adapters, actual process/config/producer/identity evidence,
existing organic shadow readiness, at least 20 organic canary entries of both
types, durable operator exercise transcripts and explicit approval are pending.
Follow the [operator procedure](../finalization-queue-canary-runbook.md); this
source validation does not satisfy live rollout or approve promotion.
