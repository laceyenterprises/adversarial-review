"""Internal read-only evidence adapter for retire-legacy-repair.mjs."""

import json
from contextlib import nullcontext
from importlib import import_module
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


def _decode_receipt(raw):
    return raw if isinstance(raw, dict) else json.loads(raw)


def _read_cwp_receipt(conn, owner_key, epoch_id):
    epoch_key = f"cwp-epoch:{epoch_id}"
    rows = conn.execute(
        "SELECT owner_key, receipt_json FROM public.repair_enqueue_fences "
        "WHERE owner_key IN (?, ?)",
        (owner_key, epoch_key),
    ).fetchall()
    receipts = {row[0]: row[1] for row in rows if row[1]}
    if receipts.keys() != {owner_key, epoch_key}:
        raise RepairFenceRefused("committed-enqueue-fence-required")
    receipt = _decode_receipt(receipts[owner_key])
    epoch_receipt = _decode_receipt(receipts[epoch_key])
    if json.dumps(receipt, sort_keys=True) != json.dumps(epoch_receipt, sort_keys=True):
        raise RepairFenceRefused("inconsistent-canonical-fence")
    if receipt["evidence"]["epochId"] != epoch_id:
        raise RepairFenceRefused("persisted-fence-identity-mismatch")
    return receipt


def read_committed_proof(conn, owner_key, *, cwp_epoch_id=None):
    if getattr(conn, "backend", None) != BACKEND_POSTGRES:
        raise RepairFenceRefused("canonical-postgres-ledger-required")
    try:
        # The runtime reader already opens a read-only transaction and uses
        # savepoints. Verify that transaction rather than setting its mode.
        if cwp_epoch_id is not None:
            _check_scope(conn, apply=False, cwp=True, readonly_connection=True)
            receipt = _read_cwp_receipt(conn, owner_key, cwp_epoch_id)
        else:
            _check_scope(conn, apply=False, readonly_connection=True)
            row = conn.execute(
                "SELECT receipt_json FROM public.repair_enqueue_fences WHERE owner_key = ?",
                (owner_key,),
            ).fetchone()
            if not row or not row[0]:
                raise RepairFenceRefused("committed-enqueue-fence-required")
            receipt = _decode_receipt(row[0])
        evidence = receipt["evidence"]
        if evidence["ownerKey"] != owner_key:
            raise RepairFenceRefused("persisted-fence-identity-mismatch")
        _require_absence(conn, evidence)
        return receipt
    finally:
        conn.rollback()


def _parse_args(argv):
    repo, pr, base_head, epoch, owner_key, *provenance = argv
    args = SimpleNamespace(
        repo=repo,
        pr=int(pr),
        base_head=base_head,
        epoch=epoch,
        owner_key=owner_key,
    )
    if len(provenance) == 1 and re.fullmatch(
        r"in-place-repair-[0-9a-f]{64}", owner_key
    ):
        args.handoff_round = int(provenance[0])
        return args
    ledger_absence = len(provenance) == 2 and provenance[1] == "ledger-absence"
    if not ledger_absence and len(provenance) != 3:
        raise RepairFenceRefused("invalid-repair-fence-selector")
    from cwp_dispatch.cli_repair_enqueue_fence import REPO
    from session_ledger.repair_enqueue_fence import (
        CWP_OWNER_KEY,
        HEAD_SHA,
        REPAIR_EPOCH_ID,
    )

    current_head = provenance[0]
    if (
        not CWP_OWNER_KEY.fullmatch(owner_key)
        or not REPAIR_EPOCH_ID.fullmatch(epoch)
        or not REPO.fullmatch(repo)
        or not 0 < args.pr <= 2**31 - 1
        or not HEAD_SHA.fullmatch(base_head)
        or not HEAD_SHA.fullmatch(current_head)
        or (current_head == base_head and not ledger_absence)
    ):
        raise RepairFenceRefused("invalid-repair-fence-selector")
    args.current_head = current_head
    if ledger_absence:
        args.ledger_absence = True
        return args
    _, conflict_worker_id, offset = provenance
    if (
        not re.fullmatch(
            rf"codex-conflict-pr-{args.pr}-rebase-[0-9a-f]{{8}}", conflict_worker_id
        )
        or not re.fullmatch(r"(?:0|[1-9][0-9]{0,15})", offset)
        or int(offset) > 2**53 - 1
    ):
        raise RepairFenceRefused("invalid-repair-fence-selector")
    args.conflict_worker_id = conflict_worker_id
    args.boot_trace_offset = int(offset)
    return args


def main(argv):
    args = _parse_args(argv)
    cwp = hasattr(args, "current_head")
    hq_root = Path(hq_root_preferring_legacy_env())
    if cwp:
        hq_root = hq_root.resolve(strict=True)
    _require_operator_continuation(hq_root)
    _require_hq_root_owner(hq_root)
    if cwp and args.current_head == args.base_head:
        producer = import_module("cwp_dispatch.cli_repair_enqueue_fence")
        # LAC-2427 adds this hook at inspection and inside canonical apply.
        if not callable(getattr(producer, "_same_head_retirement_status", None)):
            raise RepairFenceRefused("same-head-fence-producer-unsupported")
    root = _adversarial_review_root()
    if root.resolve() != Path(__file__).resolve().parents[1]:
        raise RepairFenceRefused("native-repair-checkout-required")
    target = resolve_ledger_target(hq_root=hq_root)
    if target.backend != BACKEND_POSTGRES or not target.dsn:
        raise RepairFenceRefused("canonical-postgres-ledger-required")
    guard = nullcontext(True)
    if getattr(args, "ledger_absence", False):
        from cwp_dispatch.enqueue_refusal import observe_unlocked_key

        guard = observe_unlocked_key(hq_root, args.owner_key)
    with guard as unlocked:
        if not unlocked:
            raise RepairFenceRefused("conflict-submission-owned")
        return _read_current_proof(root, args, hq_root, target, cwp)


def _read_current_proof(root, args, hq_root, target, cwp):
    conn = open_ledger_for_runtime_readonly(dsn=target.dsn, timeout=5, fixed=True)
    try:
        receipt = read_committed_proof(
            conn, args.owner_key, cwp_epoch_id=args.epoch if cwp else None
        )
    finally:
        conn.close()
    if cwp:
        from cwp_helm.pr_branch_owner import lookup_pr_owner

        # Independent HQ branch custody is PR-wide, including queued work.
        ownership = lookup_pr_owner(hq_root, args.repo, args.pr)
        if (
            ownership.get("ok") is not True
            or ownership.get("repo") != args.repo
            or ownership.get("prNumber") != args.pr
            or "owner" not in ownership
        ):
            raise RepairFenceRefused("pr-branch-ownership-unproven")
        if ownership["owner"] is not None:
            raise RepairFenceRefused("pr-branch-owned")
    # The producer rechecks the open same-repo PR head, current reservation
    # and the selected submitter evidence.
    keywords = {"hq_root": hq_root} if cwp else {}
    if receipt["evidence"] != _evidence(root, args, _hq_owner(hq_root), **keywords):
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
