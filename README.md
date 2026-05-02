---
delegation: full
confidence: 0.95
last_verified: 2026-04-24
influence_weight: medium
tags: [adversarial-review-hq, documentation, reference]
staleness_window: 30d
---
# Adversarial Code Review Service

Cross-model review for agent-authored pull requests, with a bounded follow-up remediation loop.

**Core rule:** the model that builds the code never reviews it.

| Builder tag | Reviewer path | Review bot |
|---|---|---|
| `[codex]` | Claude | `claude-reviewer-lacey` |
| `[claude-code]` | Codex | `codex-reviewer-lacey` |
| `[clio-agent]` | Codex | `codex-reviewer-lacey` |
| missing / malformed tag | fail-loud guardrail, no review spawned | n/a |

---

## Docs map

Start here depending on what you need:

- **Quick orientation:** `README.md`
- **Operating the remediation loop:** `docs/follow-up-runbook.md`
- **Understanding states and transitions:** `docs/STATE-MACHINE.md`
- **Debugging auth/runtime scars:** `docs/INCIDENT-2026-04-21-ACPX-codex-exec-regression.md`
- **Changing behavior in code:** `src/watcher.mjs`, `src/reviewer.mjs`, `src/follow-up-jobs.mjs`, `src/follow-up-remediation.mjs`

Fast triage:

- “Why didn’t review trigger?” → `README.md` + `docs/STATE-MACHINE.md`
- “Why didn’t rereview happen?” → `docs/follow-up-runbook.md` + inspect `remediation-reply.json`
- “What state is the system actually in?” → `docs/STATE-MACHINE.md` + `data/reviews.db` + `data/follow-up-jobs/*`
- “What should I run next?” → `docs/follow-up-runbook.md`

---

## What this module does

### 1. First-pass review

- watcher polls GitHub for tagged PRs
- validates title guardrails
- routes to the opposite reviewer model
- posts the GitHub review through the correct bot
- records durable delivery state in `data/reviews.db`

### 2. Follow-up remediation

After a successful review post, the service creates a durable follow-up job.

That job can then be:

- consumed explicitly
- worked by a detached remediation worker on the existing PR branch
- reconciled explicitly
- stopped or requeued explicitly
- re-armed for another review pass only via durable JSON reply metadata

This is **bounded and operator-visible**, not an autonomous retry daemon.

---

## Architecture

```text
                          ┌──────────────────────────────┐
                          │      GitHub Pull Request     │
                          │ tagged at creation time      │
                          │ [codex]/[claude-code]/...    │
                          └──────────────┬───────────────┘
                                         │
                                         ▼
                          ┌──────────────────────────────┐
                          │         watcher.mjs          │
                          │ poll + title validation      │
                          │ + route selection            │
                          └───────┬───────────┬──────────┘
                                  │           │
                    malformed tag  │           │ valid tagged PR
                                  │           ▼
                                  │  ┌──────────────────────────┐
                                  │  │       reviewer.mjs       │
                                  │  │ fetch diff, run reviewer │
                                  │  │ post GitHub review       │
                                  │  └──────────┬───────────────┘
                                  │             │
                                  ▼             ▼
                    ┌──────────────────────┐  ┌──────────────────────────────┐
                    │ fail-loud comment +  │  │ durable review row updated   │
                    │ malformed DB state   │  │ + follow-up job created      │
                    └──────────────────────┘  └──────────┬───────────────────┘
                                                         │
                                                         ▼
                                  ┌──────────────────────────────────────────┐
                                  │ data/follow-up-jobs/pending/*.json      │
                                  └─────────────────┬────────────────────────┘
                                                    │
                                                    ▼
                                  ┌──────────────────────────────────────────┐
                                  │ follow-up:consume                        │
                                  │ claim job, prep workspace, spawn worker  │
                                  └─────────────────┬────────────────────────┘
                                                    │
                                                    ▼
                         ┌─────────────────────────────────────────────────────────┐
                         │ workspace artifacts                                     │
                         │   worker-last-message.md                                 │
                         │   remediation-reply.json                                │
                         └─────────────────┬──────────────────────────────────────┘
                                           │
                                           ▼
                              ┌──────────────────────────────┐
                              │   follow-up:reconcile        │
                              │ validate artifacts,          │
                              │ finalize queue state         │
                              └─────────────┬────────────────┘
                                            │
                    ┌───────────────────────┴────────────────────────┐
                    ▼                                                ▼
      ┌──────────────────────────────┐                 ┌──────────────────────────────┐
      │ no durable rereview request  │                 │ rereview requested=true      │
      │ -> stopped/no-progress       │                 │ -> review_status='pending'   │
      │                              │                 │ -> watcher can review again  │
      └──────────────────────────────┘                 └──────────────────────────────┘
```

