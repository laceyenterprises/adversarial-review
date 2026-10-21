# Reviewer token lease recovery and enrollment

**Source of truth:** `src/reviewer-token-leases.mjs` and
`src/reviewer-token-pool.mjs`; recovery is driven by
`src/reviewer-reattach.mjs`. Broker state remains owned by Agent OS, not this store.

## Acquisition/retry journal

Store: `data/reviewer-token-leases/<sessionUuid>.json`, rooted at the watcher
checkout explicitly on startup and periodic recovery. Atomic, fsynced writes.

Each entry is `{ version: 1, sessionUuid, identity, createdAt, lease, pgid }`.
`identity` is `claude-reviewer` or `codex-reviewer`; `createdAt` is local ISO time
of the first intent. `lease` starts null, then stores only the broker fence
`{ account_id, lease_id, generation }`; unvalidated extension fields and token
bytes are never persisted. `pgid` starts null and is updated on spawn/recovery.
The file's existence is retry ownership; there is no TTL deletion.

Admission writes intent before acquire. Node journals any returned fence before
validating the wire response; rejected responses release best-effort. Python
serialization failures also attempt release. A timeout, oversized output or lost
response leaves the intent. The broker diagnostics owner recovers the original
receipt by request ID plus identity, including overdue active slots; it never
reselects an account or acquires a replacement lease.

The recovery sweep runs even with no reviewing rows, before capped stale-row
reconciliation, using at most four owner transports concurrently. Existing
run-record receipts seed journals for compatibility. Locally executing dispatches
use their renewal timer; other journals probe PGID and, on absence/death, session
UUID. Missing PGIDs get a 60-second launch grace. Unknown probes retain recovery
ownership. Live processes renew the original fence; confirmed absence releases.
Terminal/corrupt/missing run records and terminal delivery rows do not hide the
journal. A kill request alone cannot release a live group. Failures warn and keep
the entry; a failed fence operation clears the cached fence so the next sweep
re-reads broker diagnostics. Positive release acknowledgement (or diagnostics
confirming no active request) removes the entry. Unreadable journal entries warn
for operator inspection and are not deleted. Operators should restore valid
journal/process evidence before any manual release; expiry alone is insufficient.

## Last-good reviewer enrollment

Store: `data/reviewer-pool-declarations.json`, written by
`selectReviewerTokenAccount` after a successful declaration read. Shape:
`{ identities: [<declared Claude/Codex reviewer role IDs>] }`. It contains no
account descriptors or secrets. Updates are atomic and survive restarts.

An unrelated configuration error logs identity and `routing=legacy|hold`.
Roles absent at the last good read (including never enrolled) retain legacy
routing; previously declared roles hold with `pool-configuration-unreadable`.
Unreadable/corrupt enrollment evidence holds conservatively. Successful reads
replace the enrollment list; removing a pool intentionally restores legacy
routing. Holds release the delivery claim and use existing cascade backoff without
charging attempts. This adds no SQL field or reviewer runtime state.
