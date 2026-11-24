# MLRQUEUECOMP-01 queue-v2 production composition

## Change notes

### Summary

The watcher advances the existing queue only for a configured whole lane with a
matching durable transfer. Clean reviews and hammer handoffs enter the same FIFO.
A hammer acknowledgement is bound to the exact published head, the authenticated
review evidence and the recorded closer launch. The queue owns candidate checks,
expected-head squash, and the existing accounting and audit outbox.

### Interface changes

The closer uses the internal `bin/finalization-queue-handoff.mjs` receiver. The
receiver validates both the selector and the dispatched route generation. It
keeps the original signed source review and the service-signed observation of
the launch-bound hammer audit. Configuration uses the existing `lane_routes`
selector and execution brake. No selector values are added by default.

A branch with an unreadable rule set or an unsupported GitHub-native merge queue
or required workflow remains pending. Unresolved push or merge intents retain
operator drain and reconciliation ownership under the existing transfer port.

The watcher spaces parked admission probes one minute apart using durable
progress time and records original patience expiry without a live read.
Hammer handoffs retain unresolved advisory findings as `deferred` when the
effective policy explicitly disables strict non-blocking remediation.

The production merge adapter binds `GH_TOKEN` to the verified installation
token. The watcher passes the validated repository and base to the lane
resolver. For same-name checks with multiple required App sources, the queue
requires each source's latest result.

Final Hammer remediation also accepts ruleset-only protection when GitHub
omits classic protection and returns 404 for that endpoint. The watcher parks
its fence immediately after an ambiguous mutation, preserving the intent for
reconciliation before takeover. Completed admissions expose the same queue
entry shape for both intake paths, and the handoff receiver accepts files up to
1 MiB. Queue subprocesses explicitly bind the entitled token, and the watcher
logs bounded, redacted tick errors.

The final advisory verification retains all eleven Hammer dispositions. New
production fixtures prove that a suspended admission permits exclusive repository
recovery, a stalled tick warns once at its threshold, and lifting an expired hold
permits a new clean generation to merge exactly once while delivering the expiry
page. The canary runbook now describes those runtime signals, the signer path,
unsupported status pins, and the limits of automatic write reconciliation.
There is no additional runtime interface or persistent schema change.

The Node 26 run on the original remediation head reached the suite deadline
with 115 files still queued and no failed assertions in the reported TAP.
Queue tests now copy fixture seeds without unused Git templates or receiver
auto-GC. The queue's isolated Git fetches avoid automatic maintenance, and
no-op preparation uses the source proof once the checked-out head and base
match it. Later verification still recomputes the proof. Full ledger replay
folds into a fresh projection directly, while replay from a supplied snapshot
still clones that snapshot.

### Verification

Synthetic fixtures use disposable Git repositories and SQLite stores with
injected GitHub, broker, signature and delivery evidence. The runtime owner
uses the existing read-only canary probe after reviewed deployment and keeps
separate evidence of loaded services, effective route and organic entries.

The focused production, handoff and admission suites passed 122 tests.
`node scripts/validate-data-model-catalog.mjs` validated 103 entries.

Hammer canonical changed-surface validation passed 337 tests in 12 files.
`npm run lint` reported zero errors. `npm run typecheck:contracts` and
`bash demo/research-finding-walkthrough.sh` passed.

On Node 26.10.0, the repair's focused `node test/run-tests.mjs` run passed
532 tests across 22 files, including queue Git, production composition,
admission, merge, and ledger replay. The no-op regression verifies that
preparation reads the patch once and a later verifier reads it independently.

The final comment-only round added direct assertions for both completed
handoff variants, including the persisted hammer receipt, and removed Git
and SQLite setup from the request-size test. The five focused queue test
files passed 150 tests on Node 26.10.0. The Node 22 full-suite run on the
preceding PR head and the run on its exact `main` base both reached the
900-second suite deadline.

The final advisory verification's production file passed 26 tests with
`bash bin/run-bounded.sh --timeout 60 -- node test/run-tests.mjs
test/finalization-queue-production.test.mjs`. GitHub run `45308751529` on the
preceding PR head timed out in Node 22 after 900 seconds; its Node 26 job passed.
The exact main base `f4452765f1f65c5994ca29f078c5a8df26747fb4` has the same
Node 22 timeout and passing Node 26 result in run `45270411460`. No CI workflow,
check, concurrency setting or deadline is changed for this baseline failure.

The seven focused production, admission, checks, owner, merge, execution-surface
and MRQ-21 files passed 183 tests under a 120-second bound. Repository lint
passed with zero errors (147 existing warnings), the changed test file passed
ESLint, contract typecheck and the offline byte-equivalence demo passed, and
the data-model validator accepted all 103 catalog entries. The full suite was
left to PR-head CI.

```sh
node src/finalization/queue-probe.mjs --capability canary --json
```

Follow the [whole-lane canary runbook](../finalization-queue-canary-runbook.md)
for the remaining operator observations and approval.
