# OSGPROJECTLOCK-01

## Summary

Finding projection and its enclosing body-capture/recovery transactions acquire
an immediate SQLite write reservation before reading. Remediation-link
projection does the same. Grade backfill commits one immediate transaction per
review pass, keeping shared WAL writer holds short. The safe live finding path
retries a busy failure once before retaining its existing advisory warning.
Review verdicts, strictness, dispatch and merge authority are unchanged.

## Interface changes

The finding and grade backfill APIs accept an optional `onPass` callback with
`{ passId, inserted }` after each committed pass. Callers can count committed
inserts accurately while replaying a partially completed page. Persistent
schemas, finding identities and immutable grade source keys are unchanged.

## Verification

Synthetic temporary WAL fixtures use real connections on separate threads to
reproduce deferred snapshot failure and cover immediate lock waiting, writer
exclusion after the projector read, live retry/exhaustion, resumed backfill and
per-pass grade commits. The six focused suites pass 111 tests when run
individually under the required network guard. Repository lint passes with zero
errors; contract typecheck and the byte-equivalence demo pass.
