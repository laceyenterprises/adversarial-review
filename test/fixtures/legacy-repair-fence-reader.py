"""Exercise the read-only bridge without an Agent OS checkout or network."""

import importlib.util
from contextlib import contextmanager, nullcontext, redirect_stderr
from io import StringIO
import json
from pathlib import Path
import re
import sys
from tempfile import TemporaryDirectory
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import Mock, patch


class FenceRefused(ValueError):
    pass


def load_reader(test):
    dependencies = {
        "agent_os_config.roots": {"hq_root_preferring_legacy_env": Mock()},
        "cwp_dispatch.cli_repair_enqueue_fence": {
            "REPO": re.compile(r"[a-z0-9]+/[a-z0-9]+"),
            "RepairFenceRefused": FenceRefused,
            "_adversarial_review_root": Mock(),
            "_evidence": Mock(),
            "_hq_owner": Mock(),
            "_require_hq_root_owner": Mock(),
            "_require_operator_continuation": Mock(),
        },
        "cwp_helm.pr_branch_owner": {"lookup_pr_owner": Mock()},
        "cwp_dispatch.enqueue_refusal": {"observe_unlocked_key": Mock()},
        "session_ledger.db_path": {
            "BACKEND_POSTGRES": "postgres",
            "resolve_ledger_target": Mock(),
        },
        "session_ledger.db_runtime": {"open_ledger_for_runtime_readonly": Mock()},
        "session_ledger.repair_enqueue_fence": {
            "CWP_OWNER_KEY": re.compile(r"cwp-[a-f0-9]{24}"),
            "HEAD_SHA": re.compile(r"[a-f0-9]{40}"),
            "REPAIR_EPOCH_ID": re.compile(r"repair-[a-f0-9-]{36}"),
            "_check_scope": Mock(),
            "_require_absence": Mock(),
        },
    }
    modules = {}
    for name, symbols in dependencies.items():
        modules[name] = ModuleType(name)
        vars(modules[name]).update(symbols)
    path = Path(__file__).resolve().parents[2] / "bin/read-legacy-repair-fence.py"
    spec = importlib.util.spec_from_file_location("read_legacy_repair_fence", path)
    reader = importlib.util.module_from_spec(spec)
    test.enterContext(patch.dict(sys.modules, modules))
    spec.loader.exec_module(reader)
    return reader


class FenceReaderFixture(unittest.TestCase):
    def setUp(self):
        self.reader = load_reader(self)
        self.key = "in-place-repair-" + "a" * 64
        self.evidence = {
            "ownerKey": self.key,
            "baseHead": "b" * 40,
            "reservationSha256": "c" * 64,
            "submitter": {"sha256": "d" * 64},
        }
        self.receipt = {"evidence": self.evidence}
        self.conn = Mock(backend="postgres")
        self.conn.execute.return_value.fetchone.return_value = (
            json.dumps(self.receipt),
        )
        self.reader.hq_root_preferring_legacy_env.return_value = "/fixture"
        self.reader._adversarial_review_root.return_value = (
            Path(__file__).resolve().parents[2]
        )
        self.reader.resolve_ledger_target.return_value = SimpleNamespace(
            backend="postgres", dsn="disposable-fixture"
        )
        self.reader.open_ledger_for_runtime_readonly.return_value = self.conn
        self.reader._evidence.return_value = self.evidence
        self.argv = ["fixture/repo", "5", "b" * 40, "epoch", self.key, "3"]


