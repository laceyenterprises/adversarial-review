# Follow-Up Remediation Runbook

This runbook covers the shipped bounded remediation loop for adversarial-review after `LAC-206`, `LAC-209`, `LAC-210`, `LAC-211`, and the 2026-05-01 automation pass.

Use this when a review has already been posted to GitHub and you need to inspect, reconcile, stop, requeue, or debug the follow-up remediation flow without re-reading the implementation.

---

## Scope and current contract

- This is a **bounded loop** with operator override. It is not an unbounded autonomous retry daemon.
- The **watcher owns review posting**. Follow-up remediation does not post GitHub reviews directly.
- The watcher also projects the durable adversarial-review state onto the PR head SHA as the commit status context `agent-os/adversarial-gate` by default. Do not rely on GitHub-native merge or auto-merge until that context is required in branch protection for the target branch. Deployments may opt into a different context with `ADV_GATE_STATUS_CONTEXT`, but the override must be applied consistently to every watcher and branch-protection probe.
- The remediation worker works on the **existing PR branch**, commits changes, and pushes that branch.
- The remediation worker does **not** open a new PR and does **not** merge the PR.
- Until `LAC-358` is explicitly reverted, **auto-remediation defaults to the codex worker class regardless of the original PR's `builderTag`**. Operators can override that default with `ADVERSARIAL_REVIEW_DEFAULT_REMEDIATOR=codex|claude-code`; aliases `claude` and `codex-remediation` are accepted, while unknown non-empty values are configuration errors. The durable `builderTag` is still preserved on the job ledger for downstream queue/audit purposes, but worker-class selection defaults to codex per `feedback_prefer_codex_for_heavy_work.md` while claude-code remains unsuitable for unattended heavy remediation. Codex remediation commits still use the remediation trailer class configured by the spawn path, and reconcile-time public PR comments post under the selected worker bot identity when the worker model is known; `never-spawned` reconcile paths fall back to the configured/default worker class.
- Advancing from one remediation round to another runs **automatically** via the `ai.laceyenterprises.adversarial-follow-up` LaunchAgent (long-lived, internal 120s tick loop running entirely in a single node process). Each tick runs three primary steps in order: reconcile any in-progress jobs whose worker has exited, fill remediation capacity from pending jobs, retry pending PR comment deliveries (bounded by `RETRY_BUDGET_PER_TICK`). A separate stopped-job archive sweep also runs on its own cadence within the same daemon loop. Capacity defaults to one active remediation worker; set `ADVERSARIAL_REMEDIATION_MAX_CONCURRENT_JOBS=<n>` to allow bounded parallel workers across different PRs. The daemon clamps that env knob to `8` and logs when it had to clamp, so a typo cannot fan out an unbounded number of worker spawns in one tick. The daemon still refuses to spawn a second active remediation worker for the same `repo`/`prNumber`, using a case-insensitive repo/pr exclusion key because workers mutate the existing PR branch. If a SIGTERM arrives or one pending job fails during launch preparation, the daemon stops the current drain after the in-flight iteration and keeps filling any remaining safe capacity for unrelated PRs instead of aborting the whole tick. The daemon resolves 1Password / `gh` secrets once at startup; subsequent ticks reuse them in-process. The tick loop itself runs in-process (no `node` subprocess fork on every tick), so macOS TCC trust is granted once for the daemon's `node` binary and reused for the daemon's lifetime — eliminates the per-tick "node would like to access data from other apps" prompts that an earlier subprocess-per-tick design produced. Per-spawn TCC popups when a fresh subprocess starts (a different problem, and one that fires on **both** the watcher's first-pass reviewer subprocess and the follow-up daemon's remediation worker — see `docs/MACOS-TCC.md` for which binaries each path execs and why FDA on those binaries is a security tradeoff worth reading before granting).
- Public PR comments are best-effort but durable: every reconcile-time post attempt is stamped into the terminal job JSON under `commentDelivery`. A failed post (timeout, gh outage, missing token) is retried on subsequent ticks up to `MAX_COMMENT_DELIVERY_ATTEMPTS = 5`. The terminal JSON is the source of truth, not the PR comment.
- Public PR comments are **idempotent**. Each comment body embeds an HTML-comment marker keyed by `(jobId, round, action)` (prefix `adversarial-review-remediation-marker:`). Before posting, the poster runs a bounded `gh api` lookup on the PR's existing comments and skips the create if a previous attempt already landed on GitHub even though the local CLI saw a timeout. Lookup failures fall through to posting (best-effort: a duplicate is preferable to silent loss).
- PR-side `retrigger-remediation` label acknowledgements are also best-effort durable. After a successful budget bump, the watcher writes a `data/follow-up-jobs/label-consumptions/*.json` record with `ackComment.posted=false` and writes the operator-mutation audit before attempting the follow-up job requeue, so the accepted GitHub label event cannot double-bump the budget on retry. The watcher then removes the label, posts a sanitized ack comment, and rewrites the record with the ack outcome. If the requeue step fails after the bump, the label is still removed and the ack comment explicitly reports the partial-success state so operators can inspect the queue and retry without silently applying another budget increment. Each ack body embeds an HTML marker keyed by the GitHub label event (prefix `adversarial-review-retrigger-remediation-ack:`), the post path checks existing PR comments for that marker before creating, and each watcher tick retries pending ack records up to 5 attempts so a daemon bounce after label removal does not silently lose the operator-visible confirmation.
- The retry path reads from a dedicated index, not the full terminal history. `data/follow-up-jobs/delivery-retry-index/` holds one pointer file per outstanding `posted=false` delivery; pointers are added on failure and removed on success. The first tick after upgrade walks the existing terminal history once to seed the index (sentinel: `.initialized`), then steady-state ticks read only the index — bounded by retry backlog size, not history size.
- The fleet-wide false-deferral detector keeps its cross-observation state in `data/follow-up-jobs/fleet-wide-false-deferral-alerts/fleet-state.json`, but it now serializes the full read-modify-write cycle behind a reclaimable sidecar lock file (`fleet-state.lock`) so parallel watcher variants cannot drop each other's LRQ observations. The lock records owner/timestamp metadata and stale locks are reclaimed automatically so a crash while holding the lock does not permanently blind the detector. Both the main state file and the separate degraded-alert debounce sidecar are written with the repo's atomic temp-file + fsync + rename helper because the detector depends on that state surviving crashes and host bounces. The detector records the alert debounce state while the lock is held, releases the lock, and only then performs external alert delivery so slow webhook/network delivery does not block peer watcher observations. If the watcher cannot read valid JSON from the detector state, acquire the lock, or persist either the observation set or the post-alert `lastAlertedAt` update, it fails the detector closed for that tick and emits `merge_agent.fleet_wide_false_deferral_detector_degraded` instead of pretending the detector evaluated normally. Operators should treat that degraded alert as "the fleet-wide safeguard is currently blind until this state path is repaired."
- The normal success path to a fresh adversarial review pass is the worker's **durable machine-readable rereview request** (`reReview.requested = true` in `remediation-reply.json`). Once a completed remediation round requests rereview, the watcher queues the new pass even if that round consumed the PR's final remediation budget; the cap only stops the next worker spawn.
- Bounding: `DEFAULT_MAX_REMEDIATION_ROUNDS = 2` in `src/follow-up-jobs.mjs` because `medium` is the default risk class; new jobs use risk-class caps of `low=1`, `medium=2`, `high=3`, and `critical=4` (was `3` before 2026-05-06 and `6` before 2026-05-02). The cap is enforced **PR-wide**, not per-job. The watcher reads the PR's prior remediation-round count from the durable follow-up-jobs ledger (`summarizePRRemediationLedger`) and seeds each new follow-up job's `currentRound` with that count. Fresh jobs normally re-derive the cap from the current risk class; if the latest PR ledger cap is higher than the current tier, the watcher carries that elevated cap forward so legacy in-flight PRs and operator-raised budgets do not silently lose budget mid-deploy. After the cap is consumed, the next review still runs and uses the lenient final-round verdict-categorization addendum embedded in `prompts/code-pr/reviewer.last.md`; that addendum relaxes the *categorization* bar (style / nits / future-proofing concerns become non-blocking) but does **not** relax the automated merge gate — the verdict stays `Request changes` whenever any finding remains unless a current scoped `operator-approved` label deliberately overrides review/remediation state for that head. `requestReviewRereview` in `src/review-state.mjs` does **not** implement a cooldown — it refuses the reset only on hard guardrails (review row missing, malformed-title terminal, PR not open, already pending). The PR-wide round cap is the only re-arm bound. (An earlier doc claim about a per-PR rereview cooldown was inaccurate.)
- Stage-keyed prompts are part of the shipped loop contract. Reviewer runs select `prompts/code-pr/reviewer.first.md`, `reviewer.middle.md`, or `reviewer.last.md` via `pickReviewerStage(reviewAttemptNumber, completedRemediationRounds, maxRemediationRounds)`. Missing or invalid reviewer context falls back to the `first` prompt; `middle` is used only when the run is provably a re-review after at least one completed remediation round; `last` is used once the completed-round count reaches the stored cap. Remediation workers similarly select `prompts/code-pr/remediator.{first,middle,last}.md` via `pickRemediatorStage(remediationRound, maxRemediationRounds)`, with bad or missing round context falling back to `first` instead of silently framing the worker as mid-cycle.
- Every remediator prompt stage tells the worker to refuse any dirty worktree (tracked or untracked) via `git status --porcelain --untracked-files=all`, fetch and rebase onto `origin/<baseBranch>` before code changes, then run a mandatory `git cherry origin/<baseBranch> HEAD` contamination audit before commit-and-push. Legacy jobs that predate `baseBranch` persistence are lazily hydrated from GitHub before spawn/reconcile; if the real PR base cannot be proven, the job fails instead of guessing `main`. That is a real head-rewrite, not a cosmetic sync step: the worker's eventual push updates the PR head SHA, and any head-scoped operator label event (`operator-approved`, `merge-agent-requested`) that was attached to the pre-rebase head is stale for the rebased head until an operator reapplies it. The watcher already evaluates those labels against the current head SHA, so a remediation rebase can legitimately make an earlier operator label stop authorizing merge-agent or override behavior on the next tick.
- If the remote PR branch moves while the worker is running, the worker treats it as an optimistic-concurrency miss, not an immediate human handoff. The worker saves only its remediation commits as a patch series, fetches the fresh PR head, resets to that head, replays the patch with `git am --3way`, re-runs the contamination audit and relevant validation, and retries the push with `--force-with-lease=<fresh-head>`. This stale-head replay is bounded to three attempts and must not blindly rebase the whole in-progress worktree onto `origin/<this-pr-branch>`. The worker uses `operationalBlockers[]: [{ title: "stale-pr-head", ... }]` only when the bounded replay is exhausted, replay conflicts cannot be resolved safely, patch identity is ambiguous after a force-rewrite, or post-replay validation/audit fails.
- Reviewer-bot tokens (`GH_CLAUDE_REVIEWER_TOKEN`, `GH_CODEX_REVIEWER_TOKEN`) are best-effort: a missing token at startup is logged as a warning, the daemon still runs consume/reconcile, and the comment poster records `token-env-missing` for later retry once the token is restored. A 1Password outage at boot does not block remediation.

