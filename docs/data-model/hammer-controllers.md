# Data Model — Hammer Controller Registrations

**Owner:** versioned closer controller (`src/ama/hammer-controller.mjs`)
**Source of truth:** `src/ama/hammer-controller.mjs`
**Store:** `<HAM_RUN_DIR>/controller-<uuid>.json`, mode 0600

Before any dispatch read, the controller loads
`<hq-root>/dispatch/<own-lrq>/env-contract.json`, resolving `HAM_HQ_ROOT`
before the standard `HQ_ROOT` / `AGENT_OS_HQ_ROOT` / home-directory fallback.
It requires `launchProvenance.launchRequestId` to match its unambiguous launch identity.
It replaces any caller-exported `ADVERSARIAL_DISPATCH_READS_ENABLED` with the
value in that adapter-owned record. A failed dispatch-file lookup is retried
with spaced backoff (`LAUNCH_READ_BACKOFF_MS`: 2, 5, 10, 20, then 30 seconds),
each wait capped so no lookup starts after `LAUNCH_UNREADABLE_GRACE_MS`; every
lookup gets a fresh `launchReadTimeoutMs()` budget (HAMMERLAUNCHREAD-01).
Exhausted lookup (`launch-environment-read-unavailable` before work,
`launch-environment-read-unavailable-at-closure` from a closing `run` with no
kept receipt) and absent legacy
`launchEnvironment` (`launch-environment-missing-legacy-dispatch`) refuse
startup with exit 75 and a deferred launch-bound audit under the existing
VERIFYHEADTRANSIENT-01 retry/refund contract. A present malformed activation
(`controller-launch-environment-malformed`) or foreign identity
(`controller-launch-environment-identity-unconfirmed`) hard-stops with exit 125.
Retryable startup failures emit no `terminal-stop` progress receipt; malformed
or foreign startup failures retain that final receipt. No receipt field changes.
Absent or non-string/non-`"1"` activation in the adapter file remains disabled by
the unchanged reader. This file supplies environment provenance only: launch
status still comes exclusively from the SDK/HCP own-launch read. The Agent OS
adapter records and explicitly delivers `"1"` for reviewed hammer classes
before spawn. No controller registration fields or lifecycle states change.
## Launch environment receipt (HAMMERLAUNCHREAD-01)

**Store:** `<HAM_RUN_DIR>/launch-environment-<own-lrq>.json`, mode 0600, written
once (atomic link, never overwritten).
**Writer:** `bin/hammer-controller.mjs resolve-environment`, which the hammer
prompt runs right after its one-time `inputs.sh` initialization, before any
remediation or validation. **Reader:** the same verb on rerun, and the closing
`run`, which uses it instead of a fresh dispatch-file lookup.

Version 1 fields: `schemaVersion` (1), exact `launchRequestId`, boolean
`dispatchReadsEnabled` (the confirmed adapter activation) and ISO `resolvedAt`.
It holds no credential, transport output or path. It is written only after the
identity, legacy and malformed checks above pass. A receipt that cannot be
parsed, has another schema version or a non-boolean value refuses
`controller-launch-environment-malformed`; one whose `launchRequestId` differs
from the file's launch refuses `controller-launch-environment-identity-unconfirmed`.
Neither is repaired from a fresh read. An absent receipt is not an error: the
closing `run` falls back to the spaced lookup. If the receipt cannot be written,
the early step still succeeds (`source: read-unkept`) and keeps nothing. The run directory is the same
private directory that holds the deployed phase scripts, so the receipt adds no
new trust boundary. The activation is launch provenance and cannot change
during a launch, so a kept value is never stale for its own launch.

**Entrypoint:** `bin/hammer-controller.mjs run <script> [args...]`

Each invocation creates an independent registration before releasing its Bash
child to execute the closure script. This is local process ownership evidence,
not an HQ worker row, merge attestation or replacement for the HQ launch record.
The controller preserves the existing HQ LRQ/spawn environment markers so the
canonical terminal-worker sweep retains its attribution. It never edits HQ
queues, worker leases or the session ledger.
Nested controllers are refused. Lease/validator admission requires the actual
caller PGID to match the registered shell, as well as its parent and generation;
copying the environment into another detached group does not enroll that group.

