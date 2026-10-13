# GHBUDGET-01 token and call audit

This audit describes repository wiring, not deployment secrets. Synthetic runs
use `fixture/repo`, synthetic heads and disposable state; no live calls.

| Consumer | Token selection | Meter before this change |
| --- | --- | --- |
| Watcher | `GITHUB_TOKEN` for Octokit; `GH_TOKEN` for CLI. Broker role `WATCHER_GH_BROKER_ROLE`, default `merge-agent`. | Conditional REST and `github-api.mjs` meter; direct CLI and `gh-cli.mjs` calls bypass it. |
| Follow-up daemon | Both variables refreshed from `FOLLOW_UP_GH_BROKER_ROLE`, default `merge-agent`. | Mixed: API helper metered, other CLI calls unmetered. |
| Closer dispatch / inline merge | Caller service environment and injected executors; no new token selected by dispatch. | Mixed, including unmetered live probes, lease reads and label writes. |
| Hammer procedure | Entitled hammer token, falling back to `MERGE_AGENT_GH_TOKEN`; read commands also inherit the worker environment. | API helper metered, phase shell commands and retry helper unmetered; CI gate polled every 15 seconds. |
| Remediation | Service reads use follow-up environment. Push preflight can select explicit remediation push token; worker provenance selects builder role. | Mixed service I/O; worker-directed CLI reads outside the service meter. |
| Conflict rebase | Remediation workspace/push credential for daemon I/O; entitled hammer credential for hammer conflict publication. | Same split as remediation and hammer. |
| Reviewers | Route-specific `GH_CLAUDE_REVIEWER_TOKEN`, `GH_CODEX_REVIEWER_TOKEN`, `GH_GEMINI_REVIEWER_TOKEN`, rebound to both CLI variables. | API helper metered; retry helper and direct posting unmetered. |

Tokens can belong to different installations. The existing shared budget file is
conservative across these callers; it does not establish that their installations
are identical. No token or configuration key is added.

The rendered verify-head → audit-publish → merge common-path fixture records
**44 gh invocations: 42 REST API commands and 2 GraphQL commands (`pr comment`, `pr merge`)**. It starts with
an eligible exact-head verdict, green checks, a reviewed starting base, no diff,
no withdrawals, no workflow changes, no rebase and no retries. Only local lease,
audit, wake and signal sinks are replaced. GitHub-reading helpers run against the
fake gh. This is a phase-procedure command count, not GitHub points or the number
of HTTP exchanges gh internally makes. Context collection, predicate preparation,
remediation/publication, history size, pagination and retries add calls.

A synthetic five-minute pending wait records eleven snapshots: eleven REST
check-run queries, eleven REST commit-status queries and eleven REST PR-head
queries; zero GraphQL commands, zero `--watch` arguments. Each endpoint is queried
at most once per 30 seconds. History/cost evidence is read when checks turn green,
and is refreshed again immediately before the guarded merge.
