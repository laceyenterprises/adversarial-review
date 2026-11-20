"""Offline mirror boundary fixture.

Check/CheckResult and runner signatures follow agent-os 82f7c7fd23b48ef8275d9d1ed39df945f54c4127,
scripts/ci-mirror/run-ci-mirror.py. Execution and context discovery are synthetic;
this fixture needs neither that checkout nor its Python dependencies.
"""

import json
import os
import sys
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Iterable

if os.environ.get("FIXTURE_IMPORT_EXIT"):
    raise SystemExit(int(os.environ["FIXTURE_IMPORT_EXIT"]))


@dataclass(frozen=True)
class Check:
    name: str
    command: str
    tier: str
    globs: tuple[str, ...]
    fix: str | None = None
    required_tools: tuple[str, ...] = ()
    matched_files: tuple[str, ...] = ()
    cwd: str | None = None
    fail_open_exit_codes: tuple[int, ...] = ()
    local_advisory_arg: str | None = None
    advisory: bool = False
    skip_reason: str = ""
    worker_seconds: float | None = None
    worker_batch_files: int = 1


@dataclass
class CheckResult:
    check: Check
    status: str
    elapsed: float
    output: str = ""
    reason: str = ""
    scoped_files: tuple[str, ...] = ()
    python_executable: str = ""
    python_version: str = ""


def load_manifest(path: Path, *, cwd: str | None = None) -> list[Check]:
    manifest = json.loads(path.read_text())
    if "checks" in manifest:
        contributions = [
            (pattern, {"name": check_id, **row})
            for check_id, row in manifest["checks"].items()
            if "pre-push" in row["runs"]
            for pattern in row.get("paths", row.get("suite", {}).get("paths", []))
        ]
    else:
        contributions = [
            (pattern, row)
            for pattern, entries in manifest["path-glob"].items()
            for row in entries
        ]
    return [
        Check(row["name"], row["command"], row.get("tier", "fast"), (pattern,), cwd=cwd)
        for pattern, row in contributions
    ]


def selected_checks(checks: list[Check], files: list[str]) -> list[Check]:
    selected = {}
    for check in checks:
        key = (check.name, check.command, check.cwd)
        previous = selected.get(key)
        selected[key] = replace(
            check,
            globs=tuple(sorted(set(check.globs + (previous.globs if previous else ())))),
            matched_files=tuple(files),
        )
    return list(selected.values())


def run_check(
    check: Check,
    repo_root: Path,
    files: list[str],
    local_openclaw_boundary_advisory: bool = False,
    *,
    check_env: dict[str, str] | None = None,
) -> CheckResult:
    assert repo_root == Path.cwd() and check_env == {"fixture": "environment"}
    assert not local_openclaw_boundary_advisory
    if check.skip_reason:
        return CheckResult(check, "skipped", 0.0,
                           reason=os.environ.get("FIXTURE_SKIP_REASON", check.skip_reason))
    assert check.tier == "fast" and check.matched_files == tuple(files)
    with open(os.environ["FIXTURE_LOCAL_CHECKS"], "a") as log:
        print(check.command, file=log)
    if check.name == os.environ.get("FIXTURE_LOCAL_FAILURE"):
        return CheckResult(check, "inconclusive", 0.0, reason="synthetic timeout")
    return CheckResult(check, "pass", 0.0)


def run_checks(
    checks: Iterable[Check],
    repo_root: Path,
    files: list[str],
    local_openclaw_boundary_advisory: bool = False,
) -> list[CheckResult]:
    return [
        run_check(check, repo_root, files, local_openclaw_boundary_advisory,
                  check_env={"fixture": "environment"})
        for check in checks
    ]


def main(argv: list[str]) -> int:
    assert argv == ["--", "src/example.mjs"]
    files = argv[1:]
    checks = selected_checks(load_manifest(Path("scripts/ci-mirror/checks.json"), cwd=None), files)
    if os.environ.get("FIXTURE_SUBCONTEXT"):
        checks += selected_checks(load_manifest(
            Path("scripts/ci-mirror/checks.adversarial-review.json"),
            cwd="tools/adversarial-review",
        ), files)
    results = run_checks(checks, Path.cwd(), files)
    return 75 if any(r.status == "inconclusive" for r in results) else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
