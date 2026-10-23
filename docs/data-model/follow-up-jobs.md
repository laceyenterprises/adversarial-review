# Data Model - Follow-Up Remediation Jobs

After durable completion, the queue best-effort projects the round's reply and
local commit evidence into [review finding records](review-findings.md).
Failures preserve job completion and leave the stored job available for offline
replay; no queue state, retry budget or merge decision changes.

**Owner:** follow-up remediation queue
**Store:** `data/follow-up-jobs/{pending,in-progress,completed,failed,stopped}/*.json`, `data/follow-up-jobs/single-review-voids/*.json`, `data/follow-up-jobs/missing-label-events/*.json`
**Source of truth:** `src/follow-up-jobs.mjs`, `src/follow-up-branch.mjs`, `src/remediation-unpublished.mjs`, `src/review-mode-selection.mjs`, `src/follow-up-remediation.mjs`, `src/follow-up-retrigger-review-label.mjs`, `src/remediation-quota-hold.mjs`, `src/remediation-claimed-requeue.mjs`, `src/remediation-worker-class-fallback.mjs`, `src/remediation-round-accounting.mjs`, `src/remediation-infrastructure-refund.mjs`, `src/github-auth-recovery.mjs`, `src/remediation-published-head.mjs`
**Runtime surface:** `src/comment-only-final-round.mjs`, `src/comment-only-final-round-completion.mjs`, `src/ama-closure-orchestration.mjs`, `src/adapters/comms/github-pr-comments/comment-delivery.mjs`

## Branch and publication contract (REMEDBRANCH-01)

Every reviewer runtime carries the subject's PR head `branch` and title-prefix
`builderTag` in its run context. Watcher pass metadata retains both fields so
recovered agent-runtime posts enqueue the same contract as cli-direct posts.
For jobs requiring remediation, `createFollowUpJob` resolves an omitted/blank
branch through one bounded REST PR read (8 seconds). Duplicate review claims
return before that read. Resolution can also recover the builder tag from the
title when absent.

If resolution fails or returns no head ref, the job stays in `pending` with
`branch: null` and `branchResolution: { state: "blocked", reason:
"branch-unresolved", attempts: <integer>, retryAfter: <ISO timestamp> }`. This is a
hold, not a ready worker job. The claim loop retries after 60 seconds under the
atomic queue claim, returning unresolved jobs to pending until three failed
lookups (including creation) stop the job with `branch-unresolved`. No worker
spawns or remediation round is charged. Legacy holds without `attempts` count
as one prior failure. Explicit operator requeue resets attempts to zero and
makes the next lookup immediately eligible. Successful resolution stores the
branch and clears `branchResolution`.
Legacy branchless jobs must resolve the branch before either local or HQ spawn.
Settled clean reviews bypass branch resolution at creation and claim. Legacy
clean jobs carrying a branch hold settle immediately without a lookup, worker,
or round charge, even before `retryAfter`; their gate reports `review-settled`.
The shared settled predicate still honors operator retriggers and strict-mode
non-blocking findings, which continue to require remediation branch evidence.

The prompt never emits an empty `--branch`. It supplies `--repo` and `--pr` so
the guarded publisher can resolve a missing branch from the live PR. Publication
still requires the original reviewed head, exact remote lease, and diff checks.
Publisher refusal artifacts also retain `localCommit` when available. Workers
report publication refusals as the valid reply outcome `blocked`, including a
local `commitSha` in `operationalBlockers[]`.

An exited worker reporting committed-but-unpublished work stops with
`remediationPlan.stop.code: "committed-unpublished"`, even at the round cap.
`unpublishedWork` records `jobId`, `commitSha`, `workspaceDir`, and `reported`.
When the workspace HEAD can be inspected, it overrides reply hashes: an unchanged
HEAD at `revisionRef` produces no publication debt. Explicit worker-reported
commit evidence remains a fallback when the workspace is unavailable.
The stop reason and PR comment name the job and commit; the gate remains failed
with reason `remediation-committed-unpublished`, without an operator-decision
notice. If the live head exactly matches the retained commit, the gate reports
pending review (`remediation-published-awaiting-review`, or the existing
`stale-review-head` when the prior reviewed head is known). Publication alone
never settles the review or deletes the retained evidence. Workspace retention
skips this publication debt, including past the normal terminal TTL. Recover by inspecting that workspace and running the same
guarded publisher with the original previous head and remote lease; the record
is diagnostic evidence and does not authorize a merge or an unguarded push.

## Job filenames and per-PR reads (LEDGERSCAN-01)

