# Reviewer workspace state

The hosted reviewer owns this local state under the workspace root described
in the [reviewer workspace runbook](../RUNBOOK-reviewer-workspace.md). It uses
this state for evidence cache accounting, harness startup and diagnostics.

`reviewer-workspace-audit/modes/<repo-key>.json` holds one record per normalized
GitHub repository name. The key uses the same sanitized name and digest recipe
as the snapshot cache. A per-key file lock serializes the updates and a rename
publishes the resulting JSON atomically. The fields are:

- `mode` is `snapshot` or `diff-only` for the last completed workspace setup.
- `cause` is null for a snapshot or one of `no-checkout`, `origin-unverified`,
  `head-fetch-failed`, `archive-unavailable`, and `escaping-link`.
- `diffOnlyCounts` contains a saturating cumulative counter for every allowed
  cause. Each successful workspace setup contributes at most one count.
- `operationalMode` follows the last setup unrelated to a PR-authored escaping
  link. It can be null until the first such setup.
- `lastAlertAtMs` is an epoch-millisecond timestamp or null. It records the
  last selected degradation notice for the 24-hour per-repo debounce.

The file is diagnostic. Read and write failures are logged and review gates
continue to use the current evidence. URL, credential and raw error text are
excluded from both the record and its notices.

The schema-2 `.reviewer-snapshot.json` marker within each cached archive has an
optional `treeBytes` field. It counts regular files and link lengths from the
link-validation traversal, excluding the marker. GC adds the marker's size
and uses a filesystem walk for legacy or invalid totals. GC never follows
links when calculating filesystem usage or removing a cache tree. Cache
pins are keyed by review owner PID and optionally `group-<pgid>` under
`.leases/<head-sha>/`. Unknown liveness keeps the pin.

An empty harness directory sits inside an owner-created `run-<pid>-<nonce>`
container. Control files are siblings of the actual `cwd`. A `pending-*` file
covers the spawn handoff, and a `group-<pgid>` file binds the detached harness
process group. The collector only reclaims a dead owner's container whose
registered groups are dead and whose contents match the expected layout.
