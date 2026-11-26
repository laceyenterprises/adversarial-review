# GHX-05 · Review service on the resolver

## Summary

The watcher, follow-up, reviewers and pipeline health collector use the Agent OS GitHub adapter to resolve credentials. PR operations pass the repository and role. Org enumeration uses the adapter's explicit owner target. A Rundix terminal read can use its installation even when the watcher has no process-level App identity pins.

## Interface changes

Both services check their roles against all configured organizations at boot. Failures page through the existing alert outbox once per role and owner. If service authentication is unavailable, GitHub-dependent work waits for the ordinary refresh loop. The launchers preserve configured reviewer PAT mode and broker mode uses the adapter. Twenty App and installation environment keys are removed from the watcher and follow-up plists. The Agent OS configuration schema is unchanged.

Alternate-org remediation publication still requires verified `contents:write` and, for workflow changes, `workflows:write`. GHX-03's token response carries App and installation metadata but no permission map, so that route remains held when permission evidence is absent. Delivering permission evidence is an Agent OS dependency outside this ticket.

## Verification

`node test/run-tests.mjs` passed 463 tests across 16 focused suites, and the watcher claim-loop suite passed. A separate follow-up suite comparison reproduced all 41 remaining fixture failures on `origin/main`. The real GHX-03 CLI resolved a Rundix terminal read and returned a boot identity failure against a local synthetic broker. ESLint completed with zero errors, contract types checked, ShellCheck accepted the Bash helper, zsh parsed the launchers, both plists passed `plutil`, and the walkthrough produced three byte-stable deliveries. GHX-07 owns live broker cutover verification.