`buildFollowUpJob` creates `<sanitizeRepo(repo)>-pr-<prNumber>-<timestamp>`
job IDs; `createFollowUpJob` writes `<jobId>.json`, appending a numeric suffix
on a creation collision. This naming predates schema version 2.
`moveFollowUpJob`, `moveTerminalJobRecord`, claim/requeue transitions and
`archiveStoppedFollowUpJobs` preserve the basename. `writeFollowUpJob` updates
the supplied existing path. There is no alternate production job-name format
requiring a fallback history scan.

`summarizePRRemediationLedger` filters directory names by that PR prefix before
opening files in both full and refund-only modes. The trailing `-` separates
PR 87 from PR 8776. Parsed repo, PR and domain remain authoritative, including
when sanitized repo names collide. Unreadable matching records are logged and
skipped individually. Archived stopped records already use a PR prefix filter.
Directory enumeration still covers all names; job reads and JSON parsing now
scale with the matching PR's records. For example, a bucket with 10,000 jobs
and 3 matching records requires 3 job reads instead of 10,000.

The watcher's latest-job, revision, active-ownership and filtered merge-agent
dispatch lookups also narrow filenames before reading. Case-insensitive
ownership predicates retain case-insensitive filename matching.
`listFollowUpJobsInDir(rootDir, key, { repo, prNumber, caseInsensitiveRepo })`
narrows reads only when both `repo` and `prNumber` are supplied; callers retain
their parsed identity checks. Partial filters (including repo-only) or an omitted
filter retain the whole-bucket reader used by reports and maintenance.
Health/latency reports, diagnosis/reset/recovery tools, replay reports and
queue-wide admission, reconciliation, shutdown and retention sweeps retain
their existing whole-history or whole-active-queue behavior.

## Refused remediation publication (REMLABEL-01)

`bin/remediation-publish.mjs` validates the candidate against a freshly fetched
base before pushing under the prior remote-head lease. An empty PR diff or
restoration of every originally changed file refuses publication, preserving
the previous head. The publisher writes `<replyPath>.publication-failure.json`
beside the round's existing reply artifact:

| Field | Type | Meaning |
| --- | --- | --- |
| `code` | string | `remediation-empties-pr-diff` for the preservation refusal; other publication errors retain their code. |
| `message` | string | Diagnostic reason. Reconcile uses its own fixed public message. |
| `previousHead` | string | Original reviewed head, matched to the job's `revisionRef` before reconciliation trusts the refusal. |
| `refusedAt` | ISO timestamp | Refusal observation time. |

Once the worker exits, a matching preservation refusal precedes lifecycle
completion, reply validation, no-progress handling and published-head recovery.
The job moves to `failed/` with `failure.code: remediation-empties-pr-diff`, an
owed failure comment, and a failed worker; no re-review is requested. A sidecar
for another reviewed head cannot fail this round. A successful guarded publication
removes the supplied failure sidecar before reporting success; missing files are
harmless and other unlink errors are reported. Retained failures follow existing
reply-artifact storage; no separate sweeper or new CI gate is added.


## Missing retrigger-review label-event observations

`tryRetriggerReviewFromLabel` in `src/follow-up-retrigger-review-label.mjs`
persists the first observation when a present `retrigger-review` label lacks a
scoped event and the current head is a valid 40-character SHA. Conclusively
non-attributable or untrusted labels are removed without creating an observation.
The store is `data/follow-up-jobs/missing-label-events/<digest>.json`, where
`digest` is the lowercase SHA-256 hex digest (without the `sha256:` prefix) of
`missing-label-event:<repo>#<prNumber>@<normalized-head-sha>`. The payload contains
only `firstSeenAt`, an ISO 8601 timestamp from the initial observation. It has no
schema-version field and is written through `writeFileAtomic`.

| Field | Type | Meaning |
| --- | --- | --- |
| `firstSeenAt` | ISO 8601 timestamp string | Initial observation time; reused across daemon restarts. |

The digest filename is the record key; there are no foreign keys or additional
payload fields.

Subsequent observations read the same timestamp, so a daemon restart cannot
restart the wait. After five minutes (`MISSING_LABEL_EVENT_WAIT_MS`), the present
label is treated as a current-head review request with actor `unknown` and the
observation key as its synthetic label-event key. A finite non-negative
`RETRIGGER_REVIEW_MISSING_EVENT_WAIT_MS` overrides that delay. Normal
label-consumption idempotency and audit handling then apply; this fallback grants
no operator override. A proven completed comment-only final-round push retains
hammer ownership rather than triggering another review.

