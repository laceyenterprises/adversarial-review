---
delegation: full
confidence: 0.95
last_verified: 2026-05-01
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

The pipeline is **automated end-to-end**:

- a LaunchAgent (`ai.laceyenterprises.adversarial-follow-up`) ticks every 2 min
- each tick claims one pending job, spawns a detached remediation worker (codex or claude-code, picked from the PR's `builderTag`), then reconciles any in-progress jobs whose worker has exited
- on every terminal transition (completed / stopped / failed) the reconciler posts a public PR comment under the matching reviewer-bot identity so operators can read the loop status from the PR itself
- bounded by `DEFAULT_MAX_REMEDIATION_ROUNDS = 6` (in `src/follow-up-jobs.mjs`); `requestReviewRereview` in `src/review-state.mjs` does not implement a per-PR cooldown — the round cap is the only re-arm bound, and each round must end with a fresh adversarial pass plus a worker-written `reReview.requested` decision before the next round can claim the job

Operator-visible state is preserved in `data/follow-up-jobs/` (the durable JSON queue) and `data/reviews.db` (the review ledger). Operators retain explicit control: `npm run follow-up:requeue`, `npm run follow-up:stop`, `npm run retrigger-review` are still the canonical levers when manual intervention is required.

### 3. Convergence and automerge

A PR's review verdict is what the worker-pool automerge gate watches (it reads the GitHub review body's `## Verdict` section: `Comment only` = pass, `Request changes` = fail). The remediation worker drives convergence by setting `reReview.requested` in `remediation-reply.json`:

- `true` (the default success path) — fresh adversarial pass runs; new verdict replaces the stale `Request changes`; if it lands as `Comment only`, the gate fires automerge
- `false` — deliberate human-intervention exit; the PR keeps its current verdict; a public PR comment flags that human review is needed (use the `blockers` array to explain)

If the loop reaches the 6-round cap without converging, the job stops with code `max-rounds-reached` and the PR comment explicitly says human intervention is required.

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
                                  │ adversarial-follow-up LaunchAgent        │
                                  │ ticks every 2 min:                       │
                                  │   1. consume one pending job             │
                                  │   2. reconcile in-progress jobs          │
                                  └─────────────────┬────────────────────────┘
                                                    │
                                                    ▼
                         ┌─────────────────────────────────────────────────────────┐
                         │ workspace artifacts                                     │
                         │   codex-last-message.md                                 │
                         │   remediation-reply.json                                │
                         └─────────────────┬──────────────────────────────────────┘
                                           │
                                           ▼
                              ┌──────────────────────────────┐
                              │   reconcileFollowUpJob       │
                              │ validate artifacts,          │
                              │ finalize queue state,        │
                              │ post PR comment              │
                              └─────────────┬────────────────┘
                                            │
                    ┌───────────────────────┴────────────────────────┐
                    ▼                                                ▼
      ┌──────────────────────────────┐                 ┌──────────────────────────────┐
      │ rereview requested=false     │                 │ rereview requested=true      │
      │ -> stopped/no-progress       │                 │ -> review_status='pending'   │
      │ -> PR comment: human needed  │                 │ -> watcher reviews again     │
      └──────────────────────────────┘                 └─────────────┬────────────────┘
                                                                     │
                                                                     ▼
                                                       ┌──────────────────────────────┐
                                                       │ verdict on PR:               │
                                                       │   Comment only -> automerge  │
                                                       │   Request changes -> loop    │
                                                       └──────────────────────────────┘
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

### Install LaunchAgents

Two agents drive the system:

| Agent | Cadence | What it runs |
|---|---|---|
| `ai.laceyenterprises.adversarial-watcher` | KeepAlive (long-lived) | `src/watcher.mjs` — polls for tagged PRs, spawns reviewers |
| `ai.laceyenterprises.adversarial-follow-up` | KeepAlive (long-lived, internal 120s loop) | `scripts/adversarial-follow-up-tick.sh` — consume + reconcile + retry-comments |

