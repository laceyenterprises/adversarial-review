# REPAIRDISPATCHREAD-01

## Summary

The in-place repair reservation (`bin/repair-in-place.mjs`) is a cold CLI
composition root. It read closer-launch ownership through the dispatch read
client without first calling `prepareDispatchReadContext`, so the client's
read switch (`ADVERSARIAL_DISPATCH_READS_ENABLED`) was never set. Every lookup
returned `dispatch lookup disabled`. Ownership read as unknown, so the
reservation refused with `closer-owned-or-unknown` for any PR whose closer
lease was `dispatched` with a launch request, even when that launch was already
cancelled. In-place repair PR updates were blocked until the watcher happened
to reconcile the lease.

The helper now prepares the read context once, lazily, before its first
dispatch read: the closer-lease launch read, or the read that checks whether a
pending repair epoch's owner has finished. Reservations with neither lease nor
pending epoch still need no context.

- A correctly read terminal launch with no live retry counts as not owned, and
  the reservation proceeds.
- A live launch, a live retry, a transient or timed-out read, or an unproven
  absence still refuses as `closer-owned-or-unknown` (fail-closed is unchanged).
- If preparation fails, or leaves dispatch reads disabled, the helper refuses
  with the distinct `dispatch-read-context-unavailable` (plus a redacted
  `detail`) and performs no read. It no longer reports that case as closer
  ownership.

## Interface changes

- New refusal reason from `bin/repair-in-place.mjs`:
  `{ ok: false, reason: 'dispatch-read-context-unavailable', detail }`, exit 75
  like the other refusals.
- `main(args, { env, prepareDispatchReadContextImpl })` accepts an optional
  second argument (test seam; the CLI uses `process.env` and the real
  preparation).

## Verification

- `node --test test/repairdispatchread-01.test.mjs`: 11/11 pass. Five fail
  against the pre-change helper, including "a lease naming a canceled closer
  launch reads as terminal and the reservation proceeds".
- `node --test test/inplacerepair-01.test.mjs test/dispatch-read-context.test.mjs`:
  51/51 pass.
- Fixtures are synthetic; the SDK session and lookup are mocked in-process.