Version 1 fields: `schemaVersion`, random `token`, exact `launchRequestId`,
`controllerPid`, isolated `shellPid` (also the PGID), ISO `startedAt`, and `state`.
States are `running`, `stopping`, `quiescent`, and `cleanup-unconfirmed`.
Normal shell exit, TERM/INT/HUP/ALRM, the absolute two-hour ceiling, validator
timeout, or terminal/parked/foreign exact-launch evidence starts stopping.
The controller reads through the bounded SDK dispatch lookup adapter and
producer status vocabulary every 10 seconds (`LAUNCH_POLL_MS`, never load
scaled), one read at a time and without blocking the one-second process census.
Each read uses the adapter's load-aware timeout and a bounded caller abort
signal. SDK 0.9.0 may retain its HTTP request until its transport deadline after
caller cancellation. Dispatch reads require `ADVERSARIAL_DISPATCH_READS_ENABLED=1`
in the controller environment after the verified producer release and grants are live. A readable terminal, parked or foreign row stops at once (`launch-ended`).
A failed read (timeout, spawn error, unreadable target) is recorded and the
round continues; it stops with `launch-unreadable` only after
`LAUNCH_UNREADABLE_GRACE_MS` (120 seconds, widened to the poll plus two read
timeouts under load) passes with no permitted read and the latest completed read
was unreadable. Elapsed time alone, including a delayed controller poll while
all launch reads succeed, cannot trigger that reason (HAMVALTIMEOUTFLAKE-01).
A validator timeout still cancels the registered group as `validation-stopped`
and permits no validation audit. It does not adopt a successor LRQ or follow
retries to authorize the old process. Start retries an
unreadable launch read up to three times within that window, waiting 2 then 5
seconds between attempts (capped by the window); a terminal or
parked start read, or an unreadable process census, refuses execution at once.

Lease acquisition and the merge click call `assert-launch`: the ownership
checks of `assert-owner`, then a `launch:<pid>:<nonce>` request on FD 4. The controller
answers `clear` only when its newest permitted read started no longer ago than
one poll interval plus that read's timeout. Otherwise it first takes fresh reads
(up to three, counting an already in-flight read as the first attempt, and
waiting 2 then 5 seconds after a failed one). The gate
freezes its per-read timeout at the greater of the current load-aware timeout and
the latest read timeout. Its deadline allows three such reads plus census polling
slack and those two waits, with `LAUNCH_GATE_WAIT_MS` (60 seconds) as a floor. A read admitted before
that deadline may finish; no new read starts after it. The unreadable grace waits
for this bounded gate budget before stopping the round, while terminal evidence,
signals and the absolute controller ceiling still stop it immediately. Exhausted
or expired unreadable gates answer `blocked`; a blocked step refuses.

The controller first sends `wait:<nonce>:<socket-timeout-ms>` to advertise the
gate budget plus one admitted read and ten seconds of transport/census slack.
The caller adjusts its socket timeout to that budget. Final replies are
`clear:<nonce>` or `blocked:<nonce>`. Validator completion uses
`complete:<pid>:<nonce>` with the same correlated final replies and its existing
ten-second timeout. Each caller generates a UUID nonce and discards replies for
other requests, including late replies left by a timed-out predecessor. Missing
or malformed matching replies fail closed. This changes no receipt fields.

Final receipts add `reason`, `finishedAt`, `termSent`, `killSent`, `drained`,
and `leaseCleanup`; `probeError`, `signalError`, or `errorCode` record bounded
error codes without process commands, environment contents or credentials.
Every write carries `launchReadFailures`, `launchReadFirstFailureAt` and
`launchReadLastError` (a bounded reason or error code), so a no-merge audit can
tell a transient read from a real cancellation.
`launchReadSource` records `app-sdk` for a successful SDK read, or null
when unavailable. The contained controller uses its own-LRQ HCP token; app
reads use provisioned project/repository grants. Launch reads never resolve
canonical or standby database settings.
Only the source label is stored; connection DSNs, credentials and paths are
never copied into the registration. Older version 1 receipts omit this field.
`directTermSent` / `directKillSent` identify a direct-child-only fallback when
the census becomes unreadable; they do not certify descendant drain.
Bootstrap errors retain `cleanup-unconfirmed` and their error code even when
the direct child has been stopped. No terminal launch flag establishes drain.

Validators under the registered shell share its process group. The inherited
private FD 4 carries a validator timeout/cancellation request to the controller.
On ordinary test completion the same pipe requires a controller acknowledgement
that only the shell and validator runner remain in the group. Background test
descendants refuse validation and cancel the round, including when they closed
their output pipes. Missing acknowledgement fails closed.
The standalone bounded runner retains its original isolated-group behavior.
The controller signals only its witnessed group; after leader exit a member's
PID and provider birth must still match before another group signal. Darwin
uses exact kernel seconds/microseconds from the `kern.proc.pgrp` sysctl (the
start time `ps lstart` prints to the second); other hosts retain `ps lstart`.
One census helper serves the whole round on Darwin and answers each tick with a
new kernel read (QCP-08). CENSUSEIO-01 adds `censusFailure` containing the latest
failed series' request count, kernel attempts (one per unreported request), elapsed
milliseconds and last errno. After readiness, up to three consecutive failed
requests retry within a load-aware nominal ten-second window; pending validation
and merge gates await a readable snapshot. An admitted read may finish beyond
that window. Exhaustion retains `reason: process-probe-unreadable` and adds
`reasonDetail: { reason, requests, attempts, elapsedMs, lastErrno }` captured at
exhaustion. Failure metadata grants no signal or lease-release authority.
The provider remains fixed for an invocation; no denied probe becomes an empty
census or a weaker identity match. A fresh
group census must confirm no live members (zombies excluded) before `quiescent`.
Unknown or reused identities never authorize a group signal. TERM gets two
seconds, KILL another second for drain. Unconfirmed cleanup returns 125,
retains scratch and leaves canonical HQ cleanup responsible for survivors.

