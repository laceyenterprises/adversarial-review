"""Optional offline deployment check against the installed Agent OS producer.

Run with hq_exec_python3_runtime; normal AR tests need no Agent OS checkout.
Only external I/O and operator identity are mocked, never the digest builder.
"""

from contextlib import ExitStack, closing
import importlib.util
from inspect import signature
import json
import os
import sqlite3
import subprocess
from tempfile import TemporaryDirectory
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from cwp_dispatch import cli_repair_enqueue_fence as producer


def load_reader():
    path = Path(__file__).resolve().parents[2] / "bin/read-legacy-repair-fence.py"
    spec = importlib.util.spec_from_file_location("installed_fence_reader", path)
    reader = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(reader)
    return path.parents[1], reader


class ProducerContractTest(unittest.TestCase):
    def test_actual_imports_signatures_and_observation_stable_evidence(self):
        root, reader = load_reader()
        key = "in-place-repair-" + "a" * 64
        args = SimpleNamespace(
            repo="fixture/repo",
            pr=5,
            base_head="b" * 40,
            epoch="repair-fixture",
            owner_key=key,
            handoff_round=3,
        )
        epoch = {
            "id": args.epoch,
            "ownerKey": key,
            "baseHead": args.base_head,
            "reservedAt": "2026-11-21T00:00:00+00:00",
            "ownerState": "absent",
            "ownerObservedAt": "2026-11-21T00:01:00+00:00",
            "absentObservations": 1,
        }
        head = {
            "number": 5,
            "state": "OPEN",
            "headRefOid": args.base_head,
            "headRefName": "fixture",
            "isCrossRepository": False,
        }
        # Pin every cross-repository private call's consumer signature.
        for function, positional, keywords in (
            (reader._evidence, (root, args, "fixture-owner"), {}),
            (reader._hq_owner, (root,), {}),
            (reader._adversarial_review_root, (), {}),
            (reader._require_hq_root_owner, (root,), {}),
            (reader._require_operator_continuation, (root,), {}),
            (reader._check_scope, (Mock(),), {"apply": False}),
            (reader._require_absence, (Mock(), {}), {}),
        ):
            signature(function).bind(*positional, **keywords)
        self.assertIs(reader._evidence, producer._evidence)
        conn = Mock(backend=reader.BACKEND_POSTGRES)
        with ExitStack() as stack:
            stack.enter_context(
                patch.object(
                    producer,
                    "_json_command",
                    side_effect=lambda argv, tool: head if argv[0] == "gh" else [epoch],
                )
            )
            stack.enter_context(
                patch.object(
                    producer,
                    "_read_handoff",
                    return_value={"sha256": "c" * 64},
                )
            )
            evidence = producer._evidence(root, args, "fixture-owner")
            receipt = {"evidence": evidence}
            conn.execute.return_value.fetchone.return_value = (json.dumps(receipt),)
            for name, value in {
                "hq_root_preferring_legacy_env": str(root),
                "_adversarial_review_root": root,
                "_hq_owner": "fixture-owner",
                "_require_hq_root_owner": None,
                "_require_operator_continuation": None,
                "resolve_ledger_target": SimpleNamespace(
                    backend=reader.BACKEND_POSTGRES,
                    dsn="fixture",
                ),
                "open_ledger_for_runtime_readonly": conn,
                "_check_scope": None,
                "_require_absence": None,
            }.items():
                stack.enter_context(patch.object(reader, name, return_value=value))
            argv = [args.repo, "5", args.base_head, args.epoch, key, "3"]
            epoch.update(
                ownerObservedAt="2026-11-21T00:31:00+00:00",
                ownerState="absent-unfenced",
                absentObservations=42,
            )
            self.assertEqual(reader.main(argv), receipt)
            epoch["reservedAt"] = "2026-11-21T00:02:00+00:00"
            with self.assertRaisesRegex(
                reader.RepairFenceRefused,
                "persisted-fence-identity-mismatch",
            ):
                reader.main(argv)

    def test_real_cwp_submitter_and_receipt_revalidated_by_reader(self):
        from cwp_dispatch import auto_merge_daemon, pre_lrq_boot
        from cwp_helm import pr_branch_owner
        from session_ledger.alembic_postgres_revisions import r346, r348
        from session_ledger.repair_enqueue_fence import _require_absence, recover

        root, reader = load_reader()
        key = "cwp-" + "e" * 24
        epoch_id = "repair-00000000-0000-0000-0000-000000000017"
        worker = "codex-conflict-pr-17-rebase-1234abcd"
        repo, pr, base, current, branch = (
            "fixture/widgets",
            17,
            "a" * 40,
            "b" * 40,
            "topic",
        )
        operator = "fixture-owner"
        epoch = {
            "id": epoch_id,
            "ownerKey": key,
            "baseHead": base,
            "cause": "conflict-without-owner",
            "ownerState": "unknown",
            "reservedAt": "2026-11-21T00:01:00Z",
            "priorSpend": {"lifetime": 3},
        }
        head = {
            "number": pr,
            "state": "OPEN",
            "headRefOid": current,
            "headRefName": branch,
            "isCrossRepository": False,
        }
        with ExitStack() as stack:
            tmp = Path(stack.enter_context(TemporaryDirectory())).resolve()
            hq_root = tmp / "hq"
            hq_root.mkdir()
            alias = tmp / "hq-alias"
            alias.symlink_to(hq_root, target_is_directory=True)
            state = auto_merge_daemon._state_dir(hq_root, operator)
            job = state / "conflict-dispatch" / f"{worker}.json"
            job.parent.mkdir(parents=True)
            registration = hq_root / "repos/widgets/.hq/registration.json"
            registration.parent.mkdir(parents=True)
            registration.write_text(
                json.dumps({"url": f"https://github.com/{repo}.git"})
            )
            recipe = {
                "--worker-id": worker,
                "--root": str(hq_root),
                "--worker-class": "codex",
                "--parent-session": f"daemon:auto-merge:{operator}",
                "--project": "widgets",
                "--repo": "widgets",
                "--task-kind": "coding",
                "--pr": str(pr),
                "--branch": branch,
                "--completion-shape": "branch-push",
                "--ticket": f"CONFLICT-PR-{pr}-REBASE",
                "--prompt": str(state / "conflict-prompts" / f"{pr}.md"),
                "--conflict-owner-head": base,
            }
            job.write_text(
                json.dumps(
                    {
                        "workerId": worker,
                        "hqRoot": str(hq_root),
                        "argv": [
                            "/fixture/modules/worker-pool/bin/hq",
                            "dispatch",
                            "--allow-conflicted-base",
                            *(value for pair in recipe.items() for value in pair),
                        ],
                    }
                )
            )
            result = job.with_suffix(".result.json")
            result.write_text(json.dumps({"returncode": 1, "stdout": ""}))
            audit = pre_lrq_boot.audit_path(hq_root)
            audit.parent.mkdir(parents=True, exist_ok=True)
            prefix = b'{"recordKind":"unrelated"}\n'
            trace = pre_lrq_boot.PreLrqBootTrace(
                hq_root=hq_root,
                idempotency_key=key,
                worker_class="codex",
                ticket_ref=f"CONFLICT-PR-{pr}-REBASE",
                task_kind="coding",
                repo="widgets",
                worker_id=worker,
                budgets_ms={},
            )
            trace.fail(
                failure_class="pre_lrq_exception", failure_detail="ProvisionError"
            )
            trace.mark("dispatch.accepted", at="2026-11-21T00:00:00Z")
            trace.mark("repo.resolved", at="2026-11-21T00:00:30Z")
            trace.mark(
                "worktree.provision.start", at="2026-11-21T00:01:01Z", workerId=worker
            )
            trace.mark(
                "worktree.provision.ready", at="2026-11-21T00:01:02Z", workerId=worker
            )
            trace.spans[-1].update(outcome="failed", errorType="ProvisionError")
            audit.write_bytes(prefix + json.dumps(trace.record()).encode() + b"\n")
            argv = [
                repo,
                str(pr),
                base,
                epoch_id,
                key,
                current,
                worker,
                str(len(prefix)),
            ]
            producer_args = SimpleNamespace(
                repo=repo,
                pr=pr,
                base_head=base,
                current_head=current,
                epoch=epoch_id,
                owner_key=key,
                conflict_worker_id=worker,
                boot_trace_offset=len(prefix),
            )
            stack.enter_context(
                patch.object(
                    producer,
                    "_json_command",
                    side_effect=lambda _, tool: (
                        head if tool == "current-pr-head" else [epoch]
                    ),
                )
            )
            conn = Mock(backend=reader.BACKEND_POSTGRES)
            for name, value in {
                "hq_root_preferring_legacy_env": str(alias),
                "_adversarial_review_root": root,
                "_hq_owner": operator,
                "_require_hq_root_owner": None,
                "_require_operator_continuation": None,
                "resolve_ledger_target": SimpleNamespace(
                    backend=reader.BACKEND_POSTGRES, dsn="fixture"
                ),
                "open_ledger_for_runtime_readonly": conn,
                "_check_scope": None,
                "_require_absence": None,
            }.items():
                stack.enter_context(patch.object(reader, name, return_value=value))
            owner = stack.enter_context(
                patch.object(
                    pr_branch_owner,
                    "lookup_pr_owner",
                    return_value={
                        "ok": True,
                        "repo": repo,
                        "prNumber": pr,
                        "owner": None,
                    },
                )
            )
            # The deployed producer builds and commits the actual receipt in
            # a disposable store. Mock only the consumer's DB transport here.
            db = stack.enter_context(closing(sqlite3.connect(":memory:")))
            db.execute(
                "CREATE TABLE launch_requests (idempotency_key TEXT, request_payload_json TEXT, "
                "status TEXT, target_repo TEXT)"
            )
            db.executescript(r346.MIGRATION.raw_sql)
            db.executescript(r348.MIGRATION.raw_sql)

            def build():
                return producer._evidence(
                    root, producer_args, operator, hq_root=hq_root
                )

            # A zero-row inspection alone leaves every delayed route open.
            # Roll back each probe so the fixture can commit the real fence.
            delayed = [
                (key, {}),
                (f"{key}:worker-payload-retry:1", {}),
                ("new-key", {"repairEpoch": {"ownerKey": key}}),
                ("new-key", {"repairEpoch": {"id": epoch_id}}),
            ]
            self.assertTrue(recover(db, build())["canonicalAbsence"])
            for candidate, payload in delayed:
                db.execute(
                    "INSERT INTO launch_requests VALUES (?, ?, ?, ?)",
                    (candidate, json.dumps(payload), "requested", "other/repo"),
                )
                self.assertEqual(
                    db.execute("SELECT count(*) FROM launch_requests").fetchone()[0], 1
                )
                with self.assertRaisesRegex(
                    reader.RepairFenceRefused, "canonical-launch-or-retry-present"
                ):
                    _require_absence(db, build())
                db.rollback()
            receipt = recover(db, build(), apply=True, revalidate=build)
            for candidate, payload in delayed:
                with self.assertRaisesRegex(
                    sqlite3.IntegrityError, "repair-owner-enqueue-fenced"
                ):
                    db.execute(
                        "INSERT INTO launch_requests VALUES (?, ?, ?, ?)",
                        (candidate, json.dumps(payload), "requested", "other/repo"),
                    )
                db.rollback()
            self.assertEqual(
                db.execute("SELECT count(*) FROM launch_requests").fetchone()[0], 0
            )
            conn.execute.return_value.fetchall.return_value = db.execute(
                "SELECT owner_key, receipt_json FROM repair_enqueue_fences"
            ).fetchall()
            epoch.update(ownerState="absent-unfenced", absentObservations=4)
            self.assertEqual(reader.main(argv), receipt)
            owner.assert_called_once_with(hq_root, repo, pr)
            reader._hq_owner.assert_called_once_with(hq_root)

            for obj, field, changed, reason in (
                (head, "headRefOid", "d" * 40, "current-pr-head-mismatch"),
                (head, "isCrossRepository", True, "current-pr-head-mismatch"),
                (
                    head,
                    "headRefName",
                    "other-topic",
                    "original-conflict-dispatch-recipe-unproven",
                ),
                (epoch, "baseHead", current, "repair-epoch-identity-mismatch"),
                (
                    epoch,
                    "priorSpend",
                    {"lifetime": 4},
                    "persisted-fence-identity-mismatch",
                ),
                (
                    epoch,
                    "reservedAt",
                    "2026-11-21T00:00:59Z",
                    "persisted-fence-identity-mismatch",
                ),
            ):
                with self.subTest(field=field):
                    old, obj[field] = obj[field], changed
                    try:
                        with self.assertRaisesRegex(reader.RepairFenceRefused, reason):
                            reader.main(argv)
                    finally:
                        obj[field] = old
            with self.assertRaisesRegex(
                reader.RepairFenceRefused,
                "original-conflict-dispatch-evidence-unavailable",
            ):
                reader.main([*argv[:-1], str(len(prefix) + 1)])
            result.unlink()
            with self.assertRaisesRegex(
                reader.RepairFenceRefused,
                "original-conflict-dispatch-evidence-unavailable",
            ):
                reader.main(argv)

    def test_actual_reservation_read_while_retirement_locks_are_held(self):
        source_root = Path(__file__).resolve().parents[2]
        with TemporaryDirectory(prefix="repair-fence-held-locks-") as temporary:
            root = Path(temporary)
            (root / "src").symlink_to(source_root / "src", target_is_directory=True)
            script = r"""
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
const [source, root, read] = process.argv.slice(1);
const {hammerRetryCapFilePath, updateHammerRetryCapLedger} = await import(pathToFileURL(source + '/src/ama/hammer-retry-cap.mjs'));
const {tryAcquireCloserIntentLock} = await import(pathToFileURL(source + '/src/ama/pre-receipt-intent.mjs'));
const {withRepositoryStateRead} = await import(pathToFileURL(source + '/src/repository-state-lock.mjs'));
const identity = {repo:'fixture/widgets', prNumber:17};
const epoch = {id:'repair-fixture', ownerKey:'fixture', baseHead:'a'.repeat(40)};
const file = hammerRetryCapFilePath(root, identity);
mkdirSync(dirname(file), {recursive:true});
writeFileSync(file, JSON.stringify({...identity, repairEpochs:[epoch]}));
withRepositoryStateRead(root, () => {
  const unlock = tryAcquireCloserIntentLock(root, identity);
  assert.equal(typeof unlock, 'function');
  try {
    updateHammerRetryCapLedger(root, identity, ledger => {
      for (let i=0;i<3;i++) {
        const result=execFileSync(process.execPath, ['--input-type=module','-e',read,root,identity.repo,'17'], {encoding:'utf8',timeout:5000});
        assert.deepEqual(JSON.parse(result), [epoch]);
      }
      return ledger;
    });
  } finally {unlock();}
});
console.log('three real producer reads completed under both retirement locks');
"""
            result = subprocess.run(
                [
                    "node",
                    "--input-type=module",
                    "-e",
                    script,
                    str(source_root),
                    str(root),
                    producer.READ_EPOCHS,
                ],
                capture_output=True,
                text=True,
                timeout=25,
                check=True,
            )
            self.assertIn("three real producer reads", result.stdout)

    @unittest.skipUnless(
        os.environ.get("AR_TEST_CANONICAL_FENCE_DSN"),
        "owned Postgres fixture not supplied",
    )
    def test_real_postgres_committed_fence_read(self):
        import psycopg
        from session_ledger.db_postgres import (
            PostgresLedgerConnection,
            upgrade_postgres_schema,
        )
        from session_ledger.db_runtime import open_ledger_for_runtime_readonly
        from session_ledger.pytest_disposable import require_test_database
        from session_ledger.test_dsn import resolve_disposable_test_dsn
        from session_ledger.repair_enqueue_fence import recover

        dsn = resolve_disposable_test_dsn(os.environ["AR_TEST_CANONICAL_FENCE_DSN"])
        require_test_database(dsn)
        _, reader = load_reader()
        upgrade_postgres_schema(dsn)
        conn = PostgresLedgerConnection(psycopg.connect(dsn, connect_timeout=3))
        try:
            evidence = {
                "ownerKey": "in-place-repair-" + "e" * 64,
                "epochId": "repair-owned-fixture",
                "repo": "fixture/widgets",
                "prNumber": 17,
                "submitter": {
                    "provenanceRef": "merge-agent-rescue:fixture/widgets#17:owned-fixture"
                },
            }
            cwp = {
                **evidence,
                "ownerKey": "cwp-" + "e" * 24,
                "epochId": "repair-00000000-0000-0000-0000-000000000017",
                "baseHead": "a" * 40,
                "currentHead": "b" * 40,
                "branch": "topic",
                "submitter": {"kind": "native-auto-merge-conflict-dispatch"},
            }
            committed = recover(conn, evidence, apply=True, revalidate=lambda: evidence)
            cwp_committed = recover(conn, cwp, apply=True, revalidate=lambda: cwp)
            readonly = open_ledger_for_runtime_readonly(dsn=dsn, timeout=5, fixed=True)
            try:
                self.assertEqual(
                    reader.read_committed_proof(readonly, evidence["ownerKey"]),
                    committed,
                )
                self.assertEqual(
                    reader.read_committed_proof(
                        readonly, cwp["ownerKey"], cwp_epoch_id=cwp["epochId"]
                    ),
                    cwp_committed,
                )
            finally:
                readonly.close()
        finally:
            conn.close()


if __name__ == "__main__":
    unittest.main()
