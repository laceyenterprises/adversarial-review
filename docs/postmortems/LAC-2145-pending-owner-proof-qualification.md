# LAC-2145 / LEASECIPROOF-01 — pending-owner qualification

Parent: LAC-2132. Date: 2026-11-02. Severity: SEV3. Classification: intermittent CI
qualification failure; no established production custody violation. This is
the SEV/RCA qualification record, not a declaration of runtime recovery.

## Reported incident and evidence boundary

[Node 22 job 125615982430](https://github.com/laceyenterprises/adversarial-review/actions/runs/41544301096/job/125615982430)
reported 17,923 passed, 3 failed and 53 skipped. Its log identifies Node
22.23.3, Ubuntu 24.04.5 and checkout **85c223e36395f8f58d392bb34da8ee6517060b17**
(the merge of ca575612b96899a32e7094ab8a4643ab45c8927b into
a1b928b194e2a37162aeada250c771dd2831d731). Distinguish the tested merge
commit from the PR head.

The dispatch supplies the following comparison evidence: Node 26 at the same
head passed, and integrated 56a4b62e passed both full suites in
[run 41545534657](https://github.com/laceyenterprises/adversarial-review/actions/runs/41545534657)
without modifying the implicated implementation/fixtures. Those green runs
alone cannot establish a fix. LAC-2072's old additive fixture problem and
LAC-2106's macOS directory wakeup are separate investigations.

Local qualification started at 6d15973cac32cd7e9316b97afdaaddcb98217bff in the
provisioned codex-lac-2145 workspace. This is Darwin, Node 26.10.0, with Node
22.22.3 also installed. Docker's Linux socket returned permission denied.
Host `ps` execution also returned `Operation not permitted`; ambient process
inspection is unavailable here. No local Linux or exact CI Node 22.23.3
reproduction is claimed.

## Reproduced fixture defect

The three fixtures create native pending leases at fixed July/October 2026
times with synthetic watcher PID 123. They inject successful `kill(123, 0)`,
but omitted the independent synchronous process-start read. The consumer
`isReclaimablePendingAmaCloserLease` calls `abandonedAmaCloserLeaseOutcome`,
which uses `captureCloserProcessSync` to parse raw `ps -o lstart= -p 123`
output. A process starting after lease acquisition correctly proves PID reuse.
Whether an unrelated PID 123 exists in the runner thus changes the fixture's
meaning.

The controlled replay substitutes only that exact raw process-table response,
leaving timestamp parsing, lease production/acquisition, ownership decisions
and dispatch logic intact. A November process start reproduces the exact
three assertion failures; missing process output retains the fixture owner.
The original CI log does not capture PID 123's process start, so this is a
reproduced mechanism consistent with all three failures, not proof of the
original runner's process table.

| Node 26/Darwin experiment | Trials | Tests passed | Tests failed |
| --- | ---: | ---: | ---: |
| Unmodified two complete files, ambient host | 1 | 440 | 0 |
| Pre-fix, isolated three cases, absent raw PID row | 5 | 15 | 0 |
| Pre-fix, isolated three cases, newer raw PID row | 5 | 0 | 15 |
| Candidate 1, isolated three cases, absent raw PID row | 5 | 15 | 0 |
| Candidate 1, isolated three cases, newer raw PID row | 5 | 15 | 0 |

Each trial starts fresh file workers through the existing isolated runner;
there are five trials per controlled condition, not a statistical estimate
of ambient Linux failure frequency. The pre-fix newer-row replay returns
`dispatch-status-unknown` instead of `closer-lease-held-by-other-process`,
omits `inFlight`, and omits `lease-held`, respectively. No candidate production
patch was attempted.

Checked-in [trial records](evidence/LAC-2145/node26-trials.json) preserve the
pre-fix counts and an additional ten-trial confirmation with the checked-in
harness (30 passed, zero failed). The [assertion excerpt](evidence/LAC-2145/pre-fix-assertions.txt)
preserves the exact three failures from a supplementary 14-case controlled run.

Node 22.22.3/Darwin independently reproduced the pre-fix split: five absent-row
trials passed 15/15 cases; five newer-row trials failed 15/15 cases. The
[Node 22 pre-fix records](evidence/LAC-2145/node22-pre-fix-trials.json) count all
three cases in every trial. For this comparison, only the two implicated test
files were temporarily restored from the local base commit in this worker's
own workspace, then restored to the candidate in a `finally` block.
The [Node 22 candidate records](evidence/LAC-2145/node22-candidate-trials.json)
then passed all 30 cases across ten trials (five per condition).

The Node 22 run uses an ignored local `fs-ext` build against the installed
Node 22 and libuv headers; the original Node 26 binary was restored
before publication. No installed host package or checked-in
dependency changed. The initial Node 22 attempt failed module loading
with ABI 147 versus 127 and is not counted as a behavioral trial; the first
native build needed the explicit installed libuv include path.

## Fixture repair and regression contract

`closerProcessFixture` pairs the existing synthetic PID/liveness seam with
deterministic raw `ps` output predating acquisition. It checks the exact
command arguments and UTC/C locale, counts reads, and restores the built-in
export after each test. It does not return an ownership verdict or replace
the lease validator. All three original assertions, receipt preservation and
zero competing-launch assertions remain.

`leaseciproof-01.test.mjs` drives the native lease writer, real process
timestamp parser and real pending-lease consumer. It proves that an older
process holds, a newer process is reclaimable, and missing/invalid/failed
process reads retain custody within the deadline. It checks unchanged
persisted leases and the exclusive acquisition fence even after a positive
reclaim observation. Sibling foreign/dead/expired/dispatched/terminal cases
remain in the original suites.

The existing `ama-closer-lease.test.mjs` CLOSERLEASEDEAD-01 and
CLAIMPIDSTALE-01 cases also pin LRQ/current-process protection, foreign-host
probe suppression, exact deadline boundaries, and replacement-launch
preservation during an identity read. These predicates already accept parsed
identity fixtures; this change adds the missing raw producer/parser boundary.

The early pending check and late acquisition check are synchronous; their
failure did not require an SDK timeout or ownership-read budget expiry.
Existing tests still inject launch status, build completion and dispatch
SDK/registry seams. No budget, fake clock, LRQ/retry-chain/remote proof,
process identity rule, native lease fence, runtime configuration or production
implementation changes.

## Repeat and acceptance

The manual harness runs five absent-row and five newer-row trials, with
30 seconds per trial, using the existing sandbox and three exact test names:

```bash
PYTHONPATH=/path/to/agent-os/modules/worker-pool/lib/python \
python3 -m cwp_dispatch.worker_validation --repo-root . --timeout-seconds 900 \
  --command node test/qualify-leaseciproof.mjs /tmp/leaseciproof-trials
```

It writes per-trial logs and a version/platform-tagged `trials.json`. To repeat
the pre-fix experiment in an authorized disposable checkout, use the harness
and preload against the original two test files without the fixture repair.
Never edit another rescue tree to run this comparison.

The reported suite, replay, lint, typecheck and demo commands used the bounded
worker-validation process-group runner.
[Node 22 scoped validation](evidence/LAC-2145/node22-scoped.json)
passed **481/481 tests**, zero failed/cancelled/skipped, across
`ama-closer-dispatch-priority.test.mjs`, `noowner-01.test.mjs`,
`ama-closer-lease.test.mjs`, and `leaseciproof-01.test.mjs`.

Local Node 26 validation:

- `npm run lint`: zero errors (153 existing warnings); explicit ESLint on
  the changed JavaScript: zero errors (one existing unused-import warning).
- `npm run typecheck:contracts`: passed.
- `bash demo/research-finding-walkthrough.sh`: passed, three byte-stable
  transcript deliveries.
- Five raw process-evidence regression cases: five passed, zero failed.
- Full `npm test`: **not green**. The runner reached its existing 900-second
  deadline: 12,773 tests reported, 12,533 passed, 6 failed, 228 cancelled,
  6 skipped. Failures named build-cancellation descendants, cold composition,
  missing-bootstrap credential handling, two HAMLANEWAIT cases, and
  LEASEFAIR-02 ci-disjoint-strict. These are outside the changed fixture
  cases; no baseline attribution or repair is claimed. The incomplete run
  is retained as a host qualification limitation, not full-suite evidence.
  [Machine-readable incomplete-run counts](evidence/LAC-2145/full-node26-incomplete.json)
  preserve this result.

Full Node 22/26 Linux CI and a settled cross-model review of the
published head remain merge gates. Source qualification authorizes no runtime
restart, production probe, DB/lease/job mutation, incident recovery claim or
merge bypass.
