# SEV3: Findings drain throughput was fixed while capture scaled with review volume

- Date: 2026-11-20
- Ticket: FINDINGSDRAINRATE-01
- Severity: SEV3. The open non-blocking findings backlog trended up under load
  instead of toward zero. No finding was lost or wrongly settled.

## What was observed

A production host tracked open non-blocking findings (captured, no outcome) on
a high-volume review day. Over several hours, hourly captures exceeded hourly
batch completions every hour, so the backlog grew instead of draining. Several
batches were in flight and some findings were still unbatched. Volume is not
under the pipeline's control; only drain capacity is.

## Phase 0: where the time goes

Method: synthetic store (one merged PR, 12 areas, 3 findings each, so 12
batches), the real `runFindingBatches`, and a stub `hq` dispatcher that sleeps
200 ms per submission to stand in for provisioning. One claim-and-submit pass
was measured at each concurrency, then a resolution pass with every batch's
outcomes ready (all dropped, so no publication step).

| Concurrency | Batches claimed | Submitted in pass | Unbatched after | Pass wall-clock | Max concurrent dispatch | Settled next pass | Settle pass |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 12 | 12 | 0 | 2.65 s | 1 | 12 | 0.28 s |
| 2 | 12 | 12 | 0 | 1.44 s | 2 | 12 | 0.23 s |
| 4 | 12 | 12 | 0 | 0.77 s | 4 | 12 | 0.33 s |

Findings:

1. **Claiming does not limit drain.** One claim takes every eligible finding.
2. **Submission concurrency does not limit how many batches a pass submits.**
   The pass drains its whole queue at every concurrency.
3. **Submission concurrency limits the length of a pass.** A pass takes about
   K·D/N for K new batches, provisioning latency D and concurrency N. The
   collector's own source comment documents provisioning of up to about eight
   minutes. At that latency, concurrency 1 can submit only about seven batches
   an hour. The ticker refuses to overlap passes, so a pass longer than the
   hourly cadence delays the next collection and the next claim, and new
   captures wait longer before they are even batched.
4. **Settlement is cheap and concurrency-independent** once outcomes exist.
   The remaining latency is the hourly cadence: about one pass to claim, one
   to collect outcomes, and one more after publication for applied batches.
   Worker run time and HQ admission sit outside this repository.

The synthetic run cannot show whether the production growth was bound by
submission time or by worker completion latency. The binding limit in code was
fixed submission concurrency, so that is what this change makes tunable. It
also makes the trend visible, so an operator can tell the two cases apart.

## Fix

- `ADVERSARIAL_FINDINGS_BATCH_CONCURRENCY` (default 2, previously a fixed 1)
  feeds the live collector's `runFindingBatches`. The default halves pass time
  at the same per-dispatch latency. HQ normal-priority admission still owns
  running worker capacity and budget, so the default adds no second admission
  mechanism. Claims, idempotency keys, publish locks, retry caps, release and
  dispatch-attempt limits are unchanged.
- `summarizeFindingBacklog` reports `rates`, with captured, resolved and
  batches completed in the last hour plus `netLastHour`. A sustained positive
  net with short passes points at worker latency or admission. A positive net
  with long passes points at submission concurrency.

## What was not changed

The hourly resolution cadence remains a literal, and the claim interval remains
`ADVERSARIAL_FINDINGS_BATCH_INTERVAL_MS`. Neither was shown to be the binding
term. No CI check, gate or override was added.

## Regression tests

`test/findingsdrainrate-01.test.mjs` covers knob validation and the default, the
ticker honouring the knob, refusal before claim on an invalid value, one launch
per batch under racing collectors, and the summary rate fields.