Operator levers (still available, override the daemon):

```bash
npm run follow-up:consume                         # claim + spawn one job (manual tick)
npm run follow-up:reconcile                       # reconcile in-progress jobs (manual tick)
npm run follow-up:requeue -- <job-path> [reason]  # re-arm a completed job
npm run follow-up:stop -- <job-path> [reason]     # stop an in-progress job
npm run follow-up:cancel-worker -- <job-path> [reason]  # signal spawned worker without moving job state
npm run review:cancel -- --repo <slug> --pr <n> [reason]  # signal active reviewer without moving review state
npm run merge-agent:cancel -- --repo <slug> --pr <n> [reason]  # cancel latest merge-agent LRQ + clear dispatched marker
npm run no-merge:hold -- --repo <slug> --pr <n> [reason]  # apply a no-merge hold label for one PR/ticket
npm run ticket-pipeline:pause -- --repo <slug> --pr <n> [reason]  # pause Linear sync for one PR via label
npm run ticket-pipeline:pause -- --repo <slug> --scope repo [reason]  # pause Linear sync for the whole repo
npm run check-branch-protection                   # verify agent-os/adversarial-gate is required
npm run retrigger-review -- --repo <slug> --pr <n> --reason "<why>"  # force a re-review pass
npm run retrigger-remediation -- --repo <slug> --pr <n> --reason "<why>"  # bump/requeue one remediation round
```

To pause the daemon during an outage:

```bash
launchctl bootout gui/$UID/ai.laceyenterprises.adversarial-follow-up
```

To resume (the install layout deploys the plist with the `.placey` suffix dropped — see README "Install LaunchAgents" — so resume uses the deployed filename, NOT the per-user template name from `launchd/`):

```bash
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/ai.laceyenterprises.adversarial-follow-up.plist
launchctl kickstart gui/$UID/ai.laceyenterprises.adversarial-follow-up
```

Daemon log: `~/Library/Logs/adversarial-follow-up.log`.

Daemon capacity knob:

```bash
ADVERSARIAL_REMEDIATION_MAX_CONCURRENT_JOBS=2
```

The value is read at daemon startup. Invalid, missing, or non-positive values fall back to `1`, preserving the historical one-job behavior. Values above `8` are clamped to `8`, and the daemon logs the clamp in its startup line so operators can spot a typo before the next tick fans out too far. Raising it lets a tick claim and spawn multiple pending jobs until `in-progress/` plus newly spawned jobs reaches the cap. Pending jobs for a PR that already has an in-progress remediation worker are left pending for a later tick; other PRs can still fill the remaining capacity.

Default agent routing knobs:

```bash
ADVERSARIAL_REVIEW_DEFAULT_REVIEWER=codex
ADVERSARIAL_REVIEW_DEFAULT_REMEDIATOR=codex
```

Leave `ADVERSARIAL_REVIEW_DEFAULT_REVIEWER` unset for the normal opposite-agent reviewer routing: `[codex]` PRs go to Claude, while `[claude-code]` and `[clio-agent]` PRs go to Codex. Set it to `codex` to lock Claude out of first-pass reviews, or to `claude` to force Claude reviews for every supported builder class. The forced reviewer also selects the matching reviewer bot token (`GH_CODEX_REVIEWER_TOKEN` or `GH_CLAUDE_REVIEWER_TOKEN`). The watcher validates this knob at startup and exits non-zero on invalid values; under launchd that means a typo in this optional knob intentionally crash-loops the watcher until the env is fixed, with a `FATAL config: ADVERSARIAL_REVIEW_DEFAULT_REVIEWER...` banner in stderr identifying the cause. If the pin deliberately causes same-family review, the watcher logs a waiver and the posted review body includes a cross-model-waiver note for auditability. That waiver is audit-only and does not alter the merge gate; a same-family `Comment only` review can still satisfy the automated gate unless an operator or branch-protection policy adds a separate human check.

Leave `ADVERSARIAL_REVIEW_DEFAULT_REMEDIATOR` unset for the current LAC-358 codex remediation default. Set it to `claude-code` only when Claude Code is approved for unattended remediation again. Unknown non-empty values fail closed instead of silently falling back to an expensive or unintended agent. The follow-up daemon validates this knob at startup before consuming work, and the claimed-job failure path also traps invalid values so a direct helper call cannot strand a job in `in-progress/`; because this is a global config error rather than a job-specific worker failure, the claimed job is restored to `pending/` with `lastConfigValidationFailure.code=config-validation-failure` so it can run after the env is corrected.

Workspace root:

```bash
HQ_ROOT=/Users/airlock/agent-os-hq
ADVERSARIAL_REMEDIATION_WORKSPACE_ROOT=/optional/explicit/workspace-root
```

When `HQ_ROOT` is set, remediation workers clone PR branches under `HQ_ROOT/adversarial-review/follow-up-workspaces/` instead of under the deployed adversarial-review checkout. `ADVERSARIAL_REMEDIATION_WORKSPACE_ROOT` can override that location, but it must not point inside the deploy checkout. If the daemon is running from `/Users/airlock/agent-os` without either setting, it refuses to spawn mutable worker clones.

