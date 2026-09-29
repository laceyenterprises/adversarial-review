## Adversarial Review — Claude (claude-reviewer-lacey)

> Reviewer: claude · claude-opus-5-5 · high

> Cross-model review waiver: ADVERSARIAL_REVIEW_DEFAULT_REVIEWER=(unset) pins reviewer=claude for builder=claude-code; the default cross-model review guarantee is waived for this pass by explicit routing state.

## Summary
Re-review of the test-mode redirect for the op-shim ledger in `op_adapter._op_shim_ledger_path`. The remediation handles both points the earlier round appears to have raised:

- **Single test-mode resolver (TCR-05).** Test-mode detection now delegates to `session_ledger.db_path._running_in_test_mode`, which also recognises the pytest env-isolation sentinel.
- **Scratch-ledger cleanup.** Each process's scratch ledger is removed at exit, with a pid guard so forked children don't delete the parent's directory.

I checked the production path:

- `db_path` pulls in only the stdlib and `agent_os_config_helper`, which imports `agent_os_config` lazily. The new lazy import is therefore cheap and has no config-load side effects.
- Both callers of `_op_shim_ledger_path` catch `Exception`: `_emit_op_cache_event` and `op_cache_alerts.record_op_unavailable_circuit_trip`. A resolver failure can't break credential resolution.
- The explicit `OP_SHIM_DB_PATH` override still wins over the test-mode check. The existing ledger tests (`test_op_adapter.py:3214`, `3470`, `3482`, `3498`) set it explicitly, so they are unaffected.
- The op spawn, cache-store and circuit-clear semantics that the hardening-ledger contracts cover (orphan reaping, empty-value integrity) are unchanged.
- Spec-coverage rule: only private helpers changed, so it does not trigger.
- Operational-behavior rule: the production path is unchanged whenever the process is not a test process.

What remains are coverage gaps and fail-silent edges, all non-blocking.

## Blocking issues
- None.

## Non-blocking issues
- **Fail-open when session_ledger is not importable**
  - **File:** `modules/worker-pool/lib/python/cwp_dispatch/op_adapter.py`
  - **Lines:** `641-652`
  - **Problem:** `_running_in_test_process` returns `False` whenever `session_ledger` is not on `sys.path`. Any test run that imports `cwp_dispatch.op_adapter` without the worker-pool `conftest.py` path setup is then treated as production and writes to the live ledger at `~/.agent-os/op-shim/calls.db`. Examples: another module's suite, or a script test that puts only `modules/worker-pool/lib/python` on the path. This is exactly the failure this PR is meant to prevent.
  - **Why it matters:** The protection depends on the ambient `PYTHONPATH`, not on whether the process is actually a test. The fallback direction is "pollute the live ledger", which can recreate the "20 fleet circuit trips" false signal from a different suite.
  - **Recommended fix:** Pick one:
    - Move the canonical resolver into `agent_os_core`, the layer-zero helper package, so every consumer can import it.
    - Fail closed on the import-missing branch when `"pytest" in sys.modules`. That is a one-line guard, not a second resolver.

    Either way, add a test that runs a subprocess without `session_ledger` on the path.
- **Private cross-package import fails silent in production**
  - **File:** `modules/worker-pool/lib/python/cwp_dispatch/op_adapter.py`
  - **Lines:** `646-651`
  - **Problem:** `from session_ledger.db_path import _running_in_test_mode` binds to a private name in another package. If it is renamed or moved, the import raises `ImportError`, not `ModuleNotFoundError`, so it is re-raised. The broad `except Exception` in `_emit_op_cache_event` and in `record_op_unavailable_circuit_trip` then swallows it. The result is that every production `op_cache_events` row and every `op_unavailable` trip record is dropped silently, and those rows feed the op-hammer alerting.
  - **Why it matters:** A refactor elsewhere would silently turn off production op telemetry. `test_test_process_detection_delegates_to_the_session_ledger_resolver` does pin the attribute through `patch.object`, which reduces the risk, but the runtime failure is still invisible.
  - **Recommended fix:** Expose a public alias in `session_ledger.db_path`, e.g. `running_in_test_mode`, and import that instead. Alternatively, catch `ImportError` around the import and log once at warning level, so the failure shows up in logs instead of being swallowed.
