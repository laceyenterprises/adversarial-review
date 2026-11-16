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
