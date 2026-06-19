# RUNBOOK — AMA closure pipeline

Operator runbook for enabling, validating, and rolling back the
Adversarial Merge Authority (AMA) closure pipeline on a host. The full
design is in
[`projects/adversarial-merge-authority/SPEC.md`](https://github.com/laceyenterprises/agent-os/blob/main/projects/adversarial-merge-authority/SPEC.md)
in the agent-os repo; this runbook is the operational companion.

For the agent-os-side operator-facing summary (CLAUDE.md changes,
dispatcher debugging), see
[`docs/SPEC-adversarial-review-auto-remediation.md` §13](https://github.com/laceyenterprises/agent-os/blob/main/docs/SPEC-adversarial-review-auto-remediation.md#13-ama-closer-pipeline).

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
| `non-blocking-findings-present` | Strict mode (`strict_non_blocking_remediation`, default on): the settled review has standing non-blocking findings that have not been remediated, so the PR is not eligible for *direct* close. It still closes via HAM terminal remediation (the hammer addresses the non-blocking findings) or a current-head `operator-approved`. A `known` count of `>0` triggers this; an `unknown` non-blocking state also fails closed in strict mode. |
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
   non-blocking findings on the PR branch and the closer waives the gate against
   the validated remediation evidence. This is the intended steady-state path and
   makes the codex HAM worker load-bearing for most closes.
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

1. **Make AMA-eligible** — apply `operator-approved` /
   `adversarial-merge-requested` per §5 to override the failing gates.
2. **Operator-fallback lane** — apply a fresh current-head
   `merge-agent-requested`. On single-operator hosts this may be the
   same login as the PR author; the scoped label event is the control
   signal the live gate enforces. The watcher's next tick dispatches
   merge-agent with `AMA_OPERATOR_MERGE_AGENT_OVERRIDE=true`, and
   AMA-06A's admit gate lets it through.

The full SPEC reference: §4.8 coexistence table + §6 AC#9 rollback.
