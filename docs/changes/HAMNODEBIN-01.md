# HAMNODEBIN-01

## Summary

Resolve Node at entry to verify-head, publish and merge rather than depending
on a launch export surviving session continuation. All phase helper calls and
the rendered failure-audit wrapper use the resolved runtime consistently.
See the [SEV2 report](../postmortems/SEV2-HAMNODEBIN-01-resumed-hammer-node-runtime.md).

## Interface changes

The shared `bin/hammer-node-runtime.sh` preserves and exports an absolute,
executable `HAM_NODE_BIN`. Unset or empty values resolve through the launch pin
`AGENT_OS_NODE_BIN`, then `command -v node`. Invalid explicit pins or unavailable
executables fail with `node-runtime-unavailable`. The initial prompt entry and
persisted `inputs.sh` source the resolver, restoring the export in resumed shells.
Final comment-only remediation clears `HAM_NODE_BIN` when resolution fails,
avoiding an attempted invocation of the rejected pin during failure auditing.
Persisted `ham_gh`, `ham_git` and `ham_pr` helpers now use the resolved export
directly, matching the phase entrypoints.

Lease ownership, cleanup, mandatory stops, merge predicates and CI configuration
are unchanged. The closure runbook describes the runtime contract in place.

## Verification

Targeted test commands use the existing worker-validation process-group wrapper
with `--timeout-seconds 600`, one file per command, and test-only
`NETGUARD_LOG=/tmp/HAMNODEBIN-01-<suite>-netguard.log`
`PATH=/Users/Shared/evalbench/work/netguard/bin:$PATH`.

- `node --test test/hammer-procedure-generation.test.mjs`: 10 passed.
- `node --test test/hammertrim-contract.test.mjs`: 49 passed, two pre-existing
  audit-receipt assertions failed (`red CI after pending`, `permanent merge
  rejection`, both at line 716). Re-running only those two cases against
  `origin/main` reproduced both failures. The added `HAMNODEBIN-01` publication
  test passed; a final `--test-name-pattern=HAMNODEBIN-01` run also passed.
- `npm run lint`: passed, zero errors (existing warnings).
- `shellcheck bin/hammer-node-runtime.sh`: passed.
- `bash -n` and `shellcheck --severity=error` on all three rendered phases: passed.
- `git diff --check`: passed.

Tests use synthetic executables and isolated temporary state. No live query,
publication, merge, lease mutation or service change is needed for validation.
The ticket restricts execution to touched test files; the full suite and demo
were not run. The repository has no `scripts/test-shellcheck-gate.sh`, so the
scoped ShellCheck commands above validate the changed shell surfaces directly.
HCP memory search timed out; the local hardening brief returned no projections.

Final comment-only remediation, after rebasing onto freshly fetched `origin/main`:

- `bin/run-bounded.sh --timeout 120 -- node --test test/hammer-procedure-generation.test.mjs`: 11 passed.
- `bin/run-bounded.sh --timeout 120 -- node --test --test-name-pattern=HAMNODEBIN-01 test/hammertrim-contract.test.mjs`: one passed.
- `npm run lint`: passed, zero errors and 152 existing warnings.
- `npm run typecheck:contracts`: passed.
- `shellcheck bin/hammer-node-runtime.sh` and `bash -n bin/hammer-node-runtime.sh`: passed.
- Rendered phases and persisted inputs: `bash -n` and
  `shellcheck --shell=bash --severity=error` passed.
- `git diff --check`: passed.

New regression coverage verifies invalid runtime pins are absent in caller and
child shells, rendered failure audits emit no invocation errors, and persisted
helpers refuse a lost runtime export instead of launching a PATH fallback.
The full suite and demo remain delegated to PR-head CI under this round's
targeted-validation instruction. No persistent store, lifecycle declaration or
smoke promise changes are introduced.