---

## Quick start

### Install

```bash
npm install
```

### Configure

```bash
cp .env.example .env
# fill in runtime values
```

At minimum, expect to provide:

- `GITHUB_TOKEN`
- `GH_CODEX_REVIEWER_TOKEN`
- `GH_CLAUDE_REVIEWER_TOKEN`
- `LINEAR_API_KEY` (if using Linear sync)

### Important auth note

The real runtime contract is stricter than the generic `.env.example` suggests:

- **Claude review path is OAuth-first**
- **Codex review path is OAuth-first**
- silent API-key fallback is not the intended operating mode

If auth drifts, fail loud and fix auth. Don’t normalize degraded reviewer identity.

### Configure watched repos

Edit `config.json`.

Minimal example:

```json
{
  "repos": ["laceyenterprises/clio"],
  "pollIntervalMs": 300000,
  "linear": { "teamKey": "LAC" }
}
```

---

## Commands

### Start watcher

```bash
npm start
```

### Run one-shot review

```bash
node src/reviewer.mjs '{"repo":"laceyenterprises/clio","prNumber":42,"reviewerModel":"codex","botTokenEnv":"GH_CODEX_REVIEWER_TOKEN","linearTicketId":"LAC-42"}'
```

`reviewer.mjs` derives the durable follow-up `builderTag` from the live PR title when the caller omits it. If the PR title is not canonically tagged, the review run fails rather than queuing an ambiguous remediation job.

### Create a correctly tagged PR

```bash
npm run pr:create:tagged -- --tag codex --title "LAC-180: build PR creation helper" -- --body "..." --base main
```

### Follow-up queue operations

```bash
npm run follow-up:consume
npm run follow-up:reconcile
npm run follow-up:requeue -- data/follow-up-jobs/completed/<jobId>.json "Need one more bounded remediation pass"
npm run follow-up:stop -- data/follow-up-jobs/in-progress/<jobId>.json "Operator requested stop"
```

### Test

```bash
npm test
```

---

## PR title contract

Tagged titles are mandatory at PR creation time.

Examples:

```text
[codex] fix: resolve null pointer in auth middleware (LAC-17)
[claude-code] feat: add payment webhook handler (LAC-42)
[clio-agent] chore: refresh docs and scripts
```

If the title is malformed:

- watcher records `review_status = 'malformed'`
- a fail-loud GitHub comment explains why review did not trigger
- this state is terminal by design
- safe recovery is usually opening a new correctly tagged PR

---

## State you should know exists

### Review ledger

SQLite database:

```text
data/reviews.db
```

Important `review_status` values:

- `pending`
- `posted`
- `failed`
- `malformed`

### Follow-up queue

```text
data/follow-up-jobs/
  pending/
  in-progress/
  completed/
  failed/
  stopped/
  workspaces/
```

Queue directories are the state machine.

---

## The rereview contract

Another adversarial review pass only happens if the remediation worker writes a valid reply JSON with:

```json
{
  "reReview": {
    "requested": true,
    "reason": "..."
  }
}
```

That durable artifact causes reconciliation to reset the corresponding row in `reviews.db` back to:

```text
review_status = 'pending'
```

That is what re-arms the watcher.

Not enough:

- prose in the final message
- commit text
- PR comments
- human assumptions

The JSON artifact is the contract.

---

## Maintenance cheatsheet

Inspect the queue:

```bash
find data/follow-up-jobs -maxdepth 2 -type f -name '*.json' | sort
jq '.' data/follow-up-jobs/in-progress/<jobId>.json
```

Inspect review DB:

```bash
sqlite3 data/reviews.db "select repo,pr_number,review_status,pr_state,review_attempts,posted_at,failed_at,rereview_requested_at from reviewed_prs order by id desc limit 20;"
```

