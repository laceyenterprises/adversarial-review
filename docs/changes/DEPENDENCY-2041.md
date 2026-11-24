# DEPENDENCY-2041 — Verify Linear SDK 103 against the triage adapter

PR #2041 updates @linear/sdk from 102.0.0 to 103.0.0. Integrate the current
reviewed main so the existing complete-suite PR partitioning is used rather
than repeating the obsolete unpartitioned Node 22 timeout.

The upstream 103.0.0 release removes the DocumentContentDraft type, three draft
subscription fields and an integrationSentryConnect argument. None is consumed
by this repository. Other schema additions and description changes are outside
the triage adapter's consumed surface. Source: https://github.com/linear/linear/releases/tag/%40linear/sdk%40103.0.0.

Empirical verification used the production /opt/homebrew/bin/node binary
(v26.10.0) in an isolated checkout, with the exact locked SDK installed using
npm ci --ignore-scripts. All 19 operator-linear-triage tests passed, including
the real SDK's LinearClient construction and issue/updateIssue/createComment,
Issue team/state/labels and Team states API checks. Tests use fixture ports and
a dummy key; no live Linear operation or deployed dependency was changed.

Reproduce with node test/run-tests.mjs test/adapters/operator-linear-triage.test.mjs.
Required current-head hosted tests and the native dependency security decision
remain merge gates. The earlier Node 22 deadline is retained as failure evidence;
no unchanged rerun, deadline inflation or missing coverage waiver is used.
