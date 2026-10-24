# Vendored producer artifacts

LVR-09 recorded examples are extracted from the immutable SDK 0.4.0 public
snapshot. `provenance.json` pins per-producer versions and hashes under `recorded`
and exposes `producerHashes` for the report-only stale command. JSON recordings
retain compact producer canonical bytes; the token text retains export lines
verbatim. Refresh with `scripts/contracts/refresh-recorded.py`, never by hand.
Consumer drift failures name the producer and capture contract version.

Historical copied owner records and captures are verbatim. `provenance.json` is authoritative:
relative links resolve under each artifact's `source` path in agent-os at its
pinned `revision`, rather than relative to this checkout. Revision mentions in
copied READMEs describe their original capture history. Only captures listed in
provenance are vendored; publication policy, completion, disposition, drift and
backfill examples mentioned by the owner README are deliberately omitted.

`released-provenance.json` separately pins the consumer-side released fleet
capture and its generator. The ready, degraded, disabled and unavailable fleet
captures share quota sections with every reserve floor paused; their names
identify broker state, not routing admission. Positive Claude admission uses
`quota/fleet-released.json`; Codex positives use an explicitly labelled probe
mutation. See `docs/producer-contract-readers.md` at the repository root for
refresh and activation instructions. Do not edit hash-pinned copies here.
