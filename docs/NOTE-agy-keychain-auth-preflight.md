# Antigravity (agy) Gemini reviewer — keychain auth preflight

The Antigravity Gemini reviewer (`reviewer.gemini.runtime=antigravity`)
authenticates `agy` from a macOS Keychain generic-password item: **service
`gemini`, account `antigravity`**. The adversarial-review watcher fails closed
unless the launchd-spawned reviewer process can read that item. This note
documents the probe the reviewer code constructs (`agyKeychainProbeArgs`),
because the daemon security context differs subtly from an interactive login
session — the distinction behind the 2026-06-22 → 2026-08-11 reviewer-auth
outage.

## The probe

The reviewer constructs its keychain probe as:

```bash
security find-generic-password -s gemini -a antigravity <resolved-keychain-path>
```

`<resolved-keychain-path>` is appended **only** when the runtime can resolve one.
Resolution order (`agyKeychainProbeArgs`):

1. `AGY_KEYCHAIN_PATH`, when set to a non-empty value.
2. `$HOME/Library/Keychains/login.keychain-db`, when `HOME` is set.
3. No keychain operand — delegates to the calling macOS security session's
   search list.

## Why the explicit path is load-bearing

A launchd security session's default search list **does not include the per-user
`airlock` login keychain**. So the bare probe (form 3) run from a daemon misses
the item even though it exists and is readable — while the *same* bare probe run
from an interactive login session **succeeds** (its search list includes the
login keychain). That makes the bare form a **misleading reproduction**: it can
disagree with the live daemon path.

From 2026-06-22 to 2026-08-11 the ambient-search-list form failed with this exact
signature while the item existed and was readable:

```text
security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.
```

**Reproduce daemon-side failures with the explicit final operand the watcher
derives** (form 1/2), run **as the runtime owner** so `$HOME` resolves to that
account — never the bare ambient-search-list form.

## The empty-operand trap

When `AGY_KEYCHAIN_PATH` may be unset, pass it conditionally:

```bash
security find-generic-password -s gemini -a antigravity ${AGY_KEYCHAIN_PATH:+"$AGY_KEYCHAIN_PATH"}
```

A bare `"$AGY_KEYCHAIN_PATH"` on an unset variable expands to `""`, which
`security` treats as a **literal keychain path** and fails with a search miss
instead of falling back to the session search list. This is the same
omit-when-empty rule `agyKeychainProbeArgs` follows. (Bootstrap scripts that
default `AGY_KEYCHAIN_PATH="${AGY_KEYCHAIN_PATH:-$HOME/Library/Keychains/login.keychain-db}"`
before use always hold a real path and may pass it unconditionally.)

## Operator knobs

- `AGY_KEYCHAIN_PATH` — explicit login-keychain target for the probe.
- `AGY_AUTH_PROBE_TIMEOUT_MS`, `AGY_AUTH_PROBE_MAX_ATTEMPTS`,
  `AGY_AUTH_PROBE_RETRY_BACKOFF_MS`, `AGY_AUTH_PROBE_SUCCESS_TTL_MS` — preflight
  timing / retry.
- `AGY_KEYCHAIN_BOOTSTRAP_SKIP_AGY_VERIFY=1` — the hourly bootstrap LaunchAgent
  sets this so a transient network failure in the advisory `agy --print` consumer
  check does not fail the timer. `AGY_KEYCHAIN_BOOTSTRAP_STRICT_AGY_VERIFY=1`
  makes that check fatal.

Operational recovery (login flow, PKCE callback, re-auth) lives in the operator
runbook `docs/RUNBOOK-antigravity-gemini-reviewer.md`.
