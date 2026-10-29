# Data Model - AMA Closure Audit

COMPANIONFLOAT-01: a pure companion dependency terminal attempt records
`companionWait: { repo, prNumber, submodulePath, mergeCommit }`, with a null
merge commit until known. The stop reader preserves this object and extracts
legacy PR URL evidence from closing status/next without truncation. Its retry
candidates preserve target head, launch ID, audit job key and pure-companion
classification for exact-charge accounting. Closing status names automated
closure recovery and the companion-merge/base-gitlink event. Mixed blockers
retain their actual reason and ordinary accounting. See the
[companion hold contract](hammer-stop-hold.md#companion-dependency-waits-companionfloat-01).

**Owner:** AMA merge authority
**Store:** `$HQ_ROOT/dispatch/audit/adversarial-merge-authority/`
**Source of truth:** `src/ama/audit.mjs`
**Runtime surface:** `bin/ama-audit.mjs`, `bin/hammer-terminal-audit.mjs`, `src/ama/hammer-terminal-audit.mjs`, `bin/hammer-publish.sh`, `bin/hammer-pending-attestation.mjs`, `src/ama/hammer-pending-attestation.mjs`, `templates/hammer-prompt.md`, `bin/hammer-merge.sh`, `bin/hammer-verify-head.sh`, `src/ama/daemon-merge.mjs`, `src/ama/closing-keywords.mjs`, `src/ama/no-ci-configured.mjs`, `src/daemon-clean-merge.mjs`, `src/ama/hammer-stop-hold.mjs`

## Purpose

One JSON document records closure attempts for a `(repo, prNumber, headSha)`
tuple. Its filename is `<repo-with-slashes-replaced>-pr-<number>-<head>.json`.
The writer serializes appends with a sibling lock file and writes JSON atomically
at mode `0640`.

| Field | Shape | Contract |
|---|---|---|
| `schemaVersion` | number | Current value is `1`. |
| `repo`, `prNumber`, `headSha` | string, number, string | Immutable record identity. |
| `createdAt`, `updatedAt` | ISO timestamps | First write and latest append. |
| `status` | string | Latest attempt outcome, except `succeeded` stays sticky. |
| `attempts` | array | Immutable ordered attempt history. |
| `appendedRecords` | optional array | Compatibility evidence recovered from trailing JSONL after the leading JSON document. Parsed lines retain their original shape; malformed lines become `{ unparsed: string }` with at most 2000 characters. Preserved by subsequent atomic rewrites, without changing `status` or numbering `attempts`. |
| `attempts[].attemptNumber` | positive integer | Sequential, starting at `1`. |
| `attempts[].startedAt` | ISO timestamp | Append time. |
| `attempts[].outcome` | string | `in_progress`, `deferred`, `superseded`, `succeeded`, or `failed-without-merge`. Other attempt fields carry caller evidence, including `closingStatus` for gate-cap parks. |
| `attempts[].waited_s` | optional number or null | Merge-lease timeout elapsed seconds from the lease CLI; missing or null duration evidence is recorded as JSON `null` so the deferred audit remains valid. |
| `attempts[].configured_s` | optional number | Procedure-enforced merge-lease wait budget in seconds for a timeout attempt. |
| `attempts[].pendingAttestation` | optional object | Hammer audit-delivery failure after a successful range proof: `baseHead` (last reviewed SHA), `validatedHead` (document head), `identity` (`login`, numeric `databaseId`), and `validationSummary` (`rangeVerified: true`, non-negative `total`, `blocking`, `nonBlocking` counts). Fixed fields only; no secrets, stderr or arbitrary bodies. |
| `attempts[].attemptPhase`, `attempts[].path` | optional strings | Per-attempt producer provenance. Daemon phases are `daemon-pre-merge`, `daemon-merged`, `daemon-deferred`, and `daemon-failed`; `path` names its closure authority, including `ham-terminal-remediation` for a daemon call on a HAM-certified head. Hammer phases include `hammer-gh-pr-merge`, `hammer-gate-attempt-cap` and `hammer-lease-admission`. Document-level authority alone does not identify the producer of a marked attempt. |
| `attempts[].guardReversals` | optional array of `{ authorization, paths, failedCheckRun, passingCheckRun, failedHead, passingHead }` | Independently verified required-guard reversal authority from the latest completed in-lease eligibility evaluation. Daemon terminal attempts retain it on both success and failure, including when an independent gate such as CI refuses merge. Omitted when that evaluation returns no verified reversals. `authorization` is `Reversal-Authorized-By: guard:<check name>`; paths, run IDs and exact head SHAs identify the proof. This evidence does not waive other merge gates. |
| `attempts[].derivedChanges` | optional array | MIGRENUMBERDERIVED-01 mechanical migration renumber proofs from the latest in-lease eligibility evaluation. Same proof shape as [merge-action receipts](automation-merge-actions.md); retained on daemon terminal attempts. Hammer attempts retain the evidence in `githubGate.derivedChanges`. This classification does not waive other merge gates. |
| `reconciliation.needsRepair` | boolean | Latest append's repair signal. Present on records auto-created by append. |
| `reconciliation.lastVerifiedAt` | ISO timestamp | Latest append time. Present on records auto-created by append. |
| `closingKeywordRewrites` | optional array | Title and body rewrites computed by the daemon; absent on older records. Each item is `{original, referencedNumber, referencedRepo, replacement}`. |
| `attempts[].closingKeywordRewrites` | optional array | Per-attempt message rewrites, including hammer shell attempts. Same item shape as the top-level field. |
| `attempts[].resumeOwed` | optional boolean | Hammer terminal attempts set this to `true` only for `reason: required-checks-pending`; other reasons write `false`. Durable merge-resume debt consumed by the watcher closure scheduler and `src/ama/hammer-resume.mjs` after the bounded worker defers for pending CI. Older and non-hammer attempts may omit it. |
| `attempts[].resumeHead` | optional string or null | Producer attempts record the exact validated SHA when `resumeOwed` is `true`, otherwise `null`; settlement attempts retain the original SHA. The consumer resumes only while the live head equals this SHA. Routing intent only; never merge authorization. |
| `attempts[].resumeAttempt` | optional positive integer | Settlement attempts link the immutable pending-CI producer by its `attemptNumber`; absent on producer and older attempts. |
| `attempts[].waitNote` | optional string | Terminal hammer merge phase formats the published-head and required-check elapsed seconds into a diagnostic note on every terminal append. |
| `attempts[].headWaitedSeconds` | optional non-negative integer | Elapsed published-head visibility wait in seconds, measured by verify-head and persisted by the terminal merge phase. `0` means the wait never started. |
| `attempts[].requiredChecksWaitedSeconds` | optional non-negative integer | Elapsed exact-head required-check wait in seconds, measured and persisted by the merge phase. `0` means the wait never started. |
| `attempts[].remoteCiStatus` | optional string | UNKNOWN deferral uses `mergeability-unknown` when checks passed and `mergeability-unknown-ci-timeout` when CI remained unsettled at the deadline. The reason stays `pr-mergeability-unknown` for recovery routing. Deadline expiry before the next read preserves this classification from the last validated-head snapshot when no other hold is present. |
| `attempts[].githubGate` | optional object | Last exact-head gate snapshot, including `checksConclusion`, `state`, `headMatches`, and mergeability; preserves pending or unreadable CI evidence alongside UNKNOWN deferral. |
| `closureAuthority`, `reviewer`, `riskClass`, `flagState`, `ciMode` | optional provenance | Watcher-owned metadata, or caller-provided metadata when an append creates a missing record. `ciMode` is `github-checks` or `no-ci-bootstrap`. |
| `ciConfigurationAdmission`, `attempts[].ciConfiguration` | optional `{ reason, repo, base, head, baseHead, checkedAt }` | Only the operator-authorized no-CI daemon route. Top-level admission metadata holds the pre-lease proof; the successful `daemon-merged` attempt holds its latest in-lease proof. All identity fields are strings; `checkedAt` is an ISO timestamp and `reason` is `no CI configured`. |

`harnessResolution` and `attempts[].harnessResolution` record the closer's
physical `workerClass`, resolver `reason`, `hold` boolean, and quota provenance:
`evidenceSource`, `evidenceAgeMs`, `evidenceReadAt` (epoch milliseconds), and
`liveReadReason`. Evidence fields are null when unavailable. Optional `diagnostics` is an array
of producer/field strings explaining unreadable or unavailable account evidence;
it does not change the hold reason, admission policy or retry authority. Snapshot use is
recorded even when the class stays unchanged. Resolver holds write a `deferred`
attempt with `reason: harness-hold:<resolver reason>`; genuine exhausted fallback
sets preserve `all-fallbacks-grounded`. The same reason is returned to dispatch
callers, along with `holdReason`. See the
[quota snapshot contract](ama-closer-quota-snapshot.md).

ITP-14 adds optional `harnessResolution.accountProposal` (and the same nested
field per attempt): `{ identity, tokenAccountId, brokerProvider, reason,
evidenceGeneration }`. Account/provider/generation are null when no selection
was proposed. Both corporate and primary keep the canonical hammer role;
`fellBack` denotes only an eligible declared cross-family role change. These
fields convey no merge authority and are not a lease receipt. Managed dispatch
revalidates admission and owns the actual durable account binding. Pool holds
use the existing `deferred` audit outcome and `harness-hold:<reason>`; the legacy
quota snapshot is not an alternative source of pooled admission evidence.

ITPPOOLCONFLICT-01 adds optional `conflictKey` to `harnessResolution` and its
`accountProposal`, also retained per attempt. A legacy/new policy conflict
records `reason: pool-config-conflict`, `hold: false`, and the conflicting config
key path, never its value. No account/provider/generation is selected. The closer
continues on its class route and records the ordinary dispatch outcome;
the conflict does not create a deferred attempt or a new lifecycle state.

OSG-14 resolves the optional remediator arm before the closer writes its audit.
`harnessResolution.workerClass` is the selected physical execution class.
When an arm applies, optional `harnessResolution.modelResolution` contains
`resolvedModel`, `resolvedReasoningLevel` (string or null) and
`source: 'osg-remediator'`; `accountProposal` then describes that arm's proposed account.
Optional `harnessResolution.osgRemediator` retains the
[route observation](osg-remediator.md), including fallback reasons when no arm
applies. These fields also appear in `attempts[].harnessResolution`. Existing
harness holds skip OSG and retain the deferred audit; no lifecycle states or
merge authority change.

```mermaid
erDiagram
  AMA_AUDIT ||--|{ AMA_ATTEMPT : records
  AMA_AUDIT ||--o| RECONCILIATION : tracks
  AMA_AUDIT {
    int schemaVersion
    string repo
    int prNumber
    string headSha
    string status
  }
  AMA_ATTEMPT {
    int attemptNumber
    string startedAt
    string outcome
    string waitNote
    int headWaitedSeconds
    int requiredChecksWaitedSeconds
  }
  RECONCILIATION {
    boolean needsRepair
    string lastVerifiedAt
  }
```

`appendAmaAuditAttempt` may create a missing head record. That first append
includes the reconciliation block and any supplied provenance metadata. Later
appends preserve existing metadata and update reconciliation. A successful
record cannot be demoted by a later append.

`parseAmaAuditDocument` accepts a valid leading object followed by non-empty
JSONL lines and exposes them as `appendedRecords`; unrelated parse failures
still throw. This is recovery for historical hand-appended hammer evidence,
not a second writer protocol. Records can carry `outcome`, `reason`, `head` /
`currentHead` / `headSha` / `validatedHead`, `closingStatus`, `next`, and
`timestamp` / `recordedAt` without the numbered-attempt shape.

The [hammer stop hold](hammer-stop-hold.md) reads both arrays for the live and
reviewed heads, choosing the latest matching hammer terminal decision by
`startedAt` / `timestamp` / `recordedAt`, then array order. Explicit hammer
phases (`hammer-*` or `before-hammer-*`) are accepted only with no path or a
hammer path (`hammer`, `ham-terminal-remediation`); other explicit phases are
excluded. A path without a phase must be a hammer path. Legacy entries with
neither marker are accepted only when document `closureAuthority` is absent
or a hammer path. Explicit hammer provenance wins over document metadata;
daemon attempts never set or clear a hammer decision. A latest hammer
`failed-without-merge` or legacy `no-merge` starts a hold; a later hammer defer
or success clears it.

Pre-acquire live admission refusals append an attempt with
`attemptPhase: hammer-lease-admission`, `reason: merge-lease-admission:<reason>`,
`reviewedHead` and `validatedHead`. Reasons are `head-changed`, `pr-not-open`,
`pr-is-draft` or `operator-hold`. Confirmed already-merged PRs produce no refusal
record. `operator-hold` and `pr-is-draft` outcomes are `deferred`; `head-changed`
is `superseded`; `pr-not-open` is `failed-without-merge`. Thus transient live gates
do not create hammer stop holds. These attempts use the existing audit fields
and sticky-success guard. Admission has no held-lease merge decision and is
exempt from merge-action receipts; its audit records the refusal.
The hammer itself never uses historical
terminal stops as admission input after the closer releases a hold.

The pre-merge stacked-base check records `outcome: deferred` with
`reason: stacked-base-merged` or `stacked-base-read-failed` and releases the
merge lease. A merged-parent hold must not create a `failed-without-merge`
stop: retargeting can restore eligibility without changing the PR head.
The hammer reads the CLI's last non-empty output line as the reason, preserving
the merged-parent classification when preceding persistence diagnostics exist.

`src/ama/hammer-resume.mjs` reads outstanding `resumeOwed` / `resumeHead`
receipts for each PR. The posted-review scheduler bypasses no-progress backoff
and prioritizes these subjects every poll, so no unrelated wake is required.
Automatic stale-review refresh also preserves the recorded hammer head. Closure
reconciles the receipt against current PR state/head and shared exact-head CI:
pending waits without another launch; green selects the normal leased hammer
verify-and-merge path; red returns to normal remediation; head movement returns
to normal head-change handling. The receipt carries no verdict or CI authority.
Existing dispatch/target/lifetime limits, safety holds, live ownership and merge
predicates still apply. Missing audit markers do not suppress normal evaluations.

Settlement appends `attemptPhase: hammer-resume`, `resumeOwed: false`, the
original `resumeHead`, and `resumeAttempt` (the producer's `attemptNumber`).
`reason` is `resume-dispatched`, `resume-head-moved`, `resume-checks-red`, or
`resume-pr-terminal`, or `resume-budget-exhausted`. Exhausted existing hammer budgets
settle the debt and leave ordinary capped recovery ownership. Confirmed dispatch records `outcome: in_progress` and
`launchRequestId`; other settlements record `outcome: superseded`. The immutable
producer remains in history. `deliveryKey: hammer-resume:<resumeAttempt>` makes
settlement idempotent under the audit writer's lock. A later terminal helper
result supersedes older debt; a new pending stop creates a new bounded attempt.
A refused/uncertain dispatch keeps the debt for ordinary recovery. Sticky success
cannot be demoted.

For primary-change evidence, a post-lease `primary-change-read-failed` or
`primary-change-unknown` gate
writes `reason: gate-read-failed`, `permanent: false`, and the concrete reason
in `eligibilityReasons` / `preMergeReasons`. It omits `manualCloseRequired`,
so a later tick may retry the same head after GitHub reads recover.

`closingKeywordRewrites` records the explicit merge subject and body sanitization,
with title rewrites before body rewrites. `original` and `replacement` are raw
author-text snippets (including whitespace), not trusted commands or markup;
consumers must escape them when rendering. `referencedNumber` is numeric and
`referencedRepo` is `null` for local `#N` / `GH-N`, or the referenced owner/repo
for qualified and GitHub URL references. Actual self-PR references are exempt.
An empty array means no supported closing-keyword adjacency was rewritten; it
is not proof that other merge surfaces or individual commits are sanitized.
The top-level field describes the daemon's bootstrap message; immutable
attempt entries are authoritative for later attempts.

The hammer exports `HAM_AMA_TRAILERS` from the canonical dispatch-time
`composeAmaTrailers` block, preserving reviewer family, eligibility reason and
`ama-audit:<repo>:pr-<number>:head-<sha>` trace identity. Its message helper fails
closed when that block is missing; it never synthesizes substitute provenance.
No-CI evidence corroborates the operator's explicit repository declaration in
`roles.adversarial.merge_authority.no_ci_repositories`; it is not inferred from
an empty rollup alone. Live reads cover base/head Actions and known external-CI
configs, head check suites and commit statuses, all effective rule pages, and
classic branch protection. Live proof waives required adversarial-gate protection
only for the declared repository's daemon call; the domain policy still applies
to every call without proof.
Top-level evidence records admission intent, not proof of a successful merge;
only the successful attempt records the proof used at closure. In-lease
transient configuration lookup errors write `reason: gate-read-failed`,
`permanent: false` and omit `manualCloseRequired`. Permanent probe errors refuse
proof instead of deferring. Revoked proof or newly appearing CI records
`reason: gate-not-eligible`, `permanent: false` with the real eligibility reasons
and omits `manualCloseRequired`, permitting a later same-head retry.

Lease-admission attempts (`attemptPhase: hammer-lease-admission`) record live
head/state/draft/label refusals but neither set nor clear a hammer stop decision.
The stop reader skips them even when their outcome is deferred or failed.

HAMATTESTRETRY-01 records pending edges with `attemptPhase: hammer-audit-comment`,
`outcome: deferred`, and `reason: audit-comment-unavailable`. Recording requires
this run's successful reviewed-to-validated range proof. Recovery reads only the
matching repo/PR/head audit and selects a pending edge from that producer phase.
The current live head, last reviewed base and authenticated App login plus
numeric identity must match before posting under the next hammer's lease.
The pending object alone is never provenance: the unchanged App-comment parser
must accept the recovered comment before the normal range proof can succeed.
These immutable historical attempts need no new lifecycle state or config key.

## Docs fast path authority (DOCSFASTPATH-01)

The existing daemon audit may carry `closureAuthority=docs-fast-path`,
`mergeAccountability=docs-fast-path`, and `docsFastPath={headSha,baseSha,baseBranch}`.
No reviewer or finding count is invented. A failed attestation delivery appends
`outcome=deferred`, `reason=attestation-record-failed`, `permanent=false`
and diagnostic `error`, then releases the lease for a later retry. The signed
`docs-fast-path` attestation lives in the canonical head-attestation ledger,
through the existing sign/record interface. Live classification and merge
eligibility are checked under the lease before recording on every transport
attempt. A moving base tip requires a fresh docs-only range on the same base
branch. Before recording, an `in_progress` write refreshes top-level
`docsFastPath` metadata to the latest eligible range, including its base SHA;
terminal appends preserve this metadata and the ordinary attempt history.
A failed metadata write defers without attesting or merging. Recording authorizes
an attempt, so a transport failure after recording
can still leave an unmerged head with an attestation.

For a pre-merge attestation failure, the attempt also records `exitCode`
(number or null), `signal` (string or null), `stderrTail` (redacted, at most
2,000 characters), `error` (bounded redacted message and diagnostics),
`retryAfter` (ISO timestamp or null), `needsOperator` (boolean), and
`parkReason` (null or `attestation-record-retry-exhausted`). The daemon
counts `attestation-record-failed` attempts on this exact head, including older
non-permanent `failed-without-merge` entries. The first two failures set
`retryAfter` to 60 then 120 seconds later; the third sets `needsOperator=true`
and null `retryAfter`. Later observations return
`attestation-record-retry-exhausted` without audit writes or lease acquisition.
A new head has independent history. An unreadable audit defers without recording.

## Stable-key queue deliveries (MGQ-06)

`appendAmaAuditAttempt` treats a non-empty `attempt.deliveryKey` as an outbox
idempotency key: when an existing attempt already carries the same key it
returns `{ filePath, doc, replay: true }` without rewriting the file. The v2
queue delivers one `succeeded` attempt per merge with `closureAuthority:
merge-queue-v2` metadata on a newly created record and attempt fields
`attemptPhase: queue-squash-merge`, `reviewedHead`, `validatedHead`,
`rebasedOntoBase`, `mergeMethod`, `mergeCommitSha`, `mergedAt`, `mergedBy`,
`receiptDigest` and `queueEntryId`. Attempts without a delivery key keep their
existing append semantics.

## Launch outcome evidence (LVR-02)

`attempts[].launchRequestId` is the producing `HQ_LAUNCH_REQUEST_ID` when
available. The CLI overwrites any stale identity from an attempt input file.
LVR-01 checks this attempt-local identity and outcome, rather than inheriting a
sticky document status from another launch. Manual callers without a launch
identity retain the existing audit format.

Credential refresh failures that prevent a call, missing starting PR state,
manual pre-call refusals and rendered phase failures append
`failed-without-merge` before returning. Early audits use the dispatch target
head until a valid current head is known, a fixed reason code and
`attemptPhase: hammer-early-exit`. They require neither GitHub nor a merge
lease. Repeated wrappers preserve this launch's existing terminal reason.
Without `HQ_LAUNCH_REQUEST_ID`, repeated `hammer-early-exit` reports preserve
the first unkeyed terminal attempt for this repo/PR/head. Keyed launches remain
independent of manual reports and other launches.
Optional proactive refresh failure with a usable held credential creates no
terminal failure. Raw transport output and credentials never enter these
records. An unavailable audit is reported as an error; sticky succeeded
protection still applies.


HAMLANEWAIT-01 uses the existing `deferred` outcome with reason `lane-busy` for
legacy lane-lock `owner-operation-in-flight` exit 75. It is not a terminal
no-merge attempt. No schema or migration changes; the wrapper reports measured
`waitedMs` in its refusal diagnostic. Other refusals keep their prior outcomes.

## Hammer captured-base provenance (LAC-2097)

Hammer's existing `rebasedOntoBase` string records the captured base only when
`git merge-base --is-ancestor` proves it is contained in the produced head after
FIFO acquisition. Otherwise verification leaves it empty, including first-pass
retention followed by base advancement while waiting for the lease. Capturing a
base tip alone is not evidence of a rebase. The merge phase's own successful
server-side rebase continues to record its proved target. This tightens evidence
semantics without changing the audit schema or granting merge authority.
