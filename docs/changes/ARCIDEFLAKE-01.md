# ARCIDEFLAKE-01

## Summary

The lane-lock waiter now watches the persistent lock inode that release updates,
rather than relying on directory notifications for a child's attribute changes.
The routing regression asserts that subscription target while retaining the
native notification and route-fencing assertions. The closure runbook documents
the inode subscription.

The controller's synthetic-census fixtures model elapsed time at completed poll
boundaries, retaining the I/O yield needed for real child exits. Host scheduling
and synchronous filesystem work can no longer consume their TERM grace and drain
periods between observations. Genuine OS-census fixtures retain their real
clock. The lost-census case also waits for a readiness line emitted after the
child installs its signal handler. All signal, unknown-drain and retained-lease
assertions remain.

## Incident

Unrelated changes encountered intermittent CI failures. Five randomized baseline
attempts identified a missed native lock-release wake and a controller fixture
that could advance directly to KILL when real elapsed time spent its grace
period. They also exposed subprocess/smoke time limits and a restricted-host
process-group probe refusal. These are separate from source-projection drift:
the checked-in SMV projection hashes matched the measured source.

## Interface changes

None. Lock acquisition and route checks remain authoritative; notifications
remain hints. No runner, workflow, timeout cap, retry policy or assertion was
removed or relaxed.

## Verification

Baseline: `599af0bc0134b9c25bfcf78178411211137001f1`, Node 26.10.0.
Each full attempt used the required netguard environment and a bounded
`cwp_dispatch.worker_validation` invocation with a 1,200-second command budget.
Attempts ran sequentially. An external copy of the runner retained its sandbox
and concurrency settings and sorted the file list by
`sha256(seed + repositoryRelativePath)`. The repository runner was unchanged.
Seeds 3 onward used TAP output; the first two used the default reporter.

| Seed | Named assertion failures | Result | Recorded duration |
| --- | ---: | --- | --- |
| baseline-1 | 0 | 900-second suite timeout | 899.876 s coordinator |
| baseline-2 | 4 | 900-second suite timeout | 924.750 s wall |
| baseline-3 | 1 | 900-second suite timeout | 922.127 s wall |
| baseline-4 | 0 | 900-second suite timeout | 919.093 s wall |
| baseline-5 | 0 | 900-second suite timeout; concurrent CPU burner | 933.371 s wall |

The first duration excludes sandbox setup. Timeout cancellations are not counted
as assertion failures, and none of these attempts establishes a complete pass.
Detailed logs and the external harness are retained in
`/tmp/arcideflake-01-evidence/`.

| Failed test | Observed signature | Disposition |
| --- | --- | --- |
| `HAMLANEWAIT-01: native watcher wake rechecks the route after a pending wait` | `owner-operation-in-flight` instead of `lane-transfer-required`; 10-second wait, no wake acquisition | Persistent-inode subscription fix |
| `lost process census stops the direct child but retains the owned lease and unknown drain` | `directTermSent` was undefined instead of true | Controlled fixture clock and explicit readiness |
| `SMV canonical sandbox smoke merges only disposable Git` | Clean step ended after 34.27 seconds without final successful evidence | Existing smoke budget remains unchanged; unresolved |
| `[hammer shard 1/3] LAC-2097: update-branch visibility converges without repeating the CAS: ci-old-reply` | Subprocess ended with `SIGTERM` instead of no signal after 47.32 seconds | Existing subprocess cap remains unchanged; unresolved |
| `bounded runner preserves exit status and caps combined output` | Restricted-host `cleanup EPERM`, status 125 instead of 124 | Environment-dependent probe refusal; unchanged |

The originally reported SIGINT/SIGTERM, rendered common-close budget, persisted
history pages, unavailable audit dependency, both SMV projection, orchestration
catalog and both MLR-07 tests passed when they completed. None reproduced an
assertion failure in these five attempts; cancellation prevents claiming five
completed passes for each.

The added subscription-target assertion failed against the original product
code, then passed with the fix. The first affected-suite run completed with
150 passing tests, one existing skip and zero failures:

```sh
node test/run-tests.mjs test/finalization-queue-routing.test.mjs \
  test/finalization-queue-owner.test.mjs test/hammer-controller.test.mjs
```

`npm run lint` passed with zero errors and 149 existing warnings.
`npm run typecheck:contracts` and
`bash demo/research-finding-walkthrough.sh` passed.

An initial randomized affected-suite campaign passed four runs, then its
CPU-contention run exposed another fixture using the same real-clock drain:
`unreadable ownership stops shell, validator and TERM-ignoring test after detach`
returned 125 instead of 143. This prompted the shared synthetic-census clock
change, rather than special handling of only the lost-census case. No failed
attempt is counted as passing proof.

The final affected-suite campaign completed five sequential randomized runs of
the three files above, each with 150 passes, one existing skip, zero failures
and zero cancellations:

| Seed | Wall seconds | CPU contention |
| --- | ---: | --- |
| controlled-1 | 62.100 | No |
| controlled-2 | 65.806 | No |
| controlled-3 | 64.808 | No |
| controlled-4 | 79.380 | No |
| controlled-5 | 68.630 | Concurrent burner |

The final branch `npm test` gate also reached the 900-second suite timeout:
14,708 passes, zero assertion failures, 198 cancellations and nine existing
skips (14,915 reported tests; 899.880 seconds coordinator duration). This run used
the existing `ADVERSARIAL_TEST_RESTRICTED_PROCESS_PROBE=1` fixture setting after
the baseline demonstrated the host's `EPERM` group-probe refusal. That existing
branch still requires the unconfirmed-cleanup diagnostic and descendant death.

Five randomized complete green branch runs remain required; the affected-suite
results do not substitute for them. ARSUITETIMEOUT-02 had not reached
`origin/main` after the final branch gate. The operator authorized publication
of the scoped fixes with that proof explicitly pending ARSUITETIMEOUT-02
(adversarial-review PR 1822), with no merge or check bypass. After the runner
change lands, rebase and repeat the complete proof, including investigation of
any remaining failures. The unresolved smoke budget, update-branch subprocess
cap and restricted-host process-group probe refusal are listed above.

## Post-merge observation

SRE acceptance is pending: across the next 20 adversarial-review CI runs,
including PRs and main, require zero failures attributable to the fixed tests.
Check that remaining failures are attributable only to genuine PR breakage or
the separately tracked suite timeouts. No live action is performed by this
change.

The observation is declared in
`modules/worker-pool/post-merge-actions/arcideflake-01-ci-observation.yaml`.
