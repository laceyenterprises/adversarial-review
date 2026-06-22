# Antigravity Gemini Reviewer Runtime

This runbook covers the Antigravity Gemini reviewer runtime. The live reviewer
path now delegates Antigravity auth and quota behavior to the `agy` CLI, which
uses the per-user macOS keychain generic-password item service `gemini`, account
`antigravity`. The older AGR-01 file-backed OAuth bridge remains documented
below only for legacy credential maintenance; `reviewWithGemini(runtime=antigravity)`
no longer selects bridge accounts, injects per-account access tokens, marks
rate limits, pages all-capped account pools, or emits AGR-06 account telemetry.

## Scope

- `bin/agr-auth.mjs` is the operator CLI.
- `src/auth/antigravity-bridge.mjs` owns PKCE login, refresh-token storage,
  access-token refresh, and credential validation for the legacy file-backed
  bridge only.
- `reviewer.gemini.runtime` selects the Gemini reviewer runtime.
- `reviewer.gemini.runtime: antigravity` invokes
  `agy --print --print-timeout <N> -m <model>` and feeds the review prompt on
  stdin. The print timeout is controlled independently by
  `reviewer.gemini.agy_print_timeout_ms` (env:
  `AGENT_OS_REVIEWER_GEMINI_AGY_PRINT_TIMEOUT_MS`; compatibility aliases:
  `ADVERSARIAL_REVIEWER_AGY_PRINT_TIMEOUT_MS`, `AGY_PRINT_TIMEOUT_MS`) so
  operators can raise Antigravity headroom without changing Claude/Codex
  review budgets. The reviewer subprocess timeout is kept at least as large as
  the AGY print timeout so the wrapper does not kill `agy` before its own
  print wait expires.
- `src/agy-reviewer-auth.mjs` owns the fail-closed pre-flight: first
  `security find-generic-password -s gemini -a antigravity`, then `agy models`.
  Both probes run with the same OAuth-scrubbed env used for the review spawn,
  so `GEMINI_API_KEY` and `GOOGLE_API_KEY` cannot satisfy the probe. The
  default probe timeout is 5s. Timeout-shaped keychain probe failures and
  transient `agy models` transport failures are retried with bounded backoff
  before surfacing an OAuth failure; definitive missing-keychain and
  non-transient probe failures still fail closed immediately. Watcher startup
  runs the same probe as a warning-only visibility check when the runtime is
  `antigravity`, and successful real probes are cached briefly in the process
  that performs the check.
- `agy` may leave a language-server descendant alive after the direct command
  exits, with that descendant still holding inherited stdout/stderr pipes. The
  auth preflight therefore runs `agy models` in a detached process group and
  treats main-process exit as authoritative: after the direct `agy` process
  exits, the runtime kills the group, drains already-buffered stdout/stderr
  until close, and reports the direct process's real output/status instead of a
  synthetic timeout. The live reviewer spawn uses the same contract for
  `agy --print -m <model>` via process-group reaping. Killing descendants is
  safe only for these dedicated AGY probe/review groups after the direct process
  has exited, or when the configured timeout/max-buffer guard has fired.
- Quota and rate-limit handling for the live Antigravity reviewer is whatever
  `agy` returns to the subprocess. The old bridge-level hold decision,
  all-capped page, and per-account rate-limit marking are retired for this
  runtime path.
- Credential validity is asserted by direct JSON file read, schema validation,
  and file-mode checks only when an operator explicitly uses the legacy bridge
  CLI. The live reviewer path does not consume these files.

## Configuration

Set OAuth client configuration at runtime:

```bash
export GEMINI_ANTIGRAVITY_CLIENT_ID='<oauth-client-id>'
export GEMINI_ANTIGRAVITY_CLIENT_SECRET='<oauth-client-secret>'
```

Credential files default to:

```text
~/.gemini/antigravity-bridge/<account-id>.json
```

Override the credential directory with:

```bash
export GEMINI_ANTIGRAVITY_BRIDGE_DIR=/path/to/private/bridge-dir
```

The directory must be mode `0700`. Credential files must be mode `0600`.
Reads reject looser permissions before parsing credential JSON.

### Runtime Selection

The Gemini reviewer defaults to the direct Gemini CLI runtime:

```yaml
reviewer:
  gemini:
    runtime: cli
```

Select the Antigravity runtime:

```yaml
reviewer:
  gemini:
    runtime: antigravity
```

Before spawning a review, the runtime checks that the `gemini`/`antigravity`
keychain item exists and that `agy models` returns non-empty stdout. Transient
timeouts and `agy models` network/transport blips are retried before
escalation. The keychain existence probe is only the fast-path for a truly
absent item; `agy models` is the authoritative readability/ACL check. If the
keychain item is definitively missing, `agy models` returns empty output, or a
non-transient probe failure persists, the reviewer fails closed with an OAuth
error and remediation text matched to the failed probe class.

