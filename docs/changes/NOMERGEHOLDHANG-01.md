# NOMERGEHOLDHANG-01: the no-merge hold CLI applies or fails within a bounded time

## Summary

`node src/no-merge-hold.mjs` made its `gh` calls through `meteredExecFile` with
no GitHub budget scope. `gh label create` and `gh pr edit` are high-level
commands, so `ghResources` makes them wait on both the `core` and the `graphql`
pools. When the shared store held a `graphql` (or `core`) observation below the
throttle floor, the un-scoped `awaitThrottleIfNeeded` slept until that bucket's
reset, up to an hour. It printed nothing, spawned nothing and wrote no receipt.
The `default` credential bucket mixes every credential-less caller, so a
balance other callers drained could starve an operator's emergency hold.

- Hold and release now run every `gh` call in an `operatorSafety` budget
  scope. The floor never sleeps or defers that scope, in either the async or the
  synchronous metered path. GitHub itself still refuses a call that is really
  over budget, quickly and with metering. A rate limit observed in the same scope
  still fails the next call immediately.
- The whole attempt shares one deadline:
  `loadAwareTimeoutMs(30 s, { maxMs: 120 s })`. A wait that outlives it fails
  with one line naming the phase it was stuck in. The phases are metering/budget
  admission before spawning `gh <cmd>`, `gh <cmd>` to exit, and metering to
  record the response. A metering wait that resolves after the deadline is
  refused rather than spawned, and a `gh` child still running is signalled.
- Every attempt writes a receipt. Failures are marked `applied: false` with a
  one-line `error`; successes are marked `applied: true`. The CLI exits 1 on any
  failure, with the receipt path on its failure line.

## Interface changes

- Receipt fields `applied` (always) and `error` (failures only) are added. See
  `docs/data-model/no-merge-hold-receipts.md`. `schemaVersion` stays 1 because
  the change is additive. `held` remains the requested state.
- CLI success line gains `applied=true`. The failure line is now
  `[no-merge-hold] Failed: repo=<r> pr=<n> <error> applied=<bool> receipt=<path>`.
  It ends `receipt-write-failed=<reason>` when the receipt could not be written.
  `applied=true` appears there only when the label landed but its receipt did not.
- `withGitHubBudgetScope({ operatorSafety: true }, fn)` is a new scope option.
- New exports from `src/no-merge-hold.mjs`: `runNoMergeHoldCli`,
  `createBoundedGhRunner` and `resolveNoMergeHoldTimeoutMs`.
  `applyNoMergeHold` accepts `meteredExecFileImpl` and `timeoutMs` seams.

## Verification

- `node --test test/no-merge-hold.test.mjs`: 16 pass. Covers a never-resolving
  fake meter for hold and `--resume` (exit 1 within the bound, one line,
  `applied=false` receipt, no `gh` spawn), the normal hold/release CLI path,
  an exhausted shared budget (no sleep, label applied), a hung `gh`, a late
  meter that must not spawn, a real `gh` failure, and receipt-write failures
  on both the success path and the failure path.
- `test/rate-limit-throttle.test.mjs` (27 pass) and
  `test/metered-gh-sync-env.test.mjs` (7 pass) cover the `operatorSafety` scope.
- A/B: with the `rate-limit-throttle.mjs` change reverted, the exhausted-budget
  tests and the operator-safety scope tests fail.
- Real process, fake `gh` on PATH, synthetic store with `core`/`graphql`
  remaining 0 and reset in 1 h: the base CLI was silent for 20 s, made no `gh`
  call, and wrote `.throttled.json` with `waitMs` 3321023. The fixed CLI applied
  and released in about 1 s each, with receipts.
