# RUNBOOK — AMA closure pipeline

Operator runbook for enabling, validating, and rolling back the
Adversarial Merge Authority (AMA) closure pipeline on a host. The full
design is in
[`projects/adversarial-merge-authority/SPEC.md`](https://github.com/laceyenterprises/agent-os/blob/main/projects/adversarial-merge-authority/SPEC.md)
in the agent-os repo; this runbook is the operational companion.

For the agent-os-side operator-facing summary (CLAUDE.md changes,
dispatcher debugging), see
[`docs/SPEC-adversarial-review-auto-remediation.md` §13](https://github.com/laceyenterprises/agent-os/blob/main/docs/SPEC-adversarial-review-auto-remediation.md#13-ama-closer-pipeline).

> **⚠️ FREEZE — v1 merge authority is bug-fix-only.** The v1 merge authority
> described by this runbook (`src/ama/*`, `src/follow-up-merge-agent.mjs`, and
> the daemon clean-merge path) is **frozen**: bug fixes only, no new
> capabilities, pending Merge Authority v2 shadow-mode promotion per
> [`docs/SPEC-merge-authority-v2.md`](SPEC-merge-authority-v2.md). New
> merge-authority capability work belongs in the v2 finalization port
> (Phase 3 of
> [`docs/SPEC-adversarial-review-v2-app-architecture.md`](SPEC-adversarial-review-v2-app-architecture.md)),
> not in v1. See [`src/ama/FREEZE.md`](../src/ama/FREEZE.md) for the freeze
> scope and [`docs/BASELINE-v1-snapshot.md`](BASELINE-v1-snapshot.md) for the
> `v1-working-snapshot` rollback floor.

---

## Table of contents

1. [Prerequisites](#1-prerequisites)
2. [Enabling AMA on this host](#2-enabling-ama-on-this-host)
3. [Validating cutover](#3-validating-cutover)
4. [Rolling back](#4-rolling-back)
5. [Operator label reference](#5-operator-label-reference)
6. [Diagnostic playbook — the §4.4 state-machine outcomes](#6-diagnostic-playbook--the-44-state-machine-outcomes)
7. [Common refusal classes](#7-common-refusal-classes)

---

## 1. Prerequisites

- **AMA-01..AMA-07 + AMA-06A + AMA-06N merged** and main-catchup floated
  to the deploy checkout. Verify the runtime code is live by
  checking that the deploy checkout's
  `tools/adversarial-review/src/ama/dispatch-closer.mjs` exists.

- **`agent-os-config` CFG schema includes
  `roles.adversarial.merge_authority`** (AMA-01). Verify with the
  doctor:

  ```bash
  agent-os config doctor 2>&1 | grep -i "merge_authority"
  ```

  The schema leaves the master switch `enabled` at `false` by default,
  which is the safe pre-cutover state.

- **Branch protection on the target branch already requires the
  configured adversarial-gate context(s), unless the operator explicitly
  configured `branch_protection.required: false` for a repository whose
  GitHub plan has no branch-protection API access.** AMA-02's eligibility
  predicate refuses closure if this gate isn't required at branch
  protection (SPEC §6 AC#8) and the opt-out is not set. Verify against
  the PR's actual target branch, NOT universally `main` — repos that
  merge to a release branch or temporary cutover branch must check the
  protection object on that branch instead:

  ```bash
  # Query the PR's target branch and URL-encode it before interpolating it into
  # the REST path. Slash-containing names like release/2026-06 or
  # cutover/tmp-1 must be encoded or GitHub parses them as multiple segments.
  base=$(gh pr view <pr#> --json baseRefName --jq .baseRefName)
  base_enc=$(printf '%s' "$base" | jq -sRr @uri)
  gh api "repos/<owner>/<repo>/branches/$base_enc/protection" \
    | jq '.required_status_checks.contexts, .required_status_checks.checks[]?.context'
  ```

  The expected output names the value returned by
  `resolveGateStatusContext()` (default `agent-os/adversarial-gate`; or
  the `ADV_GATE_STATUS_CONTEXT` env override if set). If this endpoint
  returns GitHub's known upgrade/forbidden response because the plan does not
  support branch protection, set
  `roles.adversarial.merge_authority.branch_protection.required: false`
  only after confirming every other AMA structural gate remains acceptable
  for that repository. The closer then preserves that unavailable-plan
  evidence (for example `{ "branchProtectionUnavailable": true, "reason":
  "github_plan" }`) and records `branch_protection_requirement_waived`
  instead of `configured_gate_context_required`; malformed or unreadable
  protection input remains a hard closer input error. With the default
  `required: true`, an ordinary empty protection snapshot fails closed as
  `branch-protection-missing-gate`.

---

## 2. Enabling AMA on this host

1. Edit `config.local.yaml`:

   ```yaml
   roles:
     adversarial:
       merge_authority:
         enabled: true
         worker_class: hammer    # default; operators may pin codex, claude-code, or gemini
         # worker_class_fallback: [claude-code]  # HHR harness-fallback (default-on; see §2a)
         merge_method: squash    # or merge — never rebase (SPEC §4.4)
         strict_non_blocking_remediation: true  # default; require known-zero non-blocking findings for direct close
         eligibility:
           risk_classes: [low]   # widen later; start conservative
           high_risk_requires_two_key: true  # default; set false only after allowlisting high/critical intentionally
   ```

   `risk_classes` may include `low`, `medium`, `high`, and `critical`.

   **How a PR's risk class is resolved for eligibility:** candidate risk class →
   review-row `risk_class` → remediation-ledger `latestRiskClass` (which falls
   back to `DEFAULT_RISK_CLASS = medium` when no remediation job recorded a
   class) → `unknown`. This matches the round-budget path. In practice a PR with
   no explicit ticket classification resolves to **`medium`** (the ledger
   default), so it is auto-closeable when `risk_classes` includes `medium`; a PR
   only resolves to `unknown` if the ledger probe is unavailable, in which case
   it stays fail-closed.

   `unknown` / unclassified risk (per the resolution above) is never single-key
   eligible. With the
   default `high_risk_requires_two_key: true`, high/critical still require the
   two-key `adversarial-merge-requested` + `operator-approved` turn. When the
   operator explicitly sets `high_risk_requires_two_key: false`, high/critical
   become AMA single-key eligible only if the concrete class is also present in
   `risk_classes`; final-hammer review-cycle exhaustion does not waive a
   missing high/critical allowlist entry.

### 2a. HHR harness-fallback (codex-capped hammer → available harness)

The default closer `worker_class: hammer` runs on the **codex** (OpenAI OAuth)
harness. When the codex OAuth quota is grounded (LAC-1463: the re-hammer loop
burned the weekly cap), the hammer cannot spawn at all — `hq dispatch
--worker-class hammer` provisions a worker that dies on the cap, so settled PRs
never close even though hammer-merges-under-its-own-lease (MSM-01) is deployed.

`worker_class_fallback` protects this path automatically. At each closer launch
the dispatcher reads the HHR fleet-quota provider-state
(`hq fleet quota status --json`, the same authoritative classifier the
reviewer/remediator quota-hold path uses). If the configured `worker_class`'s
provider is **authoritatively grounded** (`exhausted`/`suspended` — never a
`degraded`/`unknown` guess), it dispatches the closer on the first
`worker_class_fallback` entry whose provider is *not* also grounded, preserving
the closer's terminal-remediation + merge-under-lease behavior (only the
physical `--worker-class` harness changes; the prompt, trailers, and audit
provenance still key off the configured logical class). It emits a loud
`ama_closer.harness_fallback` audit log + operator alert with `provider`,
`from`, and `to`.

- **Auto-revert:** the resolution is stateless and re-runs every tick. The
  moment codex recovers to `ok`, the next close returns to the configured
  primary — no manual flip. This **replaces** the manual
  `roles.adversarial.merge_authority.worker_class: claude-code` config.local.yaml
  hot-patch (which was static and never reverted).
- **Default:** `[claude-code]`, applied by the code-level schema default — the
  protection is **on automatically with no config edit**. The order is honored
  left-to-right; a fallback whose provider is also grounded is skipped.
  Explicitly pinning `worker_class_fallback` in the shared `config.local.yaml`
  (e.g. to reorder or to set `[]` to disable) additionally requires the
  companion `platform/agent-os-config` Python schema key, which is a tracked
  follow-up; until it lands, the shared Python loader would reject an explicit
  `worker_class_fallback` key (fail-loud, never silent). The default protection
  needs neither.
- **Fail-open:** if `hq fleet quota status` is unreadable, or the alert
  transport is down, the closer dispatches on the configured primary exactly as
  before — a resolver/alert fault never blocks the merge.
- **Scope:** this protects the AMA closer/hammer path (the one that stalls PR
  closure fleet-wide). Extending the same harness-fallback to the dag-walker's
  ticket dispatch is a documented follow-up, not built here.

2. Bounce the dispatch daemon per the standard procedure:

   ```bash
   hq dispatch drain --timeout 30m
   DISPATCH_LABEL=gui/<uid>/ai.laceyenterprises.cwp-dispatch-daemon.<account>
   for delay in 0 2 5; do
     [ "$delay" -eq 0 ] || sleep "$delay"
     launchctl kickstart -k "$DISPATCH_LABEL" && break
   done
   launchctl print "$DISPATCH_LABEL" | grep -E 'label =|state = running'
   hq dispatch resume --epoch <epoch-from-drain>
   ```

   Do not resume the queue until the `launchctl print` check shows the
   expected label and `state = running`. If every `kickstart` attempt
   fails or the daemon never returns to `running`, stop here and fix the
   launchd state before resuming traffic.

3. Bounce the adversarial-watcher using the label from the installed plist,
   not a hardcoded legacy owner. This repo still ships the legacy
   `launchd/ai.laceyenterprises.adversarial-watcher.placey.plist`, but the
   current host may be running the airlock-owned variant
   (`ai.laceyenterprises.adversarial-watcher.airlock`) to avoid HQ
   owner-mismatch failures on AMA / merge-agent dispatches.

   ```bash
   WATCHER_PLIST=~/Library/LaunchAgents/ai.laceyenterprises.adversarial-watcher.airlock.plist
   # If that file is absent, inspect ~/Library/LaunchAgents for the deployed
   # watcher plist and point WATCHER_PLIST at the installed variant instead.
   WATCHER_LABEL=$(/usr/libexec/PlistBuddy -c 'Print :Label' "$WATCHER_PLIST")
   WATCHER_TARGET="gui/<uid>/$WATCHER_LABEL"
   for delay in 0 2 5; do
     [ "$delay" -eq 0 ] || sleep "$delay"
     launchctl kickstart -k "$WATCHER_TARGET" && break
   done
   launchctl print "$WATCHER_TARGET" | grep -E 'label =|state = running'
   ```

   The watcher reads `cfg.roles.adversarial.merge_authority.enabled` on
   every tick via the cached config loader — no in-process state. Do not
   proceed until the `launchctl print` check shows the expected label and
   `state = running`; otherwise the old process may still be serving the
   stale config you were trying to replace.

---

## 3. Validating cutover

Cut a low-risk test PR (any work that would normally trip the
adversarial-review path, e.g. a docs-only change with a worker-class
title prefix matching the configured class — `[codex]`, `[claude-code]`,
or `[gemini]`). Expected sequence (substitute `<configured-worker-class>`
with the value of `roles.adversarial.merge_authority.worker_class` from
your CFG; supported values are `codex`, `claude-code`, `hammer`, and
`gemini`, and the reviewer/closer identities follow whatever class you
configured, NOT a hardcoded `codex`):

1. Worker opens PR with `[<configured-worker-class>]` prefix.
2. Adversarial-watcher posts the cross-class reviewer review
   (`claude-reviewer-lacey` for `[codex]` builders,
   `codex-reviewer-lacey` for `[claude-code]` builders — settled-
   success: `Approved` or clean `Comment only` with known-zero blocking
   findings and, in default strict mode, known-zero non-blocking findings).
3. **AMA closer dispatches within 1 watcher tick** instead of
   merge-agent. Verify via `hq dispatch status <lrq>` — `workerClass`
   matches `<configured-worker-class>`, `task-kind` is `merge`,
   `completion-shape` is `decision-only`, `project` is
   `adversarial-merge-authority`.
   For a Gemini cutover, the validation is specifically
   `hq dispatch --worker-class gemini --task-kind merge --completion-shape decision-only ...`,
   and the closer provenance trailer below must read
   `Closed-By: gemini-closer (adversarial-pipe-mode)`.
   Also verify the closer workspace repo set. For a PR whose repo basename is
   not `agent-os`, `workspaceRepos` must include both the PR repo basename and
   `agent-os` because the closer runs Agent OS AMA tooling and writes the audit
   under `$HQ_ROOT`. For an `agent-os` PR, `workspaceRepos` must contain
   `agent-os` only once; the closer must not duplicate the primary repo via an
   additional workspace entry.
   When a closer attempt reaches a retryable or terminal state, the watcher
   polls the session ledger for token usage once using the configured bounded
   rollup delays. If no `worker_run` token row appears by then, the watcher
   records the `reviewer_passes` closer row with empty token fields and
   `metadata_json.tokenUsageUnavailable=true`, then advances to retry or
   completion handling. `waiting-for-tokens` is therefore only a transient
   within the local poll window, not a durable operator state.
4. The closer's prompt logs the gh CLI invocation:
   `gh pr merge <prUrl> --match-head-commit <sha> --<merge_method>`.
5. PR closes; the commit on the target branch carries the §4.4 trailers
   verifiable via the deploy checkout (substitute
   `$AGENT_OS_DEPLOY_CHECKOUT` if your host is non-default; the
   `/Users/airlock/agent-os` literal is just the on-host default):

   ```bash
   git -C "${AGENT_OS_DEPLOY_CHECKOUT:-/Users/airlock/agent-os}" log --format=%B -1 <mergeSha> \
     | awk -F: '
         /^(Closed-By|Reviewed-By|Risk-Class|Eligibility-Reason|Eligibility-Trace):/ {
           counts[$1]++
         }
         END {
           required["Closed-By"]=1
           required["Reviewed-By"]=1
           required["Risk-Class"]=1
           required["Eligibility-Reason"]=1
           required["Eligibility-Trace"]=1
           for (key in required) {
             if (counts[key] != 1) {
               printf "%s count=%d\n", key, counts[key]
               bad=1
             }
           }
           exit bad
         }
       '
   ```

   Expected output: nothing. Any printed `count=` line means a required
   trailer is missing or duplicated.

6. Audit JSON record at
   `$HQ_ROOT/dispatch/audit/adversarial-merge-authority/<repo>-pr-<n>-<headSha>.json`
   has terminal `status: "succeeded"`, and the latest attempt shows a
   successful merge outcome even if earlier attempts deferred or retried:

   ```bash
   jq '
     .status == "succeeded"
     and ((.attempts // []) | length > 0)
     and ((.attempts[-1].outcome // "") == "succeeded")
   ' \
     "$HQ_ROOT/dispatch/audit/adversarial-merge-authority/<repo>-pr-<n>-<headSha>.json"
   ```

   Expected output: `true`.

7. The session ledger has the merged completion signal:

   ```bash
   # Use the host's normal ledger inspection surface. The row must match
   # repo, pr_number, and signal_kind='merged'.
   ```

   The watcher treats this row as the authoritative "closer is done" signal.
   The row's `head_sha` is producer evidence, not necessarily the PR head:
   Agent OS currently records the merge commit SHA for merged completions.
   `hq dispatch status=succeeded` and the AMA audit JSON's
   `status: "succeeded"` are observations, not sufficient completion proof on
   their own. If those terminal observations exist but the merged row is
   cleanly absent, the watcher first requires repo-level merged producer
   evidence. With that evidence, it records `unverified-terminal-success`,
   releases the stale terminal hold, and can re-dispatch the closer within its
   retry bound. If the ledger read itself is unknown — missing target/table, no
   repo-level merged producer evidence, SQLite lock, psql/TLS failure, or
   another read error — the watcher retains the existing hold for that tick and
   waits for a healthy read instead of launching another closer.

If any step fails, drop into §6 (diagnostic playbook).

---

## 4. Rolling back

The cutover is fully reversible per SPEC §6 AC#9.

1. Edit `config.local.yaml`:

   ```yaml
   roles:
     adversarial:
       merge_authority:
         enabled: false
   ```

   To disable only HAM terminal-remediation while keeping the daemon clean-merge
   path available for fully clean PRs, set
   `roles.adversarial.merge_authority.hammer_lifetime_ceiling: 0`. The watcher
   then skips hammer dispatch without entering the lifetime-exhaustion alert
   path, and daemon clean merges continue to use their independent retry budget.

2. Bounce the dispatch daemon + watcher (same commands as §2 steps 2-3).

   Apply the same bounded `kickstart` retry and `launchctl print ... state = running`
   verification before `hq dispatch resume`. A rollback is not complete
   until both services are confirmed healthy on the new config.

3. The next settled-success closure routes back to the merge-agent
   path (SPEC §4.8).

4. **No state cleanup required.** Existing AMA lease files
   (`data/ama-closer-leases/<repo>-pr-<n>-<head>.json`), audit JSONs
   (`$HQ_ROOT/dispatch/audit/adversarial-merge-authority/`), and the
   `data/follow-up-jobs/ama-closer-dispatches/` records all persist as
   audit trail. They do not affect post-rollback behavior.

---

## 5. Operator label reference

All labels are **head-scoped + attributable**. Stale (older-head)
label events are ignored. Single-operator hosts intentionally allow the
same login to supply current-head evidence for the scoped recovery paths
called out below; do not wait for a second human when the live contract
already accepts same-login evidence.

| Label | Effect | Author self-application |
|---|---|---|
| `operator-approved` | Bypasses the verdict gate. A `Request changes` review with current-head `operator-approved` becomes eligible. The structural hard gates (CI, branch protection, no remediation pending, no hard-stop labels, mergeability) still apply. On single-operator hosts, same-login current-head evidence is accepted when the event is attributable and fresh. | **Accepted** at single-operator scale when the evidence is current-head, attributable, and fresh. |
| `adversarial-merge-requested` | AMA-05. Bypasses the **risk-class gate only**. Required for unknown risk, and for high/critical unless `high_risk_requires_two_key=false` plus matching `risk_classes` membership makes that class single-key eligible. Does not bypass verdict, CI, branch protection, or hard-stop labels. | **Rejected.** |
| `adversarial-merge-blocked` | AMA-05. Blocks AMA closure unconditionally regardless of other eligibility. | **Accepted** (author may block their own PR). |
| `merge-agent-requested` | Existing. On AMA-enabled hosts, dispatches merge-agent as the current-head operator-fallback lane WITH the AMA-06A admit-gate bypass (`AMA_OPERATOR_MERGE_AGENT_OVERRIDE=true`). It also serves as the documented `merge-agent-stuck` recovery signal when the current-head evidence is attributable and the label is still present. The live contract is single-operator: the scoped current-head label is the authority, not a distinct non-author actor check. | **Accepted** when the evidence is current-head, attributable, and fresh, including same-login evidence on single-operator hosts. |

For the four other hard-stop labels (`merge-agent-skip`, `do-not-merge`,
`no-merge-hold`, `merge-agent-stuck`), see SPEC §4.2 #6. They block AMA
closure regardless of evidence except for the documented
`merge-agent-stuck` carve-out above, which requires current-head
`merge-agent-requested` evidence and does not accept `operator-approved`
as a substitute recovery signal.

---

## 6. Diagnostic playbook — the §4.4 state-machine outcomes

Every AMA close attempt produces an audit JSON entry at
`$HQ_ROOT/dispatch/audit/adversarial-merge-authority/<repo>-pr-<n>-<head>.json`.
The surface `status` is one of five values (SPEC §4.4):

| State | Meaning | Operator action |
|---|---|---|
| `in_progress` | Watcher created the authorizing record; closer is pending or running. Or `reconciliation.needsRepair=true` means the closer couldn't finalize the record. | None for short-lived `in_progress`. If `needsRepair=true`, the next watcher tick or audit-repair pass reconciles from fresh GitHub state without re-merging. |
| `deferred` | Closer's fresh predicate failed at re-run (e.g. head changed mid-flight, new comment added a blocker). Retryable on next watcher tick. | Inspect the latest `attempts[].reasons` (or `preMergeReasons`). Often self-resolves on the next head. |
| `superseded` | A newer head appeared while AMA was working. The old `(pr, headSha)` record is closed; a new lease/audit appears at the new head. | None. The new head's lease/audit is the live state. |
| `succeeded` | Fresh post-CLI GitHub state proves the authorized head merged. **TERMINAL — STICKY.** The writer refuses to demote this to anything else. | None. Verify the trailers via `git show`. |
| `failed-without-merge` | A merge attempt was made, GitHub still shows the PR open/unmerged after post-CLI reconciliation, and the failure is not a normal defer/supersede. | Inspect `attempts[].cliExitCode` and the closer worker's stderr via `hq dispatch logs <lrq>`. Common cause: branch protection mismatch — re-check §1 prerequisite. |

HAM-03 stale-head / behind recovery stores its bounded rebase counter in this
same audit history. The closer initializes the live `Rebase-Attempts` value
from the maximum prior `attempts[].rebaseAttempts` for the PR/head instead of
starting from zero on each dispatch, so a watcher retry cannot silently reset
the cap. `gh pr update-branch --rebase` is retried only for clearly transient
transport/service failures; stderr that looks like a rebase conflict is the
only path classified as `unresolvable-rebase-conflict`.

The watcher-side convergence state `unverified-terminal-success` is not a
closer audit status. It means the existing dispatch/audit surfaces reached a
terminal-success observation, the repo has merged producer evidence, but this
PR's merged `build_completions` signal was cleanly absent. Operators should
expect bounded re-dispatch attempts up to `AMA_CLOSER_REDISPATCH_BOUND` while
the asynchronous merge-signal producer catches up; repeated attempts inside
that bound are producer-lag noise, not evidence of a second merge attempt. A
ledger read failure or missing repo-level producer evidence does not create this
state; it preserves the existing dispatch hold and should be diagnosed as
ledger availability/producer rollout.

### Hammer closing discipline (2026-06-19)

The hammer terminal-remediation prompt (`templates/hammer-prompt.md`) enforces
four operator-mandated rules before and after an autonomous close. They are
prompt-driven worker behavior, not predicate gates — the audit comment and the
`Closed-By` trailer remain the evidence:

1. **Required checks plus changed-surface tests are the merge bar.** The hammer
   runs the tests that cover the files this PR touches, confirms the PR's
   required GitHub checks are green on the post-remediation head, and fixes every
   failing regression it can. Failures that are proven red on `origin/main` before
   this branch's changes, or that are purely worker-sandbox limitations such as a
   missing host dependency or blocked process introspection, must be hardened or
   triaged and documented in the closing comment rather than blocking an
   otherwise clean close. Test fixes remain the one sanctioned exception to
   "scope only to the findings"; net-new feature scope stays out.
2. **Rebase onto latest `main` and confirm it holds.** The hammer always rebases
   the branch to the current base (not merely on `BEHIND`) and re-validates the
   rebased head — required checks plus the changed-surface test bar above —
   before merging.
3. **Keep canonical docs current.** Doc-currency is part of the terminal
   remediation scope, not net-new feature work. When the diff changes an
   in-repo persistent store shape and `docs/data-model/` exists, the hammer
   updates the matching `docs/data-model/NN-*.md` file and
   `docs/data-model/catalog.json`, then runs
   `node scripts/validate-data-model-catalog.mjs`; a red validator is a red
   check. When the diff changes a module surface or operational contract and
   `modules/<name>/<name>-walkthrough.md` exists, the hammer updates that
   walkthrough. If the PR repository lacks those docs because they belong to a
   superproject or submodule boundary, the hammer leaves the repo-local surface
   alone and notes the skipped superproject-doc obligation in its audit comment.
4. **Post a closing comment.** On a confirmed merge the hammer posts a
   `✅ Closed by Hammer` comment with the merged SHA, merge method, remediated
   finding counts, the failing tests it fixed, doc-currency work or skipped
   superproject-doc obligations, and the rebase-attempt count. The terminal
   remediation audit-comment path resolves the post-remediation PR head and
   checks for an existing same-head audit comment with bounded transient retries;
   unresolved lookup failures fail closed instead of posting duplicate audit
   evidence.
5. **Bounded gate-read and already-merged recovery.** HAM treats transient
   GitHub gate-read failures like other merge-time network failures: a failed
   read inside the remote-CI polling window logs a warning, sleeps for the
   configured poll interval, and retries until either the overall remote-CI
   deadline expires or the consecutive read-failure threshold is reached. If the
   PR is already `MERGED` at the validated HAM head during preflight, or a merge
   retry receives an `already merged` response after a dropped/ambiguous merge
   request, HAM skips another merge attempt and proceeds to the same post-merge
   confirmation path that records the merge commit and releases the lease. That
   post-merge path emits the session-ledger merge signal before marking the AMA
   closer lease terminal `succeeded`, so a signal failure leaves the lease
   retryable instead of stranding a completed lease without durable merge
   evidence.
6. **Merge-agent identity.** The hammer commits/comments/merges under the
   merge-agent app identity (see the worker-pool hammer identity + token wiring),
   so the close is attributable to the merge-agent bot, not a generic worker.

To find recent audit records for a PR:

```bash
ls -lt $HQ_ROOT/dispatch/audit/adversarial-merge-authority/ \
  | head -10
jq '{status, attempts: (.attempts | map({attemptNumber, outcome, cliExitCode}))}' \
  $HQ_ROOT/dispatch/audit/adversarial-merge-authority/<repo>-pr-<n>-<head>.json
```

---

## 7. Common refusal classes

### `merge-agent-skipped-ama-enabled`

Agent-os dispatcher refusal (AMA-06A). Fires when AMA is enabled and a
merge-agent dispatch did NOT carry the operator-fallback env. See
[`modules/worker-pool/RUNBOOK-debugging.md`](https://github.com/laceyenterprises/agent-os/blob/main/modules/worker-pool/RUNBOOK-debugging.md#common-debugging-scenarios)
for the diagnostic command + recovery playbook.

Expected when AMA is enabled and the dispatch isn't from a current-head
`merge-agent-requested` label.

### `not-eligible` reasons in the closer prompt audit

Each entry in the audit's `attempts[].preMergeReasons` (or
`attempts[0].reasons`) is one failing gate from SPEC §4.2. Common
reasons:

| Reason | Meaning |
|---|---|
| `verdict-not-settled-success` | The settled review is not eligible for direct close (and no current-head `operator-approved`). This fires when the latest review is `Request changes` **OR** — when `roles.adversarial.merge_authority.strict_non_blocking_remediation` is on (default) — when a `Comment only`/`Approved` review still carries standing or unknown-state non-blocking findings. In the strict-mode case it is emitted alongside `non-blocking-findings-present` (see that row); a `Comment only` PR refused with *both* reasons was NOT downgraded to `Request changes`. |
| `non-blocking-findings-present` | Strict mode (`strict_non_blocking_remediation`, default on): the settled review has standing non-blocking findings that have not been remediated, so the PR is not eligible for *direct* close. It still closes via HAM terminal remediation (the hammer addresses the non-blocking findings) or a current-head `operator-approved`. A `known` count of `>0` triggers this; an `unknown` non-blocking state also fails closed in strict mode. HAM may waive this reason on authorized active HAM evidence only in the strict-non-blocking lane described below. |
| `blocking-findings-unknown` | Latest review does not expose a known structured blocking-finding count. |
| `blocking-findings-present` | Latest review has standing structured blocking findings. |
| `non-blocking-findings-unknown` | Strict non-blocking remediation is enabled and the settled review does not expose a known structured non-blocking-finding count. |
| `non-blocking-findings-present` | Strict non-blocking remediation is enabled and the settled review has standing structured non-blocking findings. |
| `risk-class-not-permitted` | PR's risk class is outside `cfg.eligibility.risk_classes` (and no current-head `adversarial-merge-requested`), or high/critical/unknown still require the two-key path. |
| `ci-not-green` | At least one external CI check is FAILURE / pending. |
| `branch-protection-missing-gate` | Target branch protection doesn't require the configured adversarial-gate context. Re-check §1 prerequisite. |
| `branch_protection_requirement_waived` | Audit/provenance reason for the explicit `branch_protection.required=false` opt-out on a no-branch-protection GitHub plan. This is not a refusal reason. |
| `label-adversarial-merge-blocked` | Current-head `adversarial-merge-blocked` is applied (with head-scoped evidence). |
| `stale-review-head` | The reviewed head doesn't match the PR's current head. |
| `pr-not-mergeable` | GitHub's `mergeableState` is not `MERGEABLE` — usually a conflict. |
| `remediation-pending` | Adversarial-review remediation work is owed before AMA can close. |

### Strict non-blocking remediation — throughput note

`roles.adversarial.merge_authority.strict_non_blocking_remediation` is **on by
default**. Because adversarial reviewers almost always emit at least one
non-blocking polish suggestion, this means the common `Comment only` /
`Approved`-with-polish PR is **not eligible for direct AMA close** — it surfaces
`non-blocking-findings-present` (+ `verdict-not-settled-success`) and closes via
one of:

1. **HAM terminal remediation** (preferred) — the hammer worker addresses the
   non-blocking findings on the PR branch. For a settled-success-family verdict
   where the only remaining HAM-waived reasons are
   `non-blocking-findings-present` or `non-blocking-findings-unknown` plus the
   accompanying `verdict-not-settled-success`, the closer may waive those reasons
   on an active HAM session only after the predicate verifies current-head HAM
   authority from trusted inputs: HAM worker trailers, reviewed-parent/current-head
   match, non-empty verified diff, allowlisted audit-comment author, matching
   audit-comment body, and doc-currency evidence. This active trust is
   intentionally narrower than strict `.ok`: it does not require the finding-count
   trailer to match the current non-blocking set, but a bare
   `verdict-not-settled-success`, `Request changes`, blocking findings, stale
   review heads, and unknown/pending remediation state still require strict `.ok`
   validation or a current-head operator override.
2. **Current-head `operator-approved`** — the operator accepts the standing
   non-blocking findings as-is.

This is deliberate (the operator directive is "remediate non-blocking findings
before close, not just blocking"). The cost is lower *direct*-close throughput
and a hard dependency on the HAM remediation path being healthy. Operators who
want the prior behavior (direct-close on `Comment only` regardless of
non-blocking findings) can set `strict_non_blocking_remediation: false` in
`config.local.yaml`; the gate then reverts to blocking-only.

### `lease-held` skip

Another watcher tick already dispatched a closer for this `(repo,
prNumber, headSha)`. **Not an error.** The existing lease file at
`data/ama-closer-leases/<repo>-pr-<n>-<head>.json` carries the original
launch request id after `hq dispatch` returns. While the owning watcher is
still inside the `hq dispatch` launch window, the lease can remain
`status: "pending"` with no `lrqId`; this is still live duplicate-dispatch
protection and must not be hand-deleted. Once `lrqId` is present, check
`hq dispatch status <lrqId>` if you want to know the closer's live state.

A new head SHA always gets a fresh lease — the file is keyed by
`headSha` so head-change naturally invalidates the old lease.

### Merge gate lease visibility

The base-branch merge gate uses `data/merge-leases/<repo>__<base>.json` plus
durable waiter and attempt files. Use
`node bin/merge-lease.mjs status --repo <owner/name> --base <branch>` to inspect
the current holder, FIFO waiters, ages, and per-PR attempt counts. If the holder
PR has already merged/closed, or the holder process is dead/stale, run
`node bin/merge-lease.mjs reconcile --repo <owner/name> --base <branch>`; this
only removes the lease file through the holder identity fence and does not kill
processes or change verdicts. Releasing a holder also removes that PR/head's
gate-attempt record, and attempt records older than 30 days are pruned during
new attempt recording. When a PR exceeds `AMG_MAX_GATE_ATTEMPTS`
(default `5`), `acquire` exits `70` with `{"parked":true}` so the caller should
park it for operator review instead of re-queueing. The hammer terminal closer
also treats an acquire wait timeout (`75` with `{"timedOut":true}`) as an
intentional AMG-04 park and exits successfully after logging the waited seconds,
so a contended base does not churn through repeated long retry windows. Other
non-zero acquire exits remain hard failures that should be inspected from the
CLI JSON payload.

### Merged PR but DAG step did not advance

When AMA or merge-agent merges a PR through `gh pr merge`, the watcher records
owed `hq dag autowalk-on-merge --repo <repo> --pr <n>` work as part of the
merge lifecycle sync. The durable record is
`data/follow-up-jobs/dag-autowalk-on-merge/<repo>-pr-<n>.json`; it is removed
only after the hq command exits successfully. If a merged PR's DAG run remains
stuck, check that file first:

```bash
jq '{status, attempts, lastAttemptAt, lastError}' \
  data/follow-up-jobs/dag-autowalk-on-merge/<repo>-pr-<n>.json
```

`status: "pending"` means the watcher will retry after
`ADVERSARIAL_DAG_AUTOWALK_ON_MERGE_RETRY_MS` (default 5 minutes).
`status: "failed"` means the bounded automatic attempts
(`ADVERSARIAL_DAG_AUTOWALK_ON_MERGE_MAX_ATTEMPTS`, default 5) are exhausted;
repair the recorded root cause (`HQ_BIN`, owner/env, SQLite lock, hq timeout,
or stderr from the subcommand), then re-run the hq command manually or reset the
record for another watcher retry. The command remains self-gated by
`HQ_AUTO_DAG_WALK` and cleanly no-ops for non-DAG PRs.

### Watcher info: "AMA enabled but not eligible … awaiting operator action"

When AMA is enabled, the watcher does NOT silently fall back to
merge-agent on an ineligible PR (SPEC §4.8). The watcher logs the
eligibility reasons and waits. The operator has two options:

The parenthesized `namedReason` in this log is a stable single-token summary
for scraping (`not-eligible:<first-reason>` for eligibility misses, otherwise
the no-dispatch `reason`). The separate `reasons:` field remains the fuller
diagnostic list.

1. **Make AMA-eligible** — apply `operator-approved` /
   `adversarial-merge-requested` per §5 to override the failing gates.
2. **Operator-fallback lane** — apply a fresh current-head
   `merge-agent-requested`. On single-operator hosts this may be the
   same login as the PR author; the scoped label event is the control
   signal the live gate enforces. The watcher's next tick dispatches
   merge-agent with `AMA_OPERATOR_MERGE_AGENT_OVERRIDE=true`, and
   AMA-06A's admit gate lets it through.

The full SPEC reference: §4.8 coexistence table + §6 AC#9 rollback.
