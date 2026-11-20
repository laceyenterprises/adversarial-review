"""Offline mirror with the witness runner's buffered results and timed sessions."""

import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Check:
    name: str
    command: str
    cwd: str | None = None
    skip_reason: str | None = None


@dataclass
class CheckResult:
    status: str
    output: str
    reason: str = ""


def load_manifest(path):
    return [
        Check("first failure", "exec python3 check.py fail"),
        Check("budget check", "exec python3 check.py wait"),
    ]


def run_shell_command(command, *, cwd, env, timeout):
    with subprocess.Popen(
        command,
        cwd=cwd,
        env=env,
        shell=True,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        start_new_session=timeout is not None,
    ) as proc:
        stdout, _ = proc.communicate(timeout=timeout)
        return subprocess.CompletedProcess(command, proc.returncode, stdout)


def run_check(check):
    result = run_shell_command(
        check.command,
        cwd=Path.cwd(),
        env=os.environ.copy(),
        timeout=float(os.environ.get("FIXTURE_CHECK_TIMEOUT", "8")),
    )
    return CheckResult("fail" if result.returncode else "pass", result.stdout)


def main(_args):
    results = []
    for check in load_manifest("checks.json"):
        results.append(run_check(check))
        print(f"{check.name}: {results[-1].status}", file=sys.stderr, flush=True)
    for result in results:
        print(result.output)
    return 42 if any(result.status == "fail" for result in results) else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
