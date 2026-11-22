# HAMMERPOOLSTRICT-01 (SEV1): one new host config key held every closer

On 2026-11-22 the hammer lane stopped launching. Every closer harness
resolution read `hold: true, reason: evidence-unknown` with no evidence source,
for every PR. Only the daemon's inline zero-finding merge path and human merges
landed anything until the cause was fixed. This report is generic and uses
synthetic names only.

## Cause

The host's top-level config gained a new, off-by-default key. The host's own
schema knew it; this repository's mirror of the schema did not.

The general runtime reader (`loadConfigCached`, `loadConfigRuntime`) passes
`tolerateCheckedInUnknown: true`: a key it does not know is warned about once and
dropped, so a lagging daemon cannot be taken down by a newer host config. The
identity-token-pool reader, `loadConfigForIdentityTokenPool`, did not pass that
flag, so it validated the checked-in top-level file strictly and threw
`AgentOSConfigError: <section>.<key>: unknown key (strict schema)`.

`selectWorkerTokenAccount` catches every error from that read and returns
`{ hold: true, reason: 'evidence-unknown' }`. A closer holds on any pool proposal
that is not `selected`, by design, so no closer reached the fleet-quota read.
Remediator routing survived only because a non-selected remediator proposal
falls back to legacy class routing.

Two things made it hard to see: the hold reason was the same one used for a
genuine owner or quota evidence fault, and the log carried no trace of the
underlying load error.

## Fix

- `loadConfigForIdentityTokenPool` applies the same checked-in-unknown tolerance
  as the general runtime reader. It warns once and records the dropped key in
  `runtimeDroppedUnknownKeys`. Value checks, `__strict_always` policies, and
  every declared broker instance, token account and identity pool still fail
  closed: a malformed declaration holds the lane.
- The new host key is mirrored in the Node-only key inventory
  (`src/config-node-keys.mjs`) so the warning goes quiet. This is hygiene, not
  the fix: the tolerance is what removes the failure class for this reader.
- A hold caused by a config load or validation error now carries
  `reason: 'config-load-error'` plus `configLoadError: { errorClass, keyPath }`
  into the `ama_closer.harness_resolution` event and the AMA audit record, so
  the next occurrence is diagnosable in one read. Never a message or a value.
  Owner, transport and quota faults keep `evidence-unknown`.

## Audit of other strict runtime readers

`loadConfigForIdentityTokenPool` was the only runtime routing or dispatch reader
that validated the checked-in top-level layer strictly. Module files, local
overlays and every cached reader already tolerate unknown keys. The remaining
strict entry point, `loadConfig`, is the startup/CLI validator whose purpose is
to report schema errors; it stays strict.

## Follow-ups not taken here

This is the fifth strict-reader-versus-newer-config incident. The recurring
cause is a hand-maintained mirror lagging the host schema. Re-vendoring the
generated schema removes the Node-only entry added here; the import-time check
in `src/config-schema.mjs` will name it. A schema-parity check across loaders is
a proposal for the operator and is not built in this change.
