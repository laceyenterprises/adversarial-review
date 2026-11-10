# OVERLOADDEFER-01b

## Summary

The existing watcher now owns launch-less rescue overload receipts on startup
and a 30-second recovery timer. One bounded child at a time re-enters ordinary
rescue with only repo/PR identity, using fair selection so failed observations
cannot starve other due PRs. Disk receipts survive watcher restart. No new
daemon, configuration, CI check or merge predicate is introduced.

The AMA pass now emits one structured PR/head alert with phase/load evidence
at the helper deferral cap, archives `lastOverloadDeferral` and releases the
overload hold to ordinary closer selection. The archive survives replacement
launches and prevents further overload refunds. Ordinary attempt/lifetime/target
caps, leases, head matching, attestation and strict mode remain authoritative.

## Interface changes

The companion Agent OS entrypoint
`hq merge-agent rescue --apply --retry-overload-only` inspects current
head/review/holds/writers and reconciles the original key before replay or
release. Changed intent leaves fresh work to normal selection. The watcher
also observes legacy exhausted receipts with null retry times. Deploy the
companion before activating this watcher revision.

## Verification

Individual offline files run through the repository runner under netguard
with 600-second process-group bounds: overload retry scheduling, overload
wire/ledger behavior, real closer dispatch cap/backoff, and watcher claim-loop
regressions. ESLint, contract typecheck and the research byte-equivalence demo
qualify the source. No live rescue, dispatch or service restart is performed.

After both revisions deploy and the review-service float/watcher restart,
SRE retains deployed SHAs and watcher PID/start time. A naturally deferred
rescue receipt must advance or launch within one retry interval; affected PRs
must acquire a closer or released owner without manual pumping. The committed
operator handoff records that acceptance; source tests do not establish it.
