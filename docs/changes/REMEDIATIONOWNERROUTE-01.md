# REMEDIATIONOWNERROUTE-01

## Summary

Second-owner remediation publication holds now name the check that failed.
The remediation-publication broker mint was already owner-routed. The live
cause is that the broker does not return a token permission map, so the
`contents:write` check cannot pass. The companion agent-os broker change under
the same ticket echoes GitHub's granted `permissions` map in installation-token
metadata, which unblocks the check without weakening it. The SEV2 report lives
with that change.

## Interface changes

`remediation-owner-auth-hold` from `selectRemediationPushRoute` now has
`reason: "owner publication route: <check>"` instead of the single
"owner publication route unavailable or lacks permission". The checks are:
owner route config unavailable or incomplete, mint refused (HTTP status),
mint returned no token, PAT fallback, provider mismatch, unrouted (no owner
echo), owner mismatch, App id mismatch, installation mismatch, invalid
installation pin, minted token missing or expired, broker reported no token
permissions, missing `contents:write`, and missing `workflows:write`.
`BrokerTokenFetchError` carries a token-free `check` label for this. The
installation pin and permission checks are unchanged and still fail closed.
Hold code, owner, capability, custody and retry timing are unchanged.

The owner route config (routed owner, provider, App id, installation pin and
broker secret file) is now checked in JS, not in the worker-pool shell
snippet. A false `[[ ]]` does not trip `set -e` in bash 3.2, so the old shell
gate never ran on macOS hosts. There the routed owner went unchecked before
the mint, and a missing pin reported a different reason than on Linux. Both
hosts now report `owner route config incomplete or mismatched` for a missing
pin or a route prepared for another owner, and no broker request is made.

## Verification

The remediation-owner-auth suite has new synthetic cases. They cover the
owner-routed mint request (provider, owner query and owner installation pin),
an unchanged home-owner path, and one hold case per named refusal: missing
owner pin, route prepared for another owner, home installation, unrouted,
missing permission map, read-only `contents`, and missing `workflows`. The
route-for-another-owner case fails on the previous code. Every test file
importing the touched modules (remediation-owner-auth, reviewer-broker-refresh,
owner-token, publication, reviewer-context auth, watcher claim loop and auth
outage budget, daemon maintenance state, follow-up remediation) ran under the
network guard: 689 of 689 passed. ESLint on the touched files and
`npm run typecheck:contracts` passed.