Retention is indefinite in the current implementation: consumption, label
removal and head changes do not delete observation files, and no automatic
sweeper covers this directory. Operators may remove a record after confirming
that its PR is closed or its head is superseded; recompute the digest from the
repo, PR number and head because those identifiers are absent from the payload.
Keep records for active heads: deleting one resets the observation wait if the
label is encountered again. Retention cleanup does not remove the separate
label-consumption or operator-mutation audit receipts.

## Infrastructure round refunds (REMREFUND-01)

Reconcile can return an exited worker's job to `pending/` without charging the
round or `remediationPlan.transientRetries`. It requires known, equal start and
authoritative live end heads, no lifecycle stop, and a recorded reason:
`codex-tool-host-unavailable`, `publish-blocked`, `boot-failed` or `boot-failure`.
HQ outcomes require `status: "failed"`; stale failure fields on `succeeded`,
`superseded`, running or cancelled dispatches cannot qualify. Local outcomes
without a status qualify only for `boot-failed`, recorded from a child spawn
error. Narrative text and bare signal exits (including 137/143) cannot qualify.
Operator and supervisor cancels therefore do not earn a refund from their
signal exit alone.

The persisted accounting fields are:

- `remediationPlan.rounds[].startHeadSha`: the job's `revisionRef` captured when
  the round is claimed. Legacy rounds fall back to `revisionRef` at settlement.
- `remediationPlan.rounds[].publishedHeadSha`: the different authoritative live
  head observed when the round settles. This records head movement, not proof
  that the worker authored the commit; legacy settled rounds may lack it.
- `remediationPlan.rounds[].resultingHeadSha`: the live PR head SHA observed by
  the daemon when a round completes successfully. It is `null` without live
  lifecycle confirmation; legacy completed rounds may lack it. Worker replies
  cannot attest this field. Recovery additionally requires the exact workspace
  tip to match the live head and carry this job's `Worker-Job-Id` trailer.
  Unlike `publishedHeadSha`, it may equal the start
  head when no head movement occurred.
- `remediationWorker.recordedOutcome`: optional `failureReason`, `exitCode` and
  `signal` captured from local child error/exit events. HQ outcomes instead come
  from dispatch status; failed terminal events must confirm that status first.
  Normalized events preserve SDK terminal/succeeded booleans, including explicit
  false. Status probes accept wire-only terminal evidence: missing status resolves
  to `succeeded` or `failed` only when terminality is confirmed.
- `remediationPlan.publishedRoundsForPR`: the ledger's count of rounds with
  `publishedHeadSha`, computed when a budget stop is recorded.
  It feeds budget-stop comments and cannot reconstruct historical publications.

HAMCLOSE-05 uses completed jobs in `completed/` for the same repo and PR to
connect `startHeadSha` to `resultingHeadSha`. The hammer head validator requires
each link's GitHub comparison to be strictly `ahead`; missing heads, identical
or diverged comparisons, and failed comparison reads cannot establish proof.
Unreadable or malformed job files are skipped individually, preserving valid
evidence from other completed jobs. If the directory cannot be read, no round
evidence is available.

The retry transition retains the round and its attempt metadata while decrementing
`currentRound`; the next claim reuses that round number and merges the retained
record before resetting its claim identity, delivery key, `state` and
`startHeadSha`. `retryHistory[]` retains the attempt's worker outcome in `worker`,
plus `retryMetadata` with
`code: "infrastructure-refund"`, `reason`, `startHead`, `endHead`, `workerClass`
and `harnessSpecific`. `retryReason` is `not charged: <reason>` and `retryAfter`
is the settlement timestamp. Only one refund is allowed per charged round on
the job; a failed retry stays charged. The PR-wide limit is two, including
other jobs and archived stopped jobs. `ADV_MAX_REMEDIATION_INFRASTRUCTURE_REFUNDS`
can lower the limit to a non-negative integer, including zero, but cannot raise
it above two. Only decimal digits after trimming whitespace are accepted;
blank and invalid overrides use the default. Eligibility and requeue share
the job-write lock. A declined refund retains existing HQ transient retry rules
and their separate bounded budget. Settlement patches only current round head
fields from a fresh locked record. Missing records or lock contention defer
settlement to the next tick. Local event writes retry lock contention five times
with exponential delays of 25–400 ms and verify worker identity each time.
Refund notices are best-effort posts without terminal comment-delivery stamps;
GitHub failures cannot mutate a claimable pending job. Budget comments report
observed head movement since tracking began, rather than worker publications.

`harnessSpecific` is true for `codex-tool-host-unavailable` or a local
`boot-failed` outcome. The retry prefers an eligible configured fallback with
the existing quota and next-round reviewer diversity checks. If none qualifies,
it uses the uncapped primary; an infrastructure failure alone cannot create a
`quota-exhausted` hold. A chosen fallback records
`fallbackResolution.reason: "infrastructure-fallback"` and its infrastructure
reason as `capSource`; ordinary quota holds retain REMFALLBACK-01 semantics.

