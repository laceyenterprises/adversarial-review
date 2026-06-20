# Antigravity Gemini Reviewer OAuth Bridge

This runbook covers the AGR-01 authentication bridge only. The bridge creates
and validates local Antigravity OAuth credentials for later Gemini reviewer
wiring; it does not route reviewer jobs by itself.

## Scope

- `bin/agr-auth.mjs` is the operator CLI.
- `src/auth/antigravity-bridge.mjs` owns PKCE login, refresh-token storage,
  access-token refresh, and credential validation.
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

- No reviewer runtime routing is enabled by AGR-01.
- No multi-account scheduler or rotation policy is enabled by AGR-01.
- No OAuth client secrets are committed to the repository.
