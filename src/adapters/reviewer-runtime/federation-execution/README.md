# Frozen Antigravity execution

`createFederationExecutionAdapter` implements the MHF-13 execution boundary.
It is deliberately absent from the watcher adapter registry. Importing it starts
no service, reads no configuration or credentials, and opens no database. Existing
local review operation continues unchanged; federation remains disabled.

The only public operation is
`execute({ orderBytes, signature, grantId, signal? })`. There is no discovery,
GitHub posting, remediation, or merge interface. A signed result is evidence for
the origin, never review acceptance or a merge grant. See the canonical
[AGY runbook](../../../../docs/RUNBOOK-antigravity-gemini-reviewer.md),
[workspace runbook](../../../../docs/RUNBOOK-reviewer-workspace.md), and
[merge-authority runbook](../../../../docs/RUNBOOK-ama-closure.md).

## Request and result contract, version 1

`review-order.mjs` defines the strict execution request. It contains exact
origin/executor/logical-host identity, owner-qualified credential and generation,
repository/PR/head/round/epoch, model, inline prompt/diff/context UTF-8 text and
their SHA-256 hashes, and token/cost/output/artifact/time budgets. `workOrderHash`
binds the request to the original accepted federation work order and its frozen
class and entitlements. The effect policy is
`review-result-only`; the runtime is `antigravity`. Unknown fields refuse,
including environment, auth files, bootstrap commands and publication grants.
This is the narrowed review request derived by the authenticated federation
origin adapter, not a replacement for its general work-order, entitlement or
class-acceptance protocol. Prompt/context content still requires that protocol's
secret screening; this module's strict field validation is not a secret scanner.

Signatures and `orderHash` cover the **exact supplied UTF-8 wire bytes**. This
module defines no alternative JSON canonicalizer. The origin integration must
use its canonical-content owner when constructing those bytes and preserve them
on retry. The adapter checks the wire type and 2 MiB cap first, then authenticates
the exact bytes before parsing JSON or validating the schema. Within that cap,
unauthenticated malformed payloads fail with `Unauthenticated review order`;
authenticated payloads must still pass all wire/schema checks before any origin
read or seat consumption. Parsed inputs are recursively frozen before reaching
any dependency.
There are no filesystem artifact paths: up to 64 uniquely named UTF-8 artifacts
are returned inline with byte lengths and locally computed SHA-256 hashes.
Binary/blob transfer belongs to the executor spool, outside this version.

Requests are capped at 2 MiB, execution at 20 minutes, output plus diagnostics
at 1 MiB, artifacts at 4 MiB, and usage evidence at 256 KiB. Orders can lower
these budgets. Every dependency call has a deadline (5 seconds by default,
maximum 30 seconds); execution uses the smaller of the order timeout and the
remaining relative permit lifetime, conservatively including consume latency.
Control/collection/signing deadlines are additional to the execution budget.
Cancellation aborts the supervisor call; neither cancellation nor deadline proves
process death. Dependency implementations must honor abort and continue durable
supervision/accounting of surviving children.

The return value is `{ payloadBytes, signature }`; the injected signer signs
those exact bytes. The payload includes the full request binding and order hash,
status, normalized review or null, artifacts, all available usage events,
`usageComplete`, failure class, retry time and `seatRetained`. The shared kernel
sanitizer and effective-verdict classifier determine the review verdict; structured
blocking findings retain precedence over permissive prose.

| Status | Meaning |
| --- | --- |
| `completed` | Supervisor reported success and termination; origin still confirmed the binding; seat release was acknowledged. |
| `stale` | Origin binding changed or disappeared, or the conservative permit deadline elapsed. No applicable verdict; usage remains. |
| `failed` | Supervisor reported a nonzero exit. Provider pressure may carry a retry deadline. |
| `execution-unknown` | Execution, output, termination, control-plane or accounting evidence could not establish completion. No applicable verdict. |

A stale preflight starts no process. After execution, stale head/round/epoch
results keep usage and validated artifacts. Failed or malformed review output
also keeps available usage. A mismatched supervisor result cannot authorize a
review or release a seat; usage retrieved for that permit is retained, marked
incomplete. An unavailable usage snapshot is explicitly incomplete, not evidence
of zero spend. Events retain source (`estimate`, `harness-native`, `provider`,
`unknown`), measurement quality and native fields/revisions without summing
overlapping estimates and measurements. Attribution is the permit's immutable
order/install/host/credential tuple. Missing counters stay absent or null.

## Required injected owners

