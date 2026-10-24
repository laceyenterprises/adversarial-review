"""Refresh inert producer definitions/captures; never invokes live commands.

Usage from this repo: python3 scripts/contracts/refresh.py ../agent-os
Recapture at the producer first using the copied owner records.
"""

import ast
import hashlib
import json
from pathlib import Path
import runpy
import shutil
import subprocess
import sys

if len(sys.argv) != 2:
    print(
        "Usage: python3 scripts/contracts/refresh.py <path-to-agent-os>",
        file=sys.stderr,
    )
    sys.exit(2)

source = Path(sys.argv[1]).resolve()
root = Path(__file__).resolve().parents[2]
dest = root / "test/fixtures/producer-contracts"
wp = "modules/worker-pool/"
fixtures = wp + "lib/python/cwp_dispatch/test/fixtures/"
files = {
    "quota": wp + "lib/python/tests/fixtures/quota_reserve",
    "broker": "platform/oauth-broker/tests/fixtures/contracts",
    "launch": "platform/session-ledger/tests/fixtures/launch-request-status",
    "dispatch": fixtures + "dispatch-receipts",
    "publication": fixtures + "publication-receipts",
}
records = {}
# Keep the separately refreshed public SDK recordings and their stale-report pins.
previous = (
    json.loads((dest / "provenance.json").read_text())
    if (dest / "provenance.json").exists()
    else {}
)
recorded = {
    key: previous[key] for key in ("producerHashes", "recorded") if key in previous
}
for name, path in files.items():
    target = dest / name
    target.mkdir(parents=True, exist_ok=True)
    # The released capture has its own provenance and generator. Everything
    # else in these directories is managed by this refresh, including removals.
    for old in target.iterdir():
        if name == "quota" and old.name == "fleet-released.json":
            continue
        if old.is_file() and (old.suffix == ".json" or old.name == "README.md"):
            old.unlink()
    for item in sorted((source / path).iterdir()):
        if name == "publication" and item.name not in {
            "accepted.json",
            "capture-failed.json",
            "missing-url.json",
            "refused.json",
            "same-head-adopted.json",
            "wrong-head-refused.json",
            "README.md",
        }:
            continue
        if item.name == "reserveFloors-capture-2026-10-20.json":
            continue
        if item.suffix != ".json" and item.name != "README.md":
            continue
        shutil.copyfile(item, target / item.name)
        records[f"{name}/{item.name}"] = {
            "source": str(item.relative_to(source)),
            "sha256": hashlib.sha256(item.read_bytes()).hexdigest(),
        }
definitions = [
    wp + "lib/python/cwp_dispatch/quota_reserve.py",
    wp + "lib/python/cwp_dispatch/codex_quota_snapshots.py",
    wp + "lib/python/cwp_dispatch/cli_fleet.py",
    "platform/oauth-broker/src/oauth_broker/status_contract.py",
    "platform/agent-os-config/src/agent_os_core/broker_evidence.py",
    "platform/session-ledger/src/session_ledger/launch_request_terminal_statuses.py",
    wp + "lib/python/cwp_dispatch/ticket.py",
    wp + "lib/python/cwp_dispatch/dispatch_refusals.py",
    wp + "lib/python/cwp_dispatch/publication_receipts.py",
    "modules/github-adapter/src/agent_os_github_adapter/envelope.py",
    wp + "docs/quota-producer-contract.md",
    wp + "docs/pr-publication-contract.md",
]
(dest / "definitions").mkdir(exist_ok=True)
for old in (dest / "definitions").glob("*.txt"):
    old.unlink()
for path in definitions:
    item = source / path
    name = "definitions/" + item.name + ".txt"
    content = item.read_text()
    if item.suffix == ".py":
        tree = ast.parse(content)
        selected = {
            "quota_reserve.py": {"ReserveFloor", "weekly_evidence"},
            "codex_quota_snapshots.py": {"QuotaMeasurement"},
            "cli_fleet.py": {"FleetQuotaPayload"},
            "status_contract.py": {"ProviderState", "ReadyzPayload"},
            "broker_evidence.py": {"ProviderEvidence", "provider_evidence"},
            "ticket.py": {
                "DispatchReceipt",
                "DispatchReceiptRead",
                "read_dispatch_receipt",
            },
            "dispatch_refusals.py": {"DispatchRefusalError"},
            "publication_receipts.py": {
                "PrOpenRecord",
                "PrOpenCompletionReceipt",
                "PublicationReceiptRead",
                "read_pr_open_record",
            },
            "envelope.py": {
                "ResultEnvelope",
                "PrCreateReceiptRead",
                "read_pr_create_receipt",
            },
        }.get(item.name)
        if selected:
            content = (
                "\n\n".join(
                    ast.get_source_segment(content, node)
                    for node in tree.body
                    if isinstance(node, (ast.ClassDef, ast.FunctionDef))
                    and node.name in selected
                )
                + "\n"
            )
    (dest / name).write_text(content)
    records[name] = {
        "source": path,
        "sourceSha256": hashlib.sha256(item.read_bytes()).hexdigest(),
        "sha256": hashlib.sha256((dest / name).read_bytes()).hexdigest(),
    }
status = runpy.run_path(
    str(
        source
        / "platform/session-ledger/src/session_ledger/launch_request_terminal_statuses.py"
    )
)
artifact = {
    "statuses": sorted(status["LAUNCH_REQUEST_STATUSES"]),
    "terminal": sorted(status["TERMINAL_LAUNCH_REQUEST_STATUSES"]),
}
(root / "src/producer-contracts/launch-request-statuses.json").write_text(
    json.dumps(artifact, indent=2) + "\n"
)
revision = subprocess.check_output(
    ["git", "-C", str(source), "rev-parse", "HEAD"], text=True
).strip()
(dest / "provenance.json").write_text(
    json.dumps(
        {
            **recorded,
            "repository": "agent-os",
            "revision": revision,
            "refresh": "python3 scripts/contracts/refresh.py ../agent-os",
            "files": records,
        },
        indent=2,
        sort_keys=True,
    )
    + "\n"
)
