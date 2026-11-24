# DEPENDENCY-2042 — Verify better-sqlite3 13.2.0 on the production runtime

PR #2042 updates better-sqlite3 from 13.1.1 to 13.2.0. Integrate current
reviewed main to use the existing complete-suite PR partitions after the old
unpartitioned Node 22 job exhausted its 900-second deadline.

The upstream release changes Linux musl detection to avoid reverse-DNS hangs,
rejects unsafeMode calls on a closed database and prefers a local compiled
binary over a prebuilt binary. No production call site in this repository uses
unsafeMode. Source: https://github.com/WiseLibs/better-sqlite3/releases/tag/v13.2.0.

Verification used the production /opt/homebrew/bin/node binary (v26.10.0,
Darwin arm64) in an isolated checkout, with the exact locked dependency
installed via npm ci --ignore-scripts and then rebuilt for this runtime. Eight
in-memory checks passed: constructor, prepared run/get/all, exec, transaction
commit, transaction rollback, pragma, close and closed unsafeMode rejection.
All 56 review-state tests passed against the new native module. No deployed
module or live database was modified.

Reproduce the repository checks with node test/run-tests.mjs test/review-state.test.mjs.
Required exact-head hosted tests and native dependency security approval still
gate merge. The historical timeout is retained; no unchanged job rerun,
timeout inflation or required-check waiver is used.
