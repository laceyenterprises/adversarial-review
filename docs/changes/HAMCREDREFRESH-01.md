# HAMCREDREFRESH-01

## Summary

Hammer refresh callers now preserve the launch command's bounded retry window
instead of killing renewal after ten seconds during a transient restart.
Final comment-only remediation parses each allowlisted refusal once and safely
classifies nullish or malformed thrown values without masking the Git credential
failure sentinel. The detailed credential runbook now matches the timeout and
held-token refusal contract.

## Interface changes

The default refresh command timeout is 150 seconds before load scaling;
explicit caller deadlines still clip it. API preparation, forced refresh, Git
credential mint and the refresh-only check share the allowance. Named producer
authorization and identity refusals stop immediately, without held-token
fallback. Child output and free-text errors remain private.

## Verification

HAM CI repair: the activation refresh check now expects the 150-second owner
allowance scaled once by the maximum multiplier (six), replacing its stale
60-second expectation. The timer-ceiling and single-invocation assertions remain.
Bounded targeted validation passes all 138 tests across activation-check,
hamcredrefresh-01, hammer-token and smv. Lint passes with zero errors (152
existing warnings), contract typechecking and the offline walkthrough pass.

`node --test test/hamcredrefresh-01.test.mjs`: the initial ten cases produced
nine failures against the original code, then ten passes with the fix.
The final file passes 12 cases, including held-token refusal and the Git helper's
bounded refusal diagnostic. `node --test test/hammer-token.test.mjs` passes 105
cases covering the existing parser, redaction and per-call renewal paths.
ESLint reports no errors (152 existing warnings across the repository, none
in the changed files); contract typechecking passes.
Commands run individually under a 600-second
process-group deadline and the offline network guard.

Final remediation: `node test/run-tests.mjs test/hamcredrefresh-01.test.mjs
test/hammer-token.test.mjs test/smv.test.mjs` passes all 129 targeted tests after
rebasing onto current trunk. The new unexpected-error regression failed on
the prior implementation with a null property access, then passed with the fix.
`npm run lint` passes with 152 existing warnings and no errors;
`npm run typecheck:contracts`, `node scripts/validate-data-model-catalog.mjs`
(91 entries), `bash demo/research-finding-walkthrough.sh`, and `git diff --check`
pass. Long commands ran under the checked-in bounded runner.

SRE acceptance remains pending: after deployment, observe two natural
deploy-driven broker rolls without a hammer watcher outcome of
`retryable-credential-refresh-unavailable`.
