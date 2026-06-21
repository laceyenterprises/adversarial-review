# Antigravity Gemini Reviewer OAuth Bridge

This runbook covers the AGR-01 authentication bridge and the AGR-04 Gemini
reviewer runtime/account-pool configuration. The bridge creates and validates
local Antigravity OAuth credentials; AGR-04 lets operators select the
Antigravity Gemini runtime and declare the ordered account pool it may use.

## Scope

- `bin/agr-auth.mjs` is the operator CLI.
- `src/auth/antigravity-bridge.mjs` owns PKCE login, refresh-token storage,
  access-token refresh, and credential validation.
- `reviewer.gemini.runtime` selects the Gemini reviewer runtime.
- `reviewer.gemini.antigravity.accounts[]` declares the ordered Antigravity
  account pool for the Gemini reviewer.
- Credential validity is asserted by direct JSON file read, schema validation,
  and file-mode checks. The bridge does not call `agy`, macOS Keychain, or any
  Antigravity CLI probe.

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

### Runtime Selection & Account Pool

The Gemini reviewer defaults to the direct Gemini CLI runtime:

```yaml
reviewer:
  gemini:
    runtime: cli
```

Select the Antigravity runtime with at least one ordered account entry:

```yaml
reviewer:
  gemini:
    runtime: antigravity
    antigravity:
      accounts:
        - id: primary
          tokenFile: op://Cliovault/GEMINI_ANTIGRAVITY_PRIMARY/token
        - id: backup
          tokenFile: /Users/airlock/.gemini/antigravity-bridge/backup.json
```

`tokenFile` may be a literal filesystem path or an `op://` secret reference
resolved by the launch wrapper. It is validated as metadata by this module; do
not inline token contents in YAML or env values.

Env aliases:

```bash
export AGENT_OS_REVIEWER_GEMINI_RUNTIME=antigravity
export AGENT_OS_REVIEWER_GEMINI_ANTIGRAVITY_ACCOUNTS='[{"id":"primary","tokenFile":"op://Cliovault/GEMINI_ANTIGRAVITY_PRIMARY/token"}]'
```

Legacy aliases are also accepted:

```bash
export ADVERSARIAL_REVIEW_GEMINI_RUNTIME=antigravity
export ADVERSARIAL_REVIEW_GEMINI_ANTIGRAVITY_ACCOUNTS='[{"id":"primary","tokenFile":"/path/to/oauth.json"}]'
```

Watcher boot fails closed when `runtime: antigravity` has no account entries:
`reviewer.gemini.runtime=antigravity requires at least one
reviewer.gemini.antigravity.accounts[] entry`.

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

- No multi-account scheduler or rotation policy is enabled by AGR-04; the
  configured list is an ordered account pool.
- No OAuth client secrets are committed to the repository.