## Published-head recovery (REMLINK-01)

Pending retries retain `rounds[].spawnedAt`, `publishedHeadSha` and `worker`
for recovery before another attempt. Claim merges that retained round into the
new claim; this retention alone grants no authorship or merge proof. A pre-spawn
requeue removes a purely claimed round, but preserves a round with `spawnedAt`
or `publishedHeadSha`, and decrements `currentRound` to reuse the same number.

`findWorkerPublishedHead` in `src/remediation-published-head.mjs` requires a
spawned attempt, a changed authoritative live head (different from both
`startHeadSha` and `revisionRef`), and a workspace tip matching that head with
exactly one valid `Worker-Job-Id` trailer matching `jobId`. Missing or unreadable
workspaces and mismatched trailers fail closed. `publishedHeadSha` records
movement only; reply prose and a matching tip without provenance cannot attest
worker authorship. Replies predating the attempt's `spawnedAt` are ignored.

Successful recovery uses the ordinary terminal writer to complete the retained
round and job, setting `resultingHeadSha` to the live, proven head. Job and round
`completion` contain `source: "worker-published-head-recovery"` and
`publishEvidence: "workspace-worker-job-trailer"`. The ordinary
`markFollowUpJobCompleted` writer copies this completion object onto the current
round during the terminal write, before any follow-on request. Recovery compares
round identifiers numerically, normalizes proven hexadecimal heads to lowercase,
and guards the later round-level `reReview` update if an existing terminal
record lacks the recovered round; the job-level outcome is still persisted.
A current valid reply, if
present, is retained in `remediationReply`; no reply is required to establish the
independent commit proof. The terminal record is written before follow-on
requests; `reReview` records the request intent and then its outcome. Ordinary
rounds request re-review and wake the watcher; comment-only final rounds wake
the existing cap/closure lane with re-review suppressed. Recovery itself grants
no CI waiver or merge decision.

Recovery holds a delivery claim across completion and follow-on dispatch. It
defers without changing the job or dispatching follow-on work if another
unexpired claim owns the terminal path; retained publish evidence is retried. It
registers the delivery retry index pointer only after persisting the final
`reReview` outcome and rendered `commentDelivery.body`. The one-time completed
worker backfill can use `remediationReply.payload` when the reply artifact read
fails with `ENOENT`; it revalidates that payload against the job identity and
reply contract. Multi-round jobs require the payload stored on the current
round's `remediationReply`; the top-level payload is accepted only for an
unambiguous single first round. An explicit payload round must match.
Other artifact read or validation errors do not use the fallback.

The backfill examines at most 100 records and directory transitions per tick,
including all historical archive months, before releasing the queue lock.
`data/follow-up-jobs/delivery-retry-index/.remediation-reply-backfill-cursor`
atomically stores resumable progress until the completion sentinel is written:

| Field | Type | Meaning |
| --- | --- | --- |
| `directory` | absolute path string | Last terminal directory visited, in sorted path order. |
| `after` | string | Last processed filename in that directory; `\uffff` marks a finished directory. |

The cursor has no foreign keys. Failed writes and held claims retain the cursor
before that record for the next tick. Completion removes the cursor; deleting it
early safely restarts the idempotent scan. The sentinel is never written for a
partial or failed scan.

The stale-claim sweep probes recovery after its activity, age and CPU gates.
An exited worker with current result artifacts can be reconciled earlier.
If reply reconciliation still reports `active` after the stale gates pass,
the sweep continues to the existing signal-and-requeue path. A reply file
therefore cannot reserve a hung worker's slot indefinitely.

## Re-review accepted with CI pending at timeout (CIBLOCKHAM-01)

When a valid reply requests re-review and the bounded CI settlement wait expires
with external checks still `pending`, reconcile accepts the request and completes
the job. Its `reReview` object adds `ciSettlement: "pending-at-timeout"` and
`ciGate`, the last CI inspection snapshot: `state: "pending"`, `headSha`,
`conclusion`, `rollupKnown`, `totalExternalChecks`, `failedChecks`, and
`pendingChecks`. Check
entries retain the classifier's check name, state, workflow name and details URL.
This is observation evidence, not CI greenness or merge authority. Unknown CI
at timeout retains the failure path; green CI does not add these fields.

`markFollowUpJobCompleted` persists the same object at job-level `reReview` and
at `remediationPlan.rounds[].reReview` for the completed current round. These
optional fields accompany the ordinary request fields (`requested`,
`requestedAt`, `reason`, `triggered`, `status`, `outcomeReason`, `reviewRow`). The
watcher still gates reviewer dispatch on live green external CI.