If `agy models` or `agy --print` appears to return useful output but the caller
hangs until timeout, suspect the inherited-pipe language-server failure mode
first. Do not replace the runtime helper with `execFile`, command substitution,
or another capture primitive that waits for pipe EOF from all descendants. The
expected diagnostic shape after the fix is the direct `agy` result: successful
model output, a normal non-zero `agy` failure, `agy-probe-empty`, or the
configured timeout/max-buffer guard. A recurring `agy-probe-timeout` after the
group-reaping path usually means the direct `agy` process itself failed to exit
inside `AGY_AUTH_PROBE_TIMEOUT_MS`, not merely that an orphaned language server
kept the pipes open.

Troubleshooting logs and remediation surfaces report the probed keychain item as
`keychainItem: gemini/antigravity`. Search for that composite value when
diagnosing an Antigravity reviewer auth failure; the older `Gemini Safe Storage`
item belongs to the desktop app path and is not the live `agy` selector.

Watcher startup also runs this probe when `runtime: antigravity` is configured.
Startup logs a warning on failure rather than refusing to boot; the per-review
probe remains fail-closed. Startup visibility is not a cross-process cache
warmup for reviewer subprocesses. Successful real preflights may be cached
briefly in the process performing the probe; `agy --print` remains the
authoritative reviewer invocation and still fails closed if credential state is
lost inside that short TTL.

Probe knobs:

```bash
export AGY_AUTH_PROBE_TIMEOUT_MS=5000
export AGY_AUTH_PROBE_MAX_ATTEMPTS=3
export AGY_AUTH_PROBE_RETRY_BACKOFF_MS=250
export AGY_AUTH_PROBE_SUCCESS_TTL_MS=60000
```

Env aliases:

```bash
export AGENT_OS_REVIEWER_GEMINI_RUNTIME=antigravity
```

Legacy aliases are also accepted:

```bash
export ADVERSARIAL_REVIEW_GEMINI_RUNTIME=antigravity
```

The historical `reviewer.gemini.antigravity.accounts[]` config remains parsed
for compatibility with older modules, but the live `agy` runtime does not use
it for reviewer dispatch.

## Output Guard And Timeout Behavior

`agy --print` does not expose a quiet, JSON, or final-message-only flag. In
agentic mode it can print planning/tool narration before the final answer. The
bad failure shape seen on PR #2435 was two concatenated attempts under the
Gemini review heading, each made of "I will..." exploration text, one ending in
`Error: timed out waiting for response`, and neither containing `## Verdict`.

The reviewer therefore validates captured AGY output before posting:

- a body must contain a parseable `## Verdict` section that normalizes to
  `Comment only`, `Request changes`, or `Approve`/`Approved`
- narration-only output, `Error: timed out waiting for response`, other AGY
  error sentinel lines, and unparseable bodies raise reviewer failure instead
  of posting a GitHub review
- when a valid review block is preceded by narration, only the review block
  from the review heading or first real `##` section is posted
- inline verdict headings such as `## Verdict: Comment only` are normalized to
  the downstream parser's canonical two-line form before posting

This is intentionally the same operational class as a Claude/Codex subprocess
failure before posting a verdict: the watcher retry and attempt-budget handling
owns recovery, and operators diagnose the failed reviewer attempt rather than
cleaning up a garbage PR review.

The review command's `--print-timeout` is sized from
`reviewer.gemini.agy_print_timeout_ms`. The default is 1,170,000 ms, so AGY
receives `--print-timeout 1170s` while the shared reviewer timeout remains 20
minutes. Raise the AGY-specific key when Antigravity needs more headroom; do
not raise `reviewer.timeout_ms` unless all reviewer subprocesses need a larger
budget.

## Login

```bash
agr-auth login <account-id> [--project-id <project-id>]
```

The CLI starts a local OAuth callback listener on:

```text
http://localhost:51121/oauth-callback
```

The browser is opened only after the listener reports ready. If the port is
already in use, login fails with `CALLBACK_SERVER_FAILED` and the message names
the occupied callback port.

The stored file schema is:

```json
{
  "email": "user@example.com",
  "refreshToken": "<redacted-refresh-token>",
  "projectId": "optional-project-id"
}
```

## Status

```bash
agr-auth status [account-id]
agr-auth status [account-id] --check-token
```

Default status is read-only: it checks credential presence, JSON schema, and
permissions without refreshing or rotating tokens. Use `--check-token` when an
operator intentionally wants a live refresh-token check.

Without an account id, `status` lists all valid credential files in the bridge
directory and ignores unrelated files.

## Refresh Rotation

`getAccessToken(accountId)` serializes refreshes per credential path:

- in-process callers share one in-flight refresh promise;
- cross-process refreshes use a bounded lock file beside the credential file;
- rotated refresh tokens are persisted with a private temp file plus rename;
- if a rotated refresh token cannot be persisted, the fresh access token is
  still returned and a warning hook or process warning records the persistence
  failure.

If status or reviewer wiring reports `REFRESH_TOKEN_EXPIRED`, re-run login for
that account id. Do not hand-edit refresh tokens.

## Current Non-Goals

- No multi-account scheduler, rotation policy, all-capped hold decision, or
  AGR-06 account telemetry is enabled for the live `agy` runtime.
- No OAuth client secrets are committed to the repository.
