# Data Model - AMA Closer Quota Snapshot

**Owner:** AMA closer harness resolver
**Store:** `<dispatch rootDir>/data/ama-closer-quota-snapshot.json`
**Source of truth:** `src/ama/harness-fallback.mjs`

A single best-effort snapshot records the latest successfully read and parsed
fleet quota payload. The dispatch owner supplies `rootDir`; direct callers
without a state root retain live-only resolution. No configuration key is added.

| Field | Shape | Contract |
|---|---|---|
| `readAt` | finite epoch milliseconds | Local time after the successful live read and parse. |
| `payload` | JSON object | Parsed quota status, preserving account, broker and provider evidence together. |

The existing atomic writer replaces the file with mode `0600`. Write failures
do not discard successful live evidence. Failed or malformed live reads consult
the snapshot only after bounded transport retries. Age must be non-negative and
strictly less than ten minutes at fallback time. Missing, corrupt, future-dated
and expired records are ignored. Cache reads do not renew `readAt`; malformed
live output does not overwrite the cache. Deleting the file simply restores
live-only resolution until the next successful read.

Resolver results expose `evidenceSource`, `evidenceAgeMs`, `evidenceReadAt`,
and, for cached use, `liveReadReason`. AMA dispatch persists these in
`harnessResolution` on both the audit document and its numbered attempt,
even when the selected worker class is unchanged.
