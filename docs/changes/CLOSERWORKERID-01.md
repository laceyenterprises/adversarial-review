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

## Interface changes

Closer worker IDs now always include a random attempt suffix. No new flags,
configuration keys, lifecycle values or merge authority.

## Verification

Individual bounded offline test files: `ama-closer-dispatch-priority.test.mjs`
and `closer-next-action.test.mjs`; the watcher claim-loop, contract typecheck,
targeted ESLint and offline research walkthrough also validate the change.
Final observed counts are recorded in the PR acceptance evidence.

After deployment, the runtime owner verifies consumer PID start times and natural
same-head retries, with no directory collision and a successor closer or queued
re-review within one pass. Fixture tests do not establish runtime activation.
