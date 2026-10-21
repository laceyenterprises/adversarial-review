# Launch-request status producer capture (PRM-03)

`rows.json` contains complete `LedgerDatabase.fetch_launch_request` results
from real enqueue/admit/lease/start/run/wait/resume/terminal calls on a disposable
ledger. The emitter is
`src/session_ledger/db_stores/worker_handoff_lifecycle.py` at agent-os revision
`2f686a90a102cf52e631dbf597d3e85826dc7b5d`; its implementation is unchanged by
this PR. The scenario and normalization are in
[`../../launch_request_status_capture.py`](../../launch_request_status_capture.py).
The owner suite compares new SQLite and disposable Postgres output to these
same examples. Canonical lifecycle and worker-pool archiver tests read this file.

Inputs are `LaunchRequestRecord` objects with adapter `contract-capture`,
per-scenario adapter/idempotency keys, worker `contract-worker`, auth owner
`contract-owner`, target `example/repo` / `capture`, and explicit PR completion
shape in both request payload and execution contract. All other values are
producer defaults. There is no spawn or external transport invocation: these
ledger APIs are the actual producer boundary. Reaping is simulated only by the
terminal CAS API on a temporary row; no reaper or cancellation command runs.

The lifecycle clock is fixed at `2026-10-20T00:00:00Z` before writer calls.
Only generated launch/lease identifiers, the per-capture key namespace,
and their nested references are normalized to `lrq_capture` / `wls_capture`. Nulls, keys, timestamps, lease TTL
and freshness windows, statuses, types and units are preserved. Each top-level
scenario is independent; normalized IDs do not imply a shared durable identity.

`cancelled` is passed to the real writer, which emits `canceled`.
`operator_triage_required` is reached from failed through the supervisor CAS.
`reaped_stuck_requested` is reached from requested through that same API.
`deferred-requested` applies the real admission-defer marker and remains
requested. The fetch projection does not emit admission-refusal columns; the
capture deliberately does not add them. `succeeded` alone has no publication
receipt or verified success signal, just as the producer emits it.

From the repository root, recapture only the disposable SQLite scenario:

```bash
: "${NETGUARD_ROOT:?Set to the provisioned netguard directory containing bin and site}"
test -d "$NETGUARD_ROOT/bin" && test -d "$NETGUARD_ROOT/site"
mkdir -p .tmp
env -u AGENT_OS_SESSION_LEDGER_TEST_DSN -u AGENT_OS_SESSION_LEDGER_DSN \
-u AGENT_OS_SESSION_LEDGER_DSN_DIRECT -u AGENT_OS_TEST_ALLOW_PG \
PRM03_RECAPTURE=1 AGENT_OS_SESSION_LEDGER_VDB=false \
NETGUARD_LOG="$PWD/.tmp/prm03-netguard.log" \
PATH="$NETGUARD_ROOT/bin:$PATH" PYTHONPATH="$NETGUARD_ROOT/site" \
python3 -c 'import subprocess; subprocess.run(["pytest", "platform/session-ledger/tests/test_terminalize_launch_request_success.py", "-k", "writer_status_capture_parity and sqlite", "-q", "--tb=short"], timeout=180, check=True)'
```

This writes `rows.json` directly from normalized actual output, then compares
it. Set `NETGUARD_ROOT` to your test harness's provisioned netguard directory
(the parent of its bin and site subdirectories). For Postgres parity,
use the existing `cwp_dispatch.smv.worker_pool.postgres` disposable fixture
(which verifies its owned data directory and uses a test database), retaining
netguard in the environment. With the already installed Postgres bin directory
selected with `PG_BIN` (for example, the directory containing
`$(command -v initdb)`), and package roots added for the setup helper:

```bash
: "${PG_BIN:?Set to the Postgres bin directory containing initdb and pg_ctl}"
env -u AGENT_OS_SESSION_LEDGER_TEST_DSN -u AGENT_OS_SESSION_LEDGER_DSN \
-u AGENT_OS_SESSION_LEDGER_DSN_DIRECT -u AGENT_OS_TEST_ALLOW_PG \
AGENT_OS_SESSION_LEDGER_VDB=false NETGUARD_LOG="$PWD/.tmp/prm03-postgres-netguard.log" \
PATH="$NETGUARD_ROOT/bin:$PG_BIN:$PATH" \
PYTHONPATH="$NETGUARD_ROOT/site:$PWD/modules/worker-pool/lib/python:$PWD/platform/session-ledger/src:$PWD/platform/agent-os-config/src" \
python3 - <<'PY'
import os, signal, subprocess, tempfile
from pathlib import Path
from cwp_dispatch.smv.worker_pool import postgres
def deadline(*_):
    raise TimeoutError("disposable Postgres capture exceeded 360 seconds")
signal.signal(signal.SIGALRM, deadline)
signal.alarm(360)
with tempfile.TemporaryDirectory(prefix="prm03-pg-", dir=Path.cwd() / ".tmp") as tmp:
    with postgres(Path(tmp)):
        env = {**os.environ, "AGENT_OS_SESSION_LEDGER_VDB": "false"}
        env.pop("PRM03_RECAPTURE", None)
        subprocess.run([
            "pytest",
            "platform/session-ledger/tests/test_terminalize_launch_request_success.py",
            "platform/session-ledger/tests/test_terminal_lease_retention.py",
            "modules/worker-pool/lib/python/cwp_dispatch/test/test_watch_completion_contract.py",
            "-q", "--tb=short",
        ], env=env, timeout=240, check=True)
PY
```

The outer deadline bounds setup/migration as well as pytest. The existing
fixture bounds init/teardown and always stops its owned Postgres process. This
runs selected unit suites, never the SMV smoke/PMV suite.
Malformed status mutations in the owner and archiver tests are explicitly
negative tests; they are not producer captures.

Each capture generates a fresh namespace for its adapter and idempotency keys,
then normalizes it out of the example. The parity test runs the capture twice
against the same disposable database to detect cross-run deduplication.
The Postgres case requires the explicit disposable test DSN; SQLite-only runs
report that leg as skipped, not as Postgres evidence.
