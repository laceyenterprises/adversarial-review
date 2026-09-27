# Data Model - Archive Anomalies

**Owner:** Follow-up archive and terminal workspace maintenance
**Store:** `data/archive-anomalies/`
**Source of truth:** `src/follow-up-jobs.mjs`, `src/follow-up-workspace-trash-delete.mjs`

## Purpose

One JSON file records each archive collision or failed terminal workspace
cleanup for operator follow-up. Writers allocate distinct filenames; records
are not overwritten on retry. Workspace deletion also has a fallback JSONL
file in the sibling workspace trash directory when this store cannot be written.

## Terminal workspace failure records

| Field | Shape | Contract |
|---|---|---|
| `ts` | ISO-8601 string | Failure observation time. |
| `type` | string | `terminal-workspace-reap-permission-denied` for `EACCES`/`EPERM`; `terminal-workspace-trash-delete-failed` for other background deletion failures. |
| `name` | string | Original workspace job ID. |
| `workspacePath` | string or null | Original workspace path; available for normal daemon launches. |
| `trashPath` | string, background failures only | Entry still awaiting deletion in sibling trash. |
| `hqRoot` | string | Runtime `HQ_ROOT`, or `(unset)`. |
| `runtime` | object | User name and numeric UID when available. |
| `error` | object | Error `code` and `message`. |
| `workspace` | object or null | Root entry UID, GID, mode, ownership comparison, or stat error. |
| `action` | string | `left-workspace-in-place` for failed moves; `left-workspace-in-trash` for failed recursive deletion. |

The daemon writes move failures directly. The detached deleter receives the
archive root and original workspace root from the daemon, then writes delete
failures. It leaves failed trash entries for the next sweep and continues with
other entries. If archive anomaly writing fails, it appends the same record
plus `anomalyWriteError` to `<trash-dir>/delete-failures.jsonl`.
