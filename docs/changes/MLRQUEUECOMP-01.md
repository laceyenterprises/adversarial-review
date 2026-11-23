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

### Verification

Synthetic fixtures use disposable Git repositories and SQLite stores with
injected GitHub, broker, signature and delivery evidence. The runtime owner
uses the existing read-only canary probe after reviewed deployment and keeps
separate evidence of loaded services, effective route and organic entries.

The focused production, handoff and admission suites passed 122 tests.
`node scripts/validate-data-model-catalog.mjs` validated 103 entries.

```sh
node src/finalization/queue-probe.mjs --capability canary --json
```

Follow the [whole-lane canary runbook](../finalization-queue-canary-runbook.md)
for the remaining operator observations and approval.
