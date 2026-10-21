# Vendored producer artifacts

Copied owner records and captures are verbatim. `provenance.json` is authoritative:
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
