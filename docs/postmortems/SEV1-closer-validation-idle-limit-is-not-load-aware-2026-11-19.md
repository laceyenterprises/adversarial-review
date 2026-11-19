# SEV1 — closer validation killed a slow quiet check as a hang under host load, so reviewed PRs stopped merging

Date: 2026-11-19. Ticket: HAMVALIDATEIDLE-01. Severity: SEV1.
Status: fix prepared; recovery requires the fix to be deployed and the waiting PRs re-driven by the normal closer path.

scars: merge.finding-remediation-and-authoritative-terminal, program.worker-dispatch-reliability

## Impact

Merges are the pipeline's success metric. From the early hours of 2026-11-19 UTC,
every closer that reached local validation ended `failed-without-merge`, although
no check had failed and its findings were already fixed. At least eight reviewed
PRs were waiting for a merge.

## Evidence

Read-only review of the supervisor result lines from the 22 most recent closer
launches:

- Launches that finished validation earlier in the evening: every `run-bounded`
  line was `exited`. The durations of the validation runs climbed in steps, from
  about four to five minutes, to about six minutes, to about ten minutes.
- From the first launch after the early-morning mark, four consecutive closers
  showed repeated `no-progress-timeout` lines, each with an idle value of
  120 s (shape: `elapsed=210723ms idle=120063ms bytes=833 status=124`).
- The last output before each kill was a list of passed checks with no failure.
  The next check was still running, silently.
- At that time the host's one-minute load was several times its core count,
  CPU was about one-fifth idle, and disk was busy.

## Cause

`bin/hammer-validate.mjs` runs canonical validation under `runBounded` with two
bounds:

- an absolute deadline, already scaled by host load (`loadAwareTimeoutSeconds`);
- a no-progress limit, `LEASE_VALIDATION_IDLE_MS = 120_000`, passed unscaled.

The validation runner prints one line when each check finishes, so a single
slow check produces no bytes for its whole duration. Only child output resets
the idle clock (`bounded-command.mjs` deliberately ignores CPU use and
heartbeats). On a busy host a healthy check outlasted 120 s of silence and the
run was stopped with `no-progress-timeout` (status 124). The closer treats
that status as an unknown result and ended without merging.

The absolute bound had been made load-aware; the idle bound beside it had not.

## Rejected alternatives

- *The check is hung.* The same checks pass on a quieter host, the kill always
  lands at exactly the idle limit, and no check reports a failure.
- *Print heartbeats from the runner.* A synthetic byte stream would blind the
  hang detector, which counts only real child output.
- *Remove the idle limit.* It protects the merge lease from a truly hung
  validator. It stays, scaled and bounded.

## Fix

`leaseValidationIdleMs(remainingMs)` in `src/ama/lease-validation.mjs` scales
the unloaded base (`LEASE_VALIDATION_IDLE_MS`, unchanged) with the shared
`loadAwareTimeoutMs` helper, using its multiplier and timer ceilings. The result
is capped strictly below the remaining absolute deadline, so a real hang still
ends before the lease does. `hammer-validate.mjs` evaluates it each time a
validation command starts, and the existing `run-bounded: started ... idle=`
line shows the effective value. `bounded-command.mjs` is unchanged.

## Tests

`test/hamvalidateidle-01.test.mjs` uses synthetic host readings and a fake
clock:

- at normal load the limit equals the base;
- at high load it grows but stays within the helper's multiplier ceiling;
- it is always strictly below the remaining deadline;
- a child silent for longer than the base limit but less than the scaled limit
  completes successfully at high load, and is killed at the base limit at
  normal load;
- a truly silent child is still stopped with `no-progress-timeout` at the
  scaled limit.

## Follow-up

No new CI check, gate or override is proposed. Waiting PRs are re-driven by the
normal closer path once the fix is deployed; this change touches no live state.