Cancellation defers the shell's lease-release trap to the outer controller.
After confirmed drain, fallback cleanup reads `merge-lease-acquire.json` and
requires acquired=true, this invocation's shell PID, repository/PR, and an
acquisition timestamp no earlier than controller start. The live holder must
match local host, PID, PR, head, lease ID and acquisition timestamp. Release
uses the existing per-base mutation lock and full generation fence. A successor
or unrelated holder is preserved; unknown drain cannot inspect or release one.
Normal in-run releases for CI waits still use the existing shell function.

There is no new reaper, timer-based receipt deletion or HQ cancellation API.
Existing private-scratch cleanup owns eventual removal. Controller SIGKILL,
loss of its host, or intentional group escape still needs canonical HQ teardown;
this PR does not certify HQ's synchronous cancel acknowledgement as quiescence.
Any HQ-level acknowledgement change belongs in a separate Agent OS follow-up.

## Local validation receipt

**Source of truth:** `bin/hammer-validate.mjs` and `bin/hammer-ci-mirror-validation.py`
**Store:** `<HAM_RUN_DIR>/local-validation.*`, adjacent
`*.check-*.log`, and `<HAM_RUN_DIR>/close-result.json`; standalone evidence
uses `<HAM_RUN_DIR or system tmp>/ham-validation-evidence-*/local-validation.json`
and adjacent `*.check-*.log`. An exact-head canonical deferral additionally
writes `<HAM_RUN_DIR>/validation-deferred-<head>.json`.

The closing controller starts a private `local-validation.*` receipt for each
outside-lease validation attempt. It embeds the receipts from that invocation
in `close-result.json` under `localValidation`. An empty array means the
controller has no receipt for that invocation.

| Field | Meaning |
|---|---|
| `schemaVersion` | `1` |
| `head` | Full commit SHA captured before the local validation stage |
| `status` | Runner exit code for UNKNOWN, otherwise the validator exit code |
| `selectedCheckCount` | Optional, the complete mirror selection size recorded before the first check |
| `selectionSizeReason` | `selection-size-unavailable` when the mirror lacks a hook exposing the full selection before execution. UNKNOWN cannot use CI continuation on that receipt. |
| `coverage` | Optional authenticated mapping identity with repository, PR, head and base |
| `outcome` | `harness-fault:socket-path` identifies a counted socket stop at exit 75. `node-pin-unavailable` / `node-pin-undeclared` identify Node-pin UNKNOWN results. Hard pin stops use validator status 80/81; the controller also decodes those statuses without a receipt, normalizes close status to 78 and audits the reason. |
| `socketPathDiagnostic` | Present with the socket outcome. Records the over-budget temp root and byte budget for setup refusals, or the allocated scratch path for runtime failures. |
| `checks` | Ordered records with check name, status and reason, plus local result or exit status when available |
| `checks[].commandSha256` | SHA-256 of the selected command |
| `checks[].manifest` / `manifestSha256` | Optional manifest path and digest for the authenticated check mapping |
| `checks[].jobs` | For `ci-covered`, each declared job's `name` and GitHub Actions `runId` (strings); current step mappings also include string `jobId` and the exact `step` name. Legacy job mappings and older receipts omit these optional fields. |
| `checks[].socketPathFault` | Optional flag set to `true` by the mirror when a single failed command's only nonblank output is a supported socket diagnostic. |
| `checks[].localReason` | Optional local check reason. `harness-fault:socket-path` accompanies an inconclusive result when all failed mirror checks qualify for the socket stop. |
| `checks[].diagnostics` | Optional ordered diagnostics for a check that did not pass or was interrupted |
| `checks[].diagnostics[].path` | Private combined stdout/stderr file beside the original validation receipt |
| `checks[].diagnostics[].limitBytes` | Maximum retained bytes per command, currently 4 MiB |
| `checks[].diagnostics[].exitStatus` | Raw command result when observed |
| `checks[].diagnostics[].truncated` / `unavailable` | Output exceeded the cap or the writer could not retain a complete bounded file |

