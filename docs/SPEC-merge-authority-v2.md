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

Data-model contract: [`docs/data-model/finalization-ledger.md`](data-model/finalization-ledger.md)
tracks the app-store schema introduced by
[`migrations/20260717_finalization_ledger.sql`](../migrations/20260717_finalization_ledger.sql).

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
         | finalized(rev, method) | closed(reason) | escalated(reason)
         | halted(reason)
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

`Decision := finalize-now | remediate(stageId, round) | close(reason)
| wait(reason, deadline) | halt(reason) | escalate(reason)`

Policy inputs, all explicit and versioned in config:

- **strict_mode** (default on): non-blocking findings exclude `finalize-now`
  via the autonomous path; they route to `remediate` — and the final
  remediation addresses **all** review comments, blocking and non-blocking,
  before merge (standing operator policy).
- **Exhaustion always closes by landing, never by abandoning** (standing
  operator policy, 2026-07-02/2026-07-16): when the last stage's budget is
  exhausted, the decision is `remediate(final)` followed by `finalize-now` —
  never an indefinite `wait` and never a reject-without-merge. The **final
  remediation is coverage-gated**: its structured reply must address **every**
  outstanding review comment, blocking and non-blocking (validated against the
  remediation-reply schema's per-finding coverage check), and no further
  re-review gates the merge. This path cannot merge unaddressed blocking
  findings: either the final remediation achieves validated full coverage and
  `finalize-now` executes, or coverage is operationally impossible (e.g. a
  branch conflict the remediator cannot resolve) and the decision is `halt`,
  which always pages. `close(reason)` exists in the decision vocabulary for
  **operator-override use only** (an `operator_override` event directing
  rejection); the autonomous policy never emits it.
- **Patience is bounded and explicit**: `checks_settled` requires required
  checks to be *present and completed* (a running check is not a conclusion).
  `wait(checks, deadline)` polls boundedly; deadline expiry becomes
  `escalate`, never a merge.
- **Attestations are data with both a declared producer dependency and bounded
  runtime patience.** Config validation rejects `consume_attestations` when no
  producer is configured. For each revision, a configured producer that has
  not emitted the required `attestation_recorded(produced)` event yields
  `wait(attestations, deadline)`; deadline expiry becomes `escalate`, never an
  infinite stall or merge. This covers both cutover misconfiguration and
  producer failure at runtime. (LHA class eliminated by explicit failure
  handling rather than configuration alone.)
- **Kill switch** carries over: autonomous execution disabled intercepts every
  mutating decision before dispatch. `finalize-now`, `remediate(...)`, and
  `close(...)` all become `escalate` with a fail-closed audit row; no merge,
  PR close, worker dispatch, commit, push, or other autonomous mutation may
  proceed.
- **Escalation is recorded and terminal.** Every `escalate(reason)` decision
  the executor acts on writes an `escalated(reason)` event to the ledger. The
  fold treats an unresolved `escalated` event as a terminal state — no further
  execution and no re-paging for the same cause on subsequent evaluations or
  restarts — until an `operator_override` event resumes or redirects the
  subject.

## 4. Execution

- **One executor.** A single finalization worker per subject, under a lease
  in the app store (not GitHub labels). It executes `Decision`s
  idempotently: `finalize-now` → github-adapter `pr-merge` (or GAP-1
  adjudicate surface once it exists); `close` → github-adapter `pr-close`;
  `remediate` → agent-runtime port with the same idempotency-key scheme as
  reviews. The executor applies the kill-switch interception before invoking
  any mutating adapter (`pr-merge`, `pr-close`, or the agent-runtime port).
- **Idempotent by construction:** before executing, the executor re-folds; if
  the world moved (new event since the decision), it discards and re-decides.
  Merge execution itself is guarded by the (subject, rev) pair — a merge of a
  stale rev is structurally impossible to issue. If the remote merge succeeds
  but the local `finalized` append does not, a retry may accept the adapter's
  structured `already merged` response as success only when that response
  identifies the same guarded revision; the retry then appends the missing
  terminal event. Unstructured or mismatched responses remain fail-closed.
- **The hammer becomes a decision outcome, not an actor.** "Hammer" v2 = the
  remediation worker dispatched by a `remediate(final)` decision plus the
  executor's subsequent `finalize-now`. The gate between the two is the
  coverage-validated final-remediation reply (every blocking and non-blocking
  comment addressed), not a further re-review round — per the standing
  operator policy in §3. Failure to achieve coverage folds to `halt` (pages);
  the autonomous fold never emits `close`. The hammer's lifetime ceiling and
  retry cap are policy inputs to the fold, not self-managed loops.

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
