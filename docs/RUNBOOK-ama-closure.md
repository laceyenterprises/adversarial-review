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

## Load-aware per-call budgets

The service scales GitHub lookups, quota-status reads, lock waits and
posted-review step deadlines through `src/load-aware-timeout.mjs`. All quota
readers share a 45-second nominal budget. The existing graded CPU
corroboration curve supplies up to 6x patience by default under contention;
CPU samples (including failures) and timeout policy are cached for five seconds.

Set `adversarial.reviewer.load_aware.enabled: false` in `config.local.yaml` to restore
nominal budgets, or set `adversarial.reviewer.load_aware.max_multiplier` (1..20 inclusive,
default 6) to cap the extension. Policy changes are observed within five
seconds. These keys use the shared `adversarial.reviewer` forward-compatible
extension point accepted by the Python loader and its shell wrapper; do not add
a top-level `timeouts` root. An invalid or unreadable config uses the default
policy for five seconds and emits one warning per refresh interval, so timeout
computations do not interrupt GitHub reads or lock/quota bookkeeping.

Posted-review admission uses the nominal step deadline regardless of host load.
Scaled handler waits are capped at the remaining phase budget (including time
spent preparing handlers), allowing the next discovery phase to run. Child step
waits are still bounded by that handler's outer deadline. Posted-review phase
budgets, polling/backoff, cache freshness,
leases, rate-limit windows and reviewer/worker run limits keep their existing
meaning and duration.

For quota reads, let `T` be the scaled 45-second child timeout: at the default
6x cap, `T = 270s`; at the maximum 20x cap, `T = 900s`. Worst-case timeout
budgets below exclude process teardown, parsing and any separate runtime probes;
caches or outer handler deadlines can shorten them. Retry delays stay nominal.

| Quota entry point | Default retry budget | Total at 6x / 20x |
| --- | --- | --- |
| AFH grounding and closer harness fallback | `T + 2 × 0.25T + 1.25s` | 406.25s / 1351.25s |
| Watcher quota poll | `T + 0.25T + 0.25s` | 337.75s / 1125.25s |
| Reviewer worker-class fallback | `3T + 1.25s` | 811.25s / 2701.25s |
| Argus, remediation fallback, quota revalidation, burst CLI | `T` per read | 270s / 900s |

The burst CLI uses a synchronous quota read and can block its caller for `T`.
Operators needing faster hang detection should lower the multiplier cap or disable
scaling with the configuration above. CPU corroboration still uses synchronous
`ps` with a one-second bound, at most once per five-second sample interval.

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

## Posted-review read lifetime (WATCHERLATENCY-01)

Gate projection and candidate evaluation share label events and their underlying
GitHub timeline only within one PR handler in one poll. Reuse lasts at most ten
seconds from the first successful response, so subprocess startup does not
consume the reuse window. A candidate head change discards the prior head's
entries; failed reads are evicted, and executor, credential, host and adapter
identities remain separate. The live timeline still determines the head to
which a label belongs.

The handler closes this advisory cache before coexistence, including any gate
reprojection after a changed review row. Closure, daemon merge and dispatch
freshness probes therefore remain live. PR terminal state, reviews, CI, leases,
receipts and eligibility rules retain their existing checks. Candidate guard,
label-provenance and branch-protection reads run in at most four independent
tasks per PR; every task settles before the candidate returns or rejects.

Closure accepts an optional initialized `reviewStateDb` connection from the
watcher for its rereview-round count and hammer-wake telemetry. It still executes
the count query on each evaluation and records each wake receipt, without
reopening the database or converging its schema for every PR. The posted-review
handler uses the shared watcher connection by default at the module's root;
custom roots default to no connection. Its dispatch-job construction and closure
evaluation both receive the selected connection, including an explicit override
or `null`. Callers without a connection retain the existing initialization path.

Object-addressed history evidence remains bounded to one closure evaluation.
Completed immutable reads can now be shared across operation signals. Pending
reads share only when their signal is identical, so one operation's cancellation
cannot cancel another operation. Mutable PR, review, label and base-ref reads
are excluded from this immutable cache.

Run the synthetic before/after profile from the repository root:

```bash
node test/helpers/run-posted-review-profile.mjs origin/main
```

It profiles 15 PR handlers with three operator controls, twelve checks and two
review pages per PR, using injected executors with a stated 20 ms call delay
after one unmeasured warm-up PR per version. Imports use an isolated fixture
root, so the profile cannot change checkout state.
It reports per-step GitHub command counts by kind, executor invocations and elapsed
time, plus actual SQLite read counts and read execution time. Adapter internals
and HTTP requests hidden inside high-level commands are outside this fixture,
as is live merge execution: the daemon boundary returns
a synthetic lease refusal. A separate three-consumer history fixture measures
immutable evidence reuse across operation deadlines. These are local fixture
measurements; verify the existing posted-review step logs after deployment to
establish whether normal production PRs meet the ten-second target. No config
change or new check is required.

## Live head branch confirmation (BRANCHPROBE-01)

The closer's pre-launch PR read treats `headRepository: null` as unknown and
confirms the exact head ref with bounded, noninteractive `git ls-remote
--exit-code --heads`, falling back to the base repository URL. An identified
fork uses its own repository URL. A fork identified by `isCrossRepository`
without a head repository stays unknown and retries without a base probe. Only exit code 2 authorizes
`no-dispatch / abandoned-pr-closed / live-head-branch-missing`.

A failed, timed-out or empty successful confirmation leaves branch existence
unknown. The existing `dispatch-deferred-transient` state records
`live-head-branch-unknown` and the error, releases the unlaunched pending lease,
preserves launch budget and returns a 30-second retry hint for the next normal
poll. No merge-agent fallback runs during that wait. After deployment, verify
that existing branches never receive `live-head-branch-missing`, and that
unknown reads resume normal dispatch after confirmation recovers.

Unidentified forks have a separate six-hour window, recorded per head in
`unresolvedForkHeadSince`. Repeated unknown fork reads preserve that timestamp
and launch budget. Confirmed repository metadata clears the window. If the fork
is still unidentified at the deadline, the closer writes `no-dispatch` with
reason `live-head-fork-unresolved`, logs a warning, releases the pending lease,
and returns `needsOperator: true`. It does not claim that the branch was deleted
or fall back to a merge agent. Further closer calls for that head stop before
the live PR probe. Inspect whether the fork was deleted or GitHub metadata is
unavailable; after resolving the cause, an operator may clear that head's
dispatch record to re-arm confirmation. A new reviewed head starts a new window.
After deployment, verify persistent unknown forks reach this inspection state
without a launch-budget charge or repeated GitHub probes. See the
[incident report](postmortems/BRANCHPROBE-01-null-head-repository-2026-10-19.md).

## 1. Prerequisites

### Hammer scratch lifetime (HAMTMP-03 / HAMTMP-04 / SCRATCHCENSUS-01 / SCRATCHCENSUS-02)

Each closer run owns one private `hammer-scratch-*` directory beneath
`data/follow-up-jobs/ama-closer-prompts`. Recording a terminal outcome removes
that directory, including CI logs, pytest trees and database WAL files. Scratch
log retention is zero; dispatch records, prompts and the existing AMA audit
remain available. Terminal cleanup retries on repeated observations, including
an initial `dispatching` to `dispatch-failed` transition. Launch intents and
successful launches carrying a predecessor's terminal status retain scratch
until a fresh terminal observation.

SCRATCHRACE-01: launch liveness includes every descendant linked by
`metadata.retryOf`, transitively. Any non-terminal fleet retry retains the
ancestor's scratch and prevents closer re-dispatch; the startup sweep uses the
same rule even if the owner record already reports a terminal launch. Each
attempt writes a unique prompt alongside its scratch, so retry admission never
rewrites an earlier launch's prompt. Predecessor deletion is deferred until the
closer's admission decision. A `uq_worker_runs_live_logical_job` refusal re-reads
the existing non-null predecessor LRQ with its retry chain. Only a proven live
descendant restores `dispatched` ownership, reason `dispatch-retry-live`, and
`liveRetryLaunchRequestId`, without charging a failed attempt or deleting the
previous artifacts. Restore the record at its original head; a different target
head stays `no-dispatch` with `retryOwnerHeadSha` and no launch/artifact ownership,
and its pending lease is removed. Later admission resolves that pointer before
probing liveness or a claim refusal, preserving the original owner's identity.
Without chain proof (or without a predecessor
LRQ), use charged dispatch failure and existing capped, paged recovery. An
unreadable refusal-time probe also charges a failure, but keeps the predecessor's LRQ and
artifacts in `dispatch-failed` on its original identity and suppresses fallback
until ownership can be read; it does not claim a dispatched worker.
Malformed unrelated metadata is skipped. If retry traversal is unreadable, the
base status remains observable but cannot authorize cleanup, lease settlement
or re-dispatch. Historical terminal observations survive missing/unreadable
probes without degrading reconciliation of other records. All-terminal chains
and ordinary non-retry failures retain their existing cleanup behavior.
Admission and predecessor matching resolve the repository from `dispatchContext.repo`,
then `prMetadata.repo`, then the top-level `repo`. PR number resolution uses
`dispatchContext.prNumber`, then `prMetadata.prNumber`, then top-level `prNumber`
for both admission and cleanup. Descendants are ordered by latest update and
launch ID, and promoted live rows retain their status metadata. RETRYCHAIN-02:
PostgreSQL selects the retry reader by the metadata column type. Native `jsonb`
uses a cycle-safe recursive join directly on `metadata_json ->> 'retryOf'` on
all server versions. The recursive predicate repeats the existing partial
`idx_launch_requests_retry_of` index predicate; no whole-table edge set is
materialized. Status projections select individual columns and never serialize
payloads through `to_jsonb(request)`. A missing metadata column means an empty
chain. On PostgreSQL 16+, historical text metadata uses per-row input validation
on the column before casting, skipping malformed JSON and invalid Unicode
escapes. Pre-16 text retains the read-only snapshot and application traversal;
this compatibility path can still exhaust the output bound on large ledgers.
All retry reads use read-only transactions, including through transaction
pooling, with no catalog writes; SELECT permission suffices.
Capacity reconciliation supplies only the launch IDs being reconciled, and
shares one read-only snapshot of those launches and their descendants. An empty
ID list returns no rows without a query. Application traversal reuses that
snapshot. Both sync and async PostgreSQL children retain the shared 2 MiB output
bound. An oversized chain, query error, timeout or abort remains unreadable
under the existing ownership rules. The reader preserves base status and
returns `retryChainFailure` with `reason`, `detail` and `elapsedMs`.
Closer admission logs one `ama_closer.retry_chain_unreadable` JSON line before
returning `dispatch-retry-chain-unreadable`; refusal-time ownership failures
log the same diagnostic. Connection strings, row objects, malformed-output
previews and PostgreSQL continuation lines are excluded from that log. SQLite retains
its recursive query. Interrupted admission (including
shutdown aborts) leaves the current PR's deferred predecessor cleanup for a later
completed pass. Capacity reconciliation cleans other PRs' terminal scratch
immediately, including when the current admission subsequently aborts. A refused
or aborted attempt that never launched removes its own unique prompt alongside
its scratch; launched and ambiguous-launch prompts remain available.
After deployment, verify that a fleet-retried hammer following a spawn timeout
can source its phase helpers and produces no missing-phase-script no-merge note.

SCRATCHLEAK-01: the hammer environment keeps `TMPDIR` inside scratch and appends
`--basetemp="<scratch>/tmp-tests" -o tmp_path_retention_count=1` to
`PYTEST_ADDOPTS`. Existing options are preserved before these enforced options.
Pytest replaces that base on each invocation, so one test tree remains per run;
terminal scratch removal removes it too. Concurrent pytest invocations within
one hammer must use distinct explicit base directories inside scratch.

Terminal writer and reconciliation cleanup preserve a recorded live process,
including a process draining after cancellation. A live pending launch lease or
a different launch's unreclaimable dispatched lease also preserves scratch.
A terminal launch's own merge-authority lease may remain for PR reconciliation;
that lease alone is not evidence of a live worker (HAMTMP-05). These disk checks
never grant merge authority or change lease state. Existing deferred predecessor
cleanup and transitive retry-chain protection remain in force.

At watcher startup, the sweep reclaims terminal directories after the two-hour
bound (four existing 30-minute dispatched-lease windows). Age uses the latest of
the scratch directory mtime and its owners' terminal observation timestamps,
falling back to update/dispatch time for legacy records. Nested file mtimes do
not extend a terminal run. Orphans still require the entire tree to be idle for
two hours. Until one full sweep completes, the first poll at least a minute
after the previous attempt retries it; subsequent sweeps run hourly. Overlapping
passes are suppressed. Each pass removes at most 64 directories with a 10-second
scan budget. Large terminal trees have only a 25ms byte-accounting budget: partial
accounting does not prevent deletion, and `bytesFreedIsLowerBound: true` marks
that measurement. Directory removal itself may take longer than the scan budget.

SCRATCHLEAK-02 orders candidates by directory mtime, oldest first, with name as
the tie-breaker. An atomic candidate cursor resumes after the last examined
ordering key, even when that directory was kept or has since disappeared.
Each pass visits at most one lap, wrapping to the oldest remaining key after
the newest. A full lap with no removals retains its position. Budget, removal-cap
and census pauses preserve completed candidate progress across watcher restarts.

The in-use probe runs `ps -Eww` on Darwin (`ps eww` on Linux) for process
arguments and environments, plus `lsof -nP -a -u <runtime-uid> -d cwd -F n` for
working directories. It never uses `lsof +D` or enumerates open test files.
Recorded PIDs, current launch/retry and worker ledger state, and launch leases
are checked separately. Paths are matched against both lexical and real paths;
cwd paths must equal scratch or begin with scratch followed by `/`. Launch and
worker IDs are checked only in `ps`, so unrelated audit filenames cannot hold
finished runs. Both LF and CRLF cwd output are accepted. Census output and child
error text are never logged because process environments may contain secrets.

The two census commands run in parallel, each bounded to 15 seconds, outside
the scan budget. A pass shares one census, refreshes after 30 seconds and never
reads more than two censuses. If the second expires, remaining candidates wait
for the next pass. Final checks repeat after a refresh and preserve changed
owner records, replaced directories and newly held leases.

