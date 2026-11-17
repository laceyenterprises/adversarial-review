# WATCHMULTIORG-01

## Summary

The review watcher can discover repositories in additional GitHub orgs named in
host-local configuration. Discovery previously listed exactly one org
(`config.json` `org`), so a repository in any other org was never reviewed.

`github.additional_orgs` (a list of org logins, validated by the config loader,
committed default empty, set only in `config.local.yaml`) adds orgs. Each is
listed on the existing refresh clock through that org's owner-scoped client
(`src/watcher-additional-org-client.mjs`), never the home client. Results merge
with the home org as `owner/name` and `excludeRepos` applies across all orgs.
Isolation is per org: a failed listing keeps that org's previous set, a missing
owner-scoped client skips that org with one log line, and identity quarantine is
per repository. The client uses the watcher's configured broker role and requires
a home token and broker secret configuration. A successfully read configuration
removes orgs no longer listed; a later read failure keeps only the last valid
scope. API calls carry a per-org `<org>/*` label.

## Interface changes

- New optional config key `github.additional_orgs` (documented in
  `config.local.yaml.example`) and `getAdditionalWatchedOrgs()` on the loaded
  config. With the key empty, behavior is unchanged.
- `createRepositoryRefresher` accepts `additionalOrgs` and `clientForOrg`;
  pagination and observation moved into shared helpers used by both paths.
- Merge-authority behavior is unchanged: merge enablement stays per repository.
- The key must also be accepted by the other strict readers of the shared
  config file before a host sets it (see the PR description).

## Verification

- `node --test test/watcher-additional-org-discovery.test.mjs test/watcher-repository-discovery.test.mjs`: 35 passed.
- Scoped config, watcher, owner-token and decomposition-gate suites: all pass
  except tests that also fail on an unmodified checkout when run concurrently
  (they pass in isolation); `test/watcher-claim-loop.test.mjs` passes.
- `npm run typecheck:contracts` and the research-finding demo pass; ESLint
  reports 0 errors.
