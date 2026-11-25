# Production pipeline

## The production pipeline (what runs every day)

REPORENAME-01 preserves review, remediation and merge ownership when GitHub's
stable repository ID appears under a new name. Discovery backfills IDs from
the existing listing; an audited migration fences state owners and recovers
interrupted file/database participants before another review cycle. Existing
review lifecycle states, merge predicates and disposable smoke promises remain
unchanged. See the [rename operator procedure](review-pipeline-health.md#repository-renames-reporename-01)
and [storage audit](data-model/repository-identities.md). SRE records the
post-deploy continuity receipt after the separately approved rename;
HQ attestation identity continuity belongs to REPORENAME-02.

Repository discovery restores durable current names for the configured organization
when startup listing fails, respecting exclusions and persisted identity-conflict
quarantine, plus names with ambiguous ownership in durable history. Static and
discovered names use the same case-insensitive exclusions. Until the first
successful listing, failures including repository-state lock contention retry
after 2, 5, then 10 minutes (capped by the configured refresh interval), or sooner at the budget
deferral's end. These deadlines are checked on the next poll on or after they
fall due; the configured five-minute poll can delay a two-minute retry.
A successful listing replaces fallback scope and restores the
ordinary refresh interval, including after subsequent failures. Every poll with
zero watched repositories warns; at the first poll on or after two minutes,
one SEV2 digest notice per continuous empty episode enters the existing alert
outbox under
`adversarial-repository-discovery`. See the
[discovery contract](data-model/repository-identities.md#startup-discovery-recovery).

For the GitHub-PR domain, the loop is wired through two long-running
daemons on the maintainer's host:

```
┌────────────────────────────────────────────────────────────────┐
│ ai.laceyenterprises.adversarial-watcher                        │
│   - polls GitHub for new agent-built PRs                       │
│   - validates worker-class title prefix                        │
│   - dispatches first-pass reviewer (opposite-agent by default, │
│     or ADVERSARIAL_REVIEW_DEFAULT_REVIEWER when set)           │
│   - posts the structured review to the PR                      │
│   - parses the verdict, writes a durable state record          │
└────────────────────────────────────────────────────────────────┘
                                │
                                ▼ when verdict = "Request changes"
┌────────────────────────────────────────────────────────────────┐
│ ai.laceyenterprises.adversarial-follow-up                      │
│   - 120s tick loop                                             │
│   - claims one remediation job from the JSON queue             │
│   - spawns a remediation worker on the PR branch               │
│   - validates the remediation reply against the kernel         │
│     contract                                                   │
│   - reconciles to "re-review requested" / "stopped" / "blocked"│
│   - retries durable PR comment delivery                        │
└────────────────────────────────────────────────────────────────┘
```

When a remediation pass converges (reviewer flips to `Comment only`,
or the round budget exhausts), the loop moves to closure. The watcher
projects the durable adversarial-review state onto the PR head SHA as a
GitHub commit-status context — `agent-os/adversarial-gate` by default,
overridable per deployment via `ADV_GATE_STATUS_CONTEXT` — which can
be required in branch protection if you want merge to depend on a
passing verdict. Overrides are restricted to log-safe context names
matching `[A-Za-z0-9._/-]+` with a 100-character maximum.

On Agent OS hosts with the Adversarial Merge Authority enabled
(`roles.adversarial.merge_authority.enabled`), closure uses the **MSM
two-path merge model** (operational reference:
[`docs/RUNBOOK-ama-closure.md`](RUNBOOK-ama-closure.md)):

At the round cap, an eligible exact-head Comment-only review with zero
blocking findings and remaining non-blocking or demoted findings first gets
one builder fix-all round. A structurally proven publication with a recorded
fix for every finding transfers to the exact-head closer. Pending CI retains
its observer. The closer validates the original findings, primary-source
preservation and required CI before eligible merge. New findings, live
reviewers and independent review requirements retain their existing authority.
The durable handoff receipt prevents duplicate builder work.
Final fix-all always uses an HQ-provisioned branch-push worker, including
during local failover. Its recorded launch must match the canonical workspace
and the verified produced attestation for the PR's repository, number and
current head. The follow-up service supplies the deploy root for the canonical
verifier. Offline custody fixtures cover crash/retry and wrong-workspace
refusal. Transient attestation read failures retain the in-progress job within
the existing one-hour proof window. Completed legacy receipts without native
proof may fall back to exact-head review at rollout. After normal deployment,
SRE verifies the produced attestation under the follow-up service identity
and observes a natural final fix-all go through completion. The completed
round must record the edge from the reviewed start SHA to the verified
published destination SHA.

In-place repair custody is reconciled before watcher admission, at most once
per 30 seconds. Complete terminal retry evidence can retire an unpublished
reservation. Point-in-time exact-key absence retains custody; two consecutive
canonical absence proofs after ten minutes project operator-required custody
and send a deduplicated SEV1 page. A legacy CWP conflict reservation without a
project can record exact-key repository absence after ten minutes. An absence
proof relies on the producer's `cwp-repository-dispatch-read` grant to check
the native submission lock; AR validates that grant and the exact selector,
without a separate lock attestation. AR checks for unsettled closer submissions
under the closer intent lock. An explicit selector refusal or unproven absence
scope permits a single key-only fallback to establish positive ownership,
never absence. Transport failures retain custody without a key-only fallback.
For these reservations, an unknown
observation after `absent-unfenced` clears the absence count and marks the owner
`unknown`. An unbound reservation with no verified publication and an unknown
owner observed at least ten minutes after reservation retains custody, projects
`repair-owner-unproven` for the operator and sends one SEV1 page per reservation.
The HQ owner can retire a legacy unscoped reservation at its unchanged open
base head using a committed canonical enqueue fence and the original handoff.
For an original CWP conflict reservation on a distinct live head, the HQ owner
can retire it using matching committed owner and epoch fences and the retained
conflict submission evidence, or `--ledger-absence` with fresh canonical
family absence and clear competing custody when the original evidence is unavailable.
Retirement restores the existing ownerless clock and SEV1 path.
After automatic rounds are spent, an operator PR update may atomically replace
an `absent-unfenced` reservation after fresh absence and custody checks.
Monotonic absence-count growth does not invalidate that snapshot.
Unscoped CWP reservations retain custody until fenced retirement; the helper
returns `repair-cwp-enqueue-fence-required`. Replacements beyond the ordinary
two-entry cap observe the existing deduplicated cap page with full history.
The companion owns isolation of the operator-intent environment hint; it is
not authenticated request provenance. See the
[operator update procedure](RUNBOOK-ama-closure.md#operator-pr-update-after-the-automatic-remediation-budget-is-spent).
Reviewer harness refunds are bounded to three per PR across heads; later
failures retain ordinary infrastructure cap and alert handling. Corrupt or busy
repair/refund ledgers defer only their PR. See the
[repair contract](RUNBOOK-ama-closure.md#exhausted-cycles-and-new-builder-heads-exhaustedheadowner-01).

- **Hammer — repair and fallback.** Blocking final findings, conflicts,
  CI-only repair, and findings remaining after the builder fix-all round
  retain the configured hammer/operator behavior. When hammer admission
  applies, the watcher dispatches exactly one
  hammer terminal-remediation worker (`templates/hammer-prompt.md`). The
  default `watcher.ama_hammer_dispatch_mode: inline` contract waits for
  that `hq dispatch` inside the posted-review phase. Operators may set
  `watcher.ama_hammer_dispatch_mode` /
  `AGENT_OS_WATCHER_AMA_HAMMER_DISPATCH_MODE` to `background` to submit
  the same closer call to a bounded process-local PR@head queue and
  return retained ownership (`ama-pending`,
  `ama-closer-dispatch-backgrounded`) immediately; the closer lease and
  dispatch record still prevent duplicate launches on later ticks. A queued
  entry checks the live PR state and head again before it launches. The
  hammer remediates the findings, rebases when GitHub reports a conflict or strict BEHIND, holds
  the merge bar of required checks plus changed-surface tests, waits out
  GitHub required checks on the exact post-remediation head within a
  bounded remote-CI window, and merges under its own lease with
  `--match-head-commit`. UNKNOWN validation retains exact source and cleanup
  evidence and holds a same-head successor for operator decision. Proved
  standalone CI continuation archives the hold as continued; required checks
  still govern merge. Teardown checks every target marker for the ending launch
  and keeps an unbundled workspace across published-head changes. Changed
  source/cleanup facts refresh the operator notice. Existing smoke commands
  remain unchanged; organic recovery evidence follows normal deployment.
  Watcher tenure review routing requires effective
  `worker_pool.tenure.enabled: true` (default false); disabled routing performs
  no tenure reads. When enabled and the PR's stable build launch exposes `tenureId`,
  a changed head instead requires independent exact-head review before merge.
  HAM validation and terminal-remediation certificates cannot waive that review.
  Remediation and closer dispatch retain the PR alias and their existing classes;
  the closer keeps its merge-authority principal. The review prompt names the
  remediation range, and routing excludes the originating author and identified
  same-tenure producer harness families while retaining live-writer custody and
  existing attempt/cycle caps. An available launch without `tenureId` keeps the
  existing path. Missing stage IDs and successful unindexed-stage reads retain
  opener-based review routing. Unavailable tenure reads skip tenure queueing and
  warn per PR/head using a process-local 4096-entry LRU cache (evicted keys may
  warn again) while ordinary review and closure continue;
  unknown tenure cannot certify a closer exemption. Already armed
  same-head range requests preserve pending/CI admission without writer locks.
  Optional range-prompt read failures leave reviewer startup available.
  Existing smoke commands are unchanged; offline fixtures establish
  source behavior, while natural deployed review/merge evidence remains separate.
- **Daemon inline merge — clean completion.** When the final review is
  fully clean (zero blocking AND zero non-blocking findings, both
  classifications known), GitHub reports required checks green and the
  PR mergeable, and the live head still matches the reviewed head, the
  watcher daemon clicks merge inline through a bounded subprocess under
  the shared merge lease (`src/ama/daemon-merge.mjs`) — no agent is
  spawned. `strict_mode` defaults on; turning it off permits daemon
  merge over *known non-blocking* findings only.
  A zero-finding exact-head review can supersede an unbooted closer after a
  durable dispatch marker, a fresh boot-state check and confirmed cancellation.
  Marker persistence failure prevents cancellation. The intent survives a
  failed terminal-status write or deferred merge, preventing a hammer retry
  once terminal launch evidence is complete; live or unreadable owners remain
  protected. A matching deferred terminal lease retains custody when a parked
  closer resumes through `requested` or `admitted`. Lifecycle states and
  existing smoke commands are unchanged.

CLOSURESPLIT-01: closure and background hammer admission share a decision key,
generation and complete evidence snapshot, including head-scoped primary change.
Fresh disagreement returns `closure-decision-mismatch`; closure selects a
successor from that snapshot once. Inherited primary-change failures are
recomputed before routing and real reversals still refuse. Changed decisions
precede repair-admission refusal while retaining structural safety holds;
non-dispatch successors expose the refreshed action and preserve progress.
Existing merge gates,
leases, lifecycle states and smoke promises remain unchanged. See the
[decision contract](RUNBOOK-ama-closure.md#shared-closurehammer-decision-closuresplit-01).
Offline source acceptance is separate from read-only observation of natural
recovery after normal deployment; no live verification action is added.

CLOSURERECOVERYEXEC-01: an R04 `closure-recovery` next action now has an
executor. Inline and background admission both hand it to the closer's custody
reconciliation, which dispatches when ownership resolves. Unresolved ownership
pages once at the decision deadline (`closure-recovery-ownership-unresolved`)
instead of looping on `closure-decision-mismatch`. Expired next-action deadlines
appear in the watcher log and in `pipeline-health` `expiredNextActions` with
their age. See the
[executor contract](RUNBOOK-ama-closure.md#closure-recovery-executor-closurerecoveryexec-01).

TERMLEASE-01: terminal non-merge closer leases (`superseded`,
`failed-without-merge`, `deferred`) release on the same dispatch pass once ledger
or matching dispatch evidence proves the launch ended or is absent. Live or
unproven launch/retry evidence retains the hold; `succeeded` stays sticky.
Superseded dispatches release their matching rekeyed lease and keep supersession
on the dispatch record. Retained terminal blockers name the launch after inline
or background settlement. The synthetic handoff smoke exercises same-pass
terminal reclamation; deployment verification is in the closure runbook.

A PR body may declare a merge-order hold with a bare full-line trailer.
Syntax example (remove ` (syntax)` from the key to arm a real hold):
`Protects-Against-Unsafe-Merge-Until-PR (syntax): #1234`.

Every autonomous merge path that can land a PR must honor that declaration
before calling GitHub merge. The watcher evaluates it before choosing between
daemon inline merge and hammer dispatch, and the hammer prompt re-checks it
immediately before its lease-guarded `gh pr merge` call for already-running
workers. The parser is intentionally line-oriented: any exact full-line trailer
arms the hold, including inside fenced code blocks. Documentation examples must
break the trailer name, for example
`Protects-Against-Unsafe-Merge-Until-PR (example): #1234`, when they should not
arm a real hold.

There is no standing merge-agent in this model — no agent whose only job
is to click merge — and both paths share one eligibility predicate
(`src/ama/merge-eligibility.mjs`) that fails closed on empty required
checks, non-mergeable state, and stale heads. The hard kill switch is
`roles.adversarial.merge_authority.autonomous_merge_execution_enabled:
false` followed by a watcher bounce: with it off, neither path executes;
the watcher writes a fail-closed audit and leaves the PR for manual
operator intervention. To roll back only background hammer dispatch, return
`watcher.ama_hammer_dispatch_mode` to `inline` or unset the environment
override; unknown or unreadable values fail safe to inline.

For a repository-specific merge hold, the config-only
`roles.adversarial.merge_authority.disabled_repositories` list defaults to `[]`
and accepts unique `owner/name` strings compared lowercased. A listed repository
receives `merge-disabled-for-repository`: closure dispatch and autonomous merge
execution stop while reviews and remediation rounds continue. Operators merge
these PRs manually. Watcher coexistence retains the R02 hold as `await-operator`;
the finalization executor refuses merge before lane routing for all surfaces,
including injected adjudicate and local fallback surfaces. Both the watcher and
parent worker reader must recognize the key; verify
`getMergeAuthorityConfig().disabledRepositories` before relying on it. See
[Merge off for one repository](RUNBOOK-ama-closure.md#merge-off-for-one-repository).

RDR-02 adds the ledger-independent stop used by `rdr stop --reason` and
`hq halt --confirm --reason`. Both merge consumers read
`<HQ_ROOT>/control/halt/active.json` and `merge-kill.json` through
`src/fleet-stop.mjs`: the daemon checks before closure and before each merge
subprocess, and `bin/ama-check.mjs` refuses the hammer's final eligibility
check. Presence (even malformed content or a dangling link) and unreadable
state refuse merge. Refusal reasons identify the latch as `fleet-stop-active`
or `fleet-stop-merge-kill` (active takes precedence when both exist); read errors
return `fleet-stop-unreadable`, log the failing path class and error code, and
page through the existing alert sink once per distinct cause per process
lifetime. Recovery logs only for the state root that recovered, without paging;
deliberate halt markers never page from this evaluator. Consumers treat the
`fleet-stop-` prefix as an
intentional deferral. Reads are uncached; matching `rdr resume --epoch N`
restores the file latches and eligibility without a configuration reload.
A stop at the merge boundary releases the lease and defers, without a permanent
failure or manual-close page. Closure admission checks the same fence before
dependency reads and excludes intentional stops from wait-exhaustion paging.
An already-issued GitHub request cannot be recalled.

Deploy both RDR-02 repositories before activation. The build manager must
confirm the registered watcher process has adopted this reader and drain any
older hammer processes; check owners, launchd domains and restart paths in
Agent OS `scripts/os-restart.sh`. The `refusals` smoke scenario uses disposable
file state. On a disposable installation, stop with the ledger unavailable,
verify daemon and hammer refuse within one tick, reject the wrong epoch, then
resume the matching epoch and verify eligibility returns. Restore the ledger
and reconcile through HQ twice, observing one arm/disarm audit pair. No SPEC
section 7 account or hardware step blocks this slice. Gate changes require the
normal cross-model convergence loop; do not admin-merge this change.

Ended unpublished or failed remediation rounds re-enter the existing follow-up
queue while their ordinary round budget remains. Broker-backed remediation waits
for the publisher broker's bounded `/readyz` probe before preparation and dispatch;
`credential-broker-unready` keeps the pending job and round with backoff, retaining
attempt history through preparation until spawn admission. A proven
credential-only publication outage, including a native job-bound publisher sidecar,
returns the round to pending without a charge after thirty seconds,
records the saved commit as `infrastructure-failed`, and resumes preserved local
work after readiness recovers. The reply must include a credential-outage
operational blocker and no other blocker; generic supervisor `task_failed` and
`worker_error` reasons alone do not disqualify that proven outage. See the
[accounting contract](data-model/follow-up-jobs.md#credential-broker-deferral-and-publication-refund).
Watcher recovery requeues locally without network publication or worker
credentials, preserving retained work, spent rounds and backoff without
operator override. Explicit worker-authenticated recovery can first verify
and publish a checkout owned by the current uid. A terminal execution attempt at its round
ceiling hands findings to the hammer even without a published head; watcher,
wake and read-only rescue use the same budget evidence. Live owners and
operator-owned or safety stops retain precedence. Initial missing-job creation
stays with the reviewer/reaper so single-review and PR-wide budget evidence
is included. Scoped disposable fixtures verify these
transitions; deployed acceptance requires the SRE observation declared in the
post-merge plan. Existing smoke commands are unchanged.

Two autonomous-close lanes keep a fail-closed daemon attempt from parking
for manual merge, without ever loosening a safety gate:

- **Daemon-fail-closed hammer fallback (attributed PRs).** When the
  daemon clean-path fails closed on a *remediable* gate — CI not green,
  a conflict (`pr-not-mergeable`), or a moved head (`stale-head`) — on an
  identity-resolved fleet-worker PR, the watcher hands it to the SAME
  capped hammer instead of parking. The hammer re-validates the required
  gate at the post-remediation head and merges under its own lease.
  *Non-*remediable gates still fail closed (no blind merge-clicker):
  `verdict-not-eligible`, `lease-not-held`.
- **Daemon accountability hand-off (FAILCLOSEDHAMMER-01).** When the
  daemon fails closed on its own accountability gate
  (`worker-identity-unresolved`, not a transient identity read) on a
  clean, exact-head, green, MERGEABLE PR, the shared next action selects
  the hammer (`daemon-failed-closed`). The hammer merges under its own
  merge lease and terminal audit, never with `--admin`, and every other
  predicate (exact head, required checks, findings, strict-mode
  non-blocking rules) still applies. On any other head the identity
  refusal stays a refusal; it never licenses CI, conflict or findings
  repair. If the hammer refuses the hand-off (its own merge eligibility,
  or a fresh decision handing the head back to the daemon), the PR gets
  the terminal named reason `daemon-failed-closed-hammer-refused` and
  one operator page per head instead of a daemon/hammer loop.
  Every hammer dispatch, this fallback included, is bounded by the per-PR
  hammer-retry-cap (per-head 2, lifetime 6) and fails loud with a GBI
  operator alert at the ceiling.
- **Operator-approval lane (un-attributed PRs).** An operator/agent
  infra-fix PR that no hq worker opened has no launch-provenance, so the
  daemon's worker-identity gate fails closed by design. An explicit,
  *head-scoped* `operator-approved` (or `merge-agent-requested`) label IS
  the accountability that substitutes for the missing worker identity:
  the daemon then merges the clean PR under an operator-accountable lease.
  It substitutes for identity ONLY — the settled-success verdict,
  strict-clean review, green-checks, mergeable, and head-match gates all
  still apply, a red gate never merges, and a stale-head approval is
  refused. The accountability (label, actor, event id) is written to the
  merge audit.

Accountability is never absent from an autonomous merge: it comes from a
resolved worker identity, a capped hammer under its own lease and terminal
audit, or an explicit operator approval at the exact head.

The older `merge-agent` worker class survives as the operator fallback
lane: a fresh current-head `merge-agent-requested` label dispatches it
with the AMA admit-gate bypass
(`AMA_OPERATOR_MERGE_AGENT_OVERRIDE=true`), and it also serves hosts
that have not enabled AMA. That lane's merge path is watcher-owned,
not an inline branch inside `src/follow-up-jobs.mjs`: launches are audited
under `data/follow-up-jobs/merge-agent-dispatches/`, duplicate same-head
launches are suppressed by that ledger plus the live
`merge-agent-dispatched` lifecycle state, and a review body whose
structured `## Blocking issues` section still contains a real finding is
refused with `skip-blockers-present` (the ARP-06 / #157 safety gate)
regardless of labels. See the operator label reference in
[`docs/RUNBOOK-ama-closure.md`](RUNBOOK-ama-closure.md) §5.

Operator surface, when something needs intervention:

```bash
npm run retrigger-review        # re-run first-pass review for a PR
npm run retrigger-remediation   # re-queue remediation for a PR
npm run reset-pr                # clear durable state for a PR
npm run follow-up:stop          # stop an in-flight remediation
npm run follow-up:reconcile     # reconcile drifted queue state
```

Full operator runbook: [`docs/follow-up-runbook.md`](follow-up-runbook.md).
Living contract: [`docs/SPEC-adversarial-review-auto-remediation.md`](SPEC-adversarial-review-auto-remediation.md).

## V2 finalization queue

These contracts cover repository/base ownership, closer handoff, admission,
rebase, candidate checks, guarded merge and shadow observation. See the
[queue store contract](data-model/finalization-ledger.md) and
[operator observation procedures](finalization-executor-promotion-runbook.md).

### V2 repository/base queue foundation (MGQ-01)

The finalization port now has durable lane storage and a fenced single-host
owner seam in `src/finalization/`. The watcher uses it for transferred queue lanes.
Acknowledged readiness is atomic, parked entries rejoin the tail explicitly,
and replay preserves candidate, phase and original infrastructure deadline.
Owner states are `idle`, `active`, `parked`. A per-lane issuance lock spans
intent, remote operation and drain; an expired lease cannot authorize takeover
while a request is ambiguous. Missing stop/drain and authoritative reconciliation
proof parks the lane. A watcher tick that ends with an unresolved operation
parks its active fence immediately and retains the prior owner and intent for
reconciliation. Subject leases continue to protect only individual subjects.

Focused offline fixtures in `test/finalization-queue-owner.test.mjs` exercise
simultaneous claims, stale generations/routes, paused issuance, ambiguous push
and merge intents, phase replay, FIFO/readmission, publication restart cases,
bounded waits and a probe that performs no store mutation. These are focused
fixtures; the existing smoke promises gain no new live action or CI check.

After normal deployment, the operator runs
`node src/finalization/queue-probe.mjs --capability owner --json` under the
runtime account in the deployed checkout. It checks actual schema/adapter
availability and reports the probe's runtime module digest and existing claims.
Empty lanes mean organic execution evidence is pending. No route/config flag,
service bounce or synthetic traffic is part of this slice. See the
[owner observation and recovery procedure](finalization-executor-promotion-runbook.md#queue-owner-storage-observation-mgq-01-no-activation)
and [store contract](data-model/finalization-ledger.md#repositorybase-queue-mgq-01).

### V2 durable closer handoff (MGQ-02)

`createQueueHandoffService` validates complete terminal finding coverage and
persists pushed head, source review id/commit, signed evidence, worker/closer
identities, primary-change/local-validation provenance and fixed/withdrawn
dispositions with the queue entry and ack in one transaction. Real non-blocking
findings require dispositions too. Fixes need concrete evidence; withdrawals
also need source explanations and locations. Original signatures and finding
identities survive candidate derivations without rebinding or another model
judgement.

`createCloserQueueHandoffBoundary` confirms durable acknowledgement before
resource release and suppresses duplicate closer dispatch at the admission.
State is absent until the transaction commits; duplicates, lost replies and
restart return the same immutable `acknowledged` receipt. Write failure rolls
back entry/event/readiness. The installed receiver uses authenticated review and
publication reads and verifies the dispatched launch and generation. The legacy
retry helper continues to serve lanes under legacy ownership.

`test/finalization-queue-handoff.test.mjs` covers coverage/provenance refusals,
independent duplicate submitters, crash after commit, lost ack, release ordering,
signature/disposition preservation, bounded waits and a read-only probe. Existing
smoke promises are unchanged; there is no new live action or CI check.

After source deployment and both additive queue migrations, the operator runs
`node src/finalization/queue-probe.mjs --capability handoff --json` from the
deployed checkout under its runtime account, using the bounded load-aware
supervisor in the [observation procedure](finalization-executor-promotion-runbook.md#durable-handoff-observation-mgq-02-no-activation).
Require `.capabilities.handoff.available == true` and `.runtime.build != null`.
The probe resolves the durable adapter against real schema and reports ack
counts. Zero means organic evidence is pending. Availability does not assert
live evidence-reader composition, lane routing or a running watcher's build.
See the [handoff contract](data-model/finalization-ledger.md#durable-closer-handoff-mgq-02).

### V2 FIFO admission (MGQ-03)

`createCleanReviewService` admits signed, complete zero-finding exact-head reviews
through the same transactional readiness counter as terminal closer handoffs.
`createQueueAdmissionService` reads live subject/head/base, complete labels,
identity, write rights and shared structural policy. Clean work retains its final
current-head review read; complete terminal adjudication needs no re-review.
Live/unknown holds park outside actionable FIFO. Closed/merged observations
reconcile without dispatch. External author changes return for fresh adjudication.
Parked recovery and repairs join the tail with fresh evidence, retaining history;
duplicate wakes and restarts preserve position and the original absolute deadline.
Snapshot comparison prevents late recovery reads from overwriting a newer hold.
Terminal structural returns record the matching reversion/conflict reason even
when infrastructure also fails. Progress events retain the phase before mutation;
legacy events remain replayable. Live SHA casing and numeric/string review IDs
do not change identity, and complete labels are passed as names to shared policy.

The lifecycle is acknowledged → ready, or parked-hold/permission/infrastructure,
returned-to-closer, or closed-observed. The watcher admits only lanes with matching configuration and durable queue
ownership. Readiness alone grants no merge authority. Focused offline
`finalization-queue-admission.test.mjs` exercises mixed-source process contention,
read/recovery races, holds, current-head reads, bounded waits and probe immutability.
Regressions also cover mixed infrastructure/conflict diagnostics, equivalent head
and review identities, label objects and durable prior-phase audit/replay.
Existing smoke promises gain no new live action, CI check or promotion gate.

After normal source deployment and all three queue migrations, the operator runs
`node src/finalization/queue-probe.mjs --capability admission --json` from the
deployed checkout under its runtime account with the existing bounded load-aware
supervisor. Require `.capabilities.admission.available == true` and
`.runtime.build != null`; record actual source/disposition/observation counts.
Empty organic evidence and live-reader/routing composition remain pending.
See the [store contract](data-model/finalization-ledger.md#fifo-admission-and-clean-reviews-mgq-03)
and [operator observation procedure](finalization-executor-promotion-runbook.md#fifo-admission-observation-mgq-03-no-activation).

### V2 mechanical rebase (MGQ-04)

`createQueueRebaseService` prepares conservative rebases in isolated repositories,
proves every ordered change including binary data, whitespace, paths, modes,
symlinks and gitlinks, and persists the candidate/base/source before the fenced
expected-old-head push. Empty commits, unsupported histories and unprovable
preservation return to the closer. Full-index patches must match byte for byte:
even conflict-free edits to a file changed upstream fail proof. Disjoint-file
rebases are the supported case. Generated files receive no exception.
Original signed evidence stays at its source head; author warning and permission
notice intents remain durable for the delivery composition.

The execution lifecycle is ready → rebasing → publishing → waiting-checks,
with permission/hold/infrastructure parking outside FIFO and terminal returns
for author changes or failed proof. Restart verifies the persisted candidate and
reconciles outstanding operations before retry. A published candidate resumes
checks without repushing. A no-op keeps the SHA with explicit proof. Outside base
movement keeps the original absolute deadline and records the derivation chain.
Admission re-proves a queue-published candidate against its immutable receipt
before readmission; retained candidates resume via rebasing → publishing. Explicit
Git push success settles the intent despite API lag, with a Git-sourced publication
reference. Explicit single-ref remote refusals settle as not-applied; unknown
transport outcomes still require drain recovery. Failed preparation removes its
unreturned workspace. Successful workspaces remain for restart proof and require
operator retention cleanup; no automatic retention sweep is wired. Rewritten
commits default to `Queue Rebase <queue@example.invalid>` as committer, with the
original author and message preserved. Full prior proofs and live snapshots are
still duplicated in progress events; compact evidence storage remains follow-up
work before production routing.

Recovery verifies every contiguous derivation from the admission head, including
prior workspaces, before accepting either the current candidate or its proven
expected old head. This includes a park after a second candidate was prepared
but before publication. A computed proof mismatch returns to the closer;
unavailable Git execution parks as infrastructure, and expired patience parks
before proof execution. Both already-published paths recheck live holds and
permissions before advancing to checks. Deterministic workspace, remote, runner
or deadline refusals before transport invocation settle `not-applied` with
`git:push-not-spawned`; failures after invocation still require authoritative
results or drain reconciliation. Ambient author/committer environment variables
and `EMAIL` are removed from local Git execution so replay retains the source
author and uses the synthetic committer.

The production consumer uses the existing entitled GitHub credential for
network Git. The runner refuses ambient SSH credentials. The existing execution brake applies before preparation and push.
No new CI or smoke step is added.

Focused offline fixtures are `finalization-queue-rebase-proof.test.mjs`,
`finalization-queue-rebase.test.mjs` and `finalization-queue-git.test.mjs`.
After normal deployment, the runtime owner runs
`node src/finalization/queue-probe.mjs --capability rebase --json` under the
existing bounded load-aware supervisor. Require
`.capabilities.rebase.available == true` and `.runtime.build != null` and record
the Git/proof adapter and actual publication observations. Missing organic
publications and unverified loaded routing remain pending. The probe
checks the real schema and Git executable and never creates a workspace or
mutates a lane. See the [operator procedure](finalization-executor-promotion-runbook.md#mechanical-rebase-observation-mgq-04-no-activation)
and [data contract](data-model/finalization-ledger.md#mechanical-rebase-and-publication-mgq-04).

### V2 candidate checks and parking (MGQ-05)

The v2 finalization waiter resolves and versions the complete existing
required set, enumerates all exact-candidate check-run and legacy-status pages,
and uses the shared CI classifier. Latest reruns win, with numeric REST IDs or
GraphQL database IDs breaking timestamp ties. REST runs use start/completion
timestamps; undated queued runs remain pending evidence. Missing, pending,
stale, partial, unreadable and inconclusive
evidence never authorizes finalization. Existing explicit no-CI policy still
requires a fresh candidate proof. Original local validation stays at its source
SHA in the immutable receipt.

The lifecycle is waiting-checks → finalizing for green, returned-to-closer for
completed red, or parked-infrastructure on expiry. The entry retains its original
30-minute nominal infrastructure patience, scaled once with a 60-minute hard
ceiling across polls, restart and base churn. Infrastructure parking releases the
lane and journals one stable cause page through existing Sentinel delivery;
outages never dispatch or charge remediation. Bounded recovery revalidates the
candidate/base, derivation, holds and existing admission policy before tail
readmission. An expired entry gets no new CI wait. Readmission grants no merge
rights; final eligibility remains the executor's responsibility.

No production route, new config, CI check or smoke step is installed. Source
fixtures are `finalization-queue-checks.test.mjs`,
`finalization-queue-check-transport.test.mjs`, `finalization-queue-check-race.test.mjs`,
`checks-summary.test.mjs`,
`hammer-token.test.mjs` and `alert-delivery.test.mjs`. The runtime owner separately
runs `node src/finalization/queue-probe.mjs --capability checks --json` from the
deployed checkout with a bounded load-aware supervisor. See the
[store contract](data-model/finalization-ledger.md#candidate-checks-and-infrastructure-parking-mgq-05)
and [deployment observation procedure](finalization-executor-promotion-runbook.md#checks-and-parking-observation-mgq-05-no-activation).

### V2 final eligibility, guarded merge and receipts (MGQ-06)

The v2 merge step consumes a `finalizing` exact candidate. Immediately
before mutation it rereads the existing emergency brake, subject ledger,
immutable receipt and disposition digest, live head/base/holds, identity, branch
rights, primary change, existing structural eligibility, the recomputed rebase
proof and a complete exact-candidate check snapshot. The live owner fence and
route generation replace only the legacy merge-lease execution input. Head
changes return to the closer; holds and the brake park; an outside base write
clears stale readiness and rebases/retests under the original deadline.

The final decision and owner-journaled intent precede the existing squash
expected-head surface. A reply is never success: only live merged state at the
candidate with a structured merge SHA and the attributed bot as merger records a
receipt. Mismatched, unstructured or foreign already-merged replies are not
success, and an invisible ambiguous merge waits for drained owner takeover. The
receipt (old/new head, base, rebase provenance, check snapshot, decision, merge
SHA, bot/closer attribution) commits with the merged phase, a subject-ledger
`merge_observed` landing event and stable-key outbox rows for the existing merge-action
accounting and AMA closure audit. Delivery retries never repeat the merge or an
action, and pending delivery stays visible after the lane advances. The subject
retains a post-merge delivery owner until a matching PMA run supplies verified
activation evidence; landing alone never writes `finalized`. Custody changes
invalidate authorization and select owned reconciliation from the shared fold.
Outbox database operations retain the store's configured busy timeout so a
transient writer can finish after lane release. The merge probe's recent receipt
`recordedAt` is the authoritative merge time (`merge.mergedAt`). Clean reviews
have no closer; remediated receipts retain the admitted closer attribution.

No production route, new config, CI check or smoke step is installed. Source
fixtures are `finalization-queue-merge.test.mjs` and
`finalization-execution-surfaces.test.mjs`. The runtime owner separately runs
`node src/finalization/queue-probe.mjs --capability merge --json` from the
deployed checkout with a bounded load-aware supervisor. See the
[store contract](data-model/finalization-ledger.md#final-eligibility-merge-receipts-and-delivery-outbox-mgq-06)
and [deployment observation procedure](finalization-executor-promotion-runbook.md#merge-and-receipt-delivery-observation-mgq-06-no-activation).

### V2 queue shadow decisions and throughput (MGQ-07)

The finalization port exposes a read-only queue observation consumer alongside
the existing shadow recorder/store/report. Paired observations carry v1 action
provenance, lane readiness/order, rebase/check/final proposals and evidence.
Only telemetry is written; no owner claim, push, merge, remediation dispatch or
closer budget is available to this consumer. Live composition belongs to the
routing slice. Unknown store/fold/read results stay open for operator escalation;
queue differences can be attributed to either v1 or queue defects with recorded
disposition evidence.

`finalization shadow-report --days 7 --json` now includes separate organic and
synthetic per-lane metrics: sample/window denominators, total/mean completed
service time, oldest ready age, arrivals/merges/returns per hour, check waits and
infrastructure/hold parking. Durable lifecycle replay preserves denominators
and readiness age over duplicate ticks and restart. Synthetic replay cannot
establish organic coverage. The text report rounds hourly rates to two decimal
places; the JSON model retains numeric precision. Existing promotion criteria
and smoke promises remain; this adds no CI check or automated gate. Focused
offline fixtures are `test/finalization-queue-shadow.test.mjs` and the existing
shadow tests.

After deployment, the runtime owner runs
`node src/finalization/queue-probe.mjs --capability shadow --json` under the
existing bounded load-aware supervisor. It reports real schema/adapter
availability, the probe build, latest organic consumer/time and observation-only
mode. A null `shadow.lastObservationAt` with `shadow.organicEvidence == "pending"`
is valid pending evidence; an organic observation requires a timestamp. See the
[shadow deployment observation procedure](finalization-executor-promotion-runbook.md#queue-shadow-observation-mgq-07-no-activation),
[triage guide](finalization-shadow-divergence-triage.md#queue-decision-evidence-mgq-07)
and [store contract](data-model/finalization-shadow.md#queue-observations-mgq-07).

The existing next-action observer also feeds legacy-lane snapshots/results into
the same ledger and shadow report. `hq merge-lane shadow report [--json]`
forwards the service read model; `promotionGate` adds MLR-04's 50 distinct
organic terminal-subject requirement, terminal head-move/exhaustion examples and
full-history triage/error arithmetic. Both MGQ and MLR readiness are required.
See the [deployment handoff](https://github.com/laceyenterprises/agent-os/blob/main/modules/worker-pool/post-merge-actions/mlr-07-shadow.yaml): after both
repository PRs merge and normal deployment, Main Loop 6/SRE reloads the watcher
through its registered service path and proves row growth across natural
traffic in every active lane. Historical nonzero rows alone are insufficient.
Shadow has no execution port; frozen v1 policy and existing smoke commands
remain unchanged. Focused synthetic fixtures exercise the live ingestion seam.

---

## Operating in the maintainer's deployment

To rename the GitHub status context that gets required in branch
protection (for instance, when you don't want `agent-os/adversarial-gate`
appearing in your org's governance language), set the
`ADV_GATE_STATUS_CONTEXT` environment variable on the watcher and on
`npm run check-branch-protection`; non-empty values win over the
default, whitespace is trimmed, and values must match
`[A-Za-z0-9._/-]+` with a 100-character maximum so logfmt-style
diagnostics remain unambiguous.
Treat a rename as an explicit migration: update branch protection and
every watcher/probe deployment to the same override before relying on
the new context.

If you're running this against the maintainer's hosted environment (or
reproducing it), the operator docs are:

- [`docs/follow-up-runbook.md`](follow-up-runbook.md) — the day-to-day operator runbook
- [`docs/RUNBOOK-reviewer-workspace.md`](RUNBOOK-reviewer-workspace.md) — reviewer snapshot and audit state
- [`docs/SPEC-adversarial-review-auto-remediation.md`](SPEC-adversarial-review-auto-remediation.md) — the living contract
- [`docs/STATE-MACHINE.md`](STATE-MACHINE.md) — the two durable state machines
- [`docs/MACOS-TCC.md`](MACOS-TCC.md) — TCC popup handling on macOS hosts
- [`tools/adversarial-review/DEPLOYMENT-FROM-FRESH-MAC.md`](../tools/adversarial-review/DEPLOYMENT-FROM-FRESH-MAC.md) — five-step path to a running watcher on a clean macOS host
- [`DEPLOYMENT.md`](../DEPLOYMENT.md) — audit of maintainer-local paths still in source
- [`tools/adversarial-review/DEPS.md`](../tools/adversarial-review/DEPS.md) — full dependency contract

### Watcher dispatch health

`src/health-probe.mjs` emits `watcher.no_progress` after three consecutive
polls with waiting first-pass PRs and no reviewer process start. Set
`ADVERSARIAL_WATCHER_SILENT_POLL_THRESHOLD` to a positive integer to change
the threshold, or `ADVERSARIAL_WATCHER_HEALTH_PROBE=0` to disable the probe.
Re-reviews are excluded from the waiting sample. A live reviewer removes only
its own PR from that sample, including processes inherited after a watcher
restart; other waiting PRs still accumulate the no-progress streak. Quiet
polls break the waiting streak.

The first transition into no progress queues a digest notice through the
durable alert sink; subsequent stalled polls emit telemetry without another
notice. A new process start resets the streak and emits `watcher.recovered`
if an incident was active, even when single-wave dispatch already finalized
that poll. Recovery is telemetry only. Stage, fallback and repeated PGID
callbacks count once per PR in a poll. `recoveredFromSilentPolls` counts all
polls without a new start since the last start, including quiet polls; it is
separate from the consecutive waiting streak.

This probe measures dispatch liveness. A process that starts and then fails
still counts as progress, and quiet retry-backoff polls do not trigger it.
Crashloops and processes that never post a review remain covered by the
review-freshness pager, with credential-outage gating for classified auth
failures. Inspect reviewer failure evidence when dispatch health is healthy
but freshness is stalled.

Inherited-process reconciliation reads persisted spawn records synchronously
only when the poll observed waiting PRs. Invalid record entries are ignored.
The scan remains proportional to the number of records; capacity admission
keeps its own fresh reads rather than sharing a potentially stale health
snapshot across starts and settlements within a poll.

### Secret-source contract

If your wrapper exits at startup with
`[secret-source] FATAL: could not resolve OP_SERVICE_ACCOUNT_TOKEN`, the
canonical resolution order is, in declared precedence (first match wins):

1. `OP_SERVICE_ACCOUNT_TOKEN` already in the process environment.
2. `ADV_OP_TOKEN_FILE` — path to a file containing the trimmed token.
3. `ADV_OP_TOKEN_ENV_FILE` — path to a shell-style env file with
   `OP_SERVICE_ACCOUNT_TOKEN=...` or `export OP_SERVICE_ACCOUNT_TOKEN=...`.
4. Legacy compatibility file:
   `$AGENT_OS_ROOT/agents/clio/credentials/local/op-service-account.env`
   or `$HOME/agent-os/agents/clio/credentials/local/op-service-account.env`.
5. `$ADV_SECRETS_ROOT/op-service-account.token`.
6. `$HOME/.config/adversarial-review/secrets/op-service-account.token`.

The full table — including what each source means, how the fail-once
diagnostic is shaped, and why the wrappers sleep before exit — is in
[`tools/adversarial-review/DEPS.md`](../tools/adversarial-review/DEPS.md)
under "OP_SERVICE_ACCOUNT_TOKEN resolution."

If you're not running the live deployment, you can ignore all of the
above and stick to the five-minute path at the top of this file.

---
