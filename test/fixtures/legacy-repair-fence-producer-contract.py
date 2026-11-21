"""Optional offline deployment check against the installed Agent OS producer.

Run with hq_exec_python3_runtime; normal AR tests need no Agent OS checkout.
Only external I/O and operator identity are mocked, never the digest builder.
"""

from contextlib import ExitStack
import importlib.util
from inspect import signature
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from cwp_dispatch import cli_repair_enqueue_fence as producer


class ProducerContractTest(unittest.TestCase):
    def test_actual_imports_signatures_and_observation_stable_evidence(self):
        path = Path(__file__).resolve().parents[2] / "bin/read-legacy-repair-fence.py"
        spec = importlib.util.spec_from_file_location("installed_fence_reader", path)
        reader = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(reader)
        root = path.parents[1]
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


if __name__ == "__main__":
    unittest.main()
