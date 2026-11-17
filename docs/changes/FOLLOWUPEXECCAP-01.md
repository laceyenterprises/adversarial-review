# FOLLOWUPEXECCAP-01 — merge-agent dispatcher call keeps the child's output

## Summary

The follow-up merge-agent ran `hq dispatch` through Node's `execFile` with a
`timeout`. On expiry `execFile` destroys the child's stdout/stderr pipes before it
signals, so the child's final flush fails (a Python child exits 120, not 143) and
the catch block sees an empty or truncated `err.stderr`. The comment above the call
exists so the real dispatch error surfaces; on a timeout it could not.

The dispatcher call now uses `runCommandKeepingOutput` (SIGTERM, a grace period,
then SIGKILL, pipes read until close), the same runner the legacy lane writer
adopted in LEGACYEXECCAP-01. The budget (`follow_up.hq_dispatch_subprocess_timeout_ms`,
load-aware) and `maxBuffer` (5 MiB) are unchanged.

## Behavior

- Success: identical (`{ stdout, stderr }`).
- Non-zero exit: the same `err.code` (exit status), `err.stdout` and `err.stderr`;
  `err.message` is `Command failed: <command>` plus stderr.
- Expiry: an error with message `hq dispatch timed out after <ms> ms`, `code`
  `ETIMEDOUT`, `killed: true`, `signal: SIGTERM` (also when the runner's default
  signal is used), `cmd` naming the executable, and the captured stdout/stderr.
  `formatExecFailure` appends that stderr/stdout to the surfaced error.
- Classification is unchanged: a timeout is a transient error (`isExecTimeout`
  matches on `ETIMEDOUT`/`killed`/"timed out"), so the existing transient retry loop
  re-runs it. The `--priority` fallback and the retry delays are untouched.
- An explicitly injected `execFileImpl` still receives the dispatcher call, so
  fake-exec tests keep working; only the default path uses the shared runner.

## Interface changes

- `runCommandKeepingOutput` accepts an optional `env`, passed to the child (the
  dispatcher needs its dispatch environment; `execFile` passed it before).
- `dispatchMergeAgentForPR` accepts `dispatchKillGraceMs` (default 10 s) and
  `dispatchTimeoutMsOverride` (default: the resolved budget). Both exist so tests
  can use short budgets; production callers do not set them.

## Verification

`test/followupexeccap-01.test.mjs` runs real fake children: a timeout keeps partial
stderr and names the budget; a child ignoring SIGTERM is SIGKILLed after the grace;
a timed-out dispatch is retried; success, non-zero exit and the `--priority`
fallback are unchanged. The follow-up merge-agent suites,
`run-command-keeping-output`, `legacy-lane-write-run-budget` and
`cfg-promotion-watcher-knobs` pass. `npm run lint` has 0 errors; `npm run
typecheck:contracts` is clean.

Final comment-only remediation adds assertions for the timeout cause's
`killed`, `signal` and `cmd` properties. Every scratch directory in
`test/followupexeccap-01.test.mjs`, including dispatch roots, now has a per-test
cleanup hook that runs on success or failure.

Final-round verification: `node test/run-tests.mjs
test/followupexeccap-01.test.mjs test/follow-up-merge-agent.test.mjs
test/run-command-keeping-output.test.mjs test/cfg-promotion-watcher-knobs.test.mjs`
passed (291 passed, one skipped). `npm run lint` passed with zero errors,
`npm run typecheck:contracts`, `bash demo/research-finding-walkthrough.sh` and
`git diff --check` passed. The full suite is reserved for PR-head CI.
