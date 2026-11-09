# MLR-13 — External custody observations and queue GSR

## Change notes

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