## Auth-context troubleshooting

Claude Code OAuth is stored in the macOS Keychain (`Claude Code-credentials`), not in a file like Codex's `~/.codex/auth.json`. When `reviewer.mjs` is launched from a LaunchAgent, direct subprocess execs of the Claude CLI can miss the user's Aqua/keychain context even though they run as the same uid. The reviewer now routes all Claude probe and review calls through `/bin/launchctl asuser $UID /opt/homebrew/bin/claude ...` on Darwin so launchd-spawned reviews inherit the correct login/keychain context. If Claude auth starts failing again from automation, verify that wrapped command succeeds before debugging higher-level retry behavior.

---

## Remediation round budgets

New follow-up jobs derive their default remediation budget from the linked spec ticket's `riskClass`:

| riskClass | remediation rounds |
|---|---:|
| `low` | 1 |
| `medium` | 2 |
| `high` | 3 |
| `critical` | 4 |

The old table (`low/medium=1`, `high/critical=3`) no longer applies to new jobs: medium now gets the auto-queued retry round, and critical gets one extra iteration before operator handoff. After the stored cap is consumed, the next adversarial review still runs. If a human accepts the current head, the `operator-approved` label can dispatch merge-agent, but only when the latest matching GitHub `labeled` event is attributable, appears after the PR timeline code event for the current head SHA, and was not applied by the PR author. It bypasses missing/unknown verdicts, `Request changes`, active/unknown remediation state, and claimable remediation rounds; not-mergeable state, failed or pending CI, closed PRs, and explicit skip labels remain hard gates. PRs without a discoverable spec linkage fall back to `medium` -> `2` rounds.

## Operator merge-agent labels

Before enabling GitHub-native merge or auto-merge for this repo, require `agent-os/adversarial-gate` in branch protection. That status is the GitHub-facing projection of the adversarial-review ledger; without making it required, GitHub can merge a PR even when the durable review/remediation loop is still pending or blocked. If you intentionally rename the gate with `ADV_GATE_STATUS_CONTEXT`, use a value matching `[A-Za-z0-9._/-]+` with a 100-character maximum, then update branch protection and every watcher/probe deployment to the same override before trusting the new check.

The watcher now checks that protection on a cached interval and logs `branch-protection-warning` for any watched repo/base branch where the required context is absent, unreadable, or configured with an invalid `ADV_GATE_STATUS_CONTEXT`. Run `npm run check-branch-protection` for an operator-side audit; pass `-- --repo <owner/repo>` or `-- --base <branch>` to narrow the probe.

`operator-approved` is the operator's current-head merge approval. It is accepted only from an attributable GitHub `labeled` event that appears in the PR timeline after the code event for the current head SHA; GitHub issue comments, review posts, and other non-code PR updates do not make that approval stale. A PR author cannot approve their own PR with this label. When scoped, it bypasses review/remediation state gates so the operator can merge during a pending review or stuck remediation loop. It still requires an open, mergeable PR with known successful checks and no explicit skip label.

GitHub check rollup handling separates unknown state from repos with no configured check contexts. A missing or malformed `statusCheckRollup` remains unknown and returns `skip-checks-unknown` on the normal and `operator-approved` paths. An explicit empty rollup from GitHub means there are no reported check contexts for that PR, so it is treated as successful for merge-agent dispatch. A rollup whose only reported check is the adversarial-review pipeline's own gate commit status (`agent-os/adversarial-gate` by default, resolved through `ADV_GATE_STATUS_CONTEXT`) is also treated as successful for dispatch because that status just mirrors the already-known review verdict and must not become a circular merge gate. That exclusion is intentionally limited to status-context items; check runs and all other external CI signals still gate normally. Operators relying only on the adversarial-review gate should still keep `agent-os/adversarial-gate` required in branch protection so GitHub itself cannot merge around the durable review ledger.

`merge-agent-requested` is the stronger stuck-branch request. It is accepted only from an attributable GitHub `labeled` event scoped to the current head SHA. When scoped, it can bypass missing or unknown verdicts, mergeability, failed or pending checks, and remediation-round gates so merge-agent can clean the branch. It still does not bypass closed/merged PRs, active remediation, explicit skip labels, or duplicate-dispatch protection. Stale or unattributed requests return `skip-merge-agent-requested-stale`.

Normal merge-agent dispatch only treats remediation as active when the latest follow-up job for the current head SHA is `pending` or `in_progress`/`in-progress`. Stale pending or in-progress jobs for older PR heads are ignored for this merge gate; they must not strand a newer clean head that already has its own review verdict. When debugging a skipped dispatch, compare the dispatch candidate `headSha` with the follow-up job `revisionRef` before assuming the active-remediation block is current.

The stale-posted-review auto-refresh path uses the same current-head semantics. A moved PR head with a posted review normally re-arms adversarial review immediately; the watcher suppresses that rereview only when it can prove the merge-agent still owns the current head, either via a scoped current-head `merge-agent-requested` event or a live current-head dispatch state. Raw GitHub label presence alone is not authoritative for this path because stale labels, cleanup retries, and `awaiting-rereview` handoffs must not wedge a PR on an old posted review.

Merge-agent dispatch priority is trigger-scoped, not universal. Clean-verdict launches, `operator-approved`, and `final-pass-on-budget-exhausted` dispatch with `--priority normal`. Only a scoped `merge-agent-requested` launch uses `--priority critical`, because that label is the operator's explicit memory-pressure / stuck-branch escape hatch. Clean-verdict launches also use the merge-agent's merge-by-default convergence contract now: they run `comment_only_followups.py`, apply bounded in-PR follow-ups inline, wait only for real external CI on the pushed head, ignore the adversarial-review gate status as a blocking check, and request re-review only for genuinely major in-PR refactors. Every dispatch record under `data/follow-up-jobs/merge-agent-dispatches/` persists `trigger`, the resolved `priority`, and `priorityFlagSupported`; check that JSON before inferring which admission lane was used. If `priorityFlagSupported` is `false`, the watcher hit an older `hq` binary, retried without `--priority`, and the launch ran in legacy compatibility mode instead of a named lane.

The critical lane is the worker-pool reserved lane controlled by `HQ_PRIORITY_LANE_CAPACITY` (default `1`). If `HQ_PRIORITY_LANE_CAPACITY=0`, the reservation is disabled and `critical` no longer bypasses `refuse_admit_memory_pressure`; expect the request to behave like ordinary high-priority work. To inspect contention, run `hq priority-lane status --root /Users/airlock/agent-os-hq` and compare the output with the recorded merge-agent dispatch JSON plus `hq dispatch status <dispatchId>` for the LRQ you are debugging.

`merge-agent-skip`, `do-not-merge`, and `no-merge-hold` are unbypassable skip labels. They win over both override labels and surface as `skip-operator-skip`. `merge-agent-stuck` remains the terminal handoff marker for watcher-owned auto-retries, but a scoped current-head `merge-agent-requested` label is the explicit operator recovery action for that state and can bypass `merge-agent-stuck` for one recovery dispatch. Stale or unattributed requests still fail closed as `skip-merge-agent-requested-stale`.

`no-merge-hold` is the operator-friendly ticket/PR hold. Apply it with `npm run no-merge:hold -- --repo <owner/repo> --pr <n> "<reason>"`. The command creates the GitHub repository label if needed, applies it to the PR, and writes an operator-mutation receipt under `data/operator-mutations/no-merge-holds/`. While present, it blocks future merge-agent dispatch decisions and the adversarial gate even if `operator-approved` or `merge-agent-requested` is also present. It does **not** stop a merge-agent worker that was already dispatched before the hold landed; cancel that separately with `npm run merge-agent:cancel -- --repo <owner/repo> --pr <n> "<reason>"`. Release the hold with the same command plus `--resume`.

