"""Exercise the read-only bridge without an Agent OS checkout or network."""

import importlib.util
import json
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import Mock, patch


class FenceRefused(ValueError):
    pass


def load_reader():
    dependencies = {
        "agent_os_config.roots": {"hq_root_preferring_legacy_env": Mock()},
        "cwp_dispatch.cli_repair_enqueue_fence": {
            "RepairFenceRefused": FenceRefused,
            "_adversarial_review_root": Mock(),
            "_evidence": Mock(),
            "_hq_owner": Mock(),
            "_require_hq_root_owner": Mock(),
            "_require_operator_continuation": Mock(),
        },
        "session_ledger.db_path": {
            "BACKEND_POSTGRES": "postgres",
            "resolve_ledger_target": Mock(),
        },
        "session_ledger.db_runtime": {"open_ledger_for_runtime_readonly": Mock()},
        "session_ledger.repair_enqueue_fence": {
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
    with patch.dict(sys.modules, modules):
        spec.loader.exec_module(reader)
    return reader


class CanonicalFenceReaderTest(unittest.TestCase):
    def setUp(self):
        self.reader = load_reader()
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

    def test_existing_fence_requires_guarded_global_read_and_fresh_evidence(self):
        self.assertEqual(self.reader.main(self.argv), self.receipt)
        self.reader._require_operator_continuation.assert_called_once_with(
            Path("/fixture")
        )
        self.reader._require_hq_root_owner.assert_called_once_with(Path("/fixture"))
        self.reader._check_scope.assert_called_once_with(self.conn, apply=False)
        self.reader._require_absence.assert_called_once_with(self.conn, self.evidence)
        self.conn.execute.assert_called_once_with(
            "SELECT receipt_json FROM public.repair_enqueue_fences WHERE owner_key = ?",
            (self.key,),
        )
        self.conn.rollback.assert_called_once_with()
        self.conn.close.assert_called_once_with()
        self.conn.commit.assert_not_called()

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


if __name__ == "__main__":
    sys.dont_write_bytecode = True
    unittest.main()
