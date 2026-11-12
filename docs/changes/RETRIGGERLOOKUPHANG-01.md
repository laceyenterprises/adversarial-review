# RETRIGGERLOOKUPHANG-01: retrigger-review bounds its head lookup and says why it stopped

## Summary

Under host load, `node src/retrigger-review.mjs` could stay silent for minutes
before its caller killed it, having done nothing. Its current-head lookup
(`gh pr view <n> --json headRefOid`) sized each attempt with
`loadAwareTimeoutMs(30 s)`. At about 11 load per core that is 6x, so 180 s for
one attempt, and `execGhWithRetry` allowed two more. The command printed
nothing while it waited. Passing `--head-sha` skipped the lookup, and the same
command then finished in about a second.

- New `src/operator-gh-read.mjs` runs one operator-path GitHub read inside an
  **absolute budget** that covers every attempt, retry backoff and metering
  wait. The budget is 30 s idle, scaled by host load up to a 60 s cap.
  Each attempt gets half the budget, so a hung first attempt still leaves
  room for one retry, and `execGhWithRetry`'s `totalTimeoutMs` clips the rest.
  A wall-clock guard fires even when the wait is in metering admission rather
  than in `gh`, and it signals any `gh` child still running.
- The read prints `[github-read] start <label>: \`gh pr view\` (budget Ns)` on
  stderr, plus one `[github-read] retry k/N ...` line before each retry, with the
  error and the budget used so far.
- Budget exhaustion throws `OperatorGhReadTimeoutError` carrying the caller's
  typed reason. A real GitHub error passes through unchanged.
- `retrigger-review` routes both head-lookup sites (`--exact-head-now` and the
  default live-head bind) through it. On a timeout it exits `4` with
  `failed:head-lookup-timeout: <repo>#<pr> (...)` and
  `hint: pass --head-sha <sha> to skip the lookup, or raise --github-timeout-seconds`
  (in default mode the hint names `--exact-head-now --head-sha <sha>`). Other
  `--exact-head-now` lookup failures also print the `--head-sha` hint.
- A failed CLI run now exits explicitly once stderr drains, after the
  telemetry flush that a natural exit would have run. A read abandoned at
  its budget therefore cannot leave a metering timer that keeps the process alive.

## Interface changes

- New flag `--github-timeout-seconds <N>`: the absolute budget for each GitHub
  read, retries included, used as given with no load scaling (0 < N <= 3600).
- New stderr lines `[github-read] start ...` / `[github-read] retry ...` and
  the failure line `failed:head-lookup-timeout: ...` followed by `hint: ...`.
  The exit-code contract is unchanged (`4` = runtime).
- `fetchCurrentPrHeadSha` accepts `budgetMs`, `stderr` and
  `runOperatorGhReadImpl`; `main` passes `budgetMs` and `stderr` to an injected
  `fetchCurrentHeadShaImpl`.
- `docs/follow-up-runbook.md` documents the lookup budget in the
  `retrigger-review` contract.

## Verification

- `node --test test/operator-gh-read.test.mjs test/retrigger-review.test.mjs`:
  65 pass. New cases cover a hung `gh` child, which is signalled at the budget
  with the typed reason and phase. They also cover a never-resolving metering
  admission, which is still bounded, retry progress lines, a real GitHub error
  that keeps its message, and the budget cap at incident load
  (`load_per_core=11` reaches 60 s, not 180 s). Further cases: the
  `--exact-head-now` and default modes with a stubbed slow `gh` (exit 4 inside
  the bound, typed reason and hint, nothing re-armed), `--head-sha` performing
  no lookup, and flag validation.
- Existing suites green: `retrigger-remediation`, `operator-retrigger-helpers`,
  `follow-up-retrigger-label`, `follow-up-retrigger-review-label`,
  `explicit-review-intent`, `pr-round-ledger`, `cli-output-lifecycle`,
  `gh-cli-auth-outage-remint`.
- Real process, fake `gh` on PATH that sleeps 300 s, synthetic `example/repo#7`:
  base `origin/main` printed 0 bytes and was killed by `timeout 20` (rc 124).
  The fixed CLI with `--github-timeout-seconds 3` printed the start line, one
  retry line and the typed failure plus hint, then exited 4 after about 4 s and
  left no `gh` child behind. With `--head-sha` it exited 0 in under 1 s.
- `npm run typecheck:contracts`, `bash demo/research-finding-walkthrough.sh`,
  ESLint on the changed sources: passed.