Dispatch precedence is intentionally diagnostic-first for hard stops: closed/merged PRs, unbypassable skip labels (`merge-agent-skip`, `do-not-merge`), scoped `operator-approved` hard gates, active remediation, normal verdict/mergeable/check/remediation diagnostics, scoped `merge-agent-requested` override, stale `operator-approved` diagnostics only when no dispatch path applies, duplicate-dispatch protection, then dispatch. `merge-agent-stuck` normally surfaces `skip-operator-skip`, but a scoped current-head `merge-agent-requested` label is evaluated first for the explicit operator recovery path and stale recovery requests fail closed as `skip-merge-agent-requested-stale`. A scoped `operator-approved` label surfaces mergeability/check diagnostics before dispatching, and otherwise bypasses review/remediation diagnostics. If a scoped `merge-agent-requested` label is present on a PR that was already green enough for the normal path, or on a `merge-agent-stuck` PR the operator is explicitly recovering, the request label authorizes that dispatch and is consumed. After a successful dispatch, the watcher removes only the label that actually authorized that dispatch; unused labels stay in place as operator audit trail.

`merge-agent-dispatched` is the watcher-owned lifecycle marker for an active merge-agent dispatch. The watcher adds it after a successful `hq dispatch`; if the label add fails, the failed add is recorded under `data/follow-up-jobs/merge-agent-lifecycle-cleanups/` and retried on later ticks instead of being lost as a log-only side effect. That unresolved `transition: "dispatched-label-add"` cleanup record is part of the watcher-owned lifecycle contract: if the worker later dies in a terminal retryable state before the label ever lands, the watcher still treats the dispatch as "died without handoff" and may reclaim it instead of wedging forever on `skip-already-dispatched`. On merge or close, the watcher writes a durable cleanup record before the PR leaves the open-set query, attempts `hq dispatch cancel <lrq>`, and retries that cleanup on later ticks until both worker cancellation and label removal converge. Operator `npm run merge-agent:cancel` now writes the same cleanup record when it gets a retryable partial failure on an open PR, so a stranded `merge-agent-dispatched` label is replayed by the watcher instead of being a best-effort one-shot. Non-terminal cancel failures keep the label present as the public retry signal; terminal cancel outcomes such as "already terminated" still proceed to label removal so stale labels do not linger forever. Cleanup retries are paced and capped per poll so an HQ or GitHub outage does not monopolize the watcher; malformed cleanup records are logged loudly instead of being silently dropped.

Watcher-owned same-head re-dispatch is bounded and status-scoped. Autonomous retries are allowed only when the prior LRQ is terminal `failed`, `superseded`, or authoritative `not-found`, and the per-head `watcherReDispatchCount` budget in the dispatch record is still below the bound. `cancelled` / `canceled` do not auto-relaunch; that remains operator intent and requires a scoped `merge-agent-requested` label. The `not-found` classification is safe only when the watcher definitely passed `--as-owner <hq owner>` to `hq dispatch status`; if `.hq/config.json` is unreadable, malformed, or missing `ownerUser`, the watcher logs the degraded state, treats the status as unknown, and preserves duplicate-dispatch protection instead of guessing that the LRQ is gone.

`ticket-pipeline-paused` is the PR-level Linear-ticket pipeline pause. Apply it with `npm run ticket-pipeline:pause -- --repo <owner/repo> --pr <n> "<reason>"`. The command creates the GitHub repository label if needed, applies it to the PR, and the watcher/reviewer skip Linear state changes and critical-flag comments while the label is present. Remove it with the same command plus `--resume`; release is idempotent if the label was already absent. For repo-wide outages, use `npm run ticket-pipeline:pause -- --repo <owner/repo> --scope repo --confirm-live-root "<reason>"`. The durable pause file resolves to `ADVERSARIAL_TICKET_PIPELINE_ROOT` when set, otherwise `HQ_ROOT/adversarial-review` when `HQ_ROOT` is set, otherwise the selected checkout root (overrideable with `--root <path>`). The live Linear triage adapter persists its resolved pause root to `data/ticket-pipeline-pauses/daemon-root-status.json`; repo-scope writes compare against that status and refuse if the operator shell resolves a different pause root. Corrupt repo-pause records fail closed and also write an alert receipt under `data/ticket-pipeline-pauses/alerts/` so the stall is visible outside a single log line.

Legacy in-flight jobs keep their persisted `maxRounds` cap. Fresh jobs re-derive from risk class unless the latest PR cap is higher than the current tier, in which case the elevated cap is preserved as the in-flight/operator migration guard. Do not retroactively rewrite existing queue records.

---

## Mental model

There are two separate state machines here:

1. **Watcher delivery state** in SQLite (`data/reviews.db`)
2. **Follow-up remediation queue state** in JSON files (`data/follow-up-jobs/*`)

They interact, but they are not the same thing.

- SQLite answers: *has this PR been reviewed / can it be reviewed again?*
- Follow-up jobs answer: *what remediation round is happening around this already-posted review?*

A lot of operator confusion comes from mixing those two ledgers together.

---

## End-to-end architecture

```text
GitHub PR
  │
  ▼
watcher.mjs
  │ validate title tag + choose route
  ▼
reviewer.mjs
  │ fetch diff, run adversarial review, post review
  ▼
create follow-up job JSON
  │
  ▼
data/follow-up-jobs/pending/<jobId>.json
  │
  ├─(operator) npm run follow-up:consume
  ▼
data/follow-up-jobs/in-progress/<jobId>.json
  │
  ▼
detached remediation worker on checked-out PR branch
  │ writes artifacts
  ├─ workspace: prompt.md / codex-last-message.md / codex-worker.log
  └─ HQ: dispatch/remediation-replies/<storage-key>/remediation-reply.json
  │
  ├─(operator) npm run follow-up:reconcile
  ▼
terminal queue state
  ├─ completed/   -> valid rereview request recorded
  ├─ failed/      -> launch/reconcile/artifact failure
  └─ stopped/     -> bounded stop (no-progress, operator-stop, max-rounds-reached, round-budget-exhausted)
  │
  └─ if rereview requested:
       requestReviewRereview(...)
       -> reviews.db row reset to review_status='pending'
       -> watcher may pick the PR up again
```

The follow-up daemon runs a daily stopped-job archive sweep during its normal tick loop. Jobs remain in `stopped/` until their semantic `stoppedAt` age is at least 24 hours old (mtime is only a fallback for legacy or corrupt records), then move to `stopped-archived/YYYY-MM/`. Archive target collisions are not silently destructive: byte-identical sources may be deduplicated, divergent sources stay in `stopped/`, the daemon logs a separate `collisions` count, and a structured anomaly record is written under `data/archive-anomalies/`.

---

## State transition diagram

### Follow-up queue transitions

```text
pending
  │
  ├─ follow-up:consume
  ▼
in-progress
  │
  ├─ worker still alive during reconcile
  │    └─ stays in-progress
  │
  ├─ launch preparation fails
  │    └─ failed
  │
  ├─ worker exits, final artifact missing/invalid
  │    └─ failed
  │
  ├─ worker exits, valid reply, rereview requested=true, contamination audit clean
  │    └─ completed
  │
  ├─ worker exits, valid reply, rereview requested=true, contamination audit finds patch-equivalent commits already on origin/<baseBranch>
  │    └─ failed (code=branch-contamination)
  │
  ├─ worker exits, no durable rereview request
  │    └─ stopped (code=no-progress)
  │
  ├─ pending job was reviewed on an older PR head
  │    └─ stopped (code=stale-review-head)
  │
  ├─ operator merged the PR before remediation completed
  │    └─ stopped (code=operator-merged-pr)
  │
  ├─ operator closed the PR (unmerged) before remediation completed
  │    └─ stopped (code=operator-closed-pr)
  │
  └─ operator stop
       └─ stopped (code=operator-stop)

pending/in-progress
  │
  └─ claimed round exceeds the PR-wide round budget
       └─ stopped (code=round-budget-exhausted)

completed
  │
  ├─ operator requeue
  │    └─ pending
  │
  └─ if maxRounds already reached
       └─ stopped (code=max-rounds-reached)

failed
  │
  ├─ operator requeue
  │    └─ pending
  │
  └─ if maxRounds already reached
       └─ stopped (code=max-rounds-reached)
```

### Watcher delivery state transitions

