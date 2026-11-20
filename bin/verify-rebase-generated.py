"""REBASEPROV-01: verify registered outputs in an isolated archived commit.

Use the installed GENCONFLICT registry and trusted generator code. Never run a
branch-supplied registry, change the working checkout, or write deploy state.
Missing installation/policy/generator evidence refuses the generated exception.
"""

import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile


def git(*args, cwd=None):
    return subprocess.check_output(["git", *args], cwd=cwd, timeout=30)


def main():
    # Use the owner deployment or this helper's installed superproject.
    # An explicit root never falls back.
    args = sys.argv[1:]
    configured = os.environ.get("AGENT_OS_DEPLOY_CHECKOUT") or None
    if args[:1] == ["--trusted-root"]:
        configured = args[1]
        args = args[2:]
    worktree = Path(
        os.fsdecode(git("rev-parse", "--show-toplevel").rstrip(b"\n"))
    ).resolve(strict=True)
    if configured is not None and not Path(configured).is_absolute():
        raise ValueError("The installed generated-file policy root must be absolute")
    if configured is not None:
        trusted_root = Path(configured).resolve(strict=True)
    else:
        # Discover an ancestor installation instead of assuming a fixed depth.
        trusted_root = next(
            (
                root
                for root in Path(__file__).resolve().parents
                if not root.is_relative_to(worktree)
                and (
                    root
                    / "modules/worker-pool/lib/python/cwp_dispatch/generated_conflicts.py"
                ).is_file()
            ),
            None,
        )
        if trusted_root is None:
            raise ValueError(
                "No installed generated-file policy; supply --trusted-root"
            )
    if trusted_root.is_relative_to(worktree):
        raise ValueError("The generated-file policy root is inside the worker checkout")
    library = trusted_root / "modules/worker-pool/lib/python"
    module = library / "cwp_dispatch/generated_conflicts.py"
    if not module.is_file() or not module.resolve().is_relative_to(trusted_root):
        raise ValueError("No installed generated-file policy")
    sys.path.insert(0, str(library))
    from cwp_dispatch import generated_conflicts as policy

    if not Path(policy.__file__).resolve().is_relative_to(trusted_root):
        raise ValueError("Generated policy is not installed with this helper")
    if not policy.REGISTRY_PATH.resolve(strict=True).is_relative_to(trusted_root):
        raise ValueError("Generated registry is outside the installed policy root")
    repo, action, *rest = args
    origin = (
        git("config", "--get", "remote.origin.url", cwd=trusted_root).decode().strip()
    )
    canonical = origin.removesuffix(".git").replace(":", "/").split("/")[-2:]
    if "/".join(canonical).lower() != repo.lower():
        raise ValueError("Generated registry belongs to another repository")
    entries = policy._owned_entries(policy.load_registry(), repo)
    if action == "policy":
        print(json.dumps(list(entries)))
        return
    sha, *paths = rest
    if action != "verify" or not paths or set(paths) - entries.keys():
        raise ValueError("Unknown generated verification request")
    tree = git("ls-tree", "-rz", "--full-tree", sha).split(b"\0")
    files = []
    for entry in filter(None, tree):
        metadata, path = entry.split(b"\t", 1)
        mode, kind, oid = metadata.split()
        if kind == b"commit":  # Submodule contents cannot supply output evidence.
            continue
        if mode not in (b"100644", b"100755"):
            raise ValueError("Generated verification requires a regular-file tree")
        files.append((path.decode(), mode, oid))
    # Read raw blobs: archive export-ignore/export-subst and checkout filters
    # must never change the merged sources that we verify.
    blobs = subprocess.check_output(
        ["git", "cat-file", "--batch"],
        input=b"".join(oid + b"\n" for _, _, oid in files),
        timeout=30,
    )
    with tempfile.TemporaryDirectory(prefix="rebase-generated-") as directory:
        root = Path(directory).resolve()
        stream = io.BytesIO(blobs)
        source_digests = {}
        for path, mode, oid in files:
            object_id, kind, size = stream.readline().split()
            if object_id != oid or kind != b"blob":
                raise ValueError("Unreadable source object")
            content = stream.read(int(size))
            if len(content) != int(size) or stream.read(1) != b"\n":
                raise ValueError("Truncated source object")
            target = root / path
            if not target.resolve().is_relative_to(root) or ".git" in target.parts:
                raise ValueError("Unsafe source path")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
            target.chmod(0o755 if mode == b"100755" else 0o644)
            if path not in paths:
                source_digests[path] = hashlib.sha256(content).digest()
        expected = {}
        for path in paths:
            target = root / path
            if target.is_symlink() or not target.is_file():
                raise ValueError("Generated output must be a regular file")
            expected[path] = target.read_bytes()
        git("init", "-q", cwd=root)
        # execFile's timeout must also terminate any generator process group.
        with policy.termination_cleanup():
            if not policy.regenerate_conflicts(
                root,
                paths,
                registry=entries,
                repository=repo,
                trusted_root=trusted_root,
            ):
                raise ValueError("Unregistered output")
        for path, digest in source_digests.items():
            source = root / path
            if (
                source.is_symlink()
                or not source.is_file()
                or hashlib.sha256(source.read_bytes()).digest() != digest
            ):
                raise ValueError("Generator changed merged sources")
        for path, content in expected.items():
            if (root / path).read_bytes() != content:
                raise ValueError("Generated output differs from merged sources")
    print("verified")


if __name__ == "__main__":
    main()
