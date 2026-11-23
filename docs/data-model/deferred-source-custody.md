# Deferred closer source custody

**Owner:** Hammer validation and the watcher

**Store:** `<HQ_ROOT>/dispatch/audit/deferred-source-custody/<owner>/<repo>/pr-<number>/<target-head>/`

**Source:** `src/ama/deferred-source-custody.mjs`

`hold.json` is a private, atomically created, schema-version-1 marker. It names
the repository, PR, target head, original dispatch head, exact local source head,
validation base, launch and run IDs, original checkout, initial runner and file
selection, exact-head checkout cleanliness, and private `attempt-*` evidence
directory. Controlled validation also names the owning controller registration.
The marker blocks a successor even if the validator died while writing evidence.

| Attempt artifact | Contents |
|---|---|
| `source.json` | `matches-target`, `bundled`, `local-ref-only` or `workspace-only`. `bundled` records the private Git ref, bundle name and selected prerequisite SHAs. |
| `source.bundle` | Incremental Git bundle of the original unpublished commit. `source.json` is written after checking the advertised object. Recover on a checkout with the prerequisite commits. |
| `deferred.json` | Exact source head, UNKNOWN reason and original exit status, recorded local failure, and any proof for CI-authoritative continuation. |
| `validation.json`, `*.check-*.log` | Independent copy of the exact-head check receipt and available bounded diagnostics. Paths in the copied receipt are relative to this attempt. |
| `bounded-cleanup.json` | Standalone bounded runner's actual cleanup verdict, status, reason and launch/head identity. |
| `controller-cleanup.json` | Final matching controller registration with drain and lease disposition. Its absence leaves cleanup unconfirmed. |

An incomplete bundle retains the original workspace for recovery. Missing
cleanup proof is UNKNOWN. The watcher deduplicates its operator decision
notification through the existing closure-wait store. The close controller
and conflict repair also respect holds. Source custody grants zero publication,
provenance, review, validation or merge authority.

The operator keeps the package for diagnosis and recovery under the existing
protected HQ audit namespace after run scratch and the worker are reclaimed.
A replacement live head does not delete historical custody. See the
[closure runbook](../RUNBOOK-ama-closure.md) for operator recovery and same-head
release.
