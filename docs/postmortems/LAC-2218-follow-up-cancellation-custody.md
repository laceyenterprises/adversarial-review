# LAC-2218: stale-head cancellation loses caller and execution custody

## Evidence and causal boundaries

The incident report supplies a failed follow-up reconciliation at
2026-11-18T03:49:49.597Z for job
`laceyenterprises__agent-os-pr-11047-2026-11-18T03-26-31-331Z`, launch
`lrq_a2eea883-a3b2-4b0f-9981-7904c562e75a`, run
`wrun_8bbb8f75-c45b-421f-be13-90d82198e97c`. Its cancellation receipt has
`cancelled=false`, `attempts=1`, `exitCode=1` and HQ's missing-authenticated-actor
refusal. The reported public comment 6968460755 describes no usable reply,
although the productive worker had published source. Those original records
remain unchanged; this source fix does not repair their historical status.

Content-free, read-only native Git metadata independently establishes:

| UTC | Native HEAD reflog |
| --- | --- |
| 03:38:57 | `677fddc3bf642cc5a82fc948d70a60fab39d6912` |
| 03:49:31 | `8e4daf88c8bb37248af8138e607217a8ff1a47ca` |

`git merge-base --is-ancestor` for the first tip against the second exits 1.
Thus the native replacement HEAD was installed before the reported cancellation
and did not retain the first tip in its ancestry. The incident report separately
identifies both tips as publications; reflog timestamps are not push acknowledgements. A later read-only HQ status reported
this launch `succeeded`; that observation is not retroactive evidence of
terminality at the cancellation time. A later `hq attest chain` read for this PR
returned an empty array. It does not establish exactly when attestation first
became visible, nor that a produced receipt ever existed.

The monitor's exact historical live-head observation and Git command interleaving
were not recovered. Therefore the precise incident stale-head trigger remains
unproven. Cancellation failure alone cannot explain why stale classification
occurred: classification happens first. The independently established
non-ancestral replacement makes a specific source race possible: the monitor
observes publication A, the worker replaces HEAD with publication B, and the
monitor compares A against B. The old code deterministically declares this
own publication stale. The controlled offline test reproduces that sequence
without timing assumptions. An ordinary advancing commit would not reproduce
it because A would remain an ancestor. Do not relabel the incident as proven
external movement or proven attestation delay without historical evidence.

## Source defects

1. `dispatchRemediationViaHq` passes a scoped parent session to HQ and saves it
   as `hqParentSession`. `cancelHqDispatch` previously launched a new CLI child
   using only ambient environment, losing the accepted caller when monitor and
   dispatcher environments differ. Installed HQ's `cli_watch._resolve_cancel_actor`
   accepts an explicit operator principal, parent session or harness session;
   no identity produces the incident's exact refusal before opening its ledger.
   Separately, `watch.cancel_dispatch` selects the launch by
   `requested_auth_owner`. Forwarding an established session preserves that
   owner fence; inventing `operator:*`, substituting an OS username or adding
   `--as-owner` would not be a legitimate fix.
2. `activeRemediationStopDecision` previously treated non-ancestry to mutable
   current HEAD as proof of external movement. It ignored previous HEAD custody
   and exact produced attestations. Rewrites invalidate that inference, and a
   post-publication attestation cannot be assumed visible at every poll.
3. Failed cancellation moved the job to `failed`, marked its worker failed and
   queued the generic terminal failure comment. Execution had not ended, so
   the ordinary in-progress reconciliation path lost its live owner. HQ can
   also accept a durable cancel intent with exit zero before termination;
   accepted intent or missing/malformed output is not proof of stopped execution.

## Repair and regression evidence

Cancellation forwards the already accepted parent session when the monitor has
no explicit parent. HQ retains actor precedence and owner authorization.
Non-ancestral active heads are checked against the worker's HEAD reflog and
immutable ancestry. Remote-tracking reflogs do not confer custody. A bounded or
unreadable history probe retains unknown ownership. HQ workers additionally
consult the existing verified exact-head produced identity reader; only the
same launch/class supplies own-publication proof. Unavailable reads retain
custody. These are execution fences, never completion or merge permission.
Failed/pending cancellation retains `in_progress` / `spawned` with its last
receipt and `cancellationHold`, without a terminal failure comment. Terminal
status and reply reconciliation continue on the same job. The receipt writer
locks and re-reads current custody to preserve newer observations and avoid
resurrecting a terminal job or mutating a changed owner. Fifteen controlled
receipt-write interleavings cover those three competing writer outcomes.

`test/lac-2218-cancellation-custody.test.mjs` uses disposable Git repositories
and mocked CLI boundaries. Restoring the two source preimages yields four
failing tests: actor propagation, own-publication rewrite interleavings, exact
produced custody, and pending-intent termination. The rewrite test runs 40
controlled interleavings (20 for each of two publications); every preimage
interleaving is misclassified. Fixed interleavings retain custody without any
attestation read. External absent and fetched-only commits still select the
stale-head stop; invalid/foreign attestations do not supply custody. Existing
reconcile fixtures plus LAC-2218 cases prove failed signalling retains an active
job and refused HQ cancellation can later settle from terminal status without
another cancel or false failure comment.

HCP memory searches for cancellation identity/custody and mutable-head
publication races were available and returned no records. The supplied
`merge.finding-remediation-and-authoritative-terminal` history informed the
separate checks for source publication, live ownership and authoritative
terminality. Sibling sweep: the runtime-inspection HQ cancellation branch now
also retains custody on refusal; terminal lifecycle settlement never invokes
active-worker cancellation. Standalone operator stop/cancel tools keep their
separate audited contracts.

## Source delivery and deployed acceptance

Source delivery requires the normal tagged source PR, current-head cross-model
review and required CI. Record its URL/head and validation on LAC-2218.
Publication is not deployed acceptance. After normal deployment by its owner,
record the loaded source/build identity and read-only receipts from naturally
occurring own publications, genuine external supersession and any failed or
pending cancellation. Qualify retained custody, exact authenticated caller
attribution and subsequent authoritative terminal/reply settlement separately.
Absent organic events remain pending acceptance, not a synthetic live probe.

No cancellation, redispatch, service restart, credential read, runtime DB/config/
job edit, extra review of #11047, duplicate remediation or merge action belongs
to this source work. Root operator retains #11047 closure. LAC-2212 rename proof
and LAC-2215 inventory remain distinct evidence.