- **Node op shim still writes the live ledger from tests**
  - **File:** `scripts/lib/op-rate-limit-shim.mjs`
  - **Lines:** `340-378, 470`
  - **Problem:** The Node shim resolves `env.OP_SHIM_DB_PATH || defaultDbPath()`, and `defaultDbPath()` is `~/.agent-os/op-shim/calls.db`, with no test-mode redirect. A Python test that spawns the real `op` shim without setting `OP_SHIM_DB_PATH` still writes admission and exit rows to the principal's live ledger. The PR comment says only that "any other test write goes to a per-process scratch ledger". It doesn't say this covers Python writes only.
  - **Why it matters:** This path can also distort the live ledger's attribution counts (the 2026-09-26 symptom) and the rate observed by `op-read-rate.mjs`.
  - **Recommended fix:** Pick one:
    - Have the test harness (`conftest.py`) export `OP_SHIM_DB_PATH` to a session-scoped temp path, so child processes inherit it.
    - Add an equivalent test-mode guard to the Node shim.
- **Scratch dir leaks and shared-tmp predictability**
  - **File:** `modules/worker-pool/lib/python/cwp_dispatch/op_adapter.py`
  - **Lines:** `656-669`
  - **Problem:**
    - Cleanup runs only through `atexit`. Processes that end via `os._exit` (multiprocessing fork children), SIGKILL or a timeout kill leave `agent-os-op-shim-test-<pid>` directories behind.
    - The path is predictable and keyed on pid. On a shared `/tmp`, such as Linux CI, a leftover directory from a recycled pid or one owned by another user makes the `st_uid` check skip every write silently.
    - A scratch ledger shared by all tests in one process carries trip rows from test to test, so `op_cache_alerts` threshold logic can depend on test order when a test doesn't set `OP_SHIM_DB_PATH`.
  - **Why it matters:** This is low-severity accumulation and a source of non-deterministic test results, not a production risk.
  - **Recommended fix:** Create the directory with `tempfile.mkdtemp(prefix="agent-os-op-shim-test-")` once per process, cached by pid, instead of using a predictable name. Optionally, set `OP_SHIM_DB_PATH` per test in the worker-pool `conftest.py` autouse fixture.
- **Subprocess cleanup test hides child diagnostics**
  - **File:** `modules/worker-pool/lib/python/cwp_dispatch/test/test_op_adapter.py`
  - **Lines:** `2069-2088`
  - **Problem:** `subprocess.run(..., check=True, capture_output=True)` raises `CalledProcessError` without showing the child's stderr. An import failure in the child (for example a missing `agent_os_config` on a copied `sys.path`) therefore shows up as an opaque failure.
  - **Why it matters:** The test becomes hard to diagnose when it flakes in CI.
  - **Recommended fix:** Use `check=False` and `assertEqual(result.returncode, 0, result.stderr)`.

## Suggested fixes
- Make the test-mode fallback fail closed when `session_ledger` cannot be imported (at minimum honour `"pytest" in sys.modules`), or move the resolver into `agent_os_core`.
- Import a public alias of the test-mode resolver, or log `ImportError` instead of letting it be swallowed by the telemetry `except Exception`.
- Export a session-scoped `OP_SHIM_DB_PATH` from the worker-pool `conftest.py` so Node-shim child processes spawned by tests also avoid the live ledger.
- Replace the pid-named scratch directory with `tempfile.mkdtemp`, cached per pid.
- Surface child stderr in `test_scratch_op_shim_ledger_is_removed_at_exit`.

## Verdict
Comment only
