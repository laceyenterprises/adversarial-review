# REVIEWCLIPATH-01

## Summary

Resolve hq independently of the reviewer's restricted PATH. Deterministic command lookup and
spawn failures now stop as configuration errors and alert through the existing
bus. Preserve load-aware retries for transient spawn, timeout and protocol failures.
Configuration settlement is fenced by dispatched head/session. Typed configuration
evidence retains priority; incidental stderr tags cannot override stalled or
state-busy classifications. Resolver messages contain a single classification
tag after settlement. The kernel failure-class union includes configuration
errors. State/smoke declarations and the operator repair/retrigger instructions
now describe both outcomes.
See the [SEV1 report](../postmortems/SEV1-REVIEWCLIPATH-01-resolver-command-path.md).

## Interface changes

No new CLI flags, durable statuses or gates. Existing
`reviewer-configuration-error` now covers deterministic resolver command lookup/spawn errors;
resolver failure evidence includes its failure class. HQ_BIN precedence is
caller then service; bare command lookup uses service PATH and invocation uses
an absolute path. The resolver receives the reviewer environment as before.

## Verification

All commands ran through the bounded worker validation wrapper.

- `npm test -- review-cli-resolver.test.mjs reviewclijson-01.test.mjs reviewer-spawn-settle.test.mjs reviewer.test.mjs reviewer-runtime-adapter.test.mjs`: 372 passed, zero failed.
- `npm run lint`: zero errors (existing warnings); ESLint `--fix` on changed source files also passed.
- `npm run typecheck:contracts`: passed.
- `bash demo/research-finding-walkthrough.sh`: passed with three byte-stable transcript deliveries.
- `npm test`: the 885-file offline run reached the existing 900-second runner limit after 16,020 passing results, with no `not ok` results reported; the full suite did not complete. Checked-in historical timing data for 832 files totals about 24,143 worker-seconds, exceeding this budget even at eight-way concurrency. The affected-path suite above completed green; the broad suite was not rerun.

### PR 1895 remediation verification

- Fresh `origin/main` fetch/rebase and `git cherry origin/main HEAD`: passed;
  no patch-equivalent upstream commits.
- `npm test -- review-cli-resolver.test.mjs reviewer-spawn-settle.test.mjs classification-routing-tier-unavailable.test.mjs reviewclijson-01.test.mjs reviewer-runtime-adapter.test.mjs`: 168 passed, zero failed (bounded runner).
- `npm run lint`: zero errors, 149 existing warnings.
- `npm run typecheck:contracts`: passed.
- `bash demo/research-finding-walkthrough.sh`: passed, three byte-stable deliveries.
- `git diff --check`: passed. Full local suite intentionally not run in remediation.
- Live launchd PATH and natural terminal-alert/retrigger recovery remain deployment
  verification; the runbook names both checks and the supported reset command.

### PR 1895 CI repair

- Node 22 and Node 26 PR-head CI each reported three failures in
  `host-observation-refusal.test.mjs` and `reviewclijson-01.test.mjs`.
  The terminal settlement fixture now supplies the guarded statement, and
  malformed-protocol fixtures supply an explicit resolver command so they test
  protocol handling without depending on the CI runner's PATH.
- `npm test -- host-observation-refusal.test.mjs reviewclijson-01.test.mjs review-cli-resolver.test.mjs reviewer-spawn-settle.test.mjs`:
  71 passed, zero failed (bounded runner).
- `npm run lint`: zero errors, 149 existing warnings; `npm run typecheck:contracts`,
  `bash demo/research-finding-walkthrough.sh`, and `git diff --check`: passed.
