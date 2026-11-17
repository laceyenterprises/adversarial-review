# LXS-02 — Relay CFG reader parity

Spec: `lacey-studio@2e0c25ed669c`.

A focused offline regression verifies that the Node reader ignores Python-owned
`app_relay.apps` in checked-in and local configuration, through strict and
runtime loaders. Existing reader scoping already provides this behavior; no
production loader change or new configuration/environment variable is needed
in this repository. The daemon and authoritative schema ship in Agent OS.

## Summary

The relay regression compares each loader's resolved values with a relay-free
baseline, checks the nested `app_relay.apps` lookup, and covers local overrides
both with and without `version: 1`. Its nested-array fixture complements generic
unknown-root coverage.

## Interface changes

None.

## Verification

`node bin/hammer-validate.mjs --canonical -- test/config-loader-foreign-sections.test.mjs docs/changes/LXS-02.md`
passed all 7 targeted tests. `npm run lint` passed with 0 errors (149 existing
warnings); `npm run typecheck:contracts` and
`bash demo/research-finding-walkthrough.sh` passed. The full suite is delegated
to exact-head GitHub CI under the Hammer close procedure.