class CanonicalFenceReaderTest(FenceReaderFixture):
    def test_existing_fence_requires_guarded_global_read_and_fresh_evidence(self):
        self.assertEqual(self.reader.main(self.argv), self.receipt)
        self.reader._require_operator_continuation.assert_called_once_with(
            Path("/fixture")
        )
        self.reader._require_hq_root_owner.assert_called_once_with(Path("/fixture"))
        self.reader._check_scope.assert_called_once_with(
            self.conn, apply=False, readonly_connection=True
        )
        self.reader._require_absence.assert_called_once_with(self.conn, self.evidence)
        self.conn.execute.assert_called_once_with(
            "SELECT receipt_json FROM public.repair_enqueue_fences WHERE owner_key = ?",
            (self.key,),
        )
        self.conn.rollback.assert_called_once_with()
        self.conn.close.assert_called_once_with()
        self.conn.commit.assert_not_called()

    def test_canonical_receipt_accepts_text_or_decoded_json(self):
        for value in (json.dumps(self.receipt), self.receipt):
            with self.subTest(value_type=type(value).__name__):
                self.conn.execute.return_value.fetchone.return_value = (value,)
                self.assertEqual(self.reader.main(self.argv), self.receipt)

    def test_delayed_enqueue_or_missing_guard_refuses_retirement(self):
        for guard in (self.reader._check_scope, self.reader._require_absence):
            with self.subTest(guard=guard):
                guard.side_effect = FenceRefused("unfenced or launch or retry present")
                with self.assertRaises(FenceRefused):
                    self.reader.main(self.argv)
                guard.side_effect = None
        self.reader._evidence.assert_not_called()
        self.assertEqual(self.conn.rollback.call_count, 2)

    def test_uncommitted_fence_or_enqueue_history_is_insufficient(self):
        for row in (None, (None,)):
            self.conn.execute.return_value.fetchone.return_value = row
            with self.assertRaisesRegex(
                FenceRefused, "committed-enqueue-fence-required"
            ):
                self.reader.main(self.argv)
        self.reader._evidence.assert_not_called()

    def test_fresh_pr_reservation_and_submitter_must_match(self):
        for field, changed in (
            ("baseHead", "moved"),
            ("reservationSha256", "replaced"),
            ("submitter", {"sha256": "changed"}),
        ):
            with self.subTest(field=field):
                self.reader._evidence.return_value = {**self.evidence, field: changed}
                with self.assertRaisesRegex(
                    FenceRefused, "persisted-fence-identity-mismatch"
                ):
                    self.reader.main(self.argv)
        self.reader._evidence.side_effect = FenceRefused("current-pr-head-mismatch")
        with self.assertRaisesRegex(FenceRefused, "current-pr-head-mismatch"):
            self.reader.main(self.argv)

    def test_operator_refusal_and_noncanonical_target_open_no_ledger(self):
        for guard in (
            self.reader._require_operator_continuation,
            self.reader._require_hq_root_owner,
        ):
            guard.side_effect = FenceRefused("operator-only")
            with self.assertRaisesRegex(FenceRefused, "operator-only"):
                self.reader.main(self.argv)
            guard.side_effect = None
        self.reader.resolve_ledger_target.return_value.backend = "sqlite"
        with self.assertRaisesRegex(FenceRefused, "canonical-postgres-ledger-required"):
            self.reader.main(self.argv)
        self.reader.open_ledger_for_runtime_readonly.assert_not_called()

    def test_refusal_codes_are_redacted_and_other_errors_stay_generic(self):
        for error, expected in (
            (
                FenceRefused("committed-enqueue-fence-required"),
                "repair-fence-refused:committed-enqueue-fence-required",
            ),
            (
                FenceRefused("original-submitter-path-key-mismatch: /private/handoff"),
                "repair-fence-refused:original-submitter-path-key-mismatch",
            ),
            (
                FenceRefused("postgresql://private@host/db"),
                "canonical-committed-repair-fence-or-current-evidence-unavailable",
            ),
            (
                ImportError("private module path"),
                "canonical-committed-repair-fence-or-current-evidence-unavailable",
            ),
        ):
            with self.subTest(error=error):
                stderr = StringIO()
                with (
                    patch.object(self.reader, "main", side_effect=error),
                    redirect_stderr(stderr),
                ):
                    self.assertEqual(self.reader.run(self.argv), 75)
                self.assertEqual(stderr.getvalue().strip(), expected)


class CwpFenceReaderFixture(FenceReaderFixture):
    def setUp(self):
        super().setUp()
        self.key = "cwp-" + "a" * 24
        self.epoch = "repair-00000000-1234-1234-1234-123456789012"
        self.evidence.update(
            ownerKey=self.key, epochId=self.epoch, currentHead="e" * 40
        )
        self.receipt["kind"] = "cwp-repair-retirement-proof"
        self.argv = [
            "fixture/repo",
            "5",
            "b" * 40,
            self.epoch,
            self.key,
            "e" * 40,
            "codex-conflict-pr-5-rebase-1234abcd",
            "163",
        ]
        temp = Path(self.enterContext(TemporaryDirectory())).resolve()
        self.hq_root = temp / "hq"
        self.hq_root.mkdir()
        alias = temp / "alias"
        alias.symlink_to(self.hq_root, target_is_directory=True)
        self.reader.hq_root_preferring_legacy_env.return_value = str(alias)
        self.epoch_key = f"cwp-epoch:{self.epoch}"
        self.rows = [
            (self.key, json.dumps(self.receipt)),
            (self.epoch_key, self.receipt),
        ]
        self.conn.execute.return_value.fetchall.return_value = self.rows
        self.owner = sys.modules["cwp_helm.pr_branch_owner"].lookup_pr_owner
        self.owner.return_value = {
            "ok": True,
            "repo": "fixture/repo",
            "prNumber": 5,
            "owner": None,
        }


