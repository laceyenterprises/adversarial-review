# SPEC — Durable First-Pass Review Jobs

_Status: Draft v0.1_
_Date: 2026-04-22_
_Owner: Clio / Paul_
_Related: `SPEC.md`, `SPEC-pr-review-trigger-guardrails.md`, `SPEC-org-rollout-pr-review-guardrails.md`, LAC-207, LAC-206_

## 1. Purpose

Refactor first-pass adversarial review from an inline watcher-owned execution path into a durable job-driven flow.

This spec exists because the current watcher still owns too much semantic responsibility:
- it discovers PRs
- routes reviewer selection
- spawns reviewer execution
- partially owns delivery state
- can still create false completion if discovery succeeds but delivery fails

The immediate bug was patched on 2026-04-22 by introducing explicit delivery states (`pending`, `posted`, `failed`, `malformed`) in `reviews.db`, but that patch is still a stabilizing bridge. The underlying architecture is still too much product logic inside a polling loop.

## 2. Problem Statement

Current failure pattern:
1. watcher polls GitHub and sees a new tagged PR
2. watcher decides reviewer routing correctly
3. reviewer subprocess fails somewhere in runtime/auth/filesystem/posting path
4. system can end up in an ambiguous or awkward recovery state because discovery and execution are still coupled inside one service loop

Even after the 2026-04-22 semantics patch, this design still has real weaknesses:
- execution failure handling is mixed into the polling control loop
- operator visibility is weaker than it should be
- retries are still awkwardly owned by the watcher
- the path does not match the emerging queue/worker model already being built for remediation jobs

## 3. Core Thesis

First-pass review should use the same basic control-plane pattern as remediation:

- **watcher = producer / discovery plane**
- **review worker = consumer / execution plane**
- **durable job state = operator truth**

The key change is semantic, not cosmetic:

> A PR being discovered is not the same thing as a review being delivered.

The system should only claim success when a review artifact is actually posted to GitHub.

## 4. Goals

1. Make first-pass review delivery state durable and honest
2. Separate PR discovery from review execution
3. Make failures visible and retryable without lying about completion
4. Align first-pass review with the remediation queue/worker model
5. Improve operator legibility without overbuilding a generic scheduler

## 5. Non-Goals

### In scope
- durable first-pass review job records
- watcher changed to enqueue/refresh jobs instead of directly owning completion
- a worker path that claims and executes review jobs
- explicit failure capture and retryability
- keeping malformed-title handling explicit and terminal

### Out of scope
- a fully generic multi-product job orchestration framework
- redesigning the follow-up remediation system in the same ticket
- replacing GitHub polling with webhooks in this slice
- building the full operator cockpit UI in this slice
- multi-round autonomous remediation loop policy work

## 6. Current vs Target Architecture

### 6.1 Current shape

```text
GitHub PR discovered
  -> watcher decides route
  -> watcher spawns reviewer inline
  -> watcher interprets execution result
  -> watcher records delivery state
```

This is better than the earlier binary seen/not-seen model, but it still puts too much delivery ownership in the watcher.

### 6.2 Target shape

```text
GitHub PR discovered
  -> watcher validates / routes / creates durable review job
  -> worker claims pending review job
  -> worker runs reviewer
  -> worker posts GitHub review
  -> worker records posted/failed result
  -> on success, worker emits durable follow-up handoff job
```

Key boundary:
- watcher success = job durably recorded
- worker success = review actually posted

## 7. Functional Requirements

### 7.1 Watcher responsibilities
The watcher must:
- poll watched repos for new/open PRs
- validate title tag / routing rules
- create a durable review job for eligible PRs
- avoid duplicate active jobs for the same PR
- create explicit malformed terminal records for malformed PRs
- update Linear to `In Review` when appropriate

The watcher must not:
- treat “seen” as “reviewed”
- own GitHub review posting semantics inline as its primary contract
- silently swallow delivery failures

### 7.2 Review worker responsibilities
The review worker must:
- claim a pending review job atomically
- mark it `in_progress`
- run the reviewer path with the routed model/runtime
- post the review artifact to GitHub
- mark the job `posted` on success
- mark the job `failed` with durable failure details on failure
- emit a follow-up handoff job only after successful review post

### 7.3 Operator legibility requirements
The system must make it possible to answer:
- which PRs are pending first-pass review?
- which review job is running right now?
- which jobs failed, and why?
- how many attempts has a job had?
- did a PR fail because of malformed title, runtime/auth error, filesystem permissions, or posting failure?

## 8. Data Model

A dedicated `review_jobs` model should exist, separate from PR lifecycle tracking.

### Recommended states
- `pending` — job created and waiting to be claimed
- `in_progress` — worker has claimed the job
- `posted` — review successfully posted to GitHub
- `failed` — worker attempt failed; job remains inspectable/retryable
- `malformed` — terminal invalid PR-title state

### Suggested fields
- `id`
- `repo`
- `pr_number`
- `pr_title`
- `reviewer_model`
- `bot_token_env`
- `linear_ticket`
- `status`
- `attempts`
- `created_at`
- `claimed_at`
- `finished_at`
- `failure_message`
- `review_artifact_path` (optional)
- `source` (optional, e.g. `watcher`)

### Important separation
Keep these as separate concepts:
- **PR lifecycle state**: `open`, `merged`, `closed`
- **review delivery state**: `pending`, `in_progress`, `posted`, `failed`, `malformed`

Do not collapse them into one field.

## 9. Storage Options

Two acceptable shapes:

### Option A — SQLite-backed `review_jobs`
Pros:
- already using SQLite in `reviews.db`
- easy uniqueness guarantees and atomic claim/update semantics
- easier later for ledger/cockpit queries

