# CLOSERFALLBACKFAILOPEN-01

## Summary

A closer harness-fallback resolver error no longer dispatches the primary class
when the primary's provider is known to be hard-stopped. The call site
(`maybeDispatchAmaCloser`) and the merge-agent resolver now call
`resolveHarnessAfterResolverError` (`src/ama/harness-fallback.mjs`). It reads
only the persisted last-good quota snapshot
(`data/ama-closer-quota-snapshot.json`, at most ten minutes old), never the
dispatch-read path that just failed.

| Persisted primary state | Closer decision |
|---|---|
| exhausted, suspended or soft-grounded | first configured fallback whose provider is not grounded |
| grounded, every fallback grounded | defer (`hold`), retried next pass |
| no readable snapshot, or a stale one | defer (`harness-hold:harness-fallback-resolver-error`) |
| healthy, not tracked, or no status row | keep the primary, as before |

The decision and the resolver's error text are logged as
`ama_closer.harness_fallback_resolver_error` (warn). The merge-agent keeps its
documented contract: an unreadable state still fails open there; a grounded
snapshot takes the fallback or defers as `merge-agent-harness-grounded`. Model-only
caps are not screened on this path, because the governed registry may be the
fault.

The companion agent-os change lets admission re-route a queued closer held for
an operator-sourced quota stop to its declared fallback. No config key,
persistent store or lifecycle state changes.
