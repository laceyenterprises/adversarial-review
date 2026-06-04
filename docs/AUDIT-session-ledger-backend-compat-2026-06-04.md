# Session-Ledger Backend Compatibility Audit — adversarial-review repo — 2026-06-04

## Executive summary

- 11 implementation/test files in scope (5 with findings, 4 consumers of changed exports, 2 backend-agnostic)
- 6 findings total: 3 critical-at-cutover, 2 high, 1 medium-at-cutover
- 4 fix-area groupings identified
- No production code was edited for this audit; this PR should contain this document only
- The critical severities below are cutover severities. Today's direct production risk remains low while `AGENT_OS_SESSION_LEDGER_POSTGRES_RUNTIME=on` is off by default in Agent OS (`platform/session-ledger/src/session_ledger/db_path.py#postgres_runtime_enabled`), but these paths must be closed before Postgres becomes read-authoritative.

## File inventory

| File | Classification | Categories triggered | Evidence / coupling note |
|---|---|---|---|
| `src/follow-up-merge-agent.mjs` | has-findings | A, C, F | Reads session-ledger `worker_runs` through SQLite path discovery and `better-sqlite3`. |
| `src/reviewer-pass-tokens.mjs` | has-findings | C, F | Exports `beginReviewerPass`, `readWorkerRunTokenUsage`, and `readReviewerSessionTokenUsage`; reads session-ledger tables through SQLite. |
| `scripts/backfill-reviewer-passes.mjs` | has-findings | C | Public CLI exposes `--ledger-db <path>` and passes `ledgerDbPath` into reviewer-pass token reads. |
| `src/follow-up-jobs.mjs` | consumes-changed-export | C | Imports `beginReviewerPass` from `src/reviewer-pass-tokens.mjs`; any async/signature change must migrate this caller. |
| `src/watcher.mjs` | consumes-changed-export | C | Imports `beginReviewerPass` from `src/reviewer-pass-tokens.mjs`; watcher launch flow depends on the current sync API. |
| `src/tokens-cli.mjs` | consumes-changed-export | C | Imports `reviewerPassRows` from `src/reviewer-pass-tokens.mjs`; token report CLI must preserve the new backend-neutral contract. |
| `test/review-body-capture.test.mjs` | consumes-changed-export | E | Imports `beginReviewerPass` and validates review body capture around reviewer-pass rows. |
| `src/config-loader.mjs` | backend-agnostic | none | Only parses `session_ledger.*` config keys; no DB connection or table access. |
| `test/follow-up-merge-agent.test.mjs` | has-findings | E | Seeds session-ledger-shaped SQLite `worker_runs` fixtures and asserts path precedence. |
| `test/reviewer-pass-tokens.test.mjs` | has-findings | E | Seeds SQLite `runtime_sessions` / `worker_runs`, passes `ledgerDbPath`, and asserts SQLite schema details. |
| `test/config-loader.test.mjs` | backend-agnostic | none | Only validates config parsing aliases and defaults. |
| `src/diagnose-stuck-rereview.mjs` | out-of-scope (`data/reviews.db` only) | none | Opens `rootDir/data/reviews.db` and never reads session-ledger `worker_runs` / `runtime_sessions`. |
| `scripts/replay-30-day.mjs` | out-of-scope (service-local replay DB only) | none | Replays watcher state from `data/reviews.db` and probes `sqlite_master` for local review-service tables. |
| `scripts/adversarial-watcher-start.sh` | out-of-scope (`better-sqlite3` ABI gate for local service DBs only) | none | Uses `node -e "require('better-sqlite3')"` only as a native-module startup sanity check for the review service. |
| `scripts/adversarial-follow-up-tick.sh` | out-of-scope (`better-sqlite3` ABI gate for local service DBs only) | none | Same native-module sanity gate; does not select or read the session-ledger backend. |
| `scripts/adversarial-watcher-start-placey.sh` | out-of-scope (`better-sqlite3` ABI gate for local service DBs only) | none | Same native-module sanity gate for the placey launch path. |
| `README.md` | out-of-scope (documentation only) | none | Mentions review pipeline behavior; no executable ledger access. |
| `docs/follow-up-runbook.md` | out-of-scope (documentation only) | none | Documents review-service `data/reviews.db` operations and operator commands. |
| `docs/SPEC-adversarial-review-auto-remediation.md` | out-of-scope (documentation only) | none | Documents current review-service and merge-agent contracts; no executable code. |
| `docs/STATE-MACHINE.md` | out-of-scope (documentation only) | none | Documents `data/reviews.db` review-state transitions. |