A cwd timeout is retried on a later sweep for recent terminal runs. After an
additional grace of twice the larger launch-admission or dispatched-lease window
(about 61 minutes by default, extended by a record's existing dispatch timeout),
it cannot defer a terminal directory forever. That escape still requires readable
`ps`, a terminal launch and retry chain, absent recorded worker processes, and no
live lease or path/ID reference. Positive cwd evidence returned before a timeout
also protects the run. Orphans, unreadable `ps`, other census errors, unreadable
worker/launch evidence and incomplete retry chains never use this escape.
A timeout-based removal logs `cwdProbe: timed-out-aged-terminal`.

Every removal emits `ama_closer.scratch_swept` with name, allocated bytes counted
and terminal/orphan reason. Every pass emits `ama_closer.scratch_sweep_summary`
with `removed`, `remainingCandidates`, `deferredCandidates`, `completed` and
first-match protection counts: `too-young`, `non-terminal`, `live-owner`,
`process-references-path`, `process-references-id` and `probe-timeout`.
`deferredCandidates` includes ledger-timeout candidates already visited in this
pass; `remainingCandidates` counts entries not yet visited in its rotated lap.
`ama_closer.scratch_process_census` logs command duration, byte counts and
readability only. Budget, removal-cap and expired-census pauses emit
`ama_closer.scratch_sweep_paused`; already completed deletions remain complete.

A metadata-validated record index reuses unchanged history and atomically
checkpoints partial progress to
`data/follow-up-jobs/hammer-scratch-record-index.json`. Missing or invalid cache
forces a cold scan. Source device, inode, size, modification and change time are
validated on every pass; no deletion precedes a complete current record census.
Unreadable or changed ownership preserves scratch, and dispatch evidence is
never pruned. Scratch and parent symlinks are never followed.
The independent scheduling checkpoint is
`data/follow-up-jobs/hammer-scratch-candidate-cursor.json` (see the
[scratch sweep data model](data-model/hammer-scratch-sweep.md)). Missing,
invalid or unreadable cursor state restarts oldest first; cursor state never
authorizes deletion. Checkpoint write failures warn without adding a merge gate.

Launch/retry and worker ledger probes each have a separate 10-second timeout by
default. Callers of `sweepHammerScratchDirs` may set `ledgerTimeoutMs` to override
both the probe deadline and abort timer (for example, for offline timeout tests).
Their elapsed time is added back to the scan deadline, as for the process census.
A timed-out probe retains that candidate, increments `deferredCandidates` and
advances past it, allowing independent candidates to proceed. An async timeout
aborts the probe; a late synchronous result is also discarded. No timeout is
interpreted as terminal ownership or an absent worker.

For legacy owners without a surviving launch row, the sweep falls back to live
PR state. A failed PR lookup preserves that owner's scratch and continues with
other candidates within the same scan budget. Terminal observations persisted
by closer dispatch use the current observation time, rather than the original
dispatch timestamp, for `lastObservedAt`.
Tests may inject a timestamp or clock function through `maybeDispatchAmaCloser`'s
`now` option. Scratch ledger probes honor the sweep's `spawnSyncImpl` option
while retaining the independent ledger deadline on each subprocess call.

After deployment, SRE confirms that the watcher restarted. The initial pass
and minute-spaced continuation passes should reclaim the old terminal backlog
without manual deletion. Confirm `scratch_swept` and summary progress, with only
live, protected or recent scratch remaining; the reported incident backlog
should show `removed > 0` within two passes, fall from more than 120 directories
to a handful of young/live trees within about a day, and shrink by roughly
13 GB. A timeout on an already aged terminal run must
produce bounded reclamation rather than endless deferral. Check that size stays
roughly flat over a day of hammer runs. These are post-deploy acceptance checks;
the offline tests do not inspect or remove live state.

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
         # AMA hammer dispatch stays inline by default. To keep
         # posted-review handlers from waiting on slow `hq dispatch` calls, set
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

- **Bounded quota evidence (HAMMERQUOTAREAD-01):** each launch tries the live
  read with the shared retry reader: 20 seconds initially, then up to two
  5-second retries for transient errors, with 250 ms and 1-second delays.
  Awaited retry delays keep standalone callers alive until the read settles.
  Successful parsed reads atomically refresh
  `data/ama-closer-quota-snapshot.json` under the dispatch state root. A failed
  or unreadable live read may reuse that payload only while its original read
  time is less than ten minutes old. Cached use never renews its timestamp.
  The resolver result and AMA audit's `harnessResolution` record
  `evidenceSource` (`live` or `last-good-snapshot`), `evidenceAgeMs`, and
  `evidenceReadAt` (epoch milliseconds); cached use also records `liveReadReason`.
  Cache write failures preserve successful live routing. Missing, corrupt,
  future-dated or expired caches cannot admit a launch.
- **Auto-revert:** live resolution re-runs every launch. When codex recovers to
  `ok`, the next successful live read returns to the configured primary without
  a manual flip. During a status outage, cached routing can persist for the
  bounded snapshot window.
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
- **Unknown evidence:** automatic Codex routing and the corporate Claude pin
  hold when no usable live or cached status exists. Other pinned/non-Codex
  paths retain their existing fail-open behavior. Holds return
  `harness-hold:<resolver reason>` plus `holdReason`, and the AMA audit records
  a `deferred` attempt with the same reason. A genuine exhausted fallback set
  retains `all-fallbacks-grounded`. Alert transport failures remain best effort.
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

HAMLANE-01 keeps final-review hammer ownership in the active lane even when the
NOT CONVERGED gate requests an operator decision. A genuine safety or operator
hold still uses the operator-blocked cadence and alert path.
Pending results preserve the named operator hold and safety evidence (including
`needsOperator`, draft, retry/lifetime cap and label holds); they never mark the
hammer route active while that hold applies. Ordinary pending results omit
closure details to keep submission/settlement changes out of lane fingerprints.

Background submissions persist [retry intent](data-model/ama-hammer-background.md)
before launch. On the first adoption phase after a watcher restart, matching-head
intents bypass lane backoff and receive handler priority. The normal closer
rechecks all live guards and deduplicates any launch that already succeeded.
Restart priority and recovery logging run once per watcher process/root. Handlers
deferred by the first phase's budget can still bypass lane backoff on a later
normal scheduling pass while their intent remains. Confirmed dispatch or an
existing `ama-closer-launch-in-progress` retires that head's interrupted intent:
the closer ledger and lease own subsequent reconciliation. An operator/safety
hold also retires intent before recording operator-blocked cadence.
Confirmed `pr-terminal` reconciliation removes the PR's intent even when it
belongs to a superseded head, so closed or merged PRs leave no abandoned intent.

This is a v1 bug-fix/operational mitigation under the freeze above, not a new
merge authority lane. The MSM decision tree is unchanged: a PR that needs the
hammer still goes through `maybeDispatchAmaCloser`, the same closer lease,
dispatch record, retry cap, prompt, and merge-under-lease contract. Only the
posted-review watcher phase's wait behavior changes.

Posted-review scheduling uses four concurrent handlers, with no deployment
knob. Priority probes share the phase budget and use at most thirty seconds
(or half the phase budget, if smaller), with ten seconds per read. They promote
lane-due settled approved or comment-only reviews on the current head with green
CI and no pending remediation ahead of ordinary handlers. The no-progress lane
is previewed without advancing skip counters before any readiness probe;
handlers still in backoff incur no readiness GitHub read. Merge readiness is an
ordering hint only and cannot bypass lane backoff. The scheduler accounts for
skips once per tick, and explicit wakes and the idle-lane floor retain their
existing admission rules. Budget-deferred
handlers retain their order at the front of the next tick; explicit wake
priority and positive retry holds keep their existing meaning. Priority is
scheduling evidence only: the probe reads a snapshot without performing hold
actions. Normal review, stop-hold, lease, current-head and merge gates still
decide every action. A snapshot read is reused for at most
ten seconds on its matching head; older candidates are read again. Immutable
commit/tree/blob and exact-SHA comparison reads are shared within a tick;
mutable PR, base, review, label and dispatch-time reads remain fresh. Failed or
aborted reads are not retained as successful evidence.
Readiness probes use the adoption phase's injected `execFileImpl` executor,
including the normal candidate snapshot read and its abort signal.

Timed-out handler work keeps its concurrency slot until it actually settles.
Deferrals caused by those occupied slots are reported as `in_flight_deferred`,
separately from phase-time exhaustion (`budget_deferred`); both retain next-tick
priority. Changes-requested reviews keep ordinary ordering and are excluded
from `merge_ready_handled`.
The hammer capacity census through dispatch-intent publication is serialized
within the watcher process so concurrent evaluations cannot all claim the last
launch slot. The slow dispatch acknowledgement remains outside that section;
the existing hammer launch cap and per-PR leases still apply.

Each tick logs `merge_ready_handled` and
`ama.final_review_to_hammer_launch.summary` with `samples`, `p50_ms` and `p95_ms`.
Percentiles use confirmed launch acknowledgements in a bounded process-local
24-hour window, including background completions between ticks. An empty
window reports null percentiles; a restart starts a new window. After deployment,
SRE should verify p95 remains below ten minutes with a roughly 25-PR backlog
and compare review settlement with hammer requests to check the one-tick target.
This observation requires host traffic and is not established by offline tests.
Offline tests clear the window with
`resetFinalReviewHammerLatenciesForTesting()` during setup and teardown.

The optional adapter's Node read seam uses the per-kind CLI subcommands in
`ADAPTER_READ_COMMANDS` (`src/github-adapter-client.mjs`), with `--number` for
PR references. Review head/author filtering stays local; review context combines
`pr-state` with `issue-comments`. Current `pr-state` lacks mergeability, so full
rollup/mergeability reads retain their existing fallback. Label events without
head-scope evidence also retain the authoritative timeline fallback.
Adapter CLI versions that lack a subcommand return structured `unsupported_command` evidence;
subprocess failures are classified as `exec_error`, and API telemetry does not
store the error message. After that specific capability refusal, the watcher
logs that it is skipping the unsupported read transport for the rest of the
tick and uses its existing fallback. Only that subcommand (including logical
kinds sharing it) is skipped; other reads remain available. Every new tick probes again. Transient, authentication,
timeout and unstructured failures do not disable the transport, and writes
retain their existing path. Incomplete envelopes cannot become successful reads.
Nested `withGitHubAdapterReadTick` calls share the enclosing tick's capability
cache; only the outermost call clears it on exit.

For each confirmed final-round hammer launch, the watcher emits structured event
`ama.final_review_to_hammer_launch` with PR/head identity, `postedAt`,
`launchConfirmedAt`, `latencyMs`, and `launchRequestId`. Confirmation is the
successful dispatch acknowledgement; the duration includes time spent waiting
for the lane, queue, restart recovery, and dispatch. It does not measure worker
boot time. Missing or invalid posted timestamps do not fabricate latency.
The event always includes `headSha`: the target remediation SHA, falling back to
the review-state head, then the dispatch context's reviewed SHA, or `null` when
none is available.

The control is `watcher.ama_hammer_dispatch_mode`, with env override
`AGENT_OS_WATCHER_AMA_HAMMER_DISPATCH_MODE` and legacy alias
`ADVERSARIAL_AMA_HAMMER_DISPATCH_MODE`:

| Mode | Contract |
|---|---|
| `inline` (default) | The posted-review phase awaits the hammer `hq dispatch` attempt within its handler; up to four posted-review handlers run concurrently. This is the historical dispatch mode and the fail-safe fallback for missing, unreadable, or unknown config values. |
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
`background-pr-mergeable-unknown` only after bounded same-cycle sampling with
`resolveMergeabilityWithSampling`: three total probes by default, 2.5 seconds
between reads, using the existing mergeability sample constants. Each re-read
checks open state, draft flag, and the target head; closed, draft, or moved-head
reads stop sampling and refuse dispatch. `MERGEABLE` and `CONFLICTING` readings
can dispatch in the same cycle. Sampling holds the background queue slot for
up to two additional sleeps (five seconds by default) and two live fetches, so
a queue saturated with UNKNOWN heads can delay other hammer launches.
Any other state that is neither `MERGEABLE`
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

Removing the last of `no-merge-hold`, `do-not-merge` and `merge-agent-skip`
creates a durable HOLDRELEASE-01 intent in `reviews.db`. The watcher verifies
live state, head and labels, then arms the existing review, remediation,
daemon clean-merge or hammer route without bypassing their gates or budgets.
Missing captured review bodies select a current-head re-review unless an active
remediation job already owns the head. Same-head failed reviews retain their
failure evidence and counters; ordinary retry and park gates own recovery.
If release-driven spawn freshness fails or a hold is re-applied after claim,
the unexecuted session restores its complete pre-claim state with a session
CAS, retaining the failure classification and retry gates for the next tick.
Release-routing errors log a warning and continue ordinary PR processing while
retaining the intent for retry. A live terminal PR settles the intent as
`pr-terminal`/`none` and ends that subject's tick. A moved head, unknown labels
or re-applied hold also ends the tick before gate projection and closeout;
ordinary processing resumes on the next discovery. The closer can
unlock a prior hammer stop on an exact-head release: removing a hold re-arms
a stopped hammer on an unchanged head, even when its stop was not hold-only.
Retry caps and every merge predicate still apply. Hold-only refunds
require explicit non-execution evidence and a launch ID. Current hammer audit
producers do not supply that evidence, so operators should not expect refunds
from them. See [Operator Hold Releases](data-model/operator-hold-releases.md),
[Hammer Stop Hold](data-model/hammer-stop-hold.md) and
[Hammer Retry Cap](data-model/hammer-retry-cap.md) for persistence and timing.

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

The eligible hammer wake recognizes that same recorded `workerPushedHeadSha`
for the reviewed head: `stale-head` alone does not suppress its wake after CI
turns green. Every other snapshot miss is retained. The closeout comment names
the hammer as the next owner, and no re-review is queued for this head. An
unrelated push remains `stale-head`; a round without a push keeps the ordinary
current-head wake rule. Verify after deployment that the next suppressed
comment-only worker push wakes and reaches the hammer on the first green-CI
watcher pass, without a manual re-review request.

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
   When a diff changes an owner's lifecycle states, transitions, durable status
   values, smoke-verified promises or post-deploy verification steps, and that owner
   declares `state-machines.json` and/or `post-merge-verify.json` beside its README,
   canonical doc-currency also covers the affected declarations and the README's
   state/smoke section, plus the smoke harness when a verified promise changed.
   Regenerate any committed generated state index if the repository has one (for
   example `docs/architecture/STATE-MACHINES.md`); after conflicts, regenerate from
   merged declarations rather than hand-merging generated output. Missing updates
   are blocking contract drift, like stale data-model docs, including in final
   reviews. Remediators and the hammer update only owners the change actually
   affects as part of landing it. Owners with no declarations yet need not add
   them in an unrelated PR; at most leave a non-blocking note.
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

### Operator-label closure holds (LABELGATE-01)

After hammer-route admission, hammer-stop release handling, terminal-worker and
lease reconciliation, and same-PR remediation ownership checks, the closer
classifies the latest exact-head external CI failures against
`src/ama/operator-label-gates.mjs`. All failures must map to
registered label gates and no external sibling may still be pending or unknown.
Production rollups omit failure output, so registered check names and composite
step names are name-based paging heuristics: they cannot distinguish a label
refusal from a guard script crash. Supplemental output, when supplied, must
contain matching refusal text. Only the `repo-guards` composite job family
(`repo-guards` or names beginning `repo-guards-`, `repo-guards/`, or
`repo-guards `) is expanded; reads require exact-head, exclusively registered
failed steps. Pending/unknown siblings or unrelated failures skip all job reads.
Results are cached per reader/repo/job/head (512 entries); completed responses
are reused, and unreadable responses retry after 60 seconds. Each pass reads at
most two uncached jobs, with a 3-second subprocess timeout, a 5-second total read
budget, and caller cancellation. Read-cap, deadline and transport failures return
a non-paging classification-pending recovery wait. Missing required contexts
prevent label-only paging. Transient job reads retry once within that budget. Advisory or green checks do not hold. Required-check greenness remains an independent merge gate,
including in advisory CI-cost mode; a label cannot waive red CI.

Drafts, disallowed risk classes, and PRs still owned by review remediation do
not enter this paging path. A hold suppresses hammer/merge-agent dispatch and
pages through
`ama_closer.operator_label_required`, with a durable once-per-head delivery
receipt in `data/operator-label-holds/`. Unchanged delivered receipts skip writes
and paging locks. Inspect the actual refusal first; a script crash requires
repair, not an override label. For an intended guarded delta, apply the appropriate
operator label and rerun the named check. REMLABEL-01 also classifies blocking
review findings against this registry before follow-up or terminal-hammer
remediation. An operator-only review holds without dispatching, comments once
with the label name, and shares the once-per-head paging receipt. Mixed reviews
remediate only ordinary findings; guarded changes remain in place and are
reported as blockers. Remediators never apply labels or revert those changes to
satisfy a label gate. A fresh review must observe a waiver before the finding
clears. Independent CI classification and current-head authority still apply. Before
resuming remediation after deployment, drain workers launched with older prompts;
only newly composed prompts use the guarded remediation publisher.

The next closer pass releases the hold when live CI no longer classifies as
label-only, without deleting historical receipts. A deferred hammer audit with
a matching typed label reason can receive PR 1261 series/target retry credit
only when corroborated by a matching live gate on its recorded head and an audit
timestamp at or after launch. `labelGateRefundedLaunchRequestId` dedupes the
record credit; HAMREFUND-01 and ordinary exit refunds cannot credit it again.
Lifetime charges remain intact. Terminal-worker cleanup, lease finalization
and token accounting run before the label hold. Hammer-stop releases are
persisted before paging. Receipt locking is best effort and there is no
automatic retention sweep; see
[Operator Label Holds](data-model/operator-label-holds.md) for those limits.

### Durable signal/tool-host refunds (HAMREFUND-01)

`maybeDispatchAmaCloser` reconciles a terminal hammer before stale-lease
settlement only when the session ledger reports `worker_killed` with `SIGTERM`
or `SIGKILL` in `failure_detail`, or an exact `codex-tool-host-unavailable` in
`failure_class` or `failure_detail`. A bare `succeeded` status is not
non-execution evidence. It remains on the normal terminal-success path,
including the live `DISPATCHED` lease hold when merged evidence is unknown,
and the one-refund-per-series HAMBG-02 grant when an exit without close is proven.

The non-execution refund additionally requires the same live OPEN head, no
terminal local audit, readable absence of a no-merge closing comment, and a
cleanly missing merged signal with repository-level producer evidence.
Unreadable signals cannot authorize it. It lowers series and matching target
charges, preserving lifetime charges and `lifetimeSuppressed`; only LEASEPARK-01
contention refunds may lower lifetime charges, within their PR-wide budget.

The closer cleans up the worker, records a failed pass and settles its lease
before clearing the launch IDs and setting `prelaunchRefusalSlowRetry.kind` to
`non-execution`. This uses the existing six-hour slow cadence and two alert
markers. The window survives replacement admission and repeated deaths on the
same head. A new head resets the window and `unexecutedRefundCount`, but cannot
reset the lifetime ceiling. `retryCount` remains the pass identity; admission
subtracts reconciled refunds without reusing pass numbers. The ledger retains
the newest ten `unexecutedLaunchRequestIds` across review resets. A record race
logs `ama_closer.unexecuted_refund_dispatch_record_changed` with the refunded
launch; the refund remains durable for idempotent reconciliation.

### A succeeded hammer must have closed its PR (HAMBG-02)

`maybeDispatchAmaCloser` checks the master `enabled` gate and validates the PR
number before reading closer leases, probing ledger status or settling ownership.
Disabled closure remains a no-op. On the enabled path, early ownership
reconciliation writes terminal launch status back to the record and settles
the lease from terminal audit, merged completion, or live PR evidence. A live OPEN
same-head probe records `failed-without-merge` after a 60-second grace when
`terminal_at` is readable; missing timestamps do not pin that head. An armed
GitHub `autoMergeRequest` retains ownership only inside the 30-minute dispatched
lease window, measured from `updatedAt` (or `acquiredAt`) without refreshing it.
A no-merge audit bypasses the hold. Expiry releases ownership under ordinary
retry/refund caps and emits `ama_closer.auto_merge_hold_released`. Without same-head proof or a terminal audit,
the existing settlement grace and ownership hold apply without refreshing the
reclaim clock. Follow-up claims use the same evidence rule, including rekeyed leases.
Merged signals are read per PR, independent of the lease head SHA. Other
terminal runs without audit/merge evidence record `superseded` after lease
head advancement, otherwise `failed-without-merge`.

Lease reconciliation forwards explicit `ledgerTarget` and `ledgerDbPath`
options to launch-status, merged-completion and completion-producer reads, so
all evidence uses the caller's session ledger. Terminal audit lookups use an
explicit `hqRoot`, falling back to `rootDir` when it is omitted.
Direct follow-up reconciliation uses a bounded synchronous launch-request probe.
It retains ownership when the request still reports `starting` or `running`,
even if the worker run has already ended, until the request catches up or the
existing reclaim timeout expires. Async closer dispatch resolves latest worker
run status before passing its probe to the shared reconciliation helper.

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
  suppresses and pages. This exit refund never reduces the lifetime count; only the bounded
  LEASEPARK-01 contention refund does (§ certified-head contention queue);
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

### Review cycle cap → hammer final adjudication (CYCLECAPHAM-01)

Operator decision, 2026-10-10: "Hammers judgement is final". A PR that hits the
review cycle cap (`review_cycle_cap`, default 5 review-then-remediate cycles in
`review_cycle_window_hours`) is not parked for the operator. agent-os PR 7956
showed the old behaviour: "operator attention required", then about 10h at
`CHANGES_REQUESTED` until a hand merge.

- The watcher posts the cap comment ("routed to the hammer for final
  adjudication"), applies `reviewer-cycle-cap-reached`, and keeps automatic
  review paused. On that tick and every later one it hands the PR to this
  closer with `reviewCycleCapReached` and the recent cycle history
  (`src/review-cycle-cap-hammer.mjs`). The route stands while the row is an
  automatic cap pause, or while the label is on and the watcher's
  `review_cycle_counters.escalated_at` marker is set. A hand-applied label
  alone routes nothing, and `paused-for-redesign` takes the PR off the route.
  Reconciliation precedes reviewer-only closer-head suppression, so a hammer
  that pushes a `Closed-By: hammer (adversarial-pipe-mode)` commit and exits
  with the PR still open remains on this route. The latest successful verdict
  in `review_cycle_verdicts` pins the original reviewed head independently of
  admission resets that clear `reviewer_head_sha`; the live head remains the
  remediation target, never substituted as reviewed evidence.
- The closer treats the PR as a final-hammer close and admits the unreviewed
  head of the last remediation push. It does not admit it while a remediation
  job still owns the reviewed head. The hammer prompt gains a
  "CYCLECAPHAM-01 — review cycle cap: you are the final adjudicator" section.
  The hammer remediates real findings, records false ones as
  `withdrawn-by-hammer` with exact-head evidence (the HAMFINAL-01 record shape),
  and merges under its lease with validated HAM evidence. Otherwise it posts
  `HAM closing status — no merge.` with its reasons. It requests no re-review.
- A recorded no-merge decision on this route is final. Unlike the HAMBG-02 table
  above, the closer returns `review-cycle-cap-hammer-final-no-merge`
  (`needsOperator: true`) and launches no retry hammer. An exit without a close
  is not a decision and keeps the refunded re-arm. The existing hammer retry cap
  and lifetime ceiling bound the attempts.
  Trusted exact-head no-merge evidence is checked for terminal failed and
  cancelled launches as well as successful launches, before retry admission
  or certified-park handling. Unreadable evidence holds the dispatch for a
  later tick; process failure alone cannot override a recorded decision.
- Only the no-merge decision or an exhausted hammer retry cap pages the
  operator, as SEV1 `ama.review_cycle_cap.hammer_final`, once per
  `repo#pr@head`. Read the hammer's closing-status comment on the PR first.
  The override labels (`operator-approved`, `merge-agent-requested`,
  `paused-for-redesign`) still clear the cap.

### CI-blocked with no remediation job left → hammer owner (CIBLOCKHAM-01)

agent-os PR 8007 parked as `ci-regression-no-job`: its remediation rounds were
spent, repo-guards failed on the last remediation head, and nobody owned it. The
watcher now hands such a PR to this closer with `ciBlockedHammerOwner`
(`src/ci-blocked-hammer.mjs`), through the hammer-owner route CYCLECAPHAM-01
uses (`src/hammer-owner-route.mjs`).

- Every poll probes external CI on the PR's current head, before hammer
  reconciliation or follow-up deferral (CIBLOCKSTALE-01). A confirmed green
  current head releases the row through `requestReviewRereview` into the normal
  FIFO review queue, logging `ci-blocked released: head <sha> green` once.
  This includes head changes while a hammer is running. The parked SHA and
  the former five-minute recheck backoff cannot delay release. Red, pending,
  unknown and racing-head CI remain unclaimable. A response without the
  current head's SHA updates only the probe timestamp and retries next poll,
  without releasing, rebinding or reconciling hammer ownership. Confirmed head
  changes update the parking head before hammer reconciliation.
  Reviewer admission revalidates CI again when it claims the queued head.
  Active follow-up deferral is evaluated before hammer reconciliation while
  parked. A green head still enters FIFO; the normal admission path defers
  reviewer dispatch until active remediation settles. Closer-head suppression
  applies to reviewer dispatch, so it cannot hide a hammer's own reconciliation.
  Automatic failed-CI admission never requeues a stopped `no-progress`
  hand-off; explicit operator remediation retriggers remain available.
- The closer admits the red, unreviewed head as a final-hammer close and adds a
  "CIBLOCKHAM-01 — failed CI with no remediation job left: you are the owner"
  prompt section with the failing checks. Codex-first, the lease and every
  merge predicate are unchanged.
- CIBLOCKHAM-03: native wake admission uses that same CI-repair rule for the
  exhausted final hammer, including the stale pre-remediation verdict. A
  current-head blocking verdict and all other holds retain their wake refusal.
  Ownership uses the same rule for terminal failed conclusions: `FAILURE`,
  `TIMED_OUT`, `CANCELLED`, `STARTUP_FAILURE`, `ACTION_REQUIRED` and `ERROR`.
  Pending or unknown CI cannot acquire this repair ownership.
  Both ownership and wake inputs exclude the pipeline's adversarial-gate status.
  An empty verdict on the current head does not establish an unreviewed head;
  exhausted ownership retains `page` / `review-rounds-exhausted` in that case.
  Only a handoff that actually invoked the closer can settle a refusal. Early
  daemon or background pre-dispatch exits leave the interrupted intent intact.
  A refused, settled closer handoff retires an unchanged unlaunched intent as
  `dispatch-failed`, reason `wake-refused:<closer result.reason>`, only with a
  matching pending lease whose owner is dead or whose bounded launch reclaim
  age elapsed. Missing leases, launch receipts and live work are preserved.
  A prompt populated after intent capture belongs to that attempt when its
  timestamp and target still match; an already captured prompt must match too.
  Settlement follows the closer result regardless of the diagnostic wake outcome.
  Prompt and pending-lease cleanup require successful durable dispatch-record
  settlement; a failed write preserves both for recovery. Required-context
  filtering normalizes missing or non-string check names before matching.
  It removes the retired unlaunched prompt only when its path is an immediate
  child of its prompt directory and matches this PR's generated prompt namespace.
  CI-repair wake events stay in telemetry but are excluded from the
  `clean_verdict_to_hammer_wake` latency segment.
  Rescue derives final-hammer ownership from a `ci-blocked` row carrying
  `[ci-regression-stopped]` plus exhausted remediation evidence and live failed
  external checks on the current candidate head, filtered to configured required
  contexts when present. It fills the prompt's failed
  check list from that live rollup, so a historical stop message alone cannot
  keep the CI-blocked route active after CI changes; it does not
  choose an exact-head re-review while required CI is red. No config change is
  needed. After deployment, verify the next exhausted red head requests its
  wake and records a hammer launch in one watcher pass, and refused handoffs
  have an explicit closer refusal reason when their matching lease is reclaimable,
  while a fresh live-PID lease and its intent remain untouched.
- `ci-blocked hammer route failed … authoritative reviewed head unavailable`
  means no posted review pass with a head SHA exists in `reviewer_passes`; the
  PR stays parked as before.
- A recorded no-merge decision returns `ci-blocked-hammer-final-no-merge` and
  launches no retry hammer. That decision or an exhausted hammer retry cap pages
  SEV1 `ama.ci_blocked.hammer_final`, once per `repo#pr@head`.

A remediation round whose CI wait expires with the checks still PENDING now
completes and requests the re-review (`reReview.ciSettlement` is
`pending-at-timeout` in the job). It no longer ends `failed` with "Human
intervention required".

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

### A PR whose hammer cannot launch or has stopped (NOOWNER-01)

SEV1 2026-10-10: open PRs sat for hours with no actor until the operator
relabelled them. A PR with a posted review is now always either owned by an
actor on a bounded clock, or the operator has been paged once with the reason.

- **Pre-launch refusal** (`src/ama/prelaunch-refusal-retry.mjs`). A dispatch
  that fails before any worker launched (no launch request: provisioning or
  admission refusal) no longer parks at `dispatch-retry-exhausted` once its fast
  retries are spent. The closer retries once per pending-lease reclaim window
  (about 31 minutes at the default 600 s dispatch timeout) for 6 hours from the
  first observation that fast retries are spent. It pages once when the slow cadence starts
  (`ama_closer.prelaunch_refusal_slow_retry`, with the exact `[hq]` refusal
  line) and once when the window closes and retries stop
  (`ama_closer.prelaunch_refusal_exhausted`). Between attempts the closer
  answers `dispatch-refusal-slow-retry-wait` (or
  `dispatch-branch-holder-block-exhausted` for a branch holder) with
  `recoveryWait`. The window and page markers live on the per-head dispatch
  record as `prelaunchRefusalSlowRetry`. The original window stays authoritative
  after every failed slow attempt, including aged branch-holder counter resets;
  those resets neither resume fast retries nor extend the six-hour deadline.
  A launch clears the markers and a new head
  starts fresh. The HAM-ADOPT-01 refusal (`hammer close branch-holder
  resolution refused ...`, `hammer close could not provision a private branch
  ...`) is classified as a branch-holder block, so it no longer spends the
  redispatch budget at all.
- **Hammer stop hold** (`src/ama/hammer-stop-hold.mjs`). When the hammer's
  latest terminal audit for the live head is `failed-without-merge`, the closer
  does not dispatch another hammer on that head until the head, base SHA,
  mergeability (MERGEABLE/CONFLICTING) or the external check rollup differs from
  the hammer recorded in its terminal audit (falling back per missing input to
  the first observation or prior release), or review evidence changes, or
  primary-change evidence becomes computable after an
  evidence-collection stop (CAPROUTE-01). A newly available head/base SHA or a
  known mergeability reading after `UNKNOWN` counts as a change; missing current SHA readings and
  current `UNKNOWN` mergeability do not release the hold. Own gate exclusion
  follows the canonical CI rule: only matching status contexts are ignored;
  external check runs with that name remain inputs. Per-attempt producer
  provenance excludes daemon failures, including daemon attempts on a
  HAM-certified head, so capacity deferral cannot invent a hammer decision.
  STOPHOLDREVIEW-01 also releases `exact-head-review-required` and
  `stale-review-head` when an exact-head review posted strictly after that
  terminal attempt, including before the first hold observation. It records
  `review` and sends no hold page when already satisfied. Findings still route
  to a remediating hammer under ordinary strict policy, leases and retry caps.
  Review fingerprints use only closer observations or prior-release inputs;
  normalized eligibility-trace verdicts and finding summaries cannot replace
  them. An unchanged review therefore retains the hold and pages once, even
  when the terminal audit contains an eligibility trace. The posting-time
  release applies only to those two review-required predicates.
  Posting-time release requires the local `reviewed_prs` row to be `posted`
  with `reviewer_head_sha` matching the settled reviewed head. Live review
  reconciliation supplies bodies without verified submission timestamps; it
  cannot supply this receipt before SQLite reconciliation. If no other input
  changes, the hold remains until a later closer pass observes that matching
  posted row. Same-tick posting-time release from live bodies is not guaranteed.
  HAMUNKNOWN-02 re-evaluates GitHub-read predicates (`github-gate-not-green`,
  `pr-mergeability-unknown`) on every pass: fresh green checks and MERGEABLE
  mergeability on the same open head release with `github-gate-cleared`, even
  when the recorded baseline was already passing. Findings and primary-change
  refusals retain their holds; release does not reset retry or lifetime counts.
  Unmarked legacy entries are accepted only in unattributed or hammer-owned
  audit documents; explicit hammer markers override document ownership.
  See the [audit](data-model/ama-audit.md) and
  [hold-store](data-model/hammer-stop-hold.md) contracts. It answers
  `hammer-stop-awaiting-input-change` with
  `recoveryWait`, and pages once per head (`ama_closer.hammer_stop_hold`) naming
  the predicate the hammer recorded. When an input changes, the hold releases
  and the ordinary gates, lease and per-PR retry cap decide the one re-dispatch;
  on a hammer-rebased closer head with a stale review it re-admits the hammer
  (never on standing blocking findings, never while remediation is pending). A
  stale review on a head whose tip is not a closer commit normally keeps its
  exact-head re-review as owner. CAPROUTE-01 is the evidence-stop exception:
  `primary-change-unknown` (including legacy audits) and
  `primary-change-read-failed` are held and probed before ordinary eligibility
  on every closer evaluation of an open PR, including non-closer stale heads
  and hammer-owner routes (CYCLECAPHAM-01, CIBLOCKHAM-01). The read-only probe
  runs once per pass while unreleased. An unknown or unreadable answer retains
  the hold; a computable answer persists `releasedBy: ['primary-change-evidence']`
  and lets ordinary gates decide closure, even if that answer refuses merge.
  TRANSIENTSTOP-01 gives unresolved, unpaged evidence stops a five-minute
  posted-review cadence instead of deeper lane backoff. The durable lane
  `lastRunAt` anchors it across skips and restarts; wake priority and the idle
  starvation floor respect the interval. FINALCLOSE-01 releases
  `history-read-failed` immediately for capped retry rather than installing an
  evidence hold or a separate ten-minute page. STOPHOLDINFRA-01 excludes
  missing dispatch phase scripts and unrendered phase-script placeholders from
  holds and hold pages. Existing holds for those infrastructure predicates
  release once with `infrastructure-stop` on the next evaluation; fresh dispatch
  renders scripts again. Packaging failures preserve unrelated deterministic
  holds in force: audit selection looks past packaging stops and deferrals to
  the earlier refusal (but not past success). The pre-route fence also checks
  packaging stops against persisted refusals, including ownerless recovery.
  Unchanged refusals return `hold` without rewriting state or paging again.
  With packaging-only audit history, changed base, mergeability, checks or review
  inputs release the persisted refusal and record the new input baseline. Unknown
  or transient predicates prevent classification as a pure packaging stop.
  Preflight evaluates legacy cleanup even when no audit stop remains.
  Stops combining packaging and deterministic reasons retain the refusal after
  stripping packaging reasons. Without a current stop, legacy infrastructure state is marked released
  but returns `none`, so cleanup cannot widen admission. Released infrastructure
  holds return `none` without writing state on later ticks. Release write failures
  are logged and retain the in-memory decision for that tick. No attempts are
  refunded, so ordinary gates, leases and retry caps continue to bound recovery.
  Other predicates retain their holds and page rules. Released stops return to ordinary backoff.
  Other observed input changes and merge conflicts also release the hold.
  Hammer-owner routes retain their final no-merge decision for non-evidence
  stops on the live head; an older head's no-merge does not terminate ownership
  of a newer head. The retry-cap page now
  ends with `Last hammer stop on head <sha>: <predicate>`. State:
  `data/follow-up-jobs/hammer-stop-hold/<repo>-pr-<n>.json`.
- **Cycle-cap ownership before drain** (CAPROUTE-01). The watcher reconciles
  the capped PR's hammer owner before generic failed-row retry admission and
  before the watcher drain gate, including when the row's `revision_ref` lags
  the live head. A handled route preserves the automatic `failed` cap row
  across head moves instead of re-arming it as `pending`. Previously reset
  rows still route through the cap label and escalation marker. Like
  posted-review closure handling, this may launch a hammer
  during watcher drain; drain stops new reviewer admission, not this closure
  handoff. The closer's eligibility, lease, retry cap and lifetime ceiling
  remain authoritative.
- **Closer-head re-review decline** (`src/closer-head-rereview-decline.mjs`).
  An `AMA automated recovery:` re-review on a head whose tip carries the closer
  trailer is never spawned. The watcher restores the row to `posted` at the last
  posted review's head and records
  `rereview_reason = system-rereview-declined:closer-head:<sha>`. Automated
  recovery reads that marker and does not ask again: it stalls, then pages once
  at its deadline unless the hammer stop hold owns the PR.
- **`retrigger-remediation` with no follow-up job**
  (`src/retrigger-no-job-handoff.mjs`). A `ci-blocked` row goes to the hammer
  through the CIBLOCKHAM-01 route. Otherwise the latest posted review becomes a
  follow-up job pinned to the live head (a PR with spent rounds stops at
  `max-rounds-reached`, where the round-cap hammer handoff owns it). With no
  posted review there is nothing to remediate. In every case the label is
  removed and the acknowledgement names the action and outcome; the watcher
  logs `no-job-hammer`, `no-job-job` or `no-job-none`.
- **Conflicting PRs are never held** (REMCONFLICT-01). While GitHub reports a
  merge conflict (`mergeable=CONFLICTING` or `mergeStateStatus=DIRTY`), the
  hammer stop hold releases with `releasedBy: ['conflicting']` and does not
  page, because the hammer owns merge-conflict resolution and a rebase is the
  only input change that helps. The closer's gates, lease and per-PR retry cap
  still bound the re-dispatch. Every non-conflict stop keeps the NOOWNER-01
  hold. On the remediation side, a CONFLICTING PR's `hq dispatch` carries
  `--allow-conflicted-base`, so the remediation worker starts at the branch tip
  instead of dying in provisioning. When an accepted `retrigger-remediation`
  starts no worker within 10 minutes, the PR gets one comment naming the
  refusal (`closer-lease-held`, `max-rounds-reached`, ...).

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
| `primary-change-unknown` | Evidence was read but cannot be evaluated: a capped history/file list, omitted patches without identical trusted blob evidence, truncated patches, or unsupported structural evidence. Head races are transient. Text renames (including pure renames) are supported through `previous_filename`. This fails closed without claiming a proven reversal; `operator-approved` does not bypass it. Retain the merge hold while recovering evidence. Deterministic unknown evidence enters the existing scoped escalation route immediately; it never masquerades as `gate-read-failed`. The daemon park records `reason: primary-change-unknown` with an inspection remedy. The recovery router pages after its existing six observations for the same head, deduplicating subsequent pages. Hammer context and stop output include the missing-evidence reason. CAPROUTE-01 holds legacy unknown hammer stops on the live head, including hammer-owner routes, and probes evidence once per closer pass. A computable answer releases the evidence hold through `primary-change-evidence`; ordinary merge gates still apply. |
| `primary-change-read-failed` | A transient GitHub read failed after the reader's bounded retry budget, or the head raced the read. Installation-token auth outages and cancellation are retryable reads. Permission, missing compare, malformed JSON and process-output failures now produce `history-read-failed` with `historyReadFailed: true` and the underlying error. An actual in-lease read failure remains non-permanent; a structural unknown is a scoped primary-change refusal. This is a retryable outage, including on PRs without hammer commits, and defers closure as `gate-read-failed`. It does not require operator adjudication or write a permanent failed-head marker. The next tick retries. |
| `remediation-pending` | Adversarial-review remediation work is owed before AMA can close. |

### Primary-change evidence, authorization and disputes (HAMINTENT-02 / LAC-1833)

HAMENOBUFS-01: every production history reader projects compare metadata and
commit identity into pages of 100 without compare patches. Because GitHub caps
compare files at 300 with no file pagination, complete file evidence comes from
immutable merge-base/head trees, skipping equal subtrees and diffing individual
blob pairs locally; commit file reads paginate independently. A file/submodule
type transition diffs the file's full contents against empty bytes; a change
between two submodule pointers retains patchless gitlink evidence. Read errors
carry one `history read failed:` prefix, including when the reader already
supplied it. Each child output
is explicitly bounded at 25 MiB and exceeding that limit is a named read error.
Any failed history read returns `historyReadFailed: true` with the underlying
error, the dedicated helper exits non-zero, and the hammer records
`history-read-failed` and its underlying error in a retryable terminal audit.
Preflight stops may carry `noExecution: true`, but these read failures remain
charged to the hammer retry cap. They do not retain an input-change hold;
cap exhaustion and thirty-minute final-round stalls share one page receipt.
Missing evidence never authorizes a reversal.

**Required guard authority (GUARDREVERT-01).** A required repository check may
authorize returning only the paths it explicitly forbids in pull requests to
the live base. `src/ama/guard-reversal.mjs` independently reads the branch's
required check contexts (including app binding), the latest failed check run
on the protected author head, its output/annotations naming the path, and the
latest successful run of the same check/app on the repaired head. An absent
path in a complete base-to-head comparison proves restoration; a base move
additionally needs an unchanged path between the merge base and the live base.
Only readable added/modified text files qualify; partial repairs, renames,
gitlinks, optional checks and unnamed paths retain ordinary preservation rules.
Unavailable or incomplete evidence grants no waiver. A guard must publish an
explicit path-specific prohibition in its summary, text or annotations; its
name or a generic failed CI run is insufficient. A matching annotation path
binds each title/message statement independently, including after sentence
punctuation; annotations on other paths and check summaries must explicitly
name the prohibited path in the same statement. Rejection phrasing accepts PR
context before or after that path's prohibition.

The audit's `trace.primaryChange.guardReversals`, daemon terminal-attempt
`guardReversals` and the hammer's live `githubGate.guardReversals` record
`Reversal-Authorized-By: guard:<check name>`,
the path list, failing/passing run IDs and exact head SHAs. This live evidence
is collected outside the immutable history cache, so a required-context or
check rerun change cannot reuse stale authority. The history cache version
also advances to collect the base identity needed by old cached refusals.

`guardRepairReviewCoverage` carries the approval across this pure CI repair
only when every other file's reviewed diff is identical. The rebase variant
requires a diverged reviewed-to-primary history, advancement from the reviewed
merge base to the current merge base, and identical remaining patches modulo
hunk-coordinate shifts. Coverage snapshots retain every distinct authoritative
review commit, so later comments from the same reviewer family do not erase an
earlier approval head. Any additional content change needs exact-head review.
HAM App validation, current-head CI, mergeability, lease and other safety gates
remain independently required by their existing execution paths.

**Deterministic refusal memory (GUARDREVERT-01).** The existing hammer stop
store now identifies structured terminal refusals by repository, PR, head,
sorted predicate reasons and canonical full missing evidence. A new attempt
number or reordered reason list cannot renew the same dispatch. All closer
routes consult it before eligibility/route branching. It pages once through
`ama_closer.hammer_stop_hold`, with the exact evidence and one unblock action.
A changed head, review evidence or external check status clears the refusal;
base/mergeability and explicit operator-hold release retain their existing
release semantics. A fresh primary-change probe also releases a missing-authority
hold when authority becomes verifiable or the missing evidence changes. An
unchanged refusal survives watcher restart and later audit deferrals; a distinct refusal has a distinct
page generation. Transient reads retain their bounded retry and page grace.

GUARDREVERT-01 sibling audit (sentinel trap 227):

| Authority or closer path | Disposition |
|---|---|
| Blocking finding citations; strict-policy non-blocking citations; original and rebased/superseded review snapshots | Retained identity, ancestry, kind, File/Lines and per-region verification. Guard authority is a separate whole-path proof. |
| First HAM parent; tagged and legacy HAM provenance; recorded-launch/builder-boundary provenance | Retained baseline selection. A guard trailer cannot choose a different author head. |
| Identical rename/blob preservation and test-region exemption | Retained. Neither grants guard authority to production paths or gitlinks. |
| Operator approval, PR stated intent and operator rationale | Retained. None waives the primary-change predicate or substitutes for a guard run. |
| HAM App head validation, completed-remediation chains, fleet signatures, pure-rebase coverage, non-reviewable/trailer-only deltas and closer-only stale coverage | Retained existing head-coverage contracts; they still run the shared primary-change check. Added only the proven pure guard-repair coverage. |
| `closer-head-recovery.mjs` and exact-review recovery for missing finding authority | Retained recovery. Verified guard repairs no longer emit the primary/stale refusal that would ask for an unnecessary review. Other content still needs exact-head review. |
| `ama-check`, terminal HAM validation, daemon pre-/in-lease gates and hammer in-lease gate | All consume shared primary-change authority. Added guard proof to the live hammer audit output. |
| Ordinary findings/CI repair, pending-CI mechanical closure, daemon-decline fallback, stale-closer resume and terminal-unmerged grace | Common pre-route deterministic-refusal fence; existing retry/lease limits retained after release. |
| Review-cycle-cap and CI-blocked final-owner routes; orphan/ownerless recovery and repair redrive | Same pre-route fence, including routes that previously bypassed the stop hold. The orphan repair prompt also names verified guard authority alongside finding authority. |
| Inline watcher dispatch and background closure queue | Both invoke the same fenced closer entry point. `skipMergeAgent` prevents legacy fallback from taking over an unchanged refusal. |
| Failed/cancelled/succeeded launch reconciliation, terminal no-merge remerge branches and retry-cap redrive | Reconcile existing ownership first; no new hammer bypasses the fence. Confirmed merges remain terminal. |
| Prelaunch admission retry, priority-flag compatibility retry and provisioning recovery | Retained bounded retries: these prove no hammer execution and are not predicate refusals. |
| Legacy merge-agent operator fallback and hosts with AMA disabled | Retained explicit existing routing. No new authority, automatic retry or cancel identity was added to `follow-up-merge-agent.mjs`. |

Both merge paths use `src/ama/primary-change.mjs`. The protected baseline is the
actual first parent of the first hammer commit still present in current PR
history. A launch without a commit anchors nothing; builder and remediation
worker pushes before that commit belong to the protected author change. A login alone is insufficient: an untagged identity-matching push must follow a trusted recorded hammer launch whose target descends from the builder boundary. The boundary is the opening build-completion identity head (`rowHeadSha`), or the earliest authoritative GitHub review head for callers without that ledger identity. The current produced-head attestation is not a builder boundary. A hammer-authored trailer cannot alter either source. Commits at or before the launch target remain primary. Explicit
`Closed-By: hammer (adversarial-pipe-mode)`, and legacy worker-class trailers
identify hammer commits independently of login. A hammer-authored `Reviewed-Head` trailer cannot select an older author
head. Both primary and final diffs are compared against the current PR base,
using the same merge base so rebased upstream changes are excluded. Hammer closure detection
uses the terminal commit trailer block. Finding-based reversal authorization additionally
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
does not preserve its protected baseline, even with identical bytes and a
trusted hammer rename proof. Both rename-proof destinations and the final
diff's renamed paths enforce this production-to-test boundary. Chained renames
from a builder-renamed path may collect the same identical-blob hammer proof
when both the intermediate path is absent and the merge-base name remains
removed or renamed; restoring the merge-base name does not qualify.

PCCSLOW-01: daemon, hammer snapshot and full-context CLI share atomic history
records under `data/primary-change-history`, keyed by repository, PR, base SHA,
head SHA, merge base, reviews and dispatcher provenance, with builder-boundary
compatibility checked on reuse and a `reversalprov-v3` identity version to
invalidate older proof records, including original-reversal refusals cached before
context-tolerant matching and insertion/mixed-restoration authorization. Already-held PRs recompute on
their next evaluation without head/review movement or a manual cache purge. Live head/base and
merge-base metadata are checked before reuse; CI-cost evidence remains live. Only completed successful
history reads are stored. An unresolved optional rename-proof read failure
prevents caching; a later valid proof resolves earlier failures for that source
path only. A daemon timeout cancels merge execution while the
bounded history read finishes and stores evidence for the next tick; stall logs
name the running read and elapsed seconds. The existing cache sweep removes
records older than seven days and retains at most 512 records, without a new knob.
Compare pages use four workers; blob pairs and tree pairs are fetched together.
Metadata-only cost reads avoid reconstructing patches they do not consume;
each page/blob/diff retains the existing output bound.

Merge-gate `fetchPrimaryChange` reads and the default context CLI never collect
refusal snapshot attribution. Commit-file removal/rename attribution is retained
alongside rename proof. When no possible destination exists, these metadata-only
diagnostic reads stop after 20 commits and report truncation; rename proof keeps
the full candidate range. For operator investigation, run
`node bin/primary-change-context.mjs OWNER/REPO PR HEAD --diagnostics` outside
merge execution. This explicitly calls `fetchPrimaryChangeContext`, evaluates
the refusal with the effective `strictNonBlockingRemediation` policy, and compares
snapshots for at most the first 20 commits from the first hammer through the
candidate head. Attribution has a separate 15-second wall-clock budget; expiry
aborts its reader and returns partial attribution with a budget error. Larger
ranges report truncation, and capped or otherwise incomplete snapshots report
an error instead of attribution. Cancellation, auth outages, transient transport
errors and reader failures propagate and stop collection. Other diagnostic
errors never change the independently computed verdict or authorize a merge.
Older cache records without `diagnosticCommitRange` fetch that range only on
explicit diagnostic requests. Snapshot results appear in the CLI evidence, are not cached,
and do not add GitHub reads to daemon, closer or in-lease hammer gates.

The [primary-change history data model](data-model/primary-change-history.md)
defines the record layout and retention. Cache access and sweeping require the
canonical runtime data owner's effective UID; `data/`, the store directory and
existing records are checked before mutation, and asynchronous publication
rechecks ownership. Hammer workers under another UID must run the snapshot or
full-context helper through `sudo -A -H -u <owner>` with the canonical owner's
runtime environment and `HAM_ROOT_DIR`. Ownership mismatches fail as history
read failures before a worker can publish a private `0600` record in the daemon
tree. No automatic ownership changes occur; pre-existing wrong-owner cache
files require operator cleanup before retrying under the canonical owner.

The hammer's `bin/primary-change-context.mjs` reads each GitHub endpoint through
`execGhWithRetry`: transient transport, timeout, rate-limit and HTTP 5xx failures
get at most three attempts with 500/1000ms backoff and a 15-second timeout per
attempt. Permanent permission errors are not retried; rejected credentials use
the helper's single forced token-refresh attempt. Exhausted reads and malformed
JSON emit head-scoped `historyReadFailed: true` evidence and a non-zero helper
exit, which the predicate treats as `history-read-failed` rather than a proven reversal. The hammer prompt's
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
API-published HAM commits with GitHub's `web-flow` committer retain the shared
identity requirement: a linked HAM author and `verified: true` / `reason: valid`.
The bounded history reader fetches compact verification separately for rename,
current reversal, and historical reversal-snapshot proofs, binding it to the
same immutable commit SHA. Missing, invalid, mismatched, or unreadable verification
cannot authorize a reversal; signatures never replace review or line coverage.
Hydrated commit reads (including failures) are shared within one history
evaluation, so multi-file rename scans fetch verification once per commit.
A fresh evaluation reads verification again. A verification SHA mismatch records
`commit-provenance` in `rejectedReversalAuthorizations`, including for historical
snapshots; an otherwise unclassified verification read error records `unverifiable`.
Equal-length replacements map by line position; unequal-length replacements
require the finding to cover the entire projected span. Insertion-only regions
remain protected: deleting the insertion requires a citation covering its entire
introduced span and HAM removals covering the remaining parent-state added-line
multiset at its projected parent coordinates (REVERSALPROV-02). In-place repairs
may still change introduced text while preserving the changed region. A one-line finding cannot waive the uncited
remainder of a contiguous author hunk.
Unrelated regions, missing trailers and old reviews outside
the closure cannot authorize a reversal. Restoring a deleted base line requires
matching HAM additions, including when the author hunk also introduced new lines;
that restoration does not require deleting the retained author additions.
Opaque files and rename checks remain
fail-closed. Other merge safety checks remain unchanged.

**Rebased reversals (REVERSALREBASE-01).** A rebase or conflict-owner rebase
rewrites the HAM commit, so its parent no longer descends from the cited
`Reviewed-Head` and the reviewed head keeps an older merge base. When the
compare from the cited review head to the HAM parent is exactly `diverged`, the
collector still accepts the citation if the trailer is on a HAM commit in the
current history, the review is on this pull request and contains that finding
and kind, and the protected region has the same removed/added-line multisets in the
reviewed diff (`<base>...<review head>`) as in the current primary diff
(REVERSALPROV-02). Multiplicity matters; matches must remain unambiguous in both
diffs. Distinct additions disambiguate hunks with identical deletions; identical
changed-content segments still refuse ambiguous mapping. Context, offsets and
changed-line order do not establish authority.
Reviewed-parent content comparisons retain path, status and changed-content
multisets while ignoring context and hunk partitioning. A citation with no later
superseding authoritative review remains current by GitHub review order.
If a later review supersedes it (same family, or another family on another
head), the first such review's immutable head must contain the original HAM
commit with the same message and complete reversal content: each file's path,
previous path, status and ordered changed lines must match, retaining hunk and
context-run boundaries and newline-marker attachment. Context text/counts and
hunk offsets may drift; reordering edits, moving an edit across a context run or
hunk, or moving a newline marker to another line/side refuses the original proof.
REVERSALPROV-01 also admits a linked HAM author with a foreign linked rebase
committer when exact-SHA App validation verifies, or the immutable original
HAM commit passes the shared identity predicate and carries the same trailer
set and reversal patch identity described above. Only this provenance proof
may ignore a changed commit subject. Without either proof the citation is
rejected as `rebased-commit-unproven`. A linked foreign author, conflicting
identity trailers, or unsigned web-flow committer still fails as
`commit-provenance`; a HAM committer alone cannot establish rebase provenance.
App validation does not waive the original proof for a superseded citation.
The reviewed-parent rebase proof uses the same context-independent content
comparison. The collector verifies original HAM identity, citation freshness
at its original parent, and the parent's merge base. The evaluator rechecks finding coverage and the HAM commit's removed content
against both the original and rebased patches. It derives the protected content
from that commit's own parent diff, so earlier in-place repairs and split deletions
can be followed by a cited removal of the remaining span. The authorizing patch
must overlap the projected parent region; only removals within that region count
toward its parent-state content multiset. Identical text elsewhere in the file
supplies no authority. Full-span coverage is cached per commit to avoid repeatedly
scanning an unequal-length replacement for every base line.
A primary deletion may still be restored under its cited finding: the
authorizing commit must add back the matching deleted content with sufficient
multiplicity. This retains the existing deletion-restoration authorization.
Author and committer dates supply no freshness evidence. Missing or capped snapshot history cannot establish that
original authorization and refuses the waiver. Coordinates are translated
through matched changed content for File/Lines coverage. Insertion-only regions
map to their full introduced span and appear in reversal diagnostics when
removed without authorization. Whole-file absence for newly added files, opaque-file
preservation and renames remain independently protected. Changed, ambiguous or
missing content, an unknown review or finding, or a review superseded before
the reversal stays refused. Every refusal carries
`missingEvidence` (with collector and evaluator rejection reasons, including
missing findings and failed patch or File/Lines coverage; verified counts include
only citations that passed evaluation) into the hammer gate
JSON (`primaryChangeMissingEvidence`), the hammer's closing status and the
watcher's hold log. An original-reversal proof rejection keeps its reason code
and adds `detail` naming a missing same-message candidate, change-line mismatch
paths, or another failed proof check. Mismatches list at most five paths of at
most 160 characters each, plus `(+N more)` for omitted paths. Opaque or malformed
original candidate patches are rejected with candidate diagnostics; the search
continues through later candidates, and refuses authorization if none is valid.
The complete detail
is limited to 1200 characters and the operator summary to 4096 characters,
including a trailing `...` on truncation. Diagnostic time-budget exhaustion is
reported before the rejection details so it survives summary truncation. The
operator diagnostic budget remains 15 seconds. When a HAM head's own exact-head
self-certification failed
only on that authorization (`stale-review-head`, `verdict-not-settled-success`
and `blocking-findings-unknown` are its cascade), the closer marks the
`primary-change-repair-required` refusal `exactHeadReview: true` and the
LEASEDEFER-01 leaf requests one bounded exact-head re-review instead of an
operator hold. The merge stays refused by the predicate until the evidence is
valid. Recovery runs before the primary-change page; only a refused recovery
falls through to paging. `missingEvidence` alone does not authorize that review:
`exactHeadReview` requires the HAM self-certification checks above.

**The hammer's dispute adjudication is final (HAMFINAL-01).** Operator decision,
2026-10-10, after agent-os PR 7987:

> "https://github.com/laceyenterprises/agent-os/pull/7987 also why didn't the hammer merge here. We need to investigate and fix so this doesn't happen again. Hammers judgement is final"

On PR 7987 a chunked re-review raised one real blocking finding and two false
"Malformed JSON" chunk artifacts. The hammer disputed the two, the dispute
requested a same-head re-review, the watcher skipped it as a duplicate
(`commit_id match`), the gate settled on `remediation-stopped — operator decision
required`, and the hammer stopped "pending adjudication" without remediating the
real finding. The operator hand-merged over CHANGES_REQUESTED.

For a blocking finding that is false on the exact head, the hammer preserves the
code and runs `bin/dispute-finding.mjs` with `--root-dir`, `--repo`, `--pr`,
`--head-sha`, `--review`, `--finding` and `--evidence-file`. It keeps its merge
lease. The evidence is bounded to 16,000 UTF-8 bytes and must be concrete
exact-head evidence: a fenced block quoting the repro command and its output, or
quoting the head file. Prose-only evidence is refused before anything is posted.
Before opening SQLite or performing DDL, the helper
requires its effective UID to own the existing `data/reviews.db`, its data
directory and any WAL/SHM sidecars, and the configured alert sink owner boundary
(resolved through `ADVERSARIAL_ALERT_DELIVERY_ROOT` /
`AGENT_OS_ALERT_DELIVERY_STATE_DIR`, with the pager's normal default). Missing
databases and cross-user writes fail before mutation. Run the helper as the
canonical daemon owner (for example `sudo -A -H -u <owner>` with that owner's
environment and the existing HAM GitHub identity). A different-user
hammer shell refuses with exit 78; a non-HAM GitHub identity refuses with exit 79.
Preserve evidence and record a no-merge handoff rather than switching accounts
or credentials in the worker.
The helper verifies the live head and the latest submitted authoritative review
in its ancestry; a superseded blocking review cannot be withdrawn.
It posts a HAM-authored comment carrying `Resolution: withdrawn-by-hammer`, the
finding identity (`sha256([title, file])`), the exact head (`Reviewed-Head`), the
reviewed head of the finding, `Evidence-SHA256` and the evidence. It rechecks the
live head, then records the same fields in `ham_finding_disputes` and wakes the
watcher. **No re-review is requested**, so the watcher's same-head duplicate
guard cannot strand the PR and no skipped audit can block it. A failed post,
untrusted identity or head race records nothing and exits non-zero; the finding
then still stands. A rerun is idempotent only for the same finding identity,
evidence head and finding reviewed head. A newer authoritative review on the
evidence head requires fresh admission even if it repeats the identity.

The withdrawal is final. The adversarial gate, the closer predicate
(`isEligibleForAmaClosure`, `bin/ama-check.mjs`) and the HAM self-cert treat a
withdrawn finding as resolved when its identity matches a blocking finding of
the cited review, its `Finding-Reviewed-Head` matches that review's head, and its
`Reviewed-Head` matches the current evaluated head. Descendant-head evidence
cannot resolve a finding after a branch reset to its reviewed ancestor.
Cross-head carry-forward requires independently validated coverage or content
equivalence; the withdrawal itself supplies neither. `ama-check` requires the
local durable admission in `data/reviews.db` under `--root-dir` (default: the
adversarial-review checkout), matching the comment node ID, HAM author,
full-body digest, both heads, finding identity and evidence digest. It also
re-hashes the comment's embedded evidence. Unrecorded, edited or non-HAM
comments and missing/unreadable stores resolve nothing.
A review whose every blocking finding is withdrawn projects the gate as
`success (hammer-adjudicated)`, never as "operator decision required", and is a
settled verdict for closure. Before each merge attempt, `bin/hammer-merge.sh`
calls `bin/dismiss-withdrawn-reviews.mjs` under the held lease, after predicate
admission and the required-check gate. It reads complete live review/comment
lists and the local withdrawal store, verifies the same durable admission and
comment evidence as `ama-check`, and dismisses only authoritative
`CHANGES_REQUESTED` reviews on the exact live head whose complete blocking lists
are withdrawn. It rechecks the review body and live head before dismissal.
Reviews with standing or unknown findings, older-head reviews, and unrelated
review vetoes remain. A read or dismissal failure refuses merge; GitHub still
enforces branch protection without an administrative bypass. A withdrawal-only
PR needs no HAM commit. `ama-check` retains dismissed review bodies as finding
authority so an interrupted merge can retry; dismissal alone resolves nothing.
Any finding still standing is remediated and
certified as before. The hammer continues in the same run: it remediates the
remaining findings, lists each withdrawn finding in its audit as
`- **<title>** (blocking) — withdrawn-by-hammer: Evidence-SHA256 <digest> on head <sha>`,
then rebases, validates, checks required checks and merges under its lease.
Reviewer prompts on the same head still receive the trusted withdrawal comments
(recorded `resolution = 'withdrawn-by-hammer'`, trusted HAM author, recorded node
ID, head and body digest; 16,000 bytes per comment, 256,000 bytes total) and are told not to re-raise those findings
against the unchanged head. The evidence never grants merge authority beyond
resolving the named finding.
Legacy disputes with nullable resolution are omitted from this final-withdrawal
context even when their comment provenance is valid.

Neither finding-anchored reversal nor dispute raises `hq decision raise`.
Disputes no longer spend the review cap, page, or emit
`ama_finding_dispute_exhausted`; the `requests`, `refusals` and `paged` columns
remain for legacy rows.
Preservation refusals retain the merge hold as
`primary-change-repair-required` with `needsOperator: true` until the REMORPHAN-01
watchdog admits a repair worker. Refusal observations alone no longer page.
The dispute page guard persists across restarts. Read outages remain `gate-read-failed`
and retry normal ticks after transport/auth recovery. Recovery-store or pager
failures are logged and always retain `skipMergeAgent: true`.

For a refused head, inspect the explicit diagnostic CLI evidence described above
and repair the PR branch or restore missing history/patch access. A new head re-evaluates
the predicate. If evidence recovery needs another worker, an attributable operator
can apply `merge-agent-requested` scoped to the current head and latest PR update.
The existing operator-fallback lane accepts both the closer's
`primary-change-repair-required` and the daemon's `primary-change-needs-operator`,
with `needsOperator: true`. The orchestrator promotes the daemon refusal to
the top-level result before the closer runs. A nested daemon refusal is accepted
only under that promoted `primary-change-needs-operator` result or the daemon's
own `daemon-failed-closed` wrapper; wrapper support is defensive compatibility,
not a shape the current primary-change producer emits. `manualCloseRequired`
is a paging signal and does not authorize this recovery lane.
Co-occurring non-primary-change safety reasons in either the top-level or nested
daemon result, including `operatorReason`, prevent fallback using the shared
recovery safety classifier. This exception does not include other safety holds:
risk/two-key policy, security, destructive-change holds, hard-stop labels
(including `no-merge-hold`) and hammer-cap suppression retain adjudication.
An unresolved `dispatch-status-unknown` probe retains AMA ownership even after
its dispatched lease expires: lease age cannot prove the hammer has stopped.
A nested primary-change refusal cannot override that top-level ownership result
or hammer-cap suppression. The checked-in #7716 fixture has the already-supported
closer shape (`primary-change-repair-required`, `needsOperator: true`); it does
not establish the cause of that PR's production hold. Diagnose a live recurrence
from its watcher result, label event, review row and closer lease state before
attributing recovery to nested-result handling.
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
the primary-change predicate. OWNERPROOF-01 replaces REMORPHAN-01's tick and
reason admission with a PR-wide elapsed absence-of-owner clock. On an open,
non-draft, unheld PR, a live reviewer/remediator process, a nonterminal launch in
the session ledger, or a current-head review request younger than the bound
proves ownership. A current-head pending closer lease also proves ownership
while its watcher PID is live and its launch expiry has not elapsed. Recovery's
post-acquisition ownership probe excludes its own watcher PID from that lease
check; competing leases and other live ownership evidence still hold dispatch.
Queued jobs, other leases, refusal reasons and unreadable ledger results alone
do not prove ownership. A proven owner clears the clock; head movement does not.
After 15 minutes (`OWNERPROOF_IDLE_MINUTES` accepts a positive override), request
current-head review when no authoritative review exists, otherwise request HAM
repair. Historical stops and retry counters do not prevent that dispatch.
Each external action reserves one of two per-head attempts before launch;
refusals, exceptions and missing receipts still consume the attempt. The next
ownerless observation pages with both durable outcomes, once delivery succeeds.
Pending/failed review rows visit this watchdog before ordinary retry admission;
posted rows visit it through closure orchestration. A daemon merge completed on
this tick settles as terminal before the watchdog, even if the earlier PR read
was OPEN. A scoped `merge-agent-requested` retains operator fallback precedence.
HAM keeps quota admission, operator holds, merge leases and all live merge
predicates. Its primary-line edits require HAMINTENT-03 per-finding
`Reversal-Authorized-By` trailers or restoration of reverted lines. See the
[watchdog data model](data-model/orphan-watchdog.md) for migration and evidence.

LEASEDEFER-01 lets the closure orchestrator request an immediate
`system-orphan-head-review:<headSha>` for a recognized closer-trailer tip when
HAM returns `not-eligible` and every reason is one of `stale-review-head`,
`verdict-not-settled-success` or `blocking-findings-unknown`, including the stale
head reason. Before requesting review, recovery requires no held AMA closer
lease for the PR at any head and a negative `probeOrphanOwnership` result for
queued/running launches and remediation. Live or uncertain ownership returns to
ordinary retry and the bounded watchdog. Hard refusals are classified first:
labels, terminal PRs, disallowed risk classes and branch-protection/fast-merge
failures retain `needsOperator` routing without requesting review. The watcher-owned
`duplicate-family-unresolved` census hold retains its 30-second automatic retry.
The leaf retains the durable per-head `heads.rereview` guard and lock, set
before attempting the request. OWNERPROOF-01 instead uses its shared
two-attempt review/HAM budget. Failed current-head review rows
never reset through this leaf. Only a triggered request, or a returned row
with the exact `system-orphan-head-review:<head>` marker and revision, returns `closer-head-exact-review-requested`, mapped to
`ama-pending` while the watcher owns that review. A refused request falls through
to OWNERPROOF-01 with its PR-wide idle clock, two per-head attempts and
exhaustion page; refusal never creates an unconditional wait.
A closer-trailer tip can arm stale-head HAM resume after a rebase breaks the
closer-only chain only after an authoritative live-review probe finds no review
on the new head. Without chain proof or authoritative reviewer identity, resume
stays off and an ownerless head can request exact-head review. This intentionally widens dispatch beyond ancestry-proven closer-only chains:
intervening worker commits may enter the hammer repair lane. The hammer owns
final adjudication of that head; dispatch admission is not merge certification.
While an exact-head review is pending/reviewing, the stale-tip path skips the
additional live-review/commit/certificate probes. This admits repair only: the terminal-remediation validator still proves the exact head and its
`reviewed-head` binding before merge.

STALECLOSER-03 shares `closerAuthoredStaleEligible` across the closer, eligible
hammer wake (also exposed to agent-os rescue). OWNERPROOF-01 does not require
closer-only ancestry for recovery dispatch. A proven
closer-only chain may carry a settled clean reviewed verdict to its current
head. Exact-head pending CI or unknown mergeability yields `retry`; green CI
and `MERGEABLE` yields `eligible`; resolved conflicts are hard misses and cannot
reopen an exhausted hammer cap. Once eligible, dispatch may persist one extra
series/target retry grant per head, while preserving the lifetime ceiling and
all ordinary authority gates. Spent grants survive head churn and fresh reviews.
Carry-forward observations are audited once per closer head; audit write
failures warn without changing authority. See the
[hammer retry ledger](data-model/hammer-retry-cap.md) and
[carried-verdict audit](data-model/closer-authored-stale.md) for durable fields.

Across-head launch records prove ownership only through a nonterminal session
ledger status. A `dispatching` intent without a launch ID is uncertain; queued
reviewer/remediator records alone are not live ownership. Launch terminality
shares the closer capacity classifier, including operator triage and reaped
statuses. Unreadable, corrupt or missing launch evidence advances the same idle
clock as an absent owner. Ownership probes use PR-filtered settled directory
listings and the coexistence timeout; synchronous ledger subprocesses are
bounded by the remaining probe budget. Immutable terminal results are cached.
Every recovery writes an `outcome-unknown` entry before the external call and
settles it with bounded reason, action, timestamp and launch/review-request
results. There are no refusal or exception refunds. Legacy missing outcomes
remain explicit unknown summaries. Page enqueue failures retry without another
launch. Deduplicated delivered or dead-letter exhaustion pages end watchdog
enqueue retries. Dead-letter pages warn once and remain an operator-actionable
alert sink failure; the page guard does not assert successful transport.
SQLite state and a nonblocking flock live under
`data/follow-up-jobs/orphan-watchdog`; restarts preserve budgets and page guards.
Filesystem, flock, SQLite and malformed-evidence failures log and page through
`ama.orphan_recovery.store-error`, retaining `ama-pending` and `skipMergeAgent`.
The watchdog precedes ordinary automated recovery and comment-only CI handling
throughout grace and exhaustion. A new head gets a fresh attempt budget, while
returning to an old head preserves its budget; the PR-wide idle clock survives
both. Scoped operator merge-agent fallback keeps precedence. Recovery dispatch
runs inline even when ordinary HAM dispatch uses the background queue, including
pending-CI-only ownerless heads, so the watchdog records its outcome. HAM must
still satisfy all ordinary merge gates. See
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

`REVIEWGUARD-01` reads generated-path prohibitions from the live PR base
configuration. Before publication, the reviewer drops cards whose entire remedy
is an explicit edit to those paths; if no blocking findings remain, a
`Request changes` verdict line becomes `Comment only`, including when followed
by explanatory notes. For already-posted non-blocking findings, the hammer's
`bin/guard-forbidden-paths.mjs` helper emits policy resolutions and audit details
in strict mode. Unknown policies and mixed remedies remain unresolved. Cards
containing code fences are retained conservatively, while clean neighbouring
cards can still be filtered or resolved. Policy resolutions do not waive any
merge safety gate; follow the helper's audit instructions in the hammer prompt.

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
   audit-comment body, and doc-currency evidence. HAMVERIFY-01 also accepts an
   entitled `HAM-Validated-Head` audit for the exact live head when the complete
   head-only ancestry is GitHub-verified and bound to trusted fleet App authors
   with GitHub's `web-flow` committer (or GitHub-signed base merges with
   `web-flow` as committer and verified/valid verification, whose second parent
   is reachable from the live base). Locally signed human base merges require
   exact-head re-review. The versioned
   `bin/hammer-head-context.mjs` helper discovers the live PR base and retries
   transient reads at most three times with 500/1000ms backoff and a 15-second
   per-attempt timeout. The prompt bounds collection to 90 seconds; any failed
   provenance proof releases the lease and requests one bounded exact-head
   review. Proven heads retain merge ownership without another review; all
   ordinary structural merge gates still apply. The zero-finding path is
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
`HAM_FAILING_TESTS_FIXED`. Also supply `HAM_DOC_CURRENCY` (`applicable`,
`not applicable`, or `skipped superproject-doc obligation`) and a single-line
`HAM_DOC_CURRENCY_REASON` naming the covered changed files and any updated docs
or skipped superproject obligations. Publication replaces standalone
`Doc-currency:` attestations in the details file with this rendered claim;
finding titles containing `Doc-currency:` are preserved. Supply these before
rendering the helper. Consumers prefer the standalone claim and retain legacy
unclassified `- Doc-currency:` validation bullets and inline audit prose as
fallbacks, excluding finding bullets and lines with
`(blocking)` or `(non-blocking)` finding classification markers. A successful
post or refresh sets `HAM_PUBLISHED_AUDIT_HEAD` to the head that the audit names.
The `hammer-merge` phase requires that marker and an owned, run-scoped `HAM_VERDICT_FILE` produced after audit publish by a successful `ama-check` call. The caller sets `HAM_VERDICT_READY_FILE` to the same path only after that call succeeds and removes the file after merge. The verdict must have
`eligible: true` and a matching current head before reading GitHub's required
check gate or attempting merge. A missing prerequisite appends a
`failed-without-merge` terminal audit. Publish and merge failures release the
base merge lease, including failures after GitHub confirms the merge; the AMA
closer lease is separate and remains available for recovery.

Before acquiring or queuing for the base merge lease, `ham_acquire_merge_lease`
reads live PR head/state/draft/labels. A changed head, closed PR, draft or operator
hold returns `merge-lease-admission-refused` (exit 20) and appends an audit with
phase `hammer-lease-admission` and reason `merge-lease-admission:<reason>`.
Operator holds and drafts use `deferred`; changed heads use `superseded`;
closed PRs use `failed-without-merge`. Transient live gates do not create
NOOWNER-01 stop holds: labels and draft state remain closure-owned gates.
Pre-lease admission produces no merge-action receipt because no held-lease merge
decision or execution occurred; the admission audit is its durable evidence.
Audit-write failure is fatal. A live `MERGED`
state returns `already-merged` (exit 20), without a refusal audit. The closer's
`evaluateHammerStopHold` owns historical terminal stops and their release;
the hammer does not re-read them for lane admission. Thus NOOWNER-01 releases
on changed inputs and REMCONFLICT-01 conflict releases admit same-head
re-dispatch to rebase under the ordinary lease and merge predicates.

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

HAMUNKNOWN-01 tracks settled `background-pr-mergeable-unknown` cycles separately
from charged recovery actions. K cycles are tolerated, using the same
remediation-derived cap; more than K cycles exhaust only after 30 minutes
(`stuckDeadlineMs`) since the first UNKNOWN in that series. Queue/in-flight
observations, probe-unavailable results and coexistence timeouts neither spend
nor reset this series. Gate-level `closer-head-mergeability-unknown` and nonempty
`not-eligible` results containing only `pr-mergeability-unknown` or
`labels-unavailable` are also neutral, preserving the series and any UNKNOWN
event. A different resolved blocker resets its count and clock.
Recovery supplies a lane-only `urgent` boolean: UNKNOWN waits and backgrounded
probes remain urgent only through K settled cycles, with no exhaustion event.
Beyond K, normal backoff applies while the wall-clock floor runs; scheduled
probes still escalate. Ordinary `ama-pending` returns carry no closure reason
or recovery snapshot, so submission/settlement alternation does not change
the lane decision fingerprint or spend its reset cap.
UNKNOWN exhaustion names `background-pr-mergeable-unknown`
in the existing SEV1 event and page. When a different resolved blocker arrives,
its UNKNOWN-origin event clears so hammer/re-review recovery can resume;
successful `pagedReasons` receipts remain for per-head, per-reason deduplication.
A later different exhaustion reason pages again on the same head. Legacy
`paged` receipts migrate before clearing the event; see the data-model doc.

A refused action or exhausted action cap must remain non-progressing for 30
minutes (`stuckDeadlineMs`), independent of tick count. Re-review queue states
`pending`, `reviewing`, and `pending-upstream` are exempt from the recovery
re-review deadline; their own stall monitoring owns queue latency. An unchanged
posted snapshot without an active review expires after 30 minutes. At either
non-progress deadline the watcher returns `recovery-exhausted`, persists and logs
`ama.automated_recovery.exhausted` with severity SEV1, reason, PR, head and
attempts, and queues one page per head and reason with a stable outbox identity.
The outbox also deduplicates by reason and honors matching legacy receipts.
Failed page enqueue
retries without duplicating a successfully queued page. A new head starts a new
recovery budget. The merge kill switch continues to disable execution.
Store fields, lock semantics, retention, and safe reset procedure are documented
in [AMA Automated Recovery](data-model/ama-automated-recovery.md). There is no
automatic pruning of state or stable lock files.

CCX-11 (2026-09-30): `hammer-corp` is an accepted primary/fallback hammer class on
the second Codex OAuth account. It keeps the hammer route and merge-capability
identity. The cross-model fallback default remains `[hammer-claude]`.

LANEFAILOVER-01: unpinned Codex workers resolve accounts before dispatch using
the same fleet quota, weekly measurement, freshness and broker readiness
evidence as REVIEWCORPFIRST-01 (PR 1367). Workers use **personal first**:
`hammer` and the `codex` remediator stay personal while ready with capacity.
Confirmed exhaustion or broker unavailability permits an independently ready
corporate account, selecting `hammer-corp` or `remediator-codex-corp`.
CODEXFALLTHRU-01: unknown/stale personal evidence also permits independently
measured, available and broker-ready corporate capacity. It does not prove
personal exhaustion. If no account qualifies, any unknown evidence returns
`codex-account-evidence-unknown`; otherwise the hold reason is
`no-ready-codex-account`. Every fresh dispatch resolves again, so personal
recovery restores the personal class automatically. Codex reviewers remain
**corporate first** and hold on unknown/stale preferred-account evidence.

This applies to AMA closer dispatch, merge-agent recovery dispatch and Codex
remediation claims. Explicit worker-class pins retain their previous behavior:
a concrete file/env/CLI class value wins over code defaults or builder routing,
including a personal pin. Already account-specific corporate classes are preserved. Existing
supported configuration surfaces are unchanged; for example, the AMA
`roles.adversarial.merge_authority.worker_class` supports `hammer-corp`.
No config key, label, CI check, merge predicate, lease or retry budget is added.
Claude-engine selection is unchanged. Account substitution does not send a
cross-model fallback alert.

Each dispatch emits one account line with its class and reason, for example
`codex_account=personal worker_class=hammer reason=personal-ready` or
`codex_account=corporate worker_class=hammer-corp reason=personal-unavailable-corporate-ready`.
Unknown personal evidence followed by ready corporate capacity reports
`reason=personal-evidence-unknown-corporate-ready`.
Reviewer spawn logs also name `personal` or `corporate` and the routing reason.
After deploying the watcher and follow-up consumer, verify personal-class logs
while personal has capacity, then corporate-class logs after confirmed personal
exhaustion or stale personal evidence without adding a pin. Inspect existing pins
if automatic routing does not engage. Observe real account evidence; do not alter live quota state to test
failover. Merge eligibility remains enforced independently on either account.

HAM context emits an under-8192-byte summary; use `bin/primary-change-context.mjs` for full patches. Commit identity stays local; merge decisions fetch primary evidence lazily and forward cancellation. The hammer in-lease merge re-fetches evidence independently of its claim. Transient evidence errors cannot suppress CI/conflict repair dispatch. Current commit provenance selects the first hammer parent, including login plus recorded-launch provenance for untagged hammer repairs after the builder boundary. Base merges use the first parent only after verifying the second parent belongs to the base ancestry.

Primary evidence readers use an explicit runtime root when supplied, otherwise
`HAM_ROOT_DIR`, otherwise the code checkout. Deployments with a separate runtime
root must set `HAM_ROOT_DIR` for CLI and head-closer processes; the daemon and
rendered hammer lease gate pass their configured root. `ama-check --primary-change`
is required for all calls; an explicit no-HAM evidence result is still required.
Launch records never select the primary head directly: the first proven hammer commit's parent does. They corroborate login-only untagged pushes after the builder boundary. A launch without a matching subsequent push anchors nothing. Unreadable launch evidence is retryable; unsupported ancestry or missing builder evidence escalates as a structural unknown. Tagged history does not require launch evidence unless login-only commits also need classification.
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
records. Dispatching intents retain capacity inside the bounded pending-launch
window. Unreadable, missing or budget-skipped ledger evidence preserves same-PR
ownership under existing liveness rules and reserves fleet capacity while the
record is inside the bounded pending-launch window. Unreadable retry chains reserve the
same bounded capacity even when the ancestor is terminal. Live ledger
statuses still obey the age escape for workers that die without a terminal write.
Confirmed missing LRQs expire after the existing pending-launch timeout;
launch-only records with no parseable launch timestamp stay held. Before any
ledger query, the dispatch scan checks identity, record age and lease liveness.
Aged-out records release capacity without a probe or rewrite; historical cleanup
belongs to the CLI. Production PostgreSQL capacity scans share a single timeout-bounded read-only
launch snapshot restricted to eligible dispatch IDs and their transitive retries, enabled through the
watcher's retry-status wrapper and forwarded to every per-record read. A failed
snapshot is reused as unreadable evidence, without repeated PostgreSQL queries.
SQLite reads remain in-process.
Injected per-launch readers stop further probes at the one-second budget or
first unreadable result. Cancellation is checked between probes. In-flight `dispatching`
intents are never probed or rewritten, because retries may carry a previous LRQ.
New launch writes clear old `terminalLaunchStatus` and `reconciledAt` annotations.
When HQ exits with only a same-worker provision-slot lock timeout and the
holder PID is live, the closer records `dispatch-deferred-transient`, preserves
the retry budget, and releases the failed attempt's pending lease. The next
watcher poll can retry provisioning after contention clears; the refusal is
logged through `ama_closer.pending_lease_released_after_dispatch_refusal`.
A launch receipt or mixed diagnostic does not qualify for this slot-timeout
classification. Embedded newlines in the holder's `cmd` metadata are accepted;
an additional HQ diagnostic still refuses this classification. Launch receipts
retain ownership for normal reconciliation,
and competing live pending leases remain protected from duplicate dispatch.
The capacity-only `reaped`/`cancelled` statuses do not expand per-PR retry authority.
Launch completion is not merge success. Capacity reconciliation leaves leases
untouched; the current PR decision path separately reconciles its own record and
lease before eligibility, inside the existing operation timeout. A terminal
`succeeded` launch on a confirmed live OPEN same
head settles as `failed-without-merge` after the readable `terminal_at` grace
(60 seconds; missing timestamps settle immediately), unless GitHub reports an
armed `autoMergeRequest`. Both synchronous lease reconciliation and watcher
dispatch read that field and retain ownership only inside the 30-minute
dispatched-lease window; observations never refresh that clock. Expiry emits
`ama_closer.auto_merge_hold_released` once per launch in the dispatch turn and settles as `failed-without-merge`,
allowing bounded CI-repair retries. A no-merge audit bypasses the hold. Audited
no-merge outcomes also release the lease. When the worker status is stale-active
but the ledger says `succeeded`, the watcher keeps raw `succeeded` for the terminal-success classifier rather than
mapping it to the retryable `unverified-terminal-success`. Live PR state,
no-merge audits and merged-signal evidence then decide retry/refund eligibility;
an advanced OPEN head is still a no-merge exit, and unknown merge evidence
retains the existing ownership hold when no live PR/audit proof resolves it.
Dispatch records still persist the mapped observation separately from
`terminalLaunchStatus`. Confirmed merges stay sticky; existing retry, series and
lifetime caps still apply. A delivered wake for a reconciled no-merge LRQ may
re-fire once for that attempt. Running hammers remain duplicates.

After deployment, verify that a retryable no-merge exit launches again on the
same head in the next watcher pass, queue-depth live launches match the ledger,
and no active-launch deferral identifies an already-terminal launch. During a
ledger outage or skipped probe, fresh reservations still appear in queue depth
until the pending-launch window expires. An OPEN PR with auto-merge armed must
retain its lease inside 30 minutes without spending another attempt; after that
bound it must release and allow a retry within caps even with red CI.
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

HAM reconciliation safety: apply refuses a caller whose UID differs from the dispatch-directory owner; dry-run is available to other accounts. Missing rows use the latest observation age and are never terminalized when every ledger probe is missing or a scan is unreadable. Each applied rewrite emits `ama_closer.launch_capacity_reconciled` with backend/source metadata only. The shared production snapshot uses the ledger adapter timeout; fallback per-launch probes, including in-process SQLite reads without snapshot rows, admit queries for at most one second. Unprobed, missing and unreadable records preserve PR ownership and reserve fleet capacity inside the bounded pending-launch window; after that window, existing liveness rules may still retain same-PR ownership without fleet capacity. Concurrent observation changes prevent a stale rewrite, and current terminal evidence is preserved.

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
It does not automatically switch accounts or tokens. Since HAMFINAL-01 a
dispute requests no re-review and never pages; exit 0 means the finding is
recorded `withdrawn-by-hammer` and the hammer's adjudication is final.

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

HAM finding authority is scoped per reviewer family on the same reviewed head. An authoritative review from any family on a newer descendant head supersedes older-head citations. Finding disputes use the same freshness rule; the hammer's withdrawal is final and requests no re-review. The hammer prompt includes the effective strict non-blocking policy; ama-check and the in-lease gate resolve module config and code-pr domain policy with the same precedence as daemon closure.


### Orphan watchdog evidence boundaries

OWNERPROOF-01 does not classify refusal reasons or require closer-authored
ancestry. Current-head authoritative review evidence chooses review versus HAM
repair after the elapsed bound. Unreadable queue files are scoped by PR filename
prefix; repository matching is case-insensitive. Ledger probes use the record's
HQ root and cache immutable terminal results (up to 1,000 entries). Missing or
unreadable ledger rows remain uncertain, without proving a live owner or
refunding an attempt. Review-request errors consume the same bounded attempt as
HAM errors. Only a proven owner clears the PR-wide idle clock.

### LEASEPARK-01: certified-head contention queue

Lease acquisition timeouts and pending-required-check deferrals are written as
`deferred` AMA audit attempts, keyed by the full certified head. The closer
resumes a validated HAM head through the existing daemon merge predicate rather
than launching remediation again only while verdict misses are limited to pending
CI. Structural policy holds and operator-required refusals remain authoritative;
red CI or conflicts route back to hammer remediation. A pending-check timeout
is deferred only when pending CI is the sole live gate miss; conflicts, strict
BEHIND, closed PRs and labels retain a failed-without-merge audit.
During the remote-check wait, the hammer defers primary-change and CI-cost
evaluation until checks are green, then fetches real exact-head evidence before
allowing merge. This applies in both advisory and blocking CI-cost modes;
pending checks never supply synthetic cost approval. The other live gates
remain active throughout the wait. Required checks, primary-change, exact-head,
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
Before lease acquisition, verify-head waits at most 300 seconds for the published
`HAM_PUSHED_HEAD` to replace `HAM_PUSHED_FROM_HEAD`. If the initial read still
shows the pre-publication head, the first retry follows a two-second delay;
later retries use fifteen-second intervals, clamped to the remaining deadline.
Each visibility probe is bounded to 30 seconds or the remaining deadline,
whichever is shorter. Transport
errors and probe alarms retry within that same deadline; permanent errors and
malformed or missing head data remain fatal. Visibility probes read PR metadata
without check runs or commit statuses; the subsequent lease check reads the full
rollup on the visible head. Only successful reads with a full head SHA replace
the cached PR JSON. Exhaustion reports `published-head-timeout`
with the elapsed head/check wait times; a different live head leaves the wait
and follows the existing race path.
Publication and verify-head export `HAM_HEAD_WAITED_SECONDS` and
`HAM_REQUIRED_CHECKS_WAITED_SECONDS` so subsequent child processes inherit the
current wait totals for audit reporting. Phases that update them must run in
the persistent shell; child-process changes do not propagate back to a parent.
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
reservations under the explicit watcher `rootDir` at `data/ci-recovery/` cap
each check/head at one request and deduplicate checks belonging to the same
workflow. The original cancelled attempt
is treated as pending; a later cancelled attempt raises one operator decision.
Legacy `dispatch/ci-recovery/` reservations migrate lazily when their identity is
accessed, preserving budget evidence. An existing destination reservation wins;
the matching legacy file is removed after successful migration. New reservations
stay in the gitignored `data/` tree to keep the checkout clean for deployment.
Failed POSTs and failed alert delivery release their action reservation for a
later tick, after fresh workflow reads. GitHub reads use bounded retries; the
POST itself is not retried in-call. Paging uses the shared operator-decision
alert path and its durable delivery bus. See
[CI recovery reservations](data-model/ci-recovery-reservations.md) for identity,
state, retention and ambiguous-crash handling. Recovery errors log and preserve
the existing CI classification instead of aborting the candidate or daemon.
The daemon performs no recovery POST or bootstrap paging with autonomous merge
execution disabled.
Failures and pending/missing checks never enter this recovery path.

An empty rollup still means unknown. No-CI bootstrap additionally queries the
repository's workflow inventory, base branch, classic protection when applicable,
and effective ruleset rules. Unreadable APIs, configured required contexts, or a
pending adversarial status cannot authorize bootstrap. Green managed pre-push
evidence must match the repository and full head SHA and carry a valid Ed25519
runner signature verified with the deploy-owned public key in every hosting mode.
Exact-head commit statuses and check suites must also be empty. Budget-deferred evidence is
never green for bootstrap. Without evidence, the watcher pages once with
`repo has no CI`.

A settled zero-finding review stays on the merge path only for a current,
MERGEABLE head waiting on empty/no-CI evidence or cancelled-check recovery.
Conflicts, real CI failures and stale heads still fall through to capped HAM
repair, including the HMR-01 terminal-grace route. Only an explicit `ciMergePathPending: true` from the daemon
authorizes this wait; an empty candidate snapshot alone cannot bypass the
bounded closer/daemon disagreement fallback. Fresh daemon failure evidence
wins over the older candidate snapshot. The daemon and merge-agent bootstrap paths
preserve current-head review or HAM certification, safety-core, protection,
lease, and autonomous execution gates. Each merge attempt refreshes the proof;
`bin/ci-bootstrap.mjs --repo OWNER/REPO --pr NUMBER --head SHA` provides the
merge-agent's immediate pre-merge verification. Audits flag
`ciMode: no-ci-bootstrap`.

Repository stand-up should provision a minimal CI workflow (agent-os
STANDUPCI-01). This repository only handles the existing zero-CI gap; provisioning
is follow-up work in agent-os.

HAM hardening: stale CI action reservations resume after 60 seconds using fresh workflow evidence and exclusive recovery claims. Bootstrap requires signed Ed25519 evidence in every hosting mode and empty exact-head commit-status/check-suite APIs. Empty rollups with configured workflows fall through to bounded HAM escalation. Candidate side effects require explicit clean-review and execution-switch authority; timeout handoffs cannot supply that authority. The bootstrap verifier retries GitHub reads; exit 75 permits bounded retry and exit 65 means missing evidence.

### STANDUPGATE-02: audited closure when no CI is configured

The strictly zero-finding, settled-success daemon route can close an empty
check rollup only for repositories explicitly declared by the operator in
`roles.adversarial.merge_authority.no_ci_repositories` (a list of exact
`owner/repo` names, case-insensitive; default `[]`). This declaration covers
external CI that cannot be ruled out by a GitHub configuration lookup. Until the
parent Agent OS Python schema and shell loader register the key, **only the
watcher environment override is safe**:
`AGENT_OS_ROLES_ADVERSARIAL_MERGE_AUTHORITY_NO_CI_REPOSITORIES`. Do not add
`no_ci_repositories` to shared `config.yaml` yet; strict non-Node readers reject
it. Parent loader parity must ship with the submodule bump before YAML enablement.

Live GitHub reads must corroborate the declaration: neither the base nor the
reviewed head contains Actions workflows or known external-CI configs
(CircleCI, Buildkite, Jenkins, Travis, Azure Pipelines, GitLab CI, Vercel,
Netlify, Bitbucket Pipelines, Drone, AppVeyor, Cloud Build, Woodpecker,
Semaphore, or Codemagic), the reviewed head has no check runs, concluded suites or commit
statuses (complete empty queued suites created by installed Apps are ignored), and the target branch has neither required-check rules nor required
workflows. Config detection includes nested paths and is best-effort; the
operator declaration remains necessary. Classic branch protection is checked
along with every page of effective ruleset rules. Configured required contexts
also refuse the exception.

A live no-CI proof substitutes the CI predicate **and waives the required
adversarial-gate branch-protection predicate for that repository's daemon call
only**. Keep `roles.adversarial.merge_authority.branch_protection.required: true`:
other repositories, configured-CI heads, and every call without proof retain
`branch-protection-missing-gate`. Listing a repository alone never waives the
gate. This is an explicit per-repository operator exception to required gate
protection, necessary because required status checks themselves rule out no CI.
GitHub's other branch rules continue to apply to the actual merge.

The daemon evaluates the real rollup and cheap eligibility gates first. It
probes only an opted-in, strictly clean settled-success empty-rollup head whose
only misses are `ci-not-green` and, optionally, `branch-protection-missing-gate`.
Conflicts, closed PRs, holds, stale heads, and unreadable gates retain their
original eligibility reasons and hammer routing without probe calls. Permanent
head refusal follows ordinary eligibility, but short-circuits a would-be probe.

Permission failures (including protection-read 403/404), unsupported CLI flags,
malformed responses, and truncated trees log a refusal and preserve the original
eligibility outcome. Only transient transport, timeout, 5xx, and rate-limit
errors defer before the lease or retry under it; bounded exhaustion records
`gate-read-failed`, `permanent: false`. After reading the base SHA, independent
reads run concurrently and all settle before returning. Production probe calls
use 1-second subprocess timeouts without inner transient retries; the daemon
owns the retry budget, within the enclosing coexistence operation's abort signal.

Under the lease, already-merged and moved/missing-head checks precede any probe.
Fresh real CI is evaluated first on each attempt. If a previously admitted
no-CI proof is revoked or CI appears, a failing gate records `gate-not-eligible`,
`permanent: false`, without a manual-close requirement. Later ticks may retry
the same head; genuinely green real CI can pass without a no-CI substitution.

`ciConfiguration` records `reason: "no CI configured"`, repository, base, head,
base head, and check timestamp in top-level daemon audit metadata (pre-lease
proof) and on the successful `daemon-merged` attempt (latest in-lease proof).
The evidence corroborates an explicit operator declaration, rather than
inferring absence of external CI from an empty rollup. Identity, attestation,
primary-change, mergeability, matching-head, hold, lease, and kill-switch gates
still apply. Successful daemon closure short-circuits hammer dispatch and
operator escalation. The shared check classifier still rejects empty or pending
rollups everywhere else.

RCA: searchlight#2 had an empty rollup, so the daemon's shared eligibility
predicate returned `ci-not-green`. The fallback hammer was dispatched (watcher
log records `lrq_46c92584-a470-4014-9080-fd5c49d855c3`), but the terminal-remediation
mandate requires a non-empty provenance commit (`dispatch-closer.mjs`,
`composeCloserPrompt`), and zero findings authorized no remediation diff.
This configuration exception removes that circular dependency without inventing
findings or weakening the hammer's remediation contract.

STANDUPGATE-02 probes use 15-second subprocess timeouts without inner retries, bounded by the daemon operation and recovery caps. `gh api --paginate --slurp` requires [GitHub CLI 2.51.0](https://github.com/cli/cli/compare/e83e04930641e062249dc4aba2cba5b2d35d1278...v2.51.0) or newer; older versions refuse the proof and log the unsupported flag. Top-level `ciConfigurationAdmission` records pre-lease admission; `attempts[].ciConfiguration` records the proof actually used by a successful merge. Newly concluded red CI follows normal permanent gate refusal; only empty or pending rollups permit retry after proof revocation.

HAMCIWAKE-01: `closer-commit-trailer` review-spawn suppression also supports
CI-green resume. A bounded ancestry walk must prove that every commit since the
reviewed head is a closer commit before the watcher reads that head's verdict
and findings; CI and mergeability still refer to the exact live head. A pending-only
hammer exit durably records audit-only `resumeOwed` and `resumeHead` diagnostics
and logs `hammer-ci-pending-resume-owed`; no runtime consumer reads these fields.
The watcher independently proves ancestry and reads live CI each tick. Pending-only
CI returns an ordinary recovery wait without a hammer retry or recovery charge;
red CI still enters the capped hammer repair lane. A pending deferral marks the
lease retryable before release even if the audit append fails (hard-block exit 20
reports that write failure). The CI-green wake resumes the normal leased
verify-and-merge lane without minting a review. Each new closer head has its own
dispatch budget; the lifetime ceiling bounds repeated closer pushes across heads. The
OWNERPROOF-01 watchdog uses live ownership and elapsed time independently of
refusal reasons or closer ancestry. After the bound, absent current-head review
evidence requests review; present evidence requests HAM repair.
Local Git provenance retains its trailer fallback because it has no GitHub-linked
identity. Remote commit probes require linked closer identity. This existing
local trust boundary is tracked by LAC-1848; a trailer alone never grants merge
authority, and the downstream hammer repeats live gates.

HAMUNKNOWN-02: the hammer merge procedure samples an open, exact-head
`UNKNOWN` mergeability up to three times with bounded backoff, retaining the
shared required-check polling cadence (about 60 seconds by default). This
applies both while waiting for CI and at the final pre-merge refresh. Each
sample re-evaluates the full GitHub gate; a moved head, closed PR, conflict,
red check or pending check never authorizes merge. Persistent UNKNOWN records
`deferred / pr-mergeability-unknown`, marks the merge lease retryable before
releasing it, and exits without a terminal `failed-without-merge` decision.
While required CI is pending, exhausting the mergeability sampling budget
continues polling until CI settles or `HAM_REMOTE_CI_WAIT_SECONDS` expires
(900 seconds by default); UNKNOWN defers at that deadline or once CI succeeds.
Red CI ends sampling immediately and retains its ordinary failure outcome.
Moved heads and closed PRs cannot use the retryable UNKNOWN deferral.
When UNKNOWN persists through a pending-CI deadline, the audit retains
`pr-mergeability-unknown` for queue routing and records
`remoteCiStatus: mergeability-unknown-ci-timeout` plus the last check conclusion
in `githubGate`; green CI uses `remoteCiStatus: mergeability-unknown`.
Certified HAM heads resume through the existing bounded deferral queue,
including its backoff, expiry and lifetime refund bound. Live UNKNOWN alone or
with pending CI remains a wait in that queue, without a merge or immediate
operator escalation. Red CI or conflicts still route to bounded repair,
including red CI alongside UNKNOWN; independent eligibility holds still apply.
Fresh exact-head
eligibility and merge gates remain mandatory before daemon merge or a repair
dispatch.

## CI-cost mode (CIGUARD-01 / CIGUARDADV-01)

CIGUARDADV-01 records the 2026-10-06 operator decision, "Cost guard advisory
now", superseding the unconditional CIGUARD-01 merge refusal. The AMA cost
predicate is advisory by default: `checkCiCost` returns
`{ ok: true, advisory: <reason> }` for flagged, failed, missing, stale or
unreadable evidence. The reasons remain `ci-cost-unauthorized`,
`ci-cost-check-failed` and `ci-cost-read-failed`. Spend controls are the org
budget cap, billing read and ci-spend-alarm. Authoring CI changes still
requires operator authorization; specs must state cadence and runner OS and
justify non-Linux per-PR jobs.

Live primary-change collection also reads workflow blobs at the merge base and
candidate head, all PR files, current labels and paginated label events, plus
current-head cost check results. This operates for every repository, independent
of branch protection. The offline cost engine is vendored at
`scripts/ci-cost-guard.py` from agent-os; keep the copies identical when changing
policy. JSON mode needs only Python's standard library, while Node owns YAML
parsing through its existing js-yaml dependency. API truncation, malformed YAML,
unresolved dynamic runners/matrices and unavailable Python still produce
negative evidence; the selected mode determines whether it refuses merge.

Set `AMA_CI_COST_MODE=blocking` to restore CIGUARD-01. Only that value
(case-insensitive) selects blocking; unset and all other values select advisory.
In blocking mode, a flagged change requires `ci-cost-approved` last applied by
a human listed in `roles.adversarial.operator_logins`. An empty list authorizes nobody. Neither
`operator-approved` nor terminal HAM remediation can waive this check. A failed
or pending cost check still blocks after authorization until CI reruns green.
Missing, stale or unreadable cost evidence also refuses merge in blocking mode.
The daemon and closer reach the predicate through `checkPrimaryChange`; the
merge-agent procedure runs `bin/ci-cost-check.mjs` immediately before its
exact-head merge command. That CLI emits JSON containing both the gate result
(including an advisory reason when present) and the raw cost evidence; it exits
zero for an advisory result and nonzero for a blocking refusal. The evidence
collector still retains workflow findings, estimates and authorization results in
`primaryChange.ciCost`; `checkPrimaryChange` does not forward the advisory reason
in its own result. Required-check greenness and primary-change preservation
remain independent gates: advisory cost mode cannot make a failed required
CI check green or certify unreadable primary-change history.

Apply the mode override consistently to watcher, follow-up/closer and
merge-agent environments so all merge paths use the intended policy.
After the submodule floats into the deploy checkout, or after changing a
daemon's mode environment, restart the watcher and
follow-up daemons through the registered `scripts/os-restart.sh` operator path
so long-running processes load the new predicate. Do not admin-merge this gate
change or edit live service state to make the gate green.

Merge retries strictly read the withdrawal store and revalidate the withdrawals
that supported admission before each merge attempt. Dismissed authoritative
same-head review bodies retain finding authority: deleted or edited comments,
missing records, and unreadable stores refuse a retry. Duplicate title/file
identities in a blocker list are ambiguous and grant no withdrawal authority.
Eligibility routing uses standing blocker counts; original counts remain in
`trace.verdict.originalBlockingFindings` for audit.

PRIMARYEMPTY-01: `primary-change-unknown` is a deterministic evidence refusal, not a transient read. Daemon and closer enter the existing scoped recovery/escalation route; the durable park names `primary-change-unknown` and its remedy. After six observations the existing router pages once for that head. Genuine `primary-change-read-failed` outages still retry. CAPROUTE-01 includes legacy unknown hammer stop audits in the live-head evidence hold, including CYCLECAPHAM-01 and CIBLOCKHAM-01 routes. Each closer pass probes once; unknown or unreadable evidence keeps the hold, while a computable answer persists `primary-change-evidence` and resumes ordinary gates. The hold pages once per head through `ama_closer.hammer_stop_hold`, independently of the daemon recovery router. Proven
`primary-change-reverted` decisions retain their existing recovery contract.

Transient-only eligibility declines retain the ordinary stall clock and page after `stuckDeadlineMs`, while remaining neutral to the UNKNOWN series. Pending re-review ownership and its expiry are evaluated before settled UNKNOWN recovery.

Background mergeability probes log sample count and elapsed milliseconds; null re-reads retain the previous live snapshot. Sampling remains bounded to three probes.

The qualified missing-reversal-authorization recovery lane also admits standing
finding refusals inherited from the stale review (blocking or non-blocking).
This permits only a bounded exact-head review request; merge remains refused.
CI, protection, labels and live ownership refusals still prevent recovery.

HAMVERIFY-01: hammer publication uses GitHub's `createCommitOnBranch` API with
its own entitled App token and an expected head lease, only for one single-parent
local commit descending from the freshly fetched remote head. Rebased and
multi-commit histories use the lease-protected git fallback: the API cannot
preserve their ancestry or all commit messages. Both ordinary remediation and
conflict resolution invoke the versioned publication procedure. GitHub signs the commit;
the publisher compares the returned and fetched tree IDs with the tested local
tree before adopting the new SHA. API-created fleet commits have the fleet App
as author, GitHub `web-flow` as committer, and verified/valid verification.
Unsigned git-pushed commits cannot qualify merely through an email-mapped login.
The publisher retries transient `gh pr view`, API and `git fetch` transport
failures at most three times with 500/1000ms backoff and a 15-second per-attempt
timeout, within the existing 120-second publication window. Permanent errors
and malformed responses take the fallback immediately. Mutation retries retain
the original expected-head CAS; an ambiguous server-side success cannot authorize
an overwrite. Both fallback git push routes release the merge lease and abort
on rejection, including a stale lease following an API timeout.

HAMCLOSE-01: the starting PR head is captured once in `HAM_BASE_HEAD`, before
edits. `bin/hammer-base-head.mjs` uses `execGhWithRetry`: three total transport
attempts, 15 seconds each, with 500/1000 ms backoff. Permanent errors or an
invalid SHA abort startup before edits rather than exporting an empty base.
It is trustworthy when it is the review record's reviewed head or when
App-authored comments connect that reviewed head to it through exact
`HAM-Base-Head` / `HAM-Validated-Head` edges. GitHub authenticates each comment's
author; a builder token cannot post or edit a hammer App comment. Commit SHAs
bind immutable content, while the reviewed head comes from the review record.
Builder-authored text, commit authors, committers and signatures are not needed
for this proof. Earlier edges remain available; retries deduplicate only the
same App-authored base/head edge.

The worker's exact reviewed starting base is reported as
`proof: reviewed-starting-base`; it does not claim any traversed App or
remediation-round edges. App-attestation and completed-remediation-round chain
proofs require at least one edge. Without a captured starting base, an exact
reviewed current head goes through ordinary comparison validation.

Completed remediation rounds provide another starting-base proof when their
completed start/result edges link the reviewed head to the captured base and
GitHub confirms every link is strictly ahead, or a diverged link is proven by
authenticated `HeadRefForcePushedEvent` records whose actors are fleet Bots
(built-in or configured App identities). The timeline read is all-or-nothing,
capped at ten pages of 100 events; incomplete, malformed or unreadable results
provide no force-push proof. Each chain follows at most ten force pushes, rejects
cycles, and uses the most recent event for a reused starting SHA after a branch
reset. Every traversed event requires a trusted Bot actor; a link succeeds at its
recorded result or when GitHub confirms that result is ahead of the event's new
head. The CLI omits absent or invalid pagination cursors.
The prompt exports `HAM_ROOT_DIR`
from dispatch's `rootDir`; the CLI reads daemon-owned state beneath
`$HAM_ROOT_DIR/data/follow-up-jobs/completed`. This is distinct from `HAM_HQ_ROOT`
and the PR worktree. Manual CLI callers must export that runtime root to use
round evidence. Missing/unreadable directories supply no round proof; if no
other starting-base proof exists, the CLI exits 65 and requests exact-head
review. Lookup opens only JSON filenames with the existing
`<sanitized-repo>-pr-<number>-` job ID prefix, compares repo names without case
sensitivity, and still validates each record's repo, PR and completed status.
It asynchronously iterates the flat directory and reads matching records without
blocking the event loop; unrelated historical jobs are not read or parsed.
Completed-round proof is attempted before lazily fetching PR comment pages for
the App-attestation fallback. Each immutable start/result comparison is evaluated
at most once per proof attempt, including non-ahead and unreadable comparisons.

HAMCLOSE-07 adds branch activity as a fallback when existing proofs decline.
It reads the PR's head-repository ref activity, including fork branches, through
GitHub Link cursors with a ten-page all-or-nothing bound. From the latest
departure from the reviewed SHA, every remaining event must be a contiguous
push or force push on that ref by a built-in or configured fleet Bot. Each
`after` commit must independently pass `fleetCommitIdentityMatches`: a valid
GitHub signature, web-flow committer, and trusted fleet author. A push actor
alone supplies no content authority. The complete chain structure is checked
before commit lookups run in parallel batches of at most four. Any unreadable
or untrusted commit refuses proof after the batch settles. The chain
must contain the captured hammer base (when supplied) and end at `currentHead`.
Reaching the base or an intermediate target never skips trailing activity;
untrusted pushes, other ref mutations, gaps, and a different final head refuse
proof. A distinct current head is included only when activity proves every step
to it, rather than being appended to a starting-base proof. Successful ranges
report `proof: branch-activity` and the complete validated `steps`.

Activity proof is scoped to the current hammer run. The closer does not load
activity or reconstruct the captured starting base. A deferred hammer head must
therefore have an independently provable App-attestation, completed-round or
commit-DAG chain before the closer can certify it; activity success alone does
not authorize daemon closure or waive an exact-head gate.

The audit lookup uses `gh api --paginate --slurp` to read all comment pages
as one JSON payload. `bin/hammer-audit-comment-id.mjs` parses that payload
once and searches across the pages, including pretty-printed responses.

API and CAS git publication use the same starting-base rule. Immediately before
attesting, the audit procedure confirms the remote SHA equals local HEAD. It
posts both SHA lines using the hammer token, validates the required checks at
that exact head, and merges under the shared lease. A foreign push above an
attested head has no matching edge and cannot inherit its authority. An
unproven starting base or unreadable proof requests exact-head review. The
stale-head prover and daemon also require this App chain; old prose audits
and forgeable commit identity fields cannot authorize a moved head.

The prompt runs `bin/hammer-review-handoff.mjs` as `HAM_HQ_OWNER`, using
`sudo -A -H -u` when the worker differs, so lease and review state retain
canonical daemon ownership. The helper requests the existing bounded exact-head
review CAS before recording the closer lease as `handed-to-review`. A thrown
request leaves the lease dispatched and eligible for ordinary failure settlement
and capped hammer retry; it never claims a completed transfer. The request is a
local SQLite CAS, not a GitHub network mutation. This is a completed
handoff, not `failed-without-merge`. The handed lease does not block reviewers
or daemon closure. A clean review merges through the daemon; any findings,
including Comment only findings, admit another hammer through the existing
retry and lifetime caps. Reclaiming the handed lease for that hammer is locked
and still uses atomic single-claim acquisition.

`decideClosureOwner` in `src/ama/closure-owner.mjs` exposes the shared ownership
answer alongside orchestration results. Diagnostic `merge-agent-stuck` and
`retrigger-review` labels do not grant or suppress ownership; operator holds
remain enforced. LEASEDEADPID-01 shares pending/dispatched reclaim predicates
with closer dispatch: a dead local watcher's pending lease or an aged reclaimable
lease is treated as absent on the next ownership evaluation. Local PID probing
requires `holderHost` to match the current hostname or be absent on a legacy
lease; foreign-host pending leases rely only on age expiry. Both reclaim
predicates accept ISO strings or numeric epoch milliseconds for `now`. Ordinary routing
then selects the owner, including hammer for final comment-only findings in
strict mode, without an operator step. The decision leaves lease files intact;
the acquisition path reclaims them. Live pending leases and sticky succeeded
outcomes retain their holds. The daemon retries lease contention after 250 and
500 ms in the same tick. Pending gates, uncertain/live ownership and deferred daemon
attempts record a bounded wait in `data/ama-closure-waits/` (see the
[wait data model](data-model/ama-closure-waits.md)); the default limit
is 30 minutes, adjustable through `AMA_CLOSURE_WAIT_BOUND_MS`. Exhaustion
reserves one page naming the PR, head and reason. The coexistence router keeps
that wait/page out of the independent orphan and recovery accounting. Finished
worker teardown failures remain logged cleanup debt and never change the
closure outcome.

The offline HAMCLOSE-01 test enumerates 17,280 combinations of verdict,
reviewed/untrusted/attested head, closer lease, retry and lifetime caps,
mergeability, required checks, remaining rounds and the two diagnostic labels.
It invokes the production ownership, closer eligibility, merge eligibility,
check classification, stale-head, hammer-remediability, retry-cap and rescue
adapter decisions, asserting
one named route with bounded waits and pages at exhaustion.

The JavaScript rescue classifier also accepts the authoritative ownership
projection and uses the shared decision for structured ownership inputs. Its
legacy path keeps Approved findings in remediation and treats the stuck label
as diagnostic. `buildMergeAgentDispatchJob` forwards an available ownership
projection instead of independently overriding it.

Parent-repository rescue scope remains in agent-os:
`modules/worker-pool/lib/python/cwp_helm/merge_agent_rescue_classifier.py`
still classifies Approved/Comment only with findings as inconclusive, which
`modules/worker-pool/lib/python/cwp_helm/merge_agent_rescue.py` turns into
escalation. Those two files must consume the shared `closureOwner`
answer (and the review-handoff lease) rather than treating that handled state
as a reviewer-contract violation. This repository ships the decision and
pipeline transitions; it does not edit or deploy that parent classifier.

### Empty-diff closure and capped review routing (HAMCLOSE-02)

The watcher may close an open code PR only after live metadata reports a
non-draft PR with known labels and no operator hold (`do-not-merge`,
`no-merge-hold`, or `merge-agent-skip`), zero changed files, and an empty
base/head compare. A final metadata read must retain those conditions and the
same base and head before closing with the empty-diff comment. Draft and held
subjects skip this probe; missing draft or label evidence on live reads defers
closure. In-progress placeholder drafts therefore retain their PR.

When delivered reviews reach the ceiling on a moved head, closure routing
restores the latest completed, posted first-pass or re-review with a non-null
head. Both capped closure routing and re-review admission derive their ceiling
from the greater of the current risk-class round budget and the latest follow-up
job's persisted integer `maxRounds`, plus one review. A raised legacy/operator
budget therefore keeps moved heads eligible for re-review until that ceiling
is reached. Invalid or lower persisted values retain the risk-class budget.
Remediation/closer comments never supply review head or posting time.
Without such a review pass, the router leaves the row unchanged. Stored review
bodies and verified artifact evidence count as delivery even before comment-id
backfill. Posted legacy rows without pass history retain the attempts fallback.
Generic failed rows are not revived; every routing transition logs prior status.
CEILINGPUSH-01 makes repeated observations idempotent: an already routed row
retains closure ownership without another write or transition log. The native
hammer wake admits stale-head/verdict misses for this ceiling handoff independently
of the legacy exhaustion dispatch reason or exhaustion snapshot, as
`review-ceiling-terminal-remediation`, preserving the last review's findings
at the reviewed head and targeting the live head. Active remediation and all
independent policy holds retain their existing admission rules. The closer's
ceiling route owns terminal remediation; merge still requires exact-head HAM
validation of every finding and green required checks. No extra review is
admitted. A `remediation-closeout` wake settles explicitly as
`skipped: review-ceiling-hammer-owned` in the posted-row lane. If closure cannot
act, the existing final-round durable wait records the refusal and pages once
at its 30-minute bound. After deployment, verify the next such PR reaches a
hammer lease, terminal validation and merge without an operator hand merge.
The ledger and ceiling are computed only when the review head has moved.

The watcher persists the last head verified nonempty and probes again only on a
new head or a zero-file snapshot. Calls use API telemetry. Closing precedes the
single comment, so a failed close cannot duplicate comments on retry.
Read or close transport failures defer the subject before reviewer admission,
without claiming a pass, spending an attempt or caching the head as nonempty.
The next tick retries the probe.

Reverted or unknown primary changes page once per head and prevent further
hammer dispatch, including orphan recovery. The obsolete orphan primary-repair
exception is removed because unknown authorization needs operator ownership.
Read/head/cost failures wait with a bounded deadline. The caller supplies strict
policy. Immediate primary-change pages and bounded waits have separate reason
classes, deadlines and page reservations, so neither suppresses the other.
Deployment of `waits_by_class` does not migrate legacy `waits` rows. Existing
wait deadlines and page reservations restart once at the first observation of
each head/class; bounded waits can therefore incur another 30-minute default
window. The old table is retained but no longer read. See the wait data model
for schema and recovery details.
Replay coverage uses invented histories and an offline transport that rejects
unrecognized paths.

### Reviewer seat handoff (SEATIDLE-03)

Non-pipeline reviews enable admission/settlement splitting by default. The
watcher commits the post success or failure before releasing admission. The
runtime and its identity lease have ended at this boundary; process reservations
are removed before token accounting. Token-ledger lookup/retries, token artifact
writing, and reviewer-pass completion continue outside the seat. The evidence
reader can call `queryPostgresRows` / `spawnSync(psql)` (30-second subprocess
timeout) and traverse transcripts synchronously, so it runs on a separate reader
process. At most two accounting reader processes run concurrently; each active lookup has
a bounded lifetime. A blocked ledger therefore cannot block the watcher's event
loop after capacity release. A failed durable
row write retains the seat through the fallback settlement path. Exceptions
before release still reach the pool's thrown-failure circuit breaker.

The inline final-hammer handoff starts at the post callback under a separate
in-process PR fence. Discovery skips that PR while its handoff runs, and queued
candidates for it remain deferred. Other PRs can use the credential immediately.
The durable posted row remains the recovery handle after a watcher restart; all
existing current-head, closer lease, and merge-eligibility checks still apply.
Sequential pipeline domains retain their full-pass reservations.

The shared dispatch drain prepares a bounded next wave while reviewers are
busy. Preparation holds no claim or credential reservation. Completed maintenance
is keyed by route and retained for that discovery snapshot, so a multi-minute
review cannot expire it and repeat slow work at handoff. Rediscovery replaces
the candidate and its cache. Mutable CI evidence uses a short TTL; live PR state
and exact-head dedup refresh last on each admission wave before capacity is
reserved. The admitted run
consumes those results; the existing head lease, durable claim CAS, memory and
credential gates still run. Route spillover prepares the new route before the
pool rechecks capacity. Preparation errors retain the existing refusal behavior.

`reviewer seat handoff: model=... post_to_spawn_ms=...` measures from the exact
review attempt's captured durable post timestamp (`reviewer_passes.body_captured_at`)
to the next process-start callback on that model lane. It survives an empty handoff and a
later poll admission. Missing post evidence or an adapter without a process-start
callback produces no invented process gap. The older
`reviewer admission on capacity-freed ... idle_ms=...` measures only release to
runtime admission, so it excludes both the post-to-release interval and adapter
startup before the process callback. These logs describe
model lanes, not individual identities in a multi-identity pool; use the single
seat deployment for the acceptance comparison.

`reviewer settlement timing` logs split token-ledger lookup (including retry
attempts), token/artifact/pass completion, durable row settlement, and the inline
final-hammer handoff. `reviewer preflight timing` logs individual preparation
probes. Use these to attribute the observed settlement delay after deployment;
static inspection alone cannot identify which external call consumed its time.

After deployment, SRE confirms the watcher restarted. With a backlog on a single
seat, measure the post-to-spawn median over a few hours; the target is under
15 seconds. Cross-check adjacent `reviewer_passes.ended_at` / `started_at` values
as a separate execution-gap signal (they do not share the durable-post origin).
No host environment edit is required when
`ADVERSARIAL_REVIEW_ADMISSION_SETTLEMENT_SPLIT` is unset. Explicit `0`, `false`,
`no`, or `off` retain legacy settlement inside admission as an operator rollback.
No CI runner, trigger, or gate is added.

The durable post lookup uses the effective reviewer model, including fallback
routes, to match the persisted reviewer pass. Token-ledger evidence uses a
shared two-worker reader by default. Tests and embedded runtimes may use
`createReviewerEvidenceReader({ maxConcurrent })` from
`src/reviewer-token-ledger-lookup.mjs` to own an isolated accounting queue;
its limit must be a positive integer. Queue capacity is released on worker close,
including reader failure and timeout, before the next queued lookup starts.

### REBASEPROV-01: conflict-owner rebases and hammer accounting

Before publishing a HAM validation audit, `bin/hammer-head-context.mjs` can prove
that the hammer's starting head is a replay of the reviewed series on the live
base. `src/ama/reviewed-rebase.mjs` compares the ordered, complete binary patches
of linear commit series across the entire repository, regardless of the caller's
working directory, excluding base history. Whitespace, modes, renames,
binary content, missing patches and intermediate source edits remain significant.
Commit counts and patch positions must match one-to-one, including empty commits
and commits whose only changes are registered generated outputs.
On success the HAM audit records the reviewed SHA as its base edge, allowing
the daemon to reconstruct the exact-head App attestation after the worker exits.
The proof is bounded to 256 commits per series; parent topology is checked in
one bulk Git invocation per series. Missing objects, nonlinear
history, unknown policy and failed generator verification fail closed to the
existing exact-head review handoff. A fleet force-push actor cannot substitute
for a failed content proof on a diverged starting head.

Generated exceptions come only from the deployed GENCONFLICT committed-file
registry for the matching repository. Outputs rewritten relative to the replay
base must match regeneration from each replayed commit's merged sources, using
the registry's trusted-code checks. Verification copies raw Git blobs into a
temporary directory; it does not execute a branch-supplied registry or alter the
worker checkout. Unsupported trees and unavailable generators refuse coverage.
Without an installed registry, whole-patch equivalence remains available.
The verifier accepts `--trusted-root <installed-policy-root>` for standalone
helper installations; the closer supplies its configured `HAM_HQ_ROOT`.
Otherwise it discovers the nearest ancestor with the installed policy. In both
cases the installed root's origin must match the repository under validation,
and inherited `PYTHONPATH` cannot supply policy. Missing commit objects are
fetched with three bounded attempts, retrying transport failures after 500ms
and 1000ms; permanent failures refuse proof immediately. DNS resolution, connect and
SSH/TLS handshake drops are transport failures; authorization failures are not.
The audit-base resolver reads the runtime `HAM_RUN_DIR/range.json`, with the
rendered dispatch directory as its fallback.
Required checks, the exact-head lease/CAS and primary-change checks still apply.

Conflicting duplicate identity trailers confer no direct hammer provenance,
regardless of order. Identical repeated identity values remain valid, including case variations. A replayed commit
with both `Worker-Class: hammer` and `Worker-Class: codex` therefore requires
independent content coverage rather than first-value or last-value selection.

The closer checks available dispatch ticket evidence before recording or charging
a launch. Only `HAM` or the matching `AMA-PR-<N>` ticket confirms hammer identity; a
`CONFLICT-PR-<N>-REBASE` launch is a separate owner. Its running or completed
status cannot become a hammer attempt or `failed-without-merge` outcome.
Previously misclassified launches with authoritative foreign-ticket evidence
are retired and their matching series/target/lifetime charge is refunded once.
Legacy records without `reviewedSha` use their head (or lease identity head) as
the series key; the refund still requires a matching ledger charge.
A launch receipt with unreadable ticket evidence retains its active lease
and launch IDs for reconciliation; absence of evidence cannot release ownership
or trigger another spawn. It receives a conservative attempt charge, refunded
once if authoritative foreign-ticket evidence appears. Explicit foreign tickets
are refused before charging; ledger ticket evidence takes precedence over CLI
output. JSON and key/value CLI receipts both preserve ticket identity.
An accepted receipt promotes the existing pending lease to `dispatched`, retaining
its acquisition time and launch-request ID so later polls cannot launch a duplicate.
When updating this flow, keep the `hammer-dispatch` source projection in
`state-machines.json` current and run the lease-reconciliation and state-machine
tests; the projection fingerprint does not replace those behavior checks.

Agent-os follow-up: the conflict owner must preserve the original trailer block
on every replayed commit. Do not append a second `Worker-Class` identity or
replace historical `Reviewed-Head` with an unearned claim. Record a separate
rebase receipt binding repository, PR, reviewed SHA, pre/post-rebase SHAs, onto
base SHA, registry version, regenerated paths and patch-equivalence evidence.
The closer should independently verify that receipt; the receipt alone must
never grant review or merge authority. This repository recomputes coverage and
does not require that agent-os follow-up to preserve source-content safety.

After deployment, SRE confirms that the watcher restarted. On the next PR
rebased by a conflict owner after its final review, confirm that the hammer
merges it without a provenance-proof refusal or an operator hand-merge, and
that the conflict owner's completion consumes no hammer attempt.

### Dispatch configuration refusals (UNREGREPO-01)

`repo_unregistered` is a terminal configuration refusal for the current dispatch,
not transient capacity pressure. The closer persists
`dispatch-configuration-refused:repo_unregistered` as its closure blocker and
pages once per repository, across PRs, heads and watcher restarts. An operator
registers the repository using `hq repo register https://github.com/<owner>/<repo>.git`
against the same HQ root as the watcher. Code never registers it automatically.
The existing pending-lease reclaim backoff controls rechecks; a successful
dispatch clears the PR blocker. Configuration refusals release the pending
lease and consume no hammer launch credit. The repository page receipt remains
as a deduplication record; failed delivery retries on later observations.
When dispatch time is absent, the receipt uses the current timestamp so restart
deduplication still applies.
Other dispatch failures retain their existing classifications.

### Merged stacked base (UNREGREPO-01)

Before remediation or closure, the live base is compared with the repository's
live default branch. A non-default base that is the head branch of an
already-merged PR in the same repository records `stacked-base-merged` and posts
one retarget comment per PR. The operator or builder must rebase onto the
default branch and retarget the PR; the pipeline does neither automatically.
The daemon and hammer recheck before merging, including after CI waits.
Both record `deferred` for a stacked-base hold and release the merge lease,
allowing a later attempt on the same head after rebase/retarget recovery.
The hammer classifies the CLI's last non-empty output line so preceding
persistence warnings cannot turn `stacked-base-merged` into a read failure.
Unreadable base/history evidence holds with `stacked-base-read-failed` and
retries without claiming that a parent was merged. Fork branches with the same
name and closed-but-unmerged PRs do not establish a merged parent.
Local hold-store failures preserve the hold and defer comment delivery; initial
persistence failures log a warning for filesystem recovery.

## Final-round closeout recovery (FINALCLOSE-01)

A final-round coexistence read timeout retries dispatch admission on the same
tick using the local round ledger. This route dispatches a hammer and cannot
merge from the watcher: it supplies no merge certificate and leaves head,
checks, mergeability, provenance and operator gates to the hammer under its
lease. Ordinary non-final heads retain the timeout refusal. Background dispatch
retains the per-PR queue and checks the live head before launch.

The exact-head `handed-to-review` transfer authorizes one review even if an
earlier bounded request was consumed or interrupted. An ordinary head-refresh
request can complete that transfer. A delivered review or an attempt after the
transfer consumes the exception; another head cannot inherit it. The hammer
records the transfer before advertising its exact-head route comment.

Worker history collection computes fresh evidence when the daemon history cache
belongs to another OS identity. It never reads or writes that foreign cache.
API/compare failures remain read failures; an incomplete or untrusted ancestry
proof remains a negative proof. Only the latter takes the exact-head review
route. A read failure records `history-read-failed`, releases the merge lease as
a retryable abort, and does not install an input-change stop hold or refund the
charged attempt. Deterministic refusals and other stop holds retain their rules.

Terminal launch evidence takes precedence over stale active worker status.
An open same-head PR without a terminal closing decision retries through the
existing cap: two charged dispatches per series, lifetime six. A final hammer
that exited without closing remains charged. A durable per-PR final-round
wait records the current head and latest blocker and pages after thirty minutes
without launch or head progress. Cap exhaustion shares that receipt across head
changes, so subsequent observations do not page again. Paging does
not grant merge authority or suppress remaining retry budget.
Immediate primary-change alerts use their own receipt and cannot consume this
final-round stall receipt. A successful launch resets the wait before checking
the stall deadline, including when dispatch succeeds on the deadline tick.
HAMCLOSEWAIT-01 also advances an existing final-round wait to a retained
running/starting closer's recorded launch or confirmed dispatched lease progress
(`updatedAt`, falling back to `acquiredAt`). Polling alone does not refresh this timestamp:
a closer with no progress for thirty minutes still pages. A future timestamp
seeds a new row at its first observation, but cannot advance an existing wait
until the timestamp is reached. Only running/starting retained dispatches supply launch progress;
stalled, blocked, unknown and succeeded-awaiting-audit-or-merged-signal holds supply none. Pending/uncertain ownership, held
dispatches, exhausted fallbacks, daemon failures and review handoffs retain their
existing waits; immediate pages remain immediate.

After deploy, SRE owns these checks:

1. Confirm the watcher restarted after deployment.
2. Verify the next final-round PR closes through a hammer, or pages once naming
   its head and blocker, within about thirty minutes under normal load and load
   above eighty. Confirm future-dated progress does not refresh an existing wait
   and retained stalled/blocked/unknown/succeeded-awaiting-signal dispatches preserve its original clock.
3. Over the following day, confirm no operator hand merge was needed because
   final-round closure stalled.

## Deploy drain deferrals (DRAINDEFER-01)

Drain refusal classification requires exit 6 and an anchored diagnostic; incidental
drain text and other exit codes keep their ordinary handling. Epoch metadata
preserves numeric, formatted and alphanumeric tokens. When autonomous execution
is disabled without an available live head, hint retirement uses the reviewed head.

An exit-6 `dispatch refused: drain in effect` refusal persists
`deferred-by-drain` with its epoch and releases the unlaunched pending lease.
The watcher bypasses lane backoff without charging no-progress counters only
while the current-head hint is less than 300 seconds old. Existing lane debt
is preserved. Each closer pass polls `hq dispatch drain-status --no-reap`; only
a confirmed active drain refreshes `updatedAt` and the epoch. Missing, invalid,
future or expired timestamps resume ordinary accounting; the lane retires
expired hints even when closure is never called. Either AMA kill switch also
retires the hint without polling or dispatching.
Once clear, normal dispatch resumes in existing order and within the existing
capacity cap, including background mode. Failed status reads fall back to
normal admission; no new eligibility or fail-closed gate is introduced.
Other exit-6 refusals retain their existing handling.

After deployment, verify deferred closers launch within one watcher pass after
the drain clears, subject to existing capacity. Inspect the durable closer
records for `deferred-by-drain`/`drainEpoch` and confirm watcher logs contain no
slow-lane deferral for a freshly confirmed drain-deferred head. Disable either
AMA switch on a deferred head and confirm ordinary backoff resumes; stop
closer polling and confirm the bypass expires after five minutes. No config change or migration is
required. The offline handoff smoke and drain regression fixtures cover this
scheduling contract without dispatching live workers.

Before ordinary admission resumes, the closer retires the drain scheduling hint
as `no-dispatch`, reason `drain-wait-ended`, so a new eligibility blocker uses
normal lane accounting. Hint cleanup is best effort and cannot refuse admission.
Other exit-6 diagnostics include dispatch preflight timeouts and worker-class
fallback refusals; these keep their existing transient/failure classification.
