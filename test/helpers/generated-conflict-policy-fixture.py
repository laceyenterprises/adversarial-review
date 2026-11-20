"""Offline stand-in for the installed GENCONFLICT policy boundary.

Models the version-1 registry's entry dictionaries and catalog-error handoffs.
Intentionally omits full alias-catalog parsing, registry validation, generator
trust/inputs/evidence checks, owner process custody and complete marker scanning.
The opt-in installed-policy signature test in hamconflictsync-01.test.mjs checks
the cross-repository call surface; this fixture tests the caller's control flow.
"""

from contextlib import nullcontext
import json
import os
from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[5]
REGISTRY_PATH = ROOT / "modules/worker-pool/config/committed-generated-files.json"
termination_cleanup = nullcontext


class GeneratedConflictError(RuntimeError):
    def __init__(self, reason, message):
        super().__init__(message)
        self.reason = reason


class CatalogError(RuntimeError):
    pass


def run_process_group(argv, *, cwd, env=None, timeout=30):
    env = dict(os.environ if env is None else env)
    env.pop("GIT_CONFIG_COUNT", None)
    if argv[0] == "git" and (binary := env.get("AGENT_OS_OWNER_GIT_BINARY")):
        argv = [binary, *argv[1:]]
    return subprocess.run(
        argv, cwd=cwd, env=env, capture_output=True, text=True, timeout=timeout
    )


def git(worktree, *args):
    result = run_process_group(["git", *args], cwd=worktree)
    result.check_returncode()
    return result.stdout.strip()


def _linked_tree(worktree):
    assert (worktree / ".git").is_file()
    return Path(
        git(worktree, "rev-parse", "--path-format=absolute", "--git-common-dir")
    ).parent


def github_slug(value):
    parts = value.split("/")
    return value if len(parts) == 2 and all(parts) else None


def same_repository(left, right):
    if os.environ.get("FIXTURE_CATALOG_ERROR") == "comparison":
        raise CatalogError("Alias catalog is unreadable")
    return left.casefold() == right.casefold()


def _repository_identity(repo_root, *, run):
    url = run(
        ["git", "config", "--get", "remote.origin.url"], cwd=repo_root
    ).stdout.strip()
    if url.startswith("git@github.com:"):
        return github_slug(url.removeprefix("git@github.com:").removesuffix(".git"))
    return None


def load_registry():
    registry = json.loads(REGISTRY_PATH.read_text())
    if registry["version"] != 1:
        raise ValueError("Unsupported committed generated files registry")
    owner = registry["repository"]
    if not github_slug(owner):
        raise ValueError("Registry owner is unknown")
    return {
        entry["path"]: {**entry, "repository": owner} for entry in registry["files"]
    }


def _owned_entries(entries, repository):
    if os.environ.get("FIXTURE_CATALOG_ERROR") == "ownership":
        raise GeneratedConflictError(
            "unresolved_source_conflict",
            "Repository identity unavailable. Repair the alias catalog, then rerun.",
        )
    return {
        path: entry
        for path, entry in entries.items()
        if same_repository(entry["repository"], repository)
    }


def conflict_paths(worktree, *, run):
    return git(worktree, "diff", "--name-only", "--diff-filter=U").splitlines()


def _continue(worktree, *, run, env):
    assert not conflict_paths(worktree, run=run)
    if "<<<<<<< " in git(worktree, "diff", "--cached"):
        raise GeneratedConflictError(
            "resolved_diff_check_failed", "Conflict markers remain"
        )
    return run(["git", "-c", "core.editor=true", "rebase", "--continue"], cwd=worktree)


def resolve_rebase(
    worktree, *, repo_root, run, trusted_root, preserve_source_conflicts, repository
):
    assert repo_root == _linked_tree(worktree)
    assert trusted_root == ROOT
    assert preserve_source_conflicts
    paths = conflict_paths(worktree, run=run_process_group)
    assert paths == ["example.txt"]
    assert set(paths) <= _owned_entries(load_registry(), repository).keys()
    assert regenerate_conflicts(worktree, paths, trusted_root=trusted_root)
    git(worktree, "add", "--", *paths)
    _continue(worktree, run=run, env=None).check_returncode()


def regenerate_conflicts(
    worktree, paths, *, trusted_root, registry=None, repository=None
):
    assert paths == ["example.txt"]
    if registry is not None:
        assert registry == _owned_entries(load_registry(), repository)
    generator = worktree / "generate.py"
    assert generator.read_bytes() == (trusted_root / "generate.py").read_bytes()
    subprocess.run([sys.executable, "-IB", str(generator)], cwd=worktree, check=True)
    return True
