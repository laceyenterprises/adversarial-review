---
delegation: full
confidence: 0.9
last_verified: 2026-04-05
influence_weight: medium
tags: [adversarial-review-hq, documentation, reference]
staleness_window: 90d
---
# Adversarial Code Review Service

Enforces cross-model review of agent-built PRs: the model that builds the code never reviews it.

| Builder | Reviewer |
|---|---|
| `[claude-code]` or `[clio-agent]` | Codex / GPT-4o (`codex-reviewer-lacey`) |
| `[codex]` | Claude Sonnet (`claude-reviewer-lacey`) |
| No/invalid tag | **Fail-loud guardrail** (PR comment + terminal watcher failure record), no review spawned |

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Fill in all values
```

Required env vars:

| Variable | Purpose |
|---|---|
| `GITHUB_TOKEN` | Read PRs from watched repos |
| `GH_CODEX_REVIEWER_TOKEN` | PAT for `codex-reviewer-lacey` bot |
| `GH_CLAUDE_REVIEWER_TOKEN` | PAT for `claude-reviewer-lacey` bot |
| `OPENAI_API_KEY` | GPT-4o reviewer (codex path) |
| `ANTHROPIC_API_KEY` | Claude Sonnet reviewer (claude path) |
| `LINEAR_API_KEY` | Ticket status updates |

### 3. GitHub bot accounts

Create two GitHub accounts and add them to the `laceyenterprises` org with write access to covered repos:

- `codex-reviewer-lacey` — posts reviews on Claude/Clio PRs
- `claude-reviewer-lacey` — posts reviews on Codex PRs

Generate a PAT for each with `pull_requests: write` scope. Store tokens in 1Password (Cliovault).

### 4. Configure watched repos

Edit `config.json`:

```json
{
  "repos": ["laceyenterprises/clio"],
  "pollIntervalMs": 300000,
  "linear": {
    "teamKey": "LAC"
  }
}
```

## Usage

### Prompt location

The long-form adversarial reviewer prompt lives in:

```bash
prompts/reviewer-prompt.md
```

Design rule: prompt text that humans are expected to tune over time should live in standalone Markdown artifacts, not inline string literals buried in runtime code.


### Start the watcher (polls every 5 minutes)

```bash
npm start
```

### Run a one-shot review manually

```bash
node src/reviewer.mjs '{"repo":"laceyenterprises/clio","prNumber":42,"reviewerModel":"codex","botTokenEnv":"GH_CODEX_REVIEWER_TOKEN","linearTicketId":"LAC-42"}'
```

## How it works

1. **Watcher** polls configured repos every `pollIntervalMs` ms
2. Detects PR author tag from PR title (`[claude-code]`, `[codex]`, `[clio-agent]`)
3. If tag is missing/invalid, triggers fail-loud signaling (PR comment + structured watcher failure log/record) and does **not** spawn review
4. Malformed-title records are terminal by design: retitling an existing PR does not retrigger review
5. Uses durable delivery state in `data/reviews.db` instead of a binary seen/not-seen flag
   - `pending` = picked up / attempt in flight
   - `posted` = review successfully posted to GitHub (terminal success)
   - `failed` = attempt failed and should be retried on a later poll
   - `malformed` = PR title malformed; terminal failure until human creates a correctly tagged PR
6. Sets Linear ticket to **In Review** state
7. Spawns **Reviewer Agent** as a child process
8. Reviewer fetches diff via `gh pr diff`, sends to AI model with adversarial prompt
   - **Codex path:** Uses native Codex CLI with OAuth credentials (not ACPX) — see `docs/INCIDENT-2026-04-21-ACPX-codex-exec-regression.md` for why
   - **Claude path:** Uses native Claude CLI with OAuth credentials
9. Review is posted as a GitHub PR comment by the appropriate bot account
10. After a successful GitHub post, reviewer writes a durable follow-up handoff file under `data/follow-up-jobs/pending/`
    - Queue uses exclusive writes with collision-safe retries to prevent overwriting existing jobs
11. Linear ticket updated to **Review Complete** (Done)
12. If review contains critical/security issues → comment added to Linear ticket flagging Paul

## PR Title Convention

All agent-built PRs must include a tag at the start of the title:

Repo-visible enforcement: GitHub Action `PR Title Prefix Validation` fails PR checks when this prefix is missing or malformed, and explains why creation-time correctness matters and why retitling is not a recovery path.

```
[claude-code] feat: add payment webhook handler (LAC-42)
[codex] fix: resolve null pointer in auth middleware (LAC-17)
[clio-agent] chore: update dependency versions
```

See `AUTHOR_TAGGING.md` for the full convention.

## Canonical Tagged PR Creation Helper

Use this helper instead of raw `gh pr create` for adversarial-review-tagged PRs:

```bash
npm run pr:create:tagged -- --tag codex --title "LAC-180: build PR creation helper" -- --body "..." --base main
```

Rules enforced by the helper:
- `--tag` is required and must be one of `codex`, `claude-code`, `clio-agent` (aliases: `claude`, `clio`)
- `--title` is required and must be unprefixed
- helper prepends the canonical prefix and prints the exact final title before PR creation
- passing `--title` through to raw `gh` args is blocked (including short-flag bundles that include `-t`) so title enforcement cannot be bypassed accidentally

## Data

Reviewed PRs are tracked in `data/reviews.db` (SQLite). This now stores delivery state rather than just a binary already-reviewed marker, so failed review attempts remain visible and retryable across watcher restarts instead of being silently skipped forever.

Successful review posts also enqueue a durable follow-up handoff artifact under `data/follow-up-jobs/pending/`. Each JSON job records the repo, PR number, reviewer model, review summary/body, criticality, a bounded remediation plan, and a durable remediation reply contract slot:
- `remediationPlan.mode = "bounded-manual-rounds"`
- `remediationPlan.maxRounds` caps the number of remediation attempts for the job
- `remediationPlan.currentRound` and `remediationPlan.rounds[]` preserve explicit operator-visible round history
- queue state remains explicit instead of hiding retries inside worker code
- `remediationReply.state = "awaiting-worker-write"` reserves a machine-readable worker reply artifact

### Force a re-review manually

If a PR already has a posted review and GitHub-side reviewer re-request is **not** sufficient to retrigger the watcher, you can force a fresh pass by editing the SQLite row directly.

Current watcher behavior:
- rows with `review_status in ('posted', 'malformed')` are skipped on poll
- forcing a re-review means making the row eligible again without deleting its history

Safe procedure for an **open** PR:

1. Inspect the row:
```bash
sqlite3 data/reviews.db "select id,repo,pr_number,reviewer,pr_state,review_status,review_attempts,last_attempted_at,posted_at,failed_at,failure_message from reviewed_prs where repo='laceyenterprises/agent-os' and pr_number=25;"
```

2. Flip it back to `pending` and clear terminal post/failure metadata:
```bash
sqlite3 data/reviews.db "BEGIN; UPDATE reviewed_prs SET review_status='pending', posted_at=NULL, failed_at=NULL, failure_message=NULL WHERE repo='laceyenterprises/agent-os' AND pr_number=25; COMMIT;"
```

3. Verify the row, then wait for the next watcher poll cycle.

Important constraints:
- keep `reviewer` unchanged unless you intentionally want a different reviewer path
- keep `review_attempts` and `last_attempted_at` intact so history is preserved
- do **not** use this to override malformed-title guardrails unless you explicitly want to bypass that safety contract
- prefer this only when the watcher does not yet support retriggering from GitHub review-request state alone

## Cross-user runtime contract (2026-04-22)

The canonical watcher runs as `placey`, but the adversarial-review source tree currently lives under `/Users/airlock/agent-os/tools/adversarial-review`. That means the service depends on a shared-read filesystem contract across the `airlock` ↔ `placey` boundary.

Current required shape:
```bash
sudo sh -c 'chgrp -R staff /Users/airlock/agent-os/tools && chmod -R g+rX /Users/airlock/agent-os/tools && find /Users/airlock/agent-os/tools -type d -exec chmod g+s {} +'
sudo chmod 750 /Users/airlock
```

If this contract drifts, reviewer imports can fail with `EACCES` even when launch/auth configuration is otherwise correct.

A one-shot consumer now claims the oldest pending job, starts the next bounded remediation round, moves the job into `data/follow-up-jobs/in-progress/`, prepares a PR checkout under `data/follow-up-jobs/workspaces/<jobId>/`, and spawns a detached Codex remediation worker using OAuth-backed Codex CLI auth only. If launch preparation fails, the claimed job is moved into `data/follow-up-jobs/failed/` with the error captured in the JSON record and attached to the active round record.

The remediation worker contract now includes an explicit machine-readable reply artifact:
- queue records start with `remediationReply.state = "awaiting-worker-write"`
- once a worker is spawned, the queue record includes the expected `remediationReply.path`
- the worker must write `adversarial-review-remediation-reply` JSON there instead of expressing re-review only in prose
- `reReview.requested = true` is the durable signal that this remediation result wants another adversarial review pass
- this ticket stops at the contract substrate; later tickets still need to consume that reply and trigger or requeue the next step

Run the consumer manually with:

```bash
npm run follow-up:consume
```

A separate one-shot reconciler now closes the first durable queue gap for detached worker completion:

```bash
npm run follow-up:reconcile
```

Current reconciliation contract:
- only `data/follow-up-jobs/in-progress/` jobs with `remediationWorker.state = "spawned"` are inspected
- if the recorded worker PID is still live, the job remains `in_progress`
- if the PID is gone and `.adversarial-follow-up/codex-last-message.md` exists with non-empty content, the job moves to `data/follow-up-jobs/completed/`
- if a remediation reply artifact path is configured, reconciliation reads and validates it before trusting the completion
- if that reply sets `reReview.requested = true`, reconciliation resets the matching `reviewed_prs` row to `review_status = 'pending'` so the watcher can trigger the next adversarial review pass on a later poll
- malformed-title rows and non-open PR rows remain blocked explicitly; the completed follow-up job records that blocked re-review outcome for operators
- if the PID is gone and that final-message artifact is missing or empty, the job moves to `data/follow-up-jobs/failed/`
- completed/failed records retain the worker artifact paths plus a short operator-facing preview or failure context
- reconciliation does not auto-start another remediation round; advancing to the next bounded remediation round is still an explicit operator action

To request another bounded remediation round after a completed or failed attempt:

```bash
npm run follow-up:requeue -- data/follow-up-jobs/completed/<jobId>.json "Need one more bounded remediation pass"
```

Requeue semantics:
- the existing job record is moved back to `data/follow-up-jobs/pending/`
- prior round history remains in `remediationPlan.rounds[]`
- `remediationPlan.maxRounds` is enforced; when the cap is reached, the job moves to `data/follow-up-jobs/stopped/`
- there is no hidden infinite retry path

Manual SQLite edits are now a recovery path rather than the normal re-review trigger. When a remediation worker writes a valid reply artifact with `reReview.requested = true`, `npm run follow-up:reconcile` makes the PR eligible for another watcher-driven adversarial review automatically. The direct DB procedure above still matters when the reply artifact is missing, invalid, or intentionally blocked by terminal watcher state.
New hardening lesson from the detached remediation-launch failure:
- do **not** treat `spawned process` as equivalent to `durable worker established`
- require a preflight contract before launch: repo/PR/branch target, runtime path, cwd, auth principal, lane type (`builder` vs `integration`), and expected edit/commit/push/PR-reply authority
- require a startup receipt or other explicit progress marker within a bounded timeout
- preserve exact launch metadata and expected artifact paths so failures remain diagnosable after wrapper death
- classify failures explicitly: launch failure, attach/transport failure, permission-blocked worker, artifact-missing completion, or successful completion

This is still intentionally a bounded slice. It gives the queue durable terminal states and operator visibility, launch ownership is treated explicitly, completion has a one-shot reconciler, multi-round remediation remains explicit and capped rather than autonomous, and the remediation reply contract now drives explicit watcher re-review eligibility instead of living only as inert substrate. Operator recovery paths still remain explicit when reply or watcher state blocks that trigger.
## Operational semantics note (2026-04-21)

This service currently uses **A semantics** for review completion:
- Codex/Claude generates review text
- the outer reviewer wrapper captures the final artifact
- the wrapper posts the PR review comment itself via `gh pr review`
- only after successful post does the wrapper enqueue a durable follow-up handoff job

That means the current service does **not** yet implement delegated-worker-owned completion (**B semantics**). The worker does not own the GitHub side effect directly; the wrapper does.

Important lesson from the ACPX/Codex debugging cycle:
- ACPX/native Codex can still support this A-style contract
- the quick operational win is to preserve the known-good wrapper-owned review-post path and swap only invocation/auth plumbing underneath it
- do not let a larger ambition for B-style delegated completion become the critical path for getting the review pipeline working reliably again

Practical implication:
- substrate choice (`acpx`, native `codex exec`, file-based output handoff) and completion semantics are separate decisions
- if we want real B semantics later, that needs an explicit job/session ownership contract rather than wrapper glue that scrapes output and pretends delegated work was an inline free model call
