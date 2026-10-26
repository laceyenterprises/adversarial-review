# Exact absence recovery (LAC-2120)

The public producer can return selector-bound canonical absence evidence for an
exact, expiring operator entitlement. Ordinary SDK emptiness stays unavailable
with `dispatch absence scope unproven`; `complete: true` alone never settles.
The [owning producer contract](https://github.com/laceyenterprises/agent-os/blob/main/platform/app-contract-endpoint/docs/dispatch-absence.md)
defines `dispatch_absence_reads`, the global query, scope and bounds. An exact
entitlement authorizes an existence query across project/repository boundaries,
without granting visibility of foreign launch rows. This is a separate operator
recovery authorization, never an app registration claim or a project-grant guess.

`dispatch-read-client.mjs` accepts empty results only when `scope_complete` is
exactly true and `absence_proof` names version 1,
`canonical-exact-selector-absence`, the exact selector just queried, a bounded
nonempty `grant_id` and a valid `observed_at`. Only exact key or whole ticket/time
selectors qualify. A missing row in a positive snapshot, a launch-ID selector,
retry traversal, malformed/unbound proof, transport failure or unsupported old
producer retains ownership. The producer's negative fact is point-in-time;
existing submission/deadline rules and native fences still decide settlement.

Public SDK 0.8.0 and 0.9.0 transports forward the JSON envelope unchanged.
`readDispatchLookupResult` still validates the base envelope; the consumer
validates this additive optional evidence. No SDK source, types, dependency,
lockfile, installed package or immutable archive changes are required. This
consumer remains pinned to its existing 0.8.0 artifact; the separately owned
DOG-10/LAC-2118 0.9.0 migration is independent. If typed SDK interpretation is
added later, release a new producer artifact and adopt its merged public bytes.

The dispatch directory owner continues to run the documented single-PR
`bin/settle-legacy-closer-intent.mjs` command, dry-run first. For expired keyed
intents, both key and inclusive whole-ticket query must be sufficient; a failed
supplemental ticket query cannot be bypassed by key absence. Inspect the actual
selector, grant ID, observation time, native intent/lease and result. A separate
operator decision permits `--apply --reason`; the command fsyncs
`settlement-authorized` with both proofs before mutation, then completion.
`preReceiptReconciliation.query.absenceProof` and
`query.ticketQuery.absenceProof` preserve this provenance. No proof-file input,
private canonical reader, lease clear, retry reset or guard bypass is added.

Receipt adoption still requires exact key, AMA ticket and compatible repo/head;
foreign/multiply identified rows hold. Live submitter/process identity retains
the existing pre-deadline hold; verified PID reuse needs complete process and
canonical absence evidence. Existing full record/lease snapshots protect
concurrent receipt/replacement, and the intent retry decrement replays once.
No locking algorithm or transition destination changes.

Before any separately approved recovery, verify normal reviewed producer and
consumer deployment and their actual loaded generations. Exact, expiring app
entitlements must be separately provisioned by the operator; these PRs do not
provision grants, enable flags, restart services or apply settlement. Do not
infer absence from time, caller death, missing leases or filtered emptiness.
Keep source publication, deployment/loaded evidence and organic recovery as
three separate acceptance records.

On demand, the producer suite `test_dispatch_absence.py` starts authenticated
HTTP and calls `test/helpers/absence-settlement-composition.mjs` in an explicitly
provisioned companion checkout. The latter uses the installed locked SDK and
native settlement command against disposable stores. The producer also replays
the immutable 0.9.0 archive. Existing and foreign launches, partial grants,
unreadable transport, live/reused identities, concurrent receipt/replacement
and refund replay exercise the complete boundary. No model validation or live
queue action is performed. Existing smoke promises remain unchanged.
