## Summary

PR #2005 final comment remediation fixes caller environment isolation for
transcript discovery and stale legacy Codex auth selection without `HOME`.
An offline fixture exercises deployment-root resolution through the production
cached config loader against two synthetic YAML files.

## Interface changes

`shouldUseDefaultTranscriptRoots(rootDir, env)` consistently reads
`ADV_REVIEW_TOKEN_TRANSCRIPT_FALLBACK` from its supplied environment, including
explicit enable/disable values. An omitted override still enables discovery
only in the configured deployed module.

Native reviewer auth selection resolves the default home before considering
the split-user legacy path, and selects that legacy path only if it exists and
the default auth file does not. The reviewer workspace runbook documents this
precedence. No persistent store shape, lifecycle state or smoke promise changes.

## Verification

Regression tests reproduce both fallback defects before the fixes; production
config-loader coverage already passes.

- `node test/run-tests.mjs test/arpublicready-01-host-paths.test.mjs test/reviewer.test.mjs test/reviewer-pass-tokens.test.mjs`:
  291 offline tests passed across three targeted files after the rebase and fixes.
- `npm run lint`: passed with zero errors and 147 existing warnings.
- `npm run typecheck:contracts`: passed.
- `bash demo/research-finding-walkthrough.sh`: passed with three byte-stable deliveries.
- `git diff --check`: passed.

The full local suite is reserved for PR-head CI.

Final rescue folds absolute deploy-checkout resolution into the shared deploy-root
adapter and imports it in remediation. This preserves the configured-root/null
overlap behavior while bringing the orchestration file below its unchanged
ARC-19 line ceiling. The actual hosted failure was4299 lines against4297.
The measured Node22 performance repair from AR2006 is integrated as source; no
test budget or ceiling is raised. All original Comment-only fixes remain in place.
