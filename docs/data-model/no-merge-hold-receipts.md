# Data Model - No-Merge Hold Receipts

**Owner:** operator no-merge hold CLI
**Store:** `data/operator-mutations/no-merge-holds/<repo>-pr-<n>-<requestedAt>.json`
**Source of truth:** `src/no-merge-hold.mjs`

## Purpose

`npm run no-merge:hold` (`node src/no-merge-hold.mjs`) applies or releases the
`no-merge-hold` label on one PR. Each attempt writes one receipt so the
operator mutation is auditable, whether or not it took effect. `<repo>` and
`<requestedAt>` are sanitized to `[A-Za-z0-9_.-]`. Writes are atomic
(`writeFileAtomic`). There is no TTL or pruning, and no code reads the
receipts: they are an audit trail.

## Schema (`schemaVersion: 1`)

| Field | Type | Contract |
|---|---|---|
| `kind` | string | Always `adversarial-review-no-merge-hold`. |
| `schemaVersion` | integer | `1`. The `applied` and `error` fields are additive. |
| `requestedAt` | ISO string | When the attempt started. Also keys the file name. |
| `requestedBy` | string | `$USER`, `$LOGNAME`, or `operator`. |
| `reason` | string | Operator reason, or the default hold/release text. |
| `repo` | string | `owner/repo`. |
| `prNumber` | integer | PR number. |
| `held` | boolean | The **requested** state: `true` for a hold, `false` for `--resume`/`--release`. |
| `applied` | boolean | Whether the label change took effect. `false` means the attempt failed. Receipts written before NOMERGEHOLDHANG-01 lack it and were written only on success. |
| `error` | string, only when `applied` is `false` | One-line failure, for example `timed out after 30000ms waiting for GitHub metering/budget admission before spawning \`gh label create\``. |
| `label` | string | `no-merge-hold`. |

A release that finds the label already absent counts as applied. If a receipt
cannot be written, the CLI exits 1 and says so on its failure line
(`receipt-write-failed=...`), with `applied=true` when the label change landed
anyway. No file exists in that case.
