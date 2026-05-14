# Adversarial Code Review System — Spec (original v1)

> **Note:** this is the original product spec from when the system was first
> designed. It is preserved here as a historical artifact, not as the current
> canonical contract. The current contracts live in:
>
> - [`docs/SPEC-adversarial-review-auto-remediation.md`](../SPEC-adversarial-review-auto-remediation.md) — current living contract for review + remediation
> - [`docs/ARCH-adversarial-review-adapter-architecture.md`](../ARCH-adversarial-review-adapter-architecture.md) — adapter architecture
> - [`docs/STATE-MACHINE.md`](../STATE-MACHINE.md) — durable state machines
> - [`docs/follow-up-runbook.md`](../follow-up-runbook.md) — operator runbook
>
> Read this file for *why* the system exists and what its founding constraints
> were. Read the docs above for *how* it's actually built today.

## Problem

AI coding agents tend to be sycophantic toward their own output. A Claude-written PR reviewed by Claude will often pass with minimal critique. Same-model review is a rubber stamp, not a quality gate.

A second failure mode is context starvation: reviewing only the diff without the governing specs/runbooks can produce shallow or misleading feedback on architecture-heavy PRs.

## Solution

Enforce adversarial cross-model review: the agent that builds the code is never the agent that reviews it. Claude Code and Codex have different training, tendencies, and blind spots — each will catch things the other misses.

For spec-driven projects, require PR authors to link the governing specs/runbooks/briefs in the PR body or top-level PR comments, and have the reviewer fetch those linked docs and include them as review context.

---

## Routing Rules

| Builder | Reviewer |  
|---|---|  
| Claude Code | Codex |  
| Codex (one-off / Clio-delegated) | Claude Code |  
| Clio sub-agent (Claude) | Codex |

**Default fallback:** If builder cannot be determined, Codex reviews.

---

## PR Author Detection

Reviewer routing is determined by the PR author identity. Convention:

- PRs opened by Claude Code → commit author email contains `claude` or PR title tagged `[claude-code]`  
- PRs opened by Codex → commit author email contains `codex` or PR title tagged `[codex]`  
- PRs opened by Clio sub-agents → commit author is `clio@laceyenterprises.com`

