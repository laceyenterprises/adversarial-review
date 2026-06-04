# Session-Ledger Backend Compatibility Audit — adversarial-review repo — 2026-06-04

## Executive summary

- 7 files in scope (5 with findings, 2 backend-agnostic)
- 6 findings total: 3 critical, 2 high, 1 medium
- 4 fix-area groupings identified
- No production code was edited for this audit; this PR should contain this document only

## File inventory

| File | Classification | Categories triggered |
|---|---|---|
| `src/follow-up-merge-agent.mjs` | has-findings | A, C, F |
| `src/reviewer-pass-tokens.mjs` | has-findings | C, F |
| `scripts/backfill-reviewer-passes.mjs` | has-findings | C |
| `src/config-loader.mjs` | backend-agnostic | none |
| `test/follow-up-merge-agent.test.mjs` | has-findings | E |
| `test/reviewer-pass-tokens.test.mjs` | has-findings | E |
| `test/config-loader.test.mjs` | backend-agnostic | none |
| `src/diagnose-stuck-rereview.mjs` | out-of-scope (`data/reviews.db` only) | none |
| `scripts/replay-30-day.mjs` | out-of-scope (service-local replay DB only) | none |
| `scripts/adversarial-watcher-start.sh` | out-of-scope (`better-sqlite3` ABI gate for local service DBs only) | none |
| `scripts/adversarial-follow-up-tick.sh` | out-of-scope (`better-sqlite3` ABI gate for local service DBs only) | none |
| `scripts/adversarial-watcher-start-placey.sh` | out-of-scope (`better-sqlite3` ABI gate for local service DBs only) | none |
| `README.md` | out-of-scope (documentation only) | none |
| `docs/follow-up-runbook.md` | out-of-scope (documentation only) | none |
| `docs/SPEC-adversarial-review-auto-remediation.md` | out-of-scope (documentation only) | none |
| `docs/STATE-MACHINE.md` | out-of-scope (documentation only) | none |

## Findings

### F-001 — `src/follow-up-merge-agent.mjs:529-570` — merge-agent resolves ledger targets by hand
- **Category:** C (library-level coupling), F (dual-write / runtime-gate correctness)
- **Severity:** critical
- **Current state:** the merge-agent reads `AGENT_OS_SESSION_LEDGER_DB_PATH`, `.hq/config.json#ledgerDbPath`, and multiple hardcoded `ledger.db` paths under `/Users/.../.agent-os/session-ledger/ledger.db`, then returns the first existing file.
- **Why it breaks:** this bypasses the canonical ledger target resolver entirely and assumes the ledger is always a filesystem-backed SQLite DB. After read-authority flips to Postgres, this path resolver will still select a SQLite file or `null`, so the merge-agent will not read the authoritative backend.
- **Proposed fix:**
  ```diff
  - function resolveSessionLedgerDbPath({ hqRoot, env = {} } = {}) {
  -   if (env.AGENT_OS_SESSION_LEDGER_DB_PATH) return String(env.AGENT_OS_SESSION_LEDGER_DB_PATH);
  -   const config = readJsonFileDetailed(join(hqRoot, '.hq', 'config.json'));
  -   if (config.ok && config.value?.ledgerDbPath) return String(config.value.ledgerDbPath);
  -   const candidates = [/* hardcoded ledger.db paths */];
  -   for (const candidate of candidates) {
  -     if (existsSync(candidate)) return candidate;
  -   }
  -   return null;
  - }
  + async function resolveSessionLedgerTarget({ env = {} } = {}) {
  +   return await resolveLedgerTargetViaCli({
  +     env,
  +     json: true,
  +   });
  + }
  ```
- **Fix-area:** `merge-agent-ledger-read-normalization`

### F-002 — `src/follow-up-merge-agent.mjs:605-627` — merge-agent reads `worker_runs` through `better-sqlite3` and `rowid`
- **Category:** A (SQLite-only construct), C (library-level coupling)
- **Severity:** critical
- **Current state:** `lookupOriginalWorkerRunStatus` dynamically imports `better-sqlite3`, opens the resolved path directly, and runs:
  ```sql
  SELECT run_id, launch_request_id, status
  FROM worker_runs
  WHERE launch_request_id = @launchRequestId
  ORDER BY rowid DESC
  LIMIT 1
  ```
