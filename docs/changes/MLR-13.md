# MLR-13 — External custody observations and queue GSR

## Summary

Agent OS source transactions retain lifecycle facts until the existing
finalization append API returns a committed, source-keyed receipt. The thin
`custody-ingest.mjs --root DIR` event bridge accepts one observation on stdin.
`launch_custody_observed` preserves original time, repository/PR/head, launch
family, admission reasons, run/launch scope and workspace evidence. Replaying
a lost receipt appends once. Expired evidence projects unknown; no owner or
closure decision is added.

`queue-gsr.mjs status|steer|drain|resume ROOT [TOKEN]` is the existing GSR
host's queue boundary. Status and steer are read-only. Drain records one
original maintenance token in the app store; claims and issuance respect it.
In-flight or ambiguous requests remain in MGQ's operation ledger and block
the existing host merge guard. Resume releases only the matching token,
preserving every candidate, deadline, readiness sequence and route generation.
Cold queues are covered before a future lane can start.

Deploy with the Agent OS MLR-13 producer, migrate/reload actual writers through
the registered SRE path, and retain read-only loaded-build and organic append
receipts for MLR-08. MGQ-10 lane ownership/retirement and rollback boundaries
remain authoritative. The canary owner must retain the separately authorized
GSR rehearsal receipt. No live drain, restart, route flip or canary is performed
or authorized by this worker PR.

Offline acceptance: custody (3), event vocabulary (10), ledger store (9),
queue ownership (23) and GSR (4) tests passed individually; contract type
checking passed. Thirty forced post-drain continuations issued in 30/30
trials on the original owner and 0/30 on the changed owner. Unknown operation
intent survives drain/resume and a cold queue is held before lane creation.
These deterministic schedules exercise the exclusion boundary; they are
not a live drain rehearsal.

## Interface changes

The custody and queue GSR CLIs include the underlying error message on stderr.
`custodyFreshness` returns an unknown, non-fresh projection for inputs without
custody data. Queue hold reads reuse a prepared statement while observing
current hold state on every call. Persistent shapes and lifecycle states are
unchanged.

Final remediation removes the ticket narrative from the root README and
clarifies that the state manifest includes operational verification records.
The ledger documentation describes the missing-custody projection.

## Verification

Final remediation passed 52 targeted offline tests across
`finalization-custody`, `finalization-queue-gsr`, `finalization-queue-owner`,
`finalization-ledger-events` and `finalization-ledger-store` using
`node --test test/<name>.test.mjs` for those five files. This includes CLI
stderr diagnostics, absent-custody projections and 30 forced post-drain
continuations with zero remote invocations.

`npm run lint` passed with zero errors (152 existing warnings);
`npm run typecheck:contracts`, `bash demo/research-finding-walkthrough.sh`,
`node scripts/validate-data-model-catalog.mjs` (91 entries) and
`git diff --check` passed. The full suite is left to PR-head CI.


## Further review remediation

Custody ingestion resolves the app root, checks store ownership and requires an
existing database. Reused keys with different custody content refuse the receipt.
Unknown custody payloads remain readable without becoming eligibility or freshness
evidence. Queue merge currency excludes custody observations; eligibility changes
still invalidate an evaluated decision. GSR exposes accepted/released receipts,
nonzero token-refusal exits and truthful missing-store status.

Rebased onto current trunk, retaining its timeout stderr regression separately
from the GSR tests and preserving both lifecycle declarations and README text.
The Agent OS producer is in the superproject; no local producer docs were invented.

Verification: 102 targeted tests passed across custody, GSR, queue merge,
ledger fold/store/events, queue owner and CLI timeout stderr suites. Commands:
`node --test test/finalization-{custody,queue-gsr,queue-merge,ledger-fold,ledger-store,ledger-events,queue-owner,cli-timeout-stderr}.test.mjs`
(run in bounded groups); `npm run lint` (zero errors, existing warnings),
`npm run typecheck:contracts`, `node scripts/validate-data-model-catalog.mjs`
(93 entries), `bash demo/research-finding-walkthrough.sh` (byte-stable), and
`git diff --check` passed. The full local suite was not run per worker rules.
