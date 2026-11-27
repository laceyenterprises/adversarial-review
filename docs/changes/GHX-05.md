# GHX-05 · Review service on the resolver

## Summary

The watcher, follow-up, reviewers and pipeline health collector use the Agent OS GitHub adapter to resolve credentials. PR operations pass the repository and role. Org enumeration uses the adapter's explicit owner target. A Rundix terminal read can use its installation even when the watcher has no process-level App identity pins.

## Interface changes

Both services check their enabled broker roles against all configured organizations at boot. The service's broker flag controls its `merge-agent` check; follow-up worker broker mode also checks merge-agent and its worker roles. Environment-token mode alone does not page for broker identity. Failures page through the existing alert outbox once per role and owner. If service authentication is unavailable, GitHub-dependent work waits for the ordinary refresh loop. The launchers preserve configured reviewer PAT mode and broker mode uses the adapter. Twenty App and installation environment keys are removed from the watcher and follow-up plists. The Agent OS configuration schema is unchanged.

The final comment-only remediation keeps zsh launchers alive after adapter refusal or service-repository lookup failure, restores the Grok seed's checkout fallback, and joins an in-flight authentication refresh before classifying a watcher tick. Gemini still refuses an empty selected credential before posting. Service refreshes reject alternate-owner targets without changing the home token or refresh clock.

Token verification requires the expected provider for known roles and binds installation budgets only for an explicit `github_app_installation` source. Structured upstream mint/rate-limit failures remain transient and public diagnostics remain redacted. Asynchronous adapter calls reserve primary and standby attempt budgets; synchronous cold owner mints have a fixed two-second cap. Home broker-mode adapter calls rely on the external adapter token cache, as documented in the standup runbook. The health collector's next snapshot is its credential retry. `ROLE_TOKEN_VARS` is exported for offline coverage of every worker role against the captured HQ slug contract; no role mapping changed.

The final Gemini advisory pass forwards the cache directory in shell seeds,
resolves Perl from `PATH`, caches the default Node service repository, and
preserves allowlisted health adapter refusal codes through the Node collector.
Watcher launchers use a shared callable repository fallback, tested under Bash
and zsh without extracting executable statements by regex. The standby fixture
returns immediately; an injected subprocess assertion pins the 21-second budget.
The workflow-role recommendation is accounted for without changing identity:
the provider selector already escalates required workflows unless explicitly
disabled. With escalation disabled, the harness role must match the selected
harness provider and independently prove `workflows:write`; changing only the
role to merge-agent would cause a provider mismatch. Successful and refused
harness workflow routes are covered offline.

Alternate-org remediation publication still requires verified `contents:write` and, for workflow changes, `workflows:write`. GHX-03's token response carries App and installation metadata but no permission map, so that route remains held when permission evidence is absent. Delivering permission evidence is an Agent OS dependency outside this ticket.

## Verification

`node test/run-tests.mjs` passed 463 tests across 16 focused suites, and the watcher claim-loop suite passed. A separate follow-up suite comparison reproduced all 41 remaining fixture failures on `origin/main`. The real GHX-03 CLI resolved a Rundix terminal read and returned a boot identity failure against a local synthetic broker. ESLint completed with zero errors, contract types checked, ShellCheck accepted the Bash helper, zsh parsed the launchers, both plists passed `plutil`, and the walkthrough produced three byte-stable deliveries. GHX-07 owns live broker cutover verification.

Final comment-only validation: 556 tests passed across 12 explicitly selected suites, including the watcher claim loop, launcher wrappers, context authentication, owner routing, health collection and broker refresh. ESLint reported zero errors; contract types, ShellCheck for the broker helper, zsh launcher parsing, whitespace checks and the offline byte-equivalence walkthrough passed. The latest source review is 6082160526 on `7270d49e660720ca441ef9ab053f9578e1c0d7e3`.

Gemini advisory remediation validation: the four explicitly selected
`reviewer-broker`, `reviewer-broker-refresh`, `pipeline-health-github`, and
`remediation-owner-auth` suites passed with zero failed files, using
`node test/run-tests.mjs` under the bounded worker validation runner. ESLint
completed with zero errors (147 existing warnings); Ruff lint/format,
ShellCheck, zsh parsing, contract typechecking, `git diff --check`, and the
offline walkthrough passed. Full-suite execution remains the PR-head CI gate.
