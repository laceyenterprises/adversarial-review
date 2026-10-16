"""REBASEPROV-01: verify registered outputs in an isolated archived commit.

Use the installed GENCONFLICT registry and trusted generator code. Never run a
branch-supplied registry, change the working checkout, or write deploy state.
Missing installation/policy/generator evidence refuses the generated exception.
"""

import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile


def git(*args, cwd=None):
    return subprocess.check_output(["git", *args], cwd=cwd, timeout=30)


def main():
    from cwp_dispatch import generated_conflicts as policy

    repo, action, *rest = sys.argv[1:]
    trusted_root = policy.REGISTRY_PATH.parents[3]
    origin = (
        git("config", "--get", "remote.origin.url", cwd=trusted_root).decode().strip()
    )
    canonical = origin.removesuffix(".git").replace(":", "/").split("/")[-2:]
    if "/".join(canonical) != repo:
        raise ValueError("Generated registry belongs to another repository")
    entries = policy.load_registry()
    if action == "policy":
        print(json.dumps(list(entries)))
        return
    sha, *paths = rest
    if action != "verify" or not paths or set(paths) - entries.keys():
        raise ValueError("Unknown generated verification request")
    archive = git("archive", "--format=tar", sha)
    with tempfile.TemporaryDirectory(prefix="rebase-generated-") as directory:
        root = Path(directory)
        with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
            tar.extractall(root, filter="data")
        expected = {}
        for path in paths:
            target = root / path
            if target.is_symlink() or not target.is_file():
                raise ValueError("Generated output must be a regular file")
            expected[path] = target.read_bytes()
        git("init", "-q", cwd=root)
        if not policy.regenerate_conflicts(root, paths, trusted_root=trusted_root):
            raise ValueError("Unregistered output")
        for path, content in expected.items():
            if (root / path).read_bytes() != content:
                raise ValueError("Generated output differs from merged sources")
    print("verified")


if __name__ == "__main__":
    main()