For a reply whose operational blockers are only CI, reconciliation also projects
`completion.pendingCiOnly: true` and `completion.workerPushedHeadSha`. For ordinary
rounds, the live PR head must differ from the current round's `startHeadSha`
(falling back to `revisionRef`), and an independent CI probe must match that head
and satisfy `classifyFinalRoundOperationalBlockers`. Comment-only final rounds
instead require the worker push proof described below and probed pending CI.
`resolvePendingCiCompletion` in `src/comment-only-final-round-completion.mjs`
owns this projection and reply normalization. The fields select the public
CI-running completion comment; they do not suppress an ordinary requested
re-review or grant merge authority.

Automatic failed-CI admission leaves a stopped `no-progress` job stopped and
hands ownership to the hammer; it cannot reopen that job on a later CI probe.
Explicit operator remediation retriggers retain their existing stopped-job allowlist.
A completed job with `finalRound: "comment-only"` and
`reReview.suppressed: "comment-only-final-round"` is already
handed to the hammer. Failed-CI admission returns `ci-regression-hammer-owned`
without mutating it, and direct round requeue throws before either no-progress
or round-cap handling. Its job and round remain completed, preserving the
start/result edge read by strict hammer starting-base validation.

## Conflicted-base probe retries (REMCONFLICT-01)

A transient `hq dispatch --help` failure before spawn reuses the existing
`remediationPlan.transientRetries`, `retryAfter`, and `retryHistory[]` fields.
The retry history's `retryMetadata` contains
`{ code: "hq-conflicted-base-probe-transient", recoverable: true }`, and
`retryReason` retains the subprocess diagnostic. Transient requeue retains the
round and decrements `currentRound` so the next claim retries the same round.
`nextAction.operatorOverride=true` is retained on the claim's `worker-spawn`
action and restored on the retry's `consume-pending-round` action when the
pending job carried it. Successful spawn replaces that action normally.
The shared transient retry limit applies; exhaustion records
`failure.code="hq-conflicted-base-probe-retries-exhausted"` with the original
error message and `remediationWorker.state="never-spawned"`.

## Native workflow publication evidence (WFDRIFT-01)

`operationalBlockerRecovery` records `{ category: "github-auth", classification,
rescue, retry, recordedAt }`. After a scoped native push emits a matching Git
update transcript, reconcile atomically saves
`retry.pendingNativePublication` before querying the live PR head. Its shape is
`{ schemaVersion: 1, source: "native-workflow-publisher", method: "git-update",
jobId, repo, prNumber, branch, expectedRemoteSha, headSha, observedAt }`.
`observedAt` is the original update-evidence timestamp. No subprocess output or
credential is stored. `retry.workflowPush` retains the proven outgoing paths,
provider and lease/commit identity.

Live head reads retry transient subprocess errors with 250/750 ms backoff;
post-push verification also retries a stale head. Exhausted transient or stale
verification sets `retry.pushed: false`,
`retry.reason: "workflow-push-publication-unproven"` and `retry.retryLater: true`
for ten minutes from the update-evidence timestamp. The job stays in
`in-progress/`; later reconcile ticks validate the saved job/repo/PR/branch/lease/
commit identity and resume verification without another push or worker spawn.
Permanent errors and expiration of that window stop active verification retries
under normal settlement rules, while retaining update evidence for a later
explicit recovery. Failed capability preparation also preserves saved evidence.

Only a fresh exact-target PR-head observation upgrades that evidence to
`retry.nativePublicationReceipt`, with method `git-update-and-live-pr-head` and
a fresh `observedAt`, and sets `retry.pushed: true`. An already-published head
without matching native update evidence cannot create a receipt. Final-round
blocker projection still requires independent worker/trailer/patch-equivalence
proof and exact-head pending/green CI; the worker reply remains immutable.

## Comment-only final-round evidence

