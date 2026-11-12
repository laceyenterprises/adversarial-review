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
| `applied` | boolean or null | `true` means the PR label edit succeeded (or a release found the label absent). `false` means the PR edit was never spawned. `null` means the edit was spawned but its effect is uncertain, including a timeout or rejected command without success confirmation. Receipts written before NOMERGEHOLDHANG-01 lack it and were written only on success. |
| `error` | optional string | One-line attempt failure, including metering failure after a confirmed edit (`applied: true`). For example `timed out after 30000ms waiting for GitHub metering/budget admission before spawning \`gh label create\``. |
| `label` | string | `no-merge-hold`. |

A release that finds the label already absent counts as applied. Metering
failure after a successful PR edit exits 1 but preserves `applied: true` and
records the metering error. A successful repository-label creation alone never
proves that the PR hold was applied. For an uncertain spawned edit, the CLI
prints `applied=unknown`; inspect the live PR before relying on the requested
state. A late completion cannot rewrite the attempt's receipt.

If a receipt
cannot be written, the CLI exits 1 and says so on its failure line
(`receipt-write-failed=...`), with `applied=true` when the label change landed
anyway. No file exists in that case.
