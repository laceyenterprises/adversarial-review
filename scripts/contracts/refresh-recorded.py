"""Extract LVR recordings from a reviewed SDK release; no producer execution.

Usage: python3 scripts/contracts/refresh-recorded.py <sdk.tgz> <release-revision>
"""

import hashlib
import json
from pathlib import Path
import re
import sys
import tarfile


def sha256(value):
    return hashlib.sha256(value).hexdigest()


def refresh(archive, revision, root):
    dest = root / "test/fixtures/producer-contracts"
    with tarfile.open(archive) as release:
        snapshot = release.extractfile("package/src/producer-contracts-v1.json").read()
        package = json.load(release.extractfile("package/package.json"))
    bundle = json.loads(snapshot)
    paths = {
        "github-token-refresh": "github-token-refresh.v1.txt",
        "fleet-quota-status": "fleet-quota-status.v1.json",
        "worker-class-show": "worker-class-show.v1.json",
        "launch-request-row": "launch-request-row.v1.json",
    }
    records = {}
    artifacts = {}
    for name, path in paths.items():
        producer = bundle["producers"][name]
        recording = producer["recording"]
        label = f"{name} contract {recording['contractVersion']}"
        examples = [
            entry["value"]
            for entry in producer["examples"]
            if entry.get("provenance") == "producer-recorded"
        ]
        if len(examples) != 1:
            raise ValueError(f"{label}: expected one producer-recorded example")
        value = examples[0]
        canonical = json.dumps(
            value, sort_keys=True, separators=(",", ":"), ensure_ascii=False
        ).encode("utf-8")
        if sha256(canonical) != recording["contentHash"]:
            raise ValueError(f"{label}: content hash mismatch")
        # JSON bytes retain Python's numeric spelling (1.0 versus 1). Token text
        # is verbatim; its contentHash covers the JSON string, not raw shell bytes.
        artifacts[path] = value.encode() if isinstance(value, str) else canonical
        records[name] = {
            **recording,
            "file": path,
            "sha256": sha256(artifacts[path]),
            "producerCommand": producer["producerCommand"],
        }
    manifest = (
        json.loads((dest / "provenance.json").read_text())
        if (dest / "provenance.json").exists()
        else {}
    )
    manifest["producerHashes"] = {
        name: record["contentHash"] for name, record in records.items()
    }
    manifest["recorded"] = {
        "sdk": {
            "file": str(archive.relative_to(root)),
            "version": package["version"],
            "sha256": sha256(archive.read_bytes()),
            "snapshotSha256": sha256(snapshot),
            "releaseRevision": revision,
            "contractVersion": bundle["contractVersion"],
        },
        "producers": records,
        "refresh": "python3 scripts/contracts/refresh-recorded.py <vendored-sdk.tgz> <release-revision>",
    }
    # Validate the entire input before changing any consumer artifacts.
    dest.mkdir(parents=True, exist_ok=True)
    for path, content in artifacts.items():
        (dest / path).write_bytes(content)
    (dest / "provenance.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n"
    )


if __name__ == "__main__":
    if len(sys.argv) != 3 or not re.fullmatch(r"[a-f0-9]{40}", sys.argv[2]):
        sys.exit(
            "usage: python3 scripts/contracts/refresh-recorded.py <sdk.tgz> <release-revision>"
        )
    root = Path(__file__).resolve().parents[2]
    refresh(Path(sys.argv[1]).resolve(), sys.argv[2], root)
