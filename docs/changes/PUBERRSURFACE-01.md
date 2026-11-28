# PUBERRSURFACE-01 | Guarded publication refusal diagnostics

## Summary

Guarded remediation publication retains GitHub's diagnostic in the failure
sidecar and follow-up stop reason. A rejected credential can retry once when
the same route supplies a fresh credential. Permission and branch protection
refusals go directly to the owner hold.

See the [SEV4 report](../postmortems/SEV4-PUBERRSURFACE-01-guarded-publication-stderr-lost-2026-11-28.md).

## Interface changes

Publication failure records may include `pushExitCode`, `httpStatus`,
`stderrTail`, `githubMessage`, `authRefusal` and `credentialRetried`. The tail is limited to
2,048 UTF-8 bytes after secret redaction.

## Verification

- `node --test test/remediation-owner-auth.test.mjs` passed all 50 cases.
- `node --test test/remlabel-publication.test.mjs` passed all 60 cases.
- Both suites ran under netguard with a 600-second validation bound.
- `npm run lint`, `npm run typecheck:contracts`, and
  `bash demo/research-finding-walkthrough.sh` passed.
