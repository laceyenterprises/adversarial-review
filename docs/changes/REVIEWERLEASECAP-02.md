# REVIEWERLEASECAP-02

## Summary

Clamp reviewer claims and process budgets after load scaling and composition;
bound evidence-based no-progress reclaim independently. Preserve session fencing,
late-review recovery and typed GitHub budget-deferral reset holds. See the
[SEV2 fix report](../postmortems/SEV2-REVIEWERLEASECAP-02-absolute-reviewer-lease-ceiling.md).
Phase 0 PR #1883 remains open; this branch is based on `origin/main`.

## Interface changes

The existing `reviewer.ceiling_max_seconds` is now a shared absolute ceiling
(default three hours). Existing `reviewer.no_progress_timeout_ms` bounds model
patience (default 15 minutes); idle thresholds no longer scale with load.
Diagnostic stderr cannot renew model progress, including file-backed capture.
With stdout-only progress enabled, file-backed diagnostic stderr also cannot
satisfy the first-output watchdog. Reattach uses the shared lease reader so
valid persisted expiries survive a shorter nominal timeout when GitHub PR
state is unverified; only the absolute ceiling truncates a persisted lease.
`spawnCaptured` already delegates to the ceiling-enforcing `spawnWithInput`;
regression coverage verifies omitted, zero, negative, oversized and shorter
explicit timeouts without duplicating that policy.
No new config key, state, CI check, label or review-strictness change.

## Verification

Each touched test file ran separately under `cwp_dispatch.worker_validation
--repo-root . --timeout-seconds 600 --command node --test <file>`, with
`NETGUARD_LOG=/tmp/reviewerleasecap-02-<suite>-netguard.log` and
`PATH=/Users/Shared/evalbench/work/netguard/bin:$PATH` for tests only:

- `test/reviewerleasecap-01.test.mjs`: 2 passed.
- `test/reviewerleasecap-02.test.mjs`: 9 passed.
- `test/reviewer-timeout.test.mjs`: 36 passed.
- `test/reviewer-chunk-timeout.test.mjs`: 25 passed.
- `test/reviewer-stall.test.mjs`: 11 passed.
- `test/watcher-reattach.test.mjs`: 86 passed.
- `test/watcher-claim-loop.test.mjs`: 182 passed.
- `test/codex-oauth-responses.test.mjs`: 6 passed.
- `test/claude-reviewer-token-proxy.test.mjs`: 20 passed.

Scoped ESLint `--fix`: zero errors, one pre-existing unused-argument warning.
`npm run typecheck:contracts`: passed. Full-suite and demo execution were
excluded by the ticket's touched-test-only constraint. No live state changed.

Final comment-only remediation:

- `bash bin/run-bounded.sh --timeout 180 --tail-bytes 7500 -- node --test
  test/process-group-spawn.test.mjs test/reviewerleasecap-02.test.mjs
  test/watcher-reattach.test.mjs`: all three test files passed.
- `bash bin/run-bounded.sh --timeout 240 --tail-bytes 2500 -- node --test
  test/watcher-claim-loop.test.mjs`: 182 passed in 133 seconds. The initial
  120-second bound expired after test 156; the longer bounded run completed.
- `npm run lint`: passed with zero errors and 149 existing warnings.
- `npm run typecheck:contracts`: passed.
- `node scripts/validate-data-model-catalog.mjs`: validated 98 entries.
- `git diff --check`: passed.

No persistent shape, lifecycle value, smoke promise or post-deploy verification
step changed. No generated state index exists in this checkout.
