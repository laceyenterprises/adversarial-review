# Corporate Claude quota cooldown

Source: `src/claude-account-routing.mjs`, `src/reviewer-spawn-settle.mjs`, and
`src/pollonce-phases.mjs`.

`data/claude-corporate-quota-cooldown.json` lives under the resolved review state
directory. It contains `{ "resetAt": "<ISO timestamp>" }`. Only typed
`quota-exhausted` results from a corporate Claude reviewer runtime write it,
atomically and before reviewer capacity is released. Other accounts and failure
classes do not write this record.

A future reset blocks corporate reviewer selection and permits primary selection
only with independent fresh primary quota and broker evidence. Missing,
unreadable, malformed or expired records preserve fleet-based selection. The
provider reset is preferred; absent or past resets use 15 minutes. Holds are
bounded to seven days. Expired records need no cleanup to stop applying.

The file supplies account-local exhaustion evidence when fleet quota polling
lags a spawn. It grants neither reviewer seats nor permission to bypass stale
quota evidence, writer diversity, current-head deduplication, or claim CAS.
