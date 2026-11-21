"""Optional offline deployment check against the installed Agent OS producer.

Run with hq_exec_python3_runtime; normal AR tests need no Agent OS checkout.
Only external I/O and operator identity are mocked, never the digest builder.
"""

from contextlib import ExitStack
import importlib.util
from inspect import signature
import json
import os
import subprocess
from tempfile import TemporaryDirectory
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
        path = Path(__file__).resolve().parents[2] / "bin/read-legacy-repair-fence.py"
        spec = importlib.util.spec_from_file_location(
            "real_postgres_fence_reader", path
        )
        reader = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(reader)
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
            committed = recover(conn, evidence, apply=True, revalidate=lambda: evidence)
            readonly = open_ledger_for_runtime_readonly(dsn=dsn, timeout=5, fixed=True)
            try:
                self.assertEqual(
                    reader.read_committed_proof(readonly, evidence["ownerKey"]),
                    committed,
                )
            finally:
                readonly.close()
        finally:
            conn.close()


if __name__ == "__main__":
    unittest.main()
