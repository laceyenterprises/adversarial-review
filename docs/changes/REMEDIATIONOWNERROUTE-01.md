# REMEDIATIONOWNERROUTE-01

## Summary

Second-owner remediation publication holds now name the check that failed.
The remediation-publication broker mint was already owner-routed. The live
cause is that the broker does not return a token permission map, so the
`contents:write` check cannot pass. See the
[SEV2 report](../postmortems/SEV2-REMEDIATIONOWNERROUTE-01-second-owner-remediation-could-not-publish-2026-11-20.md).

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

## Verification

The remediation-owner-auth suite has new synthetic cases. They cover the
owner-routed mint request (provider, owner query and owner installation pin),
an unchanged home-owner path, and one hold case per named refusal: home
installation, unrouted, missing permission map, read-only `contents`, and
missing `workflows`. With the broker-refresh, owner-token and publication
suites, it ran under the network guard with `--test-concurrency=2`. 58 of 59
passed. The one failure is
`REMEDBRANCH-01: a branchless publisher resolves the fake PR head`, which fails
the same way on the unchanged base. ESLint on the touched files and
`npm run typecheck:contracts` passed.