A zero-blocker `Comment only` review with non-blocking findings creates a job
marked `finalRound: "comment-only"`. Every final-round job that reconciles a
worker reply records `reReview.suppressed: "comment-only-final-round"`, whatever
directory it lands in. The optional
For these final rounds, `completion.workerPushedHeadSha` is a 40-character commit SHA written only when
the worker workspace's local `HEAD` matches a retried live GitHub PR-head lookup,
its commit carries the matching `Worker-Job-Id` trailer, and a local replay
proof holds (COMMENTCLOSE-01): every reviewed commit has a patch-equivalent in
`HEAD` (`git cherry HEAD <reviewed>`), `HEAD` adds no merge commit, and every
other commit it adds beyond the reviewed head and `origin/<base>` carries the
job's trailer (`git cherry <reviewed> HEAD origin/<base>`). The remediator's
mandatory base rebase makes most pushes `diverged` from the reviewed head, which
the earlier ancestry-only proof rejected without a log line.
`completion.workerPushProof` records `{ method: "git-cherry-replay",
reviewedCommitsReplayed, workerCommits }`. Reconcile remains re-entrant when a
transient lookup exhausts its retry budget. A transient git failure during the
proof (network, remote hang-up, lock contention) is retried after 2 s and 5 s;
if it persists the job stays in `in-progress/` with
`finalRoundProofTransient: { since, lastAttemptAt, attempts, error }` and later
ticks retry it. After one hour from `since` the proof is withheld as usual. HQ jobs use their resolved topic
workspace for this proof. Every withheld proof logs its reason
(`finalRoundOutcome.push`, for example `live-head-mismatch`,
`foreign-commit-in-push`, `branch-contamination-audit-failed`). When the proof
is withheld while the PR head moved, the job records that head as
`completion.withheldPushHeadSha`. HELDHEAD-01 queues one automatic exact-head
review when that SHA remains current and no reviewer or closer owns it. The
job records `completion.withheldHeadReReview` as a durable intent before the
guarded reset, with `headSha`, `requestedAt`, and a system `reason`. Unprobed CI is
recorded as `reported-pending`, distinct from reconciler-probed `pending`. The file
write does not prove the SQLite transaction committed. If the row lacks both a
matching `rereview_requested_at` / `revision_ref` and an exact-head
`reviewer_head_sha`, watcher admission retries the same intent using its original
`requestedAt`; a request exception or transaction rollback does not page or
consume the recovery. Missing terminal files (including an absent archive
directory) defer the lookup without resetting the row. Once the database
confirms the request or exact-head reviewer, repeated ticks cannot request
another review. The system bypass applies only to the unproven-head hold and review-budget
admission; settled verdict and terminal closer guards remain in force. Legacy
exact-head posted or pending rows are never reset. Request and paging errors
are logged per subject without aborting the watcher tick. Job writes re-read
under the shared writer/archive lock and preserve the recovery intent. Once
normal retry policy declares a terminal failure, the operator-blocked lane
pages with `withheld-head-review-failed`; the alert debounce is written only
after delivery is queued, and the job intent is not marked alerted in advance;
a moved PR head never receives a review of the withheld SHA. The historical
`adversarial_review.comment_only_final_round_push_unproven` page is replaced by
this automatic recovery. No withheld proof grants AMA authority; the fresh
verdict supplies the proof needed by normal AMA/hammer closure.

Absent or malformed push proof grants no AMA final-round handoff.

`completion.finalRoundOutcome` (COMMENTCLOSE-01) records the reconciler's
decision: `{ completed, reason, ciState }`. A final round is complete when its
reply has no `blockers[]` and its only operational blockers are PR-head CI that
is still running, and either the reply says `completed` or the push is proven.
Pending CI is classified structurally: each entry carries
`kind: "pending-ci"`, or (legacy replies) exactly one untagged entry with no
`needsHumanInput`, in a reply whose outcome is not `blocked`, is corroborated by
the reconciler's CI probe of the proven pushed head reporting `pending`. `reason`
names the rule that decided, for example `kind-pending-ci`,
`ci-probe-pending-ci`, `operational-blocker-needs-human-input`,
`untagged-blocker-outcome-blocked`, `untagged-blocker-ci-not-pending`,
`ci-failed`, `review-blockers` or `no-proven-push`. An
incomplete final round still records its pushed head and suppression marker.

The ledger summary retains `commentOnlyFinalRoundRevisionRefs` for reviewed
heads and projects verified `(reviewedHead, workerPushedHeadSha)` pairs as
`commentOnlyFinalRoundPushedHeads`, with `completedAt` (the job's terminal
timestamp) for follow-up suppression and `status` for the terminal directory it
came from, and `pushProof` for the recorded proof method. Both read `completed/`,
`stopped/`, `failed/` and `stopped-archived/<YYYY-MM>/`: an archived stopped job
keeps its recorded push, its withheld head and its review key. AMA requires the current PR head to equal a
pair's pushed head, the settled review to match its reviewed head, and GitHub
compare to report the pushed head `ahead` (or `diverged` for a
`git-cherry-replay` proof); the closer then reads the verdict from the
matching terminal job's `reviewBody` (`findCommentOnlyFinalRoundPushJob`). While
PR-head CI on that head is pending, AMA holds the PR without spending the
retain-loop cap for up to two hours after the pair's `completedAt`
(`FINAL_ROUND_CI_WAIT_DEADLINE_MS`); past that it logs
`final-round-ci-pending-timeout` and the cap applies again. A later head can be
reviewed normally.
Job scans skip a file removed during a queue transition and warn on malformed
JSON without discarding other jobs.