All dependencies are mandatory. There is no ambient fallback or default native
launcher. `verifyOrder(bytes, signature, { signal })` must authenticate the origin,
audience, peer identity, current authorization, approved frozen class/entitlement
hashes, budgets and content prerequisites, including correspondence to
`workOrderHash`; only literal `true` admits execution. Token and micro-USD cost
limits are positive safe integers. They are enforced by the injected supervised
runtime/capability owner, not inferred from estimated usage after execution.
`readCurrent(binding, { signal })` must return that complete binding only while
the origin's lease/epoch and review head/round remain current. An authoritative
absence returns null; an unreadable origin throws. It runs before seat consumption
and after execution. The origin must revalidate **again at acceptance/publication**
because these reads cannot eliminate a later head change.

`seatTransport` is an authenticated injected MHF-14 service client, wrapped by
`createHostSeatClient`. Its methods are:

| Method | Required service guarantee |
| --- | --- |
| `consume({ grantId, binding, signal })` | Atomically validate/consume a preauthorized grant; check shared account pressure; durably return `{ version: 1, grantId, startId, binding, validForMs }`. Same-grant recovery returns the same start identity, never a new child authorization. |
| `finish({ permit, terminationProof, signal })` | Verify opaque supervisor termination evidence covering every descendant and pending spawn; release idempotently and return `{ released: true, startId }`. Never release merely on expiry, parent exit, lost caller or daemon restart. |
| `defer({ permit, retryAt, failureClass, signal })` | Persist account-wide pressure and acknowledge `{ recorded: true }`. Admission on every host consults the credential owner/id, independent of executor/install/OS user. |

Physical-parent resolution, global seat arbitration, authenticated grant expiry
and durable seat storage belong exclusively to MHF-14's platform service.
Logical `hostId` supplied in an order is not proof of physical identity.
An invalid/unreadable permit never starts the supervisor. A failed finish or
pressure write keeps the seat retained and returns uncertainty. The service
must reconcile retained seats with its supervisor, including after grant expiry;
there is no unsafe release in a catch/finally block here.

`supervisor.run({ order, permit, signal })` must durably journal before spawning
and **start or attach by `permit.startId`** across adapter/process restarts. It
enforces model budgets, the execution-only sandbox and mediated capabilities
from MHF-11, without ambient GH/operator credentials, discovery, remediation,
merge tools or unrestricted network writes. It must never use the ordinary
posting reviewer CLI as its execution entrypoint. This injected implementation
is trusted; a JavaScript interface cannot sandbox a malicious dependency.

`supervisor.snapshot({ permit, signal })` returns a durable snapshot for that
start: `{ binding, output, diagnostic, exitCode, artifacts, usage, usageComplete,
terminationProof }`. Null exit/proof means unconfirmed termination. `run` settles
when supervision completes, and can throw on loss of connection; snapshot still
collects already-spent usage. Each usage event needs `eventId`, `source` and
`quality`; additional native fields are preserved. The supervisor owns a durable
outbox for late usage/artifacts and result retry; bounds, signer outages and lost
responses must not discard that spool or rerun a process. The signer must persist
the exact signed result for retry before publication acknowledgement. This
adapter stores no durable journal and makes no exactly-once transport claim.

Provider failures reuse the canonical runtime classifier and quota reset/hold
owner. There are no automatic paid retries or quota probes. A quota reset hint
wins over the shared conservative fallback window, also used for transient
429/capacity failures. The injected service carries pressure across hosts;
extra physical seats do not imply independent provider quota. A pure model
review body is never parsed as provider pressure.

## Offline evidence and deployment

Run the two `test/federation-*.test.mjs` files with `node --test`. The synthetic
service fixture models competing installs/users on one host, distinct hosts,
same-start restart attachment, surviving children, grant expiry, shared-account
throttling, signed-byte tampering, stale heads/rounds/epochs and accounting gaps.
It is an injected in-memory service model, not a production seat implementation,
physical-parent proof, process-kill test or Postgres concurrency proof. No ledger
or transaction behavior is implemented in this change. MHF-14 must exercise its
real service's storage, transaction/exception behavior, identity and arbitration.

No service restart, migration, configuration flip or real-host activation is
required after merge: the adapter has no registered runtime or listener. The
idempotent health action is to run the focused offline fixtures at the deployed
revision and confirm ordinary local watcher operation remains on its existing
runtime. MHF-14 owns integration; readiness and activation remain separately
reviewed work. Preserve origin-only publication/remediation/merge and the existing
cross-model convergence gate when that integration is built.
