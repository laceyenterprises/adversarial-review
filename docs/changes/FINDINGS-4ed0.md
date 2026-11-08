# FINDINGS-4ed0

## Summary

Legacy blocker ownership preserves human ownership for ambiguous credential and
approval conjunctions in either order and accepts negated lists with or without
an Oxford comma. Codex discovery awaits credential and catalog probes through
the isolated service home; async probes close stdin and handle stream errors
without bypassing the command callback or cleanup.

## Interface changes

`prepareServiceCodexHomeAsync` provides asynchronous preparation alongside the
existing synchronous API. Credential staging, output redaction, catalog fallback,
and private-home cleanup retain the existing contract documented in
`docs/RUNBOOK-reviewer-workspace.md`.

## Verification

`node --test test/remediation-blocker-ownership.test.mjs test/codex-service-home.test.mjs`
passed all 91 offline tests after conflict resolution, including inverted
conjunctions, both list forms, and early stdin EPIPE/ERR_STREAM_DESTROYED errors.
