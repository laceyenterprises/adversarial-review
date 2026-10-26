# Queue remediation closer

Remediate PR <<PR_URL>> in repository <<REPO>>, PR <<PR_NUMBER>>.
Reviewed head: <<REVIEWED_SHA>>. Target head: <<TARGET_REMEDIATION_SHA>>.
Risk: <<RISK_CLASS>>. Queue route generation: <<QUEUE_ROUTE_GENERATION>>.
Use this run's private scratch directory <<RUN_DIR>> and absolute helpers from
<<ROOT_DIR>>. Never print credentials or scan unrelated state.

Read the complete current review inventory, including non-blocking findings,
original review IDs and commit IDs. Preserve primary-change intent and signed
source evidence. Resolve every finding by a concrete fix with paths and exact-head
validation evidence, or a justified withdrawal with source locations, explanation
and exact-head evidence. An acknowledgement or exhausted budget is no disposition.
Terminal adjudication is final; do not request another model judgement.
Honor live holds, ordinary edit/reversal authority, branch rights and the existing
emergency execution brake. If required guard or primary-change authority is
missing, stop through the existing operator recovery surface; never waive it.

Make only the required remediation edits. Run bounded focused validation in the
foreground with the existing load-aware validation helper. Publish the remediated
head through the entitled expected-old-head publication surface, preserving
worker/closer launch identity and produced/reviewed signature references.
Do not acquire a merge lease, run a base-rebase loop, wait for remote CI, or call
merge. Those operations belong to the queue executor. Do not source or render
hammer-verify-head.sh, hammer-publish.sh or hammer-merge.sh.

Pass routeGeneration <<QUEUE_ROUTE_GENERATION>> and the original absolute deadline
to the completion surface. Submit the complete schemaVersion 1 queue handoff through the resolved service below: lane,
PR, pushed head, stable admission generation and handoff ID, worker and closer
identities, source review ID/commit ID, original attestation references, complete
fixed/withdrawn dispositions, primary-change provenance, local validation and
successful publication references. The trusted service verifies these facts
mechanically; never self-certify or edit its database.

<<QUEUE_HANDOFF_INSTRUCTIONS>>

Wait only for the bounded durable handoff acknowledgement. A failed/lost reply
must retry the identical handoff ID/payload through that service. Exit successfully
only after the service reads back the matching committed ack and releases this
closer's worker/lease resources idempotently. Report the entry ID, ack ID and
pushed head, then exit immediately. Do not retain a closer slot across queue CI.
An unavailable service or unconfirmed acknowledgement uses existing recovery;
never fall back to legacy finalization, including during rollback. An in-flight
closer must be drained by the operator before any route transfer.
