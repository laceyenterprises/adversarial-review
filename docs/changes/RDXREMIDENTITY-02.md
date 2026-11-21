# RDXREMIDENTITY-02

## Summary

An operator can set repository-specific remediation Git identities in config
(`config.local.yaml`), not only through an environment variable, so a host whose
watcher runs as a service needs no service-definition edit.

## Interface changes

New config key `remediation.git_identity_repo_overrides`, default `{}` in
`config.yaml`. It has the same shape as
`REMEDIATION_WORKER_GIT_IDENTITY_REPO_OVERRIDES`: lowercase `owner/name`, then
worker class, to `{ name, email }`. The schema applies the same field rule as the
resolver (non-blank, no NUL, CR, LF, `<` or `>`) and rejects a bad field at load.
A config layer replaces the whole mapping, which keeps dotted repository names
intact.

Resolution order, highest first: the env var, the config key, the per-class env
vars, the built-in defaults. A layer with no entry for the repository or class
falls through. A malformed entry in either layer warns with a fixed message that
never prints values, then falls through; resolution never throws.

`remediationWorkerGitIdentity` and `configureRemediationWorkspaceIdentity` take
an optional `configOverrides` (mapping or lazy reader). The config is read by
`src/remediation-identity-config.mjs` through the cached role-config loader, and
only when the env layer did not settle the identity. See the
[follow-up runbook](../follow-up-runbook.md).

Both config-wired identity wrappers accept `loaderImpl` and forward it to the
role-config reader. Workspace setup can use an injected loader without changing
the process environment or reading host config.

## Not done

No `ENV_ALIASES` entry: the loader's env coercion has no dict form, so the
existing env var would make malformed JSON throw at config load. The Agent OS
Python and shell loaders live in the parent repository and need the same key
before a host that uses them sets it.

## Verification

- Final comment-only remediation: the injected-loader regression failed before
  the forwarding fix (loader call count zero instead of one). After the fix,
  `node --test test/rdxremidentity-02.test.mjs` passed all 16 tests.
- `test/rdxremidentity-02.test.mjs` passed all 15 tests.
- All 163 test files that import the edited modules, or the config and role-config
  loaders, passed: 2268, 2394 and 1941 tests in three runs, 0 failures. That
  includes `test/arc19-boundary-gate.test.mjs`, which caps
  `follow-up-remediation.mjs` at its current line count.
- `npm run lint` passed with zero errors.
- `npm run typecheck:contracts` passed.
- `bash demo/research-finding-walkthrough.sh` passed with three byte-stable
  transcript deliveries.
