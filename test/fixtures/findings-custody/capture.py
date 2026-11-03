import getpass
import json
import os
import sqlite3
import tempfile
from pathlib import Path

os.environ.update(
    AGENT_OS_SESSION_LEDGER_VDB="false",
    AGENT_OS_SESSION_LEDGER_POSTGRES_RUNTIME="off",
    AGENT_OS_SESSION_LEDGER_BACKEND="sqlite",
    AGENT_OS_SESSION_LEDGER_TEST_MODE="1",
)
from cwp_dispatch import watch
from session_ledger import MIGRATIONS_DIR
from session_ledger.db import LedgerDatabase
from session_ledger.canonical_views.app_dispatch_reads import fetch_app_dispatch_reads
from session_ledger.models import (
    LaunchRequestRecord,
    WorkerRunRecord,
    WorkerLaunchReceiptRecord,
    WorkerMilestoneRecord,
)
from session_ledger.worker_observability import WorkerObservability

lrq = "lrq_findings-custody-fixture"
run = "wrun_findings-custody-fixture"
repo = "sample/service"
workspace = "/synthetic/hq/workers/codex-findings/service"
with tempfile.TemporaryDirectory(prefix="findings-native-contract-") as directory:
    root = Path(directory)
    dbpath = root / "ledger.db"
    db = LedgerDatabase(dbpath, force_sqlite=True)
    db.migrate(MIGRATIONS_DIR)
    db.enqueue_launch_request(
        LaunchRequestRecord(
            launch_request_id=lrq,
            adapter="test-adapter",
            adapter_request_key=lrq,
            idempotency_key="findings-batch-fixture",
            submitted_by="fixture",
            source_surface="isolated-validation",
            worker_class="codex",
            runtime_kind="exec",
            route_intent="enqueue-worker-handoff",
            requested_auth_owner=getpass.getuser(),
            requested_at="2026-11-02T00:00:00Z",
            task_type="coding",
            target_repo=repo,
            target_worktree=workspace,
            target_branch="fixture/findings",
            request_payload={
                "ticketRef": "FINDINGS-fixture",
                "expectedCompletionShape": "decision-only",
            },
        )
    )
    obs = WorkerObservability(db)
    obs.open_run(
        receipt=WorkerLaunchReceiptRecord(
            runtime_substrate="exec", launch_status="launched", launch_request_id=lrq
        ),
        run=WorkerRunRecord(
            worker_kind="codex",
            runtime_substrate="exec",
            started_at="2026-11-02T00:00:00Z",
            run_id=run,
            launch_request_id=lrq,
            repo_path=workspace,
            worktree_path=workspace,
            branch_name="fixture/findings",
        ),
    )
    obs.materialize_milestone(
        WorkerMilestoneRecord(
            run_id=run,
            milestone_key="branch_pushed",
            status="done",
            observed_at="2026-11-02T00:00:50Z",
            detail="Disposable fixture push evidence; no real push",
        )
    )
    obs.mark_run_terminal(
        run_id=run, status="succeeded", ended_at="2026-11-02T00:01:00Z"
    )
    db.terminalize_launch_request_from_status(
        lrq,
        current_status="requested",
        terminal_status="succeeded",
        recorded_at="2026-11-02T00:01:00Z",
    )
    card = watch.resolve_status(
        db, lrq, owner_user=getpass.getuser(), hq_root=root
    ).to_dict()
    fields = [
        "launchRequestId",
        "dispatchId",
        "workerRunId",
        "ticketRef",
        "repo",
        "workspacePath",
        "branch",
        "status",
        "terminal",
        "succeeded",
        "milestones",
    ]
    with sqlite3.connect(dbpath) as conn:
        conn.row_factory = sqlite3.Row
        worker = dict(
            conn.execute(
                "SELECT run_id,launch_request_id,repo_path,worktree_path FROM worker_runs"
            ).fetchone()
        )
    projection = fetch_app_dispatch_reads(
        db.conn, selector={"launch_request_ids": [lrq]}, registry_ids=[lrq], hq_root=root
    )
    assert projection["status"] == "found" and len(projection["items"]) == 1
    launch = projection["items"][0]
    assert "target_worktree" not in launch
    print(
        json.dumps(
            {
                "status": {k: card[k] for k in fields},
                "worker": worker,
                "launch": launch,
            },
            indent=2,
        )
    )
    db.close()