```text
new tagged PR
  │
  ├─ malformed title
  │    └─ malformed   (terminal by design)
  │
  └─ valid tagged PR
       └─ pending
            │
            ├─ successful review post
            │    └─ posted
            │
            ├─ review attempt fails
            │    └─ failed
            │
            └─ remediation rereview request accepted
                 └─ pending   (re-armed for another watcher pass)
```

### Important consequence

A follow-up job can be `completed` while the PR is still far from done.

Here, `completed` means:

- the remediation round finished cleanly
- a durable rereview request was accepted
- the queue round reached terminal success

It does **not** mean the PR is merged, approved, or production-ready.

---

## Lifecycle in detail

### 1. Review pickup and follow-up job creation

When the watcher successfully posts an adversarial review comment, it writes a durable JSON job under:

```text
data/follow-up-jobs/pending/
```

That job includes:

- PR identity: `repo`, `prNumber`, `linearTicketId`, `reviewerModel`
- review context: `reviewSummary`, `reviewBody`, `critical`
- bounded-loop state: `remediationPlan.mode`, `maxRounds`, `currentRound`, `rounds[]`
- reply contract state: `remediationReply.state`
- future-session placeholder metadata: `sessionHandoff`

Initial state:

- `status = "pending"`
- `remediationPlan.mode = "bounded-manual-rounds"`
- `remediationPlan.maxRounds = riskClass-derived budget` for new jobs (`low=1`, `medium=2`, `high=3`, `critical=4`), except when the latest PR ledger cap is already higher than the current tier; that elevated legacy/operator cap is preserved
- `remediationPlan.currentRound = priorCompletedRoundsForPR` — seeded from the PR's accumulated remediation rounds so the cap is enforced PR-wide; `0` for the very first follow-up job created for a PR
- `remediationReply.state = "awaiting-worker-write"`
- `remediationPlan.nextAction.type = "consume-pending-round"`

### 2. Start one remediation round

Consume the oldest pending job:

```bash
npm run follow-up:consume
```

What this does:

- claims the oldest JSON file in `data/follow-up-jobs/pending/`
- moves it to `data/follow-up-jobs/in-progress/`
- increments `remediationPlan.currentRound`
- appends a round entry to `remediationPlan.rounds[]`
- prepares a workspace under `HQ_ROOT/adversarial-review/follow-up-workspaces/<jobId>/` when `HQ_ROOT` is set
- checks out the existing PR branch there with `gh pr checkout`
- writes worker artifacts under `<workspace>/.adversarial-follow-up/`
- spawns a detached Codex remediation worker

Launch artifacts written into the job record include:

- `remediationWorker.processId`
- `remediationWorker.workspaceDir`
- `remediationWorker.promptPath`
- `remediationWorker.outputPath`
- `remediationWorker.logPath`
- `remediationWorker.replyPath`
- `remediationWorker.workspaceState`

Current worker authority and expectations:

- edit code in the checked-out PR branch
- run focused validation
- commit the remediation changes and push the PR branch
- write a machine-readable remediation reply JSON file
- do not open a new PR
- do not merge the PR

Operator-triggered retriggers use a separate durable ledger under `data/operator-mutations/` by default. The storage is repo-local so the CLIs stay writable under the normal `placey` runtime account; `--audit-root-dir` can relocate that ledger when an operator intentionally wants it elsewhere. Successful mutations are idempotent by key; previously refused attempts stay in the ledger for operator history but do not block a later retry after conditions change. PR-label retriggers are keyed to the GitHub `labeled` event id, not just the current job, so a stale `retrigger-remediation` label can retry audit/label cleanup without authorizing another budget bump after a later halt.

`reset-pr` is also an operator mutation and reserves a `pending` receipt in `data/operator-mutations/` before moving queue files into `_operator-reset/`. A successful run rewrites that receipt with the final moved list. If a move fails after partial mutation, the same receipt is rewritten with `outcome: "partial"` and the moved entries known so far, leaving operators with a durable audit trail instead of a silent filesystem change.

If launch preparation fails, the claimed job moves to:

```text
data/follow-up-jobs/failed/
```

### 3. Worker finishes and writes reply/output artifacts

The detached worker is expected to leave two important workspace artifacts plus one durable HQ artifact:

- final message: `.adversarial-follow-up/codex-last-message.md`
- worker log: `.adversarial-follow-up/codex-worker.log`
- reply JSON: `~/agent-os-hq/dispatch/remediation-replies/<storage-key>/remediation-reply.json`

The worktree's `.adversarial-follow-up/` directory is now a prompt/log sandbox only. It should not contain `remediation-reply.json` for newly spawned jobs.

The final message is operator-facing completion text.

The reply JSON is the durable control-plane signal. It must use kind:

```text
adversarial-review-remediation-reply
```

and it is where re-review intent is expressed:

Per-finding accountability fields (`addressed[]`, `pushback[]`, and
structured `blockers[]`) are public PR-comment input, not a scratchpad.
When the review gives blocking findings `Title:` fields, new replies
must copy those titles into the matching entries. The validator compares
titles with normalization for case, dash variants, quote variants, and
whitespace so humans are not punished for harmless typography, while
errors still show the original expected and supplied text.

Keep per-finding `finding`, `action`, `reasoning`, and
`needsHumanInput` fields short: 1200 characters and 20 non-empty lines
per field. The validator rejects raw JSON/log/tool-output/traceback/diff
shapes and markdown code blocks that start a line with a fence opener.
Inline prose that merely mentions triple backticks is allowed.

String `blockers[]` entries are legacy/salvage-only compatibility for
old or hand-edited artifacts that bypass strict validation. New worker
replies should always use structured blocker objects.

- `reReview.requested = true` means the worker is asking for another adversarial review pass
- if `reReview.requested = true`, `reReview.reason` is required

Prose alone is not enough to trigger another review pass.

---

## Stop codes

### `round-budget-exhausted`

Meaning:
- the queue record attempted to enter a remediation round that exceeds the PR's stored round budget
- this is the substrate-level refusal for Track A

Typical cause:
- a legacy job still carries a persisted `maxRounds` cap that differs from the current default
- or an operator manually requeued a PR after its allowed round budget was already consumed

Operator action:
- review the completed remediation rounds already on the PR
- if the PR is ready, move it to merge/manual integration handling
- if more remediation is truly required, use `npm run retrigger-remediation` with an explicit operator reason and any intentional `maxRounds` bump

### `max-rounds-reached`

Meaning:
- the job reached its own persisted `maxRounds` cap

Operator action:
- inspect the prior rounds and decide whether to merge, stop, or create a newly authorized follow-up path
- `npm run retrigger-remediation -- --repo <slug> --pr <n> --reason "<why>"` is the canonical operator path when you are intentionally authorizing one more round

### `operator-stop`

Meaning:
- an operator explicitly stopped the follow-up loop

Operator action:
- continue with manual handling

### Cancel a spawned worker without changing job state

Use this when the remediation worker process itself needs to be interrupted but
the follow-up job should remain in its current durable state for normal
reconcile. This is the right handle for stopping a duplicate or runaway worker
without moving the job to `stopped/` first:

```bash
npm run follow-up:cancel-worker -- data/follow-up-jobs/in-progress/<jobId>.json "Duplicate worker; operator is applying the remediation manually"
```

Behavior:

- reads only the in-progress job JSON and its persisted `remediationWorker`
  process handle
- verifies process-group liveness and start-time identity before signalling,
  then sends `SIGTERM` to the worker process group by default
- writes an audit receipt under `data/follow-up-jobs/worker-cancellations/`
- does not move the job file or mutate the review/follow-up ledger state

Use `--signal SIGKILL` only after `SIGTERM` has failed or the process is known
to ignore graceful termination.

### Cancel an active reviewer without changing review state

Use this when the first-pass or re-review process itself needs to be
interrupted but `reviews.db` should remain the durable source of truth for the
normal orphan/reconcile path:

```bash
npm run review:cancel -- --repo <owner/repo> --pr <n> "Duplicate active reviewer; operator is restarting the loop"
```

Behavior:

- reads the `review_status='reviewing'` row from `data/reviews.db`
- verifies process-group liveness and start-time identity before signalling,
  then sends `SIGTERM` to the persisted `reviewer_pgid` process group by default
