# CLOSERWORKERID-01

## Summary

Every new closer intent appends its random dispatch-key suffix to the PR/head
worker ID. Retries preserve the preceding launch's identity for custody checks
and cleanup, while provisioning uses a distinct directory.

A terminal predecessor and its complete terminal retry chain release closure
ownership independently of directory teardown. Retained native evidence cannot
turn that ended launch back into a live owner. Live, parked, unreadable and
replacement owners retain their existing fences; successful merge receipts stay
sticky. Head matching, review findings and merge eligibility are unchanged.
An existing head-matched exact-head review request reaches normal admission
after terminal custody resolves, ahead of another closer retry. Holds, safety,
live owners and retry ceilings retain precedence.

Final comment-only remediation uses the stored predecessor worker suffix for
filesystem, liveness and reclaim probes when launch receipts are absent. Live
or unknown evidence restores the unchanged predecessor lease, including its
slot identity, across repeated ticks. The reviewed head already contained the
`.live` guard, unknown-custody deferral and `noAmaDispatch` return; regression
coverage verifies those paths without reinstating obsolete code.

## Interface changes

Closer worker IDs now always include a random attempt suffix. No new flags,
configuration keys, lifecycle values or merge authority.

## Verification

Individual bounded offline test files: `ama-closer-dispatch-priority.test.mjs`
and `closer-next-action.test.mjs`; the watcher claim-loop, contract typecheck,
targeted ESLint and offline research walkthrough also validate the change.
Final observed counts are recorded in the PR acceptance evidence.
Added offline cases cover receipt-less suffixed predecessors with running,
unavailable and failed worker evidence, including repeated deferrals and
terminal replacement without teardown.
Existing PR-head CI exposed two retry-cap fixtures still expecting unsuffixed
worker IDs and a stale dispatch state projection. The fixtures now assert the
attempt suffix and matching persisted identity; the reviewed projection is
refreshed without changing the state graph or smoke commands.

Final-round validation: `node test/run-tests.mjs
test/ama-closer-dispatch-priority.test.mjs test/closer-next-action.test.mjs
test/watcher-claim-loop.test.mjs test/ama-hammer-retry-cap.test.mjs
test/smv.test.mjs` passed all 811 tests under the 300-second bounded runner.
`npm run lint` passed with zero errors (149 existing warnings),
`npm run typecheck:contracts` passed,
`node scripts/validate-data-model-catalog.mjs` validated 93 entries, and
`bash demo/research-finding-walkthrough.sh` passed with byte-stable deliveries.
The full suite remains the PR-head CI merge gate.

After deployment, the runtime owner verifies consumer PID start times and natural
same-head retries, with no directory collision and a successor closer or queued
re-review within one pass. Fixture tests do not establish runtime activation.
