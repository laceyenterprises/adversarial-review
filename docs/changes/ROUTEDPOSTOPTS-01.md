# ROUTEDPOSTOPTS-01

## Summary

A finished review of a repository in an owner-routed (additional-org) organization
could not be posted. `meteredExecFile` and `meteredExecFileSync` in
`src/metered-gh.mjs` resolve the routed owner's token after the hammer-token
session has already consumed `credentialEnv`. They then rebuilt the executor
options with `credentialEnv: env` still attached. The review post path hands
`spawnCapturedProcessGroup` as the executor, and its option allowlist rejects
the key (`Unsupported spawnCapturedProcessGroup options: credentialEnv`) before
any GitHub request. Default-organization requests keep the same `env` object, skip
that branch and never carried the key, so only routed owners failed. The reviewer
spent a full model run and then exited as a post failure.

The routed credential is now carried only as `options.env.GH_TOKEN` /
`GITHUB_TOKEN`, as before. The credential map (`credentialEnv`) stays inside the
session wrapper and is never forwarded to an executor. `SUPPORTED_OPTIONS` is
unchanged: the spawner still rejects unknown options, including `credentialEnv`.

RDXORGAUTH-03 owner routing is unchanged: a routed repository uses its owner's
token, never the default-organization token.

## Interface changes

None. Executors passed to `meteredExecFile` / `meteredExecFileSync` no longer
see a `credentialEnv` option on routed requests (they already did not on
default-owner requests). Two assertions in `test/github-owner-token.test.mjs`
that pinned the leaked option now assert its absence.

## Verification

- New `test/routedpostopts-01.test.mjs` (synthetic owners and tokens, a stand-in
  `gh` on `PATH`): a routed-owner `postExactHeadReview` through the real
  `spawnCapturedProcessGroup` posts with the routed token; a default-owner post
  posts with the home token; neither hands the spawner `credentialEnv`; the async
  and sync wrappers keep the routed token without the map; an unknown spawner
  option still throws. On the unmodified base the routed post and the wrapper
  test fail with the production error; with the fix all four pass.
- `node --test` per file: `test/github-owner-token.test.mjs` (29), `test/process-group-spawn.test.mjs` (28),
  `test/metered-gh-cli.test.mjs` (37), `test/hammer-token.test.mjs` (106),
  `test/reviewer-exact-head-post.test.mjs` (5) all pass.
  `test/metered-gh-sync-env.test.mjs` is red on an unmodified checkout in this
  environment (19 of 20 subtests) with an identical result set before and after.
- ESLint on the touched files: 0 errors.
- Incident report: `docs/postmortems/SEV2-owner-routed-review-post-fails-on-an-unsupported-spawn-option-2026-11-18.md`
  in the Agent OS superproject.