## Findings

### F-001 — `src/follow-up-merge-agent.mjs:529-570` — merge-agent resolves ledger targets by hand
- **Category:** C (library-level coupling), F (dual-write / runtime-gate correctness)
- **Severity:** critical-at-cutover
- **Current state:** the merge-agent reads `AGENT_OS_SESSION_LEDGER_DB_PATH`, `.hq/config.json#ledgerDbPath`, and multiple hardcoded `ledger.db` paths under `/Users/.../.agent-os/session-ledger/ledger.db`, then returns the first existing file.
- **Why it breaks:** this bypasses the canonical ledger target resolver entirely and assumes the ledger is always a filesystem-backed SQLite DB. After read-authority flips to Postgres, this path resolver will still select a SQLite file or `null`, so the merge-agent will not read the authoritative backend. Today's risk is low while the Postgres runtime gate is off; cutover risk is critical.
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
- **Severity:** critical-at-cutover
- **Current state:** `lookupOriginalWorkerRunStatus` dynamically imports `better-sqlite3`, opens the resolved path directly, and runs:
  ```sql
  SELECT run_id, launch_request_id, status
  FROM worker_runs
  WHERE launch_request_id = @launchRequestId
  ORDER BY rowid DESC
  LIMIT 1
  ```
- **Why it breaks:** the direct SQLite driver is a backend bypass, and `ORDER BY rowid DESC` is SQLite-specific. A Postgres authority path has neither a local SQLite file nor `rowid`, so this read path fails exactly at the worker ownership check that gates merge-agent dispatch. Today's risk is low while the Postgres runtime gate is off; cutover risk is critical.
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
- **Severity:** critical-at-cutover
- **Current state:** the module imports `better-sqlite3`, accepts `ledgerDbPath`, builds a candidate list of `ledger.db` file paths, probes tables via `SELECT name FROM sqlite_master`, and then reads `runtime_sessions` / `worker_runs` directly with `Database(...).prepare(...).get(...)`.
- **Why it breaks:** this entire read stack assumes a local SQLite file. `sqlite_master` is SQLite-specific, `ledgerDbPath` is path-shaped instead of backend-shaped, and the raw reads never go through the canonical abstraction that knows whether the runtime target is SQLite or Postgres. Today's risk is low while the Postgres runtime gate is off; cutover risk is critical.
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
- **Caller migration scope:** this proposal changes public exports consumed by `src/follow-up-jobs.mjs`, `src/watcher.mjs`, `src/tokens-cli.mjs`, and `test/review-body-capture.test.mjs`. The implementation should either keep `ledgerDbPath` accepted as a deprecated alias and preserve sync wrappers where required, or migrate those callers in the same fix-area.

### F-004 — `scripts/backfill-reviewer-passes.mjs:10-13,16-18,31-35,69-75` — backfill CLI exposes a SQLite-path-only ledger target
- **Category:** C (library-level coupling)
- **Severity:** medium-at-cutover
- **Current state:** the public CLI contract is `--ledger-db <path>`, stored as `ledgerDbPath`, then passed directly into `backfillReviewerPasses(...)`.
- **Why it breaks:** even if the underlying module is fixed, the operator-facing CLI shape still encodes "the ledger is a local DB path". That is incompatible with a Postgres-authoritative read path and encourages callers to bypass the canonical resolver.
- **Proposed fix:** add `--ledger-target` while keeping `--ledger-db` as a deprecated alias during a transition window. `--ledger-db` should continue to work, emit a deprecation warning to stderr, and map through the same canonical resolver so existing operator wrappers do not break.
  ```diff
  - node scripts/backfill-reviewer-passes.mjs [--root-dir <path>] [--ledger-db <path>] ...
  + node scripts/backfill-reviewer-passes.mjs [--root-dir <path>] [--ledger-target <target>] [--ledger-db <deprecated-path>] ...
  ...
  - ledgerDbPath: null,
  + ledgerTarget: null,
  ...
  - } else if (arg === '--ledger-db') {
  + } else if (arg === '--ledger-target' || arg === '--ledger-db') {
  ...
  - args.ledgerDbPath = argv[idx];
  + args.ledgerTarget = resolveDeprecatedLedgerDbAliasIfNeeded(arg, argv[idx]);
  ...
  - ledgerDbPath: args.ledgerDbPath,
  + ledgerTarget: args.ledgerTarget,
  ```
