# Data Model — Hammer Controller Registrations

**Owner:** versioned closer controller (`src/ama/hammer-controller.mjs`)
**Store:** `<HAM_RUN_DIR>/controller-<uuid>.json`, mode 0600
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
timeout, or terminal/parked/unreadable exact-launch evidence starts stopping.
The controller reads through the existing bounded session-ledger adapter and
producer status vocabulary, at one-second intervals with a two-second read
deadline. It does not adopt a successor LRQ or follow retries to authorize the
old process. A failed initial launch read or process census refuses execution.

Final receipts add `reason`, `finishedAt`, `termSent`, `killSent`, `drained`,
and `leaseCleanup`; `probeError`, `signalError`, or `errorCode` record bounded
error codes without process commands, environment contents or credentials.
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
PID and `ps lstart` birth must still match before another group signal. A fresh
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
