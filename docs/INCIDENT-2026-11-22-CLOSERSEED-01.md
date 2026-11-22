# CLOSERSEED-01 (SEV2): the committed seed had no closer classes

On 2026-11-22 roughly 30% of held closer harness resolutions in a recent
window (114 of 381) read `reason: harness-fallback-resolver-error`. This report
is generic and uses synthetic names only.

## Cause

Closer model resolution goes through `resolveRemediationModel`, which reads the
worker registry. When that read fails as retryable infrastructure (timeout,
unavailable, 5xx), the resolver falls back to the committed seed,
`src/adapters/agent-runtime/local/worker-model-seed.json`. That seed declared
only the reviewer and remediator classes. It had no `hammer`, `hammer-corp`,
`hammer-claude` or `hammer-claude-corp`, so the fallback found no class
`defaultModel` and threw `registry and committed seed have no valid class
defaultModel`. `resolveCloserDispatchHarness` surfaced that as a deferral, and
the closer lane held. Every transient registry blip therefore stalled the
closers even though a seed exists precisely to ride out such blips.

## Fix

- The seed carries all four closer classes, with values mirrored from the
  seed's own entries for the same model family. Seed precedence is unchanged:
  retryable infrastructure failures only; a readable registry that withdrew a
  class still fails closed; a registry-approved pin is still honored.
- Seed coverage is a unit test over the seed file and the exported closer class
  set (`CLOSER_WORKER_CLASS_PROVIDER` hammer keys and the `HAMMERS` aliases), so
  a new closer class without a seed entry fails an ordinary test. No CI check
  was added.

## Follow-ups not taken here

The seed is hand-maintained and can still drift from the live registry's
values. The seed values here were not read from the registry; an operator
should confirm them against it. Generating the seed from the registry is a
proposal for the operator and is not built in this change.
