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
5. Skips PRs already reviewed (tracked in `data/reviews.db`)
6. Sets Linear ticket to **In Review** state
7. Spawns **Reviewer Agent** as a child process
8. Reviewer fetches diff via `gh pr diff`, sends to AI model with adversarial prompt
9. Review is posted as a GitHub PR comment by the appropriate bot account
10. After a successful GitHub post, reviewer writes a durable follow-up handoff file under `data/follow-up-jobs/pending/`
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

Reviewed PRs are tracked in `data/reviews.db` (SQLite). This prevents duplicate reviews across watcher restarts.

Successful review posts also enqueue a durable follow-up handoff artifact under `data/follow-up-jobs/pending/`. Each JSON job records the repo, PR number, reviewer model, review summary/body, criticality, and the recommended next action: start a follow-up coding session against the reviewed PR.

This is intentionally a narrow first slice. The queue is explicit and durable, but nothing consumes it yet. The long-term direction is to replace file handoff with native session/principal-aware continuation so the system can resume the original build session with its intent and context intact instead of starting fresh.

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
