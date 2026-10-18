# Data Model - Operator Label Holds

**Owner:** AMA closer operator-label paging
**Store:** `data/operator-label-holds/`
**Source of truth:** `src/ama/operator-label-gates.mjs`
**Runtime surface:** `src/ama/dispatch-closer.mjs`, `src/follow-up-remediation.mjs`

## Purpose

After hammer-route admission, stop-release persistence, terminal-launch and
lease reconciliation, and same-PR remediation ownership checks, the closer
observes exclusively registered operator-label failures on the live PR head
before launching closure work. Pending or state-less external siblings
and unrelated failures prevent a label-only classification. Latest runs win;
the pipeline's own status context is excluded. Registered check names are a
paging heuristic in production, whose normalized rollups omit failure output;
check/step names cannot distinguish a refusal from a guard script crash. When
supplemental output is present it must contain matching refusal/override text.
Only the registered `repo-guards` composite family (`repo-guards` and names
starting with `repo-guards-`, `repo-guards/`, or `repo-guards `), or
matching workflow names (including `Repo Guards`), is expanded
through the GitHub jobs API, and only when its head matches and every failed
step is a registered gate. Pending or unrelated failures skip all job reads.
A per-reader, bounded 512-entry cache keys responses by repo/job/head, retaining
completed responses and cooling down unreadable responses for 60 seconds. At
most two uncached jobs are read per pass with a 3-second subprocess timeout, a
5-second total read budget, and the closer abort signal. Read-cap, deadline and transport failures create a non-paging
`operator-label-classification-pending` recovery wait; transient reads retry once
within the budget. Missing required contexts prevent label-only paging. The registry currently maps
CI cost, submodule pointers, live-pack cross edits and historical gym freeze
checks to their operator labels. Advisory/successful checks create no hold.

The hold returns `dispatched: false`, `skipMergeAgent: true`,
`recoveryWait: true`, `needsOperator: true`, `reason` and `operatorLabelGates`.
The CI hold creates no dispatch record or follow-up job stop. REMLABEL-01 also
uses the registry for blocking review findings: an operator-only review stops
the unspawned follow-up job with `operator-label-required:<label>` and holds
terminal HAM dispatch. Mixed reviews retain ordinary remediation and explicitly
preserve gated changes. A fresh review must observe the operator waiver. A receipt is
paging evidence, never authorization to merge or proof of live CI greenness.
The follow-up consumer resolves PR lifecycle before creating this hold; closed,
merged or superseded reviewed heads use their lifecycle stop without a hold
comment or page.
The unspawned job records `commentDeliveryExemption: no-remediation-started`;
the hold receipt owns its operator comment and retry instead of worker-reply
delivery. Terminal HAM hold comments use the shared GitHub outbound-body filter.

## Files and fields

`<digest>.json` uses the hexadecimal SHA-256 of
`JSON.stringify([repo, prNumber, headSha])`. JSON writes use atomic replacement;
there is no schema-version field.

| Field | Shape | Contract |
|---|---|---|
| `repo` | string | Repository slug used in the key. |
| `prNumber` | positive integer | PR number used in the key. |
| `headSha` | string | Live head observed by the closer. |
| `reason` | string | First gate's `operator-label-required:<label>` reason. |
| `gates` | array of objects | Each contains `check`, `label`, and `reason`; preserves all observed label failures. |
| `alertedAt` | ISO timestamp or null | Successful alert-delivery timestamp; null permits delivery retry. |
| `commentedAt` | ISO timestamp or null (optional on legacy receipts) | Successful review-finding hold comment; absent/null permits comment retry independently of paging. CI-only holds do not require a comment. |

The comment callback uses the normalized `postRemediationOutcomeComment`
contract: only a truthy `posted` records `commentedAt`. That wrapper normalizes
successful adapter payloads and returns `posted: false` for skipped or failed
delivery. Such results retry the comment without repeating a successful page;
the paging claim is released after each attempt.

`<digest>.json.lock` is an empty exclusive-create paging claim. Its mtime is
used to reclaim stale claims after `OPERATOR_LABEL_PAGE_LOCK_STALE_MS` (default
60 seconds, minimum 1 second). The claim spans alert delivery and receipt write,
and is removed in `finally`. The receipt is re-read under the claim. Delivered
receipts matching the current
identity, reason and gates bypass both the lock and atomic rewrite; changed
gates update the receipt without paging that head again. A process-local successful-delivery set also suppresses repeat pages if a receipt
write fails, but does not survive restart and is capped at 512 entries.

## Lifecycle and retention

The closer reevaluates CI on every pass. Clearing the failing checks, advancing
the head, or observing a non-label failure removes this hold without deleting
the old receipt. Applying a label alone does not clear red CI. Inspect the
failure and repair a crashed script, or apply the appropriate override for a real
label refusal if intended, then rerun the named check.
Operator-gated review findings must retain the guarded changes; remediation cannot remove them to satisfy the gate.

The alert event is `ama_closer.operator_label_required` with payload
`{ repo, prNumber, headSha, reason, gates }`. Failed delivery is retried on later
observations. The lock's stale reclaim is best effort; slow delivery beyond its
stale interval and concurrent stale-claim reclamation can duplicate pages.
The successful-delivery set is capped at 512 entries. A best-effort sweep removes
superseded-head receipts when a new hold is observed, closed-PR receipts when
closure observes the closed PR, and unrelated receipts older than 30 days.
Active claim files are excluded from the sweep. These retention
and claim limitations do not grant merge authority. Ordinary findings remain remediable.
