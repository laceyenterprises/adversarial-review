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

## Merge-message protection and remaining scope

Daemon clean merge, the closer's inline terminal-remediation merge, fast-merge,
and the hammer shell supply explicit `--subject` and `--body` from the shared
`buildMergeCommitBody` helper. The subject is the sanitized PR title plus
`(#<PR number>)`; an empty or unavailable title defers the merge rather than
writing a placeholder. The live merge-agent candidate fetch requests and
returns `title`; the daemon prefers a non-empty live title, then the candidate
title. The body contains the sanitized author PR body plus closure trailers.
Closing keywords (including colon-without-space and underscore-prefixed forms) followed by
`#N`, `owner/repo#N`, or `http(s)://github.com/<owner>/<repo>/(issues|pull)/N`
also cover schemeless and `www.github.com` URL forms and
are separated from the reference by `PR`; `GH-N` is covered conservatively too.
Only a reference to this PR in this repository is exempt. Combined title/body
rewrites are recorded in `closingKeywordRewrites` (see the
[AMA audit](data-model/ama-audit.md) and
[fast-merge audit](data-model/fast-merge-audits.md) contracts).

Hammer provenance comes from dispatch's canonical `composeAmaTrailers` output,
exported as `HAM_AMA_TRAILERS`. The helper refuses a missing block;
transient title-read exhaustion, missing titles, unexpected sanitization and decode
failures write a terminal audit and mark the lease attempt as a retryable abort
before releasing it. A permanent title-read error writes the audit, releases
the lease and returns hard-block code 20, matching the body-read contract.
Sanitizer exits 64 (invalid arguments) and 78 (missing canonical trailers) also
write a terminal audit, release the lease and return 20 without retryable abort.
Each merge phase clears rewrite evidence before any refusal.

Activation checklist:

1. Pause hammer dispatch and drain hammers dispatched with the older prompt before
deploying merge-message protection. Those prompts lack `HAM_AMA_TRAILERS` and
cannot recover by retrying the same merge procedure. Re-dispatch them with the
current prompt after the drain; otherwise sanitization refusal spends lease
attempts and retry-cap budget.
2. Allow normal main-catchup float and restart the daemons through the documented path.
3. Resume dispatch and re-dispatch drained hammers with the current prompt.

Trailer contract: plain daemon and fast-merge commits carry only a `Closed-By`
marker (`daemon-merge` or `fast-merge`). They do not attest the full SPEC §4.4
Reviewed-By / Risk-Class / Eligibility-Reason / Eligibility-Trace block.
Closer-dispatched daemon merges and hammer merges retain canonical dispatch
trailers; use the structured audits for plain-daemon/fast-merge provenance.

