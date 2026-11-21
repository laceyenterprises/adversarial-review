"""Internal read-only evidence adapter for retire-legacy-repair.mjs."""

import json
from pathlib import Path
import re
import sys
from types import SimpleNamespace

from agent_os_config.roots import hq_root_preferring_legacy_env
from cwp_dispatch.cli_repair_enqueue_fence import (
    RepairFenceRefused,
    _adversarial_review_root,
    _evidence,
    _hq_owner,
    _require_hq_root_owner,
    _require_operator_continuation,
)
from session_ledger.db_path import BACKEND_POSTGRES, resolve_ledger_target
from session_ledger.db_runtime import open_ledger_for_runtime_readonly
from session_ledger.repair_enqueue_fence import _check_scope, _require_absence


def read_committed_proof(conn, owner_key):
    if getattr(conn, "backend", None) != BACKEND_POSTGRES:
        raise RepairFenceRefused("canonical-postgres-ledger-required")
    try:
        _check_scope(conn, apply=False)
        row = conn.execute(
            "SELECT receipt_json FROM public.repair_enqueue_fences WHERE owner_key = ?",
            (owner_key,),
        ).fetchone()
        if not row or not row[0]:
            raise RepairFenceRefused("committed-enqueue-fence-required")
        receipt = row[0] if isinstance(row[0], dict) else json.loads(row[0])
        evidence = receipt["evidence"]
        if evidence["ownerKey"] != owner_key:
            raise RepairFenceRefused("persisted-fence-identity-mismatch")
        _require_absence(conn, evidence)
        return receipt
    finally:
        conn.rollback()


def main(argv):
    repo, pr, base_head, epoch, owner_key, handoff_round = argv
    args = SimpleNamespace(
        repo=repo,
        pr=int(pr),
        base_head=base_head,
        epoch=epoch,
        owner_key=owner_key,
        handoff_round=int(handoff_round),
    )
    hq_root = Path(hq_root_preferring_legacy_env())
    _require_operator_continuation(hq_root)
    _require_hq_root_owner(hq_root)
    root = _adversarial_review_root()
    if root.resolve() != Path(__file__).resolve().parents[1]:
        raise RepairFenceRefused("native-repair-checkout-required")
    target = resolve_ledger_target(hq_root=hq_root)
    if target.backend != BACKEND_POSTGRES or not target.dsn:
        raise RepairFenceRefused("canonical-postgres-ledger-required")
    conn = open_ledger_for_runtime_readonly(dsn=target.dsn, timeout=5, fixed=True)
    try:
        receipt = read_committed_proof(conn, owner_key)
    finally:
        conn.close()
    # The producer's own evidence builder rechecks GitHub's open, same-repo
    # head, the current reservation and the original on-disk handoff recipe.
    if receipt["evidence"] != _evidence(root, args, _hq_owner(hq_root)):
        raise RepairFenceRefused("persisted-fence-identity-mismatch")
    return receipt


def run(argv):
    try:
        print(json.dumps(main(argv)))
        return 0
    except RepairFenceRefused as exc:
        # Some producer refusals append a private handoff path after a colon.
        reason = str(exc).partition(": ")[0]
        if re.fullmatch(r"[a-z][a-z0-9-]{0,119}", reason):
            print(f"repair-fence-refused:{reason}", file=sys.stderr)
        else:
            print(
                "canonical-committed-repair-fence-or-current-evidence-unavailable",
                file=sys.stderr,
            )
        return 75
    except Exception:
        # Reader exceptions can contain connection details or handoff paths.
        print(
            "canonical-committed-repair-fence-or-current-evidence-unavailable",
            file=sys.stderr,
        )
        return 75


if __name__ == "__main__":
    sys.exit(run(sys.argv[1:]))