class CwpFenceReaderTest(CwpFenceReaderFixture):
    def test_cwp_both_committed_rows_and_guarded_global_read(self):
        self.assertEqual(self.reader.main(self.argv), self.receipt)
        self.reader._check_scope.assert_called_once_with(
            self.conn, apply=False, cwp=True, readonly_connection=True
        )
        self.reader._require_absence.assert_called_once_with(self.conn, self.evidence)
        self.assertEqual(
            self.conn.execute.call_args.args[1], (self.key, self.epoch_key)
        )
        self.conn.rollback.assert_called_once_with()
        self.conn.close.assert_called_once_with()
        self.conn.commit.assert_not_called()
        self.owner.assert_called_once_with(self.hq_root, "fixture/repo", 5)
        _, args, _ = self.reader._evidence.call_args.args
        self.assertEqual(
            self.reader._evidence.call_args.kwargs, {"hq_root": self.hq_root}
        )
        self.assertEqual(args.current_head, "e" * 40)
        self.assertEqual(args.base_head, "b" * 40)
        self.assertEqual(args.conflict_worker_id, "codex-conflict-pr-5-rebase-1234abcd")
        self.assertEqual(args.boot_trace_offset, 163)
        self.assertFalse(hasattr(args, "handoff_round"))

    def test_cwp_incomplete_or_inconsistent_receipt_pair_is_insufficient(self):
        for rows, reason in (
            (self.rows[:1], "committed-enqueue-fence-required"),
            (self.rows[1:], "committed-enqueue-fence-required"),
            (
                [self.rows[0], (self.epoch_key, None)],
                "committed-enqueue-fence-required",
            ),
            (
                [self.rows[0], (self.epoch_key, {**self.receipt, "version": 2})],
                "inconsistent-canonical-fence",
            ),
        ):
            with self.subTest(rows=rows):
                self.conn.execute.return_value.fetchall.return_value = rows
                with self.assertRaisesRegex(FenceRefused, reason):
                    self.reader.main(self.argv)
        self.reader._require_absence.assert_not_called()
        self.reader._evidence.assert_not_called()

    def test_cwp_missing_schema_and_read_errors_fail_closed(self):
        for failing_call in (
            self.reader._check_scope,
            self.conn.execute,
            self.reader._require_absence,
        ):
            with self.subTest(failing_call=failing_call):
                failing_call.side_effect = OSError("disposable store unavailable")
                with self.assertRaises(OSError):
                    self.reader.main(self.argv)
                failing_call.side_effect = None
        self.assertEqual(self.conn.rollback.call_count, 3)
        self.assertEqual(self.conn.close.call_count, 3)
        self.reader._evidence.assert_not_called()

    def test_cwp_queued_or_unknown_branch_owner_retains_custody(self):
        free = self.owner.return_value
        for result, reason in (
            ({**free, "owner": {"status": "requested"}}, "pr-branch-owned"),
            ({**free, "ok": False}, "pr-branch-ownership-unproven"),
            ({**free, "repo": "other/repo"}, "pr-branch-ownership-unproven"),
        ):
            with self.subTest(result=result):
                self.owner.return_value = result
                with self.assertRaisesRegex(FenceRefused, reason):
                    self.reader.main(self.argv)
        self.reader._evidence.assert_not_called()