- **Why it breaks:** the direct SQLite driver is a backend bypass, and `ORDER BY rowid DESC` is SQLite-specific. A Postgres authority path has neither a local SQLite file nor `rowid`, so this read path fails exactly at the worker ownership check that gates merge-agent dispatch.
- **Proposed fix:**
  ```diff
  - Database = (await import('better-sqlite3')).default;
  - db = new Database(dbPath, { readonly: true, fileMustExist: true });
  - const row = db.prepare(`
  -   SELECT run_id, launch_request_id, status
  -   FROM worker_runs
  -   WHERE launch_request_id = @launchRequestId
  -   ORDER BY rowid DESC
  -   LIMIT 1
  - `).get({ launchRequestId });
  + const row = await readWorkerRunStatusViaLedgerCli({
  +   launchRequestId,
  +   orderBy: ['updated_at DESC', 'started_at DESC'],
  +   limit: 1,
  +   env,
  + });
  ```
- **Fix-area:** `merge-agent-ledger-read-normalization`

### F-003 — `src/reviewer-pass-tokens.mjs:1,249-404` — token readers hardwire SQLite path discovery, `sqlite_master`, and `better-sqlite3`
- **Category:** C (library-level coupling), F (dual-write / runtime-gate correctness)
- **Severity:** critical
- **Current state:** the module imports `better-sqlite3`, accepts `ledgerDbPath`, builds a candidate list of `ledger.db` file paths, probes tables via `SELECT name FROM sqlite_master`, and then reads `runtime_sessions` / `worker_runs` directly with `Database(...).prepare(...).get(...)`.
- **Why it breaks:** this entire read stack assumes a local SQLite file. `sqlite_master` is SQLite-specific, `ledgerDbPath` is path-shaped instead of backend-shaped, and the raw reads never go through the canonical abstraction that knows whether the runtime target is SQLite or Postgres.
- **Proposed fix:**
  ```diff
  - import Database from 'better-sqlite3';
  + import { execFile } from 'node:child_process';
  ...
  - function resolveSessionLedgerDbPath({ explicitPath, env, rootDir, requiredTables } = {}) {
  -   const candidates = [];
  -   ...
  -   if (!sessionLedgerDbHasTables(resolved, requiredTables)) continue;
  -   return resolved;
  - }
  -
  - function sessionLedgerDbHasTables(dbPath, tableNames = []) {
  -   db = new Database(dbPath, { readonly: true, fileMustExist: true });
  -   const rows = db.prepare(`SELECT name FROM sqlite_master ...`).all(...);
  - }
  + async function resolveSessionLedgerTarget({ explicitTarget = null, env = process.env } = {}) {
  +   return await resolveLedgerTargetViaCli({ explicitTarget, env, json: true });
  + }
  +
  + async function readWorkerRunTokenUsage(...) {
  +   return await readWorkerRunUsageViaLedgerCli(...);
  + }
  +
  + async function readReviewerSessionTokenUsage(...) {
  +   return await readRuntimeSessionUsageViaLedgerCli(...);
  + }
  ```
- **Fix-area:** `reviewer-pass-token-ledger-adapter`

### F-004 — `scripts/backfill-reviewer-passes.mjs:10-13,16-18,31-35,69-75` — backfill CLI exposes a SQLite-path-only ledger target
- **Category:** C (library-level coupling)
- **Severity:** medium
- **Current state:** the public CLI contract is `--ledger-db <path>`, stored as `ledgerDbPath`, then passed directly into `backfillReviewerPasses(...)`.
- **Why it breaks:** even if the underlying module is fixed, the operator-facing CLI shape still encodes "the ledger is a local DB path". That is incompatible with a Postgres-authoritative read path and encourages callers to bypass the canonical resolver.
- **Proposed fix:**
  ```diff
  - node scripts/backfill-reviewer-passes.mjs [--root-dir <path>] [--ledger-db <path>] ...
  + node scripts/backfill-reviewer-passes.mjs [--root-dir <path>] [--ledger-target <target>] ...
  ...
  - ledgerDbPath: null,
  + ledgerTarget: null,
  ...
  - } else if (arg === '--ledger-db') {
  + } else if (arg === '--ledger-target') {
  ...
  - args.ledgerDbPath = argv[idx];
  + args.ledgerTarget = argv[idx];
  ...
  - ledgerDbPath: args.ledgerDbPath,
  + ledgerTarget: args.ledgerTarget,
  ```
- **Fix-area:** `reviewer-pass-token-ledger-adapter`

