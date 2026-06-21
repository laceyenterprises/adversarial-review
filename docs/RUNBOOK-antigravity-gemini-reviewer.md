# Antigravity Gemini Reviewer Runtime

This runbook covers the Antigravity Gemini reviewer runtime. The live reviewer
path now delegates Antigravity auth and quota behavior to the `agy` CLI, which
uses the per-user macOS keychain item `Gemini Safe Storage`. The older AGR-01
file-backed OAuth bridge remains documented below only for legacy credential
maintenance; `reviewWithGemini(runtime=antigravity)` no longer selects bridge
accounts, injects per-account access tokens, marks rate limits, pages
all-capped account pools, or emits AGR-06 account telemetry.

## Scope

- `bin/agr-auth.mjs` is the operator CLI.
- `src/auth/antigravity-bridge.mjs` owns PKCE login, refresh-token storage,
  access-token refresh, and credential validation for the legacy file-backed
  bridge only.
- `reviewer.gemini.runtime` selects the Gemini reviewer runtime.
- `reviewer.gemini.runtime: antigravity` invokes `agy --print -m <model>` and
  feeds the review prompt on stdin.
- `src/agy-reviewer-auth.mjs` owns the fail-closed pre-flight: first
  `security find-generic-password -s "Gemini Safe Storage"`, then `agy models`.
  Both probes run with the same OAuth-scrubbed env used for the review spawn,
  so `GEMINI_API_KEY` and `GOOGLE_API_KEY` cannot satisfy the probe.
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

Before spawning a review, the runtime checks that the `Gemini Safe Storage`
keychain item exists and that `agy models` returns non-empty stdout. If either
probe fails, the reviewer fails closed with an OAuth error and the remediation
text points operators at the keychain partition-list fix.

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
