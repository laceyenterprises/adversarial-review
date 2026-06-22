# SPEC - Adversarial Review Auto-Remediation

_Status: Living contract_
_Related: `SPEC.md`, `docs/follow-up-runbook.md`_

For the AMA closer lane documented in [`docs/RUNBOOK-ama-closure.md`](docs/RUNBOOK-ama-closure.md),
the operator-facing contract is that closure dispatch uses the configured
`roles.adversarial.merge_authority.worker_class`, not a hardcoded `codex`
worker. Supported closer worker classes are `codex`, `claude-code`, `hammer`,
and `gemini`. Validation examples and cutover checks must therefore substitute
the configured worker class and verify the dispatched `workerClass` against
that config value; for the Gemini harness this means validating an
`hq dispatch --worker-class gemini --task-kind merge --completion-shape decision-only`
launch and the generic provenance trailer
`Closed-By: gemini-closer (adversarial-pipe-mode)`. HAM terminal-remediation
is the exception to the generic suffix rule: its remediation commit uses
`Closed-By: hammer (adversarial-pipe-mode)` exactly, per the HAM predicate
contract. The AMA eligibility predicate trusts active HAM terminal remediation
without full `.ok` finding-count provenance only after it independently verifies
the HAM worker trailers, reviewed-parent/current-head match, non-empty verified
diff, allowlisted audit-comment author, matching audit-comment body, and
doc-currency evidence. That active lane is limited to strict non-blocking
remediation: a settled-success-family verdict whose remaining refusal reasons are
`non-blocking-findings-present` or `non-blocking-findings-unknown`, plus the
accompanying `verdict-not-settled-success`. A bare
`verdict-not-settled-success`, a `Request changes` verdict, blocking-finding
reasons, stale-head reasons, and remediation-state reasons still require
validated HAM evidence (`ham_terminal_remediation_validated`) or a current-head
operator override.

AMA closer dispatch must also declare the workspace repo set required by the
closer prompt. The PR repository is always passed as the primary `--repo`. When
that repo basename is not `agent-os`, the dispatch must additionally include
`agent-os` in the workspace repo set, e.g. via `--additional-repo agent-os`,
because the closer prompt runs the Agent OS AMA tooling and writes its audit
under `$HQ_ROOT`. When the PR repository is already `agent-os`, the closer must
not add a duplicate `agent-os` workspace entry; the primary repo already grants
the required scope. Cutover validation must inspect the launch contract's
`workspaceRepos` (or equivalent `hq dispatch status` field) for both cases.

AMA closer convergence is authoritative only when the session ledger has a
`build_completions` row for the PR with `signal_kind='merged'`.
`hq dispatch status=succeeded` and the AMA §4.4 audit JSON's
`status:"succeeded"` are not enough by themselves: without the merged signal the
watcher records the existing terminal success as `unverified-terminal-success`,
releases the old terminal hold, and may re-dispatch the closer within the normal
bounded retry policy. That release is allowed only after a clean negative ledger
read (`missing-build-completion-signal`) plus repo-level evidence that the
merged-signal producer is active for this repository. If the ledger target is
missing, the `build_completions` surface is unavailable, the repo has no merged
producer evidence, `psql`/SQLite fails, or any other read error occurs, the
watcher retains the existing closer hold for that tick and does not spawn a
replacement closer. The merged-signal lookup is intentionally scoped to
`repo`/`pr_number`/`signal_kind`, not to the closer's reviewed head SHA: current
Agent OS merge capture stores the merge commit in `build_completions.head_sha`,
while the closer's `--match-head-commit <reviewedSha>` guard uses the PR head.
The producer SHA is evidence returned to operators, not an equality gate.

The merged-signal producer is outside this repository's write path: watcher
lifecycle sync records owed
`hq dag autowalk-on-merge --repo <repo> --pr <n>` work when it observes a PR
merge, and Agent OS owns the session-ledger `build_completions` write behind
that handoff. Deployments where the `build_completions` table itself is not
readable retain the old terminal hold semantics rather than treating an unknown
ledger state as proof the PR was not merged. A table that is readable but has no
repo-level merged producer evidence also retains the old hold semantics; this
keeps a schema-only rollout from looking like a clean negative.

AMA's §4.2 branch-protection gate is enabled by default:
`roles.adversarial.merge_authority.branch_protection.required` defaults to
`true`, and the target branch must require the resolved adversarial-gate
context (`resolveGateStatusContext()`, default `agent-os/adversarial-gate`).
Operators may set `branch_protection.required: false` only for repositories on
GitHub plans where branch protection is unavailable and the protection API
returns the known upgrade/forbidden response. The closer must preserve that
unavailable-plan evidence; `{ "branchProtectionUnavailable": true, "reason":
"github_plan" }` is one accepted shape, but any parsed unavailable/404 payload
is sufficient when the operator has explicitly waived the gate. Other
protection-fetch failures are hard stops, not waiver inputs. That opt-out waives only the
branch-protection-required-context predicate; review verdict, blocking-finding
state, risk class, CI, hard-stop labels, mergeability, remediation state, and
the closer's `--match-head-commit <reviewedSha>` guard still apply.

Closer rechecks accept any successfully parsed protection JSON when
`branch_protection.required=false`; malformed or unreadable input is still a
hard input error. With the default requirement enabled, the GitHub-plan
sentinel is a hard input error, and an ordinary empty protection snapshot fails the
branch-protection gate closed with `branch-protection-missing-gate`.
Audit/provenance strings must distinguish the two successful cases:
`configured_gate_context_required` means branch protection actually required
the configured gate, while `branch_protection_requirement_waived` means the
explicit no-branch-protection plan opt-out satisfied §4.2 #9.

AMA risk-class configuration accepts `low`, `medium`, `high`, and `critical`.

**Risk-class resolution (eligibility).** AMA resolves the PR's risk class in this
precedence: (1) an explicit class on the merge-agent candidate, (2) the review
row's `risk_class`, (3) the remediation ledger's `latestRiskClass`
(`summarizePRRemediationLedger`), which resolves the PR's ticket class and falls
back to `DEFAULT_RISK_CLASS` (`medium`) when no remediation job recorded a class,
and finally (4) `unknown`. This is the **same** risk class the round-budget path
(§4.2a) consumes, so eligibility and round-budget can never disagree on a PR's
class. Because the ledger default is `medium`, a PR carrying no explicit ticket
classification is treated as `medium` for eligibility — NOT `unknown` — and is
therefore auto-closeable under an operator `risk_classes` allowlist that includes
`medium`. A PR resolves to `unknown` only when the ledger probe itself is
unavailable (e.g. it throws), in which case the risk gate keeps it fail-closed.

`unknown` / unclassified risk (per the resolution above) is never a configured
single-key class and always fails closed unless the explicit two-key override is
present. By default,
`roles.adversarial.merge_authority.eligibility.high_risk_requires_two_key` is
`true`, so `high` and `critical` still require both current-head
`adversarial-merge-requested` evidence and current-head `operator-approved`
evidence. Operators may set that key to `false` when AMA is intended to be the
single merge authority for every known risk class: in that mode, `high` and
`critical` close on `risk_classes` membership alone, exactly like `low` and
`medium`. The risk-class allowlist remains load-bearing; final-hammer review
cycle exhaustion must not make a `high` or `critical` PR eligible when that
class is absent from `risk_classes`.

### AMA current-head review reconciliation

AMA review authority is resolved from the same durable source as the
adversarial gate: the latest current-head follow-up job review body when one
exists, otherwise the posted `reviewed_prs` row body. That stored source is not
enough by itself when it resolves to settled success (`Comment only` or
`Approved`), because a completed remediation job can retain an older
comment-only body after a later adversarial review posts `Request changes` on
the same commit.

When the stored source is settled success and there is no pending remediation,
the watcher must reconcile it against live GitHub PR reviews on the current
head before dispatching the closer. Live reconciliation is scoped to submitted
reviews whose `commit_id` equals the current head SHA, whose state is one of
`APPROVED`, `CHANGES_REQUESTED`, or `COMMENTED`, and whose author login is in
the authoritative reviewer-login set resolved from `reviewed_prs.reviewer`.
The stored `reviewer` value is the reviewer model/family or supported
builder-tag alias, not a GitHub login. AMA resolves that value through the
canonical GitHub-PR reviewer routing tables before applying the anti-spoof
author filter. Known Claude-authority values (`claude`, `claude-code`, and
`clio-agent`) accept the canonical GitHub App author
`lacey-claude-reviewer[bot]` plus the legacy PAT-backed
`claude-reviewer-lacey` alias. Known Codex-authority values (`codex`, `gemini`,
`pi`, `opencode`, and `hermes`) accept the canonical GitHub App author
`lacey-codex-reviewer[bot]` plus the legacy PAT-backed
`codex-reviewer-lacey` alias. Native Gemini reviewer capture accepts
`lacey-gemini-reviewer[bot]` plus legacy `gemini-reviewer-lacey`. For REST PR
reviews posted by GitHub Apps, AMA normalizes the GitHub-reserved `[bot]` suffix
off the review author login before checking membership in this authoritative
set, so `lacey-codex-reviewer[bot]` matches `lacey-codex-reviewer` while
unrelated App bots still fail the anti-spoof check. Unknown or missing reviewer
models resolve to an empty authoritative set and fail closed rather than
trusting any live review body. Reviews from operators, unrelated bots, or
missing/unknown authors are not merge authority even if they contain a
structured `## Verdict` section.

The precedence is:

1. Active or queued remediation remains not settled and blocks ordinary AMA
   eligibility.
2. If the stored current-head source is not settled success, the stored verdict
   stands and no live lookup is needed.
3. If the stored current-head source is settled success, the newest submitted
   live review from the authoritative adversarial reviewer on that same head
   replaces the stored verdict. That exact body is authoritative even when its
   `## Verdict` section is malformed, ambiguous, or missing.
4. If the reviewer model cannot be mapped to authoritative GitHub login(s), or
   no authoritative same-head review is found, or the newest authoritative
   same-head review has no normalizable verdict, AMA fails closed with an empty
   review verdict rather than trusting stale stored success.
   Transient live-lookup failures from the watcher-side GitHub CLI path, such
   as timeouts, TLS/socket interruptions, HTTP 429, or HTTP 502/503/504, are
   retried with a small bounded budget before this fail-closed decision;
   non-transient lookup failures fail closed immediately.

This reconciliation is deliberately not an author-agnostic "latest review wins"
rule. A newer `Comment only` review by an operator or unrelated automation must
not override an authoritative adversarial `Request changes` review on the same
head.

### §4.2a — AMA final hammer (review-cycle exhaustion)

AMA is the **final merge authority at the end of the review cycle**, by operator
directive (2026-06-14): a PR must not loop on `Request changes` forever. The
review-cycle is **exhausted** once the PR has consumed its full remediation
round budget — `completedRoundsForPR >= roundBudget` (the same budget
`evaluateRoundBudgetForReview` resolves: the risk-class default, raised by any
persisted higher `maxRounds`). The watcher computes this signal
(`reviewState.reviewCycleExhausted`) at AMA dispatch time only as an eligibility
precheck and audit observation. The closer's `ama-check` invocation must
recompute exhaustion at merge time from the durable follow-up ledger for the
current repo/PR before applying any waiver, using the same effective budget
resolution. Any probe error, missing repo identity, or ledger read failure fails
safe by treating the cycle as NOT exhausted (normal strict gates apply).

When the cycle is exhausted, the eligibility predicate may waive the soft,
convergence-dependent gates so AMA can land the PR:

- `verdict-not-settled-success` and `blocking-findings-present` /
  `blocking-findings-unknown` only when a current-head `operator-approved`
  override is present. The `adversarial-merge-requested` label is not merge
  authority for verdict or blocking-finding gates; it is scoped to the
  risk-class decision below.
- `remediation-pending` / `remediation-state-unknown`
- `branch-protection-missing-gate` (the structural gate this GitHub plan can't
  provide — the historical reason AMA closed zero PRs)
- `risk-class-not-permitted` only for low/medium allowlist misses when a
  current-head `adversarial-merge-requested` request is present. High/critical
  allowlist misses are never waived; when high/critical are configured for
  single-key AMA closure, the class must already be present in `risk_classes`.

Exhaustion **never waives the hard safety gates** — these still block AMA even at
cycle-end: PR open / non-draft / **mergeable**; **head-match** to the reviewed
head (AMA still pins `--match-head-commit <reviewedSha>` at merge); **CI green**;
**hard-stop labels** (including head-scoped `adversarial-merge-blocked`);
fast-merge state; AMA enabled; the **two-key override for unknown risk**; and the
configured high/critical risk contract described above.

A PR that converges normally (settled-success `Comment only` / `Approved` with no
standing blocking findings) merges via the ordinary path and never reaches this
waiver — only a PR that burned its entire remediation budget without converging
is force-landed. The §4.4 audit records `trace.finalHammer.{active,waived}` so
every waiver is attributable.

## Kernel Contract Surface

`src/kernel/contracts.d.ts` defines the target kernel contract surface for
the review/remediation boundary. Today only the verdict, remediation-reply,
and prompt-stage shapes are bound directly from runtime `.mjs` modules via
JSDoc; the adapter interfaces remain the intended steady-state shape for the
in-flight kernel split and are exercised by `test/fixtures/kernel/contracts-check.ts`.

This split is intentional. When the runtime grows a concrete kernel adapter
boundary, those modules should bind to these interfaces rather than fork new
shapes. Until then, updates to the declaration file must keep the fixture and
the runtime-bound JSDoc consumers in sync.

## Optional GitHub Adapter

The GitHub-PR domain may prefer a local `github-adapter` binary for GitHub
lookups and selected GitHub mutations during review and remediation
orchestration. The integration is rollout-safe: adapter reads are
opportunistic, and failures or missing binaries must fall back to the existing
`gh` or Octokit path for the same lookup. Adapter writes are likewise optional
for the supported mutation kinds listed below; absence of the adapter must
preserve the historical `gh` behavior.

`src/github-adapter-client.mjs` resolves the binary in this order:

1. `GHA_ADAPTER_BIN`
2. `AGENT_OS_GITHUB_ADAPTER_BIN`
3. `<repo-root>/modules/github-adapter/bin/github-adapter`
4. `<repo-root>/../modules/github-adapter/bin/github-adapter`
5. `<repo-root>/../../modules/github-adapter/bin/github-adapter`

The third through fifth entries are auto-discovery candidates. Auto-discovery
must only select a binary under one of those trusted `modules/github-adapter`
roots, and the selected file must be a regular executable that is not
group/world-writable before the watcher passes GitHub credentials to it.
Explicit environment overrides are operator-controlled escape hatches.

If none of those paths resolves, the adapter is treated as absent. When the
adapter is present it is invoked with the caller's GitHub/OAuth environment
(`GH_TOKEN`, `GITHUB_TOKEN`, host, proxy, certificate, and basic process env
needed by the binary); `GITHUB_TOKEN` is copied to `GH_TOKEN` only when
`GH_TOKEN` is unset. The adapter currently covers pull-request rollups, review
contexts, head/state reads, review bodies for a head SHA, label events, issue
comments, open PR discovery, single-PR snapshots, and PR diffs. Each read call site
must preserve the fallback behavior independently, because the adapter is an
optional preferred read source rather than the authoritative availability gate.
Adapter-absent reads must not emit synthetic adapter telemetry or consume a
second throttle wait before falling through to the existing GitHub client path.

Adapter writes currently cover issue comments, commit statuses, pull-request
reviews, pull-request label add/remove, and pull-request merge. Write calls use
the same binary resolution and env gate (`GHA_ADAPTER_BIN` /
`AGENT_OS_GITHUB_ADAPTER_BIN`) as reads. A write helper must distinguish
"adapter absent" from "adapter ran": an absent adapter returns the no-adapter
sentinel and falls through to `gh`, while a present adapter that successfully
emits JSON `null` is still a handled write and must not be retried through
`gh`. This prevents duplicate public side effects after an adapter successfully
creates a comment, review, status, label, or merge and chooses not to return an
object payload.

Write fallback is allowed only when the adapter is absent or reports a
machine-checkable unsupported signal: exit code `78` or JSON output/error
payload with `error`, `code`, `reason`, or `type` set to `unsupported_kind`,
`unsupported_write_kind`, `unsupported_write_operation`, or
`unsupported_command`. A narrow legacy usage-string classifier may remain for
adapter CLI rollout, but free-form GitHub failure prose such as "unknown ref" or
"command failed" must not by itself trigger fallback because a second `gh` write
can duplicate public artifacts.

Fast-merge is the special high-authority write path. The adapter merge request
must carry explicit admin intent via `--admin`; if an enabled adapter merge
fails for any reason, the closer must fall back to the historical `gh pr merge
--admin --squash --match-head-commit <sha> --delete-branch` command so protected
branch bypass semantics are preserved.

Open-PR discovery is the highest-blast-radius adapter read because an empty
result can silence the entire watcher. During rollout, an empty adapter
`open-pull-requests` result is inconclusive when an Octokit discovery client is
available; the subject adapter must cross-check Octokit instead of treating the
empty adapter list as authoritative. Adapter-only deployments may still return
an empty subject set when no fallback client exists.

The review-context adapter path is intentionally narrower than the full PR
rollup. It must normalize to the same contract as the GraphQL/legacy review
context reader: PR metadata plus comments, with `labels`, `reviews`, and
`checks` empty and `mergeable` / `mergeStateStatus` set to `null`. Missing or
present mergeability fields must not decide whether the review-context adapter
path engages.

AMA mergeability sampling is adapter-first through the pull-request rollup read
and falls back to `gh pr view` when the adapter is absent, malformed, or missing
the required mergeability enums; both paths record `pr_mergeability` telemetry.

The `pull-request-review-bodies-for-head` read kind must return structured
review objects carrying body, submitted state, reviewed commit/head SHA, submit
time, and author metadata. String-only body arrays are not sufficiently
verifiable; callers must fall back to the legacy GitHub reader so in-process
head/state filtering remains identical to the non-adapter path. Empty structured
body arrays are also inconclusive during rollout and must fall back to the
legacy reader because this read directly feeds verdict detection. PR diff
adapter payloads must contain a non-empty string diff; empty-string diffs fall
back to `gh pr diff` rather than reviewing an empty representation.

