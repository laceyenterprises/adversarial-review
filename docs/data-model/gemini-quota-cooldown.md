# Data Model - Gemini Quota Cooldown

**Owner:** Gemini reviewer quota routing
**Store:** `data/gemini-quota-cooldown.json`
**Source of truth:** `src/gemini-quota-cooldown.mjs`
**Runtime surface:** `src/pollonce-phases.mjs`, `src/reviewer-spawn-settle.mjs`, `src/reviewer-quota-signal.mjs`

## Path and shape

The file lives under `resolveAdversarialReviewStateDir(rootDir, env)`: by default
`<rootDir>/data/gemini-quota-cooldown.json`, or directly under
`ADVERSARIAL_REVIEW_STATE_DIR` when configured. It contains one field:

| Field | Type | Meaning |
|---|---|---|
| `resetAt` | ISO-8601 string | Exclusive end of the provider-wide Gemini routing hold. |

`writeFileAtomic` writes the record using a unique temporary file, fsync and
rename. It contains no credentials or review text. This is provider routing
state, separate from per-PR quota/backoff and per-model OAuth outage state.

## Lifecycle and routing

Only an unsuccessful Gemini result with runtime-classified
`failureClass: quota-exhausted` starts the hold. The wrapper never classifies
quota from review stdout, stale-head output, or GitHub posting errors.
An existing active hold is retained without extending its expiry.

A valid future provider reset is used, capped at seven days from the write.
Absent, invalid or past resets use a 30-minute default;
`AGENT_OS_GEMINI_QUOTA_COOLDOWN_MS` sets a positive duration in milliseconds
for that default window. The override is also capped at seven days. Clamping
emits a warning; hold creation and expiry emit informational logs.

The watcher temporarily resolves Gemini mode to `off` during the hold and logs
`source=quota-cooldown resetAt=...`. The spawn wrapper also reads the store,
so an already-admitted Gemini route skips its checkout and uses its base route.
A quota failure may immediately try the base route using a new ledger attempt
number while preserving the logical review/remediation round and claim session.
Both paths check the fallback model's OAuth hold before dispatch. A held fallback
returns a quota hold, preserving both retry budgets. Settlement uses the actual
reviewer model, so fallback success/failure affects only its own credential state.

Expiry is checked on read and the expired file is removed. Missing, malformed,
or unreadable state returns no hold. No daemon must run for expiry to become
ineffective, and a watcher restart preserves an unexpired hold.

## Operator recovery

After verifying Gemini quota is available, remove the resolved
`gemini-quota-cooldown.json` file to clear the provider routing hold manually.
The next routing read resumes configured Gemini selection without a restart.
This does not reset per-PR quota holds or OAuth outage files; those retain their
own recovery procedures. See the [Gemini runtime runbook](../RUNBOOK-antigravity-gemini-reviewer.md#provider-wide-quota-cooldown).