Remaining scope: the operator-fallback merge-agent prompt and v2 finalization
adapter still use default GitHub messages. Follow-up work must add explicit
subject/body support to their adapter contract and route both through the
shared sanitizer. For `merge_method: merge`, the generated merge commit also
uses the explicit sanitized `<PR title> (#N)` subject and full PR body plus
closure trailers, replacing GitHub's default `Merge pull request #N from
owner/branch` subject. Consumers parsing that default must accept the explicit
subject before activation. Repositories configured with `merge_method: merge`
retain
individual PR commits unchanged; closing keywords in those commit messages can
still close work when they land. This protection covers the generated merge
message only. PR-description linking performed directly by GitHub is also
outside this commit-message protection.

## 1. Prerequisites

Merge execution evidence (OPSEV1-03) is appended under
`$HQ_ROOT/dispatch/audit/automation-merge-actions/` by the daemon, fast-merge
paths and hammer. Fast-merge owns its receipt and currently executes through
exact-head `gh --admin`: the deployed adapter cannot forward explicit commit
messages, so the adapter seam declines sanitized-message calls. Adding explicit
subject/body support to that adapter contract remains follow-up work; until then
fast-merge's write identity and execution receipt come from the gh path. Each
explicit-message adapter decline logs a warning; close audits record
`mergeWritePath: gh-admin-explicit-message` for the attempted write (including
a refusal or a race with a manual merge), plus `mergeActor` from the ambient
`gh api user` identity read (`null` if unavailable, with a warning). This is the
attempting credential actor, not an attestation of a racing manual merge actor. Follow-up recorded 2026-10-05: add
adapter subject/body support before returning fast-merge to service auth.
Retryable or unclassified fast-merge refusals remain closure-audit evidence only. Refusal receipts
require an explicit permanent rejection or eligibility/policy decision under a
held lease; read failures, transient exhaustion, superseded/deferred outcomes
and accepted-but-unconfirmed merges remain closure-audit evidence only.
Success receipts require live confirmation of the
producer's exact PR head; an already-merged response does not represent another
execution. The hammer CLI and adapter confirmation retry transient `gh pr view`
failures up to three times with 500/1000ms backoff and a 15-second timeout per
attempt. After exhaustion, the adapter warns and retains its merge result; the
CLI exits non-zero. Receipt publication failures do not grant or revoke merge
authority. For schema, ownership, append-only publication and isolated-worker
handoff, see [Automation Merge Actions](data-model/automation-merge-actions.md).

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

  The hammer's protection fetch writes one of two files when the endpoint
  refuses (HAMBG-02). GitHub's free-plan answer for a private repository,
  `Upgrade to GitHub Pro or make this repository public to enable this
  feature. (HTTP 403)`, becomes the `github_plan` sentinel. `Branch not
  protected (HTTP 404)` becomes `{ "status": "404", "message": "Branch not
  protected" }`, which ama-check reads as `branch-protection-missing`. With
  `required: false` both inputs are waived. With `required: true` the sentinel
  is a hard input error and the 404 fails closed as
  `branch-protection-missing-gate`. Any other fetch error stops the hammer.

  The repo-wide closeout/audit helper is:

  ```bash
  npm run check-branch-protection -- --json
  npm run check-branch-protection -- --json --apply
  ```

  `--json` writes one audit record per unresolved repo under
  `data/branch-protection-audits/` and exits `1` until every watched repo is
  either protected or explicitly waived by policy. `--apply` performs only the
  safe in-place repair: add the resolved adversarial gate context to an already
  readable branch-protection object. It does not invent a full branch-protection
  policy for 404/missing repos and it does not waive 403/forbidden repos.

  For a `branch-protection-forbidden` audit record, use a repo-admin credential
  and run the exact add-context mutation manually:

  ```bash
  base=$(gh api "repos/<owner>/<repo>" --jq .default_branch)
  base_enc=$(printf '%s' "$base" | jq -sRr @uri)
  gh api -X POST "repos/<owner>/<repo>/branches/$base_enc/protection/required_status_checks/contexts" \
    -f "contexts[]=agent-os/adversarial-gate"
  ```

  For a `branch-protection-missing` audit record, bootstrap the minimum branch
  protection explicitly, then rerun the audit:

  ```bash
  base=$(gh api "repos/<owner>/<repo>" --jq .default_branch)
  base_enc=$(printf '%s' "$base" | jq -sRr @uri)
  gh api -X PUT "repos/<owner>/<repo>/branches/$base_enc/protection" --input - <<'JSON'
  {"required_status_checks":{"strict":true,"contexts":["agent-os/adversarial-gate"]},"enforce_admins":false,"required_pull_request_reviews":null,"restrictions":null}
  JSON
  ```

---

## 2. Enabling AMA on this host

1. Edit `config.local.yaml`:

   ```yaml
   roles:
     adversarial:
       merge_authority:
         enabled: true
         worker_class: hammer    # default; operators may pin codex, claude-code, hammer-claude, or gemini
         # worker_class_fallback: [hammer-claude]  # HHR harness-fallback (default-on; see §2a)
         # AMA hammer dispatch stays inline by default. To keep the serial
         # posted-review phase from waiting on slow `hq dispatch` calls, set
         # watcher.ama_hammer_dispatch_mode / AGENT_OS_WATCHER_AMA_HAMMER_DISPATCH_MODE
         # to background; see §2b before enabling.
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
- **Default:** `[hammer-claude]`, applied by the code-level schema default — the
  protection is **on automatically with no config edit**. The order is honored
  left-to-right; a fallback whose provider is also grounded is skipped.
  Explicitly pinning `worker_class_fallback` in the shared `config.local.yaml`
  (e.g. to reorder or to set `[]` to disable) additionally requires the
  companion `platform/agent-os-config` Python schema key, which is a tracked
  follow-up; until it lands, the shared Python loader would reject an explicit
  `worker_class_fallback` key (fail-loud, never silent). The default protection
  needs neither.
- **Domain declaration:** every `domains/*.json` `mergeAuthority` block
  declares `workerClassFallback: ["hammer-claude"]` (`code-pr`,
  `code-pr-security`, `research-finding`). `resolveMergeAuthorityConfigFromDomain`
  (`src/domain-policy.mjs`) lets the domain value replace the loader default
  unless the operator set `roles.adversarial.merge_authority.worker_class_fallback`
  through `local:`, `env:`, or `cli`, so a domain value is effectively the
  fleet default. A coding-only class such as `claude-code` cannot accept the
  `merge` task kind and must never appear there; `test/domain-policy.test.mjs`
  asserts every domain fallback is a hammer class. Explicit operator overrides
  still take precedence. This is a role declaration, not a temporary
  provider-outage pin.
- **Fail-open:** if `hq fleet quota status` is unreadable, or the alert
  transport is down, the closer dispatches on the configured primary exactly as
  before — a resolver/alert fault never blocks the merge.
- **Alert debounce ownership:** fallback operator alerts are debounced by
  fleet-wide condition under `data/ama-harness-fallback-alerts/`. Native writes
  are allowed only when the caller UID matches the canonical owner of the
  existing alert directory, the shared `data/` directory, or the repo root before
  either exists. Cross-user callers must write through `sudo -A -H -u <owner>` so
  a restricted hammer worker cannot first-create shared debounce state and lock
  out the daemon. The directory is maintained as setgid group-writable (`02775`)
  and records as group-writable (`0664`); failures still fail open and only
  affect debounce suppression, not closer dispatch.
- **Scope:** this protects the AMA closer/hammer path (the one that stalls PR
  closure fleet-wide). Extending the same harness-fallback to the dag-walker's
  ticket dispatch is a documented follow-up, not built here.
- **Merge-agent fallback (CLOSERREUSE-01):** the merge-agent resolves
  `roles.merge_agent_worker_class` through the same resolver and the same
  `worker_class_fallback` list (`src/merge-agent-harness.mjs`), so the watcher's
  AMA recovery fallback dispatches `hammer` as `hammer-claude` while
  openai/oauth is grounded. Unlike the closer, it never dispatches a grounded
  class: fallback candidates are screened on soft as well as hard grounding
  (`screenSoftGroundedFallbacks`), and with no ungrounded fallback it returns
  `dispatch-deferred` with reason `merge-agent-harness-grounded`, and the next
  tick resolves again. Each deferral is recorded per (PR, head) under
  `data/follow-up-jobs/merge-agent-harness-deferrals/` (first seen, count), and
  one that outlives 30 minutes logs `merge_agent.harness_grounded_deferral` at
  warn level once. A dispatch clears the record. An unreadable quota status
  still keeps the configured class.

### 2b. HAMASYNC-01 background hammer dispatch

This is a v1 bug-fix/operational mitigation under the freeze above, not a new
merge authority lane. The MSM decision tree is unchanged: a PR that needs the
hammer still goes through `maybeDispatchAmaCloser`, the same closer lease,
dispatch record, retry cap, prompt, and merge-under-lease contract. Only the
posted-review watcher phase's wait behavior changes.

The control is `watcher.ama_hammer_dispatch_mode`, with env override
`AGENT_OS_WATCHER_AMA_HAMMER_DISPATCH_MODE` and legacy alias
`ADVERSARIAL_AMA_HAMMER_DISPATCH_MODE`:

| Mode | Contract |
|---|---|
| `inline` (default) | The posted-review phase awaits the hammer `hq dispatch` attempt before moving to the next row. This is the historical behavior and the fail-safe fallback for missing, unreadable, or unknown config values. |
| `background` | The posted-review phase submits the hammer dispatch to the in-process AMA hammer background queue and immediately returns retained ownership (`ama-pending`) with reason `ama-closer-dispatch-backgrounded`. The watcher retains ownership until the closer gates return an outcome; a scoped operator label does not skip that evaluation. The background run calls `maybeDispatchAmaCloser` with the same closer args, detached from the posted-review step deadline. |

The queue is process-local, bounded, and keyed by PR@head
(`<owner>/<repo>#<pr>@<head>`). It starts hammer `hq dispatch`
subprocesses at the configured floor (default three), scales with eligible entries
up to the domain ceiling, runs eligible waiters FIFO, and coalesces duplicate
submissions for the same PR@head while one is queued or running. Different heads
of the same PR run serially because they share a worker worktree. The closer
also checks active dispatch records for the same PR at any head before launch;
its configurable capacity limit counts active launches for other PRs only.
`watcher.ama_closer_max_concurrent_launches` is read when the process-local
queue is first created, so changing this limit requires a watcher restart.
When a queued entry gets a slot, the watcher fetches the live PR state,
head, draft flag, and mergeability before calling the closer, and names what
blocked it without launching a hammer (COMMENTCLOSE-01): a closed or updated PR
yields `background-pr-state-changed`, a draft yields `background-pr-draft`, a
PR whose normalized mergeability (`mergeable` plus `mergeStateStatus`, where
`UNKNOWN`+`CLEAN` counts as `MERGEABLE`, because the hammer re-reads
mergeability itself) is still `UNKNOWN` yields
`background-pr-mergeable-unknown`, any other state that is neither `MERGEABLE`
nor `CONFLICTING` yields `background-pr-not-mergeable` (with the observed
`mergeable` value), and an unreadable live state yields
`background-pr-state-unavailable`. A `CONFLICTING` PR is not blocked here: it
reaches the closer, whose hammer resolves the conflict (DIRTYOWN-01). These
results are retained for the next tick to apply through the normal inline
result path. A state change, an `UNKNOWN` mergeability, or an unmergeable PR
retries after 30 seconds; a draft routes to the operator-blocked lane with
`operatorReason: pr-is-draft`, because nothing in the pipeline marks a PR ready
for review, and its operator alert says the PR is a draft. A settle-log failure cannot
leave an unhandled background promise rejection.

When a run settles, the queue keeps its outcome for that PR@head (at most 256
outcomes, dropped after an hour). Safety refusals are consumed once too, so
removing a hold or applying same-head two-key evidence lets the next submitting
tick re-evaluate it. Repeated primary-change refusals still reach the closer's
three-observation SEV1 page threshold; replay does not replace an observation.
The next tick for that PR@head **applies the
outcome instead of submitting again**: the result goes through the same handling
as an inline call. A terminal rejection from the closer's own gates (hammer retry
cap, structural ineligibility) or a thrown error (`ama-dispatch-failed`) reaches
the watcher exactly as it would inline, one tick later, so the merge-agent
fallback and alerting are still reachable. An exhausted remediation round
remains `success/remediation-stopped` on the adversarial gate with an
operator-decision alert. It is not projected as `hammer-pending` merely because
the round cap was reached: AMA enablement, structural holds, and hammer dispatch
caps are checked by the closer before any hand-off. A refused hand-off remains
operator visible and follows normal no-progress backoff. In steady state a
PR@head alternates
between a submitting tick and an applying tick, and the tick after that may
submit again only if the normal closer logic still allows it. The durable
guards remain the safety boundary: `maybeDispatchAmaCloser` checks for an active
same-PR launch, writes
`state: dispatching` and acquires the per-PR closer lease before shelling out,
and later ticks see that active dispatch/lease as
`ama-closer-launch-in-progress` instead of launching a duplicate closer.

Expected watcher logs:

```text
[watcher] AMA hammer dispatch started in background for <repo>#<pr>@<head>; posted-review phase continues
[watcher] AMA hammer dispatch queued in background for <repo>#<pr>@<head>; posted-review phase continues
[watcher] AMA hammer dispatch in-flight in background for <repo>#<pr>@<head>; posted-review phase continues
[watcher] AMA hammer background dispatch settled for <repo>#<pr>@<head>: dispatched=<true|false> reason=<reason> [reasons=[<r1>,<r2>,...]] elapsed_ms=<n>
[watcher] AMA hammer background outcome applied for <repo>#<pr>: dispatched=<true|false> reason=<reason> [reasons=[<r1>,<r2>,...]]
```

When the closer's result carries a `reasons` array, both lines print it
(DIRTYOWN-02). A `reason=not-eligible` always has one, so the log names the
eligibility gates that refused the hammer, for example
`reasons=[pr-not-mergeable,stale-review-head,verdict-not-settled-success,non-blocking-findings-present,ci-not-green]`.

Validation after enabling `background`:

```bash
# Confirm the watcher is reading the intended mode. Unknown/unreadable values
# fail safe to inline and log "watcher.ama_hammer_dispatch_mode unreadable; using inline".
AGENT_OS_WATCHER_AMA_HAMMER_DISPATCH_MODE=background npm test -- test/ama-hammer-background-dispatch.test.mjs

# On a live closeout, watch for the PR@head key and retained ownership. The
# watcher writes to its launchd StandardOutPath file, not the unified log, so
# `log stream` shows nothing:
tail -F ~/Library/Logs/adversarial-watcher.log | grep --line-buffered "AMA hammer"
```

For a live PR that needs hammer closure, the first tick should log `started` or
`queued` and the posted-review row should retain ownership as `ama-pending`
instead of blocking the whole serial closeout phase on `hq dispatch`. A
subsequent tick for the same PR@head while the dispatch is still waiting for a
slot logs `queued`, and while it runs logs `in-flight`; neither creates a second
closer launch. The first tick after it settles logs `outcome applied` and returns
the closer's own result: a hammer that launched, or a rejection the watcher then
handles as it would inline.

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

### 2c. SINGLEREVIEW-01 one review round for super-small PRs

Operator decision (2026-09-29): a super-small PR gets exactly one adversarial
review. That review is the final round. It runs on the `reviewer.last.md`
lenient bar, which still keeps data corruption, secret leakage, security
regressions and broken contracts blocking.

- **No findings.** The normal clean path (`no-remediation-required`).
- **Findings.** The follow-up job is stopped `max-rounds-reached` with no
  remediation worker and no re-review, and the existing ROUNDCAP / terminal
  hammer handoff closes the PR. This includes a `Comment only` verdict with
  non-blocking findings: the single review replaces the comment-only
  final-round worker, so the hammer owns those findings too. Security-surface PRs never reach this lane,
  because they are refused below and queue for Argus as before.

**What counts as super-small.** Either of these:

- ≤`max_changed_lines` changed lines AND ≤`max_files` files, on any path; or
- docs/tests-only within the slim-review limits (20 files / 400 lines), while
  `docs_tests_follow_slim_limits` is on.

**What never qualifies:**

- the gate-keeper surface:
  - `src/{watcher,reviewer,review-state,process-group-spawn,reviewer-reattach,reviewer-cascade}.mjs`;
  - `src/kernel/`, `src/adapters/`;
  - launchd templates and `.plist`, `scripts/`, `bin/`;
  - the `tools/adversarial-review` submodule mount and `.gitmodules`;
- any submodule pointer bump (a gitlink: mode `160000` or `Subproject commit`);
- any rename, copy or file-mode change. Every path rule also runs against a
  rename's pre-image path;
- migrations (`alembic/`, `migrations/`, `versions/*.py`, `*.sql`);
- secret, credential and auth paths;
- sensitive surfaces from `security-surface-classifier.mjs`, and any other
  trigger that classifier reports, including a bot author (Dependabot,
  Renovate, `github-actions[bot]`): refused as `bot-author`;
- dependency manifests;
- `.github/workflows/`;
- any `ADVERSARIAL_REVIEW_SLIM_DENY_PREFIXES` prefix;
- a PR labelled `operator-approved: full-review`.

Anything unknown also means normal rounds: an unreadable config, or a diff
with any `diff --git` header the parser cannot read (quoted Git paths are
decoded, so a quoted protected path is still classified). One unreadable
header refuses the whole PR as `changed-files-unknown` rather than classifying
the files that did parse. The lane applies only to what would have been the PR's *first* review;
a PR already in the round loop never enters it.

**How it rides the existing budget.** There is no second counter. The job is
created with `remediationPlan.currentRound = maxRounds` (the tier budget),
and the decision is recorded on the job as `singleReview`. The remediation
ledger then counts that stop as `maxRounds` completed rounds, which gives two
things:

- the terminal Hammer's "the remediator had a turn" check passes;
- a later author push that is still super-small is re-reviewed once at the
  `last` stage, the same as any budget-exhausted PR, instead of earning a fresh
  budget.

A later push that makes the PR's full diff no longer qualify voids the credit.
For example, a small first push followed by a change to `src/watcher.mjs`. The
reviewer re-classifies every non-`first`-stage review. When the PR no longer
qualifies, it writes
`data/follow-up-jobs/single-review-voids/<domain>--<repo>-pr-<n>.json`. The
ledger then stops counting the earlier single-review stop, the review re-stages
(normally to `first`), and the PR gets its normal tier budget. The reviewer log
shows
`single-review: voided <repo>#<n> credit — head no longer super-small (<codes>)`
and `Effective prompt stage for <repo>#<n>: …`.

If the void marker cannot be written after 3 attempts, the reviewer logs
`[reviewer] Unhandled error: Error: single-review credit void did not persist for <repo>#<n>; refusing to review until it does`
and exits non-zero before dispatch. The watcher retries the pass. Fix the
`data/follow-up-jobs/single-review-voids/` write failure, for example
permissions or a full disk. A stopped single-review job still counts after the
stopped-job archive sweep moves it to `stopped-archived/`.

Knobs, all under `roles.adversarial.single_review`:

| Key | Default | Effect |
|---|---|---|
| `enabled` | `true` | `false` restores normal rounds for every PR. |
| env `ADVERSARIAL_REVIEW_SINGLE_REVIEW_ENABLED` | unset | `false`/`0`/`off` disables the lane, and `true`/`1`/`on` enables it. It overrides `enabled`. **Use this as the kill switch** until the key below is registered in every loader. |
| `max_changed_lines` | `50` | Changed-line ceiling for the any-path rule. |
| `max_files` | `5` | File ceiling for the any-path rule. |
| `docs_tests_follow_slim_limits` | `true` | Docs/tests-only PRs qualify up to the slim limits. |

These are registered in the adversarial-review JS loader only. Do not set them
in `config.yaml` until agent-os lands the matching keys in:

- the Python `schema_v1`;
- `env_aliases.py`;
- the shell `SHELL_ALLOWED_KEYS`.

Until then the defaults apply.

Diagnose from the reviewer log:

```bash
grep 'single-review:' <reviewer log>
# [reviewer] single-review: super-small owner/repo#123 super-small (small-change; 2 file(s), 12 changed line(s)) — first review is final; prompt stage=last
```

The follow-up job carries `singleReview` and, once claimed, a stop reason that
begins `single-review: super-small PR; the first review was the final round`.
The `review_mode_selected` latency row's payload carries `singleReview` too. The
reviewer-pass reaper reads it back when it re-queues a posted review whose
reviewer died.

---

## 3. Validating cutover

### GitHub review-state contract

The reviewer keeps its body-level verdict vocabulary (`Request changes` or
`Comment only`) separate from GitHub's submitted review event. An exact-head
review with both structured finding sections present and empty is submitted as
GitHub `APPROVE`, so `reviewDecision` and downstream merge authority receive an
explicit clean signal. `Comment only` with any non-blocking finding remains a
GitHub `COMMENT`, and any blocking finding remains `REQUEST_CHANGES`. Missing or
unparseable finding sections fail closed to `COMMENT`; they are never promoted
to approval.

Cut a low-risk test PR (any work that would normally trip the
adversarial-review path, e.g. a docs-only change with a worker-class
title prefix matching the configured class — `[codex]`, `[claude-code]`,
`[hammer-claude]`, or `[gemini]`). Expected sequence (substitute `<configured-worker-class>`
with the value of `roles.adversarial.merge_authority.worker_class` from
your CFG; supported values are `codex`, `claude-code`, `hammer`,
`hammer-claude`, and `gemini`, and the reviewer/closer identities follow whatever class you
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
   The dispatch args include `--priority critical` only for a finding-free
   mechanical validate-gate-and-click close whose remaining gate is pending
   required CI. HAM terminal-remediation closes for findings, red CI, or
   mergeability repair dispatch with `--priority normal`.
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
   Each launch's closer row is recorded once, and an error while recording it
   never fails the closer decision (see "A hammer that died of an
   infrastructure cause" below).
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
   To roll back only HAMASYNC-01 background dispatch while keeping hammer
   closure enabled, set `watcher.ama_hammer_dispatch_mode: inline` or unset
   `AGENT_OS_WATCHER_AMA_HAMMER_DISPATCH_MODE`; unreadable or unknown values
   also fail safe to `inline`.

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

For the five other hard-stop labels (`merge-agent-skip`, `do-not-merge`,
`no-merge-hold`, `duplicate-family-hold`, `merge-agent-stuck`), see SPEC §4.2 #6. They block AMA
closure regardless of evidence except for the documented
`merge-agent-stuck` carve-out above, which requires current-head
`merge-agent-requested` evidence and does not accept `operator-approved`
as a substitute recovery signal. On the posted-review closeout tick, these
labels surface as the `operator-skip-label` gate reason and the handler returns
`skip-operator-skip`: open PRs stay owned but no daemon merge, hammer, or
merge-agent dispatch is launched. If GitHub reports the held PR is already
terminal (`merged` or `closed`), the watcher clears the no-progress lane and
drops ownership instead of retaining the hold forever.

The posted-review handler also admits explicit pending re-review rows when a
follow-up worker has just requested another adversarial pass. Those rows are
held while the gate remains `review-queued`, `review-in-progress`,
`rereview-queued`, or otherwise non-success: reviewer delivery owns that state,
not AMA/HAM. The narrow exception is a head-change re-review whose latest
completed follow-up job carries a clean settled verdict for the current head;
that projects `review-settled-head-change-rereview` and lets closeout continue
without waiting for a redundant reviewer post. A missing job head fails closed.
The re-review reason must also name the current head: `current head is <sha12>`
for auto-refresh, `live=<sha>` for FSR-06B. The reason stays on the row after
its review posts, so a reason naming any other head, or a head whose review
has posted, is history and grants nothing (COMMENTCLOSE-02).

A recorded comment-only final-round push is resolved before that reason, so it
outranks even a live one. Suppose a posted row's reason still names the pushed
head: a re-review of that head was requested but never posted. The final
round's verdict then wins, the result carries `overrodeHeadChangeRereview: true`,
and the gate logs one
`[adversarial-gate] comment-only-final-round-overrides-rereview:` warning per
PR, pushed head and reason, naming the reviewed head, the pushed head and the
reason. Merge still waits on exact-head HAM validation. When you see this
warning and the skipped re-review must still run (an FSR-06B request, or one an
operator asked for), apply `adversarial-merge-blocked` before the hammer's
terminal validation, then request the re-review.

A proven final-round head that conflicts with base reaches the hammer even with
red or pending CI (DIRTYOWN-02), because the hammer must rebase before any CI on
it counts. The conflict is proven only from GitHub's raw signal
(`mergeable=CONFLICTING` or `mergeStateStatus=DIRTY`) beside the
`pr-not-mergeable` gate. A `pr-not-mergeable` head that is only `BLOCKED` by a
red required check, `UNSTABLE` or `BEHIND` still parks on red CI or waits for
pending CI as before. A conflicting head never gets the final-round CI-wait
exemption from the retain-loop cap. When a final-round PR parks with
`reasons=[...,pr-not-mergeable,...,ci-not-green]` in the dispatch log lines
above, read `gh pr view <n> --json mergeable,mergeStateStatus`: a conflict
there should have resumed the hammer, while a `BLOCKED` head needs its red
check fixed first.

Normal `posted` rows are different. `stale-review-head`,
`blocking-findings-present`, and `verdict-not-settled-success` remain AMA/HAM
eligibility inputs, because the merge authority owns the evidence-specific
waivers for rebase coverage, trailer-only head moves, terminal remediation, and
operator-scoped approvals. The watcher must not hard-hold those posted rows
before `resolveMergeAgentCoexistence`.

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
2. **Rebase onto a recent `main` and confirm the merge guards.** The hammer
   always rebases at least once onto the current base and re-validates the
   rebased head — required checks plus the changed-surface test bar above —
   before merging. After that validation, a target branch with an explicit
   `required_status_checks.strict=false` rule, or no required-status-checks rule
   at all, does not force the hammer to chase a moving base when the PR becomes
   `BEHIND` only because unrelated PRs landed. In that narrow lane the hammer may
   merge the still-`BEHIND` head only when GitHub reports `MERGEABLE`, the newer
   base has no changed-file overlap with this PR (`ham_base_touches_pr_files`),
   and the head already completed the one recent rebase plus validation. A
   strict up-to-date rule, an undetermined branch-protection read, a non-
   `MERGEABLE`/conflicting PR, or any base/PR changed-file overlap still fails
   closed into the normal rebase-and-revalidate path.
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
   evidence. The parser still expects the hammer to list changed file paths for
   each finding, but preserves a finding by title with an empty file attribution
   when the audit line omits an exact changed-file path so coverage counts do not
   silently lose addressed findings.
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

### `worker class claude-code does not support task kind merge`

A closer or merge-agent dispatch fell back to a coding-only class. The closer
fallback list is `roles.adversarial.merge_authority.worker_class_fallback`,
resolved through the domain policy; a domain or operator override that names
`claude-code` replaces the merge-capable `[hammer-claude]` default. Check the
active domain's `mergeAuthority.workerClassFallback` and any `local:`/`env:`
override of that key, and restore a hammer class. See §2a (**Domain
declaration**) for the precedence rules.

### Terminal branch-holder takeover

On a hammer provision collision, the closer first requires terminal worker-run
evidence and checks for processes with a cwd inside the holder as its owner. It
inspects Git and archives dirty or locally divergent holders as that same UID;
cross-user commands use `sudo -A -H -u <holder-owner>`. The daemon temporarily
transfers ownership of the unique rescue directory for archive creation and
restores it afterward. Mixed-owner Git worktree removal uses sudo with the
owning repository explicitly marked safe. A holder whose Git metadata is
missing or invalid is removed without salvage after the process check, with a
`corrupt-removed` audit decision. Other inspection failures still refuse
takeover; rescue archives and decisions are recorded under `rescues/holder-adopt`.

### `worker-identity-unresolved` on daemon clean-merge

The daemon clean-merge path resolves the identity of the worker that opened the
PR (head-attestation → `pr_opened` ledger row → HQ worker
`launch-provenance.json`) so the merge is attributable. The provenance fallback
matches only when it carries the exact canonical repository identity GitHub
reports for the PR: `<owner>/<name>`. Short-form `<name>` provenance is ambiguous
across forks and intentionally fails closed; update the producer to write full
repo identity rather than weakening the daemon matcher.

**Un-attributed PRs (operator/agent infra-fix PRs).** A PR that no hq worker
opened — an operator/agent infra-fix PR authored by the operator on a
`claude-code/*` branch — carries no launch-provenance, so identity resolution
correctly fails closed. These PRs do not park anymore: an explicit, **head-scoped
operator label IS the accountability that substitutes for the missing worker
identity** (the operator-approval auto-close lane). Apply either:

- `operator-approved` — the canonical operator override, or
- `merge-agent-requested` — the operator-fallback signal,

**on the current head**. The daemon merges under an operator-accountable lease
(the audit records `mergeAccountability: operator-approval` with the label,
actor, and event id). `merge-agent-requested` substitutes for worker identity
only; it still needs a settled-success, strict-clean review. Current-head
`operator-approved` also overrides the verdict and finding-count gates, so a
`Request changes` review with blocking findings can use the daemon lane even
when worker identity resolves. When the live label is present, the audit records
`closureAuthority: daemon-operator-approved-override`,
`mergeAccountability: operator-approval`, and `operatorApproval` with the
actor, event id, observation time, and approved head. A successful merge emits
`ama.daemon_clean_merge.operator_override_merge` with the same provenance. The
daemon re-reads the live label and head before merging. Its validated head is
the live, approved head, which must still match the head at the merge attempt.
When the approval substitutes a newer head for an older clean review, the audit
also records operator approval and the in-lease read must still find that label.
An inline override that clears a verdict or findings gate requires an allowlisted
operator actor even when actor enforcement is configured as `observe`.
Required checks, branch protection, mergeability, and the merge lease remain
mandatory. An older-head approval or a label removed before the live read or
inside the merge lease is refused with no carryover when the override is needed
for review eligibility or operator accountability. A fully clean, settled review
with resolved worker identity continues through the ordinary daemon gates when
the label is removed; a required approval holds dispatch until the next tick
reads fresh labels. Actor provenance is mandatory. For ordinary clean reviews,
default `observe` enforcement honors a known actor even if that actor is not
allowlisted; `enforce` requires an allowlisted operator login. The substitution emits
`ama.daemon_clean_merge.operator_accountability_substituted`.

### A succeeded hammer must have closed its PR (HAMBG-02)

A hammer LRQ that ends `succeeded` has only proven that its process exited 0.
Headless Claude hammers backgrounded the close and ended the session (SEV2
2026-09-29), leaving the PR open. When the closer observes a `succeeded` hammer
it asks GitHub for the PR and classifies the run:

| Live PR | Evidence for the current head | Recorded `outcome` | Next |
|---|---|---|---|
| `MERGED` | n/a | none (merged paths) | merged handling as before |
| `OPEN` | local AMA audit `failed-without-merge`, or the hammer's audit comment (`<!-- hq:ham-terminal-remediation:audit -->`, same `HAM-Terminal-Remediation-Head`) carrying `HAM closing status — no merge` | `failed-without-merge` | charged re-dispatch within the hammer retry cap |
| `OPEN` | neither | `hammer-exited-without-close` | lease released, refunded re-dispatch |
| `OPEN` | no local audit, and the PR's comments could not be read | none; `lastError: hammer-outcome-unconfirmed:audit-comments-unreadable` | launch retained, nothing refunded; the next tick asks again |
| unreadable | n/a | none; `lastError: hammer-outcome-unconfirmed:<why>` | launch retained; the next tick asks again |

The audit comment alone is not a close. hammer-publish posts it before the merge
phase, so a hammer that published and then lost its merge leaves it behind
(adversarial-review#1178, agent-os#7345).

On `hammer-exited-without-close` the closer:

- finalizes the closer lease the hammer held, including a lease the watcher
  rekeyed onto the head the hammer pushed. That lease belongs to the recorded
  launch, so it no longer answers `closer-lease-held-by-other-process` for 30
  minutes;
- marks the dispatch record terminal, which frees its in-progress launch slot;
- refunds the exited dispatch in the hammer retry-cap ledger (`attemptCount`
  down, `retryable` up). The shape follows HAMGATE-01's merge-gate refund, but
  the counter is this ledger's own; the merge gate's `retryable` in
  `data/merge-leases/` is separate and has its own budget. One exit per reviewed-head
  series is refunded. Past that, an exit stays charged and the normal cap
  suppresses and pages. The lifetime count is never refunded;
- re-dispatches in the same tick, subject to every existing gate.

The closer reconciles the newest launch in the review series. A hammer that
pushes moves the head, and its re-dispatch record is keyed on the new head, so
the closer follows the record for the same `reviewedSha` with the newest
`dispatchedAt`. Re-reconciling a launch whose closer pass is already recorded
logs `closer pass already recorded` and continues instead of throwing
`refusing to reuse terminal reviewer_passes row`. The closer pass is keyed on
`attempt=retryCount`, not on the launch, so a launch from a later review series
can land on a terminal row another launch wrote. Since CLOSERREUSE-01 that
launch is recorded at the PR's next free closer attempt, logged as `closer pass
attempt-number collision` with both launch ids.

To inspect a PR: the watcher log carries `ama_closer.hammer_exited_without_close`
(with `retryRefund`) or `ama_closer.hammer_ended_without_merge`, and
`data/follow-up-jobs/hammer-retry-cap/<repo>-pr-<n>.json` shows `retryable` and
`retryableLaunchRequestIds`.

### A hammer that died of an infrastructure cause (CLOSERREUSE-01)

A hammer that dies on a provider 429, a revoked OAuth grant or an adapter boot
crash never ran its close. Before CLOSERREUSE-01 (SEV2 2026-09-29) such a death
did two things. It spent a real retry-cap attempt, so agent-os#7349's two 429
deaths parked it at `hammer-retry-cap-exhausted`. And the closer's next ticks
failed on `refusing to reuse terminal reviewer_passes row` whenever the first
tick after the death deferred its re-dispatch (agent-os#7347, deferred behind
another PR's launch).

Now:

- **Recording.** A closer pass is recorded once per launch, decided before the
  token rollup poll (`src/ama/closer-pass-attempt.mjs`). A terminal row for the
  same launch makes recording a no-op, and another launch at the attempt is
  recorded at the next free attempt. Any error while recording is logged as
  `closer pass recording failed` and never fails `maybeDispatchAmaCloser`.
- **Re-arm.** When a hammer launch is observed `failed`, pushed nothing (the PR
  head is still its dispatch head), and its LRQ failure class is
  `oauth_access_token_revoked`, `adapter_boot_crash`, or
  `process_exited_after_progress` / `worker_killed` with the provider's API 429,
  the closer refunds its dispatch (`src/ama/dead-hammer-rearm.mjs`) and
  re-dispatches on the same head in that tick. The 429 must come from the
  harness: the LRQ's failure detail, the final `result` event of the worker's
  `<HQ_ROOT>/dispatch/<lrq>/stdout.log`, or a provider error line. A quote of
  the 429 text in the worker's own narrative does not count. An
  `oauth_access_token_revoked` or `adapter_boot_crash` death is refunded only
  when the next dispatch resolves to a different harness class (for example the
  provider is now grounded and a fallback takes over); otherwise the same class
  would die the same way, so the death stays charged with reason
  `infra-cause-persists`. A 429 death is refunded without that probe.
- **Budget.** The refund is the one above: the same ledger, the same
  `retryable` counter, and the same one refund per reviewed-head series,
  whether the launch exited without closing or died of infrastructure. Past
  it, the death stays charged, and the normal cap suppresses and pages.
- **Log.** `ama_closer.infra_dead_hammer_rearm` records `rearmed`, `cause`,
  `failureClass` and the refund's `reason` (for example
  `retry-budget-exhausted`). It is logged once per launch, whatever the reason:
  the dispatch record's `infraRearmLoggedLaunchRequestId` names the launch
  already logged. A launch re-observed while its re-dispatch waits, or after
  the cap suppressed the series, is not logged again.

A failure class outside that list (`worker_crashed`, an exit after progress
with no 429, an unreadable LRQ row) stays charged, as before.

### Daemon fail-closed on a hammer-remediable gate → capped hammer fallback

When the daemon clean-path fails closed on a **remediable** gate for an
**attributed** (identity-resolved) clean PR, the watcher no longer parks it for
manual close — it hands the PR to the SAME capped hammer the common path uses.
The hammer re-validates the required gate at the post-remediation head and merges
under its own lease. Remediable gates:

The in-lease live gate carries the exact-head terminal predicate's branch
protection requirement into the shared eligibility check. When that predicate
has verified the repository's branch protection waiver, green required checks
can pass; an absent or unresolved predicate decision fails closed.

| Daemon fail-closed reason | Hammer action |
|---|---|
| `stale-head` | the reviewed head moved; a fresh review head gets its own hammer |
| `gate-not-eligible` with `verdict-not-eligible` | a selected daemon route disagreed with the live verdict gate; the hammer re-validates the verdict before merge |
| `gate-not-eligible` with `ci-not-green` | the hammer repairs the failing required checks, then merges |
| `gate-not-eligible` with `pr-not-mergeable` | the hammer rebases onto base / resolves the conflict, then merges |

Every hammer dispatch — including this fallback — is bounded by the per-PR
hammer-retry-cap (per-reviewed-head 2, lifetime 6). At the ceiling the closer
fails **loud** via a GBI operator alert and suppresses further dispatch; it is
never an uncapped re-dispatch. The fallback emits an
`ama.daemon_clean_fail_closed.hammer_fallback` event.

**Non-remediable gates still hold** (fail closed — no blind merge-clicker):
`worker-identity-unresolved` (use the operator-approval lane above),
`lease-not-held`, and permanent or unclassified merge rejections. Transient
budget/read exhaustion may retry on a later tick. The watcher emits
`ama.daemon_clean_park.manual_close_required` only when the daemon marks
`manualCloseRequired`, a permanent failure, or a non-remediable identity or
eligibility gate requiring operator action. It also fires once per head when a
closer→daemon route disagreement on a non-remediable decline passes its bound
(see the next section). Missing live labels or GitHub's still-computing
`mergeable=UNKNOWN` (`pr-mergeability-unknown`), alone or together, produce a
transient `gate-read-failed` with no manual-close marker or page and no
permanent-failure audit; an UNKNOWN read is first re-sampled within the
daemon's merge retry budget, and the daemon can retry on a later tick. Beside
a real gate miss, an UNKNOWN is still re-sampled, and the terminal is a
non-permanent `gate-not-eligible` without a manual-close marker. A hammer-remediable failure instead emits
`ama.daemon_clean_fail_closed.hammer_fallback`. A removed `operator-approved`
label is a protective hold, not a hammer handoff.

### Closer routed to the daemon, daemon declined → logged, then hammer or park (CIDEDUPE-01)

The daemon clean-merge runs first each tick; when it returns `not-taken` the
tick falls through to the closer. If the closer's own eligibility passes, it
answers `daemon-clean-route` ("the daemon owns this PR") and dispatches
nothing. If the daemon keeps declining the same head, nothing acts. That is
how agent-os#7314 sat `STALLED` (SEV3, 2026-09-28): the closer read CI as
latest run per check, the daemon as every run, and a superseded cancelled run
was red to one and not the other. Both now call one classifier
(`classifyCheckRollup` in `src/checks-summary.mjs`). The backstop below
(`src/daemon-route-disagreement.mjs`) covers any disagreement that remains.

- **Every disagreement is logged** as an `ama.daemon_route_disagreement` event
  (plus a `[watcher] AMA closer routed … but the daemon declined …` line). The
  event carries the daemon's `daemonDisposition`, `daemonReason`,
  `daemonReasons` (gates), and the per-head `disagreements` count. The count is
  stored at `data/follow-up-jobs/daemon-route-disagreement/<repo>-pr-<n>.json`.
  A new head restarts it, and a daemon merge deletes it.
- **Transient-read declines are logged but never counted** (DIRTYOWN-01). A
  `not-eligible` decline whose gates are all transient GitHub reads
  (`pr-mergeability-unknown`, `labels-unavailable`; the daemon's
  `TRANSIENT_GATE_READ_REASONS`) logs the event with `transientRead: true` and
  `escalation: null`, and leaves the count unchanged. It cannot reach the
  hammer or park escalation, so a moving `main` that keeps GitHub recomputing
  mergeability never pages for a manual close. The closer also reads a raw
  `mergeable=UNKNOWN` as `UNKNOWN` whatever `mergeStateStatus` says, as the
  daemon does (`closureGateMergeability`), and its bounded re-sampling uses the
  same classifier, so an `UNKNOWN`+`CLEAN` read is re-sampled and then waits a
  tick on both sides instead of the closer routing it to the daemon. A
  transient-read decline reports the caller's current head and a count of 0
  when the stored series belongs to another head.
- **A transient read beside a hammer-remediable gate still reaches the hammer**
  (DIRTYOWN-01). `pr-mergeability-unknown` next to `ci-not-green`,
  `pr-not-mergeable`, `stale-head`, or `verdict-not-eligible` is judged on the
  other gates: pre-lease it counts toward the bound and then takes the
  `hammer_fallback` row below; post-lease the daemon re-samples the UNKNOWN,
  then fails closed as a NON-permanent `gate-not-eligible` with no
  manual-close marker, so Gate 3 never locks the head out and the closer's
  fail-closed hammer fallback takes it. An UNKNOWN beside `lease-not-held` or a
  non-remediable gate is not remediable.
- **A head stuck on transient reads is surfaced once** (DIRTYOWN-01). The first
  transient-read decline on a head is recorded in a
  `<repo>-pr-<n>.transient.json` sidecar next to the count file. When declines
  on the same head span more than `MERGEABILITY_UNKNOWN_STUCK_MS` (30 min), the
  watcher logs one `ama.mergeability_unknown_stuck` event for that head (with
  `firstObservedAt`, `elapsedMs`, and the daemon gates). It is an operator
  signal only: it never counts, parks, or pages. A new head restarts the
  clock, and a daemon merge deletes the sidecar with the count file.
- **Past the bound** (3 disagreements on one head), the next tick escalates:

| Daemon decline | Escalation |
|---|---|
| `not-eligible` whose gates are all hammer-remediable (`verdict-not-eligible`, `ci-not-green`, `pr-not-mergeable`, `stale-head`), optionally with `pr-mergeability-unknown` alongside | The closer is called with `forceHammerAfterDaemonFailure`, so the capped hammer takes the PR (per-PR hammer-retry-cap applies). Emits `ama.daemon_route_disagreement.hammer_fallback`. |
| Any other decline (e.g. `duplicate-family-unresolved`, a transient read mixed with a non-remediable gate or `lease-not-held`, `prior-daemon-terminal-failure`, `findings-unknown`) | Keeps the diagnostic `daemon-route-disagreement` park record and enters bounded automated recovery. Safety holds retain adjudication; other exhausted recovery emits a structured SEV1 and one page. |

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
| `skip-operator-skip` | A hard-stop operator label produced `operator-skip-label`; the watcher is deliberately holding merge/hammer/merge-agent closeout for an open PR. Terminal held PRs are cleaned up instead of held. |
| `stale-review-head` | The reviewed head doesn't match the PR's current head. |
| `pr-not-mergeable` | The PR is closed, or GitHub's `mergeableState` is neither `MERGEABLE` nor `UNKNOWN` (usually a conflict; also strict-mode `BEHIND` or an empty/unrecognized enum). Hammer-remediable for a conflicting or behind open PR: the hammer resolves the conflict or rebases. A closed PR or an empty-state read gets no hammer fix. |
| `pr-mergeability-unknown` | GitHub still reports `mergeableState` `UNKNOWN` after the watcher's bounded re-sampling (it recomputes after a push or base move). Transient: on a non-exhausted review cycle it is not hammer-remediable (an exhausted cycle still hammers any miss without `stale-review-head`), and it never produces a manual-close page; the next tick re-reads. On the daemon clean path an UNKNOWN-only miss inside the lease is re-sampled within the retry budget and then ends as the non-permanent `gate-read-failed`, so the head stays eligible for the daemon on the next tick (a diagnostics park record is still written, as for every non-merged daemon outcome). A pre-lease UNKNOWN decline is never counted as a closer→daemon route disagreement. |
| `primary-change-reverted` | Trusted first-hammer-parent history shows an author-changed region returning to the merge base, a removed line being restored, or a rename undone. AMA stops both hammer closeout and daemon merge; `operator-approved` does not bypass this gate. The daemon records this park reason for pipeline-health. Inspect the primary and final diffs and the finding authorization described below. The closer pages once per refused head after three observations; both daemon and closer expose scoped operator recovery described below. |
| `primary-change-unknown` | Evidence was read but cannot be evaluated: a capped history/file list, omitted patches without identical trusted blob evidence, truncated patches, or a permanent permission/compare read failure. Head races are transient. Text renames (including pure renames) are supported through `previous_filename`. This fails closed without claiming a proven reversal; `operator-approved` does not bypass it. Retain the merge hold while recovering evidence. The closer pages once per refused head after three observations; recover using the scoped route below. |
| `primary-change-read-failed` | A transient GitHub read failed after the reader's bounded retry budget, or the head raced the read. Installation-token auth outages and cancellation are retryable reads. Permanent permission, missing compare and malformed JSON errors are structural unknowns requiring evidence recovery. An in-lease unknown after pre-lease validation remains non-permanent so a partial re-read cannot poison that head. This is a retryable outage, including on PRs without hammer commits, and defers closure as `gate-read-failed`. It does not require operator adjudication or write a permanent failed-head marker. The next tick retries. |
| `remediation-pending` | Adversarial-review remediation work is owed before AMA can close. |

### Primary-change evidence, authorization and disputes (HAMINTENT-02 / LAC-1833)

Both merge paths use `src/ama/primary-change.mjs`. The protected baseline is the
earliest daemon-owned dispatch launch head with a valid SHA when available, covering untagged
repairs. After a rebase diverges from that launch, it is the actual parent of
the first hammer commit in the rebased PR history; a hammer-authored `Reviewed-Head` trailer cannot select an older author
head. Both primary and final diffs are compared against the current PR base,
using the same merge base so rebased upstream changes are excluded. Hammer closure detection
uses the terminal commit trailer block. Reversal authorization additionally
uses `hamCommitIdentityMatches` with the trusted HAM login set
(`hamAuditCommentAuthorMatches`): reject any linked non-HAM author or committer;
otherwise accept a linked HAM author, or an unlinked author with a linked HAM
committer and all three terminal trailers (`Worker-Class: hammer`, including
`hammer-corp` / `hammer-claude`, `Worker-Ticket: HAM` / `AMA-PR-<n>`, and
`Closed-By: hammer (adversarial-pipe-mode)`). A HAM committer stamped onto a
linked foreign author cannot authorize reversals, even with valid trailers.
Binary and omitted-patch files can pass only with an identical GitHub blob SHA and change status;
otherwise their preservation remains unknown. Structural hammer merge refusals
are audited immediately with their primary-change reason, while read failures
retry within the bounded gate window. Every
changed region in production and config paths must still differ from that base, and removed-line occurrence
counts must survive (whitespace is normalized). In-place fixes to added author
lines are allowed. A preserved result means syntactic region coverage only; it cannot detect adjacent constant changes, false guards, or moved removed lines. This syntactic check does not prove semantic intent;
reviewers and the hammer still inspect inversions and neutralizations.

Test paths (`test/`, `tests/`, `**/*.test.mjs`, `**/*.test.js`, and
`**/__tests__/**`, including fixtures under test directories) are excluded from
`primary-change-reverted` and reported as informational `testRegionsChanged`
evidence. CI verifies tests against the final head; test repairs mandated by
findings are allowed. Reviewers must still flag inversions or neutralizations of
the tested primary-change behavior. Renaming production code into a test path
does not exempt its protected baseline.

The hammer's `bin/primary-change-context.mjs` reads each GitHub endpoint through
`execGhWithRetry`: transient transport, timeout, rate-limit and HTTP 5xx failures
get at most three attempts with 500/1000ms backoff and a 15-second timeout per
attempt. Permanent permission errors are not retried; rejected credentials use
the helper's single forced token-refresh attempt. Exhausted reads and malformed
JSON emit head-scoped `readFailed: true` evidence, which the predicate treats as
`primary-change-read-failed` rather than a proven reversal. The hammer prompt's
90-second process limit still bounds the complete collection.

A blocking finding may authorize a specific reversal. A non-blocking finding may
also authorize one only when the effective `strict_non_blocking_remediation` policy
is enabled; advisory findings in non-strict mode cannot waive preservation.
All three evaluators pass the effective policy to the primary-change predicate:
closure eligibility (`bin/ama-check.mjs`), the daemon's pre-lease and in-lease
merge checks, and the hammer's in-lease GitHub gate (`bin/hammer-merge.sh`).
The hammer gate resolves `loadConfigCached().getMergeAuthorityConfig()` on each
live gate read, just as `ama-check` does, with strict remediation enabled unless
`strictNonBlockingRemediation` is explicitly `false`. The HAM commit must carry
`Reversal-Authorized-By: <review node id or URL> finding=<n> [kind=<blocking|non-blocking>]`, `Worker-Ticket: HAM` (or `AMA-PR-<n>`),
and `Reviewed-Head` naming that review's head. The finding number is its one-based
position in the indicated section (blocking by default for legacy trailers).
Emit one trailer per finding whose fix edits primary-change lines. Multiple
trailers may cite the latest review from each authoritative reviewer family on
the Reviewed-Head; another model does not supersede that family’s final review.
Choose one literal kind (`kind=blocking` or `kind=non-blocking`). If cited reviews
have different heads, split HAM commits by reviewed head, with one `Reviewed-Head`
and its matching citations per commit.
The collector verifies authoritative
reviewer identity, review/commit ancestry inside the protected closure, live HAM
commit patches, and File/Lines coverage of each reverted base line. Base coordinates
are projected into the reviewed and commit-parent heads, accounting for line shifts.
Equal-length replacements map by line position; unequal-length replacements and
insertions require the finding to cover the entire projected span. A one-line
finding cannot waive the uncited remainder of a contiguous author hunk.
Unrelated regions, missing trailers and old reviews outside
the closure cannot authorize a reversal. Opaque files and rename checks remain
fail-closed. Other merge safety checks remain unchanged.

For a disputed blocking finding, the hammer preserves the code and releases its
merge lease, then runs `bin/dispute-finding.mjs` with `--root-dir`, `--repo`, `--pr`,
`--head-sha`, `--review`, `--finding` and `--evidence-file`. The evidence is bounded
to 16,000 UTF-8 bytes. Before opening SQLite or performing DDL, the helper
requires its effective UID to own the existing `data/reviews.db`, its data
directory and any WAL/SHM sidecars, and the configured alert sink owner boundary
(resolved through `ADVERSARIAL_ALERT_DELIVERY_ROOT` /
`AGENT_OS_ALERT_DELIVERY_STATE_DIR`, with the pager's normal default). Missing
databases and cross-user writes fail before mutation. Run the helper as the
canonical daemon owner (for example `sudo -A -H -u <owner>` with that owner's
pager environment and the existing HAM GitHub identity). A different-user
hammer shell refuses with exit 78; a non-HAM GitHub identity refuses with exit 79.
Preserve evidence and record a no-merge handoff rather than switching accounts
or credentials in the worker.
The helper verifies the live head and the latest submitted authoritative review
in its ancestry; a superseded blocking review cannot spend the dispute budget.
It posts a finding-linked evidence comment, rechecks the head, and calls the existing
`requestReviewRereview` CAS with `targetRevisionRef`. Both full and slim reviewer
prompts include exact-head dispute evidence only when the comment has a trusted
HAM author and matches the helper's durable reservation by comment node ID, head,
poster identity and SHA-256 body digest. Legacy REST and adapter contexts carry
`node_id` alongside their numeric IDs so the same reservation check applies.
Each finding reservation contributes its latest comment, rather than only the
last two disputes overall, with 16,000 bytes per comment and a 256,000-byte total
context cap. Edited, unreserved and spoofed comments
are omitted. The reviewer must confirm or withdraw each admitted dispute.
The evidence is untrusted PR content, never a merge waiver. Do not merge while
awaiting adjudication or claim the disputed finding was remediated.

Neither finding-anchored reversal nor dispute raises `hq decision raise`. Disputes respect the configured review
cap (also bounding total dispute requests per PR) and permit at most two requests per finding (title/file identity persists
across heads). Cap exhaustion or repeated refusal emits `ama_finding_dispute_exhausted`
with SEV1 and pages once per PR for its lifetime (later heads do not reset the
guard). The atomic page guard is held during enqueue and cleared if the pager
throws, allowing a later invocation to retry without posting another dispute or
spending another request. A successful durable enqueue retains the guard;
the alert outbox owns delivery retries. Failed comment writes or head rechecks refund the request reservation;
the cycle threshold uses `shouldEscalateReviewCycle.escalate`.
Preservation refusals retain the merge hold as
`primary-change-repair-required` with `needsOperator: true` until the REMORPHAN-01
watchdog admits a repair worker. Refusal observations alone no longer page.
The dispute page guard persists across restarts. Read outages remain `gate-read-failed`
and retry normal ticks after transport/auth recovery. Recovery-store or pager
failures are logged and always retain `skipMergeAgent: true`.

For a refused head, inspect `bin/primary-change-context.mjs` evidence and repair
the PR branch or restore missing history/patch access. A new head re-evaluates
the predicate. If evidence recovery needs another worker, an attributable operator
can apply `merge-agent-requested` scoped to the current head and latest PR update.
The existing operator-fallback lane accepts both the closer's
`primary-change-repair-required` and the daemon's `primary-change-needs-operator`,
with `needsOperator: true`. This exception does not include other safety holds:
risk/two-key policy, security, destructive-change holds, hard-stop labels
(including `no-merge-hold`) and hammer-cap suppression retain adjudication.
An unresolved `dispatch-status-unknown` probe retains AMA ownership even after
its dispatched lease expires: lease age cannot prove the hammer has stopped.
Before taking over a settled primary-change refusal, the watcher checks for a
live closer lease at any head, including a lease keyed to the previous head.
Both inline and background modes evaluate the closer first; newly queued/running
background work retains ownership until its gates return a result, and is not
cancelled by the label. Once the guarded operator fallback is selected, its
queue entry is aborted. Observing or submitting a newer head also aborts older
entries for that PR: queued entries are removed without launching, while running
entries retain their slot until settlement and do not retain cancelled outcomes.
The scoped operator-fallback predicate requires the
request label to remain present on the current snapshot and excludes
`remediation_pending` rows. It also rejects `merge-agent-skip`, `do-not-merge`,
`no-merge-hold`, `adversarial-merge-blocked`, `merge-agent-stuck`, and
`duplicate-family-hold`. The same predicate controls both fallback selection and
the eligibility-miss recovery routing. Timeout handoffs normalize the live
GitHub label objects into names before applying it.
Generic `operator-approved`, stale label events and read outages do not activate
this route. This is a recovery dispatch, not AMA merge eligibility or a waiver of
the primary-change predicate. REMORPHAN-01 automatically dispatches a repair
HAM after six consecutive ownerless ticks on an open, non-draft, unheld head.
Its primary-line edits require the HAMINTENT-03 per-finding
`Reversal-Authorized-By` contract or restoration of the reverted lines.
The same watchdog covers `no-progress` / `remediation-stopped` remediation,
blocking findings with explicit valid round/max-round evidence below max and no
pending job, and closer-authored stale heads (STALECLOSER-01). `operator-stop`
and every other unrecognized stop code forbid recovery; a missing plan does not
default to below max. A scoped `merge-agent-requested` retains its operator
fallback precedence, including on heads whose watchdog budget is exhausted.
A closer head that HAM cannot re-certify gets one exact-head re-review.
Admission never waives CI, primary-change, identity, policy or merge leases.
Across-head live launch records and pending reviewer/remediator queues retain
ownership. A closer `dispatching` intent without a launch identity proves
ownership only while the existing closer lease/PID/age checks report a live
launch, including the narrow pre-lease write window. Interrupted or stale
intents at any head enter uncertainty and page rather than resetting streaks
forever. Their unresolved reservations stay charged. `primary-change-unknown`
also enters uncertainty; unreadable reversal evidence never admits a repair HAM.
Launch terminality shares the closer capacity classifier, including
operator triage and reaped statuses; terminal rekey-successor ancestry releases
obsolete source records. Unreadable, corrupt or missing launch evidence holds
dispatch and pages SEV1 after six consecutive uncertain ticks. Ownership probes
use PR-filtered settled directory listings and the coexistence timeout, with
synchronous ledger subprocesses bounded by the remaining probe budget.
Two settled attempts per head exhaust into one durable SEV1 page with bounded
reason, stop, round and last-attempt summaries. Explicit pre-launch live-owner
refusals and `gate-read-failed` refund their reservation. Cancellation before
dispatch starts also refunds. Exceptions after dispatch starts, including
operation timeouts, transient GitHub errors and aborts, preserve the charged
reservation until durable launch evidence resolves admission. An interrupted
outcome-unknown reservation is reconciled
against same-head launch identity plus `dispatchedAt` or `lastAttemptedAt`
evidence before the live-owner return or another attempt. Receipt comparisons
accept the reservation's whole second, including receipts retained by later
`no-dispatch` writes; uncertainty never authorizes a duplicate. Page enqueue
failures are persisted and retried without
throwing out of coexistence. State and a nonblocking process lock live under
`data/follow-up-jobs/orphan-watchdog`; restarts preserve budgets and page guards.
Filesystem, flock, SQLite and malformed-evidence failures are caught, logged and
paged as `ama.orphan_recovery.store-error`, returning `ama-pending` with
`skipMergeAgent: true` even on ineligible ticks that open an existing store.
Pager failure is logged and retains that hold. Store-error and ownership-uncertain
pages use deterministic repo/PR/head outbox IDs, including across guard-write
crashes. Empty head observations do not create rows or reset other heads.
Eligible orphan observations take precedence over ordinary automated recovery
and comment-only CI handling throughout the grace period and after exhaustion.
The exhausted head stays held for operator action; a new head gets its own
budget, while returning to an old head preserves its budget. Scoped operator
merge-agent fallback still precedes the watchdog.
Orphan admission widens covered primary-repair/closer-head routing after the
ownerless grace, but pending-CI-only misses keep the mechanical validate-and-click
closer instead of a terminal-remediation HAM. Recovery dispatch runs inline even
when ordinary HAM dispatch uses the background queue, so its result can be
accounted for. Unsettled background queue results are neutral watchdog
observations and preserve the eligible tick streak. See
[data-model/orphan-watchdog.md](data-model/orphan-watchdog.md), the legacy
[refusal store](data-model/ham-primary-change-refusals.md) (no production writer),
and [data-model/ham-finding-disputes.md](data-model/ham-finding-disputes.md).

### FSR-06B: fleet-self-repair re-review requests for a trailer-only head move

`stale-review-head` on a head that moved by **trailer-only commits** (an empty
branch diff after the reviewed head — agent-os#6059's residual class) is
cleared by automation, not by a `retrigger-review` label: the agent-os
`modules/fleet-self-repair` hourly sweep (`review-head-trailer-only`) flips the
watcher's `posted` row to `pending` with

```
rereview_reason = "FSR-06B: trailer-only head move detected; request fresh adversarial review. reviewed=<sha> live=<sha>"
```

The watcher (`src/fleet-self-repair-rereview.mjs`, consumed in
`pollonce-phases.mjs`) treats that row as a *request*, never as operator
authority:

- It **re-verifies the premise from the daemon clone** — `reviewed` is an
  ancestor of `live`, `git diff --quiet reviewed live` is empty, and `live` is
  the head the tick is processing. Transient local `git` errors are retried with
  bounded backoff before the request fails closed. When the daemon has not
  cached a local checkout for the repo yet, the watcher falls back to
  `gh api repos/<owner>/<repo>/compare/<reviewed>...<live>` and requires the
  compare result to be ahead-only with an empty `files` list. Any exhausted git
  or GitHub compare error, missing object, or missing compare data is "not
  verified" (a failed diff read is never an empty diff).
- A **verified** request spawns the re-review past the remediation-round budget
  suppression and the hard review / attempt ceilings (log lines
  `FSR-06B re-review request … verified`, `reviewer spawn ALLOWED … past …`).
  It never lifts the review-cycle cap and never re-reviews a terminal closer
  head (a trailer-only closer head is already merge-covered by
  `non_reviewable_head_delta`).
- A request the watcher will not spawn is **declined** (log
  `FSR-06B re-review request DECLINED … <reason>`): the row is restored to
  `posted` with `rereview_reason = "FSR-06B declined: <reason>; reviewed=<sha>
  live=<sha>"`, so merge authority keeps the existing verdict and the next
  sweep escalates the PR to an operator instead of re-requesting every hour.
  A `pending` FSR-06B row is therefore always either spawned or declined within
  the tick that reads it.
- A request whose `live` head is no longer the PR head is stale: ordinary
  policy applies and the row is left as it is (a moved head owes its own
  review).

Operator recovery for a declined PR is unchanged: `retrigger-review
--exact-head-now` or a current-head `operator-approved` label.

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
   accompanying `verdict-not-settled-success`, or for a zero-finding `Comment
   only` verdict whose sole remaining refusal reason is
   `verdict-not-settled-success`, the closer may waive those reasons on an
   active HAM session only after the predicate verifies current-head HAM authority
   from trusted inputs: HAM worker trailers, reviewed-parent/current-head match,
   non-empty verified diff, allowlisted audit-comment author, matching
   audit-comment body, and doc-currency evidence. The zero-finding path is
   admitted only after the caller supplies a finite measured terminal-unmerged
   duration that meets the comment-only grace threshold. This active trust is
   intentionally narrower than strict `.ok`: it does not require the finding-count
   trailer to match the current non-blocking set, but `Request changes`, blocking
   findings, stale review heads, and unknown/pending remediation state still
   require strict `.ok` validation or a current-head operator override.
2. **Current-head `operator-approved`** — the operator accepts the standing
   non-blocking findings as-is.

This is deliberate (the operator directive is "remediate non-blocking findings
before close, not just blocking"). The cost is lower *direct*-close throughput
and a hard dependency on the HAM remediation path being healthy. Operators who
want the prior behavior (direct-close on `Comment only` regardless of
non-blocking findings) can set `strict_non_blocking_remediation: false` in
`config.local.yaml`; the gate then reverts to blocking-only.

### Lifecycle settlement

Lifecycle sync settles a live closer lease as `succeeded` when a merged PR's
head matches the lease head or its recorded prior heads; it never cancels HQ
for a merged PR. A foreign-head merged lease remains held for the closer's
post-merge work; the dispatch-record stale-window reaper does not release
leases, so a closer that never finishes may require operator reconciliation.
For a closed PR, lifecycle sync persists a closer-cancel
obligation before marking the PR terminal. The watcher drains at most three
obligations per tick, with one-minute spacing and five attempts per obligation.
HQ cancellation is outside the lifecycle mark. A definitive unknown HQ id or
expired pending launch settles the lease as `pr-closed-externally`; exhausted
HQ retries remain visible in `data/ama-closer-cancels/` and emit an alert.
A pending lease without a launch ID waits for its launch expiry without
spending the HQ failure budget.

### `active-remediation-job` skip

A pending or active same-PR remediation job owns the branch, so AMA defers
before writing its append-only audit attempt, prompt, or dispatch record.
A second check after lease acquisition closes the claim race and restores the
retry count because no closer launched.

### `lease-held` skip

Another watcher tick already dispatched a closer for this `(repo,
prNumber, headSha)`. **Not an error.** The existing lease file at
`data/ama-closer-leases/<repo>-pr-<n>-<head>.json` carries the original
launch request id after `hq dispatch` returns. While the owning watcher is
still inside the `hq dispatch` launch window, the lease can remain
`status: "pending"` with no `lrqId`; this is still live duplicate-dispatch
protection and must not be hand-deleted. Once `lrqId` is present, check
`hq dispatch status <lrqId>` if you want to know the closer's live state.

A closer that moves the head it already owns rekeys the lease to the new
head, records the direct source in `rekeyedFromHeadSha`, and carries the full
ancestry in `supersededHeads`. If the process is interrupted after writing the
destination but before deleting the source, that provenance is the recovery
proof: the old source lease is obsolete even if the destination has since
progressed to another owner or a terminal outcome. A terminal destination is
cleanup-only: the stale source is removed, but the retrying worker is told it
does not hold an active lease. Lease discovery ignores any lease whose
`headSha` appears in another matching lease's superseded-head ancestry, then
chooses the most recently updated remaining non-terminal lease. This prevents
orphaned pre-rekey ancestors from poisoning the watcher after chained rebases
or after the current head has already completed.

### Merge gate lease visibility

HAM's versioned `hammer-publish` phase takes the audit finding bullets from
`HAM_AUDIT_DETAILS_FILE`, decimal remediation counts from
`HAM_AUDIT_REMEDIATED_TOTAL`, `HAM_AUDIT_REMEDIATED_BLOCKING`, and
`HAM_AUDIT_REMEDIATED_NON_BLOCKING`, and a test summary from
`HAM_FAILING_TESTS_FIXED`. Supply these before rendering the helper. A successful
post or refresh sets `HAM_PUBLISHED_AUDIT_HEAD` to the head that the audit names.
The `hammer-merge` phase requires that marker and an owned, run-scoped `HAM_VERDICT_FILE` produced after audit publish by a successful `ama-check` call. The caller sets `HAM_VERDICT_READY_FILE` to the same path only after that call succeeds and removes the file after merge. The verdict must have
`eligible: true` and a matching current head before reading GitHub's required
check gate or attempting merge. A missing prerequisite appends a
`failed-without-merge` terminal audit. Publish and merge failures release the
base merge lease, including failures after GitHub confirms the merge; the AMA
closer lease is separate and remains available for recovery.

The base-branch merge gate uses `data/merge-leases/<repo>__<base>.json` plus
durable waiter and attempt files. Use
`node bin/merge-lease.mjs status --repo <owner/name> --base <branch>` to inspect
the current holder, FIFO waiters, ages, and per-PR attempt counts. If the holder
PR has already merged/closed, or the holder process is dead/stale, run
`node bin/merge-lease.mjs reconcile --repo <owner/name> --base <branch>`; this
only removes the lease file through the holder identity fence and does not kill
processes or change verdicts. A normal holder release leaves its gate-attempt
record in place. `release --retryable-abort <reason>` and an acquire timeout
refund the provisional attempt instead: `attempts` decreases by one and
`retryable` increases by one for that PR/head. A timeout still returns `75`
with `{"timedOut":true}` if its refund fails; `refundFailed:true` in the JSON
and a stderr warning identify the charged attempt for operator inspection.
Use `reset-attempts` with that repo, base, PR, and head to clear its counters
after resolving the cause; reset checks for a current holder before clearing
the record. Because holder acquisition uses its own atomic file operation, this
check is best effort if acquisition races the reset.
`classify` reports
whether a mergeability, required-check, or protection-read failure qualifies
for a retryable refund. On a remote-CI timeout, the hammer passes the gate's
structured check states to `classify`; it refunds only when pending or queued
checks remain and none are red. A red check or unrecognized gate state leaves
the attempt charged. When `acquire` parks a head at the cap, the hammer writes
the returned `closingStatus` (attempt and retryable counts plus the exact
`reset-attempts` command) to stderr, the terminal audit, and its PR closing
comment. The green-check sentence describes the fresh pre-acquire snapshot for
the same head, not a later live gate result.
Attempt records older than 30 days are pruned
during new attempt recording. The cap applies to charged `attempts`, not the
`retryable` count. Contention timeouts are bounded by the outer hammer lifetime
retry cap, not by this gate-attempt cap. When a PR exceeds `AMG_MAX_GATE_ATTEMPTS`
(default `5`), `acquire` exits `70` with `{"parked":true}` so the caller should
park it for operator review instead of re-queueing. The hammer terminal closer
also treats an acquire wait timeout (`75` with `{"timedOut":true}`) as an
intentional AMG-04 park and exits successfully after logging the waited seconds,
so a contended base does not churn through repeated long retry windows. Other
non-zero acquire exits remain hard failures; inspect their CLI output and stderr.

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

### AMAFIND-01: automated recovery and safety holds

The watcher routes AMA ineligibility through `src/ama/automated-recovery.mjs`
for both posted reviews and reviewer-timeout exhaustion. The timeout-exhaustion
handoff uses the live candidate's labels for scoped fallback and hard skips,
rather than the earlier discovery snapshot: a newly applied request is eligible
for scope validation, a removed request grants no override, and newly applied
hard-stop labels retain ownership. Ordinary AMA safety gates still apply.
A stale review requests one current-head re-review through the review-state CAS.
Missing findings sections request a re-review once per head; a subsequent malformed review may
retry the closer, subject to its ordinary terminal-remediation gates. A
strict-mode comment-only review with standing non-blocking findings reaches the
hammer after the existing terminal grace, proven final-round resume, or cycle
exhaustion admits it. The shared kernel findings parser supplies both
eligibility counts and the attestation's total blocking plus non-blocking count.

Recovery retries re-enter the ordinary closer gates and leases. They authorize
remediation dispatch, never a merge waiver. Hard-stop labels, risk policy,
security holds and destructive-change safety holds still require adjudication.
Recovery only widens worker-class admission; it never bypasses mechanical
pending-CI routing, actionable-reason checks or Codex-first ownership. Refusals
containing `remediation-pending`, `remediation-state-unknown` or
`blocking-findings-present` wait for the follow-up lane without spending recovery
attempts or paging. The ordinary closer remains responsible for admitting an
exhausted Request-changes cycle after remediation ownership is released and
completed-remediation evidence is satisfied.
Missing identity or safety evidence remains fail-closed and retries automatically.
A live closed or merged candidate never starts recovery.

Launch recovery uses the existing closer liveness predicates and ledger adapter
(the AMACAP-01 accounting seam). Proven terminal or phantom launches release
ownership; live launches and failed ledger reads are never reclaimed.

Recovery state is durable under `data/follow-up-jobs/ama-automated-recovery/`,
keyed by repo, PR and head, and protected by a crash-releasing kernel flock.
The action cap follows `amaRetainLoopCapFor(dispatchJob.remediationPlan.maxRounds)`.
Only confirmed dispatches, triggered re-reviews, and non-cancellation action
errors spend attempts. Active hammers/remediators, background launches, lease
contention, uncertain dispatch status, comment-only grace, and proven final-round
CI waits return `ama-pending` without consuming the budget. Configuration/draft
refusals and explicit `needsOperator` results retain adjudication without paging.
Abort and coexistence-timeout errors propagate without charging recovery.

A refused action or exhausted action cap must remain non-progressing for 30
minutes (`stuckDeadlineMs`), independent of tick count. Re-review queue states
`pending`, `reviewing`, and `pending-upstream` are exempt from the recovery
re-review deadline; their own stall monitoring owns queue latency. An unchanged
posted snapshot without an active review expires after 30 minutes. At either
non-progress deadline the watcher returns `recovery-exhausted`, persists and logs
`ama.automated_recovery.exhausted` with severity SEV1, reason, PR, head and
attempts, and queues one page with a stable outbox identity. Failed page enqueue
retries without duplicating a successfully queued page. A new head starts a new
recovery budget. The merge kill switch continues to disable execution.
Store fields, lock semantics, retention, and safe reset procedure are documented
in [AMA Automated Recovery](data-model/ama-automated-recovery.md). There is no
automatic pruning of state or stable lock files.

CCX-11 (2026-09-30): `hammer-corp` is an accepted primary/fallback hammer class on
the second Codex OAuth account. It keeps the hammer route and merge-capability
identity. The fallback default remains `[hammer-claude]`; account fallback
selection and activation are governed by credential-capacity-expansion CCX-13.

HAM context emits an under-8192-byte summary; use `bin/primary-change-context.mjs` for full patches. Commit identity stays local; merge decisions fetch primary evidence lazily and forward cancellation. The hammer in-lease merge re-fetches evidence independently of its claim. Transient evidence errors cannot suppress CI/conflict repair dispatch. Trusted dispatch launch heads can cover untagged repairs; fallback detection accepts only explicit hammer worker-class trailers (hammer, hammer-corp, hammer-claude), never login patterns. Base merges use the first parent only after verifying the second parent belongs to the base ancestry.

Primary evidence readers use an explicit runtime root when supplied, otherwise
`HAM_ROOT_DIR`, otherwise the code checkout. Deployments with a separate runtime
root must set `HAM_ROOT_DIR` for CLI and head-closer processes; the daemon and
rendered hammer lease gate pass their configured root. `ama-check --primary-change`
is required for all calls; an explicit no-HAM evidence result is still required.
Matching dispatch JSON that cannot be parsed is skipped; dispatch I/O errors
defer with `primary-change-read-failed`. The earliest valid launch SHA wins.
Each evaluation reads a compare endpoint once; pre-lease and in-lease evaluations
remain independent to preserve fresh evidence. GitHub compare bounds are fewer
than 250 commits and fewer than 300 files; larger or truncated comparisons remain
structural unknowns. Omitted patches pass only with identical trusted blobs.
A diverged launch without HAM trailers remains unknown: untagged automation
cannot be excluded from that evidence (follow-up LAC-1832). Non-HAM remediation
trailers cannot authorize primary reversals (follow-up LAC-1833). In-place repairs
remain allowed, but preserving author intent takes precedence over those waivers.

### AMACAP-01 / AMASCALE-01 closer launch capacity and reconciliation

`watcher.ama_closer_max_concurrent_launches` remains the configurable floor
(default 3); existing host overrides continue to raise that floor. AMASCALE-01
scales capacity as `clamp(eligible closer backlog, floor, ceiling)`. The repo-owned
`domains/code-pr.json` merge-authority policy sets
`amaCloserConcurrentLaunchCeiling` (default 32) and `closureLagSloMs` (default
1800000). These are domain policy fields, not new shared config.yaml keys;
no changes to the Python or shell strict schemas are needed. The worker-pool
admission gate remains responsible for memory and load back-pressure.

Only requested, leased, starting and running ledger launches consume capacity,
with terminal ledger evidence required before PID absence releases a slot. Parked/blocked decision launches
retain same-PR exclusivity but consume no fleet slots. Terminal launches release
capacity without releasing safety leases or authorizing retries. The backlog
census counts nonterminal closer candidates observed within ten minutes,
including the current candidate. Live launches are compared against this
backlog-derived cap; their count does not raise a successfully observed cap.
The process-wide background dispatch queue scales with its eligible entries to
a fixed ceiling of 32 (while preserving a higher configured host floor).
Each queued run retains its own domain policy, which `maybeDispatchAmaCloser`
checks before launching a worker. The first domain processed cannot set the
shared queue's ceiling.

The daemon clean path runs before hammer capacity, including automated recovery.
No eligible inline merge waits behind `ama-closer-launch-in-progress`.

`ama.closure_lag` emits `eligible_at`, `merged_at`, and `lag_ms` once per PR;
`ama.closure_queue_depth` emits the eligible unmerged queue depth and p95 lag.
Observations persist under the runtime root in `data/ama-closure-lag/`. Lifecycle
sync settles hammer merges from live terminal state, while inline merges settle
at success. A rolling 24-hour p95 includes completed lags and pending eligible
waits. Exceeding the configured SLO or any eligible wait over 60 minutes creates
an automated `ama.closure_lag.slo_breach` SEV1 event naming blocking reasons.
Pages are durable and deduplicated; delivery failures retry, and a recovered p95
can start a new breach episode. PR-specific breach records are removed when
their PR is terminal or no longer present in the state, including undelivered
pages; active PR breaches retain their delivery deduplication. State access uses
asynchronous IO and atomic replacement under a nonblocking advisory lock with
a one-second acquisition budget. Observation failures are logged by callers and
dispatch falls back to the configured floor on census failure. Invalid JSON is quarantined and logged at error level before starting a fresh diagnostic ledger. See the
[closure-lag data model](data-model/ama-closure-lag.md) for fields and retention.
Diagnostics grant no merge authority.

The cap reconciles session-ledger launches within the
existing dispatch-record and lease reclaim windows, plus pending lease-held
dispatches inside the bounded launch window. Terminal
launches immediately stop consuming capacity when the next dispatch scans the
records. Unreadable or missing ledger evidence and dispatching intents hold fleet capacity for the existing bounded pending-launch window, preserving
same-PR ownership under the existing record/lease liveness checks. Live ledger
statuses still obey the age escape for workers that die without a terminal write.
Confirmed missing LRQs expire after the existing pending-launch timeout;
launch-only records with no parseable launch timestamp stay held. Before any
ledger query, the dispatch scan checks identity, record age and lease liveness.
Aged-out records release capacity without a probe or rewrite; historical cleanup
belongs to the CLI. The first unreadable ledger result stops further queries in
that scan, and cancellation is checked between probes. In-flight `dispatching`
intents are never probed or rewritten, because retries may carry a previous LRQ.
New launch writes clear old `terminalLaunchStatus` and `reconciledAt` annotations.
The capacity-only `reaped`/`cancelled` statuses do not expand per-PR retry authority.
Launch completion is not merge success:
reconciliation leaves closer leases and merge leases untouched, and successful
launches retain `unverified-terminal-success` until the normal outcome checks.
Closers can spill to `hammer-claude` through the existing harness fallback (§2a).

Preview the one-time backlog repair, then apply it against the runtime root.
Run both commands as the canonical daemon owner for that root; replace
`<daemon-user>` with the deployed runtime account (for example, `placey` on a
placey-owned host). Verify the account against the daemon configuration and
ownership of the dispatch directory and its existing JSON files first. Do not
assume the interactive operator or HQ owner is also the dispatch-file owner:
atomic replacement creates a file owned by the calling user and can lock out
the daemon when run as another account.

```bash
sudo -A -H -u <daemon-user> node bin/reconcile-ama-closer-dispatches.mjs --root-dir <runtime-root> --hq-root <hq-root> --ledger-target <ledger-target> --dry-run
sudo -A -H -u <daemon-user> node bin/reconcile-ama-closer-dispatches.mjs --root-dir <runtime-root> --hq-root <hq-root> --ledger-target <ledger-target>
```

Pin `<hq-root>` and `<ledger-target>` to the values used by the watcher;
`--ledger-target` accepts a SQLite path/`sqlite://` URI or Postgres DSN.
This avoids environment loss under `sudo -H`. Both commands print the resolved
ledger backend and source (without DSN credentials), plus scanned, terminal,
missing, unreadable, changed, and active counts. Target resolution failure aborts
before rewriting records. Verify the preview's ledger metadata before apply.
Apply preserves original fields, writes `state: launch-terminal`, the
ledger terminal status, and `reconciledAt`; repeated apply makes no further
changes. The normal dispatch capacity scan reconciles only launches still within
the record/lease liveness window; the CLI also visits historical dispatched records.
No cap default or shared CFG schema changes are included in this single-repo fix.

HAM reconciliation safety: apply refuses a caller whose UID differs from the dispatch-directory owner; dry-run is available to other accounts. Missing rows use the latest observation age and are never terminalized when every ledger probe is missing or a scan is unreadable. Each applied rewrite emits `ama_closer.launch_capacity_reconciled` with backend/source metadata only. The scan admits ledger queries for at most one second (an already-started query retains the adapter timeout); subsequent records retain the existing age/lease liveness rules. Concurrent observation changes prevent a stale rewrite, and current terminal evidence is preserved.

HAM closure diagnostics hardening: explicit ineligibility or a new head resets the eligible wait and removes stale PR pages; reopened candidates start fresh. Unchanged observations skip durable writes, redundant recovery observations are omitted, and recovery reuses the first daemon result unless deferred. SEV1 payloads keep the five longest pending and completed waits with omitted counts; page text is capped at 3500 characters. Process startup warns when the configured max acts as a floor below the adaptive ceiling.

### HAMINTENT-02 final-review recovery contracts

Reversal authority follows the parsed blocking verdict, including COMMENTED or
DISMISSED REST reviews with an unchanged blocking body. The cited review must
remain the latest authoritative review in the HAM parent ancestry; a later
withdrawal revokes it. Reviews are read once per evaluation. An unreadable or
capped citation refuses only its waiver; transient reads defer the entire check.

The dispute CLI refuses an owner mismatch with exit 78 before SQLite opens.
Non-HAM posted comment provenance exits 79 after refunding its reservation.
The prompt preserves
evidence and records no-merge handoff to the canonical owner for these refusals.
It does not automatically switch accounts or tokens. A non-triggered re-review
restores previous admitted provenance; a thrown request also refunds its budget.
Refusal paging releases its reserved guard after failed enqueue and retries on
the next observation. Successful enqueue keeps the guard across restarts.

### Dispute recovery and owner routing

Hammer workers can run under a different UID than the canonical daemon. The
prompt resolves the database owner and runs the dispute CLI through the existing
`sudo -A -H -u <owner>` boundary, passing only the entitled HAM GitHub credential.
The evidence file must be readable by that owner. An unavailable owner wrapper
fails closed before database writes; do not change database ownership.

Dispute and reversal accept authoritative CHANGES_REQUESTED, COMMENTED,
DISMISSED and APPROVED reviews whose body parses as request-changes. An operator
withdrawal must publish a newer authoritative review with the finding removed:
dismissal alone does not withdraw the blocking body. The latest authoritative
review in ancestry supersedes prior findings for both paths.

Requests interrupted by the CLI alarm are reclaimable after five minutes.
Pending/in-flight review CAS results retain the freshly posted evidence.
Exhaustion enqueue claims are retried after crashes with deterministic alert
IDs; terminal outbox entries also prevent duplicate pages.

### HELDHEAD-01: unproven comment-only final-round pushes

A terminal final round whose replay proof failed records the withheld head.
When that head is still current and has no live review or closer owner, watcher
admission queues one exact-head review and audits its intent on the terminal job.
A file intent is not proof of a committed SQLite reset: admission reuses its
original `requestedAt` until the row confirms that request on the withheld head
or an exact-head reviewer. Request exceptions and commit rollbacks remain
retryable; missing terminal files or an absent archive defer the lookup. Once
armed, recovery cannot reset again. Legacy posted or pending exact-head reviews
are preserved. Only failures terminal under normal retry policy page, with a
dedicated `withheld-head-review-failed` reason and alert-delivery debounce; no
job-file `alertedAt` is committed before delivery. Shared writer/archive locking
and fresh reads protect job updates; recovery errors are isolated per subject.
The fresh verdict feeds normal AMA/hammer closure. A moved head stays held for
that recovery, and a failed bounded review pages once through operator-blocked.
Pending CI alone is work-complete; unprobed withheld-head CI is recorded as
`reported-pending`. The proven-head CI wait remains unchanged.

HAM finding authority is scoped per reviewer family on the same reviewed head. An authoritative review from any family on a newer descendant head supersedes older-head citations. Finding disputes use the same freshness rule and request the cited reviewer family. The hammer prompt includes the effective strict non-blocking policy; ama-check and the in-lease gate resolve module config and code-pr domain policy with the same precedence as daemon closure.


### Orphan watchdog evidence boundaries

Stale-only observations prove closer-authored identity before probing ownership;
ordinary externally pushed stale heads fall through to exact-head review recovery.
Unreadable queue files hold only the PR identified by their filename prefix;
repository matching is case-insensitive. Historical missing ledger rows expire
at the closer pending-lease reclaim age, except while reconciling a reservation.
Ledger probes use the dispatch record's HQ root and cache immutable terminal
results (up to 1,000 entries). Identity and re-review request errors retain a
pending hold without consuming the store-error alert slot. Uncovered or persistently
owned primary-change refusals page after six observations, without authorizing
HAM dispatch. Reservations persist the expected dispatch-record head so reviewed
head receipts cannot refund an already launched attempt.
### LEASEPARK-01: certified-head contention queue

Lease acquisition timeouts and pending-required-check deferrals are written as
`deferred` AMA audit attempts, keyed by the full certified head. The closer
resumes a validated HAM head through the existing daemon merge predicate rather
than launching remediation again only while verdict misses are limited to pending
CI. Structural policy holds and operator-required refusals remain authoritative;
red CI or conflicts route back to hammer remediation. A pending-check timeout
is deferred only when pending CI is the sole live gate miss; conflicts, strict
BEHIND, closed PRs and labels retain a failed-without-merge audit. Required checks,
primary-change, exact-head,
protective predecessors, branch protection and the autonomous execution switch
remain mandatory, including the live read inside the lease. Moving the head
invalidates the certification and removes the old audit from the active queue.
The park must have a matching existing dispatch record and an audit timestamp
at least as recent as that launch's `dispatchedAt`; stale or unanchored parks
retain the operator hold for terminal dispatches; an active repair hammer follows the normal retain path. Certified
merge resumes also require a readable retry ledger for the reviewed-head series
and a recorded launch ID; a missing launch ID retains the operator hold.
Missing, corrupt or mismatched ledgers return
`hammer-deferral-ledger-unavailable` with `needsOperator: true` before any merge
attempt, so the bounded queue cannot silently turn into indefinite retries.

Each observed deferred launch refunds the series and matching target failure
counters exactly once, deduped against ordinary retry refunds. Lifetime refunds
are limited to twelve across the entire PR by `lifetimeDeferralRefundCount`,
which survives fresh reviews; legacy ledgers without proven refund usage get no
new lifetime refunds until operator reconciliation. The separate series launch
history expires at twelve deferrals or six hours, with exponential backoff
starting at two minutes and capped at thirty minutes. Within the lifetime refund
budget, contention does not trigger retry-cap paging; after it is spent, the
normal lifetime ceiling remains enforced. An expired queue
returns `hammer-deferral-budget-exhausted` for operator handling.

The lease CLI maintains FIFO waiters and respects the caller's explicit `--wait`
window, including with `--wait-for-holder-deadline`; it never extends the worker's
command budget. Zero-wait callers return immediately. Hammer releases its lease
before sleeping on remote CI without refunding the acquisition, so a subsequent
red-CI outcome remains charged to the gate-attempt cap. Pending-only terminal
deferrals may still refund a held acquisition. Each successful acquire clears
previous retryable-abort state. Pre-acquire and park-state GitHub reads retry
transient failures three times using the full stderr; exhausted transient
post-CI reads record a deferred lease-timeout audit. Permanent failures stay fatal.
Certified parks with pending CI skip daemon merge until the metadata checks settle.
Queue bounds and backoff use `evaluateHammerDeferralQueue`; missing or invalid
start timestamps expire the queue. Park audits are read only on certified HAM
routes; an unreadable audit explicitly requires operator recovery.
After reacquisition it re-runs the fail-closed changed-file overlap guard from
verify-head against the live base before the final fresh exact-head gate. The
comparison starts at the merge-base of the exact CI-validated head and fetched
live base, rather than the older parallel-phase validation base. This recomputes
the incorporated base even when the earlier validation base is unavailable. Base
changes overlapping PR files require rebase and revalidation even without a
strict branch-protection rule; disjoint movement may proceed under that rule.

IDENTBASE-01 merge-agent rebases with a worker author remain reviewable. Do not
assume a per-head review ceiling bounds repeated new rebase heads: the combined
lifetime accounting needs the offline cycle regression tracked in LAC-1849.
Local-first trailer suppression still lacks authenticated linked identity;
source-aware stale-head resume verification is tracked in LAC-1848.
## CIUNKNOWN-01: cancelled checks and no-CI bootstrap

When the current open head's only non-green external checks are cancelled, the
watcher verifies the workflow run's head and requests `rerun-failed-jobs`. Durable
reservations under `dispatch/ci-recovery/` cap each check/head at one request and
deduplicate checks belonging to the same workflow. The original cancelled attempt
is treated as pending; a later cancelled attempt raises one operator decision.
Failures and pending/missing checks never enter this recovery path.

An empty rollup still means unknown. No-CI bootstrap additionally queries the
repository's workflow inventory, base branch, classic protection when applicable,
and effective ruleset rules. Unreadable APIs, configured required contexts, or a
pending adversarial status cannot authorize bootstrap. Green managed pre-push
evidence must match the repository and full head SHA: GitHub hosting accepts the
owner-controlled local sidecar, while full-mirror hosting requires the deploy-owned
CI runner public key and a valid Ed25519 signature. Budget-deferred evidence is
never green for bootstrap. Without evidence, the watcher pages once with
`repo has no CI`.

A settled zero-finding review stays on the merge path, including when CI is
unknown; it does not dispatch HAM. The daemon and merge-agent bootstrap paths
preserve current-head review or HAM certification, safety-core, protection,
lease, and autonomous execution gates. Each merge attempt refreshes the proof;
`bin/ci-bootstrap.mjs --repo OWNER/REPO --pr NUMBER --head SHA` provides the
merge-agent's immediate pre-merge verification. Audits flag
`ciMode: no-ci-bootstrap`.

Repository stand-up should provision a minimal CI workflow (agent-os
STANDUPCI-01). This repository only handles the existing zero-CI gap; provisioning
is follow-up work in agent-os.