## Default Agent Routing Overrides

The GitHub-PR adapter first resolves the historical opposite-agent base route
for every supported title prefix:

- `[codex]` PRs route first-pass review to Claude and use
  `GH_CLAUDE_REVIEWER_TOKEN`.
- `[claude-code]` PRs route first-pass review to Codex and
  use `GH_CODEX_REVIEWER_TOKEN`.
- `[clio-agent]` PRs route first-pass review to Claude and use
  `GH_CLAUDE_REVIEWER_TOKEN` because Clio dispatches Codex-family writers.
- `[gemini]`, `[pi]`, `[opencode]`, and `[hermes]` PRs also route first-pass
  review to Codex and use `GH_CODEX_REVIEWER_TOKEN`.

The exported GitHub-PR route helpers and watcher dispatch path then apply
`reviewer.gemini.mode` through the same effective-route helper. The default
mode is `off`; operators must explicitly enable Gemini routing after the
Antigravity reviewer runtime is provisioned.

`routePR` helpers use the shared `(title, subject, options)` call shape; wrappers
that do not need subject context still pass the subject through so future
subject-aware routing cannot silently diverge.

With the `off` default, the public default matrix remains the base
opposite-agent route:

- `[codex]` and `[clio-agent]` PRs route first-pass review to Claude and use
  `GH_CLAUDE_REVIEWER_TOKEN`; `[claude-code]` PRs route first-pass review to
  Codex and use `GH_CODEX_REVIEWER_TOKEN`.
- `[gemini]`, `[pi]`, `[opencode]`, and `[hermes]` PRs keep the base Codex
  route and use `GH_CODEX_REVIEWER_TOKEN`.

`reviewer.gemini.mode: always-on` is the opt-in staged rollout mode that routes
`[codex]`, `[claude-code]`, and `[clio-agent]` first-pass reviews to Gemini and
uses `GH_GEMINI_REVIEWER_TOKEN`. `reviewer.gemini.mode: fallback` selects
Gemini only when the base reviewer is inside the quota-exhausted hold window.
`reviewer.gemini.mode: off` preserves the base route above. Gemini is never
permitted to review a `[gemini]` PR: even an operator pin or default route that
resolves to `reviewerModel: gemini` for a Gemini-built PR is stripped back to
the Codex base route before dispatch.

The canonical GitHub-PR title-prefix allowlist is therefore:
`[codex]`, `[claude-code]`, `[clio-agent]`, `[gemini]`, `[pi]`, `[opencode]`,
and `[hermes]`.
Any other prefix is malformed and must fail loud instead of silently falling
back to same-model review or an unregistered worker class.

Operators may deliberately pin the reviewer with
`ADVERSARIAL_REVIEW_DEFAULT_REVIEWER=codex|claude|claude-code|gemini`.
A non-empty override wins over the title-prefix route and the Gemini default
layer for every supported builder class, except for the Gemini-on-Gemini hard
guard. It also selects the matching reviewer bot token:
`GH_CODEX_REVIEWER_TOKEN`, `GH_CLAUDE_REVIEWER_TOKEN`, or
`GH_GEMINI_REVIEWER_TOKEN`. The aliases `claude` and `claude-code` both
normalize to the Claude reviewer route.
Watcher startup validates this override once and exits non-zero on invalid
values instead of discovering the typo mid-poll. When the override intentionally
pins the same reviewer family as the builder, the posted review body carries an
explicit cross-model-waiver note so the audit trail shows the guarantee was
deliberately suspended.

The MHX-09 `[pi]`, `[opencode]`, and `[hermes]` values remain GitHub-PR
title-prefix builder tags, not shared CFG role enum values. They must not be
accepted in `roles.reviewer`, `roles.merge_agent_worker_class`, or
`dispatch.default_worker_class_by_task_kind` until the Python
`agent_os_config` loader widens the same enums. `[gemini]` is the exception:
the native Gemini reviewer runtime is operator-selectable through
`roles.reviewer: gemini` / `ADVERSARIAL_REVIEW_DEFAULT_REVIEWER=gemini`, posts
as the GitHub App author `lacey-gemini-reviewer[bot]`, captures reviews against
that canonical login plus the legacy `gemini-reviewer-lacey` alias, and uses
`GH_GEMINI_REVIEWER_TOKEN`. No same-family waiver is inferred for `[opencode]`
without a future explicit writer-family config knob.

### Gemini Antigravity Runtime

`reviewer.gemini.runtime: antigravity` delegates the live reviewer invocation to
the `agy` CLI instead of the historical file-backed account-rotation bridge.
`reviewWithGemini` builds one OAuth-scrubbed environment before any Antigravity
probe or review spawn, stripping `GEMINI_API_KEY`, `GOOGLE_API_KEY`, and the
rest of the canonical OAuth fallback env set. The fail-closed pre-flight first
checks for the macOS keychain item `gemini`/`antigravity` and then runs
`agy models` with that same scrubbed env. Timeout-shaped keychain probe
failures and transient `agy models` transport failures use bounded
retry/backoff before surfacing an OAuth failure; definitive missing-keychain and
non-transient probe failures fail closed immediately. The review itself runs
`agy --print -m <model>` and receives the complete reviewer prompt on stdin.
Watcher startup runs the same scrubbed-env AGY auth probe when this runtime is
selected, but startup treats failures as warning-only visibility signals rather
than refusing to boot. The per-review probe remains fail-closed. Successful real
preflights may be cached briefly in the process performing the probe, keyed by
the resolved AGY/security command and launchd user environment, to avoid
repeated `security`/`agy models` subprocess probes on that process's hot path.
The startup visibility probe is not a cross-process cache warmup for reviewer
subprocesses. The subsequent `agy --print` invocation remains authoritative and
still fails closed if credential state changes inside the short success-cache
TTL.

Because auth and provider quota behavior are delegated to `agy`, the live
Antigravity path no longer injects per-account access tokens, rotates through
`reviewer.gemini.antigravity.accounts[]`, marks bridge accounts as
rate-limited, pages all-capped account pools, emits AGR-06 account telemetry, or
synthesizes the old bridge-level `quotaHoldDecision`. Operators should treat an
`agy` quota or auth failure as a normal reviewer subprocess failure unless a
future `agy` integration exposes a structured reset signal that can be mapped
back into the watcher quota-hold contract. The legacy account config remains
parseable for older modules, but it is not the dispatch contract for the live
Antigravity reviewer runtime.

Follow-up remediation defaults to cross-model routing by PR builder tag:
`[codex]` PRs route to `claude-code`, `[claude-code]` PRs route to `codex`,
and `[clio-agent]` PRs route to `claude-code`. When the durable builder tag is
missing or unknown, the degraded fallback is `codex`. Operators may pin
remediation with `roles.remediator`,
`AGENT_OS_ROLES_REMEDIATOR`, or
`ADVERSARIAL_REVIEW_DEFAULT_REMEDIATOR=codex|claude-code|gemini`; aliases
`claude`, `codex-remediation`, `claude-code-remediation`, and
`gemini-remediation` are accepted and normalized to the worker classes that the
dispatcher can spawn. The follow-up daemon validates the override during
startup and exits before claiming work if the value is invalid. Consume-time
worker selection also runs inside the claimed-job failure handler so
direct/helper callers cannot strand a job in `in-progress/` on a bad override.

Code-PR reviewer and remediator stage prompts share the same canonical
doc-currency contract. Reviewer stages must flag stale in-repo data-model docs
when a diff changes persistent-store shape without moving the matching
`docs/data-model/NN-*.md` file and `docs/data-model/catalog.json`; they must
also flag stale `modules/<name>/<name>-walkthrough.md` files when a diff changes
that module's public interface, dispatch flow, or operational contract. The
remediator stages treat those same updates as in-scope remediation when the
worker's patch changes the corresponding surface, run
`node scripts/validate-data-model-catalog.mjs` for in-repo data-model edits only
when that script exists, treat validator failures as red checks, record a
missing validator script as an operator follow-up rather than a red check by
itself, and record skipped superproject-doc obligations in the machine-readable
reply when the PR repository is a submodule without the canonical docs. The
reviewer-last stage deliberately keeps stale data-model or walkthrough docs as
blocking operator-facing contract drift; at cap exhaustion, accepting that risk
uses the same scoped `operator-approved` recovery path as other final-round
accepted findings.

Gemini remediation is a public third-lane remediator. In direct dispatch, the
daemon spawns the native `gemini` CLI in headless approval mode, requires local
subscription OAuth at `GEMINI_AUTH_PATH` or `${GEMINI_HOME:-$HOME/.gemini}/oauth_creds.json`,
strips API-key, ADC, and Vertex fallback environment before spawn, and stamps
worker-provenance commits with the `gemini-remediation` trailer class. In HQ
dispatch, the daemon sends `hq dispatch --worker-class gemini` and lets the
worker-pool Gemini adapter own broker-backed OAuth seeding (`broker-oauth`);
the HQ path must not require an operator-local `~/.gemini/oauth_creds.json`
before dispatch. The remediation prompt still carries
`WORKER_CLASS=gemini-remediation` so the broker-backed worker stamps the same
provenance trailer as the direct path.

Invalid non-empty override values are configuration errors. The runtime must
not silently fall back from an invalid value because that can route work to an
expensive, unavailable, or intentionally locked-out agent.

## Codex Runaway Guardrails

Before spawning a GitHub-PR rereview, the watcher evaluates the Codex runaway
guardrail block at `agent_control.codex_runaway_guardrails`. The vocabulary
fatigue guardrail reads only the configured tail window of recent PR commit
subjects with `fetchPullRequestCommitSubjects(repo, prNumber, { limit })`,
normalizes the first non-builder-tag word of each subject, and emits an
informational `remediation-vocabulary-fatigue` finding when one verb stem
dominates the configured recent window. First-pass reviews skip this guardrail
because no remediation round has occurred yet.

The finding is reviewer-facing context, not a merge gate. The watcher threads
the finding into reviewer spawn metadata and `src/reviewer.mjs` renders it into
the reviewer prompt as a non-blocking soft churn signal. Reviewers may use that
context when judging whether the diff shows runaway remediation churn or
repeated superficial edits, but the finding is not itself a blocking issue and
must not make the merge-agent blocker count non-zero.

The strict CFG knobs are:

- `agent_control.codex_runaway_guardrails.vocabulary_fatigue_window_commits`
  (default `5`, minimum `1`): how many most-recent commit subjects are inspected.
- `agent_control.codex_runaway_guardrails.vocabulary_fatigue_min_repeats`
  (default `3`, minimum `1`): how many occurrences of one normalized stem are
  required before the finding is emitted.

Commit-subject lookup is fail-open. If config loading or GitHub commit-subject
fetching fails, the watcher logs the degraded scan and continues the reviewer
spawn without the informational finding.

## Launcher Secret Resolution

The airlock watcher and follow-up LaunchAgents set
`CLAUDE_REVIEWER_AUTH_VIA_BROKER=true`, `CODEX_REVIEWER_AUTH_VIA_BROKER=true`,
and `GEMINI_REVIEWER_AUTH_VIA_BROKER=true`, plus
`OAUTH_BROKER_SHARED_SECRET_FILE`, so reviewer GitHub tokens are minted through
the local OAuth broker before any legacy per-role 1Password PAT path is used.
Broker mode fails closed: when the flag is true and the broker cannot mint the
token, the launcher must not silently fall back to `op read`. That fail-closed
path must also sleep before exit using the same launchd respawn-storm guard as
the other startup secret failures.

The watcher LaunchAgents also own a separate GitHub token for the watcher's
own GitHub calls: poll-loop Octokit requests, branch/label/status probes, and
watcher-side `gh` calls such as AMA eligibility checks. That token is not a
reviewer bot token and is controlled by a watcher-specific surface:

- `WATCHER_GH_AUTH_VIA_BROKER` defaults to `true` in the maintained airlock
  wrapper, the canonical `placey` wrapper, and the portable rendered watcher
  template.
- `WATCHER_GH_BROKER_ROLE` defaults to `merge-agent`. Operators may point it at
  a dedicated watcher role once provisioned; the startup and runtime refresh
  paths both use the same role value.
- On successful broker minting, launchers export the App installation token to
  both `GITHUB_TOKEN` and `GH_TOKEN`. `GITHUB_TOKEN` is consumed by the
  watcher's in-process Octokit client, while `GH_TOKEN` is the GitHub CLI
  credential that `gh` prefers.
- Startup watcher-token broker mode is fail-safe, not fail-closed: if
  `WATCHER_GH_AUTH_VIA_BROKER=true` but the broker is unavailable, malformed,
  or disabled by missing config, the launcher falls back to `gh auth token` and
  logs that it is sharing the operator PAT's 5000/hr budget. If neither broker
  nor `gh auth token` yields a token, startup fails and sleeps before exit.
- Broker responses for the watcher-owned token use the same
  `scripts/lib/reviewer-broker.sh` verification primitive as reviewer tokens:
  provider is checked, and configured expected app/installation metadata pins
  must match before the token is accepted.

This watcher-owned token path is deliberately distinct from reviewer-token
broker mode. Reviewer tokens are per reviewer identity and fail closed at
startup when their `*_AUTH_VIA_BROKER=true` flag is set, because falling back to
the wrong reviewer PAT changes review authorship. The watcher token is the
daemon's operational GitHub identity; its broker path exists to move high-volume
watcher reads off the operator PAT, but its fallback preserves daemon startup
when the broker is temporarily unavailable.

### Merge-agent broker CFG mirror

The shared CFG surface also permits
`oauth_broker.merge_agent.broker_auth_enabled`,
`oauth_broker.merge_agent.expected_app_id`, and
`oauth_broker.merge_agent.expected_installation_id` in checked-in
`config.yaml` / `config.local.yaml`. These keys describe the GitHub App
installation-token cutover and metadata pins for the merge-agent / AMA broker
role.

The adversarial-review Node loader treats `oauth_broker.merge_agent` as a
strict, partial mirror for CFG parity only. It validates and exposes the three
keys above so shared config files parse consistently across loaders, and it
rejects unknown siblings such as `oauth_broker.merge_agent.secret_file` in
checked-in config. The watcher and follow-up daemon do not consume these keys
directly; their runtime broker behavior remains controlled by the launcher/env
surfaces documented above and by the broker verification helpers. Operational
changes to merge-agent broker auth must therefore update the owning broker/CFG
implementation as well as this tolerated Node-schema mirror.

### Runtime reviewer-token refresh (watcher and follow-up daemon ticks)