- writes an audit receipt under `data/review-cancellations/`
- does not mutate `review_status`, retry counters, or any PR state columns

Use `--signal SIGKILL` only after `SIGTERM` has failed or the process is known
to ignore graceful termination.

### Cancel the latest merge-agent dispatch

Use this when a merge-agent LRQ should be interrupted for an open PR without
waiting for merge/close lifecycle cleanup:

```bash
npm run merge-agent:cancel -- --repo <owner/repo> --pr <n> "Operator is holding this merge"
```

Behavior:

- reads the latest matching merge-agent dispatch record under
  `data/follow-up-jobs/merge-agent-dispatches/`
- runs `hq dispatch cancel <lrq>` when an LRQ is present
- removes the `merge-agent-dispatched` label after cancellation reaches a
  terminal outcome
- writes an audit receipt under `data/follow-up-jobs/merge-agent-cancellations/`
- does not mutate `reviews.db` or follow-up job state

If the cancel path reports `retryable=true`, inspect the receipt and retry after
the HQ or GitHub label-write failure clears.

## Operator retrigger contracts

`retrigger-review` and `retrigger-remediation` are distinct surfaces and are intentionally idempotent:

- `retrigger-review` resets the watcher row back to `review_status='pending'`. Its exit-code contract is stable: `0=triggered/already-pending`, `1=blocked`, `2=usage`, `3=reason input`, `4=runtime`.
- `retrigger-remediation` requeues the latest terminal follow-up job and optionally bumps `remediationPlan.maxRounds`. It starts with a remediation worker responding to the last posted review; it does not reset `reviews.db` for another review first. If the watcher row is already `review_status='pending'`, reviewer dispatch is still deferred while the latest follow-up job is `pending` or `inProgress`, so the worker cannot race a fresh review verdict. It only accepts terminal jobs in `failed`, `completed` with `reReview.requested=true`, or `stopped:{max-rounds-reached,round-budget-exhausted,daemon-bounce-safety,review-settled}`. `stopped:review-settled` is accepted because the automatic loop stops on Comment-only reviews, while an explicit operator flag means "address the remaining non-blocking findings." The requeue records that one-shot operator override on `remediationPlan.nextAction={type:'consume-pending-round', operatorOverride:true, requestedAt, requestedBy, operatorVisibility:'explicit'}`; the next `claimNextFollowUpJob` must honor it by skipping the `review-settled` early-stop once, then consume it by rewriting `nextAction` to `worker-spawn`. While the requeued job is `pending` or `inProgress`, the adversarial gate remains pending even if the stored review body is still Comment-only. It still refuses `stopped:operator-stop` and `stopped:rereview-blocked` so explicit operator halts and watcher refusals do not silently spawn another worker. If the worker fails or is stopped before leaving a durable `reReview.requested=true` reply, no fresh adversarial review is queued; apply `retrigger-review` separately when an operator wants a review without another worker pass. If a launch crash happens after claim but before spawn, let reconcile mark the in-progress job `failed` (or use the documented operator stop/reset path), then apply `retrigger-remediation` again; active jobs intentionally refuse duplicate retriggers. Its exit-code contract is also stable: `0=success`, `1=blocked`, `2=usage`, `3=reason input`, `4=runtime`.
- Both commands default their durable mutation ledger to `data/operator-mutations/` under the tool root, not `HQ_ROOT/dispatch/`, so they remain writable from the documented `placey` LaunchAgent topology.
- Both commands derive a default idempotency key from `(verb, repo, pr, reason)`. A previously successful key replays as a no-op success; a previously refused key is re-evaluated so operators can retry after state changes without minting a new key.

For `review_status='failed-orphan'`, inspect the GitHub PR first. If no orphaned reviewer post landed, run `npm run retrigger-review -- --repo <slug> --pr <n> --reason "<verified reason>"`; that is the supported clear path for the sticky row and lets the next watcher tick publish the next non-failure `agent-os/adversarial-gate` state. Do not hand-edit `data/reviews.db` or the local gate-record file to clear it.

### 4. Reconcile detached completion

Reconciliation is explicit and one-shot:

```bash
npm run follow-up:reconcile
```

What reconciliation inspects:

- only jobs in `data/follow-up-jobs/in-progress/`
- only jobs whose `remediationWorker.state` is `spawned`

Possible outcomes:

- worker PID still live: job stays `in_progress`
- worker PID gone, `remediation-reply.json` exists but is malformed / fails schema validation / does not match the job: job moves to `failed/` with code `invalid-remediation-reply` (this path is taken regardless of whether stdout is empty — the invalid reply is the load-bearing signal, not a missing narrative)
- worker PID gone, final message artifact missing or empty, AND no valid reply artifact: job moves to `failed/`
- worker PID gone, final message artifact present (non-empty stdout):
  - if a valid reply requested re-review and the `git cherry origin/<baseBranch> HEAD` audit is clean, job moves to `completed/`
  - if a valid reply requested re-review but the contamination audit finds patch-equivalent commits already merged on the base branch, job moves to `failed/` with code `branch-contamination`, records the suspect commits in the failed ledger entry, and still runs the normal reconcile-time PR comment delivery path
  - if no durable re-review request was recorded, job moves to `stopped/`
- worker PID gone, final message artifact missing or empty, BUT a valid reply artifact exists (e.g. a tool-only `claude-code` worker that pushed code + wrote `remediation-reply.json` but emitted no stdout narrative): the validated reply is the durable success signal — `reReview.requested` (per SPEC.md §5.1.2), NOT `outcome`, decides the terminal state. Routes to `completed/` if rereview was requested, otherwise to `stopped/` with code `no-progress`.

Reconciliation never starts another remediation round on its own.

### 5. Re-review trigger

If the worker wrote a valid reply JSON with `reReview.requested = true`, reconciliation tries to reset the matching watcher row in `data/reviews.db` back to `review_status = 'pending'`.

Before it does that reset, reconcile fetches `origin/<baseBranch>` and runs the same `git cherry origin/<baseBranch> HEAD` audit the prompt requires from the worker. A `-` marker means the PR branch still contains a patch-equivalent copy of a commit already on the base branch. If either the fetch or cherry step fails, reconcile now fails closed with a distinct `failed:branch-contamination-audit-error` record instead of assuming the branch is clean. In either case the round refuses to fabricate another review pass, because the next reviewer would otherwise run against an unproven or wrong branch state.

That is the shipped re-review trigger. The queue does not directly post another review.

If the reset succeeds:

- the follow-up job ends in `completed/`
- `job.reReview.requested = true`
- `job.reReview.triggered = true`
- `job.reReview.status = "pending"`

Then the next watcher poll can pick that PR up for another adversarial review pass.

### 6. Bounded stop conditions

The loop is intentionally capped and explicit. A job moves to `data/follow-up-jobs/stopped/` when one of these durable stop conditions applies:

- `operator-stop`
- `no-progress`
- `max-rounds-reached`
- `stale-review-head`

`no-progress` means the latest remediation round finished without a durable re-review request. This is deliberate: the system stops instead of silently pretending forward progress exists.

`max-rounds-reached` means another round would exceed the stored `remediationPlan.maxRounds` cap.

`stale-review-head` means the follow-up job was created for an older reviewed head SHA and the consume-time lifecycle lookup already sees a newer PR head. This is a stale-job/race guard before worker spawn, not a reconcile-time failure mode: once a remediation worker pushes commits, the PR head is expected to differ from `job.revisionRef`, and that success path must continue to the rereview request.

`operator-merged-pr` means the PR was merged before remediation could complete. The lifecycle gate prefers a live `gh pr view` lookup over the SQLite mirror so it doesn't depend on the watcher's `syncPRLifecycle` poll cadence — when GitHub says merged, the gate stops cleanly even if `reviews.db.pr_state` is still stale. On a `gh` outage the gate falls back to the mirror so it degrades gracefully rather than disappearing. Fires from both the consume path (gate before worker spawn) and the reconcile path (gate after worker exit, before rereview reset). The terminal record carries the merged-at timestamp under `remediationPlan.stop.reason`, plus a `source=live|mirror` tag so operators can tell which path supplied the answer.

