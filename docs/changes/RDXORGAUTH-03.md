# RDXORGAUTH-03

## Summary

Select GitHub App installation tokens by the repository owner at each PR
transport. Home-org and unknown-owner traffic preserves its URLs, pins,
environment contents and token values. No registration, deployment or
merge-authority change is included.

See the [SEV3 report](../postmortems/SEV3-RDXORGAUTH-03-github-app-tokens-ignored-the-target-repo-owner-2026-11-16.md)
and [repository standup runbook](../RUNBOOK-new-repo-standup.md#repositories-outside-the-home-org).

## Interface changes

Broker resolution accepts an optional routed `owner`, verifies `metadata.owner`
and optional `OAUTH_BROKER_<ROLE>_EXPECTED_INSTALLATIONS` pins instead of the
home installation pin, and refuses PAT fallback. Owner tokens are cached by
role and owner without updating home environments or refresh clocks. Cropped
child environments use the Node process broker configuration without
forwarding it to subprocesses.

Octokit, gh (including cache-only synchronous calls), adapter environment-token
mode and raw review REST calls use that authority. GraphQL repository variables
also identify their target for reviewer context reads. Direct workflow-push
mints take the owner from the job repository. A failed routed selection raises
`github-owner-token-unavailable` as a GitHub authentication outage. Managed
hammer sessions and git credentials remain outside this change.

The offline runner explicitly gives legacy transport fixtures the supported
no-`org` auth configuration without changing existing test assertions. Routed
fixtures independently supply synthetic home and other owners. Documentation
uses this fragment in accordance with the repository change-note convention;
the root README's historical notes remain frozen.

## Verification

All checks ran through the bounded worker validation runner. Test commands
used the network guard and fake broker/executor fixtures; no live token was
minted. The repository's current sandbox runner invoked native `node:test`
with two files at a time, each command bounded to 600 seconds.

- `node test/run-tests.mjs <two scoped files>`: all 120 selected files passed;
  3,178 tests passed, two were skipped and none failed. Selection included every
  matching import of the edited modules, all ticket-required files, runner
  fixtures and the watcher claim-loop suite. Existing assertion files were not
  edited.
- `test/github-owner-token.test.mjs`: all 24 routed/compatibility cases passed,
  including exact home URLs/pins/environment/token assertions, owner echo and
  pin refusal, single-flight/expiry/auth recovery, all transports, cropped
  environments and the one-PR reviewer context/side-call/post path.
- `npm run lint`: passed, zero errors and 149 existing warnings.
- `npm run typecheck:contracts`: passed.
- `bash demo/research-finding-walkthrough.sh`: passed with three byte-stable
  transcript deliveries.

The full `npm test` suite was not run, as requested. No SQL, dependency, CI,
host configuration, registration or merge-authority changes were made.

## Final comment-only remediation

Await asynchronous auth providers in the Octokit before-hook fallback, preserve
merge adapter auth arguments for every owner, normalize owner remint failures
through the existing CLI auth-outage error, exclude bare non-repository API
namespaces from routing, and accept case-insensitive broker owner echoes while
retaining App and installation verification. Replace the routing-disable
preload with a real per-worker no-org configuration for legacy test transports.

The service-role concern is accounted for without trusting ambient startup
seeds: production `refreshWatcherGithubToken` calls the broker fetch that records
the returned token's role before polling. An offline regression exercises that
actual refresh, then routed Octokit, adapter and CLI requests without manually
registering the refreshed token. Canonical standup and incident documentation
now describe this boundary and owner casing. No persistent store, lifecycle,
merge eligibility or smoke promise changes.

Validation: the three directly affected regression files passed (39 tests).
The remaining 17 targeted transport, broker, claim-loop, runner and previously
failing PR-CI fixture files also passed after fixture repairs (501 distinct
targeted tests in total). CLI fixtures preserve symlink module identity and
supply their own config and runtime inputs; claim-loop fixtures explicitly
separate discovery's home org from authentication routing.

`npm run lint` passed with zero errors and 149 existing warnings;
`npm run typecheck:contracts`, `bash demo/research-finding-walkthrough.sh`
(three byte-stable deliveries), and `git diff --check` passed. No full local
suite was run; PR-head CI remains the full-suite merge gate.

## Hammer CI fixture repair

The remaining Node 22 and Node 26 failures were in fast-merge and
reviewer-timeout watcher fixtures. Their loaders now supply the synthetic home
organization for repository discovery independently of the runner's no-org auth
configuration. Existing polling, closure and retry assertions remain intact;
production routing and merge authority interfaces are unchanged.

Verification: canonical targeted validation passed all 280 tests across the two
repaired watcher suites, owner-token and routing-isolation suites, dynamic
Octokit auth and watcher claim-loop suites. Lint, contract typechecking and the
offline research walkthrough passed. The full suite runs only in exact-head CI.