The launcher mints the reviewer tokens **once**, at startup. The watcher and
follow-up daemon, however, are single long-lived processes and the broker issues
**GitHub App installation tokens that expire ~1h after issuance** (and may be
served from the broker's cache already partway through that life). A token
resolved only at startup therefore goes `401` mid-run, failing the GitHub review
POST, remediation worker handoff, or remediation comment delivery until the
daemon is restarted. To close that gap both long-lived processes
**re-resolve each broker-enabled reviewer token on every tick**
(`src/reviewer-broker-refresh.mjs`), writing the fresh token back into
`process.env[botTokenEnv]` so subsequently-spawned reviewer/remediation workers
and in-process comment delivery inherit it.

The watcher runs the refresh at the start of each `pollOnce`. The follow-up
daemon runs the same refresh as its first tick step, before `consume` can spawn a
remediation worker that snapshots `process.env` and before `retry-comments` can
post a durable remediation comment. A refresh failure therefore degrades only the
current token freshness: reconcile, heartbeat, stuck-claim sweep, comment retry,
and maintenance still run, but `consume` is skipped for that tick when the
refresh summary cannot prove every broker-backed reviewer token remains safe for
remediation-worker subprocess handoff. The runtime refresh contract:

- **Scheduling is expiry-driven, not a blind TTL.** The next refresh is keyed
  off the broker response's `expires_at` minus a 15-minute skew; a fixed
  fallback TTL applies only when `expires_at` is absent. The first sight of a
  role always re-fetches (the startup token's expiry is unknown to the watcher).
- **Subprocess handoff requires enough remaining lifetime.** A token with a
  parseable `expires_at` is written into the runtime environment only when its
  remaining lifetime exceeds the caller's handoff floor. The watcher uses the
  configured reviewer timeout plus runtime post slack
  (`REVIEWER_TOKEN_POST_SLACK_MS`, default 2m). The follow-up daemon passes a
  separate remediation-worker floor
  (`ADVERSARIAL_REMEDIATION_WORKER_TOKEN_MIN_LIFETIME_MS`, default 50m) before
  `consume` can spawn detached workers. Short-lived cached broker responses are
  rejected and the prior token, if any, remains in place, because each spawned
  reviewer or remediation subprocess snapshots `process.env` at spawn and
  cannot benefit from a later daemon refresh. If that prior token has already
  aged below the remediation-worker floor, the follow-up daemon leaves the token
  untouched but skips only worker spawn until a handoff-safe token is available.
- **Operator config rotations bypass the schedule.** The refresh clock records a
  per-role fingerprint covering broker URL, provider, expected app ID, expected
  installation ID, shared-secret file path, and the broker-mode flag. Any change
  to that fingerprint forces an immediate broker call and metadata
  re-verification even when the prior token's expiry-derived refresh time has
  not arrived.
- **Same verification as launcher minting.** The runtime path re-applies the
  `scripts/lib/reviewer-broker.sh` checks: provider is compared unconditionally,
  and `metadata.app_id` / `metadata.installation_id` must match the configured
  expectations when set. A response failing any check is rejected.
- **Bounded.** The broker fetch *and* body read run under a single abort timer
  (`REVIEWER_TOKEN_FETCH_TIMEOUT_MS`, default 5s) so a wedged broker can never
  hang the poll loop.
- **Runtime is fail-OPEN, deliberately distinct from startup fail-CLOSED.** A
  refresh failure (broker down, non-200, malformed/unverified response, timeout)
  is logged and **leaves the existing token in place** — it never clears a
  still-valid token and never throws into the tick. This is intentional: at
  startup, no token yet exists so a broker failure must fail closed; at runtime,
  a still-valid token is in hand, so a transient broker blip must not take the
  pipeline down. The refresh retries on the next tick.
- **Honors the per-role `*_AUTH_VIA_BROKER` flag** — a pure no-op when broker
  mode is off, so non-broker deployments are unaffected.

The watcher performs an additional tick-start refresh for its own
`GITHUB_TOKEN`/`GH_TOKEN` when `WATCHER_GH_AUTH_VIA_BROKER=true`
(`refreshWatcherGithubToken`). That refresh uses `WATCHER_GH_BROKER_ROLE`,
updates both environment variables together, honors broker metadata pins, and
is fail-open like reviewer-token runtime refresh: transient broker failures
leave the prior watcher token in place and retry on the next tick. The
watcher's Octokit client is constructed without static `auth` in this mode and
injects the current `process.env.GITHUB_TOKEN` into each request so an expired
startup token cannot be re-applied by Octokit after the refresh hook runs.

### Reviewer Review-Post Auth Retry

`src/reviewer-broker-refresh.mjs` also exposes `resolveReviewerAppToken(identity,
opts)` for the reviewer post path. The post path may call it only after a
genuine GitHub authentication failure while submitting `gh pr review --comment`:
HTTP 401/unauthorized, bad credentials, authentication-required messages, or a
pre-write self-probe 401 paired with token/credential/OAuth-specific post
errors. When that happens, the reviewer refreshes the matching GitHub App
installation token, writes it back to `process.env[botTokenEnv]`, and retries
the review post at most once.

The retry must not fire for generic transport or server errors such as
`ECONNRESET`, timeouts, secondary-rate-limit messages, or 502/503/504 responses.
`gh pr review --comment` submits a non-idempotent review mutation; if the first
write committed server-side and the client failed while reading the response, a
transport retry would duplicate the submitted review. Transport resilience
requires a separate idempotency check that can prove a self-authored submitted
review already exists at the reviewed head before any no-refresh retry is added.

The airlock watcher may satisfy runtime-only alerting secrets from local files
before using 1Password:

- `LINEAR_API_KEY` is read from `$REPO_ROOT/.secrets/local/linear.env` or the
  legacy `$REPO_ROOT/agents/clio/credentials/local/linear.env` only as a single
  parsed key assignment. The launcher must not source this file into its global
  shell environment. Unquoted inline comments are not part of the token, and a
  blank or whitespace-only value must fall through to the canonical 1Password
  resolver.
- `ALERT_TO` is read from `$REPO_ROOT/.secrets/local/adversarial-watcher-alert-to`
  or the legacy
  `$REPO_ROOT/agents/clio/credentials/local/adversarial-watcher-alert-to` as the
  first non-empty trimmed line only. If no such line exists, the existing
  `ADVERSARIAL_REVIEW_ALERT_TO_OP_REF` resolution and allow-missing contract
  remain authoritative.

## GitHub Diff Cache Contract

Reviewer diff caching is keyed by `(repo, prNumber, headSha)`, where `repo`
must be an exact `owner/name` slug and the fixed-head key components must not
contain path separators, NUL bytes, or `..` traversal segments. Cache paths are
repo-local under `data/api-cache/diffs/`; patch and metadata files are written
atomically with non-world-readable permissions.

The patch bytes are the source of truth. Metadata stores only `cached_at` for
LRU ordering; it must not duplicate byte counts or stale ETag state. Reads for
a fixed head are immutable and refresh `cached_at` without re-fetching from
GitHub. `GHO_DIFF_CACHE_TTL_HOURS` is therefore a garbage-collection horizon,
not a read-miss rule. Budget eviction uses the on-disk patch size, and expired
entries are swept during writes.

Telemetry distinguishes cache hits from HTTP calls: cache hits report
`cache_hit_diff_fetch` with `status=hit`, while misses emit only the real
`diff_fetch` GitHub call status. The cache layer must not add a second miss
event for the same network fetch.

## SIGTERM Fence Contract

When `ADVERSARIAL_REVIEW_SIGTERM_FENCE` is not `off`, reviewer subprocesses
serialize the review-post critical section with a fence under
`<stateDir>/reviewer-fences/`, where `stateDir` resolves from
`ADVERSARIAL_REVIEW_STATE_DIR` or the repo-local `data/` root. Each active
reviewer fence uses:

- `<spawnToken>.json` for the durable reviewer metadata (`repo`, `pr`,
  `identity`, `openedAt`, `expectedClearBy`)
- `<spawnToken>.lock` for the live `flock` guard
- `spawn-records/<spawnToken>.json` for restart-time identity/token lookup
- `cleanup-jobs/*.json` for deferred pending-review cleanup work
- `quarantine/` for corrupt fence JSON or cleanup-job files that recovery
  moved aside instead of crashing startup
- `audit/*.jsonl` for append-only fence lifecycle events

Fence cleanup order is load-bearing: the reviewer deletes the JSON sidecar
before unlocking the flocked lock file, then closes and removes the lock file.
That ordering makes a concurrent startup sweep or SIGTERM probe observe either
"no fence" or "still held", never a transient free-lock orphan on a clean exit.
If fence open fails after `flock(2)` succeeds, the reviewer must unlock, close,
and remove the lock file before rethrowing so failed opens cannot strand
orphaned `*.lock` files forever.

Watcher startup runs this sequence before orphan-review reconciliation:

1. `processQueuedFenceCleanupJobs()`
2. `sweepReviewerFencesOnStartup()`
3. `processQueuedFenceCleanupJobs()`
4. `reconcileOrphanedReviewing()`

Startup recovery treats corrupt fence JSON and corrupt cleanup-job JSON as
recoverable input: quarantine the bad file under
`reviewer-fences/quarantine/`, emit `fence_corrupted_skipped`, and continue
iterating. The sweep also prunes stale `*.lock` files that no longer have a
matching JSON sidecar once they age past
`ADVERSARIAL_REVIEW_FENCE_STALE_TTL_SECONDS`.

`classifyFenceOrphan()` currently applies these rules:

- `flock-held` is not an orphan.
- `flock-free` is an orphan and queues cleanup.
- Unknown tokens are orphaned immediately as `token-unknown`.
- Known tokens whose wall-clock age exceeds
  `ADVERSARIAL_REVIEW_FENCE_STALE_TTL_SECONDS` are orphaned as
  `wall-clock-stale`.
- Missing or inconclusive locks on known, non-stale tokens are orphaned as
  `fence_lock_missing_with_json` or `lock-inconclusive-known-token`.

The SIGTERM grace path waits up to
`ADVERSARIAL_REVIEW_SIGTERM_FENCE_GRACE_SECONDS` for active fences to clear.
If `shouldPreserveReviewersOnSigterm()` says the reviewer subprocesses should
survive the watcher bounce, grace expiry emits `fence_grace_exceeded` audit
events but does not queue cleanup jobs; only truly stale fences queue cleanup
in preserve mode. Non-preserve shutdown paths may queue cleanup on grace
expiry.

`ADVERSARIAL_REVIEW_WATCHER_PLIST_PATH` points at the watcher LaunchAgent plist
for startup self-checks. The watcher warns, rather than refusing to start, when
the plist path is unavailable or its `ExitTimeOut` is below
`ADVERSARIAL_REVIEW_SIGTERM_FENCE_GRACE_SECONDS + 15`. Operators should still
set `ExitTimeOut >= 45`, and at minimum `grace + 15`, so launchd gives the
watcher enough time to wait for fence release on SIGTERM.

## First-Pass Reviewer Pool And Memory Admission

The watcher may dispatch first-pass reviewers through a bounded global pool
instead of a strict per-PR serial loop. Pool mode is enabled by default and
uses a default cap of `3` concurrent first-pass reviewer spawns across the
watcher's entire claimable set.

Operators can control that behavior with:

- `ADVERSARIAL_FIRST_PASS_REVIEWER_POOL_ENABLED`
- `ADVERSARIAL_REVIEWER_POOL_ENABLED` as the compatibility alias for the same
  enable/disable switch
- `ADVERSARIAL_FIRST_PASS_REVIEWER_POOL_MAX_CONCURRENT`
- `ADVERSARIAL_FIRST_PASS_REVIEWER_MAX_CONCURRENT` as the legacy first-pass
  concurrency alias
- `ADVERSARIAL_REVIEWER_POOL_MAX_CONCURRENT` as the compatibility alias for
  the concurrency cap

Non-positive or malformed concurrency values are clamped back to the default
configured positive integer, and the exported queue helper must still clamp any
direct caller to at least one worker so a bad test/helper call cannot busy-loop
the watcher tick.

On Darwin, first-pass reviewer admission is further gated by live
memory-pressure sampling from `vm_stat` plus `sysctl vm.swapusage`. This gate
applies in both bounded-pool mode and serial fallback mode; disabling the pool
reduces concurrency to one but does not force reviewer spawns through critical
host pressure. The watcher deduplicates concurrent host-pressure reads, then
refreshes the cached sample during long poll ticks after a bounded TTL so later
admissions see memory consumed by other pipelines. Each admission computes a
projected headroom check using the already-reserved reviewer budget plus the
next reviewer's estimated peak RSS. The shared reservation must be recorded
before the async sample is awaited so concurrent admissions observe each
other's in-flight reservations rather than all admitting against a stale zero
baseline.

The current thresholds and model estimates are:

- `ELEVATED_AVAILABLE_MB = 2048`
- `CRITICAL_AVAILABLE_MB = 1024`
- `ELEVATED_SWAP_USED_PCT = 85`
- `CRITICAL_SWAP_USED_PCT = 95`
- `PROJECTED_HEADROOM_FLOOR_MB = 1024`
- Peak reviewer RSS estimates: `codex=1024`, `clio-agent=512`,
  `claude-code=512`, `claude=512`, `gemini=512`, unknown reviewers=`256`

Admission refuses the spawn immediately on `pressureLevel=critical`, or when
`availableMb - reservedMb - estimatedReviewerRssMb` would fall below
`PROJECTED_HEADROOM_FLOOR_MB`. A denied admission releases its optimistic
reservation before returning so later candidates can retry against current
memory state on a future tick.

In pool mode operators should expect multiple first-pass reviewer log streams
from one watcher tick. Interleaved `[watcher] Spawning reviewer for ...` and
`[reviewer:<n>] ...` lines are normal when several PRs are claimable; set
`ADVERSARIAL_FIRST_PASS_REVIEWER_POOL_ENABLED=false` to return to the old
single-reviewer serial behavior for diagnosis.

The SQLite `review_attempts` counter captured during candidate discovery is a
best-effort diagnostic for the DB row being claimed. The remediation ledger is
the source of truth for reviewer round budgeting; the claim compare-and-swap
and GitHub freshness checks remain the load-bearing concurrency protections.

## Routing-Tier Readiness Gate

Before spawning a reviewer, the watcher may probe the local routing tier
(LiteLLM) so a known-bad proxy does not waste a full reviewer launch. The
probe surface is operator-configurable:

- `WATCHER_ROUTING_TIER_READINESS_URL` overrides the default
  `http://127.0.0.1:4000/health/readiness`.
- `WATCHER_ROUTING_TIER_READINESS_TIMEOUT_MS` overrides the default `2000ms`
  per probe attempt.
- `WATCHER_ROUTING_TIER_READINESS_PROBE_DISABLED=1` disables the pre-spawn
  readiness gate entirely.

Failure semantics are intentionally transient: probe failures settle through
the existing `cascade` path and must not increment `review_attempts`. The
watcher retries failed probes with short bounded backoff before it defers a
spawn, caches successful probe results for the rest of the current poll tick,
and caches failed results only for a very short TTL so later PRs in the same
tick can re-check after a momentary proxy bounce. Classifier heuristics that
bucket reviewer stderr into the same routing-tier `cascade` class must stay
scoped to explicit local-routing context such as `127.0.0.1:4000`,
`localhost:4000`, `LiteLLM`, or equivalent routing-tier markers; generic
non-local API connectivity failures remain `unknown` unless another more
specific classifier matches. Reviewer setup is one such explicit classifier:
`gh pr diff` / GitHub GraphQL transient failures (`TLS handshake`, temporary
network failures including refused/reset connections, and HTTP 5xx shapes) are
retried before the review exits with a diff-specific timeout that is longer than
the generic GitHub lookup timeout; if the retry budget is exhausted before a
diff is fetched, the failed row is tagged as `cascade` so it rides the bounded
infrastructure backoff path instead of consuming the substantive review attempt
budget. The `gh` environment remains allowlisted but must preserve the normal
GitHub CLI host/config, proxy, locale, and CA-certificate variables needed for
deployment hosts that reach GitHub through a proxy or custom trust store.

## Infrastructure Failed-Row Auto-Recovery

The watcher may boundedly recover `review_status='failed'` rows only through
the normal reviewer dispatch path. The row must still be an open, rediscovered
PR, the watcher must not be draining, active follow-up/backoff/handoff gates
must allow dispatch, memory admission must pass, and the routing-tier readiness
gate above must report healthy before an infrastructure failed row is claimed.

Eligible infrastructure classes are routing-tier `cascade`, exhausted
GitHub diff-fetch transients tagged as `cascade`, `reviewer-timeout`,
`launchctl-bootstrap`, reviewer-spawn `oauth-broken`, and hard provider usage
caps recorded as `quota-exhausted`. Reviewer subprocess exits recorded as
`[unknown] Command failed` (including stored stdout/stderr tails) or
`[unknown] Command failed with code <n>` before any verdict exists are also
eligible as `reviewer-command-failed`. Before retrying that class, the watcher
must have durable reviewer session/start evidence, query GitHub for a matching
reviewer-bot review posted after that start time, and mark the row `posted`
instead of respawning when such a review exists. If the watcher cannot perform
that proof because the row lacks session/start evidence or the GitHub probe
fails, it leaves the failed evidence intact for a later poll/operator
inspection. Only rows whose probe finds no posted review continue to the same
bounded claim and cap semantics as the other infrastructure classes.
`forbidden-fallback`,
`failed-orphan`, `malformed`, inactive repos, closed or merged PRs,
undiscovered PRs, drain-skipped rows, and rows blocked by active follow-up jobs
are not recovered by this path. `oauth-broken` is included only for spawn
failures recorded in the watcher row, because those failures can represent
local OAuth/runtime launch breakage before any reviewer verdict exists.
Exhausted GitHub diff-fetch transients intentionally share the same routing-tier
readiness gate as other `cascade` rows because recovery immediately dispatches a
full reviewer after the diff is fetched; if the local model route is still down,
the recovered row would only trade a GitHub-side failure for another
infrastructure failure.

`quota-exhausted` is a hold-until-reset recovery class, not a normal immediate
retry. The reviewer/runtime classifier must tag failed-row evidence with a
`[quota-exhausted]` prefix and the watcher must capture the provider reset hint
from the full reviewer output, before truncation, into
`reviewed_prs.quota_reset_at_utc`. That column is the preferred durable reset
source for the hold decision. It is set only when a reviewer failure is recorded
as `quota-exhausted`; it is cleared when the row is claimed for a replacement
review, when a review posts successfully, and when an operator quota re-arm
moves the row back to `pending`.

Before claiming a quota row again, the watcher resolves the reset in this order:
first `quota_reset_at_utc`; then a fallback parse of the stored
`failure_message` for Codex month/day strings, explicit ISO timestamps (with a
trailing `Z` or a `+HH:MM`/`-HH:MM` offset), and Claude clock-only strings such
as `resets at 5:39 PM` anchored to the host's local date and rolled to the next
day if the clock time has already elapsed; finally a fixed quota fallback window
anchored to a **durable** timestamp (`failed_at`, then `last_attempted_at`). If
the resolved reset/fallback window is still in the future, the watcher leaves
the row `failed`, skips the spawn for that poll, and does not consume an
infrastructure auto-recovery attempt. When no durable anchor exists at all, the
row is **not** held: anchoring the window on the current poll time would
recompute `now + window` every tick and suspend the row forever, so the decision
releases it to bounded recovery (capped by the infrastructure auto-recovery
budget) instead. A `failed` row always carries `failed_at` in practice, so this
guards only the pathological no-timestamp case.

Operators may manually release a stuck quota hold with
`npm run quota-rearm -- --repo <owner/repo> --pr <number>` (or
`node bin/quota-rearm.mjs ...`). The command is intentionally narrower than a
generic re-review reset: it refuses missing rows, non-open PRs, `reviewing`
rows, already terminal/backoff statuses such as `posted`, `malformed`,
`failed-orphan`, and `pending-upstream`, and non-quota failed rows unless
`--force` is supplied. `--force` only bypasses the quota-evidence check for an
open `failed` row; it does not authorize rewriting posted reviews or unrelated
state-machine statuses. The mutation itself is a compare-and-swap against the
failed row that was read, including stable failure/session evidence, so a
concurrent watcher claim, posted review, or operator edit returns
`state-changed` instead of clearing the new state. A successful re-arm moves the
row to `pending`, clears `failed_at`, `failure_message`,
`quota_reset_at_utc`, and reviewer lease/session fields, and resets
`infra_auto_recover_attempts` to `0` so the next watcher poll treats the next
quota incident as a fresh bounded recovery window.

The same hard-cap contract applies to follow-up remediation workers that spawn
direct harness CLIs outside the dispatch lane. Reconcile may move a
quota-exhausted in-progress remediation job back to `pending` with
`retryAfter` pinned to the provider reset or the fixed fallback window. That
hold does not request re-review and does not consume the PR's normal
remediation round by itself; it is a delayed retry of the same worker round.
If the remediation job exhausts its bounded quota retry budget before the
provider window clears or the worker can produce a valid remediation reply, it
must become terminal with `quota-exhausted-budget-exhausted` so operators see a
loud stop instead of an endless suspended loop.

The recovery budget is lifecycle-scoped to the current failed-row incident, not
PR-row lifetime state. The watcher atomically promotes an eligible failed row to
`reviewing` and increments `infra_auto_recover_attempts` in the same SQL
transition, conditional on the row still being `failed` and still matching the
same infrastructure class observed before claim. If another watcher, operator
action, stale-head refresh, or remediation reconciliation has already moved the
row to another status or changed the failure class, the claim loses and the
counter is not consumed. Once the counter reaches the cap (`3`), the watcher
leaves the row `failed` with its evidence intact for operator inspection.

Failure evidence is cleared only at the successful recovery claim, when the
replacement reviewer pass is durably `reviewing`. A successful posted review
resets `infra_auto_recover_attempts` to `0`, and intentional re-review re-arms
such as remediation reconciliation or stale-head refresh also reset the counter
when they move the row back to `pending`. This gives later, unrelated
infrastructure incidents a fresh bounded budget while still capping persistent
failure loops.

## Review Cycle Cap

The watcher also tracks successive successful adversarial review verdicts that
still carry standing structured blocking findings for a PR in
`review_cycle_verdicts` / `review_cycle_counters`. Settled `Comment only` or
`Approved` verdicts with `## Blocking issues` set to `- None.` do not accrue
cycle-cap budget. The operator-facing config keys are `review_cycle_cap`
(default `5`) and `review_cycle_window_hours` (default `24`). A new counted
verdict on the same head keeps the current count; a counted verdict on a
distinct head increments the count when it lands within the configured window
of the prior counted verdict; a larger gap resets the sequence to `1`.

When the next review attempt would exceed `review_cycle_cap`, the watcher posts
one escalation comment for the PR, applies `reviewer-cycle-cap-reached`, marks
the review row `failed`, and skips automatic reviewer dispatch. The escalation
dedupe is PR-scoped, not head-scoped: once any head for that PR has escalated,
later pushes while the cap pause remains active must not post another cap
comment. A cap bookkeeping failure on the success path must never prevent the
canonical `review_status='posted'` write for a successfully posted review.

The cap pause is cleared only by an override label:

- `operator-approved` removes `reviewer-cycle-cap-reached`, resets the cycle
  counter, and restores the review row to `posted` so the existing current-head
  operator-approved merge-agent path can evaluate the PR.
- `merge-agent-requested` removes `reviewer-cycle-cap-reached`, resets the
  cycle counter, and restores the review row to `posted` so the existing scoped
  merge-agent-requested escape hatch can evaluate the PR.
- `paused-for-redesign` removes `reviewer-cycle-cap-reached`, resets the cycle
  counter, and leaves the row `failed` with a redesign-specific failure message;
  this is an intentional operator pause, not a resume signal.

Cap-clear keys on the bare presence of an override label in the PR's current
label set; unlike the AMA / merge-agent **merge** lanes it does not require a
non-author, current-head, attributable `labeled` event. This is intentional:
clearing the cap only lifts the review pause and resets the cycle counter — it
grants no merge. The downstream merge gate independently re-validates
attribution (non-author, current-head), so a self-applied `operator-approved` /
`merge-agent-requested` cannot merge the PR; its only effect is to re-open the
review/remediate loop, bounding the impact to review-resource churn rather than
an unauthorized merge.

## GitHub API Rollup

`src/github-api.mjs` is the watcher/reviewer rollup helper for GitHub PR
metadata, comments, reviews, labels, and checks. Its normalized contract is
intentional: PR `id` is the GraphQL node ID string-or-null, PR `state` is
lower-case `open`, `closed`, or `merged`, `mergeable` is the GraphQL enum string
(`MERGEABLE`, `CONFLICTING`, `UNKNOWN`) or `null`, `mergeStateStatus` is the
GraphQL enum string-or-null, absent or ghost authors are `null`, and `labels`,
`comments`, `reviews`, and `checks` are always arrays. Reviewer prompt assembly
uses `fetchPullRequestReviewContext`, which fetches only PR metadata plus
comments and deliberately leaves `reviews`, `checks`, and `labels` empty so a
reviewer spawn does not page fields it never reads. Callers that only need fresh
lifecycle state should use `fetchPullRequestHeadAndState` instead of the full
rollup so lifecycle ticks do not paginate comments/reviews/checks for fields
they never consume; it fetches live labels by default so merge-agent lifecycle
cleanup does not rely on stale `reviewed_prs.labels_json` snapshots. Fast
HEAD-SHA authorization probes pass `withLabels: false` so they do not paginate
labels they will discard.

The GraphQL path fetches one combined page and then paginates remaining
connections with single-connection queries. Check pagination is anchored to the
captured `headRefOid` rather than repeatedly resolving `commits(last: 1)`, so a
force-push during pagination cannot switch the commit being paged. Label
pagination must also continue beyond the first 100 labels so hold/veto labels
are not silently truncated on crowded PRs. A connection that reaches the
configured GraphQL page cap returns the rows collected so far with
`truncated: true` and `truncatedConnections`, plus a structured warning, rather
than wedging the watcher on the same overlarge PR forever.

`GHO_DISABLE_GRAPHQL_ROLLUP=1` is the operator kill-switch for GraphQL-backed PR
helpers. It is read at call time and falls back to the legacy `gh pr view` plus
REST list paths for full/reviewer contexts, and to REST `pulls` plus `issues`
labels for lightweight head/state probes. `gh` invocations pass an allowlisted
environment only: path/home/config/proxy basics, locale variables, custom CA
bundle paths, and `GH_TOKEN`, falling back to `GITHUB_TOKEN` when needed.
Provider API keys and broker credentials must not be inherited by the `gh`
child. Fast-merge HEAD SHA probes and tick-start freshness
re-checks moved from the old `pr_view` telemetry category to `pr_head_state`;
reviewer prompt fetches use `pr_review_context`; full GraphQL rollups use
`graphql_pr_rollup`. GraphQL telemetry records one event per `gh api graphql`
call, including pagination pages, so dashboards count GitHub operations rather
than only helper invocations.

GraphQL missing-payload errors should distinguish a missing repository payload
from a missing `pullRequest` payload and include GraphQL error types when
available. The complexity fallback only treats regex-matched stderr as a
complexity signal when the error has an explicit GraphQL HTTP status, including
the `HTTP 4XX/5XX` line from real `gh api graphql` exec failures; malformed
structured stderr should produce a one-shot warning before falling back to the
regex path. PR numbers are normalized to positive integers before interpolation
into REST paths or GraphQL flags. Legacy check fallback dedupes combined status contexts against
check-runs by name with CheckRun data winning, and check-run pagination follows
`total_count` so short non-final pages do not silently truncate later checks.

## Conditional Request Cache

Watcher-owned GitHub REST reads for labels, timeline events, and merge-closeout
comments run through `createWatcherOctokit()` plus
`fetchConditionalRestPage()`. The cache root is
`data/api-cache/etags/`, with one fixed-length SHA-256 filename per normalized
`(repo, prNumber, category, endpoint, params)` call key. Each entry stores:

- `call_key` for human/debug readability
- `etag`
- `cached_at`
- `body` when the serialized body stays within the configured size cap

`conditional_304` is a watcher telemetry category, not a GitHub endpoint. It
is emitted only when GitHub answers `304 Not Modified` and the watcher serves a
cached body instead of re-recording the underlying endpoint category.

The cache is a best-effort optimization. A cache write failure must never turn
an otherwise-successful `200` GitHub response into a watcher error; the watcher
logs a warning and continues with the live response.

Retention and body-capping policy:

- The watcher runs an age-based sweep no more than once per hour, from the main
  poll loop, deleting cache entries whose `cached_at` is older than
  `WATCHER_ETAG_CACHE_MAX_AGE_DAYS` days. The default is `7`. Sweep failures
  are warning-only and must not abort the poll tick.
- Cached bodies larger than `WATCHER_ETAG_CACHE_MAX_BODY_BYTES` bytes are
  dropped from the entry while keeping the `etag`. The default cap is
  `262144` bytes.
- Entries whose body was previously dropped are not conditional-read
  candidates. The watcher skips `If-None-Match` for those entries and goes
  straight to an unconditional request, avoiding a permanent `304` + `200`
  double round-trip on oversized resources.

## Remediation Reply Contract

The durable remediation reply schema is the public contract between the worker,
the validator, reconciliation, and the PR-comment renderer. `schemaVersion: 1`
supports five accountability lanes:

- `addressed[]` for blocking review findings that were fixed. The blocking-only
  contract: new code must place non-blocking findings in `nonBlocking[]` (see
  below). A narrow back-compat tolerance still lets entries whose `title`
  exactly matches a finding in the review's `## Non-blocking issues` section
  count as "non-blocking extras" — they render publicly but do not satisfy
  blocking-finding coverage. That tolerance is for pre-`nonBlocking[]` producers
  only and should not be relied on by new workers.
- `pushback[]` for blocking review findings the worker deliberately left unchanged.
- `blockers[]` for blocking review findings that hard-stop on required human input.
- `operationalBlockers[]` for git/process failures that are not themselves review
  findings, such as `branch-contamination`, `stale-pr-head`,
  `push-lease-rejected`, `missing-auth`, `fetch-failed`, or `rebase-conflict`.
- `nonBlocking[]` (LAC-893) for non-blocking review findings the worker
  nonetheless fixed in this round. Same per-entry shape as `addressed[]`
  (`{ title?, finding, action, files? }`). **Invisible to the blocking-coverage
  check** — the validator does not count `nonBlocking[]` entries toward the
  `addressed + pushback + blockers === blocking_findings_in_review` invariant.
  Renderer emits it as its own `## Non-blocking improvements` section placed
  LAST among the per-finding sections (after Addressed → Pushback → Blockers →
  Operational blockers) so an operator skimming the comment hits the
  operationally-urgent surfaces first. The renderer dedupes by normalized
  title against `addressed[]` so a worker that hedges by listing the same
  finding in both arrays does not produce a double-print in the public comment.
  Untitled entries render with a per-section numbered fallback
  (`Non-blocking improvement N`) instead of a collapsed `Finding` label.

Remote PR-head movement is an optimistic-concurrency event, not an immediate
hard stop. A remediation worker must capture the clean post-base-rebase head
before editing, commit its remediation, then publish with `--force-with-lease`
against the freshly observed PR head. If that lease fails or Git reports a
non-fast-forward push, the worker must replay only its own remediation patch
onto the fresh PR head, re-run the contamination audit and relevant validation,
and retry the lease-guarded push with a fresh expected SHA. This replay is
bounded to three stale-head attempts.

`stale-pr-head` specifically means that bounded replay was exhausted or became
unsafe: unresolved `git am --3way` conflicts, ambiguous force-rewritten PR
history where the worker cannot identify its own patch, repeated lease misses
after three fresh-head replays, or post-replay validation/audit failure. The
worker still must not blindly rebase the entire in-progress worktree onto
`origin/<pr-branch>` because that can resurrect commits another writer
intentionally removed; safe recovery replays only the worker's patch series onto
the newly fetched PR head.

`operationalBlockers[]` does not count toward per-finding coverage. A worker may
therefore emit `addressed=[]`, `pushback=[]`, `blockers=[]`, and a non-empty
`operationalBlockers[]` when the round stops before any remediation work begins,
for example when the mandatory branch-contamination audit fails immediately after
rebase. That early-exit shape must validate cleanly and render as an operational
stop, not as a missing-per-finding-accountability error.

Validation keeps three invariants load-bearing:

- Per-finding coverage is enforced only across blocking review findings
  recorded in `addressed[]`, `pushback[]`, and `blockers[]`, with
  operational-only early exits exempt because no review finding was processed
  yet. `addressed[]` entries whose titles match only the review's
  `## Non-blocking issues` section are allowed as extras and are excluded from
  the blocking-coverage count.
- Cross-field contradictions (`reReview.requested=true` while blockers remain,
  `outcome="blocked"` without blockers, `outcome="completed"` with blockers)
  apply only to structured-schema replies so legacy persisted string-blocker
  artifacts remain readable under `schemaVersion: 1`.
- Known operational blocker titles misplaced in `blockers[]` are normalized into
  `operationalBlockers[]` as a worker-safety hatch, but title collisions with an
  actual blocking review finding must fail loudly instead of being silently
  relocated.

## Remediation Workspace Contract

Remediation worker clones live under a canonical workspace root that is resolved
in this precedence order:

1. `ADVERSARIAL_REMEDIATION_WORKSPACE_ROOT`
2. `HQ_ROOT/adversarial-review/follow-up-workspaces`
3. Legacy in-source fallback: `<tool-root>/data/follow-up-jobs/workspaces`

When the daemon is running from the production deploy checkout
`/Users/airlock/agent-os`, it must refuse to create mutable remediation clones
under the live source tree unless either `ADVERSARIAL_REMEDIATION_WORKSPACE_ROOT`
or `HQ_ROOT` points the worker at an external workspace root. An explicitly
configured workspace root must also be rejected if it resolves inside the deploy
checkout.

Spawn persists both the resolved `workspaceRoot` and the per-job `workspaceDir`
on the durable worker record. Reconciliation validates stored absolute artifact
paths against that persisted workspace root rather than re-resolving the current
process environment, so operator changes to `HQ_ROOT` or
`ADVERSARIAL_REMEDIATION_WORKSPACE_ROOT` do not orphan in-flight jobs that were
spawned under an earlier root.

Before reconciliation trusts a persisted absolute `workspaceRoot`, that stored
root must itself resolve inside one of the legitimate remediation workspace
trees for the current process: the configured
`ADVERSARIAL_REMEDIATION_WORKSPACE_ROOT`, `HQ_ROOT/adversarial-review/follow-up-workspaces`,
or the legacy in-source `data/follow-up-jobs/workspaces/` fallback. Stored roots
outside that union are ignored and reconciliation falls back to the current
resolved workspace root instead of treating an arbitrary absolute path as the
containment anchor for worker artifacts.

When a durable worker record is missing `workspaceDir`, reconciliation falls
back to `<persisted workspaceRoot>/<jobId>` before reading legacy workspace
artifacts or running the branch-contamination audit. This preserves the
pre-relocation invariant that the audit has a deterministic per-job workspace
path even for legacy or partially-written records.

Operational ownership expectation: if `HQ_ROOT` is used, the runtime user must
have read/write access under `HQ_ROOT/adversarial-review/` and
`HQ_ROOT/dispatch/remediation-replies/`. LaunchAgent templates that are kept for
operator revival or diagnostic bounces must carry the same `HQ_ROOT` value as
the live daemon so a temporary bounce cannot consume jobs into an unwritable or
mis-resolved workspace tree. Workspace-root provisioning failures must surface a
structured error that names both `HQ_ROOT` and the runtime user so first-deploy
permission drift is diagnosable without reading a raw stack trace.

### HQ Branch-Push Remediation Lane

When `ADV_WITH_HQ_INTEGRATION=1` or
`roles.adversarial.orchestration_mode=agentos`, follow-up remediation uses the
HQ branch-push lane instead of the detached local CLI spawn. In `agentos` mode
the daemon registers with the App Contract endpoint and dispatches through
`/v1/dispatch` using a stable `request_id` derived from the follow-up job id.
That `request_id` is the idempotency key for retrying a claimed remediation
dispatch after daemon or endpoint failure. In native mode, the legacy
`ADV_WITH_HQ_INTEGRATION=1` override must remain a real `hq dispatch
--completion-shape branch-push` subprocess; it must not route into an
in-memory standalone App Contract session because the worker record would look
dispatched without a backing worker. The durable worker record must still
preserve the same reconciliation invariants as the local lane:

The follow-up daemon registers App Contract telemetry subscriptions before
entering its periodic tick loop and installs handlers for the configured
`apps.adversarial-review.subscribes` topics from `config.yaml`. The shipped
subscription set includes `health.worker.*`, and `token.*` remains reserved for
future token lifecycle notices. In `agent-os` mode this is currently a staged
registration: the request/response App Contract session has no inbound delivery
transport that feeds topics into `session.emitTopic(...)`, so production
convergence still depends on the periodic scanner. Listener registration is
best-effort and bounded by
`ADVERSARIAL_REVIEW_TELEMETRY_LISTENER_START_TIMEOUT_MS` (default 5000ms); a
slow or hung App Contract registration must disable the listener for that start
instead of blocking the authoritative periodic tick loop. When an inbound transport is
added, delivered `health.worker.terminal.<launchRequestId>` worker-completion
events will route into `handleRemediationTelemetryEvent` as an acceleration
path, not a separate state machine: the periodic follow-up reconcile tick
remains authoritative and continues to scan
`data/follow-up-jobs/in-progress/`. Both the topic handler and the periodic
scanner acquire the same short-lived per-job reconcile claim before calling
`reconcileFollowUpJob`; if another reconcile owns that job, the topic handler
skips and lets the owner finish. This preserves the single-writer invariant for
side effects such as re-review row resets, branch-contamination audits,
lifecycle cancellation, and terminal comment delivery. Reconcile claims older
than the one-hour stale window are reclaimable by age, so pid reuse cannot
indefinitely protect an abandoned claim left by a crashed daemon while normal
multi-call reconcile work is not stolen after the old ten-minute window.

`health.worker.terminal.<launchRequestId>` events may short-circuit the HQ
status poll only for `status:"succeeded"`. Success remains gated by the
worker's durable reply artifact and the normal branch-contamination audit before
the queue can complete or request re-review. Non-success terminal statuses
(`failed`, `canceled`, `cancelled`, and `superseded`) must fall through to
`hq dispatch status <dispatchId> --root <HQ_ROOT>` so `failureClass`,
`failureDetail`, and retry-attempt metadata come from the canonical HQ status
payload before transient-vs-terminal requeue classification runs. A failed topic
event that omits `failureClass` is therefore only a wakeup signal; it is not
trusted as the complete failure record.

- Standalone App Contract sessions are a local dispatch shim for development
  and controlled deployments that cannot reach an agent-os endpoint. They may
  resolve launches with either an injected `standalone_dispatcher(payload)`
  function or a configured `dispatch_command` / `dispatchCommand`. The command
  is spawned as either a string executable or an argv array, receives the
  dispatch payload as JSON on stdin, and must write either JSON containing
  `launch_request_id`, `launchRequestId`, or `dispatchId`, or a JSON string
  containing the launch request id. A non-zero exit, invalid JSON response,
  missing launch id, spawn/stdin error, or timeout is a failed dispatch and must
  clear the in-flight memo entry so the same stable `request_id` can be retried.
  The timeout is bounded by
  `request_timeout_ms` / `requestTimeoutMs` (default 10000ms), and a timed-out
  command is killed before the dispatch promise rejects. Standalone sessions
  must not emit `health.worker.terminal.<launchRequestId>` on acceptance:
  terminal topics are reserved for worker-completion lifecycle events from the
  real App Contract transport. While a standalone launch is still in flight,
  `dispatchStatus(request_id)` reports `status:"dispatching"`; after acceptance
  it reports the accepted ticket fields from the bounded in-memory cache, and
  unknown or evicted request ids report `status:"not_found"`. Standalone
  idempotency is best-effort and bounded by
  `standalone_dispatch_cache_max_entries`; unlike the agent-os transport, it is
  not durable after cache eviction.

- The worker record persists both `launchRequestId` and `dispatchId` from the
  HQ dispatch ticket. `launchRequestId` remains the reply-storage and audit key;
  `dispatchId` is the authoritative handle for `hq dispatch status` and
  `hq dispatch cancel`.
- App Contract dispatch tickets may also include `watch_url` and `audit_ref`;
  the daemon persists these as `watchUrl` and `auditRef` on
  `remediationWorker` so operators retain a structured trace now that the
  worker record no longer stores a raw `command` array for the HTTP path.
- HQ branch-push remediation dispatches must pass the PR head ref with
  `--branch <headRefName>`. The daemon resolves and persists that ref from
  GitHub PR metadata before dispatch so the worker attaches to the live PR head
  instead of a synthetic provisioning branch.
- The daemon, not the worker prompt, owns commit-hook installation. The
  checked-out remediation workspace already has the worker-provenance
  `commit-msg` hook installed before the worker runs, and any pre-existing hook
  must remain chained through `commit-msg.worker-provenance-chain`.
- Before honoring `reReview.requested=true`, reconcile runs the same
  branch-contamination audit used by the legacy lane against the HQ-managed git
  workspace. If the dispatch ticket did not provide that path, reconcile must
  resolve it from `hq dispatch status <dispatchId> --root <HQ_ROOT>` and fail
  closed when the workspace cannot be proven. `dispatchId`, not
  `launchRequestId`, is the lookup handle for this workspace recovery path.
- If reconcile decides to move an active HQ remediation to a terminal stop
  because the PR merged/closed or another terminal guard fired, it must cancel
  the in-flight dispatch with `hq dispatch cancel <dispatchId> --root <HQ_ROOT>`
  before finalizing the queue record. Transient `EIO`/timeout failures get a
  bounded retry with backoff; non-transient failures surface as
  `hq-dispatch-cancel-failed` instead of silently writing a stopped ledger row
  while the remote worker keeps running.
- HQ liveness and failure classification continue to use the existing
  `hq-dispatch-failed`, `hq-dispatch-not-found`, and
  `hq-dispatch-status-unavailable` reconcile reasons, but those states are
  derived from `hq dispatch status <dispatchId>`, never from `launchRequestId`.
- HQ terminal failures are not uniformly fatal. Reconcile must classify known
  transient dispatch failures from the status payload before terminalizing the
  queue record:
  - Retryable / backpressure-class failures are identified first from
    structured status fields (`failureClass`, `failureCode`, `code`, `status`,
    `health`, etc.) using the canonical codes `launch_refused_memory_pressure`,
    `memory_pressure`, `lease_lost`, `daemon_bounced`, `daemon_restart`, and
    `supervisor_restart`; bounded free-text `failureDetail` matching is only a
    compatibility fallback for older HQ payloads and is limited to canonical
    memory-pressure and lease-loss wording. Retryable failures move the
    job back to `pending/` for a later tick. The canonical round ledger remains
    one entry per round number: on requeue, the live `rounds[]` entry for round
    `N` is removed before the next claim can recreate round `N`, and the failed
    launch/requeue summary is appended to `remediationPlan.retryHistory[]`
    instead. Each requeue also increments the job-level
    `remediationPlan.transientRetries` counter, stamps a future
    `remediationPlan.retryAfter`, and backs off exponentially so a wedged HQ
    does not hot-loop on every consume tick.
  - Pending jobs with `retryAfter` in the future are not claimable work. The
    consume loop must pre-read and skip them in `pending/` without bouncing the
    file through `in-progress/`, so concurrent status readers never observe a
    delayed pending job as a claimed worker.
  - Transient retries are bounded by
    `ADVERSARIAL_REMEDIATION_MAX_TRANSIENT_RETRIES` (default `3`). Once the
    next transient retry would exceed that cap, reconcile terminalizes the job
    to `failed/` with `failure.code = "hq-dispatch-transient-budget-exhausted"`
    instead of requeueing again. The cap is job-scoped, not round-scoped; the
    terminal failure message must include the current round and the number of
    rounds represented in `retryHistory[]` so operators can tell when an earlier
    round consumed the shared transient budget.
  - Non-transient failures such as prompt rejection, explicit cancellation, or
    workspace corruption still terminalize to `failed/`.

## Follow-Up Drain-To-Capacity Tick Contract

The follow-up consume tick no longer follows the historical "claim one job,
return" model. Each tick drains pending remediation work until either:

- the daemon reaches `ADVERSARIAL_REMEDIATION_MAX_CONCURRENT_JOBS`,
- there are no more pending jobs, or
- the tick hits an explicit safety stop such as same-PR exclusion or shutdown.

The consume result exposes the per-tick counters that operators rely on for
lane observability:

- `maxConcurrent`
- `activeAtStart`
- `availableAtStart`
- `spawned`
- `stopped`
- `deferredSamePR`
- `capacityRemaining`
- `pendingClaimable`
- `pendingRetryDelayed`

Logging contract:

- `Drain summary: ...` is the canonical per-tick heartbeat and must always be
  emitted, including idle ticks and saturated ticks.
- `No pending follow-up jobs to consume.` is reserved for the truly idle shape:
  no active remediation workers, no claimed work this tick, and no pending jobs
  available to claim.
- When `availableAtStart === 0` and pending claimable jobs still exist, the
  daemon must emit a distinct backpressure line (`Backpressure:
  activeAtStart=N pendingClaimable=M`) instead of collapsing that state into
  "queue empty". Pending jobs delayed by `retryAfter` do not count as claimable
  backpressure until their retry window opens; saturated-but-empty ticks use the
  drain summary alone. The drain result carries these pending counters so the
  CLI logging path does not perform a second pending-directory scan.
- `pendingClaimable` and `pendingRetryDelayed` are per-tick pending-directory
  snapshots, not "encountered during drain" counters. The drain summary includes
  both fields so retry-after-delayed backlog is visible even when capacity is
  otherwise available.
- Same-PR exclusion remains part of the drain contract: pending jobs for a PR
  that already has an active remediation worker stay in `pending/`, increment
  `deferredSamePR`, and do not consume another slot in the same tick.

## Follow-Up Stop Codes

Queue stop codes are operator-facing state. The durable stop surface currently
includes:

- `operator-stop` — human explicitly stopped the job.
- `no-progress` — worker exited without a durable `reReview.requested=true`.
- `max-rounds-reached` — another round would exceed the stored cap.
- `stale-heartbeat` — the stuck-claim sweep reclaimed an orphaned in-progress
  claim after liveness went stale.
- `operator-merged-pr` — the PR merged before consume or reconcile could
  advance the loop.
- `operator-closed-pr` — the PR closed unmerged before consume or reconcile
  could advance the loop.
- `stale-review-head` — consume-only guard: the job was created for an older PR
  head and a newer head is already live, so this stale job must not spawn.

`stale-heartbeat` is a recovery stop for a transient daemon/worker failure mode,
not a terminal business state. The sweep compares `lastHeartbeatAt`, then the
spawn timestamp, then the claim timestamp, then file mtime for legacy rows. A
reclaimed job remains operator-retriggerable through the normal CLI or
`retrigger-remediation` label flow after inspection.

`stale-review-head` is intentionally a pre-spawn stale-job signal, not a
post-spawn invariant. Reconcile must not emit it merely because the remediation
worker pushed commits and moved the PR head away from `job.revisionRef`; that
head movement is the normal success path before rereview is requested.

The merged/closed consume guard is rerun immediately before worker spawn through
the same canonical lifecycle resolver/decision path used at claim time and
reconcile time. That late recheck must preserve live-to-mirror fallback,
`source=live|mirror` stop-reason tagging, and consume-time stale-drift /
stale-review-head suppression instead of maintaining a second bespoke parser.

The operator `follow-up:stop` command is the terminal ledger transition for
manual intervention. When it targets an in-progress job whose
`remediationWorker.state` is `spawned`, it must first try to signal the
persisted worker process group using the same identity verification as
`follow-up:cancel-worker`. Stale worker handles are not allowed to strand the
operator stop: `process-group-not-found`, `identity-unconfirmed`, and
`missing-worker-process-handle` mean no signal was delivered to a verified live
worker, so the command may proceed to the `operator-stop` transition while
surfacing the cancellation result. Unexpected cancellation failures remain hard
errors and must name the `--no-cancel-worker` escape hatch.

Signal delivery is not the same thing as worker termination. After a successful
signal, `follow-up:stop` must record whether a bounded post-signal liveness
probe observed the process group exiting before moving the job to `stopped/`.
Operators can use `--signal SIGKILL` for urgent termination and
`--no-cancel-worker` only after independently proving the worker can no longer
mutate the PR branch. A benign race with the follow-up daemon reconciling the
job between the stop command's initial read and cancellation attempt must be
treated as "nothing left to cancel"; the command should re-locate the current
job record and continue the operator stop instead of failing.

## Adversarial Gate Commit Status

The watcher projects the durable adversarial-review ledger onto the PR head SHA as a GitHub commit status with context `agent-os/adversarial-gate` by default.

Operators must require `agent-os/adversarial-gate` in branch protection before relying on GitHub-native merge or auto-merge for adversarial-review-gated branches. Without the required context, GitHub can merge while review, remediation, or operator handling is still pending. Deployments may opt into a different context with `ADV_GATE_STATUS_CONTEXT`, but that override must be applied consistently anywhere the watcher posts or probes the gate. Overrides must match `[A-Za-z0-9._/-]+` and be at most 100 characters so structured diagnostics remain log-safe.

The watcher verifies that policy in process: on a cached interval it checks watched repositories' branch protection and logs `branch-protection-warning` when the configured gate context is missing, when the protection endpoint cannot be read, or when `ADV_GATE_STATUS_CONTEXT` is invalid. Operators can run the same probe with `npm run check-branch-protection`.

Status-context migrations are explicit operator work, not an in-place default flip: update branch protection to require the new context and roll the same `ADV_GATE_STATUS_CONTEXT` override to every watcher and branch-protection probe before depending on the renamed check.

State mapping:

| State | Meaning |
|---|---|
| `pending` | Review has not posted, review is queued/in progress, a posted review is waiting for the follow-up ledger to appear, remediation is queued/in progress, or a requested re-review has not posted yet. |
| `success` | The latest posted review settled as `Comment only` or `Approved` in its durable follow-up verdict carrier with no standing structured blocking findings; an infrastructure failure (timeout/bootstrap/cascade/failed/orphaned reviewer) has been surfaced for operator handling without implying a substantive review verdict; or a current scoped `operator-approved` label accepts the PR head regardless of review/remediation state and no explicit skip label is present. |
| `failure` | Review/remediation is malformed, stopped, missing a verdict, still blocked by `Request changes`, explicitly skip-labeled, or in an unknown state. |

Reason mapping:

| Reason | State | Meaning |
|---|---|---|
| `review-not-posted` | `pending` | No durable adversarial review row has posted yet. |
| `review-queued` | `pending` | The watcher has queued the adversarial review. |
| `review-in-progress` | `pending` | The reviewer subprocess is currently in flight. |
| `rereview-queued` | `pending` | A completed remediation round requested a fresh adversarial review that has not posted yet. |
| `review-retry-pending` | `pending` | A reviewer failure is retryable, but no more specific transient class is known. |
| `reviewer-timeout-retry-pending` | `pending` | The reviewer timed out and is waiting for retry/backoff. |
| `reviewer-bootstrap-retry-pending` | `pending` | The Claude launchctl/bootstrap path failed and is waiting for retry/backoff. |
| `reviewer-cascade-retry-pending` | `pending` | The reviewer hit a LiteLLM/upstream cascade and is waiting for retry/backoff. |
| `awaiting-ledger` | `pending` | A review was posted, but the follow-up job ledger has not appeared yet. |
| `remediation-queued` | `pending` | Follow-up remediation is queued. |
| `remediation-in-progress` | `pending` | Follow-up remediation is currently in progress. |
| `review-settled` | `success` | The latest review verdict is non-blocking. |
| `operator-approved` | `success` | A scoped operator approval accepts the current PR head regardless of review/remediation state. |
| `review-malformed` | `failure` | The durable review row is in a malformed terminal state, including but not limited to malformed-title. |
| `reviewer-timeout` | `success` | The reviewer timed out before posting after retry handling; the gate must not imply a substantive review passed. The watcher must make the operator action visible and, when the timeout follows a completed remediation that requested re-review, hand the PR to the merge-agent decision path. |
| `reviewer-launchctl-bootstrap` | `success` | The Claude launchctl/bootstrap path failed before posting; the gate reflects an operator-visible automation failure, not a substantive review verdict. |
| `reviewer-cascade` | `success` | The reviewer hit a LiteLLM/upstream cascade before posting; the gate reflects an operator-visible automation failure, not a substantive review verdict. |
| `review-failed` | `success` | The adversarial review failed before posting and no more specific class is known; the gate reflects an operator-visible automation failure, not a substantive review verdict. |
| `review-failed-orphan` | `success` | The watcher needs operator verification for a possible orphan review post; the gate reflects an operator-visible automation anomaly, not a substantive review verdict. |
| `review-state-unknown` | `failure` | The durable review row contains an unexpected state. |
| `blocking-review` | `failure` | The latest review verdict still requests changes. |
| `missing-verdict` | `failure` | The latest review body does not contain a usable verdict. |
| `unknown-verdict` | `failure` | The latest review body contains a malformed or unsupported verdict. |
| `remediation-failed` | `failure` | Follow-up remediation failed and needs operator action. |
| `remediation-stopped` | `failure` | Follow-up remediation stopped and needs operator action. |

Clean review verdicts still create follow-up jobs for auditability and gate projection. When the consumer sees a `Comment only` or `Approved` verdict with no standing structured blocking findings, it moves that job to `stopped` with `review-settled` instead of spawning a remediation worker. If a clean verdict body still contains a structured `## Blocking issues` section with any standing item other than `- None.`, merge-agent dispatch parks at `skip-blockers-present` rather than treating the verdict as settled-success. The `- None.` sentinel remains a fail-safe empty marker, not a license to free-form the section: same-line explanatory prose and indented wrapped continuation lines are tolerated, but flush-left follow-on prose or finding-card field markers are treated as blocker content so the gate refuses rather than silently opening.

Within the review body's `## Verdict` section, the authoritative verdict is the last recognized verdict line. If the section contains both a blocking `Request changes` verdict line, including clause forms such as `Request changes: ...` or `Request changes -- ... must be fixed`, and a permissive `Comment only` or `Approved` line, the parser resolves conservatively to `Request changes`; explanatory prior-round resolution prose only avoids this override when the request-changes clause is explicitly in a resolved state, such as `Request changes ... are now resolved` or `Request changes ... have been addressed`. Any negated, current, or future blocking phrase on the same line (`not fixed`, `still`, `remains`, `must be fixed`, `needs to be addressed`, etc.) keeps the line classified as blocking even if it quotes or mentions resolved-state language. If no line is recognized, the verdict remains malformed and the gate fails closed.

The watcher must project the gate on terminal early-exit paths, including already-posted review rows. A settled PR must not stay frozen at an earlier `pending` projection after the durable review verdict is available.

## Operator Retrigger Contracts

`retrigger-review` and `retrigger-remediation` are separate operator surfaces:

- `retrigger-review` resets the watcher delivery row to `review_status='pending'` so the watcher can post another adversarial review.
- `retrigger-remediation` bumps the remediation budget and requeues the latest eligible terminal follow-up job. It does not reset `reviews.db` first; the next fresh adversarial review must come from the requeued worker's durable `reReview.requested=true` reply during normal reconciliation. Eligible terminal jobs are `failed`, `completed` with `reReview.requested=true`, or `stopped` with one of `max-rounds-reached`, `round-budget-exhausted`, `daemon-bounce-safety`, or `review-settled`. `stopped:review-settled` is retriggerable because the automatic loop has settled the review as non-blocking, but an explicit operator action can still request a worker pass over the remaining findings. That retrigger is carried durably on `remediationPlan.nextAction={type:'consume-pending-round', operatorOverride:true, requestedAt, requestedBy, operatorVisibility:'explicit'}`; `claimNextFollowUpJob` must suppress the claim-time `review-settled` early-stop for that one claim, then consume the override by rewriting `nextAction` to `worker-spawn`. While the requeued job is `pending` or `inProgress`, the adversarial gate must stay pending rather than projecting the stored Comment-only verdict as settled. `stopped:operator-stop` and `stopped:rereview-blocked` are intentionally not retriggerable through this surface because those states encode operator intent or a watcher refusal that needs human handling.

For PR-side `retrigger-remediation` labels, a successful budget bump is the durable consumption boundary. Once the bump lands, the watcher must write the label-consumption record and operator-mutation audit before attempting the queue rearm. If requeue then fails, the watcher still removes the label and posts a failure-flavored acknowledgement that names the partial-success state; the same GitHub label event must not authorize another budget bump on retry.

The watcher must not run a fresh adversarial review while the latest follow-up job for the same PR is `pending` or `inProgress`. This guard is load-bearing for the PR #48 race: if an operator requeues remediation while the watcher row is already `pending`, the pending follow-up job wins and reviewer dispatch is deferred until the worker reaches a terminal state.

Re-review resets are also gated on branch cleanliness, not just `reReview.requested=true`. Before `requestReviewRereview` is allowed to move the watcher row back to `pending`, reconcile must have a proven PR base branch, fetch `origin/<baseBranch>`, and run `git cherry origin/<baseBranch> HEAD`. Legacy jobs without `baseBranch` are lazily hydrated from GitHub and persisted before any worker spawn or reconcile audit; if the real base cannot be proven, the job fails before defaulting to `main`. Any `-` marker means the remediation branch still contains a patch-equivalent copy of a commit already merged on the base branch, so reconcile must route that round to durable `failed:branch-contamination`, preserve the suspect commits on the failed job record, and post the normal reconcile-time remediation outcome comment instead of fabricating a new review pass. Operators recover by cleaning the branch and using `retrigger-remediation`; the stale `Request changes` review remains authoritative until a later clean round requests another pass.

## Reviewer Runtime Recovery Contract

The watcher's reviewer subprocess lifecycle is split across two durable ledgers:

- `data/reviews.db` keeps the review-delivery row for each PR, including `review_status='reviewing'` as the durable claim that a reviewer launch is in flight.
- `data/reviewer-runs/<sessionUuid>.json` keeps the runtime session record for that launch, including the adapter runtime id, process-group metadata, and the most recent lifecycle state observed by the runtime adapter.

`src/adapters/reviewer-runtime/cli-direct/index.mjs` is the canonical OAuth-first runtime today. When it advertises `oauthStripEnforced: true`, it must strip the full canonical OAuth fallback env set before spawning the reviewer subprocess: `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `AWS_BEARER_TOKEN_BEDROCK`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, and `GEMINI_API_KEY`. Partial stripping is a contract violation because downstream code trusts the adapter capability bit.

The cli-direct reviewer subprocesses are non-streaming. Claude `--print` and Codex `exec --json --output-last-message` can spend a healthy full review turn without writing stdout or stderr, so cli-direct disables the no-output progress watchdog and relies on the hard reviewer timeout for bounding runtime. `ADVERSARIAL_REVIEWER_PROGRESS_TIMEOUT_MS` remains the default for streaming subprocess helpers, but it does not apply to cli-direct reviewer launches.

Reviewer-runtime selection is controlled by `roles.adversarial.orchestration_mode`. In `native` mode, `domains/code-pr.json` remains the source of truth for the reviewer runtime. In `agentos` mode, first-pass reviewer launches use the `agent-os-hq` runtime so review work flows through Agent OS orchestration. The watcher refreshes the active runtime before startup recovery and at the top of each poll tick, keyed by the resolved mode plus the `domains/code-pr.json` mtime. Config-read failures in this refresh path keep the last-known-good mode, emit a deduplicated degradation signal, and must not prevent GitHub App token refresh; later strict config reads in the same tick may still fail until the operator fixes the invalid config. Adapter-construction failures keep the active adapter and must emit deduplicated degradation signals whether the failed rebuild is a mode switch or a same-mode domain refresh. Stored reviewer run records route reattach/cancel through their recorded runtime when possible; corrupt records, unknown stored runtimes, or stale domain config must be isolated per record and must not abort startup recovery or skip cancellation of other in-flight reviewers.

Reviewer and follow-up worker children are bounce survivors. They must be spawned as detached session/process-group leaders (`setsid` semantics; Node `detached: true` on supported POSIX hosts) with durable stdout/stderr side channels and without parent-exit cleanup hooks that reap the child on routine watcher or follow-up daemon exit. A routine `launchctl kickstart -k`, SIGTERM, poll-deadline respawn, or SQLite-orphan respawn preserves in-flight work; the restarted daemon reconciles the durable claim rather than cancelling the child.

On watcher startup, `reconcileReviewerSessions` and `recoverReviewerRunRecords` must reconcile every recoverable reviewer-run record before any new reviewer claim can be admitted. Records in `spawned`, `heartbeating`, or `cancelled` state are all recoverable. For a live reviewer, adoption requires the durable `reviews.db` `reviewing` claim plus the recorded PGID and identity verification: the runtime run record's spawn token (`reviewer_session_uuid` / `reattachToken`) must still identify the process, and the PGID start time must match the recorded `spawnedAt` within the existing `verifyPgidIdentity` tolerance. A verified live child remains `reviewing` and must not be double-spawned or killed. A dead child with no posted review may be requeued through the existing retry path; ambiguous identity remains sticky rather than signalling an unrelated PGID.

Follow-up remediation workers use the same lifecycle shape through their job JSON: `remediationWorker.processGroupId`, `processId`, `spawnedAt`, and worker artifacts are the durable adoption/cancel handles. The follow-up daemon's ordinary SIGTERM path stops the daemon loop only; it does not stop spawned workers. Reconcile adopts by reading the in-progress job record and worker artifacts, and operator cancellation uses `src/follow-up-stop.mjs` / `src/follow-up-worker-cancel.mjs` with PGID plus start-time identity checks.

The follow-up daemon also owns terminal workspace reaping for
`HQ_ROOT/adversarial-review/follow-up-workspaces/` or the configured remediation
workspace root. A workspace is eligible only when its `jobId` has a matching
terminal follow-up job record in `completed/`, `failed/`, `stopped/`, or
`stopped-archived/`, and that terminal record's semantic terminal timestamp is
at least 24 hours old. The workspace reaper deliberately does not fall back to
workspace directory mtime or job-file mtime when a terminal record is missing a
parseable terminal timestamp; it must skip the workspace, increment
`missingTerminalTimestamp`, and leave manual recovery to an operator who can
re-stamp the terminal record or remove the workspace after inspection.

Archive and workspace-reap maintenance cursors are persisted separately in
`data/follow-up-jobs/maintenance-sweeps.json`. A persistent failure in one step
must not force the other successful step to rerun every daemon tick, and failed
steps use the short retry cooldown before trying again. On first upgrade from
the legacy single archive cursor, the workspace-reap cursor may inherit the
legacy archive timestamp so the first reap can be deferred by up to one hour
instead of spiking immediately after deploy.

Workspace delete failures are isolated per entry. A failed `rm` must increment
the reaper error count, log the workspace path and error code, and continue to
later workspaces. For `EACCES` or `EPERM`, the daemon must not attempt
privileged deletion. Instead it writes a structured
`terminal-workspace-reap-permission-denied` anomaly under
`data/archive-anomalies/` with the runtime user, `HQ_ROOT`, workspace path,
ownership metadata when readable, and `action: "left-workspace-in-place"` for
operator follow-up.

Intentional teardown is a separate operator surface: `npm run hard-shutdown -- [reason]` runs `src/adversarial-hard-shutdown.mjs`, cancels every `review_status='reviewing'` reviewer and every in-progress spawned follow-up worker, waits for signalled process groups, and returns non-zero if any live worker could not be signalled or remained alive through the wait window. This command is the only normal lifecycle path that cancels children before the daemons drop; routine bounces are survive-and-reattach.

## Round-Budget Derivation

Every fresh follow-up job derives its default cap from the PR's current risk class: `low=1`, `medium=2`, `high=3`, and `critical=4`. The PR-wide completed-round count is carried into each new job, so the cap bounds the full PR cycle instead of resetting per job.

Carry-forward of ordinary persisted caps is intentionally removed: if the latest stored cap is equal to or below the current risk-class tier, the next job lets `createFollowUpJob` derive the current tier cap again. This keeps stale queue JSON from permanently lifting or lowering the remediation budget after the PR's governing risk class changes.

The migration guard is deliberately narrow. If the latest PR ledger cap is higher than the current risk-class tier, the reviewer carries that elevated value into the next job. That preserves legacy in-flight PRs and operator-raised escape hatches that would otherwise be silently truncated after they have already consumed more rounds than the new tier allows.

The sanctioned operator override is `npm run retrigger-remediation` or the PR-side `retrigger-remediation` label. Both paths record an explicit operator mutation; hand-editing queue JSON is not the supported way to raise the cap.

## Auto-Merge Convergence Loop

The pipeline closes the loop on a PR by handing it to a merge-agent once the adversarial review converges. The merge-agent runs in the host agent-os worker-pool, not in adversarial-review itself; adversarial-review's responsibility is to (a) decide when to dispatch, (b) build the dispatch prompt, (c) record the dispatch, and (d) clean up consumed trigger labels.

Every durable dispatch record under `data/follow-up-jobs/merge-agent-dispatches/` persists the dispatch `trigger`, the resolved worker-pool `priority`, and `priorityFlagSupported`. On fully rolled-out hosts `priorityFlagSupported` is `true` and `hq dispatch` received `--priority <lane>`; on mixed-version hosts the watcher retries once without `--priority`, records `priorityFlagSupported: false`, and still preserves the resolved priority selection for auditability.

## Fast-Merge Close Path

The follow-up daemon also owns a narrow fast-merge close path for PRs whose first-pass review was intentionally skipped into `reviewed_prs.pr_state='fast_merge_skipped'`. This path is active only for rows that already carry a proven `fast_merge_authorized_head_sha`; the label alone is never sufficient authority.

Each poll makes up to `DEFAULT_FML_MERGE_AGENT_PER_POLL_CAP = 5` terminal fast-merge transitions unless operators override the cap with `FML_MERGE_AGENT_PER_POLL_CAP`. Rows that are still pending may be scanned past the cap, within a bounded over-read, so a few old pending PRs cannot starve newer mergeable rows.

For each row the daemon must:

- Re-fetch the PR view and refuse the bypass if the live head no longer matches `fast_merge_authorized_head_sha`, except for the narrow HAM terminal-remediation carve-out below.
- Requeue normal first-pass review instead of merging when the head changed, `fast-merge-veto` is present, or the live fast-merge authorization label is absent.
- Validate CI with `gh pr checks --json name,state,bucket,workflow,link`, treating CLI exits `8` (pending) and `1` (failed) as data-bearing results when stdout contains parseable JSON rather than as transport failures, and treating the real `gh` "no checks reported" diagnostic as an empty check set.
- Re-fetch and re-summarize CI in the immediate pre-merge window, after the head/veto/authorization-label re-check and before the admin merge.
- Merge only with `gh pr merge --squash --admin --delete-branch --match-head-commit <authorizedHeadSha>` so GitHub rejects the merge if the head moved after the last verification step.

The `--admin` flag is an intentional branch-protection bypass for this lane. The safety floor is therefore explicit and cumulative: the row must already be in the watcher-authorized fast-merge state, the live head must still equal the authorized SHA, CI must summarize as successful, an allowlisted `fast-merge:*` label must still be present, and `fast-merge-veto` must remain absent. If any of those predicates stop being true, the daemon must fail closed to the normal adversarial-review path or leave the row in `fast_merge_skipped` for a later poll; it must not broaden merge authority.

The only supported changed-head exception is a HAM terminal-remediation commit
directly on top of the authorized head. That exception is fail-closed. For any
lane that waives stale-head, blocking-finding, remediation-state, or non-HAM
verdict failures, it requires all of the following before the daemon may replace
the exact merge head with the HAM head: the live commit's first parent is the
authorized head; the live GitHub commit has a non-empty diff; the commit trailers
include `Worker-Class: hammer`, `Worker-Ticket: HAM-<n>`, `Reviewed-Head:
<authorizedHeadSha>`, `Closed-By: hammer (adversarial-pipe-mode)`, and a
parseable `Remediated-Findings` count; a PR timeline comment from an allowlisted
hammer bot identity contains both the canonical `Closed-By` marker and the same
findings count; and the local AMA audit JSON at
`$HQ_ROOT/dispatch/audit/adversarial-merge-authority/<repo>-pr-<n>-<liveHead>.json`
matches the exact `(repo, pr, liveHead)` tuple with a latest
`preMergeEligible: true` attempt whose `headMatchEvidence` is
`ham_terminal_remediation_validated`. The audit JSON must be owned by the
configured HQ owner, must not be world-writable, and an `in_progress` audit is
authoritative only while the matching AMA closer lease for `(repo, pr, liveHead)`
is still `dispatched`; a `succeeded` audit is terminal authority. In the narrow
strict-non-blocking lane, the eligibility predicate may also accept an active HAM
closer session when the only HAM-waived reasons are
`non-blocking-findings-present` or `non-blocking-findings-unknown` and the paired
`verdict-not-settled-success`, but the active state is authoritative only after
the predicate verifies the live HAM commit, reviewed-parent/current-head match,
non-empty diff, HAM worker trailers, allowlisted audit-comment author, matching
audit-comment body, and doc-currency evidence from trusted inputs. That trust
does not extend to `Request changes`, bare verdict failures, blocking findings,
stale review heads, or unknown/pending remediation state. Commit
trailers and PR comments are attacker-controlled corroborating evidence, not
sufficient authority. If `HQ_ROOT` is unset, the audit record is absent,
untrusted, not keyed to the live head, missing its matching closer lease, the
comment is by the commit author alone, or the comment only echoes the findings
string without the `Closed-By` marker, the daemon requeues normal first-pass
review and never merges the changed head. The requeue audit records the precise
HAM rejection reason so operators can distinguish missing HQ roots, untrusted
audit files, bad provenance, missing comments, and lease drift.

Fast-merge state transitions are audit-bearing. Successful merges persist `fast_merge_merged`; closed-unmerged PRs persist `fast_merge_closed`; deterministic refusals while the PR is provably still open persist `fast_merge_blocked`. Merge CLI errors are not authoritative on their own: before recording `fast_merge_blocked`, the daemon must re-fetch PR state and treat an already-merged PR as `fast_merge_merged` so a server-side merge followed by client timeout or branch-delete failure does not strand the row in a false blocked state. Merge audits should capture the real merge commit SHA from `gh pr view --json mergeCommit` when available rather than regex-scraping CLI output. Fast-merge audit JSON belongs under `data/fast-merge-audits/` rather than the reviewer runtime state directory, uses an explicit audit type to distinguish skip vs. close records, and must leave a pending retry marker on the row if a terminal close-path audit write fails.

### Dispatch trigger

`src/follow-up-merge-agent.mjs::pickMergeAgentDispatchDetail` evaluates dispatch in layers instead of applying one universal gate matrix to every trigger:

1. **Universal hard gates:** every dispatch path first requires `prState === 'open'` and `merged === false`, and refuses dispatch when `do-not-merge`, `no-merge-hold`, or `merge-agent-skip` is present. `merge-agent-stuck` is also a skip label by default, but a scoped current-head `merge-agent-requested` label is allowed to bypass that one marker for explicit operator recovery after the watcher exhausts its same-head retry budget. Duplicate dispatches for the same `(repo, prNumber, headSha)` are also blocked unless the watcher proves the recorded dispatch reached a watcher-owned retry state described below.
2. **`operator-approved` override:** a scoped `operator-approved` label is checked before the active-remediation gate. It can bypass review-verdict and remediation-round state for the current head, including a `request-changes` verdict or in-flight remediation, but it still requires `mergeable === 'MERGEABLE'` and a checks rollup of `SUCCESS`. That rollup excludes only the adversarial-review pipeline's own gate commit status (`agent-os/adversarial-gate` by default, resolved through `resolveGateStatusContext()`), because that status merely mirrors the already-known review verdict and would otherwise create a circular wait. Missing or malformed rollups remain unknown and still block this path; real external CI check runs and other status contexts continue to gate normally.
3. **Normal verdict path:** without a live override label, the latest follow-up job for the current head SHA must NOT be `pending` or `in-progress` (`in_progress` in the durable queue is normalized to `in-progress` at the merge-agent boundary). Older-head follow-up jobs do not block convergence for a newer reviewed head. Before any normal-verdict dispatch, the watcher reads the latest structured `## Blocking issues` section. Any known standing blocker (`blockingFindingCount > 0`) parks the dispatch at `skip-blockers-present` for every verdict, including `comment-only` and `approved`, unless a scoped operator override applies. Recovery is a fresh structured review whose blockers are `- None.`, a scoped `operator-approved` label that explicitly accepts the blockers, or a scoped `merge-agent-requested` label for that head. A clean `comment-only` verdict with no standing blockers dispatches immediately. That clean-verdict dispatch now carries the same converge-and-merge prompt contract as the budget-exhausted final pass: run `comment_only_followups.py`, apply actionable in-scope findings inline, wait only for real external CI on the pushed head, ignore the adversarial-review gate status as a merge blocker, and request another adversarial pass only for major in-PR refactors. A `request-changes` verdict dispatches only when the remediation budget is exhausted; if more rounds are claimable, the merge-agent waits for current-head remediation instead of racing it.
4. **`merge-agent-requested` override:** a scoped `merge-agent-requested` label is the explicit "run the merge-agent now" escape hatch. "Scoped" is load-bearing: the watcher accepts the label only when the latest attributable GitHub `labeled` event is attached to the current head SHA, carries durable audit identity (`eventId` / `nodeId` plus `observedAt`), and is not older than the latest PR update on that same head. Same-login application is valid at single-operator scale; freshness and head scoping are the safety checks. When scoped, the label still respects the universal hard gates and the active-remediation guard, but it can bypass mergeability, checks, verdict parsing, and remediation-round exhaustion so the merge-agent can rebase or clean the branch on demand.

For clean-verdict and final-pass dispatches, the merge-agent prompt authorizes
only in-scope fixes needed to converge and merge, but that scope includes
doc-currency for the change the worker lands. If the pushed diff changes a
persistent store shape and `docs/data-model/` exists in the PR repository, the
merge-agent must update the matching `docs/data-model/NN-*.md` domain doc and
`docs/data-model/catalog.json`, then run
`node scripts/validate-data-model-catalog.mjs`; a failing catalog validator is a
merge-blocking check. If the diff changes a module's public interface, dispatch
flow, or operational contract and the affected module has
`modules/<name>/<name>-walkthrough.md`, the merge-agent must update that
walkthrough. Repositories without those documentation surfaces are exempt; if a
submodule change owes documentation in a superproject, the merge-agent records
the skipped superproject-doc obligation in its audit or closing comment instead
of inventing local docs.

AMA closer labels are separate from the merge-agent dispatch labels above. `adversarial-merge-blocked` is an AMA-only hard stop: when the current PR labels include it, AMA closure is refused unless a non-null, attributable label-event snapshot proves the latest block event is stale or unapplied for the current head. Missing or null block evidence fails closed on raw label presence. `adversarial-merge-requested` is an AMA-only risk-class request: it must be an attributable non-author label event scoped to the current head and bypasses only AMA's risk-class gate. It is mandatory for unknown risk, and for high/critical risk unless `eligibility.high_risk_requires_two_key=false` and the concrete risk class is included in `risk_classes`; in that configured single-key mode, high/critical follow the same risk-class gate as low/medium. Whenever two-key is required, `adversarial-merge-requested` still needs simultaneous scoped `operator-approved` evidence plus all structural hard gates. The watcher initializes both labels idempotently by name and preserves operator-customized colors/descriptions.

When AMA does not dispatch and the watcher parks at await-operator, the log
line includes a stable `namedReason` token for operator scraping. For
eligibility misses, `namedReason` is `not-eligible:<first-reason>`; the full
ordered eligibility list remains in the separate `reasons:` field. Other
no-dispatch outcomes use their `reason` value as `namedReason`.

5. **Final-pass-on-budget-exhausted:** when `MERGE_AGENT_FINAL_PASS_ON_REQUEST_CHANGES=1` is set in the per-call env (set on the follow-up daemon LaunchAgent in this repo) AND `remediationCurrentRound >= remediationMaxRounds` AND the verdict is still `request-changes` AND no scoped `operator-approved` label is present, the watcher first inspects the latest structured `## Blocking issues` section. A legacy or malformed `Request changes` review with no structured blocking section produces `skip-blocking-findings-unknown` and still fails closed. When blocker state is known, the watcher now emits **distinct machine-readable final-pass modes**:
   - standing blockers dispatch exactly once per PR/head progression with trigger `final-pass-blocker-remediation`, `MERGE_AGENT_BLOCKER_REMEDIATION_REQUIRED=1`, and `MERGE_AGENT_BLOCKING_FINDING_COUNT=<n>` so downstream code can refuse merge without parsing prompt prose;
   - zero blockers dispatch with trigger `final-pass-on-budget-exhausted` and `MERGE_AGENT_BLOCKING_FINDING_COUNT=0` for the traditional merge-by-default deadlock case.
   If the fresh post-remediation review still reports standing blockers, the single automatic blocker pass is consumed and the watcher hard-stops with `skip-blockers-present`, `handoffRequired=true`, and `merge-agent-stuck` so the operator handoff is visible in the normal stuck queue rather than only in logs. The current implementation keys that "already spent" check per PR lifetime by looking for any prior blocker-remediation dispatch recorded for the same `(repo, prNumber)` on a different head SHA; it is not reset by later heads unless the code changes. Reviews whose blocking section parses to the explicit `- None.` sentinel remain eligible for the traditional final-pass dispatch-and-merge path. The merge-agent's own `comment_only_followups.py` sub-worker is then responsible for the final substance triage: **apply every actionable in-scope reviewer finding inline (trivial polish and substantive non-trivial work alike), merge after light-to-medium fixes, and request a fresh review pass only for major in-PR refactors**. The previous policy of "apply trivial, defer non-trivial" is gone for the zero-blocker final-pass path — see the "Apply, don't defer" subsection below — while the standing-blocker path is explicitly remediate-and-rereview, never merge-on-first-dispatch. The merge-agent hard-refuses (`merge-rejected`) when the sub-worker surfaces a non-empty `blockers_observed` list (data corruption, secret leakage, security regression, broken external contract); blocker receipts/log summaries include only blocker count and normalized kinds, while detailed payloads stay in `.adversarial-follow-up/followups-reply.json` so secret-leakage findings are not echoed back into public surfaces. The dispatched worker receives the trigger via the `MERGE_AGENT_DISPATCH_TRIGGER` env var (machine-readable) AND in the rendered prompt's `{{DISPATCH_TRIGGER}}` placeholder, so the merge-agent's adapter and prompt can branch on dispatch mode without parsing markdown. The universal hard gates, the `mergeable === 'MERGEABLE'` requirement, and the `SUCCESS` check rollup requirement all still apply — failing CI or a conflicted PR still skips even with the flag enabled.

### Dispatch priority

Merge-agent priority is narrower than merge-agent triggering:

- Default behavior is `--priority normal` for clean-verdict dispatches, `operator-approved`, and `final-pass-on-budget-exhausted`.
- Only the scoped `merge-agent-requested` trigger uses `--priority critical`.

That split is intentional. `merge-agent-requested` is the operator's explicit stuck-branch escape hatch, and the observed 2026-05-19 outage was exactly that path getting wedged behind `refuse_admit_memory_pressure`. By contrast, clean-verdict and final-pass merge-agents can run for minutes, push commits, and wait on checks; sending every one of those to the single reserved critical lane would turn a PR-local admission problem into fleet-wide starvation of genuinely urgent critical work.

The worker-pool priority lane is governed by `HQ_PRIORITY_LANE_CAPACITY` (default `1`). When that env var is `0`, the reserved lane is disabled and a `critical` dispatch no longer bypasses memory-pressure refusal; it degrades to ordinary high-priority admission. Operators investigating contention should check `hq priority-lane status --root /Users/airlock/agent-os-hq` alongside the recorded dispatch JSON and the individual LRQ state from `hq dispatch status <dispatchId>`.

Because watcher and worker-pool can roll out independently, `src/follow-up-merge-agent.mjs::dispatchMergeAgentForPR` must treat an explicit CLI rejection of `--priority` as a compatibility downgrade, not a hard dispatch failure. The watcher first tries the flagged invocation, then retries once without `--priority` only for the specific unknown-argument / unrecognized-argument class of error. Any other `hq dispatch` failure still aborts the launch normally.

### Merge-agent original-worker preparation

Before `src/follow-up-merge-agent.mjs::dispatchMergeAgentForPR` launches `hq dispatch --worker-class merge-agent`, it runs `prepareOriginalWorkerForMergeAgent` to free the PR branch from the original builder worktree without reaching for `git worktree add --force`.

- The original worker id is derived from the PR branch prefix, then validated against the recognized worker-id shape before any filesystem probe or `hq` invocation. Recognized worker-id prefixes include the canonical reviewer/builder worker classes (`codex`, `claude-code`, `clio-agent`, `gemini`, `pi`, `opencode`, `hermes`) plus merge-agent and test stub prefixes. Human branches like `paul/my-feature` do not opt into teardown; suspicious or non-worker-shaped prefixes emit `merge_agent.tear_down_skipped` with reason `unrecognized-worker-id-shape`.
- If the worker directory is gone, or the recorded worktree path no longer exists on disk, prep returns `decision: 'ready'` with reason `original-worker-already-torn-down`. This is the idempotent "already gone" exit.
- If `HQ_ROOT/workers/<workerId>/workspace.json` is missing while the worker directory still exists, prep logs `merge_agent.workspace_missing` and returns `decision: 'deferred'` with reason `workspace-json-missing-but-worker-dir-present`. A missing marker file is not treated as proof that the branch is free.
- If the workspace file cannot be read for a reason other than `ENOENT` (for example permissions drift or malformed JSON), prep logs `merge_agent.workspace_read_failed` with the errno/detail and returns `decision: 'deferred'`. Read failures are not treated as proof that the branch is free.
- If `workspace.json` is present, prep validates both `workspace.workerId` and `workspace.branch` against the derived worker id and PR branch before any teardown. Mismatches emit `merge_agent.tear_down_skipped` and return `decision: 'ready'` without touching the worker.
- If the worker directory and worktree still exist, prep consults `worker_runs.status` from the session ledger, resolving the DB from `AGENT_OS_SESSION_LEDGER_DB_PATH`, `HQ_ROOT/.hq/config.json#ledgerDbPath`, the deploy-checkout ledger, the HQ-root owner's canonical `$HOME/.agent-os/session-ledger/ledger.db`, or the runtime user's canonical ledger path. Every sqlite candidate, including env overrides and legacy HQ config, must exist and contain the requested session-ledger tables before it wins; stale stubs fall through to the next candidate. The merge-agent lookup does not use `process.cwd()` as a ledger root because watcher cwd/worktree cwd is not authoritative for merge prep. `worker_runs` lookups keep last-inserted semantics with `ORDER BY rowid DESC LIMIT 1`. When the row is missing but the worktree is still present, prep logs `merge_agent.dispatch_deferred` and returns `decision: 'deferred'` with reason `original-worker-run-row-missing-but-worktree-present`; ledger drift is not treated as branch freedom, and override-triggered dispatches do not bypass that fail-closed liveness check.
- `src/session-ledger-read-adapter.mjs::readLatestWorkerRunStatusFromLedger` is the backend-neutral "latest worker run" reader for remediation and merge-prep callers. For both SQLite and Postgres it defines "latest" as the row with the greatest `COALESCE(updated_at, ended_at, started_at, '')`, then `COALESCE(ended_at, started_at, '')`, then `COALESCE(started_at, '')`, with `run_id DESC, launch_request_id DESC` as deterministic tiebreakers; the contract no longer depends on SQLite `rowid`. The Postgres path shells out synchronously to `psql` with `--no-psqlrc`, `ON_ERROR_STOP=1`, and a 30s hard timeout (`SIGKILL` on expiry); the synchronous call is intentionally bounded so the long-lived follow-up daemon cannot hang forever, but operators should treat a slow Postgres lookup as consuming up to one 30s event-loop stall per merge-prep attempt until this path graduates to an async client. `launch_request_id` is passed through `psql -v` substitution instead of SQL string concatenation. When a URL or libpq `key=value` Postgres DSN embeds credentials, the adapter strips the password from argv and injects it through `PGPASSWORD` so host-level process listings do not expose the secret; password-bearing libpq DSNs that cannot be parsed safely fail closed as malformed ledger targets.
- Prep may tear down the original worker only when the current `worker_runs.status` is terminal according to the session-ledger contract (`succeeded`, `failed`, or `cancelled`). A non-terminal status logs `merge_agent.dispatch_deferred` with `reason: worker-run-status-<status>`.
- Operational lookup failures such as `missing-ledger-db`, `better-sqlite3-unavailable`, `worker-run-lookup-failed`, `worker-run-lookup-threw`, `unsupported-ledger-backend`, `malformed-ledger-target`, and `missing-launch-request-id` become explicit skipped-dispatch records instead of unbounded silent deferrals. `worker-run-lookup-failed` remains the canonical merge-agent reason for adapter read faults even when backend-specific adapters surface aliases such as `ledger-read-failed` or `psql-not-installed`, and `better-sqlite3-unavailable` still logs a loud dependency error. `session_ledger.backend=postgres` now reads through `psql` with the bounded/no-password-on-argv behavior above; `unsupported-ledger-backend` remains the deliberate fail-closed path for backend values other than `sqlite` or `postgres`, rather than falling through the ambiguous deferred path. Convergence parks caused by standing blockers (`skip-blockers-present`) in any verdict path, by the second blocked final-pass observation after the one automatic blocker-remediation dispatch has already been consumed, or by legacy/unknown blocker state (`skip-blocking-findings-unknown`) in the final-pass path write the same durable skipped-dispatch record under `data/follow-up-jobs/merge-agent-skips/` with the blocker count/state.
- The mutating teardown call honors Agent OS ownership boundaries. If `HQ_ROOT` owner cannot be proven, the runtime user cannot be resolved, or the watcher user differs from the HQ owner, prep emits `merge_agent.tear_down_skipped` and returns `decision: 'deferred'` without attempting cross-user mutation. Successful teardown logs `merge_agent.original_worker_torn_down` with the PR number, original worker id, worker status, and launch request id.

The four stable prep outcomes are therefore:

- `ready` because no worker-authored branch was detected or the original worker was already gone.
- `deferred` because the original worktree is still present but not yet safely reclaimable.
- `torn-down` because prep reclaimed the branch successfully.
- `dispatch-deferred` at the caller boundary when `dispatchMergeAgentForPR` receives a prep `decision: 'deferred'` and skips the merge-agent launch for that watcher tick.

A clean (`comment-only`) verdict triggers the merge-agent immediately on the first review pass that returns clean — the dispatch path does NOT wait for the round budget to exhaust. Waiting for the budget cap on a clean verdict was the gate that left PR #90 stuck in May 2026 burning unused remediation rounds with nothing to remediate. Once dispatched on that clean verdict, the merge-agent follows the same merge-by-default convergence contract as the final-pass trigger, except without the budget-exhausted framing: it should finish bounded in-PR follow-ups, wait only for real external CI, and merge unless the work turns into a genuinely major in-PR refactor that merits re-review. Rounds-available remains a gate for `request-changes` verdicts so the merge-agent does not race an in-flight remediation cycle.

Concrete contract example used by operator docs and regression tests:

1. Review round 2 posts `Comment only` for current head `abc123`.
2. The watcher, not `follow-up-jobs.mjs`, evaluates merge dispatch for `abc123`.
3. If the latest structured `## Blocking issues` section is `- None.`, the watcher dispatches merge-agent and records the handoff under `data/follow-up-jobs/merge-agent-dispatches/<repo>-pr-<n>-abc123.json`.
4. If the PR still carries a `merge-agent-requested` label from older head `def456`, that label is stale and does not authorize anything for `abc123`.
5. If `abc123` already has a dispatch record or a live `merge-agent-dispatched` handoff, the watcher returns `skip-already-dispatched` instead of launching a duplicate worker.
6. If the same `Comment only` review still lists a real blocking issue, the watcher returns `skip-blockers-present` (ARP-06 / #157) and keeps the PR out of the merge path until a fresh structured clean review or a scoped current-head operator override exists.

#### Why a fifth dispatch path exists

Without the final-pass path, every PR whose verdict never converges to `Comment only` halts at `max-rounds-reached` and waits for the operator. In practice the codex reviewer almost always returns `Request changes` because the reviewer prompt is adversarial by design; the lenient final-round addendum relaxes *categorization* but keeps the *verdict* at `Request changes` whenever any finding remains. Result: the auto-merge daemon never auto-merged a single PR in the observed window leading up to 2026-05-14. The final-pass dispatch path closes that loop by giving the merge-agent itself the responsibility for the final substance check — the merge-agent's `comment_only_followups.py` is the right place to decide whether reviewer findings warrant blocking a merge or warrant another review round on a freshly-pushed head.

This is a behavioral expansion of the merge contract, **enabled by default in code** as of 2026-05-16 (see `isFinalPassOnRequestChangesEnabled` in `src/follow-up-merge-agent.mjs`). The legacy halt-at-max-rounds behavior stranded every PR at the operator's desk — the remediation worker is not the right actor to decide whether a PR can merge on its final commit, and the merge-agent + `comment_only_followups.py` sub-worker are the right place for the final substance triage. The `MERGE_AGENT_FINAL_PASS_ON_REQUEST_CHANGES` env var stays as an explicit off-switch (`=0`, `=false`, or `=no`) for OSS deployments or forks that need the legacy halt behavior. The merge-agent decision happens in the **watcher** process, so any environment override must be set on the watcher LaunchAgent (not the follow-up daemon). The universal hard-skip labels (`do-not-merge`, `merge-agent-skip`, `merge-agent-stuck`) work as emergency brakes per-PR regardless. Re-tune risk-class budgets independently if needed.

#### Apply, don't defer

The previous final-pass contract instructed the `comment_only_followups.py` sub-worker to apply trivial findings inline and defer non-trivial findings to operator handoff (`fail_with_receipt 13 merge-rejected`). That gate fired on the dominant path — most non-trivial reviewer findings — and effectively meant the auto-merge loop never closed on its own. The current contract for clean-verdict dispatches and zero-blocker final passes is:

- The sub-worker **applies every actionable in-scope reviewer finding inline**, trivial or non-trivial. It edits the workspace, commits each logical adjustment, and reports the changed files in `files_changed`.
- If applying a finding would require more than one PR (multi-PR scope, schema-migration plan, cross-module refactor, refactor that changes PR intent), the sub-worker records it under `suggestions_unable_to_apply` with a concrete reasoning string and the merge-agent files Linear tickets for each follow-up. These tickets are the durable follow-up mechanism; they are not merely listed in a PR comment. The merge-agent then proceeds with the merge when no blocker remains.
- If a finding describes a **blocker-class** problem the sub-worker cannot safely fix in this PR — data corruption, secret leakage, security regression, broken external contract — the sub-worker records it under `blockers_observed`. The merge-agent hard-refuses (`merge-rejected`) when this list is non-empty even if other findings were applied successfully.
- Inline review comments (line-anchored review comments on the PR diff, head-filtered to the reviewer-bot logins) are pulled into the sub-worker's prompt via `{{REVIEWER_INLINE_COMMENTS}}` so the sub-worker treats them as findings on par with the review body.

In short: non-trivial work that fits in this PR is no longer an operator-handoff trigger. The merge-agent applies light-to-medium edits, force-pushes, waits for checks, and merges. It requests another review only for major in-PR refactors. Follow-up refactors outside the PR boundary become Linear tickets and do not strand the current PR.

### Convergence cycle

Each merge-agent invocation either MERGES the PR or exits with `awaiting-rereview` to hand control back to adversarial-review. The cycle then iterates:

1. Adversarial review pass returns a verdict.
2. If `comment-only` → merge-agent dispatches.
3. Merge-agent attempts the rebase / response / push flow.
4. If the merge-agent makes major in-PR refactor changes, it exits `awaiting-rereview` and force-pushes the new head. The watcher's next tick sees a new head SHA, schedules a fresh review pass, and the cycle continues from step 1. Suppress that stale-posted-review auto-refresh only while the merge-agent is provably still converging for the current head: a current-head scoped `merge-agent-requested` label or a live current-head dispatch state. Raw label presence by itself is not authoritative because cleanup lag and stale labels must not wedge the rereview handoff. Light-to-medium edits do not take this path; they are pushed, checked, and merged.
5. If the merge-agent makes no substantive changes (clean rebase, no follow-up code edits) AND the PR's checks remain green for the rebased SHA, it merges via `gh pr merge --squash`. The standard merge-agent path does not use `--admin`; required GitHub checks and branch protection must still gate the merge.

The cycle terminates when (a) the merge succeeds, (b) the operator applies a skip label, or (c) the merge-agent applies `merge-agent-stuck` after exhausting its retry policy, or the watcher applies `merge-agent-stuck` after a phantom-handoff escalation. The round budget caps the adversarial review side; the merge-agent's own retry policy caps the merge side. Neither bounds the OTHER side, so a worst-case cycle is `rounds × merge-attempts` — operators should keep the budgets aligned.

### OSS guard

`src/follow-up-merge-agent.mjs::detectAgentOsPresence` runs before every dispatch. If `hq` is not on PATH and `HQ_BIN` is unset and the operator has not set `ADV_REVIEW_MERGE_AGENT_AGENT_OS=1`, the dispatch path returns `{ decision: 'skip-no-agent-os' }` without invoking hq. This keeps OSS deployments and CI sandboxes usable: the watcher, reviewer, remediation, and verdict pipeline continue working; auto-merge becomes a manual operator step. Detection merges any per-call environment override over `process.env` before probing or launching, so sparse overrides do not drop PATH, HOME, auth, or other runtime state. An explicit `hqPath` argument takes precedence over ambient `HQ_BIN`; `HQ_BIN` and PATH resolution are fallbacks only when the caller did not supply a non-default binary path.

The operator can also force-disable merge-agent on a host that DOES have agent-os installed by setting `ADV_REVIEW_MERGE_AGENT_DISABLED=1`. This is the supported way to pause auto-merge during a release freeze without touching the source. A skipped launch writes an explicit record under `data/follow-up-jobs/merge-agent-skips/<repo>-pr-<n>-<headSha>.json` so operators can distinguish an intentional OSS/disabled-mode skip from an unobserved watcher tick.

### Trigger labels

- `operator-approved` — scoped operator override for the current head SHA. It bypasses review/remediation-state gates, including an active remediation job, but does NOT bypass open-PR, hard-skip, mergeability, or green-check requirements. Consumed (removed from the PR) after a successful dispatch, or after an acknowledged `skip-no-agent-os` when agent-os is missing or merge-agent dispatch is force-disabled.
- `operator-approved: advisory-only-review` — scoped reviewer-posting override for the current head SHA. When the reviewer-generated head still matches the live PR head and the latest GitHub `LabeledEvent` for this label is attributable to a non-author actor, carries an event id/node id, and is scoped to that head, the reviewer posts an advisory-only review header and does not enqueue a follow-up remediation job. Missing label-event evidence, an `unknown` actor, author self-application, stale head scope, or a reviewer/live-head mismatch all fail closed to normal enforcement mode. Advisory-only still writes the posted review row, so a `Request changes` advisory review remains visible to the adversarial gate; the intended convergence path is operator/manual action or label removal followed by a normal re-review.
- `pr-class: additive-only` — PR classification label for diffs that should remain within the additive-only allowlist (`projects/*`, worker-pool post-merge action packs, and audit/postmortem docs). Raw label presence enables enforcement across all PR commits. The reviewer may backfill the label when the initial commit is entirely allowlisted; later out-of-allowlist files produce a structured `scope-violation` finding and suppress automated remediation/merge-agent dispatch.
- `operator-approved: scope-expand` — scoped additive-only override for the current head SHA. It is accepted only from the latest attributable non-author `LabeledEvent` after the latest observed head-changing timeline event, and the latest observed head SHA must match the live PR head when the event carries a SHA. Author self-application, unknown actors, unknown PR author, stale label order, and head mismatch fail closed. This exact label does not count as the generic `operator-approved` merge override.
- `adversarial-merge-blocked` — AMA-only hard stop for the current head. It overrides AMA closure even when review, risk, and `operator-approved` would otherwise pass; authors may apply it to block their own PR, and AMA never removes it automatically.
- `adversarial-merge-requested` — AMA-only scoped request to evaluate closure on an otherwise risk-class-blocked PR. It is accepted only from an attributable non-author current-head label event, bypasses only the AMA risk-class gate, and is not a merge-agent fallback trigger.
- `merge-agent-requested` — explicit scoped request to fire a merge-agent pass for the current head SHA even when the standard verdict gate would skip. It still respects open-PR, hard-skip, active-remediation, and duplicate-dispatch guards, but it can bypass mergeability, checks, verdict parsing, and remediation-round exhaustion. Consumed after a successful dispatch, or after an acknowledged `skip-no-agent-os` when agent-os is missing or merge-agent dispatch is force-disabled.
- `reviewer-cycle-cap-reached` — watcher-owned pause label applied when the review-cycle cap is exceeded. Operators clear that pause by applying exactly one of `operator-approved`, `merge-agent-requested`, or `paused-for-redesign`; the first two restore the row to `posted` for the existing merge-agent override lanes, while `paused-for-redesign` leaves review paused.
- `merge-agent-skip`, `do-not-merge`, `no-merge-hold` — hard skips that even an operator-approved or merge-agent-requested label does not bypass. `merge-agent-stuck` is a hard skip by default, but a scoped current-head `merge-agent-requested` label may bypass it for explicit operator recovery.

The `final-pass-on-budget-exhausted` trigger is **not** a label — it is selected automatically by the dispatch decision tree when the env flag is set and the round budget is consumed. There is no GitHub-visible label for it; the audit trail is the dispatch record (`data/follow-up-jobs/merge-agent-dispatches/<repo>-pr-<n>-<headSha>.json`, `trigger`, `priority`, and `priorityFlagSupported` fields) plus the `MERGE_AGENT_DISPATCH_TRIGGER` env var passed to the worker.

Advisory-only review posts use this exact public header shape:

```text
## Adversarial Review (advisory-only) — <displayName> (<reviewerIdentity>)

**Advisory-only review** — findings below are informational; no automated remediation will run.
```

Normal enforce-mode review posts continue to use:

```text
## Adversarial Review — <displayName> (<reviewerIdentity>)
```

Consumers that locate adversarial-review posts must treat both headers as
adversarial reviews because both begin with the canonical `## Adversarial
Review` marker. Consumers that need to distinguish advisory-only from enforce
mode must classify the first line exactly: the parenthetical
`(advisory-only)` after `Adversarial Review` is the advisory marker; its
absence is enforce mode. The bold advisory disclaimer is human-facing context
only and is not the primary machine classifier.

Advisory-only mode is intentionally not represented as an advisory durable job. `queueFollowUpForPostedReview` short-circuits before job creation, so persisted follow-up records keep `verdict_mode: "enforce"` as an enforcement-carrier compatibility field. Code that needs to know whether a review was advisory should use the reviewer post/header path and the `queueFollowUpForPostedReview` return reason `advisory-only-review`, not infer it from pending job records.

Repeated reviewer no-output timeouts are infrastructure failures, not substantive review rounds. They must not increment the remediation round counter or make the next reviewer pass "final" by themselves. After two timeout-class failures for the same PR head, the watcher may switch to the alternate reviewer model for the next retry only when an operator explicitly opts in (`ADVERSARIAL_REVIEW_TIMEOUT_FALLBACK_MODEL=claude|codex`; the default is `off`). Timeout exhaustion is scoped to the head SHA that the timed-out reviewer attempted; a new PR head must not inherit the previous head's timeout budget. If the timeout budget is exhausted after a remediation round completed with `reReview.requested=true`, the watcher must not strand the PR behind a green-ish timeout gate: it routes the head through the same AMA/merge-agent coexistence matrix used by the normal watcher handoff. With AMA disabled, the `reviewer-timeout-exhausted` merge-agent trigger runs unchanged. With AMA enabled, the watcher first tries the AMA closer; true AMA eligibility misses still park at await-operator unless a fresh scoped `merge-agent-requested` event authorizes the operator-fallback lane, but AMA launch/status failures recover by dispatching merge-agent with `AMA_OPERATOR_MERGE_AGENT_OVERRIDE=true` so a transient AMA outage does not become a durable manual park. Because the downstream timeout path still has no fresh review of the post-remediation diff, it parks at `skip-blocking-findings-unknown` unless a scoped `operator-approved` override explicitly accepts the head; standing blockers still park at `skip-blockers-present`. A non-mergeable or checks-blocked PR records a durable skip under `data/follow-up-jobs/merge-agent-skips/` with the timeout trigger so operators see a concrete mergeability/check blocker instead of an ambiguous stalled review.

### Merge-time DAG autowalk

When the watcher observes an open PR transition to merged, it records owed
`hq dag autowalk-on-merge --repo <repo> --pr <n>` work before it marks the
SQLite lifecycle mirror merged. This is the AMA/DAG bridge for PRs merged by
AMA or merge-agent through `gh pr merge`: the legacy `hq adjudicate merge`
`dag_on_merge` hook did not run, and the broad periodic DAG sweep can miss the
specific just-merged D5 step long enough to strand the run. The subcommand is
self-gated by Agent OS (`HQ_AUTO_DAG_WALK`) and is a clean no-op for non-DAG
PRs, so the watcher records the owed work for every observed merge rather than
trying to pre-classify DAG membership.

The owed-work record lives at
`data/follow-up-jobs/dag-autowalk-on-merge/<repo>-pr-<n>.json`. The watcher
removes it only after the hq command exits successfully. Nonzero exits,
timeouts, missing `HQ_BIN`, SQLite locks, and other launch/runtime failures keep
the record on disk with `attempts`, `lastAttemptAt`, `lastError.exitCode`,
`lastError.signal`, and captured stdout/stderr. Later watcher ticks retry
eligible records even though the PR row is already marked merged. Each
`pollOnce` tick runs one global retry pass after lifecycle sync has enqueued any
newly merged PRs; lifecycle sync itself does not run retries inside the per-PR
loop. The retry path is paced and bounded per poll so a broken hq installation
cannot monopolize the watcher:
`ADVERSARIAL_DAG_AUTOWALK_ON_MERGE_RETRY_MS` defaults to 5 minutes,
`ADVERSARIAL_DAG_AUTOWALK_ON_MERGE_PER_POLL` defaults to 2, and
`ADVERSARIAL_DAG_AUTOWALK_ON_MERGE_TIMEOUT_MS` defaults to 2 minutes. After
`ADVERSARIAL_DAG_AUTOWALK_ON_MERGE_MAX_ATTEMPTS` attempts (default 5), the
record stays in `status: "failed"` with terminal diagnostics for operator
repair instead of being silently discarded.

### Poll tick review-adoption priority

Within one watcher `pollOnce` tick, first-pass reviewer dispatch candidates must
drain before posted-review merge handoffs, lifecycle cleanup, DAG autowalk
retry, merge closeout retry, and proactive stuck/phantom maintenance. This
ordering is the guardrail from
`docs/INCIDENT-2026-06-20-review-adoption-starved-by-merge-handoff.md`: slow
merge-side shell children must not prevent newly discovered PRs from being
claimed into reviewer runs. The reviewer dispatch drain may wait for admission,
token refresh, and child-spawn bookkeeping, but reviewer execution itself is a
detached runtime concern bounded by the reviewer timeout and by the outer
`safePollOnce` deadline. A drain that exceeds the watcher SLA emits an explicit
warning so the inverse starvation class is observable.

Posted-review handlers run after reviewer dispatch has drained. Because that
places them before lifecycle sync, merge-side dispatch decisions must re-fetch
live PR state, head SHA, and mergeability at dispatch time rather than relying
on the previous lifecycle mirror. Per-repo post-review maintenance handlers are
isolated: one repo's stuck/phantom scan failure must not skip later repos in the
same tick.

### Dispatch state

Successful dispatches write a record under `data/follow-up-jobs/merge-agent-dispatches/<repo>-pr-<n>-<headSha>.json`. Each record carries the dispatch timestamp, the trigger label (or null for the standard verdict path), the resolved priority selection, whether the host actually supported `--priority`, the resulting `dispatchId` and `launchRequestId` from the hq invocation, and the label-removal attempt result. The same record is also the durable watcher-side handoff ledger: when a terminal-failed dispatch clears `merge-agent-dispatched` without establishing recovery, the watcher stamps `phantomHandoffObservedAt` on the first tick that proves the gap and starts the 60-minute grace from that timestamp, not from the original dispatch creation time. That detection is proactive and keyed to the current PR head, not just the normal merge-agent revisit set, so a label-cleared orphan can still enter the grace/escalation state machine. If the grace expires with no recovery ownership, the watcher first persists pending phantom-handoff comment-delivery state on the dispatch record, then converges the `merge-agent-stuck` label and owed operator comment from that ledger. Later ticks replay whichever side effect is still missing, so a partial failure after the label transition cannot permanently lose the human-facing explanation. Pre-existing dispatches with the same `(repo, prNumber, headSha)` triple normally short-circuit a second dispatch via the `skip-already-dispatched` decision, and the consumed-label removal is retried best-effort each tick until the label is observed gone from the PR.

The watcher now also owns a bounded retry path for same-head merge-agent failures. If the recorded LRQ is terminal `failed`, `superseded`, or authoritative `not-found`, the watcher may clear the duplicate-dispatch guard and launch one replacement worker for the same head, bounded by `watcherReDispatchCount` in the dispatch record. `cancelled` / `canceled` are deliberately excluded from this autonomous path; reviving an intentionally cancelled merge-agent still requires an explicit scoped `merge-agent-requested` label. The public `merge-agent-dispatched` label is not the only handoff oracle: an unresolved `data/follow-up-jobs/merge-agent-lifecycle-cleanups/<repo>-pr-<n>.json` record with `transition: "dispatched-label-add"` keeps the dispatch in watcher-owned state even when the label never landed on GitHub, so a failed label add cannot wedge the PR on `skip-already-dispatched` forever. Once the label is cleared and the worker is terminal-failed, the watcher switches from retry ownership to phantom-handoff grace tracking via `phantomHandoffObservedAt`; that conservative clock prevents long-running original dispatches from being escalated immediately when the missing-handoff state is only newly observed.

### Recovery-in-flight handoff label (MAR-C)

`merge-agent-recovery-in-flight` is the transitional handoff marker between a merge-agent's failure-recovery dispatch and the recovery worker's terminal outcome. Ownership and lifecycle:

| Role | Owner | When |
|---|---|---|
| **Apply** | merge-agent (paired agent-os MAR-B/C in `modules/worker-pool/lib/adapters/merge-agent.sh`) | After `hq dispatch --worker-class merge-agent --task-kind merge-agent-failure-recovery ...` returns successfully, BEFORE the merge-agent removes `merge-agent-dispatched` and exits. |
| **Remove** | recovery worker | On every terminal outcome (`succeeded`, `failed`, `cancelled`, and the merge-rejected / blocker-refusal paths). The recovery prompt enforces removal as the last cleanup step. |
| **Read** | watcher (`reconcilePhantomHandoffEscalation` per-job, `reconcileProactivePhantomHandoffs` per-tick) | On every grace-suppression evaluation. Presence of the label is equivalent to `merge-agent-dispatched` for grace purposes, **with** the bounded ceiling below. |

The watcher's ceiling for trusting the label is `_PHANTOM_HANDOFF_RECOVERY_IN_FLIGHT_MAX_MINUTES = 120` (2× the 60-min phantom-handoff grace window). The ceiling clock is the LABEL's `LabeledEvent.createdAt` from the PR's GitHub timeline — fetched via `fetchLatestLabelEvent` — NOT the original merge-agent dispatch time. Keying the ceiling off the dispatch time would fire the 120-min limit instantly on any merge-agent that ran longer than 2h before dispatching recovery, which is exactly the false-positive shape this label is supposed to prevent. When the label-add age exceeds the ceiling, the watcher logs `merge_agent.recovery_in_flight_label_max_age_exceeded` and falls through to the existing phantom-handoff grace/escalation path. When the label-add timestamp cannot be resolved (gh API failure, no matching LabeledEvent in the timeline, force-push that orphaned the scoped anchor), the watcher logs `merge_agent.recovery_in_flight_label_age_unresolved` and ALSO falls through to grace — the failure mode chosen is "false-positive on stuck" rather than "PR silently wedged behind an unresolvable label."

Operator stale-label recovery: removing `merge-agent-recovery-in-flight` by hand returns the PR to the normal phantom-handoff path on the next tick. The watcher does not own the WRITE path for this label, so manual removal does not require a corresponding watcher action.

Failure mode this addresses (live, 2026-05-31): the merge-agent legitimately dispatched a failure-recovery worker on PRs #1186/#1188/#1194, removed `merge-agent-dispatched`, and exited. The recovery worker then died from a spawn.sh teardown bug. The watcher observed no in-flight marker, started the 60-min grace, and applied `merge-agent-stuck` to three PRs that were trying to land real work. The recovery-in-flight label closes that gap by carrying the in-flight signal across the merge-agent → recovery-worker handoff window.

`not-found` is authoritative only when the watcher definitely proved cross-account visibility by passing `--as-owner <hq owner>` to `hq dispatch status`. If `.hq/config.json` cannot be read, is malformed, or lacks `ownerUser`, the watcher logs the degraded owner-visibility state, refuses to classify the LRQ as gone, and leaves duplicate-dispatch protection in force for that tick.

### Merge closeout capture

After a PR merges, the watcher runs a closeout-capture pass to fold any operator closeout comments into the durable `pr_merge_closeouts` table. The scrape window is `(latest completed reviewer pass ended_at, mergedAt + 24h]`; the lower bound falls back to the PR's GH-side `created_at` when no completed reviewer pass exists. `status='completed'` is load-bearing on the lower-bound query — failed/orphan passes with an `ended_at` do NOT shift the window forward, so commentary posted between a failed pass and the eventual successful re-review remains in the closeout window. Reviewer-bot logins and builder-bot logins are excluded from the closeout-authors set per the cross-model routing table. Watcher-side closeout comment reads use Octokit under the watcher's `GITHUB_TOKEN` and the conditional request cache; stored artifact refs preserve GitHub `node_id` strings only, matching the legacy gh CLI scrape shape.

**Settled-empty path.** A scrape that returns zero closeout comments past the 10-minute post-merge settle window records `empty_confirmed_at` as a successful terminal state. Re-scrapes on a slower cadence (default 1h) up to 24h past merge keep a path open for late operator replies. The closeout `recordMergeCloseout` upsert resets `scrape_attempt_count` to 0 and clears `scrape_last_error` on ANY terminal success — body captured OR settled-empty confirmed — so triage dashboards keyed on those columns don't keep paging on rows that have already recovered.

**Chronic-failure triage.** Persistent gh / SQLite failures bump `scrape_attempt_count` and persist the last error in `scrape_last_error`. The pending-list ordering pushes chronic failures to the tail (fresh debt first), and a per-tick 60s wall-clock budget bounds the time the closeout-capture path can spend before `pollOnce` reclaims the loop. `gh` stderr is classified content-sensitively: parsed non-empty stdout is accepted alongside benign banners; only stderr matching fatal patterns or stderr with empty parsed result trips the retry path.

Authoritative state-machine documentation: `docs/STATE-MACHINE.md` §"Merge closeout capture". Schema columns + ON CONFLICT semantics: `migrations/20260529_reviewer_passes_body_capture_and_closeouts.sql`, `migrations/20260530_pr_merge_closeouts_empty_refs_compat.sql`, `migrations/20260531_pr_merge_closeouts_scrape_attempt_tracking.sql`.
