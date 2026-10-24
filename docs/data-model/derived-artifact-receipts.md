# Derived artifact receipts (LAC-2101)

Owner: canonical AMA daemon data owner. Store:
`<runtime rootDir>/data/derived-artifact-receipts/<sha256>.json`.
Source: `src/ama/derived-artifact-receipt.mjs`; registration:
`bin/derived-artifact-receipt.mjs`; consumer: `src/ama/derived-artifacts.mjs`.

This is explicit, local owner consent to a fixed reproducibility recipe for one
legacy artifact rebuild. It is not a successful proof, author declaration,
review verdict, merge approval or removal allowance. Repository content, workers,
CI output and HAM trailers cannot register authority in the daemon owner's store.
The existing deployment boundary must keep the daemon root unwritable by workers.
If workers share that principal, this file store does not create a new principal
boundary; use a separately protected canonical owner before enabling registration.

Version 1 fields:

| Fields | Meaning |
|---|---|
| `version`, `recipe` | `1`, `npm-pack-ignore-scripts-v1`; no other recipe or command accepted |
| `repo`, `prNumber` | Exact repository and positive numeric PR |
| `primaryHead`, `headSha`, `mergeBase` | Immutable protected author, candidate and comparison base |
| `path`, `primaryBlob`, `blob` | Exact archive path and original/final Git blob SHAs |
| `review`, `reviewedHead`, `finding`, `kind` | Review node ID or URL, its immutable head, one-based finding and `blocking`/`non-blocking` section |
| `rationale` | Required owner explanation of why this finding requires this archive rebuild (maximum 2,000 characters) |
| `registeredAt` | UTC registration time set by the registration tool |

The filename hashes the JSON array of `repo`, numeric `prNumber`, `primaryHead`,
`headSha`, `mergeBase`, `path`, `primaryBlob`, `blob`, in that order. Registration
atomically replaces one identity through an exclusive `0600` temporary file.
Unknown fields are rejected. Root, data directory, store and records must belong
to the caller's effective UID, have no group/world write permission, and contain
no symlink at these boundaries. Reads also check the opened descriptor, regular
file type, a 16 KiB limit and a seven-day age limit; future/invalid dates refuse.
Owner registration does not execute code or modify a repository or queue.

Every gate reads the receipt afresh outside the primary-history cache. It verifies
the binding, reads the complete live PR review list, verifies authoritative family,
ancestry and currency, and verifies that the named finding still exists. Blocking
citations require Request changes; non-blocking citations require the effective
strict-remediation policy. The owner supplies the specific finding-to-package
relationship; the collector never infers that relationship from arbitrary prose.
Missing, superseded, foreign, oversized or unreadable evidence supplies no proof.

Only a conventional manifest-local npm tarball, whose filename matches the head
manifest's package name and version, qualifies. The collector removes the output
and runs its fixed `npm pack --ignore-scripts --offline` command with the existing
sanitized, network-denied OS sandbox and immutable, hash-verified head package
sources. Receipt-only candidates materialize the union of their package subtrees,
so unrelated repository symlinks/submodules do not block packing. Those inside
a package still refuse. Mixed receipt/declaration candidates retain the existing
whole-tree materialization and refusal rules.
It does not run a branch script, generator or lifecycle hook. A successful rebuild
must match the final Git blob exactly. Same-path added/modified status is required;
deletions, renames, source reversals and unrelated changes remain protected.
All existing process, source, output and candidate limits still apply.

Returned `derivedArtifacts` proofs additionally record `recipe`, `mergeBase`, `receipt` (the
receipt identity digest), `review`, `finding`, and `kind`. They are transient and
recomputed on each gate read, including under lease; success is never stored in
the receipt or history cache. The evaluator also rechecks the receipt proof's
merge base and effective non-blocking policy. Missing sandbox support retains the opaque refusal.
Owners may revoke a receipt by removing its exact file. Expired files are ignored;
there is no automatic cleanup job or retry/dispatch mechanism.

Receipt ancestry checks use the history reader metadata projection when available, under the same abort and total proof deadline as other reads. Readers without that projection retain the bounded full-reader fallback. No receipt authority or expiry rule changes.