### F-005 — `test/follow-up-merge-agent.test.mjs:3133-3379` — merge-agent ledger tests are SQLite-only and cement path-based behavior
- **Category:** E (test coverage gaps)
- **Severity:** high
- **Current state:** the tests import `better-sqlite3`, create ad hoc `worker_runs` SQLite files, assert `session-ledger.sqlite` / `ledger.db` path precedence, and never exercise a Postgres-backed resolver or reader.
- **Why it breaks:** these tests enforce the current bypass behavior instead of guarding backend-agnostic behavior. They will keep passing even if the production code is still broken for Postgres authority, and several assertions would actively fail once the implementation stops preferring SQLite path heuristics.
- **Proposed fix:**
  ```diff
  - const { default: Database } = await import('better-sqlite3');
  - const ledgerDbPath = path.join(hqRoot, 'session-ledger.sqlite');
  - db.exec('CREATE TABLE worker_runs ...');
  - const result = await lookupOriginalWorkerRunStatus({ workerDir, hqRoot, env: {} });
  + for (const fixture of await ledgerRuntimeFixtures()) {
  +   await fixture.seedWorkerRuns([...]);
  +   const result = await lookupOriginalWorkerRunStatus({
  +     workerDir,
  +     env: fixture.env,
  +   });
  +   assert.equal(result.status, 'cancelled');
  + }
  ```
- **Fix-area:** `merge-agent-ledger-parity-tests`

### F-006 — `test/reviewer-pass-tokens.test.mjs:3,35-172,257-427` — reviewer-pass token tests only seed SQLite fixtures and include SQLite-only assertions
- **Category:** E (test coverage gaps)
- **Severity:** high
- **Current state:** the tests import `better-sqlite3`, create `runtime_sessions` / `worker_runs` with SQLite DDL, pass `ledgerDbPath` everywhere, and include a `PRAGMA table_info(...)` assertion for schema inspection.
- **Why it breaks:** this suite never proves the ledger token readers work against Postgres, and it bakes SQLite-only setup patterns into the contract. Once runtime authority flips, these tests provide zero coverage for the code path that will matter.
- **Proposed fix:**
  ```diff
  - import Database from 'better-sqlite3';
  + import { ledgerRuntimeFixtures } from './helpers/session-ledger-fixtures.mjs';
  ...
  - function createLedgerDb(dbPath) {
  -   const db = new Database(dbPath);
  -   db.exec(`CREATE TABLE runtime_sessions (...); CREATE TABLE worker_runs (...);`);
  -   ...
  - }
  + async function seedLedger(fixture) {
  +   await fixture.seedRuntimeSessions([...]);
  +   await fixture.seedWorkerRuns([...]);
  + }
  ...
  - const usage = readWorkerRunTokenUsage({ workerRunId: 'wr_1', ledgerDbPath: ledgerDb, rootDir });
  + const usage = await readWorkerRunTokenUsage({ workerRunId: 'wr_1', ledgerTarget: fixture.target, rootDir });
  ```
- **Fix-area:** `reviewer-pass-token-parity-tests`

## Fix-area groupings

| Fix-area | Description | Findings | Estimated diff size |
|---|---|---|---|
| `merge-agent-ledger-read-normalization` | Replace merge-agent SQLite path discovery and direct `worker_runs` reads with a canonical ledger-targeted CLI/adapter path | F-001, F-002 | ~120 LOC |
| `reviewer-pass-token-ledger-adapter` | Replace reviewer-pass token ledger path discovery, `sqlite_master` probing, and path-only CLI surface with canonical ledger-targeted reads | F-003, F-004 | ~220 LOC |
| `merge-agent-ledger-parity-tests` | Rewrite merge-agent ledger tests around dual-backend fixtures instead of SQLite files | F-005 | ~180 LOC |
| `reviewer-pass-token-parity-tests` | Rewrite reviewer-pass token tests around dual-backend fixtures and remove SQLite-only fixture assumptions | F-006 | ~260 LOC |

## Notes

- `src/config-loader.mjs` and `test/config-loader.test.mjs` are the two backend-agnostic files in scope. They only define and validate `session_ledger.*` config keys, including the `postgres_runtime` alias, and do not directly touch ledger connections.
- The main risk concentration is Node-side ledger access. Every operational finding came from code that currently treats the canonical ledger as a SQLite file instead of a backend-neutral service target.
- None of the identified fix-areas appear to require a >300 LOC change on their own, so no mandatory split warning is needed from this repo alone.
