# WATCHMULTIORG-01

## Summary

The review watcher can discover repositories in additional GitHub orgs named in
host-local configuration. Discovery previously listed exactly one org
(`config.json` `org`), so a repository in any other org was never reviewed.

`github.additional_orgs` (a list of org logins, validated by the config loader,
committed default empty, set only in `config.local.yaml`) adds orgs. Each is
given an initial discovery attempt on the next poll after configuration, with
subsequent attempts on the existing refresh clock through that org's owner-scoped client
(`src/watcher-additional-org-client.mjs`), never the home client. Results merge
with the home org as `owner/name` and `excludeRepos` applies across all orgs.
Isolation is per org: a failed listing keeps that org's previous set, a missing
owner-scoped client or unavailable owner token skips that org with one log line
per outage (a successful listing resets warning suppression),
and identity quarantine is
per repository. The client uses the watcher's configured broker role and requires
a home token and broker secret configuration. A successfully read configuration
removes orgs no longer listed, including their cached clients and outage warning
suppression; a later read failure keeps only the last valid scope. Startup
fallback warns for each non-excluded additional-org candidate omitted by persisted
quarantine or ambiguous ownership history, matching the home-org diagnostic.
API calls carry a per-org `<org>/*` label.
Additional-org repository-state lock contention propagates after the home
organization's first successful reconciliation, deferring discovery on the same
terms as the home path. Local observation failures retain fallback scope and
log reconciliation errors without recording failed GitHub API calls. Home
credentials accept `GITHUB_TOKEN` with `GH_TOKEN` as the fallback, read on
every authentication so cached clients follow rotation and credential removal.

PR #1912 deployment-order remediation documents the shared-loader prerequisite
beside the example key and in the canonical discovery contract. Operators must
deploy and validate Python, shell and Node schema support before setting
`github.additional_orgs`, and leave the key absent until then (even an explicit
empty list is unsafe for an older strict reader). Python/shell schema changes
and their validation remain a follow-up in the Agent OS superproject, outside
this repository; no host configuration is enabled by this patch.

## Interface changes

- New optional config key `github.additional_orgs` (documented in
  `config.local.yaml.example`) and `getAdditionalWatchedOrgs()` on the loaded
  config. With the key empty, behavior is unchanged.
- `createRepositoryRefresher` accepts `additionalOrgs` and `clientForOrg`;
  pagination and observation moved into shared helpers used by both paths.
- Merge-authority behavior is unchanged: merge enablement stays per repository.
- The key must also be accepted by the other strict readers of the shared
  config file before a host sets it (see the PR description).
- Additional org logins must be 1–39 characters, start and end with an
  alphanumeric character, and otherwise contain only alphanumerics or hyphens.

## Verification

- PR #1912 deployment-order documentation remediation: after rebasing onto
  freshly fetched main, bounded `node --test
  test/watcher-additional-org-discovery.test.mjs
  test/watcher-repository-discovery.test.mjs test/github-owner-token.test.mjs`
  passes all 51 tests, including optional-key validation and empty defaults.
  `npm run lint` passes with 0 errors and 149 existing warnings;
  `npm run typecheck:contracts`, `bash demo/research-finding-walkthrough.sh`,
  `node scripts/validate-data-model-catalog.mjs` (98 entries), and
  `git diff --check` pass. The Python validation harness is unavailable in this
  environment, so commands used the checked-in bounded runner. Full-suite
  validation remains with PR-head CI.
- PR #1912 credential-rotation and dynamic-configuration remediation: bounded
  `node --test test/watcher-additional-org-discovery.test.mjs
  test/watcher-repository-discovery.test.mjs test/github-owner-token.test.mjs`
  passes all 51 tests. New regressions failed before the fix and pass afterward:
  cached clients use rotated credentials, fail closed on removal and recover;
  newly configured orgs discover immediately, with later attempts still using
  the shared deadline after success, listing failure or client unavailability.
  `npm run lint` (0 errors, 149 existing warnings), scoped ESLint, contract
  typechecking, the offline research demo, data-model catalog validation
  (98 entries), and `git diff --check` pass. Full-suite validation remains
  with PR-head CI.
- Latest PR #1912 remediation: bounded `node --test
  test/watcher-additional-org-discovery.test.mjs
  test/watcher-repository-discovery.test.mjs test/github-owner-token.test.mjs`
  passes all 46 tests. Regressions reproduce additional-org lock swallowing,
  local-error API misattribution (with and without a prior listing), and
  missing `GH_TOKEN` support before the fix. Tests also cover unchanged
  refresh cadence, recovery after releasing the lock, and `GITHUB_TOKEN`
  precedence. Lint, contract typechecking, the offline research demo,
  data-model catalog validation (98 entries), and `git diff --check` pass.
- Final PR #1912 remediation: `node --test
  test/watcher-additional-org-discovery.test.mjs
  test/watcher-repository-discovery.test.mjs` passes all 41 tests. New regressions
  failed before the fix and pass after it: removing/reconfiguring an org creates
  a fresh client and warning, while startup fallback warns for quarantine and
  ambiguous history without warning for excluded names.
- Final remediation guards pass: `npm run lint` (0 errors), `npm run
  typecheck:contracts`, `bash demo/research-finding-walkthrough.sh`,
  `node scripts/validate-data-model-catalog.mjs` (98 entries), and
  `git diff --check`. The full local suite was intentionally left to PR-head CI.
- `node --test test/watcher-additional-org-discovery.test.mjs test/watcher-repository-discovery.test.mjs test/watcher-claim-loop.test.mjs`:
  40 passed, including failure/recovery/failure warning coverage and org-login
  boundary validation added for PR #1912 remediation.
- Scoped config, watcher, owner-token and decomposition-gate suites: all pass
  except tests that also fail on an unmodified checkout when run concurrently
  (they pass in isolation); `test/watcher-claim-loop.test.mjs` passes.
- `npm run typecheck:contracts` and the research-finding demo pass; ESLint
  reports 0 errors.
