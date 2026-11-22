# HAMMERPOOLSTRICT-01

## Summary

The identity-token-pool config read now tolerates checked-in keys that belong
to a newer host config (warn once, drop, record) instead of throwing, so one new
host key can no longer hold every closer at `evidence-unknown`. A hold caused by
a config load error is now named `config-load-error` with the error class and
key path. Incident report: [`docs/INCIDENT-2026-11-22-HAMMERPOOLSTRICT-01.md`](../INCIDENT-2026-11-22-HAMMERPOOLSTRICT-01.md).

## Interface changes

- `loadConfigForIdentityTokenPool` passes `tolerateCheckedInUnknown: true`.
  Value validation and the pool/account/broker declarations stay strict.
- `selectWorkerTokenAccount` (and the pooled routing select wrapper) return
  `reason: 'config-load-error'` and `configLoadError: { errorClass, keyPath }`
  when the failure is an `AgentOSConfigError`; other faults keep
  `evidence-unknown`. The closer's `harness-hold:<reason>` and the
  `ama_closer.harness_resolution` event/audit `harnessResolution` carry both.
- `worker_pool.worktree_reuse.enabled` (boolean, default false) is a Node-only
  schema entry; nothing reads it.

## Verification

- `node --test test/hammerpoolstrict-01.test.mjs` — 10 pass; 3 of them fail
  with the loader change reverted.
- `node --test test/ama-closer-dispatch-priority.test.mjs` — 333 pass.
- `node --test test/config-cfg-parity.test.mjs test/config-identity-token-pools.test.mjs test/config-token-pool-migration.test.mjs test/config-ons07-rescue.test.mjs test/cloud-access-config.test.mjs test/cfg-promotion-watcher-knobs.test.mjs` — all pass.
- `test/worker-token-pool.test.mjs`: 16 failures, identical on an untouched
  archive of the base commit (pre-existing).
