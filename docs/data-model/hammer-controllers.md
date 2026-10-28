# Data Model — Hammer Controller Registrations

**Owner:** versioned closer controller (`src/ama/hammer-controller.mjs`)
**Source of truth:** `src/ama/hammer-controller.mjs`
**Store:** `<HAM_RUN_DIR>/controller-<uuid>.json`, mode 0600

Before any dispatch read, the controller loads
`<hq-root>/dispatch/<own-lrq>/env-contract.json`, resolving `HAM_HQ_ROOT`
before the standard `HQ_ROOT` / `AGENT_OS_HQ_ROOT` / home-directory fallback.
It requires `launchProvenance.launchRequestId` to match its unambiguous launch identity.
It replaces any caller-exported `ADVERSARIAL_DISPATCH_READS_ENABLED` with the
value in that adapter-owned record. Missing, malformed or foreign records
refuse startup; absent or non-string/non-`"1"` activation remains disabled by
the unchanged reader. This file supplies environment provenance only: launch
status still comes exclusively from the SDK/HCP own-launch read. The Agent OS
adapter records and explicitly delivers `"1"` for reviewed hammer classes
before spawn. No controller registration fields or lifecycle states change.
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
unreadable launch read up to three times within that window; a terminal or
parked start read, or an unreadable process census, refuses execution at once.

Lease acquisition and the merge click call `assert-launch`: the ownership
checks of `assert-owner`, then a `launch:<pid>:<nonce>` request on FD 4. The controller
answers `clear` only when its newest permitted read started no longer ago than
one poll interval plus that read's timeout. Otherwise it first takes fresh reads
(up to three, counting an already in-flight read as the first attempt). The gate
freezes its per-read timeout at the greater of the current load-aware timeout and
the latest read timeout. Its deadline allows three such reads plus census polling
slack, with `LAUNCH_GATE_WAIT_MS` (60 seconds) as a floor. A read admitted before
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