Per-check statuses include `run`, `ci-covered`, `failed`, `interrupted` and `not-run`. Runners
without per-check reporting produce a battery-level record. The controller
uses these receipts for diagnosis. `run` without a result means the check
was in flight when that receipt was persisted. A cancellation can leave
`status` unset and a partial diagnostic without an exit status. Use the
original receipt if no `close-result.json` was written. Completed passing
checks drop their logs. Standalone canonical mirror runs without a caller
receipt print the path to a private evidence directory separate from their
disposable validation scratch.

The create-once deferral receipt has `schemaVersion: 1`, exact `head`,
`outcome: deferred`, `validation: unknown`, bounded `reason` and original
`status`. It points to `localValidationReceipt` when available. `cleanupOwner`
is `controller` or `bounded-command`. For ordinary validation, confirm cleanup
from that owner's record or output. MRQ-20 adds
`ciAuthoritative` (boolean), `requiredContexts` (the declared exact-head
contexts the UNKNOWN would defer to, possibly empty) and `localFailureObserved`
(a failed mirror check row or a TAP `not ok` line was seen before the stop).
CI continuation requires `cleanup: finished`, `localFailureObserved: false`,
an eligible reason under current policy, and a final check receipt without a
failed row or a typed process-inspection refusal. HAMCIAUTH-01 records
`cleanCheckout` on every deferral (the battery
started and ended on a clean checkout at this exact head) and requires it in
place of `coverageComplete`, which still records whether every selected check
passed. Receipts written before that rule continue only with
`coverageComplete: true`. A controller-owned stop records `cleanup:
controller-owned`. After the controller certifies drain, the close command
rewrites the receipt with `cleanup: finished` and the re-judged
`ciAuthoritative`.
HAMNODEPIN-01 also permits reason `node-pin-unavailable` for a skipped canonical
battery on a clean exact committed head with declared contexts. Its check row is
`interrupted` / `inconclusive`, `coverageComplete` is false, and the original
deferral status is 75. No child was started, so standalone cleanup is finished;
controller runs still require whole-round drain. A drained `shell-exited` round
can finalize this reason just as it can a killed battery. A missing declaration
(`node-pin-undeclared`) never qualifies. Missing identity/configuration and
unreadable declarations keep their infrastructure or world stop rather than
using this installed-runtime exception.
Unqualified or unreadable receipts return 75 before another battery on that head.
Exact-head merge still requires all declared GitHub contexts to be green. The
[HQ custody store](deferred-source-custody.md) retains evidence beyond run scratch.

For a completed conflict repair, `cleanCheckout` covers its exact rebased head.
Its private `conflict-repair-publish.env` binds source, head and branch. New
bindings also record the exact rebase base for deferred bundle prerequisites.
`cleanupConfirmed` records drain when the validator can confirm it directly.
Inside the controller, a finished runner can return a budget or load stop
before the controller has drained the round. Those receipts remain
controller-owned until the same launch's supervisor records cleanup.
Close, queue publication and the legacy merge gate reread the referenced
exact-head check receipt before reusing a CI-authoritative UNKNOWN. Receipts
that record `cleanCheckout` require that reference. Legacy receipts with
`coverageComplete: true` can still be reused when they omit it.
Otherwise `controllerRecord` names the launch-bound registration. The launcher
re-reads the conflict binding after an interrupted round or explicit
local-validation deferral. It checks drain, lease disposition and final
per-check evidence before allowing one fresh round to publish through the
bound source lease. A passing pre-publish
battery or qualifying UNKNOWN is reused on the same published head. A clean,
drained repair without declared contexts can publish and
hand off to watcher backoff, with merge still blocked. Local failure, unreadable
check evidence or unconfirmed cleanup blocks the UNKNOWN publication route.

Retention belongs to the caller/run-directory owner. Passing checks delete their
command logs immediately. Failed or interrupted diagnostic files remain with
their receipt until diagnosis is complete; after confirmed process drain and
collection of needed incident evidence, remove the receipt/log pairs with their
private run directory. A standalone caller removes the printed
`ham-validation-evidence-*` directory under the same conditions. There is no
automatic expiry or aggregate byte cap; each command can retain 4 MiB. Do not
delete files while process drain is unconfirmed.

Each validator owns a mode-0700 `ar-hv-<8 hex>` directory in the canonical
`/tmp` parent (`/private/tmp` on Darwin) or a budget-checked caller temp
parent. Its mode-0600 `.validator-pid` records the validator PID. Confirmed
cleanup removes both. Exit 125, interruption or failed deletion can leave
scratch for the same uid's orphan reaper. A candidate must be at least 24
hours old, have no live recorded validator and pass the environment and
working-directory process census. The mode-0600 `.ar-hv-reap-<uid>` marker
in each selected parent persists across runs and gates scan attempts to
once per hour, including attempts with an unavailable census.