`operator-closed-pr` means the PR was closed unmerged before remediation could complete. Same gate as `operator-merged-pr` — `requestReviewRereview` already refuses `pr_state != 'open'` and a comment on a closed PR is noise — but the separate stop code lets operator reporting distinguish "we shipped this" from "we abandoned this".

---

## Operator control surface

### Inspect queue state

There is no dedicated list/status CLI yet. Inspect the queue directly:

```bash
find data/follow-up-jobs -maxdepth 2 -type f -name '*.json' | sort
```

For a specific job:

```bash
jq '.' data/follow-up-jobs/in-progress/<jobId>.json
```

The state directories are the queue:

- `pending/`: waiting for an operator to start a round
- `in-progress/`: claimed or spawned round
- `completed/`: worker finished and requested re-review; reconciliation recorded terminal success for that round
- `failed/`: launch or reconciliation failure
- `stopped/`: bounded-loop terminal stop
- `workspaces/`: legacy/local per-job repo checkout location. Production launches with `HQ_ROOT` set keep mutable worker clones under `HQ_ROOT/adversarial-review/follow-up-workspaces/` so remediators do not operate inside the live deploy checkout.
- `delivery-retry-index/`: pointer files for terminal jobs whose PR-comment delivery still owes a retry (`<jobId>.json` → `{ "jobPath": "..." }`). The retry tick reads only this directory; pointers are added on delivery failure and removed on success or terminal cap. Operators should not edit these by hand — to clear a stuck pointer, fix the underlying `commentDelivery.posted` state on the terminal record (or delete the record entirely if recovery is hopeless), and the next tick will prune the dangling pointer automatically.

### Start the next round

Only pending jobs can be consumed:

```bash
npm run follow-up:consume
```

If no work is pending, the command exits with a no-op message.

### Reconcile detached workers

Run:

```bash
npm run follow-up:reconcile
```

This is the normal way to convert spawned work into a durable terminal state.

### Request another bounded remediation round

Only `completed/` and `failed/` jobs are accepted:

```bash
npm run follow-up:requeue -- data/follow-up-jobs/completed/<jobId>.json "Need one more bounded remediation pass"
```

Requeue behavior:

- moves the existing record back to `pending/`
- preserves round history in `remediationPlan.rounds[]`
- clears transient terminal fields like `completion`, `failure`, and `remediationWorker`
- sets `remediationPlan.nextAction.type = "consume-pending-round"`

Guardrails:

- if the current round count already hit `maxRounds`, requeue stops the job with `max-rounds-reached`
- if the source job is `completed/` but `reReview.requested` is not `true`, requeue stops the job with `no-progress`
- this is why there is no hidden infinite loop

### Stop a job

Accepted source states:

- `pending`
- `in_progress`
- `completed`
- `failed`

Command:

```bash
npm run follow-up:stop -- data/follow-up-jobs/in-progress/<jobId>.json "Operator requested stop"
```

Stop behavior:

- moves the job to `stopped/`
- records `remediationPlan.stop.code = "operator-stop"`
- records `remediationPlan.stop.reason`
- records `remediationPlan.stop.stoppedBy`

---

## Durable metadata operators should read

### In the follow-up job JSON

These fields are the primary audit trail:

- `status`
- `jobId`
- `repo`
- `prNumber`
- `reviewSummary`
- `reviewBody`
- `remediationPlan.currentRound`
- `remediationPlan.maxRounds`
- `remediationPlan.rounds[]`
- `remediationPlan.nextAction`
- `remediationPlan.stop`
- `remediationWorker`
- `remediationReply`
- `reReview`
- `completion`
- `failure`

Round-level records in `remediationPlan.rounds[]` are especially important. They preserve:

- when a round was claimed and spawned
- which worker metadata applied to that round
- completion, failure, or stop details for that round

### In the workspace

For a spawned or terminalized round, inspect:

```text
HQ_ROOT/adversarial-review/follow-up-workspaces/<jobId>/
HQ_ROOT/adversarial-review/follow-up-workspaces/<jobId>/.adversarial-follow-up/prompt.md
HQ_ROOT/adversarial-review/follow-up-workspaces/<jobId>/.adversarial-follow-up/codex-last-message.md
HQ_ROOT/adversarial-review/follow-up-workspaces/<jobId>/.adversarial-follow-up/codex-worker.log
~/agent-os-hq/dispatch/remediation-replies/<storage-key>/remediation-reply.json
```

What each tells you:

- `prompt.md`: exact worker contract and trusted metadata passed to the worker
- `codex-last-message.md`: worker’s final narrative summary, used as the completion artifact
- `~/agent-os-hq/dispatch/remediation-replies/<storage-key>/remediation-reply.json`: machine-readable outcome and re-review intent
- `codex-worker.log`: launch/runtime stderr/stdout trail

### In SQLite

The watcher delivery ledger lives in:

```text
data/reviews.db
```

This is where reconciliation resets a PR back to `review_status = 'pending'` when a valid reply requests re-review.

Useful inspection query:

```bash
sqlite3 data/reviews.db "select id, repo, pr_number, reviewer, pr_state, review_status, review_attempts, last_attempted_at, posted_at, failed_at, failure_message, rereview_requested_at, rereview_reason from reviewed_prs where repo='laceyenterprises/adversarial-review' and pr_number=212;"
```

Interpretation:

- `review_status = 'pending'` means the watcher can pick the PR up again
- `review_status = 'posted'` means the previous review is terminal unless requeued by reconciliation or manual DB recovery
- `review_status = 'malformed'` is terminal by design for malformed-title cases

---

## Terminal states and what they mean

### `completed`

Meaning:

- the detached remediation worker produced a non-empty final message artifact
- if a reply path was configured, the reply JSON validated
- the worker requested another adversarial review pass
- the rereview reset was accepted by the watcher delivery ledger

Important nuance:

- `completed` here means successful completion of the remediation round plus durable re-review request handling
- it does **not** mean the PR is merged or finished

### `failed`

Meaning:

- launch preparation failed, or
- worker output artifact was missing/empty/invalid, or
- rereview handling failed in a way the reconciler treats as failure

This is an operator investigation state, not an automatic retry signal.

### `stopped`

Meaning:

- the loop intentionally terminated without arming another review round

Common reasons:

- `operator-stop`
- `no-progress`
- `max-rounds-reached`

`stopped` is often healthy. It frequently means the worker did not make a durable rereview request, so the control plane refused to guess.

---

## Maintenance and debugging tips

### 1. Check the durable artifact before debugging control flow

The HQ directory name is the persisted reply storage key: `<launchRequestId>` when the job carries one, otherwise `<jobId>`.

If a rereview didn’t happen, first inspect:

```bash
jq '.' ~/agent-os-hq/dispatch/remediation-replies/<storage-key>/remediation-reply.json
```

The most common root cause is simply that `reReview.requested` was absent or false.

During the one-week cutover window after LAC-373, reconcile also falls back once to the legacy worktree path `.adversarial-follow-up/remediation-reply.json` for in-flight jobs that started before deploy, and logs a deprecation warning when that fallback fires.

### 2. Reconcile is not automatic

A worker can finish successfully and the queue can still appear stuck in `in-progress/` if nobody ran:

```bash
npm run follow-up:reconcile
```

This is normal and by design.

### 3. Don’t confuse `completed` with “PR done”

Queue success means the remediation round closed successfully.
It says nothing by itself about merge readiness.

### 4. Malformed-title rows are intentionally sticky

If a PR hit malformed-title guardrails, don’t assume retitling later will restore the happy path.
The safer recovery remains: create a fresh, correctly tagged PR.

### 5. Use the workspace as the forensic record

Before guessing, inspect:

- worker prompt
- final message artifact
- reply artifact
- worker log
- round history in the job JSON

Usually the answer is already there.

### 6. Max rounds is a safety rail, not a suggestion

Default max rounds are risk-class derived: new jobs get `low=1`, `medium=2`, `high=3`, and `critical=4` remediation rounds (was `low/medium=1`, `high/critical=3` before 2026-05-06, and 6 before 2026-05-02). The cap is enforced PR-wide: each new follow-up job is seeded with the PR's prior accumulated rounds, so the cap counts the *PR's* remediation cycles, not a single job's. Ordinary persisted caps no longer carry forward forever; the watcher only preserves a latest cap that is higher than the current risk-class tier.