Cons:
- less immediately inspectable than file queue dirs for casual humans

### Option B — filesystem job queue
Pros:
- very legible
- naturally aligns with current `follow-up-jobs/pending/` pattern
- easy manual requeue by moving files

Cons:
- more custom claim/collision handling
- more moving pieces if later merged into ledger queries

### Recommendation
Use the smallest shape that fits the current repo well.

Bias:
- if speed and operator legibility matter most immediately, filesystem queue is acceptable
- if aligning with future cockpit/ledger queries matters more, prefer SQLite

Either is fine for this slice as long as the semantic boundary is real.

## 10. Transitional Implementation Strategy

Do **not** over-rotate into a giant multi-daemon architecture immediately.

### Phase 1 — semantic split, minimal ops churn
- watcher creates durable jobs
- same long-running service may still claim/process pending jobs after the poll cycle
- execution must still occur through the job abstraction, not inline ad hoc state

This gives the architecture win now without requiring a whole new service topology.

### Phase 2 — explicit producer/consumer split
- separate long-running review worker if needed
- cleaner isolation of polling vs execution
- easier concurrency limits and independent restart behavior

### Why this transition is acceptable
The important thing is not “number of processes.”
The important thing is **number of semantic boundaries**.

A single process can still honor the durable job boundary if it:
- records the job first
- claims it through explicit state transition
- records posted/failed after execution

## 11. Retry Policy

For the first slice, prefer bounded simplicity.

### Required
- failed jobs must remain visible
- failure message must be durable
- retry must be possible without rewriting history or losing prior attempts

### Optional in first slice
- automatic backoff retries
- max-attempt terminalization
- dead-letter queue

### Recommendation
Start with:
- durable failed jobs
- manual or explicit requeue path
- clear attempt count

Then add automatic retry policy only after the operator path is already trustworthy.

## 12. Runtime / Substrate Constraints

This work must preserve the real operational lessons from April 2026.

### 12.1 Principal/runtime truth matters
The current system has multiple distinct ownership planes:
- process owner
- `HOME`
- OAuth/auth file owner
- GitHub CLI state owner

## 13. `stale-drift` operator label

`stale-drift` is an explicit operator override that suppresses automated review work on an open PR.

- Watcher behavior: after malformed-title evaluation, the watcher skips first-pass review when the PR has a `stale-drift` label.
- Follow-up behavior: the consume path stops without spawning a remediation worker when the PR is open and labeled `stale-drift`.
- Reconcile behavior: if a worker was already spawned and the label appears before reconcile, the job stops with `stopCode=stale-drift` and preserves the fact that a worker had already run.
- Precedence: merged / closed PR states outrank `stale-drift` for follow-up stop-code reporting. A merged labeled PR records `operator-merged-pr`; a closed labeled PR records `operator-closed-pr`.
- Re-arming: removing the label only affects future watcher / follow-up passes. It does not automatically requeue a stopped remediation job; operators still use the documented requeue / retrigger commands.
- Failure mode: when live `gh pr view` succeeds, the current label set is mirrored into `reviews.db`. If a later consume/reconcile attempt has to fall back to the mirror, the last mirrored label snapshot is used for `stale-drift` checks rather than silently treating labels as absent.
- readable source tree owner

The refactor must not hide these behind “it should work” assumptions.

### 12.2 Codex invocation hints remain first-class
When Codex is involved, preserve the known machine-specific lessons:
- do not casually mix principals
- treat `HOME` and `CODEX_AUTH_PATH` as part of a single runtime contract
- prefer argv prompt transport for automation
- validate output artifacts, not just stderr vibes

### 12.3 Cross-user filesystem contract remains real
As of 2026-04-22:
- canonical watcher runtime owner is `placey`
- shared source currently lives under `/Users/airlock/agent-os/tools`
- that tree must remain group-readable/traversable by `staff`
- `/Users/airlock` must remain readable/traversable enough for `placey` (`750` currently)

This spec should not assume those constraints disappear just because job semantics improve.

## 13. Relationship to Remediation Loop

This first-pass review refactor should converge with, not compete with, the remediation flow.

Desired future shape:

```text
PR discovered
  -> review job created
  -> review posted
  -> follow-up job created
  -> remediation worker consumes follow-up job
```

This creates a coherent pipeline:
- discovery plane
- review delivery plane
- remediation plane

All three become inspectable and retryable instead of being hidden inside one watcher loop.

## 14. Acceptance Criteria

This slice is successful when:
- a new eligible PR results in a durable first-pass review job
- watcher no longer claims review completion merely because it discovered the PR
- a worker can claim and process a pending review job
- successful GitHub post moves the job to `posted`
- failed execution moves the job to `failed` with durable failure details
- malformed PR titles remain explicit terminal failures
- operator can inspect pending/in-progress/failed/posted review state without guessing from logs
- the design does not regress the current follow-up handoff behavior after successful review posts

## 15. Recommended Ticket Split

### Ticket A — durable first-pass review jobs
- add `review_jobs` storage model
- change watcher to create/refresh jobs instead of owning inline completion
- preserve malformed-title terminal behavior

### Ticket B — review worker consumer
- create worker claim/execute/post/fail path
- capture durable failure reason
- preserve current reviewer model routing

### Ticket C — operator controls / docs
- document manual retry / requeue path
- expose a minimal operator inspection path
- update runbooks with the new truth model

## 16. Recommendation

Land this next.

Why:
- it directly addresses the failure mode just experienced in production
- it aligns first-pass review with the remediation architecture already underway
- it improves truthfulness and operability more than almost any other adversarial-review refactor of similar size

This is not speculative architecture work.
It is the shortest path from “polling loop with hidden semantics” to “small real system with honest state.”
