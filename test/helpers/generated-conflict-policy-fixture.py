"""Offline stand-in for the installed GENCONFLICT policy boundary."""

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
    owner = registry["repository"]
    if not github_slug(owner):
        raise ValueError("Registry owner is unknown")
    return {path: owner for path in registry["paths"]}


def _owned_entries(entries, repository):
    return {
        path: owner
        for path, owner in entries.items()
        if same_repository(owner, repository)
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
    generator = worktree / "generate.py"
    assert generator.read_bytes() == (trusted_root / "generate.py").read_bytes()
    subprocess.run([sys.executable, "-IB", str(generator)], cwd=worktree, check=True)
    git(worktree, "add", "--", *paths)
    _continue(worktree, run=run, env=None).check_returncode()
