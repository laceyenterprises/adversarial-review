# BROKERREADYGATE-01

## Summary

Remediation waits for credential broker readiness before preparation and dispatch.
An outage defers the same pending job with bounded exponential backoff and no
round charge. A proven credential-only publisher failure records an
infrastructure-failed attempt and retries without charging the remediation budget,
retaining the commit and workspace for recovery.

Final comment-only remediation requires an explicit credential-outage operational
blocker, retains backoff attempts through preparation until spawn admission, and
accepts only the generic supervisor reasons `task_failed` and `worker_error`
alongside proven outage evidence. Other recorded failures remain charged.
OAuth consumer fixtures inject broker readiness. The central data-model catalog,
domain contract, runbook and lifecycle/smoke declarations describe these rules.

## Interface changes

Pending jobs may carry `credentialBrokerDeferral` with typed
`credential-broker-unready` evidence and a retry time. Publisher failures may use
`remediation-credential-refresh-unavailable`; replies carry the same operational
blocker code. Retry history records `credential-refresh-unavailable` and
`state: infrastructure-failed`. Local retries resume the preserved workspace.
No config key, CI job, label or merge-authority rule changes.

## Verification

Offline synthetic fixtures cover readiness, timeout, backoff, spawn admission,
publisher artifacts, refunds, preserved work and lease rejection. The isolated
broker, publication and infrastructure-refund suites passed all 70 assertions.
The follow-up suite passed all 388 assertions; its combined invocation reported
a checkout-data isolation guard failure caused by concurrently invoked fixtures.
Lint, contract typechecking and the byte-equivalence demo passed. The broader
affected-file run and full suite each reached their fixed 600-second limit,
so neither provides a completed suite result.

Final remediation validation: the bounded targeted runner passed 83 tests across
`remediation-credential-broker`, `remediation-infrastructure-refund`,
`remlabel-publication` and `follow-up-remediation-reply-path`. Four selected
`follow-up-remediation` cases passed under the repository's isolation preloads:
both spawn-readiness outcomes retained/cleared prior attempts correctly, and both
OAuth consumer entrypoints made zero fetches with a configured broker.
`npm run lint` passed with zero errors (149 existing warnings),
`npm run typecheck:contracts`, the offline byte-equivalence demo,
`node scripts/validate-data-model-catalog.mjs` (98 entries), the SMV reviewed
graph/source-projection/README-diagram checks and `git diff --check` passed.
An initial combined SMV run reached its 60-second bound after its smoke assertion
passed; the broader follow-up-file run reached its 180-second bound. Neither
bounded attempt is claimed as a completed suite. Full-suite validation belongs
to PR-head CI.
