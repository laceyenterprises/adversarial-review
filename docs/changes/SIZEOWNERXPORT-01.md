# SIZEOWNERXPORT-01

## Summary

The shrink-diff transport incident left oversized heads with a reserved PR
update because the dispatch subprocess ran out of time during provisioning.
Shrink-diff dispatch now returns after HQ admission and defers provisioning.

## Interface changes

The dispatch uses `--defer-provision` and shares the merge agent's load-aware
`follow_up.hq_dispatch_subprocess_timeout_ms` setting, which defaults to 90
seconds before scaling. Fast transient failures can retry with the same key.
A killed attempt ends the pass. The dispatch record and watcher warning
include subprocess status, elapsed time and bounded output tails.

## Verification

- Scoped `node --test` run with the local network guard passed 296 tests across
  three files, with one skip. Before the fix, the injected-kill regression
  reproduced three attempts and a generic command failure.
- `npm run lint` completed with zero errors, `npm run typecheck:contracts`
  passed, and `bash demo/research-finding-walkthrough.sh` reached its terminal
  state with three byte-stable deliveries.
