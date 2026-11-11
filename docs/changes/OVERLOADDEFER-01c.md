# OVERLOADDEFER-01c

## Summary

Mirror `worker_pool.overload_deferral.minimum_multiplier` (default 2, range
2–20) in the strict Node CFG loader. The independent v1 overload adapter now
requires this threshold; a clipped wait or a small load adjustment alone does
not park a hammer helper or refund overload retry debt. Receipt ownership,
wire shape, bounded retries and exhaustion are unchanged. Companion agent-os
changes repair rescue's capped dispatch budget and defer workspace provision
to the existing admission materializer. SRE verifies a normal-load rescue
closer after both repositories deploy; the worker makes no live changes.

Final review remediation corrects the internal schema option to the canonical
`__enforceMax` spelling. The existing upper-bound rejection remains unchanged.
The isolated hammer-helper audit-failure fixture supplies a default-returning
config loader for the overload adapter's new dependency, so it reaches the
intended missing-audit diagnostic and preserves exit 76.

## Interface changes

The configuration mirror above is unchanged by remediation; no additional
public interface, durable state or lifecycle change.

## Verification

- `node --test test/config-loader-foreign-sections.test.mjs test/overload-deferral.test.mjs` — passed.
- `node --test test/hammer-helper-launch.test.mjs` — all seven fixture checks passed.
- `npm run lint` — passed with zero errors (existing warnings).
- `npm run typecheck:contracts` — passed.
- `bash demo/research-finding-walkthrough.sh` — passed with byte-stable deliveries.
- Full-suite validation remains owned by PR-head CI.
