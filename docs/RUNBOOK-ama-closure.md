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
  to the deploy checkout. Verify the deploy is new enough to contain the full
  AMA closure cutover by checking ancestry in both repos:

  ```bash
  git -C /Users/airlock/agent-os merge-base --is-ancestor \
    e696c58af8fb031ba68a889aff487722dd802b7e HEAD
  git -C /Users/airlock/agent-os/tools/adversarial-review merge-base --is-ancestor \
    0deeb0204a1f8cb594a288b2727ed07ccf2aa696 HEAD
  ```

  The first command proves the deploy checkout includes the agent-os-side
  AMA-08N submodule bump on top of AMA-01..AMA-07 + AMA-06A. The second proves
  the live adversarial-review checkout includes the AMA-06N-side coexistence
  logic, not just an older tree that already happened to have
  `src/ama/dispatch-closer.mjs`.

- **`agent-os-config` CFG schema includes
  `roles.adversarial.merge_authority`** (AMA-01). Verify with the
  doctor:

  ```bash
  agent-os config doctor 2>&1 | grep -i "merge_authority"
  ```

  The schema leaves the master switch `enabled` at `false` by default,
  which is the safe pre-cutover state.

- **Branch protection on the target branch already requires the
  configured adversarial-gate context(s)**. AMA-02's eligibility
  predicate refuses closure if this gate isn't required at branch
  protection (SPEC §6 AC#8). Verify:

  ```bash
  gh api repos/<owner>/<repo>/branches/main/protection \
    | jq '.required_status_checks.contexts, .required_status_checks.checks[]?.context'
  ```

  The expected output names the value returned by
  `resolveGateStatusContext()` (default `agent-os/adversarial-gate`; or
  the `ADV_GATE_STATUS_CONTEXT` env override if set).

---

## 2. Enabling AMA on this host

1. Edit `config.local.yaml`:

   ```yaml
   roles:
     adversarial:
       merge_authority:
         enabled: true
         worker_class: codex     # or claude-code
         merge_method: squash    # or merge — never rebase (SPEC §4.4)
         eligibility:
           risk_classes: [low]   # widen later; start conservative
   ```

2. Bounce the dispatch daemon per the standard procedure:

   ```bash
   hq dispatch drain --timeout 30m
   for attempt in 1 2 3 4 5; do
     if launchctl kickstart -k gui/<uid>/ai.laceyenterprises.cwp-dispatch-daemon.<account>; then
       break
     fi
     if [ "$attempt" -eq 5 ]; then
       echo "dispatch-daemon kickstart failed after 5 attempts" >&2
       exit 1
     fi
     echo "transient launchctl kickstart failure; retrying (${attempt}/5)" >&2
     sleep $((attempt * 2))
   done
   hq dispatch resume --epoch <epoch-from-drain>
   ```

   Treat transient `launchctl` failures (for example launchd still settling
   after a prior bounce) as retryable. Stop after the bounded retry budget and
   inspect `launchctl print` / service logs before trying again.

3. Bounce the adversarial-watcher (placey-owned LaunchAgent):

   ```bash
   for attempt in 1 2 3 4 5; do
     if launchctl kickstart -k gui/<uid>/ai.laceyenterprises.adversarial-watcher; then
       break
     fi
     if [ "$attempt" -eq 5 ]; then
       echo "adversarial-watcher kickstart failed after 5 attempts" >&2
       exit 1
     fi
     echo "transient launchctl kickstart failure; retrying (${attempt}/5)" >&2
     sleep $((attempt * 2))
   done
   ```

   The watcher reads `cfg.roles.adversarial.merge_authority.enabled` on
   every tick via the cached config loader — no in-process state.

---

## 3. Validating cutover

Cut a low-risk test PR (any work that would normally trip the
adversarial-review path, e.g. a docs-only change with `[codex]` title
prefix). Expected sequence:

1. Codex worker opens PR with `[codex]` prefix.
2. Adversarial-watcher posts `claude-reviewer-lacey` review (settled-
   success: `Approved` or clean `Comment only`).
3. **AMA closer (codex) dispatches within 1 watcher tick** instead of
   merge-agent. Verify via `hq dispatch status <lrq>` — `workerClass`
   is `codex`, `task-kind` is `merge`, `completion-shape` is
   `decision-only`, `project` is `adversarial-merge-authority`.
4. The closer's prompt logs the gh CLI invocation:
   `gh pr merge <prUrl> --match-head-commit <sha> --<merge_method>`.
5. PR closes; the commit on `main` carries the §4.4 trailers verifiable
   via:

   ```bash
   git -C /Users/airlock/agent-os log --format=%B -1 <mergeSha> \
     | grep -E '^(Closed-By|Reviewed-By|Risk-Class|Eligibility-Reason|Eligibility-Trace):'
   ```

   Expected output: each of the five trailer lines exactly once.

6. Audit JSON record at
   `$HQ_ROOT/dispatch/audit/adversarial-merge-authority/<repo>-pr-<n>-<headSha>.json`
   has `status: "succeeded"` and `attempts[0].outcome: "succeeded"`.

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
label events are ignored. The author-as-labeler check rejects
self-application except where noted.

| Label | Effect | Author self-application |
|---|---|---|
| `operator-approved` | Bypasses the verdict/remediation/blocking-findings gates for the current head. A `Request changes` review with current-head `operator-approved` can still be AMA-eligible even when remediation is pending, remediation state is unknown, or blocking findings are present/unknown. It does **not** bypass mergeability, CI, branch protection, fast-merge import refusal, or hard-stop labels. | **Rejected.** |
| `adversarial-merge-requested` | AMA-05. Bypasses **only AMA's risk-class gate** for the current head. For `high`, `critical`, and `unknown` risk it must be present simultaneously with current-head `operator-approved` (two-key turn). For `medium`, the label does not bypass the allowlist at all; the risk class must already be configured in `cfg.roles.adversarial.merge_authority.eligibility.risk_classes`. It does not bypass verdict, CI, branch protection, remediation/blocking-finding gates, fast-merge import refusal, or hard-stop labels. | **Rejected.** |
| `adversarial-merge-blocked` | AMA-05. Blocks AMA closure unconditionally regardless of other eligibility. | **Accepted** (author may block their own PR). |
| `merge-agent-requested` | Existing. On AMA-enabled hosts, dispatches merge-agent as the operator-fallback lane WITH the AMA-06A admit-gate bypass (`AMA_OPERATOR_MERGE_AGENT_OVERRIDE=true`). | **Rejected.** |

For the four other hard-stop labels (`merge-agent-skip`, `do-not-merge`,
`no-merge-hold`, `merge-agent-stuck`), see SPEC §4.2 #6. They block AMA
closure regardless of evidence; `merge-agent-stuck` has a documented
scoped-recovery carve-out per §4.2.

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
| `verdict-not-settled-success` | Latest review is `Request changes` (and no current-head `operator-approved`). |
| `risk-class-not-permitted` | PR's risk class is outside `cfg.eligibility.risk_classes` (and no current-head `adversarial-merge-requested`). |
| `ci-not-green` | At least one external CI check is FAILURE / pending. |
| `branch-protection-missing-gate` | Target branch protection doesn't require the configured adversarial-gate context. Re-check §1 prerequisite. |
| `label-adversarial-merge-blocked` | Current-head `adversarial-merge-blocked` is applied (with head-scoped evidence). |
| `stale-review-head` | The reviewed head doesn't match the PR's current head. |
| `pr-not-mergeable` | GitHub's `mergeableState` is not `MERGEABLE` — usually a conflict. |
| `fast-merge-state-unsupported` | The PR is already in a fast-merge override state. AMA refuses closure until that contract is explicitly imported or the override is cleared. |
| `remediation-pending` | Adversarial-review remediation work is owed before AMA can close. |
| `remediation-state-unknown` | The current-head review record did not carry a trustworthy remediation-pending boolean. AMA fails closed unless current-head `operator-approved` is present. |
| `blocking-findings-present` | The latest current-head review still reports one or more structured blocking findings. Current-head `operator-approved` is the only override for this gate. |
| `blocking-findings-unknown` | The review record did not carry a trustworthy structured blocking-finding count. AMA fails closed unless current-head `operator-approved` is present. |

### `lease-held` skip

Another watcher tick already dispatched a closer for this `(repo,
prNumber, headSha)`. **Not an error.** The existing lease file at
`data/ama-closer-leases/<repo>-pr-<n>-<head>.json` carries the original
launch request id; check `hq dispatch status <lrqId>` if you want to
know the closer's live state.

A new head SHA always gets a fresh lease — the file is keyed by
`headSha` so head-change naturally invalidates the old lease.

### Watcher info: "AMA enabled but not eligible … awaiting operator action"

When AMA is enabled, the watcher does NOT silently fall back to
merge-agent on an ineligible PR (SPEC §4.8). The watcher logs the
eligibility reasons and waits. The operator has two options:

1. **Make AMA-eligible** — apply `operator-approved` /
   `adversarial-merge-requested` per §5 only when those labels match the
   specific failing gate:
   - `operator-approved` bypasses verdict/remediation/blocking-finding gates
     for the current head, but not mergeability, CI, branch protection,
     fast-merge import refusal, or hard-stop labels.
   - `adversarial-merge-requested` participates only in AMA's risk-class gate
     and, for `high` / `critical` / `unknown`, still requires simultaneous
     current-head `operator-approved`.
2. **Operator-fallback lane** — apply `merge-agent-requested` (must be
   non-author). The watcher's next tick dispatches merge-agent with
   `AMA_OPERATOR_MERGE_AGENT_OVERRIDE=true`, and AMA-06A's admit gate
   lets it through.

The full SPEC reference: §4.8 coexistence table + §6 AC#9 rollback.
