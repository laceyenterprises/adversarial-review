# SEV1 — Startup budget deferral disabled repository discovery for an hour

- Ticket: REPODISCOVERY-01
- Report date: 2026-11-08
- Severity: SEV1
- Scope: watcher repository discovery across all configured repositories
- scars: adversarial-watcher.repository-discovery

## Impact

The review and closure pipeline made no progress across all repositories for
approximately one hour. About ten new PRs acquired no review row; existing open
PRs received no review, closer or merge activity. No PR merged during the window.
The watcher continued completing polls successfully, so process liveness did not
reflect repository coverage. The available evidence supports these approximate
counts and duration; it does not establish exact incident timestamps.

## Evidence and relative timeline

At T+0, a routine deployment restarted the watcher while its shared GitHub core
budget was below the client floor: 180 remaining out of 5,400, with a floor of
200. Initial organization listing failed with a budget deferral until roughly
T+3 minutes. A neutral rendering of the error is:

```text
[watcher] Failed to list org repos for example-org: GitHub core budget deferred until <T+3 min> (credential=<id>; remaining=180/5400; floor=200)
```

Within minutes the budget recovered above 5,000 remaining. For approximately
60 minutes, no `Org repos refreshed — watching N repos` message appeared.
Polls reported `ok=true` and touched only already-closed PRs retained in durable
rows. No open PR was discovered, and review and closure activity stayed absent
across repositories. Budget recovery alone did not wake discovery.

## Cause and detection gap

`src/watcher-repository-discovery.mjs` advanced `lastRepoRefresh` in `finally`
after failed listings as well as successful ones. That prevents an API retry
loop during steady-state outages, when `activeRepos` retains a good scope.
At fresh startup, however, `activeRepos` contained only static configuration.
Dynamic organization discovery had an empty static set, and discovery did not
restore its durable repository observations. The failed first attempt therefore
left an empty scope while suppressing another listing for the full 60-minute
refresh interval. Poll success measured loop completion without indicating zero
watched repositories, delaying detection of the loss of coverage.

## Correction

Before the process's first successful listing, discovery restores the configured
organization's durable current repository names, retaining current exclusions
and persisted identity-conflict quarantine. It explicitly logs fallback scope.
Incomplete pagination cannot publish a partial listing. A later complete
successful listing replaces fallback scope.

Startup failures schedule the earlier of the budget error's future reset time
or bounded 2/5/10-minute backoff, capped by the configured refresh interval.
After one successful listing, the existing full-interval failure semantics
remain in force. Every zero-scope poll warns. After two minutes of continuous
zero scope, one SEV2 `adversarial-repository-discovery` event per process episode
enters the existing alert outbox; failed enqueue retries. A restart begins a new
grace period. Persisted quarantine is cleared only by a safe observation of the
same name, so a missing name cannot silently undo a known identity conflict.

## Regression evidence and limits

`test/watcher-repository-discovery.test.mjs` uses synthetic repositories, a
controlled clock and a disposable SQLite database. It covers immediate durable
fallback, exclusions and organization scope, empty-scope warning/grace/notice
deduplication, earlier budget deadlines, bounded retry progression, unchanged
steady-state failure cadence, fallback replacement, conflict persistence,
partial pagination failure, static/empty-success scopes and alert enqueue retry.
The alert presentation contract confirms SEV2 without delivering a live alert.

No live deployment, restart, synthetic PR, merge or alert is part of this fix.
After ordinary deployment, passive evidence should show a nonzero watched scope
or explicit zero-scope warnings and a notice, and recovery at the scheduled
startup retry rather than one hour later. Existing terminal-PR guards, claim
CAS, review/remediation ownership, required checks and merge predicates retain
their authority. No configuration key, CI check or merge gate is introduced.
