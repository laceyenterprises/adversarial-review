# ORPHANDAEMONMERGE-01 — Ownerless recovery runs the daemon clean merge instead of refunding an empty pass forever

## Summary

SEV2, merge lane, silent strand. Once a PR entered ownerless (orphan) recovery
it could never be daemon-merged, even when its live decision was a clean
exact-head daemon merge.

Each recovery pass re-derived `daemon-merge`/`clean-exact-head`. Closure
orchestration then skipped the daemon attempt because the pass carried
`ownerProof` (`ownerless-hammer-recovery`), and no hammer was dispatched because
the decision was not a hammer. The undispatched result was classified as a
recovery wait, so the watchdog refunded the attempt. Attempts never grew, the
`attempts >= 2` exhaustion and page never ran, and nothing paged. The PR sat
until a human noticed.

Two fixes:

- **Recovery runs the merge it re-derives.** When the re-derived decision is
  `daemon-merge` by `daemon`, ownerless recovery runs the existing
  `runDaemonCleanMergeAttempt` with every gate unchanged and the same audit and
  lease. The OWNERPROOF/DAEMONSUPERSEDE fences already prove no live closer, so
  recovery is the sole owner and there is no race to avoid. Hammer, remediate and
  wait decisions keep `ownerless-hammer-recovery`. A fail-closed merge falls to the
  hammer exactly as on the normal path.
- **An empty pass is spent, not refunded.** An undispatched pass whose settled
  decision is a daemon merge spends its attempt even when flagged `recoveryWait`.
  A recognized wait reason (operation timeout, 429, quota read) still refunds.
  Repeated empty passes now reach `recovery-attempts-exhausted` and page once.
  A landed recovery merge settles `pr-terminal` and no longer reports
  `dispatch-refused:daemon-merged`.

## SEV2 report (public-safe summary)

- **Impact:** a clean, approved, green, mergeable PR stranded indefinitely in
  ownerless recovery; no page, no operator signal. One live agentpaddock PR was
  affected for several hours.
- **Trigger:** the daemon clean merge failed closed on an unresolved worker
  identity (a since-fixed provenance producer gap). Its next-action deadline
  expired, handing the PR to ownerless recovery. After identity resolved, the
  daemon decision was clean again but recovery could not act on it.
- **Masking:** the skipped merge produced an undispatched result that the
  watchdog treated as a wait and refunded. The exhaustion and page paths were
  unreachable. The ordinary closure pass does not re-enter a PR that ownerless
  recovery owns.
- **Why it was not caught:** `ownerless-hammer-recovery` was written to avoid
  racing a daemon merge against a closer recovery is waking. That reasoning holds
  for hammer decisions, not for a decision that is itself the clean daemon merge.
- **Detection gap closed:** an empty recovery pass now spends its attempt.
- **Companion:** the agent-os postmortem
  (`docs/postmortems/SEV2-ownerless-recovery-never-daemon-merges-a-clean-pr-2026-11-18.md`)
  lives in agent-os and is not part of this repository.

## Interface changes

None. `src/ama-closure-orchestration.mjs` gates the `ownerless-hammer-recovery`
skip on a non-`daemon-merge` decision. `src/ama/orphan-watchdog.mjs` adds the
settled-merge refund exception and the merged-result settle. No gate, config
key, check or label is added or relaxed; `strict_mode` is untouched.

## Verification

- `node --test test/orphandaemonmerge-01.test.mjs`: 7 pass (offline, synthetic
  fixtures, real watchdog driving the real closure orchestration). Tests 1, 2, 3
  and 6 fail on the base source and pass with the change; 4, 5 and 7 pin
  unchanged behaviour.
- Existing suites green: daemonsupersede-01, ownerproof-review-recovery,
  noowner-01, interactiveprident-02, recovery-deadline, watcher-daemon-clean-merge,
  daemon-next-action, closer-next-action, closerparkowner-01, remorphan-01,
  amafind-01, ama-retain-loop-cap, hamlanewait-02, safety-stop-repair,
  ama-hammer-background-dispatch, ama-closer-dispatch-priority, watcher-claim-loop.
- `hamclose-replay` has 2 failures that are identical on the base source.
- `npm run lint`: 0 errors. `npm run typecheck:contracts`: clean.

### HAM CI repair

Reviewed the orchestration state projection against the merge base. The only
projected change is the existing `owner: page` branch guard changing from
`!orphanRecovery?.ownerProof` to `!hammerOnlyRecovery`, so ownerless daemon
recovery retains the ordinary identity-absence parking path. The 24 projected
state/owner records, lifecycle states, graph edges and smoke promises remain
unchanged. Refreshed the orchestration source digest in `state-machines.json`;
the independent graph snapshot and drift/mutation assertions remain intact.

HAM validation: canonical changed-surface runner passed 2,198 tests across 51
files, including SMV and orchestration producer checks. Lint passed with zero
errors; contract typechecking and the offline research-finding walkthrough
passed. Full-suite authority remains the exact-head GitHub Node 22/26 jobs.