Both plists live in `launchd/` and are automatically provisioned at boot by `scripts/os-restart.sh` in the parent agent-os repo.

> **The shipped plists are user-bound AND host-bound.** The filename suffix (`.placey.plist`) names the operator the plist's `HOME` and log paths point at; the `ProgramArguments` and `WorkingDirectory` paths additionally hardcode this host's Agent OS repo root (`/Users/airlock/agent-os/...`), since `EnvironmentVariables` in launchd plists do not expand shell variables. If you are running as `placey` on this host, the manual install below works as-is. If you are running as a different operator OR on a host where the repo lives elsewhere, **do not bootstrap the shipped plist directly** — it would write logs to the wrong account, resolve `gh`/Codex auth from the wrong home directory, or point at a `ProgramArguments` script that does not exist. Copy with the matching suffix and substitute paths first (see `Install for a different user` below).

#### Install for `placey` (the shipped binding)

```bash
cp launchd/ai.laceyenterprises.adversarial-follow-up.placey.plist \
   ~/Library/LaunchAgents/ai.laceyenterprises.adversarial-follow-up.plist
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/ai.laceyenterprises.adversarial-follow-up.plist
launchctl kickstart gui/$UID/ai.laceyenterprises.adversarial-follow-up
```

#### Install for a different user or host

Two substitutions are required:

- `/Users/placey` → the operator's home (drives `HOME`, log paths)
- `/Users/airlock/agent-os` → the absolute path to your Agent OS repo root (drives `ProgramArguments` and `WorkingDirectory`; launchd plists cannot expand `$HOME` or any shell variable, so the repo path must be a literal)

Replace `<USER>` with the running operator's username and `<AGENT_OS_ROOT>` with the absolute repo path:

```bash
sed -e "s|/Users/placey|/Users/<USER>|g" \
    -e "s|/Users/airlock/agent-os|<AGENT_OS_ROOT>|g" \
  launchd/ai.laceyenterprises.adversarial-follow-up.placey.plist \
  > ~/Library/LaunchAgents/ai.laceyenterprises.adversarial-follow-up.plist
plutil -lint ~/Library/LaunchAgents/ai.laceyenterprises.adversarial-follow-up.plist
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/ai.laceyenterprises.adversarial-follow-up.plist
launchctl kickstart gui/$UID/ai.laceyenterprises.adversarial-follow-up
```

If your repo is at `/Users/<USER>/agent-os`, the `<USER>` substitution alone covers both — but verify by `grep /Users/airlock ~/Library/LaunchAgents/ai.laceyenterprises.adversarial-follow-up.plist` after the `sed`; any remaining hits mean you still need to point them at your repo root.

The tick script honors `AGENT_OS_ROOT` as a runtime override (it defaults to `/Users/airlock/agent-os`), so as a stopgap you can also export `AGENT_OS_ROOT` in the plist's `EnvironmentVariables` to relocate the in-script `WATCHER_DIR` lookup. The launchd-level `ProgramArguments` path still needs to point at the actual script on disk, though, so the substitution above is the complete fix.

You will also need to commit a per-user copy of the plist (e.g. `ai.laceyenterprises.adversarial-follow-up.<that-user>.plist`) and add a matching entry to `USER_AGENTS_ONESHOT` plus `INSTALLABLE_USER_AGENT_PLISTS` in `scripts/os-restart.sh` so the daemon is picked up on a system restart — the auto-install path copies the file verbatim and does not substitute placeholders.

#### Pause / resume

```bash
launchctl bootout gui/$UID/ai.laceyenterprises.adversarial-follow-up   # pause
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/ai.laceyenterprises.adversarial-follow-up.plist  # resume
```

