# SEV1 — Git fixture processes and concurrent validation overloaded a shared test host

Date 2026-11-20. Ticket TESTLOADHYGIENE-01.

## Impact

Concurrent validation suites put sustained pressure on process creation.
Timing-sensitive helper tests could fail under contention and pass when run
alone. Retries prolonged closer validation and delayed PR completion.

## Cause

The suite gives each test file an isolated home, and some Git fixtures use a
fresh home or disable global Git configuration. Fixture commits and fetches
could therefore launch Git's default automatic maintenance, including
detached children. Some fixture commands already carried explicit Git
settings, while others relied on the default.

The repository runner allowed eight parallel files per suite. Direct
`node --test` invocations used Node's own concurrency default. Multiple
suites on the same host multiplied the number of active files and their
child processes. The relative contribution of file concurrency to the
observed failures was not measured independently.

## Synthetic reproduction

A local `git init` and empty commit used a fresh home with system and global
Git configuration excluded. Git Trace2 captured the following events under
the offline test guard.

| Configuration | Git execs | Children launched by Git | Auto-maintenance execs |
| --- | ---: | ---: | ---: |
| Stock defaults | 3 | 1 | 1 |
| `maintenance.auto=false`, `gc.auto=0`, `gc.autoDetach=false` | 2 | 0 | 0 |

Adding a push to a local bare repository and a fetch from it reduced Git
execs from 17 to 15 and Git child starts from 10 to 8. Auto-maintenance
execs fell from three to one. The remaining launch came from the local
`git-receive-pack` process, which runs with a cleared repository-specific
Git configuration environment.

Git child starts and Git execs overlap. These traces do not count every
process in the suite tree. A controlled busy-host wall-time comparison
between default concurrency and four workers was not run, so the
measurements support the maintenance-spawn fix and do not quantify a suite
speedup.

## Fix and regression coverage

The shared runner passes the three settings to fixture descendants through
Git's configuration environment. A regression test constructs that environment
explicitly, makes a real commit, push and fetch in temporary repositories, and
uses Trace2 to check for maintenance launches. The bare push receiver is
configured separately because Git transport strips client command settings.
Helpers replacing Git command
configuration can replace these settings; production credential helpers remain
responsible for their own configuration.

Local validation now defaults to half the available logical CPUs, rounded
down and clamped to one through four. `AR_TEST_CONCURRENCY` overrides the
limit within this repository’s runner. Generic bounded validators preserve
their caller’s arguments, including downstream repositories’ Node concurrency.
The suite deadline stays at 900 seconds when the selected parallel files fit
within the configured worker limit. Otherwise it scales as
`900 * 8 / min(8, limit)` seconds.
Tests exercise the default, override, scaled deadline and CI's existing worker
count. CI retains the same suite selection and scheduling. A measured local
full-suite wall time remains unavailable; remediation runs targeted tests only.