Re-trigger a review for a previously-reviewed PR (canonical path):

```bash
npm run retrigger-review -- \
  --repo laceyenterprises/adversarial-review \
  --pr 212 \
  --reason "operator triggered: <why you're rerunning>"
```

This wraps the same atomic transition the follow-up flow uses — `review_status='pending'`, clears `posted_at`/`failed_at`/`failure_message`, stamps `rereview_requested_at` and `rereview_reason`. Hand-written SQL that only sets `rereview_requested_at` is a silent no-op because the watcher polls on `review_status`, not on the rereview metadata. By default the CLI refuses rows whose `review_status` is `'failed'` (the watcher already retries those automatically and the reset would erase diagnostic evidence); pass `--allow-failed-reset` after reviewing the failure if you really want a clean rerun. See `npm run retrigger-review -- --help` for the full surface.

**Emergency-only direct SQL** (use only if the npm script is unavailable, e.g. partial repo state during an incident):

```bash
sqlite3 data/reviews.db "BEGIN; UPDATE reviewed_prs SET review_status='pending', posted_at=NULL, failed_at=NULL, failure_message=NULL WHERE repo='laceyenterprises/adversarial-review' AND pr_number=212; COMMIT;"
```

Note that this path skips the rereview audit metadata (`rereview_requested_at`, `rereview_reason`) — the npm wrapper is preferred for any non-emergency operator action.

Check worker artifacts:

```bash
ls -la data/follow-up-jobs/workspaces/<jobId>/.adversarial-follow-up/
jq '.' data/follow-up-jobs/workspaces/<jobId>/.adversarial-follow-up/remediation-reply.json
```

If a remediation round “finished” but nothing advanced, the first thing to ask is usually:

- was `follow-up:reconcile` run?
- did `remediation-reply.json` exist?
- did it actually set `reReview.requested = true`?

---

## Common failure modes

### Review never triggered

Usually one of:

- PR title missing required creation-time tag
- watcher is not polling the repo you expect
- `GITHUB_TOKEN` lacks read access
- row already landed in `malformed`

### Reviewer failed to post

Usually one of:

- reviewer bot PAT missing/invalid
- Claude/Codex OAuth drift
- CLI path drift
- cross-user permission drift
- runtime/env mismatch

### Follow-up worker ran but queue did not advance

Usually one of:

- `follow-up:reconcile` was not run yet
- final artifact missing/empty
- `remediation-reply.json` invalid or absent
- rereview was not requested durably

### Queue round completed but no new review appeared yet

Usually one of:

- watcher has not polled again yet
- `reviews.db` was not actually reset to `pending`
- PR is no longer open

### Sharp edges worth remembering

- malformed-title state is terminal by design
- `completed` does not mean merged/done; it means rereview was armed successfully
- `no-progress` is healthy defensive behavior, not necessarily a bug
- the `.env.example` is generic; real reviewer auth is stricter

For the compact control-plane view, see `docs/STATE-MACHINE.md`.
For the full operator guide, see `docs/follow-up-runbook.md`.
For auth/runtime history, see `docs/INCIDENT-2026-04-21-ACPX-codex-exec-regression.md`.

---

## Repository map

```text
src/
  watcher.mjs
  reviewer.mjs
  review-state.mjs
  watcher-title-guardrails.mjs
  watcher-fail-loud.mjs
  pr-title-tagging.mjs
  pr-create-tagged.mjs
  follow-up-jobs.mjs
  follow-up-remediation.mjs
  follow-up-reconcile.mjs
  follow-up-requeue.mjs
  follow-up-stop.mjs

prompts/
  reviewer-prompt.md
  follow-up-remediation.md

docs/
  follow-up-runbook.md
  INCIDENT-2026-04-21-ACPX-codex-exec-regression.md
```

---

## For deeper operator detail

See:

- `docs/follow-up-runbook.md`
- `src/watcher.mjs`
- `src/reviewer.mjs`
- `src/follow-up-jobs.mjs`
- `src/follow-up-remediation.mjs`

---

## Status

As of 2026-04-24, this README is intentionally optimized for quick scanning. Heavier operator semantics and maintenance detail live in `docs/follow-up-runbook.md`.
