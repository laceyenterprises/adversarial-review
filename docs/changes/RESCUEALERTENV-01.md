# RESCUEALERTENV-01

## Summary

An overdue custody-evidence alert can fail without interrupting closer
admission. A failed enqueue refunds the page reservation, so a later pass can
retry the alert.

## Interface changes

The closer result and its dispatch audit can include `alertDelivery` with
`delivered: false` and a reason of `alert-routing-unconfigured` or
`alert-delivery-failed`. Alert enqueue uses `ALERT_TO` when present. Otherwise
it resolves `ADVERSARIAL_REVIEW_ALERT_TO_OP_REF` or `ALERT_TO_OP_REF` through
the watcher’s shared 1Password helper with a five-second deadline.

## Verification

The pre-fix synthetic closer fixture reproduced `ALERT_TO must be configured
for alert delivery`. The successful alert stub let the closer launch.

- `node --test test/alert-delivery.test.mjs` passed 97 tests.
- `node --test test/ama-closer-dispatch-priority.test.mjs` passed 345 tests,
  including the launch after failed delivery, the audit reason and the page
  reservation refund.
- `npm run lint` reported zero errors. `npm run typecheck:contracts` passed.

Test commands used netguard and a 600-second process-group bound.
[SEV2 report](../postmortems/SEV2-rescue-closer-blocked-by-alert-routing-2026-11-27.md)