- **Fix-area:** `reviewer-pass-token-ledger-adapter`

## Prerequisites for implementation work

The proposed code sketches intentionally describe the desired caller shape, not drop-in helpers that already exist in this repository. The implementation work needs one canonical adapter surface before the call-site migrations land:

| Prerequisite | Owner surface | Required before | Notes |
|---|---|---|---|
| Canonical ledger target resolver for Node callers | Agent OS session-ledger CLI or a shared Node adapter | F-001, F-003, F-004 | Must resolve SQLite-vs-Postgres authority from the same environment/config rules as `platform/session-ledger/src/session_ledger/db_path.py`. |
| Worker-run status read by launch request | Agent OS session-ledger CLI subcommand or shared Node adapter | F-002 | Needs deterministic Postgres-safe ordering; do not rely on SQLite `rowid`. |
| Worker-run token usage read | Agent OS session-ledger CLI subcommand or shared Node adapter | F-003, F-006 | Must return the same shape currently produced by `readWorkerRunTokenUsage`. |
| Runtime-session token usage read | Agent OS session-ledger CLI subcommand or shared Node adapter | F-003, F-006 | Must return the same shape currently produced by `readReviewerSessionTokenUsage`. |
| Caller migration/back-compat shim | `tools/adversarial-review` | F-003, F-004 | Either migrate all consumers listed above or keep compatibility wrappers that accept the old `ledgerDbPath` contract. |

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

| Fix-area | Description | Findings | Prerequisites / caller scope | Estimated diff size |
|---|---|---|---|---|
| `canonical-ledger-read-adapter` | Add the shared CLI/Node read surface that resolves backend authority and exposes worker-run / runtime-session reads | F-001, F-002, F-003, F-004 | New Agent OS session-ledger CLI subcommands or a shared Node adapter | ~220-320 LOC |
| `merge-agent-ledger-read-normalization` | Replace merge-agent SQLite path discovery and direct `worker_runs` reads with the canonical ledger-targeted path | F-001, F-002 | Depends on `canonical-ledger-read-adapter` | ~120 LOC |
| `reviewer-pass-token-ledger-adapter` | Replace reviewer-pass token ledger path discovery, `sqlite_master` probing, path-only CLI surface, and public caller contracts with canonical ledger-targeted reads | F-003, F-004 | Includes `src/follow-up-jobs.mjs`, `src/watcher.mjs`, `src/tokens-cli.mjs`, and `test/review-body-capture.test.mjs` unless compatibility wrappers preserve the old shape | ~300-420 LOC |
| `merge-agent-ledger-parity-tests` | Rewrite merge-agent ledger tests around dual-backend fixtures instead of SQLite files | F-005 | Depends on adapter fixture support | ~180 LOC |
| `reviewer-pass-token-parity-tests` | Rewrite reviewer-pass token tests around dual-backend fixtures and remove SQLite-only fixture assumptions | F-006 | Depends on adapter fixture support and caller migration decision | ~260 LOC |

## Notes

- `src/config-loader.mjs` and `test/config-loader.test.mjs` are the two backend-agnostic files in scope. They only define and validate `session_ledger.*` config keys, including the `postgres_runtime` alias, and do not directly touch ledger connections.
- The main risk concentration is Node-side ledger access. Every operational finding came from code that currently treats the canonical ledger as a SQLite file instead of a backend-neutral service target.
- The adapter prerequisite and reviewer-pass caller migration may exceed the repo's 300 LOC split threshold if combined. Prefer landing the canonical adapter first, then migrating merge-agent and reviewer-pass consumers in separate follow-up PRs.
