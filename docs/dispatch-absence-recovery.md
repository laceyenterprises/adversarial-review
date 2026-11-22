# Exact absence recovery (LAC-2120)

The public producer can return selector-bound canonical absence evidence for an
existing paired grant with explicit project/repository selectors, or an exact,
expiring operator entitlement. Ordinary SDK emptiness stays unavailable
with `dispatch absence scope unproven`; `complete: true` alone never settles.
The [owning producer contract](https://github.com/laceyenterprises/agent-os/blob/main/platform/app-contract-endpoint/docs/dispatch-absence.md)
defines `dispatch_absence_reads`, the global query, scope and bounds. An exact
entitlement authorizes an existence query across project/repository boundaries,
without granting visibility of foreign launch rows. Unscoped incident recovery uses separate operator authorization. Scoped
recovery validates an explicit pair against the existing grant; app registration
and guessed visibility never establish authority.

`dispatch-read-client.mjs` accepts empty results only when `scope_complete` is
exactly true and `absence_proof` names version 1,
`canonical-exact-selector-absence`, the exact selector just queried, a bounded
`grant_id` containing non-whitespace and a valid `observed_at`. Selector keys must
be own properties of the proof with defined values equal to the query. Only exact
key or whole ticket/time selectors, optionally with both scope fields, qualify. A missing row in a positive snapshot,
a launch-ID selector, retry traversal, malformed/unbound proof, transport failure or unsupported old
producer retains ownership. The producer's negative fact is point-in-time;
existing submission/deadline rules and native fences still decide settlement.

Before creating a new in-place repair epoch, the native helper sends the
intended project and qualified repository with a fresh probe key through the
authenticated review app SDK session. It requires a selector-bound canonical
response with `grant_id: project-repository-dispatch-read`. A generic authorization error,
filtered response, hidden match or transport failure leaves visibility
unproven. A typed `dispatch_scope_denied` identifies an unreadable pair.
Admission persists the verified project and rechecks current custody under the
existing lock. The preflight establishes pair visibility at admission time.
It does not establish absence or custody for the actual dispatch key.

Existing reservations use the paired selector when their dispatch project was
recorded. A repair reserves before enqueue, so even a canonical exact-key
absence proof leaves an existing reservation pending. At the base head,
release requires a positively identified terminal launch with complete retry
evidence on the automatic path. For legacy unscoped and original CWP conflict
reservations, the [HQ-owner
retirement command](RUNBOOK-ama-closure.md#retire-one-fenced-legacy-repair-reservation-lac-2297)
requires a committed canonical enqueue fence, independently of this SDK
contract. CWP requires matching committed owner and epoch fences and verifies
the distinct live head on the original PR branch. The command uses the
existing operator boundary and requires no additional dispatch-read entitlement.

Public SDK 0.8.0, 0.9.0 and 0.10.0 transports forward the JSON envelope unchanged.
`readDispatchLookupResult` still validates the base envelope; the consumer
validates this additive optional evidence. No SDK source, types, dependency,
lockfile, installed package or immutable archive changes are required. This
consumer uses the installed immutable 0.10.0 artifact; absence evidence needs no artifact modification. If typed SDK
interpretation is added later, release a new producer artifact and adopt its
merged public bytes.

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
ownership even after the deadline; verified PID reuse needs complete process and
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
the immutable 0.9.0 archive. A custom `sdk_entry` accepts an absolute filesystem
path or a `file:` URL, including encoded spaces and URL-sensitive characters.
Existing and foreign launches, partial grants,
unreadable transport, live/reused identities, concurrent receipt/replacement
and refund replay exercise the complete boundary. No model validation or live
queue action is performed. Existing smoke promises remain unchanged.


## Dead dispatch submitters (CLOSERDISPATCHDEAD-01)

Recovery reads now send `project_ref` and owner-qualified `repo` with the exact
key or inclusive ticket/time selector. The producer requires the existing paired
`dispatch_reads` grant and checks unfiltered canonical rows before returning
`canonical-exact-selector-absence`. Zero canonical matches prove no launch; a
hidden match, incomplete scope, unreadable identity, timeout or exceeded bound
still holds ownership. This fixes the ordinary recovery contract without
per-attempt operator entitlements; unscoped incident recovery remains supported.

Dispatch records add `hqProject` (the project passed to HQ; older records use
`adversarial-merge-authority`) and optional `interruptedAt`. SIGTERM/SIGINT stop
background admission and synchronously persist `state: dispatch-interrupted`
before aborting submissions or waiting on reviewer fences. It is a pre-receipt
intent: retain its lease, key and artifacts until native reconciliation adopts
the matching receipt or proves no launch. It never authorizes a direct retry.

`abandonAmaCloserLease` is asynchronous and invokes that reconciliation before
releasing a pending lease. Dead/reused PID plus process-start identity, no live
submission/key process and canonical absence settle to `no-dispatch` and a
terminal `deferred` lease in the same pass. Normal fenced reclamation admits
one successor; retry refund replays once. Live submitters, launch owners,
foreign hosts and uncertain evidence retain ownership. No live recovery is
performed by this source change. After normal producer then consumer deployment,
the runtime owner may observe organic recovery; existing smoke promises remain.
