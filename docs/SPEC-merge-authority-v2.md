# SPEC — Merge Authority v2: Ground-Up Finalization Redesign

**Status:** Draft v0.1 — design for operator review; implementation is
Phase 3 of [`SPEC-adversarial-review-v2-app-architecture.md`](SPEC-adversarial-review-v2-app-architecture.md).
**Scope:** the code-pr implementation of the v2 finalization port. v1 merge
authority (`src/ama/*`, `follow-up-merge-agent.mjs`, daemon-clean path) is
**frozen** — bug-fix-only, no new capabilities — from the moment this design
is accepted until v2 is promoted.

---

## 1. Why a redesign instead of another fix

The v1 merge-authority failure family, from this repo's own incident history:

- **Phantom die-before-merge / non-resumable closes** (HCM-01): hammer
  progress lived in process state; a crash between remediation and merge
  stranded converged PRs.
- **Bound-reset-on-head-move / identity head-pin** (#603): worker identity
  lookups pinned to the current head broke when the head moved after open.
- **Review-ceiling + head-move deadlock** (LAC-1559): a clean, green PR became
  permanently un-landable because the round ceiling and the head pointer were
  tracked by different actors with no reconciliation.
- **LHA premature cutover**: the daemon required `produced` attestations that
  no producer had ever written — a policy flag flipped ahead of the data it
  depended on, and nothing in the design made that dependency explicit.
- **Impatience with CI** (AR#550): merge eligibility read "checks green" as
  "checks I can see are green," merging before required checks existed.
- **Verdict-at-wrong-head merges**: "remediation-stopped" and mergeState CLEAN
  misread as clean verdicts; review `commit_id` vs head never reconciled in
  one place.

These are not six bugs. They are one design property: **merge authority is
distributed across cooperating actors (watcher, hammer, labels, leases,
GitHub timeline scrapes, log greps) whose shared state is implicit.** Every
fix so far has added another coordination rule between actors. v2 removes the
coordination problem instead.

## 2. Design thesis

One subject, one durable state machine, one writer.

```
FinalizationLedger (per subject, append-only, in the app store):
  Event := revision_advanced(rev)
         | verdict_recorded(rev, stageId, role, verdictKind, sourceRef)
         | checks_settled(rev, conclusion, requiredChecksPresent)
         | attestation_recorded(rev, kind, principal)      # data, not authority
         | remediation_dispatched(rev, round, idempotencyKey)
         | remediation_concluded(rev, round, outcome)
         | budget_exhausted(stageId)
         | operator_override(kind, principal, reason)
         | finalized(rev, method) | halted(reason)
```

- **Eligibility is a pure function** `eligible(fold(events), policy) →
  Decision`. No actor "decides to merge" — the fold does. Actors only append
  observations.
- **Head-move is an ordinary event**, not an edge case. `revision_advanced`
  does not reset anything; it simply means later eligibility folds require
  `verdict_recorded` and `checks_settled` **at that revision**. The
  ceiling/deadlock class disappears because budgets are counted per stage
  (kernel-side) while eligibility is computed per revision — two questions v1
  conflated.
- **Every external fact carries its provenance** (`sourceRef` = GitHub review
  `commit_id`, check-run id, ledger row id). "Verdict at head" is verified by
  construction — the fold only matches verdicts whose `rev` equals the
  candidate revision — never by comparing a log line to a head pointer.
- **Crash-resume is a replay.** Any executor restart folds the ledger and
  continues. This is the graceful-pause/resume invariant applied to merges:
  pause = stop appending, resume = fold and continue; there is no in-memory
  progress to lose. (HCM-01 class eliminated structurally.)

## 3. Decision policy

`Decision := finalize-now | remediate(stageId, round) | wait(reason, deadline)
| halt(reason) | escalate(reason)`

Policy inputs, all explicit and versioned in config:

- **strict_mode** (default on): non-blocking findings exclude `finalize-now`
  via the autonomous path; they route to `remediate` — and the final
  remediation addresses **all** review comments, blocking and non-blocking,
  before merge (standing operator policy).
- **Exhaustion always closes** (standing operator policy): when the last
  stage's budget is exhausted, the decision is `remediate(final)` →
  `finalize-now`, never an indefinite `wait`. `halt` is reserved for
  operational impossibility (e.g. branch conflict the remediator cannot
  resolve), and always pages.
- **Patience is bounded and explicit**: `checks_settled` requires required
  checks to be *present and completed* (a running check is not a conclusion).
  `wait(checks, deadline)` polls boundedly; deadline expiry becomes
  `escalate`, never a merge.
- **Attestations are data with a declared producer dependency.** The policy
  key `consume_attestations` is only satisfiable when
  `attestation_recorded(produced)` events exist for the revision; enabling
  the consumer while the producer emits nothing is a **config-validation
  error at load time**, not a silent zero-merge regime. (LHA class
  eliminated at the config layer.)
- **Kill switch** carries over: autonomous execution disabled → every
  `finalize-now` becomes `escalate` with a fail-closed audit row.

## 4. Execution

- **One executor.** A single finalization worker per subject, under a lease
  in the app store (not GitHub labels). It executes `Decision`s
  idempotently: `finalize-now` → github-adapter `pr-merge` (or GAP-1
  adjudicate surface once it exists); `remediate` → agent-runtime port with
  the same idempotency-key scheme as reviews.
- **Idempotent by construction:** before executing, the executor re-folds; if
  the world moved (new event since the decision), it discards and re-decides.
  Merge execution itself is guarded by the (subject, rev) pair — a merge of a
  stale rev is structurally impossible to issue.
- **The hammer becomes a decision outcome, not an actor.** "Hammer" v2 = the
  remediation worker dispatched by a `remediate(final)` decision plus the
  executor's subsequent `finalize-now`. Its lifetime ceiling and retry cap
  are policy inputs to the fold, not self-managed loops.

## 5. Shadow-mode cutover

1. **Shadow:** v2 ingests live events and logs `Decision`s; frozen v1
   continues to act. Every (v1 action, v2 decision) pair is recorded.
2. **Diff triage:** divergences are triaged in both directions — v1 is the
   known-buggy system, so a divergence is evidence, not automatically a v2
   defect. Divergence classes and dispositions are recorded in the repo.
3. **Promotion gate (operator-approved):** ≥ N days (default 7) with every
   divergence dispositioned, including at least one organic head-move and one
   budget-exhaustion close observed in shadow.
4. **Cutover:** v2 executor enabled, v1 actors disabled by config — one flag,
   one bounce. v1 code is retained for one release cycle as the documented
   rollback (`flip flag, bounce watcher`), then deleted.
5. **Fail-closed default at every step:** if the shadow ledger is
   unavailable or the fold errors, v2 emits `escalate` — it never guesses.

## 6. Open questions for operator review

1. **N-days promotion gate**: is 7 days of clean shadow diff the right bar,
   given merge volume (~dozens/week)? A volume-based gate (e.g. 50 shadowed
   finalizations) may be sounder than a time-based one.
2. **Escalation channel**: `escalate` currently means page + Linear ticket
   via the operator surface. Should budget-exhaustion closes *also* notify,
   or stay silent-by-default as v1's hammer closes are?
3. **Ledger location**: the FinalizationLedger lives in the app store
   (`reviews.db`) per the OS-optional principle. Mirror to the session ledger
   once GAP-2 (app notes API) exists, or keep app-local permanently?
