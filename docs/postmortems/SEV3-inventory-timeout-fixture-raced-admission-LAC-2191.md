# SEV3 — inventory timeout fixture raced metering admission

Tracking: LAC-2191. Supplied incident: adversarial-review #1869's Node 22 job
failed only `default inventory reader bounds a hanging lookup and records the
failure`, dereferencing an undefined signal. Impact: a false CI failure blocked
review validation. The supplied evidence does not establish a production outage
or a merge-gate bypass.

## Cause

The fixture gave the default inventory reader 50 ms of wall time for both real
asynchronous metering admission and its mocked hanging child. Admission can
consume that budget before the child executor runs. The production reader then
correctly reports an admission timeout with zero attempts, while the fixture
incorrectly assumes the child received an AbortSignal. Raising the wall deadline
would leave the scheduling dependency in place.

## Repair and regression proof

`test/merge-lane-inventory.test.mjs` uses the existing `FakeClock` and an explicit
child-start promise. Real admission completes before virtual time advances.
At 49 ms the read remains pending and its signal remains live; at 50 ms the
signal is aborted and inventory records the typed lookup timeout, execution
phase and one attempt, with no repository result.

The independent admission fixture in `test/operator-gh-read.test.mjs` stalls
the existing retry seam before any child. At 99 ms it remains pending with a
live signal; at 100 ms it reports the typed admission timeout with zero attempts,
aborts that signal and never calls the child executor. The existing real-child
cancellation test remains in the scoped suite.

Family rule: a cancellation assertion must establish that execution started;
prove pre-execution admission expiry separately. Promise draining alone does
not complete filesystem admission. Sibling operator fixtures already use
`FakeClock` for admission, execution and response-record timeouts; this repair
strengthens the admission proof and fixes the inventory fixture.

No production code, policy cap, retry allowance, job budget, CI configuration,
config schema or merge lifecycle changes. This is a separate PR; #1869 and
#1868 are untouched, and no earlier bulk timing conversion is required.
HCP symptom/scope searches returned no matching records. See the
[change note](../changes/LAC-2191.md) for observed Node 22 offline validation.
