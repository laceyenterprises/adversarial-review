# HAMCREDREFRESH-01

## Summary

Hammer refresh callers now preserve the launch command's bounded retry window
instead of killing renewal after ten seconds during a transient restart.

## Interface changes

The default refresh command timeout is 150 seconds before load scaling;
explicit caller deadlines still clip it. API preparation, forced refresh, Git
credential mint and the refresh-only check share the allowance. Named producer
authorization and identity refusals stop immediately, without held-token
fallback. Child output and free-text errors remain private.

## Verification

`node --test test/hamcredrefresh-01.test.mjs`: the initial ten cases produced
nine failures against the original code, then ten passes with the fix.
The final file passes 12 cases, including held-token refusal and the Git helper's
bounded refusal diagnostic. `node --test test/hammer-token.test.mjs` passes 105
cases covering the existing parser, redaction and per-call renewal paths.
ESLint reports no errors (152 existing warnings across the repository, none
in the changed files); contract typechecking passes.
Commands run individually under a 600-second
process-group deadline and the offline network guard.

SRE acceptance remains pending: after deployment, observe two natural
deploy-driven broker rolls without a hammer watcher outcome of
`retryable-credential-refresh-unavailable`.