class CwpLedgerAbsenceReaderTest(CwpFenceReaderFixture):
    def setUp(self):
        super().setUp()
        self.absence_argv = [*self.argv[:-2], "ledger-absence"]
        self.observe_lock = sys.modules[
            "cwp_dispatch.enqueue_refusal"
        ].observe_unlocked_key
        self.evidence["submitter"] = {"kind": "canonical-cwp-ledger-absence"}
        self.rows[0] = (self.key, json.dumps(self.receipt))

    def test_absence_selector_excludes_original_provenance(self):
        args = self.reader._parse_args(self.absence_argv)
        self.assertTrue(args.ledger_absence)
        self.assertEqual(args.current_head, "e" * 40)
        self.assertFalse(hasattr(args, "conflict_worker_id"))
        self.assertFalse(hasattr(args, "boot_trace_offset"))
        for argv in (
            [*self.absence_argv, "163"],
            [*self.argv[:5], args.base_head, *self.argv[-2:]],
        ):
            with self.assertRaisesRegex(FenceRefused, "invalid-repair-fence-selector"):
                self.reader._parse_args(argv)

    def test_absence_checks_local_custody_while_key_is_locked(self):
        locked = False

        @contextmanager
        def guard():
            nonlocal locked
            locked = True
            try:
                yield True
            finally:
                locked = False

        def producer_evidence(root, args, operator, *, hq_root):
            self.assertTrue(locked)
            self.assertTrue(args.ledger_absence)
            self.assertEqual(hq_root, self.hq_root)
            return self.evidence

        free = self.owner.return_value

        def local_ownership(*args):
            self.assertTrue(locked)
            return free

        self.owner.side_effect = local_ownership
        self.observe_lock.side_effect = lambda *_: guard()
        self.reader._evidence.side_effect = producer_evidence
        self.assertEqual(self.reader.main(self.absence_argv), self.receipt)
        self.observe_lock.assert_called_once_with(self.hq_root, self.key)
        self.owner.assert_called_once_with(self.hq_root, "fixture/repo", 5)
        self.owner.side_effect = None
        for result, reason in (
            ({**free, "owner": {"status": "requested"}}, "pr-branch-owned"),
            ({**free, "ok": False}, "pr-branch-ownership-unproven"),
            ({**free, "repo": "other/repo"}, "pr-branch-ownership-unproven"),
            ({**free, "prNumber": 6}, "pr-branch-ownership-unproven"),
            (
                {key: value for key, value in free.items() if key != "owner"},
                "pr-branch-ownership-unproven",
            ),
        ):
            with self.subTest(result=result):
                self.owner.return_value = result
                self.reader._evidence.reset_mock()
                with self.assertRaisesRegex(FenceRefused, reason):
                    self.reader.main(self.absence_argv)
                self.reader._evidence.assert_not_called()
                self.assertFalse(locked)
        self.owner.side_effect = OSError("ownership unavailable")
        with self.assertRaises(OSError):
            self.reader.main(self.absence_argv)
        self.assertFalse(locked)

    def test_absence_busy_key_refuses_before_ledger_or_producer_reads(self):
        self.observe_lock.return_value = nullcontext(False)
        with self.assertRaisesRegex(FenceRefused, "conflict-submission-owned"):
            self.reader.main(self.absence_argv)
        self.reader.open_ledger_for_runtime_readonly.assert_not_called()
        self.reader._evidence.assert_not_called()
        self.owner.assert_not_called()

    def prepare_same_head(self):
        self.evidence.update(currentHead="b" * 40, ownerState="absent-unfenced")
        self.rows[0] = (self.key, json.dumps(self.receipt))
        self.observe_lock.return_value = nullcontext(True)
        return [*self.absence_argv[:-2], self.evidence["currentHead"], "ledger-absence"]

    def test_same_head_requires_compatible_producer_and_readonly_transaction(self):
        argv = self.prepare_same_head()
        with self.assertRaisesRegex(
            FenceRefused, "same-head-fence-producer-unsupported"
        ):
            self.reader.main(argv)
        self.reader.open_ledger_for_runtime_readonly.assert_not_called()
        producer = sys.modules["cwp_dispatch.cli_repair_enqueue_fence"]
        producer._same_head_retirement_status = Mock()
        self.assertEqual(self.reader.main(argv), self.receipt)
        producer._same_head_retirement_status.assert_not_called()
        self.reader._check_scope.assert_called_once_with(
            self.conn, apply=False, cwp=True, readonly_connection=True
        )

    def test_same_head_retains_custody_when_late_submitter_appears(self):
        argv = self.prepare_same_head()
        sys.modules[
            "cwp_dispatch.cli_repair_enqueue_fence"
        ]._same_head_retirement_status = Mock()
        for reason in (
            "canonical-launch-or-retry-present",
            "canonical-enqueue-guard-unavailable",
        ):
            with self.subTest(reason=reason):
                self.reader._require_absence.side_effect = FenceRefused(reason)
                with self.assertRaisesRegex(FenceRefused, reason):
                    self.reader.main(argv)
        self.conn.commit.assert_not_called()
        self.reader._evidence.assert_not_called()


if __name__ == "__main__":
    sys.dont_write_bytecode = True
    unittest.main()
