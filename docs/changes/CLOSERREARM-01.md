# CLOSERREARM-01

## Summary

A newer authoritative exact-head review can supersede terminal closer history
when the remaining-retry branch would otherwise dispatch another hammer.
Selection reuses the existing daemon-only supersession rule. All live merge
predicates, strict-mode finding policy, attestation and lease checks remain.
Fixtures use synthetic repositories, heads and audit records.

Final comment-only remediation clarifies that unsuccessful supersession retains
the original stop or retry owner and action: R07 keeps closure-recovery ownership,
while R08 keeps hammer dispatch ownership.

## Interface changes

No new configuration, labels, checks or durable lifecycle states. The next-action
decision records the existing supersession evidence refs for R08 retries too.

## Verification

Each file ran separately through `cwp_dispatch.worker_validation`, with a
600-second bound and netguard:

- `node --test test/pr-next-action.test.mjs`: 283 passed.
- `node --test test/watcher-daemon-clean-merge.test.mjs`: 125 passed.
- `node --test test/watcher-claim-loop.test.mjs`: 161 passed.
- `npm run lint`: zero errors (152 existing warnings).
- `npm run typecheck:contracts`: passed.
- `bash demo/research-finding-walkthrough.sh`: passed, three byte-stable deliveries.

The full suite was not run on the host, as required by the dispatch.

Final comment-only documentation remediation re-ran the focused next-action
suite (283 passed), lint (zero errors, 152 existing warnings), contract typecheck
and offline walkthrough (three byte-stable deliveries); all passed using the
bounded runner with a 120-second limit per command. `git diff --check` also passed.

After ordinary deployment and the separately authorized service restart, SRE
must retain a natural terminal-stop → fresh clean exact-head review → daemon
merge receipt without a human merge. The companion rescue must report either
its merge action or a concrete reason and owner.