The follow-up daemon resolves the same secrets the watcher does (`OP_SERVICE_ACCOUNT_TOKEN`, `GITHUB_TOKEN`, `GH_CLAUDE_REVIEWER_TOKEN`, `GH_CODEX_REVIEWER_TOKEN`, `CODEX_AUTH_PATH`) and uses `unset` to scrub direct-provider API keys before exec — same OAuth-first contract as `src/reviewer.mjs`. Per-user paths (`CODEX_AUTH_PATH`, log dirs) are derived at runtime from `$HOME` set by the plist; only the WorkingDirectory and `AGENT_OS_ROOT` reference the repo location explicitly.

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

**Convergence rule (see `prompts/follow-up-remediation.md`):** `reReview.requested = true` is the default success path — without it, the PR's stale `Request changes` verdict is never replaced and the worker-pool automerge gate never fires. `false` is reserved for deliberate human-intervention exits (cite the reason in `blockers`). The bounded 6-round loop is the safety net against thrashing.

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

If a remediation round "finished" but nothing advanced, the first thing to ask is usually:

- did the follow-up LaunchAgent tick? (`tail -200 ~/Library/Logs/adversarial-follow-up.log`)
- did `remediation-reply.json` exist?
- did it actually set `reReview.requested = true`?

**The terminal job JSON is the durable source of truth, not the PR comment.** Each terminal record carries a `commentDelivery` field stamped at the time reconcile attempted to post:

```bash
jq '.commentDelivery' data/follow-up-jobs/{completed,stopped,failed}/<jobId>.json
```

If `commentDelivery.posted === false`, the queue advanced but the public PR comment failed (timeout, gh outage, missing token). The retry-comments step at the start of every daemon tick re-attempts up to `MAX_COMMENT_DELIVERY_ATTEMPTS = 5` times — see `src/comment-delivery.mjs`. Reasons in `NON_RETRYABLE_DELIVERY_REASONS` (e.g. `no-token-mapping`) are never retried; those records sit for operator inspection.

So:

- comment present on the PR → reconcile ran AND delivery succeeded.
- comment missing on the PR → reconcile may still have run; check `commentDelivery.posted` in the terminal record.
- terminal record has `commentDelivery.posted === false` past 5 attempts → operator inspection needed.

Inspect daemon logs:

```bash
tail -100 ~/Library/Logs/adversarial-follow-up.log
launchctl list | grep adversarial
```

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
  watcher.mjs                      # poll loop + tag routing
  reviewer.mjs                     # cross-model review post
  review-state.mjs                 # reviews.db ledger
  watcher-title-guardrails.mjs     # PR title tag enforcement
  watcher-fail-loud.mjs            # fail-loud comment posting
  pr-title-tagging.mjs             # title parsing
  pr-create-tagged.mjs             # operator helper for tagged PRs
  pr-comments.mjs                  # remediation outcome comments (this PR)
  follow-up-jobs.mjs               # durable JSON queue + reply schema
  follow-up-remediation.mjs        # consume + reconcile + worker spawn
  follow-up-reconcile.mjs          # canonical reconcile entrypoint
  follow-up-requeue.mjs            # operator: re-arm a completed job
  follow-up-stop.mjs               # operator: stop an in-progress job
  retrigger-review.mjs             # operator: re-review a PR

prompts/
  reviewer-prompt.md
  follow-up-remediation.md

hooks/
  worker-provenance-commit-msg     # stamps Worker-Class trailers

scripts/
  adversarial-watcher-start-placey.sh
  adversarial-follow-up-tick.sh    # daemon tick driver

launchd/
  ai.laceyenterprises.adversarial-watcher.placey.plist
  ai.laceyenterprises.adversarial-follow-up.placey.plist

docs/
  follow-up-runbook.md
  STATE-MACHINE.md
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

As of 2026-05-01, the pipeline is automated end-to-end:
- watcher posts reviews
- follow-up daemon claims jobs every 2 min, spawns workers, reconciles
- public PR comments narrate every terminal outcome
- convergence rule + 6-round cap + round-by-round "worker must request rereview" gate bound the loop (no per-PR rereview cooldown is implemented; the cap and the gate are the only re-arm bounds)

This README is optimized for quick scanning. Heavier operator semantics and maintenance detail live in `docs/follow-up-runbook.md`.
