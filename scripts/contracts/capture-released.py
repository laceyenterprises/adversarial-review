"""Capture real fleet output over disposable released-floor inputs.

Run against an archive of agent-os f54169eb71c6f0b55b51d3025dd435c88652277e.
Requires the producer's pytest dependencies; never part of the offline Node suite.
"""

import contextlib
from datetime import timedelta
import io
import json
from pathlib import Path
import runpy
import socket
import sys
import tempfile

import pytest

source = Path(sys.argv[1]).resolve()
for relative in (
    "platform", "modules/worker-pool/lib/python", "modules/token-budget/lib/python",
    "modules/hq-control-plane/server", "platform/agent-os-config/src",
    "platform/dispatch-core/src", "platform/release-manifest/src",
    "platform/session-ledger/src",
):
    sys.path.insert(0, str(source / relative))

owner = runpy.run_path(str(source / "modules/worker-pool/lib/python/tests/test_quota_reserve_weekly.py"))
from cwp_quota_probe import anthropic_usage
from cwp_quota_probe.status_store import write_status


class Captured(Exception):
    pass


def no_network(*args, **kwargs):
    raise AssertionError("capture must not use network")


with tempfile.TemporaryDirectory() as directory, pytest.MonkeyPatch.context() as patch:
    root = Path(directory)
    (root / "config.yaml").write_text('{"version": 1}\n')
    patch.setenv("AGENT_OS_CONFIG_PATH", str(root / "config.yaml"))
    patch.setattr(socket, "socket", no_network)
    for key in ("AGENT_OS_SESSION_LEDGER_DSN", "AGENT_OS_SESSION_LEDGER_DSN_DIRECT",
                "AGENT_OS_SESSION_LEDGER_SERVICE_ROOT"):
        patch.delenv(key, raising=False)
    patch.setenv("HQ_ROOT", str(root))
    patch.setenv("AGENT_OS_SESSION_LEDGER_POSTGRES_RUNTIME", "false")
    patch.setenv("AGENT_OS_SESSION_LEDGER_VDB", "false")
    patch.setenv("AGENT_OS_OPERATOR_TASKS_DB_PATH", str(root / "operator-tasks.db"))
    evidence = owner["evidence"].__wrapped__(root, patch)
    now = owner["NOW"]
    for row in evidence[2]:
        row["usedPercent"] = 20.0 if row["window"] == "primary" else 25.0
        row["resetsAt"] = (now + timedelta(hours=6)).isoformat()
    for account in owner["ACCOUNTS"]:
        anthropic_usage._usage_path(root, account).write_text(json.dumps({"windows": anthropic_usage.parse_usage({
            "five_hour": {"utilization": 20, "resets_at": (now + timedelta(hours=4)).isoformat()},
            "seven_day": {"utilization": 25, "resets_at": (now + timedelta(hours=6)).isoformat()},
        }, now=now)}))
        write_status(root, {"provider": "anthropic", "authPath": account, "state": "ok",
                            "lastProbeAt": now.isoformat(), "lastGoodAt": now.isoformat()})
    output = io.StringIO()
    errors = io.StringIO()

    class Capture:
        def readouterr(self):
            # SQLite's idempotent migration backstops report existing columns.
            assert all(line.startswith("session-ledger migration skipping already-present column ")
                       for line in errors.getvalue().splitlines()), errors.getvalue()
            self.payload = json.loads(output.getvalue().replace(str(root), "<scratch>"))
            raise Captured()

    capture = Capture()
    try:
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            owner["test_fleet_producer_capture_parity"](evidence, patch, capture, "ready")
    except Captured:
        pass
    for floor in capture.payload["reserveFloors"].values():
        assert floor["released"] and not floor["active"] and not floor["paused"] and not floor["nearCap"]
        assert floor["weeklyMeasurement"]["status"] == "measured"
    print(json.dumps(capture.payload, indent=2, sort_keys=True))
