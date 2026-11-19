"""Select installed generated policy or continue an explicitly staged source repair."""

import argparse
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile


POLICY = Path("modules/worker-pool/lib/python/cwp_dispatch/generated_conflicts.py")


def load_policy(worktree, trusted_root=None):
    # The helper runs with Python isolation. Resolve only from the configured
    # root shared with reviewed-rebase verification, the configured deployment,
    # or this helper's installed superproject. An explicit root never falls back.
    configured = trusted_root or os.environ.get("AGENT_OS_DEPLOY_CHECKOUT")
    roots = [Path(configured)] if configured else Path(__file__).resolve().parents
    for root in roots:
        root = root.resolve(strict=True)
        if root.is_relative_to(worktree):
            continue
        module = root / POLICY
        if module.is_file() and module.resolve().is_relative_to(root):
            sys.path.insert(0, str(module.parent.parent))
            from cwp_dispatch import generated_conflicts as policy

            if Path(policy.__file__).resolve() != module.resolve():
                break
            if not policy.REGISTRY_PATH.resolve(strict=True).is_relative_to(root):
                break
            return root, policy
    raise ValueError("No trusted installed generated-conflict policy")


def source_pending(paths):
    print(
        "Merge both sides and stage the resolved source paths, then rerun with --continue: "
        + ", ".join(repr(path) for path in paths),
        file=sys.stderr,
    )
    return 22


def resume(repo, worktree, trusted_root=None):
    trusted_root, policy = load_policy(worktree.resolve(strict=True), trusted_root)

    def run(argv, *, env=None, **kwargs):
        if argv[0] != "git" or argv[-1] not in {"--continue", "--skip"}:
            return policy.run_process_group(argv, env=env, **kwargs)

        # The owner runner filters Git config overrides before invoking its
        # nested Git launcher. Carry the fixed setting at the selected binary
        # so nested commit keeps the author's headings and drops Git's footer.
        env = dict(os.environ if env is None else env)
        git = env.get("AGENT_OS_OWNER_GIT_BINARY") or shutil.which(
            "git", path=env.get("PATH")
        )
        if not git:
            raise ValueError("Git executable is unavailable")
        with tempfile.TemporaryDirectory(prefix="hammer-conflict-git-") as directory:
            launcher = Path(directory) / "git"
            launcher.write_text(
                f"#!/bin/sh\nexec {shlex.quote(git)} -c 'core.commentChar=;' \"$@\"\n"
            )
            launcher.chmod(0o700)
            env["AGENT_OS_OWNER_GIT_BINARY"] = str(launcher)
            return policy.run_process_group(argv, env=env, **kwargs)

    with policy.termination_cleanup():
        try:
            owning_checkout = policy._linked_tree(worktree)
            repository = policy._repository_identity(owning_checkout, run=run)
            if (
                not repository
                or not policy.github_slug(repo)
                or not (
                    repository.casefold() == repo.casefold()
                    or policy.same_repository(repository, repo)
                )
            ):
                raise ValueError(
                    "Conflict worktree repository identity is unknown or differs from the PR"
                )
            registry = policy.load_registry()
            if not registry:
                raise ValueError("Installed generated-file registry ownership is unknown")

            owned = policy._owned_entries(registry, repository)
            if owned:
                policy.resolve_rebase(
                    worktree,
                    repo_root=owning_checkout,
                    run=run,
                    trusted_root=trusted_root,
                    preserve_source_conflicts=True,
                    repository=repository,
                )
                return 0

            # A readable, positively foreign registry supplies no generators for
            # this PR. Use the shared marker-checked Git continuation on the
            # sources the closer already staged. A later conflict needs a handoff.
            paths = policy.conflict_paths(worktree, run=run)
            if paths:
                return source_pending(paths)
            result = policy._continue(worktree, run=run, env=None)
            if result.returncode == 0:
                return 0
            paths = policy.conflict_paths(worktree, run=run)
            if paths:
                return source_pending(paths)
            raise ValueError(
                (result.stderr or result.stdout or "Source rebase failed").strip()
            )
        except policy.GeneratedConflictError as exc:
            print(f"{exc.reason}: {exc}", file=sys.stderr)
            if exc.reason in {
                "unresolved_source_conflict",
                "resolved_diff_check_failed",
            }:
                return 22
            return 1
        except policy.CatalogError as exc:
            print(
                f"Repository identity unavailable: {exc}. Repair the alias catalog, "
                "then rerun with --continue.",
                file=sys.stderr,
            )
            return 22


if __name__ == "__main__":
    if sys.version_info < (3, 11):
        print("Conflict continuation refused: Python >= 3.11 is required", file=sys.stderr)
        sys.exit(1)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("repository")
    parser.add_argument("worktree", type=Path)
    parser.add_argument("--trusted-root", type=Path)
    args = parser.parse_args()
    try:
        sys.exit(resume(args.repository, args.worktree, args.trusted_root))
    except (
        OSError,
        ValueError,
        KeyError,
        TypeError,
        ImportError,
        AttributeError,
        RuntimeError,
        subprocess.SubprocessError,
    ) as exc:
        print(f"Conflict continuation refused: {exc}", file=sys.stderr)
        sys.exit(1)