Agent author tagging is the responsibility of the build workflow — in this repo, the canonical helper is `npm run pr:create:tagged` (see `src/pr-create-tagged.mjs`), which prepends the worker-class prefix before opening the PR. Higher-level dispatchers (e.g. Clio's coding-agent skill) wrap that helper or include the tag instruction in the worker prompt.

---

## Reviewer Prompt (Standard)

All review agents receive this adversarial framing — non-negotiable:

```  
You are performing an adversarial code review. You did NOT write this code.

Your job is to find problems. Specifically:  
- Bugs and edge cases the author missed  
- Security vulnerabilities (injections, auth gaps, secret leakage, unsafe deps)  
- Design flaws (wrong abstraction, fragile coupling, missing error handling)  
- Performance issues  
- Anything that would fail in production

Do NOT summarize what the code does. Do NOT praise. Be specific and direct.  
For each issue: state the file, line(s), the problem, and the recommended fix.

If you find nothing substantive, say so plainly — but look hard first.  
```

### Spec-touch enforcement

The reviewer prompt treats silent contract drift as a blocking issue. The rule is intentionally scoped to explicit ownership mappings instead of "any Python anywhere," because remediation only converges when the changed-path -\> governing-spec mapping is deterministic.

Current ownership map:

- `modules/worker-pool/lib/python/**/*.py` -\> `projects/worker-pool/SPEC.md`  
- `modules/main-catchup/lib/python/**/*.py` -\> `projects/main-catchup/SPEC.md`  
- `platform/session-ledger/src/session_ledger/**/*.py` -\> `docs/SPEC-session-ledger-control-plane.md`  
- `platform/session-ledger/src/session_ledger/migrations/*.sql` -\> `docs/SPEC-session-ledger-control-plane.md`  
- `modules/worker-pool/bin/hq` and `modules/worker-pool/lib/hq-*.sh` -\> `projects/worker-pool/SPEC.md`

Trigger only on public contract changes in those paths:

- public Python function or method signature changes (parameter lists or return types only)  
- new or altered SQL migrations in session-ledger  
- new or altered `hq` CLI subcommands or flags

Do **not** trigger on private `_helpers`, cosmetic docstring edits, or unanchored mentions of `worker_events`. The earlier unscoped `worker_events` bullet was removed because it lacked a stable file/schema anchor and created false-positive / false-negative churn.

When the reviewer blocks on this rule, the message is a template with filled slots, not a byte-exact literal: `Contract changed without spec update. The diff modifies {thing} in {path}, but {specPath} was not touched. Either update the governing spec to match, or revert the contract change. Spec-as-source-of-truth is load-bearing; silent drift is the dominant maintenance risk from the 2026-05-04 operator retrospective.`

Final-round interaction is explicit: spec-touch findings stay **blocking** on the lenient final round because they are broken external-contract drift, not documentation nits. The lenient addendum still governs everything else.

---

## System Architecture

```  
GitHub PR opened  
        │  
        ▼  
  PR Watcher (polling or webhook)  
        │  
        ├── detect author → determine reviewer model  
        │  
        ▼  
  Reviewer Agent spawned  
  (adversarial prompt \+ PR diff \+ repo context)  
        │  
        ▼  
  Review posted to GitHub PR as comment  
  (via gh CLI or GitHub API)  
        │  
        ▼  
  Durable follow-up handoff queued  
  (explicit job artifact, pending consumption)  
        │  
        ▼  
  Linear ticket updated: "Review complete"  
```

---

## Components

### 1. PR Watcher  
- Polls GitHub for new PRs on watched repos (or receives webhook)  
- Detects author from commit metadata or PR title tag  
- Triggers reviewer agent with correct model assignment  
- Runs as a persistent service or cron (interval TBD — suggest 5 min)

### 2. Reviewer Agent  
- Spawned by PR Watcher via Clio's `sessions_spawn` or `coding-agent` skill  
- Receives: repo URL, PR number, diff, adversarial prompt  
- Posts review as a GitHub PR comment via `gh pr review`  
- Reports back to Clio when complete

### 3. Author Tagging Convention  
- All agent-built PRs must include author tag in PR title or commit message  
- Canonical helper (`npm run pr:create:tagged`, source in `src/pr-create-tagged.mjs`) is the owned, in-repo build-time path for tagging  
- Clio's coding-agent skill ensures dispatched workers include the tag instruction in the prompt, so workers opening PRs via plain `gh` still tag correctly  
- Format: `[claude-code]`, `[codex]`, `[clio-agent]`

### 4. Linear Integration  
- When a PR is reviewed, update the associated Linear ticket status  
- Ticket transitions: `In Review` → `Review Complete`  
- If reviewer finds critical issues: flag ticket for Paul's attention

### 5. Follow-up Handoff Queue (first slice)
- After a GitHub review post succeeds, write a durable JSON job under `data/follow-up-jobs/pending/`
- Record repo, PR number, reviewer model, review summary/body, criticality, and recommended follow-up action
- Review, follow-up remediation, comment-delivery, and operator-mutation records carry the additive subject identity fields `domainId`, `subjectExternalId`, and `revisionRef` (SQLite: `domain_id`, `subject_external_id`, `revision_ref`) alongside legacy `repo` / `pr_number`. Legacy rows that predate persisted PR head SHA keep `revisionRef = null`; migrations backfill the `code-pr` revision only when a head SHA column is available and never synthesize one.
- Clean verdicts (`Comment only` / `Approved`) still get a durable job as the verdict carrier; the follow-up consumer records them as settled without spawning a remediation worker
- Keep the handoff explicit and append-only; do not hide it behind undocumented local hooks
- This queue is the minimal bridge until session-aware continuation exists natively

### 5.1 Follow-up worker completion reconciliation (bounded next slice)
- A detached remediation worker launch must not be treated as terminal queue success by itself
- The queue must expose explicit terminal states for launched remediation work: `completed` and `failed`
- Reconciliation may remain one-shot/manual in this slice; it does not need a new long-running daemon
- Current bounded contract:
- inspect only `in_progress` jobs whose `remediationWorker.state` is `spawned`
- if the recorded worker PID is still live, leave the job `in_progress`
- if the PID is gone and the recorded final-message artifact exists with non-empty content, move the job to `completed`
- if a remediation reply artifact path is recorded, reconciliation must read and validate that JSON before trusting the terminal completion
- if the validated reply sets `reReview.requested = true`, reconciliation must explicitly reset the matching watcher delivery row to `review_status = pending` so the next adversarial review pass is a durable queued state transition rather than prose-only intent
- if watcher state blocks that reset (for example malformed-title terminal state or a non-open PR), reconciliation must preserve that blocked outcome explicitly on the follow-up job for operator inspection instead of silently forcing another review
- if the PID is gone and the final-message artifact is missing or empty, move the job to `failed`
- Reconciled terminal records must preserve operator-visible metadata: worker PID, workspace path, log path, final-message path, and a short completion preview or explicit failure reason
- This slice preserves wrapper-owned review completion semantics; it does not grant the remediation worker ownership of the GitHub review side effect

### 5.1.1 Bounded remediation rounds (LAC-206 slice; convergence-loop revision 2026-05-06)
- Follow-up remediation must not remain an implicit one-shot with no durable path for a second bounded pass
- Each follow-up job must carry an explicit bounded remediation plan:
- `mode = bounded-manual-rounds`
- `maxRounds` cap stored durably in the job record. **Current bounded defaults (post-2026-05-06):** `low: 1`, `medium: 2` (default), `high: 3`, `critical: 4`. Higher-risk PRs get more rounds because that's where you most want the bot to converge before pulling the operator in — the cost of pulling operator attention rises with criticality. (Pre-2026-05-06 medium was `1` and critical was `3`; both bumped, medium for the auto-queued retry round and critical for one extra iteration on the highest-risk class.) The cap is enforced PR-wide: each new follow-up job is seeded with the PR's prior accumulated remediation rounds so `claimNextFollowUpJob` stops the bounded loop once the PR exhausts its budget. Fresh jobs re-derive the default cap from the current risk class; the watcher carries forward only an elevated latest `maxRounds` when it is higher than the current risk-class tier, preserving legacy in-flight PRs and explicit operator-raised escape hatches that would otherwise be silently truncated.
- After every remediation round (whether the cap is consumed or not), the watcher always queues a fresh adversarial review pass — the rereview is never skipped on a "budget exhausted" condition. Rationale: the reviewer's verdict is the only signal that can replace a stale `Request changes`, so skipping the rereview after remediation strands converged work behind a stale verdict. The cap on the convergence loop lives entirely on the remediation-enqueue side (`claimNextFollowUpJob` refuses `currentRound \>= maxRounds`).
- Stage-keyed prompts are part of this bounded-loop contract. Reviewer passes load `prompts/code-pr/reviewer.first.md`, `reviewer.middle.md`, or `reviewer.last.md` via `pickReviewerStage(reviewAttemptNumber, completedRemediationRounds, maxRemediationRounds)`. The safe default is `first` unless the caller can prove the run is mid-cycle; `middle` is reserved for re-reviews after at least one completed remediation round, and `last` is used only once the completed-round count reaches the stored cap. Remediation workers likewise load `prompts/code-pr/remediator.{first,middle,last}.md` via `pickRemediatorStage(remediationRound, maxRemediationRounds)`, with invalid or missing round context falling back to `first` instead of silently using a mid-cycle prompt.
- Remediation workers rebase the checked-out PR branch onto `origin/main` before changing code in every prompt stage. That rebase rewrites the PR head SHA, so any head-scoped operator label decision (`operator-approved`, `merge-agent-requested`) that was attached to the pre-rebase head becomes stale until it is re-applied to the new head. The watcher intentionally evaluates those labels against the current head SHA on every tick; operators debugging a post-remediation head change must reason about the rebased head, not the pre-rebase label event.
- After the cap is consumed, the final adversarial review pass runs with the lenient final-round verdict-categorization addendum embedded in `prompts/code-pr/reviewer.last.md`; that addendum relaxes the categorization bar so non-critical findings move to `## Non-blocking issues`, but it does not relax the merge gate — the verdict stays `Request changes` whenever any finding remains, so PRs with known unresolved issues do not silently auto-merge.
- Operator merge-agent labels:
- `operator-approved` is the operator's current-head merge approval when they have decided the substance is fine. The watcher resolves the latest matching GitHub `labeled` event from the PR timeline and accepts the label only when that event is attributable, occurs after the timeline code event for the current head SHA, and was not applied by the PR author. The label can bypass review/remediation-state gates, but it does NOT bypass closed/merged PRs, not-mergeable state, failed, pending, or unknown CI, or explicit skip labels.
- `merge-agent-requested` is a stronger one-shot operator request to dispatch merge-agent so it can clean or rebase a stuck branch. The watcher resolves the latest matching GitHub `labeled` event and accepts the label only when that event is attributable and scoped to the current head SHA; stale or unattributed label events produce `skip-merge-agent-requested-stale`. When scoped, the label can bypass missing/unknown verdicts, current mergeability, failed or pending checks, and remediation-round gates, but it does NOT bypass closed/merged PRs, active remediation, explicit skip labels, or duplicate dispatch protection.
- `merge-agent-skip`, `merge-agent-stuck`, and `do-not-merge` are explicit skip labels. They win over both override labels and return `skip-operator-skip`.
- Merge-agent dispatch precedence is: closed/merged PRs; explicit skip labels; scoped `operator-approved` hard gates; active remediation; the normal verdict/mergeable/check/remediation gates; a scoped `merge-agent-requested` override for bypassable gates; stale `operator-approved` diagnostics only when no dispatch path applies; duplicate-dispatch protection; dispatch. When a scoped `merge-agent-requested` label is present on a PR that the normal path would already dispatch without an operator trigger, the request label is treated as the authorizing trigger so the one-shot operator request is consumed. A successful dispatch removes only the label that actually authorized that dispatch, preserving unused operator labels as audit trail.
- `currentRound` plus append-only `rounds[]` history for operator inspection
- Starting a worker consumes exactly one round and records round claim/spawn metadata durably
- Advancing to another round must remain explicit and operator-visible; do not hide it inside an autonomous retry loop
- Bounded-stop conditions in this slice must be durable and operator-visible:
- `max-rounds-reached` when another round would exceed the stored `maxRounds` cap
- `no-progress` when a remediation round finishes without a durable `reReview.requested = true` signal and the loop would otherwise stall ambiguously
- `operator-stop` when a human explicitly stops the job
- Stopped jobs must carry machine-readable stop metadata in addition to human-readable reason text
- Manual or scripted requeue is acceptable in this slice; a fully autonomous multi-round loop is intentionally deferred

### 5.1.1.1 Adversarial gate commit status
- The watcher projects the durable adversarial-review ledger onto the PR head SHA as the GitHub commit status context `agent-os/adversarial-gate` by default
- Branch protection must require `agent-os/adversarial-gate` before operators rely on GitHub-native merge or auto-merge for adversarial-review-gated branches. Without that required context, GitHub can merge while the durable review/remediation loop is still pending or blocked. Deployments may opt into a different context with `ADV_GATE_STATUS_CONTEXT`, but the override must be applied consistently to every watcher and branch-protection probe.
- The watcher checks watched repositories' branch protection for the configured required gate context on a cached interval and emits `branch-protection-warning` when the context is absent, when the protection endpoint cannot be read, or when `ADV_GATE_STATUS_CONTEXT` is invalid. Operators can run `npm run check-branch-protection` for the same check outside the watcher.
- Gate state mapping:
- `pending`: no review has posted, a review is queued/in progress, remediation is queued/in progress, or a requested re-review has not posted yet
- `success`: the latest posted review settled as `Comment only` or `Approved` in its durable follow-up verdict carrier, or a current scoped `operator-approved` label accepts the PR head regardless of review/remediation state
- `failure`: malformed/failed/failed-orphan review state, missing follow-up ledger or verdict, failed/stopped remediation, unresolved `Request changes` verdict, stale/ineligible operator approval, or any unknown ledger/verdict state
- The gate is projected on terminal watcher branches, including already-posted rows, so a PR does not remain stuck at a previous `pending` projection after the review verdict settles.

### 5.1.2 Remediation reply contract for re-review requests (LAC-209 slice)
- Remediation output must expose a durable machine-readable reply contract in addition to any prose final message
- The contract must not hide a re-review request only inside Markdown text
- Each follow-up job must carry explicit remediation-reply metadata, including the expected artifact path once a worker is spawned
- The ONLY canonical remediation-reply location is `HQ_ROOT/dispatch/remediation-replies/<LRQ_ID>/remediation-reply.json`
- Legacy worktree path `.adversarial-follow-up/remediation-reply.json` is forbidden for new remediation rounds and must never be committed in a PR branch
- The worker reply artifact must be JSON with a stable kind/schema, job identity, outcome summary, validation/blocker fields, and a `reReview` object
- Structured remediation replies may include per-finding accountability arrays: `addressed[]`, `pushback[]`, and `blockers[]`. When the adversarial review supplies `Title:` fields for blocking findings, each corresponding reply entry must carry the same title. Title comparison is tolerant of case, Unicode dash variants, smart/straight quotes, and whitespace normalization, while public error messages preserve the original expected and supplied title text.
- Public reply text fields that can render into PR comments (`summary`, `validation[]`, `finding`, `action`, `reasoning`, `needsHumanInput`, and `reReview.reason`) must be concise and human-readable. Per-finding text fields are capped at 1200 characters and 20 non-empty lines, reject raw JSON/log/tool-output/traceback/diff shapes, and reject markdown code blocks only when a line begins with a fence opener.
- The PR-comment renderer applies the same public-noise detector before rendering per-finding text and then redacts secrets and host-local paths. Renderer length caps may be slightly larger than validator raw-text caps so redaction expansion does not truncate placeholders mid-token.
- String `blockers[]` entries are legacy/salvage-only compatibility for persisted or hand-edited artifacts that bypass strict validation. Newly spawned workers must use structured blocker objects under this contract.
- Durable re-review request signal in this slice: `reReview.requested = true`
- If `reReview.requested` is true, the reply must also include a short operator-visible reason
- `LAC-210` consumes this reply contract during reconciliation: a valid explicit request resets watcher delivery state to a durable pending re-review, while blocked paths remain operator-visible and do not bypass malformed-title or closed/merged safeguards
- This still must not create an implicit infinite autonomous loop; remediation-round caps and explicit terminal states remain authoritative, and manual/operator recovery semantics remain documented for blocked or invalid reply cases

Worker prompt env contract for the canonical reply path:

| Env var | Required value | Purpose |
|---|---|---|
| `HQ_ROOT` | absolute path to the HQ checkout | base directory for durable remediation-reply storage |
| `LRQ_ID` | launch request id / reply storage key for the round | selects `dispatch/remediation-replies/<LRQ_ID>/` |

### 5.1.3 Operator retrigger workflow
- Manual recovery remains explicit and operator-visible; it must not require hand-editing SQLite rows or queue JSON
- `retrigger-review` is the canonical operator surface for re-arming the watcher row to `review_status='pending'`
- `retrigger-remediation` is the canonical operator surface for authorizing one more remediation round on the latest terminal follow-up job without directly mutating the watcher row. **It has two equivalent invocations**:
- **CLI**: `npm run retrigger-remediation -- --repo <slug> --pr <n> --reason "..."` — the canonical shell-side surface, audit-rich, suitable for scripted operator workflows.
- **PR-side label** (post-2026-05-06): the operator applies the `retrigger-remediation` label to the PR (mobile-friendly via the GitHub iOS / Android app or web UI). The watcher resolves the matching GitHub `labeled` event, records that event id and actor, calls `bumpRemediationBudget` (raises `maxRounds`) AND `requestReviewRereview` (re-arms the watcher row to `review_status='pending'` so a fresh review fires next tick), appends an operator-mutation audit row with `source: pr-label`, and removes the label after success. **The label handler does NOT call `requeueFollowUpJobForNextRound`** — letting the natural convergence cycle drive (review fires; if verdict is still `Request changes`, the reviewer creates a new follow-up job which the daemon claims and spawns) preserves the loop's expected sequencing. The CLI keeps its old "bump + force-requeue" behavior for operators who explicitly want to skip the review step. If the latest follow-up job is still active (pending/in-progress), a new unconsumed label event is left in place for the next tick. Once a label event is consumed, stale replays of that same event only retry audit/label cleanup and must not bump budget again, even if the job later halts again.

  The 2026-05-06 motivation for the no-force-requeue split: during PR #48's live verification, the prior label-handler shape called both `bumpRemediationBudget` and `requeueFollowUpJobForNextRound`. Bumping the budget unblocked the watcher's gate and a fresh review started spawning. Concurrently, the requeue moved the job to `pending`, the daemon claimed it, and a remediation worker started — the worker pushed commits BEFORE the review verdict was even posted. The convergence loop's "review then remediation" sequencing was violated.
- `retrigger-remediation` may requeue only terminal jobs in:
- `failed`
- `completed` when the prior round left `reReview.requested = true`
- `stopped:max-rounds-reached`
- `stopped:round-budget-exhausted`
- Operator-triggered mutations must be durably audited on the job record (`operatorRetriggerAudit[]`) and in a repo-local operator-mutation ledger under `data/operator-mutations/` by default; alternate roots may be configured explicitly
- Operator-triggered mutations must be idempotent across calendar boundaries; the key space is global, not monthly
- A replay of a previously successful operator-mutation key is a no-op success
- Previously refused operator-mutation keys remain visible in the ledger for operator history but do not block a later retry after state changes
- Existing public CLI contracts remain stable: blocked operator outcomes must stay distinct from usage errors in exit codes and docs

### 5.2 Remediation worker launch contract (new hardening requirements)
- A detached remediation launch must not treat \"process spawned\" as equivalent to \"durable worker established\"
- Required control-plane distinctions:
- launch command issued
- worker/session registration created
- startup receipt emitted
- transport/attach healthy
- active progress observed
- terminal outcome recorded
- Minimum hardening requirements for remediation workers:
- preflight contract before launch covering repo / PR / branch target, runtime path, cwd, auth principal, lane classification (`builder` vs `integration`), and expected edit / commit / push / PR reply authority
- startup receipt within a bounded timeout; if no receipt arrives, classify as launch failure rather than leaving the run ambiguously spawned
- durable launch metadata recording the exact launch shape, expected artifact paths, and timeout semantics so failures remain diagnosable after wrapper death
- progress evidence beyond PID existence; PID-only liveness is insufficient as a durable success signal
- explicit failure classification separating launch failure, attach/transport failure, permission-blocked worker, artifact-missing completion, and successful completion
- Ticket mapping:
- `LAC-207` should not be considered production-complete if success still effectively means only \"spawned a detached process\"
- `LAC-208` should carry the durable per-PR / per-run ledger state needed to model the distinctions above
- `LAC-209` and `LAC-210` should build on explicit terminal and reply states rather than implicit worker disappearance
- `LAC-212` should document the operator-visible meaning of each state plus the manual recovery path

### 6. Review completion semantics (current vs target)

**Current implementation: A semantics (wrapper-owned completion)**
- reviewer runtime generates review text/artifact
- outer wrapper captures the final output artifact
- wrapper posts the PR review comment itself
- wrapper then writes the durable follow-up handoff artifact

This is true whether the substrate is direct CLI, ACPX, or another sessionful runtime. The current production question is operational reliability, not semantic impossibility.

**Target future architecture: B semantics (delegated-worker-owned completion)**
- delegated job/session owns the completion side effect directly
- outer orchestration layer trusts explicit completion artifacts/events instead of scraping final output and manually replaying the PR comment
- session/job ownership, retries, and auditability become first-class contracts rather than wrapper convention

**Operational lesson from 2026-04-20/21 debugging**
- we lost time pushing toward B-shaped behavior while debugging ACPX/Codex invocation mechanics
- the faster restore path was to preserve the known-good A-style review-post contract and swap only the transport/auth layer underneath it
- file-based final-output handoff is a valid A-style bridge when using sessionful Codex/ACPX substrates

---

## Repos in Scope (Initial)

- `laceyenterprises/clio` — this repo  
- Any repo where Clio delegates a coding agent task

---

## GitHub Bot Accounts

Reviews are posted by dedicated bot accounts — not Clio's personal account — so the reviewer identity is visible in the PR timeline.

| Bot Account | Posts Reviews For |  
|---|---|  
| `codex-reviewer` | PRs built by Claude Code |  
| `claude-reviewer` | PRs built by Codex or Clio sub-agents |

### Setup Prerequisites  
- Create two GitHub accounts: `codex-reviewer` and `claude-reviewer`  
- Add both as members of the `laceyenterprises` org with write access to covered repos  
- Generate a personal access token (PAT) for each with `pull_requests: write` scope  
- Store tokens in 1Password (Cliovault): items `"GitHub Bot — codex-reviewer"` and `"GitHub Bot — claude-reviewer"`  
- Wire tokens into the reviewer agent config via `op://` references

---

## Out of Scope (v1)

- Human code review — this system is agent-to-agent only  
- Auto-merge on clean review — Paul merges manually  
- Multi-round review cycles — one review pass per PR in v1  
- Review of PRs Paul opens himself
- Resuming the original build session with full context preservation (target future architecture, not tonight's slice)

---

## Codex runtime debrief note (2026-04-21)

For this system on laceyent-mbpro, the durable Codex runtime contract is now:
- long-running watcher runs as `placey`
- Codex prompt passed as argv, not stdin
- `codex exec --dangerously-bypass-approvals-and-sandbox --ephemeral --output-last-message <file>`
- outer wrapper remains responsible for validation + GitHub posting

Explicit anti-patterns from the PR #19 debugging session:
- mixed-principal `airlock` watcher with borrowed `placey` auth path as the main resident contract
- stdin-fed prompt transport as the default noninteractive path
- accepting scary stderr as fatal without checking the output artifact/body
- appending wrapper template sections after an already-complete Codex review body

See also: `docs/POSTMORTEM-codex-cross-user-invocation-2026-04-21.md` and `docs/RUNBOOK-codex-invocation-contracts.md`.

## Open Questions

1. **Webhook vs polling?** Webhook is more responsive but requires a public endpoint (or ngrok/Tailscale tunnel). Polling is simpler for now.  
2. **What repos does the watcher cover?** Start with `laceyenterprises/clio` only, expand to the broader agent-built repo fleet as it grows.  
3. **Codex API access** — confirm Codex is accessible via OpenAI API for spawned reviewer agents (it is, via litellm-local).  
4. **Max concurrent reviews** — respect the 2–3 parallel agent limit from WORKING_INSTRUCTIONS.md.

---

## Dependencies

- `gh` CLI configured with `laceyenterprises` org access  
- Codex reviewer path available locally (current working implementation uses native Codex CLI / ACPX execution, not just a generic model alias)  
- Claude Code available via `litellm-local/claude-sonnet-4-6`  
- Linear API configured (`\~/clio/credentials/local/linear.env`)  
- In-repo `npm run pr:create:tagged` helper (source: `src/pr-create-tagged.mjs`) — the owned build-time path for worker-class title prefixing; replaces any prior reliance on external build-time tooling

### Codex reviewer auth contract
For Codex-backed review workers, OAuth identity selection must be treated as part of the runtime contract.

Required rules (current operational patch):
- do not trust ambient `codex login status` from the launching user alone
- validate the intended `auth.json` directly and require `auth_mode: chatgpt`
- pass `CODEX_AUTH_PATH` explicitly when the intended Codex principal is not the launch user's default local state
- keep worker `HOME` compatible with the local GitHub/runtime context needed by the wrapper
- strip `OPENAI_API_KEY` from the subprocess environment so Codex does not silently prefer API-key auth

Observed incident/fix sequence (2026-04-20):
- `airlock` local Codex state reported `auth_mode: apikey`
- valid OAuth state existed at `/Users/placey/.codex/auth.json`
- initial patch path copied/staged auth into `airlock/.codex`, which still produced a broken execution path in the watcher
- durable operational fix for the watcher/reviewer pipeline was the split contract:
  - `HOME=/Users/airlock`
  - `CODEX_AUTH_PATH=/Users/placey/.codex/auth.json`
- this allowed `gh` to work from the launch user's normal environment while forcing Codex to the correct OAuth principal

Architectural direction:
- this split-contract patch should be treated as a compatibility bridge
- long term, the spawner/worker should receive a native principal grant/materialized auth view from the routing/broker layer and should not need to care about user-home path trivia
- the normal block reason should be principal unavailability / reauth / allowance exhaustion, not incorrect auth-path selection

---

## Success Criteria

- [ ] Every agent-built PR in covered repos gets a review from the opposing model within 10 minutes  
- [ ] Review is substantive (adversarial prompt enforced — no empty approvals)  
- [ ] Author detection works reliably from PR title tags  
- [ ] Linear ticket updated on review completion  
- [ ] Successful review posts create a durable, explicit follow-up handoff artifact  
- [ ] Paul can see all pending/completed reviews from Linear

---

## Next Steps (post-approval)

1. Create Linear project: "Adversarial Code Review"  
2. Break into tickets:  
   - PR Watcher service (polling)  
   - Reviewer Agent wrapper  
   - Author tagging convention \+ enforcement  
   - GitHub API integration  
   - Linear status update hook  
3. Assign to coding agents per WORKING_INSTRUCTIONS.md queue process  