## One follow-up per posted review

`createFollowUpJob` creates at most one job per posted review (COMMENTCLOSE-01).
The reviewer process and the watcher's reviewer-pass reaper can both queue the
same review (agent-os#7311: two final-round jobs 9 s apart). A review is keyed
by repo, PR, reviewed head (`revisionRef`) and the SHA-256 of its normalized
`reviewBody`. An existing job for that key in `pending/`, `in-progress/`,
`completed/`, `failed/`, `stopped/` or `stopped-archived/` makes the request a duplicate: the call
returns `{ job: null, jobPath: null, duplicateOf }`, the reviewer reports
`queued: false, reason: "duplicate-review-follow-up"`, and the reaper skips its
wake. A short-lived claim serializes the two processes between that scan and
the job write. It is a chain of generation files
`data/follow-up-jobs/review-claims/<repo>-pr-<n>-<revisionRef>-<digest16>.g<N>.json`
(`{ repo, prNumber, revisionRef, digest, token, claimedAt, pid, host }`), each
created exclusively; the highest generation holds the claim. A holder older than
2 minutes, whose process has exited on this host, or whose file is unreadable is
abandoned, and taking it over means creating the next generation, so only one
recoverer wins. A claim held by a live creator is not a duplicate: the caller
waits for that job to appear or the claim to be released or abandoned, and throws
`review-follow-up-in-flight` if that takes more than 4 minutes. Release is
token-checked and removes the chain only for the current holder. A review with no
reviewed SHA or no body is not de-duplicated.

## Remediator quota holds and fallback (REMFALLBACK-01)

ITP-14 adds optional `remediationWorker.accountProposal` for declared privileged
remediator pools: `{ identity, tokenAccountId, brokerProvider, reason,
evidenceGeneration }`. IDs/provider/generation may be null on holds. This is
pre-dispatch selection evidence; the dispatcher revalidates and records the
actual bound account/lease in launch/run provenance. Never infer a historical
account from the canonical worker class or promote a proposal to a receipt.
Canonical `remediator-codex`/`remediator-claude` remains the worker class on both
accounts. `fallbackFrom`/`fallbackResolution` apply only to a cross-family role
change, including the existing typed infrastructure repair. Unknown evidence and
unsupported local pooled dispatch use the existing budget-neutral claim hold;
no new durable job status is introduced. Undeclared pools keep the legacy
class-based evidence below. Pool selection uses shared account evidence and
does not turn historical class-only cap records into an account-wide cap.

A quota hold is a job whose latest `remediationPlan.retryHistory[]` entry has
`retryMetadata.code: "quota-exhausted"` (a legacy job with no history is read
from `remediationPlan.lastRetryMetadata`). Two writers produce it.

Reconcile (`settleQuotaExhaustedRemediation`, `src/remediation-quota-hold.mjs`)
writes it when a spawned worker hit a provider usage cap:

- `harness`: the quota harness named by the cap signal.
- `workerClass`, `model`: the remediator class (`remediationWorker.model`) and
  resolved model that ran, or `null`. These are the job-local cap evidence the
  next claim reads.
- `resetAt`, `providerResetAt`: the parsed provider reset (ISO) or `null`.
- `source`: `"provider-reported"` or `"fallback-window"`.
- `maxUnvalidatedHoldMs`: the one-hour hold window.
- `pastHoldWindow`: `true` when the provider reset is more than one hold window
  away. That hold does not increment `remediationPlan.transientRetries`, and it
  never reaches the terminal `quota-exhausted-budget-exhausted` failure, because
  the next claim re-resolves the remediator class instead of respawning the
  capped one.

Claim (`holdClaimedJobForCappedRemediator`, `src/remediation-claimed-requeue.mjs`)
writes it when the routed remediator is capped and no declared fallback class
can take the job. The job returns to `pending/` budget neutral, with its claimed
round removed, `remediationPlan.retryAfter` set to the hold end and a
`consume-pending-round` `nextAction`. The entry has `worker: null`, and
`retryMetadata` carries `code`, `harness`, `workerClass`, `model`, `resetAt`,
`providerResetAt`, `maxUnvalidatedHoldMs` as above, plus:

- `source`: `"remediator-fallback-resolution"`.
- `capSource`: what proved the cap, for example a fleet quota state or
  `"provider-reset-past-hold-window"`.
- `fallbackReason`: `"no-available-fallback"`, `"no-fallback-configured"` or
  `"primary-resets-within-hold-window"`.
- `skipped[]`: `{ workerClass, reason }` for each declared fallback class passed
  over (`provider-untracked`, `reviews-next-round:<reviewer>`,
  `capped:<capSource>`, `resets-within-hold-window`, `unavailable:<state>`).
- `noRespawn: true`: the claim gate releases the hold early only on a fleet
  probe whose `lastGoodAt` is newer than the entry's `requeuedAt`.

When the claim moves the job to a fallback class, the spawned
`remediationWorker` records the substitution:

- `fallbackFrom`: the routed class that was capped.
- `fallbackReason`: the cap source, or the routing reason when none.
- `fallbackResolution`: `{ reason: "primary-grounded-fallback", capSource,
  primaryState, resetAt, candidateState, skipped[] }`. `candidateState` is the
  fallback's fleet quota state, or `"unverified"` when the fleet status could
  not be read.

A job run by its routed class has none of these fields. The fallback order is
`roles.remediator_fallback` in `config.yaml`.

## Single-review jobs (SINGLEREVIEW-01)

A job queued for a super-small PR's single review carries
`singleReview: { applied: true, basis, stats, reason }`. `basis` is
`small-change` or `docs-tests`, and `stats` is the classifier's diff stats. Only
an applied decision is persisted; normal-rounds jobs have no `singleReview` key.
The reviewer writes it from `selectReviewMode`, and the reviewer-pass reaper
writes it from the `review_mode_selected` row (`readSingleReviewDecision`).

Creation-time invariant: such a job is born with the tier budget spent,
`remediationPlan.currentRound = maxRounds` and
`remediationPlan.nextAction.round = maxRounds + 1`. The claim guard stops it
`max-rounds-reached`. This covers any verdict with findings, including a
`Comment only` review with non-blocking findings (`finalRound: "comment-only"`),
and holds even if a claim-time budget raise lifted `maxRounds`. A clean review
still settles `no-remediation-required`. The stop reason begins
`single-review: super-small PR; the first review was the final round`. An
operator override (`nextAction.operatorOverride: true`) bypasses the stop.

Ledger rule: `summarizePRRemediationLedger` counts a never-spawned
single-review stop (`isSingleReviewStop`) as `currentRound` completed rounds,
with a `completedRoundTimestamps` entry at `stoppedAt` and no trigger or
revision ref. This is the only never-spawned stop the ledger counts. It is
counted from `stopped/` and, after the 24-hour archive sweep, from
`stopped-archived/<YYYY-MM>/`, once per `jobId`, so archiving does not give an
open PR its spent budget back. The summary exposes `singleReviewStopJobIds` for
the stops still counting and `singleReviewVoidedAt`.

**Void marker.** Store:
`data/follow-up-jobs/single-review-voids/<domain>--<repo>-pr-<n>.json`.
Written by `voidSingleReviewCredit` (`src/follow-up-jobs.mjs`), called from
`selectSingleReview` (`src/review-mode-selection.mjs`) when a non-`first`-stage
review's full diff is no longer super-small while the ledger still counts a
single-review stop. Shape:

```json
{
  "domainId": "code-pr",
  "repo": "owner/repo",
  "prNumber": 123,
  "voidedAt": "<ISO>",
  "history": [
    { "voidedAt": "<ISO>", "headSha": "<sha|null>", "reasons": ["gate-keeper-path"], "jobIds": ["<jobId>"] }
  ]
}
```

`history` is capped at the last 10 entries. The ledger ignores single-review
stops whose `createdAt` is at or before `voidedAt`, so the PR gets its tier
budget back; a single-review job created later counts again. The stopped job
files are never rewritten. An unreadable marker is logged and ignored. A void
write that fails is retried up to 3 times. If it still fails, `selectReviewMode`
throws and the reviewer exits non-zero before dispatch. The review pass fails retryable instead of running the
lenient stage while the credit is still spent.

## Operator-label CI failures (LABELGATE-01)

Review-findings consumption and the final pre-spawn lifecycle gate do not stop
jobs for operator-label CI checks. A finding that requests reverting a guarded
change can still spawn remediation to restore the base state without granting
an override. `operator-label-required:<label>` is a closer hold/audit reason,
not a follow-up job stop code; this PR does not add it to
`RETRIGGERABLE_STOP_CODES` or persist it in `remediationPlan.stop`. No retrigger
is needed for label-gate CI state because review remediation is not stopped.

The final pre-spawn gate evaluates existing lifecycle stops before DIRTY
conflict repair. In particular `stale-drift` and `stale-review-head` win over a
DIRTY merge state, preventing a stale job from repairing or launching a
conflict hammer. Their existing stop and retrigger rules remain applicable.
