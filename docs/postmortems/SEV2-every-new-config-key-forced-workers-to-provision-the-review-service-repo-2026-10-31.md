# SEV2: new shared configuration keys forced unrelated review-service changes

Date: 2026-10-31
Ticket: CFGREADERSCOPE-01
Severity: SEV2
scars: config-schema.multi-loader-parity

## Impact

Changes owned by other configuration consumers repeatedly needed a companion
review-service checkout, schema patch and publication. Four of six repository
requests in the observed sample were for schema mirroring. This consumed worker
sessions, delayed otherwise unrelated work and created avoidable provisioning
requests. A rejected shared configuration could also prevent a review daemon
from starting.

This public report describes the mechanism generically. Its examples and tests
use synthetic configuration; it contains no host configuration or private
operational correspondence.

## Cause

Several readers share a configuration overlay. The review service already
tolerated some foreign roots and local overrides, but checked-in files remained
strict within shared namespaces. Recognizing `worker_pool` therefore made an
unrelated new child a fatal schema error.

The existing parity tooling reinforced this coupling by requiring whole
namespaces to be accepted by the startup reader. The historical
`config-schema.multi-loader-parity` remedy required duplicating every key across
readers. That prevented individual crashes while making unrelated consumers
depend on coordinated schema releases.

## Correction

Startup and runtime Node loads now ignore unregistered sibling-reader keys at
every depth, in module, top-level and local files. Ignored paths emit a note only
with configuration debugging enabled. Registered values retain their existing
type, range and allowlist checks. Consumed atomic policies and declarations
retain their complete strict shape.

The existing parity harness uses the Node runtime projection over the complete
shared input, checking supported shared keys without demanding a mirror for
unread additions. The authoritative Python reader still validates its schema.
No CI job, trigger, label or gate was added.

The scar's prevention rule is refined: a companion edit is required when another
reader actually begins supporting a shared key, or changes a consumed atomic
declaration. An unrelated producer addition alone requires no review-service
schema patch. Historical incidents involving missing consumed enums, invalid
values or loader-runtime prerequisites remain applicable.

## Verification and recovery

Offline regression tests cover previously unseen `worker_pool` keys in each
overlay layer, silent default logging, opt-in debug logging, and rejection of
invalid reviewer types and allowlist values. Updated parity tests exercise a
Python-only addition and preserve rejection coverage for shared known values.

Publish the reader and parity changes through their respective repositories and
normal deployment path. No migration, live configuration edit or daemon restart
was performed by this change.

The live acceptance receipt remains pending: observe the next natural ticket
adding a `worker_pool.*` key and confirm that it completes without requesting a
review-service repository solely for schema mirroring. Passing synthetic tests
does not establish that production receipt.
