# Follow-up Daemon Status

Source of truth: `scripts/adversarial-follow-up-daemon.mjs` (`writeConfigSignatureStatus` and `writeFollowUpTickMetrics`). The reader is `src/review-pipeline-health.mjs`.

The daemon atomically writes `$HQ_ROOT/.adversarial-follow-up/config-status.json` on each tick. It contains:

| Field | Meaning |
| --- | --- |
| `algorithm` | `sha256` for both configuration signatures. |
| `loadedSignature` | Signature loaded by this daemon, or `null` until a successful load. |
| `diskSignature` | Current on-disk configuration signature. |
| `inSync` | `true` or `false` when a loaded signature exists; otherwise `null`. |
| `observedAt` | ISO timestamp of the latest signature check. |
| `driftSince` | First observed mismatch timestamp while drift continues, or `null` when in sync. |
| `daemon` | `adversarial-follow-up`. |
| `daemonStartedAt` | ISO timestamp identifying this daemon process; a different value resets prior consume metrics. |
| `expectedIntervalMs` | Configured daemon tick interval in milliseconds. |
| `lastConsumeAt` | ISO timestamp of the last consume pass, or `null` before any pass. |
| `consumeIntervalMs` | Milliseconds between consecutive consume passes in this daemon process, or `null` for the first pass and on a skipped tick. Skips do not reset the interval baseline. |
| `consumeSkippedReason` | `null` after an actual consume pass, or the reason the current tick deliberately skipped consume. |
| `tickDurationMs` | Duration of the latest completed tick in milliseconds, or `null` before completion. |
| `tickCompletedAt` | ISO timestamp of the latest completed tick; absent before the first completed tick. |

The health reader reports a consume gap over five minutes using the larger of the last completed consume interval and the time from `lastConsumeAt` (or `daemonStartedAt` before the first consume) to `observedAt`. This includes repeated deliberate skips; the skip reason appears in the finding evidence. A restart resets the in-process interval baseline and clears the prior process's consume timestamp. A stale or missing status file is handled by the separate daemon-status finding.
