# RESCUEALERTENV-01

## Summary

An overdue custody-evidence alert can fail without interrupting closer
admission. A failed enqueue refunds the page reservation, so a later pass can
retry the alert.

## Interface changes

The closer result and its dispatch audit can include `alertDelivery` with
`delivered: false` and a reason of `alert-routing-unconfigured` or
`alert-delivery-failed`. Alert enqueue uses `ALERT_TO` when present. With a
service-account token it otherwise selects the first trimmed `op://` reference
from `ADVERSARIAL_REVIEW_ALERT_TO_OP_REF` and `ALERT_TO_OP_REF`, in that order.
A malformed primary override does not mask a valid fallback reference.
The shared 1Password helper has a five-second read
deadline. The process shares concurrent lookups and caches successful and
unavailable routes for 15 minutes. A rate limit suppresses new reads for the
same credential for the helper’s configured cooldown. The drain redacts
literal and `encodeURIComponent`-encoded recipients in transport failures.

## Verification

The pre-fix synthetic closer fixture reproduced `ALERT_TO must be configured
for alert delivery`. The successful alert stub let the closer launch.

- `node --test test/alert-delivery.test.mjs` passed 97 tests.
- `node --test test/ama-closer-dispatch-priority.test.mjs` passed 345 tests,
  including the launch after failed delivery, the audit reason and the page
  reservation refund.
- `npm run lint` reported zero errors. `npm run typecheck:contracts` passed.

Test commands used netguard and a 600-second process-group bound.

The follow-up passed all 100 alert-delivery tests via `node test/run-tests.mjs
test/alert-delivery.test.mjs` and both `RESCUEALERTENV-01` closer cases in the
same runner with a name filter.

The final comment-only remediation reproduced the malformed-override failure
with its new regression before the fix. After the fix,
`node test/run-tests.mjs test/alert-delivery.test.mjs
test/alert-delivery-timeout.test.mjs` passed all 120 tests, including fallback
selection with surrounding whitespace, valid-primary precedence, and refusal
when no valid route exists. `npm run lint` passed with zero errors (147 existing
warnings), `npm run typecheck:contracts` passed, and
`bash demo/research-finding-walkthrough.sh` passed. These commands ran through
`bin/run-bounded.sh`; the full local suite was not run.

[SEV2 report](../postmortems/SEV2-rescue-closer-blocked-by-alert-routing-2026-11-27.md)