When the loop hits that cap, behavior is governed by the `MERGE_AGENT_FINAL_PASS_ON_REQUEST_CHANGES` env var read by the **watcher** process (the merge-agent dispatch decision lives in the watcher, NOT the follow-up daemon — this changed 2026-05-16). The code default is ON; the env var serves as an explicit off-switch for OSS / forks that want the legacy halt behavior.

- **Default ON (this deployment + code default):** After the cap is consumed and the verdict is still `Request changes`, the merge-agent is automatically dispatched with the `final-pass-on-budget-exhausted` trigger. The merge-agent's `comment_only_followups.py` sub-worker then **applies every actionable in-scope reviewer finding inline** — trivial polish and substantive non-trivial work alike. Light-to-medium fixes are pushed, checked, and merged without another review. Only major in-PR refactors trigger a fresh adversarial review pass. The sub-worker only records two non-apply outcomes:
  - `suggestions_unable_to_apply` for findings that genuinely cannot fit in this PR (multi-PR scope, cross-module refactors, conflicts with PR intent). These do NOT block the merge directly. The merge-agent must file Linear tickets for each follow-up refactor and proceed with the merge when no blocker remains; follow-up tickets must not live only as prose in the PR comment.
  - `blockers_observed` for blocker-class findings the sub-worker cannot safely fix (data corruption, secret leakage, security regression, broken external contract). Non-empty blockers hard-refuse the merge with `fail_with_receipt 13 merge-rejected`. The receipt embeds only the blocker count and normalized kind list; detailed payloads stay in the workspace-local `.adversarial-follow-up/followups-reply.json` so a secret-leakage blocker summary cannot re-leak via operator-visible logs.
  - A scoped `operator-approved` label still works as an explicit override and takes precedence. A *stale or unscoped* `operator-approved` label is a hard `skip-operator-approval-stale` regardless of the flag — the operator's signal that the PR needed manual attention is never overridden by the budget-exhausted final-pass path.
- **Explicit OFF (legacy / OSS deployments, `MERGE_AGENT_FINAL_PASS_ON_REQUEST_CHANGES=0` on the watcher LaunchAgent):** After the cap is consumed, the next adversarial review pass uses the lenient final-round verdict-categorization addendum, but the automated merge gate halts: if any finding remains (blocking or non-blocking), the verdict stays `Request changes` and the system posts a public PR comment saying human intervention is required. A current scoped `operator-approved` label is the explicit human override for that head, not an automated relaxation.

When the loop hits the cap, the first thing to check is which mode the watcher is in: `launchctl print gui/$(id -u <watcher-owner>)/ai.laceyenterprises.adversarial-watcher.<watcher-owner> | grep MERGE_AGENT_FINAL_PASS_ON_REQUEST_CHANGES` (NOT the follow-up daemon — that env was the pre-2026-05-16 contract and is no longer the control point). If unset or `=1` the flag is ON and you should see `merge-agent decision for <repo>#<pr>: dispatch` with the `final-pass-on-budget-exhausted` trigger in the watcher log. Then watch the `merge-agent-dispatches/` record and the merge-agent's own log to see how the triage step decided. If `suggestions_unable_to_apply` is non-empty, verify that corresponding Linear tickets were filed and that the merge-agent did not park the current PR merely because follow-up work exists. If `blockers_observed` fired, inspect `.adversarial-follow-up/followups-reply.json` on the merge-worker workspace (NOT the receipt) for the redacted payload and decide whether to add `do-not-merge` / `merge-agent-skip` or to split the blocker into its own PR.

Rollback to legacy halt behavior: edit the watcher LaunchAgent plist to set `MERGE_AGENT_FINAL_PASS_ON_REQUEST_CHANGES=0`, then `launchctl bootout gui/$(id -u <watcher-owner>)/ai.laceyenterprises.adversarial-watcher.<watcher-owner> && launchctl bootstrap gui/$(id -u <watcher-owner>) <plist-path>`. Universal hard-skip labels (`do-not-merge`, `merge-agent-skip`, `merge-agent-stuck`) work as per-PR emergency brakes either way.

### 7. Be careful with manual DB resets

Resetting `review_status='pending'` is powerful.
Use it for recovery, not to paper over malformed titles or to bypass queue semantics without understanding the consequences.

### 8. Cross-user auth/permission drift is a real failure mode

If workers or reviewers suddenly start failing after runtime/user changes, verify:

- CLI paths still exist
- Codex OAuth auth file is readable
- cross-user permissions still allow the active runtime to read required artifacts
- queue/workspace directories are writable by the runtime user

### 9. macOS TCC popups on reviewer or worker spawn

If "node would like to access X" / "claude would like to access X" popups start firing on subprocess spawn (typically on a fresh Mac, or after `brew upgrade node` / `brew upgrade --cask claude-code` shifts the underlying Cellar/Caskroom path), check **which** subprocess fired the popup before assuming it came from the follow-up loop:

- The watcher's first-pass reviewer subprocess (`src/watcher.mjs` → `src/reviewer.mjs::reviewWithClaude` / `reviewWithCodex`) execs the same protected binaries (`claude`, `codex`) and will pop TCC prompts on the same trigger conditions. A popup during a watcher tick is a reviewer-side popup, NOT a remediation-worker popup, even though the doc text and the binaries are the same.
- The follow-up daemon's remediation worker spawn (`src/follow-up-remediation.mjs::spawnCodexRemediationWorker` / `spawnClaudeCodeRemediationWorker`) is the other place the same binaries get exec'd. Daemon's own long-lived `node` process is approved once and stays approved — what re-prompts is each freshly-`exec`'d subprocess.

Both paths converge on the same TCC subjects, but their CLI resolution is **different** code (the reviewer hardcodes `CLAUDE_CLI` / `CODEX_CLI`; the worker uses `resolveCodexCliPath` / `resolveClaudeCodeCliPath` against the daemon's launch-time PATH). Resolve the exact paths each flow will use with `node scripts/print-tcc-targets.mjs`. Read `docs/MACOS-TCC.md` for the security tradeoff before granting Full Disk Access on a non-isolated host — both spawn flows already exec with bypass-style approvals on untrusted PR content, so FDA expands the trust boundary.

---

## Common operator playbooks

### A. “A remediation worker finished. Why didn’t we get another review?”

1. run `npm run follow-up:reconcile`
2. inspect `~/agent-os-hq/dispatch/remediation-replies/<storage-key>/remediation-reply.json`
3. verify `reReview.requested = true`
4. inspect `data/reviews.db` row for the PR
5. confirm the PR is still `pr_state='open'`

### B. “The queue says completed, but nothing has happened yet.”

Likely meaning:

- the remediation round successfully requested rereview
- the DB row was reset to `pending`
- the watcher has not polled / processed the PR again yet

Check watcher logs and `reviews.db`.

### C. “I want one more bounded remediation round.”

Use:

```bash
npm run follow-up:requeue -- data/follow-up-jobs/completed/<jobId>.json "Need one more bounded remediation pass"
```

Then consume it explicitly.

### D. “I want this to stop right now.”

Use:

```bash
npm run follow-up:stop -- data/follow-up-jobs/in-progress/<jobId>.json "Operator requested stop"
```

### E. “Something feels inconsistent.”

Inspect in this order:

1. queue JSON file
2. workspace artifacts
3. SQLite review row
4. watcher logs
5. worker log

---

## Canonical files to read before code changes

- `src/follow-up-jobs.mjs`
- `src/follow-up-remediation.mjs`
- `src/follow-up-reconcile.mjs`
- `src/follow-up-requeue.mjs`
- `src/follow-up-stop.mjs`
- `src/review-state.mjs`
- `src/watcher.mjs`

---

## Bottom line

The system is intentionally conservative.

- review posting is owned by the watcher path
- remediation is owned by the follow-up queue path
- rereview is armed only by durable JSON metadata
- explicit operator actions keep the loop bounded and debuggable

That conservatism is the feature. It keeps the service from silently spinning or fabricating progress.
