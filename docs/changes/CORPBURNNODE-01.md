# CORPBURNNODE-01

## Summary

PR #1919 added `claude-code-corp` to
`ENUM_ROLES_BUILD_PACK_DEFAULT_WORKER_CLASS` in `src/config-loader.mjs`,
aligning the Node config loader's enum with the Python schema enum.
This follow-up supplies the missing repository change note.

## Interface changes

`roles.build_pack_default_worker_class` accepts `claude-code-corp` in
addition to `plan`, `codex`, `codex-corp`, and `claude-code`. The default
remains `codex`.

## Verification

`test/config-loader-codex-corp.test.mjs` covers the enum values and loading
`claude-code-corp` from local YAML through both strict and runtime loaders.

The documentation follow-up passed:

- `npm run lint`
- `npm run typecheck:contracts`
- `bash demo/research-finding-walkthrough.sh`
- `npm test -- test/config-loader-codex-corp.test.mjs`

`npm test` completed with 20,944 passing, 19 failing, and 11 skipped tests.
All failures were in `test/primary-change-authorized-rename.test.mjs`.
Running `npm test -- test/primary-change-authorized-rename.test.mjs` in a
clean worktree at `origin/main` (`4c90c270d28b868928f46e5a0408a511e3bad736`)
reproduced the same 19 failures; they predate this documentation change.
