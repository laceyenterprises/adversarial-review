"""Apply closer CI evidence and keep the mirror's commands under HAM custody."""

import ast
import hashlib
import inspect
import json
import locale
import os
import re
import selectors
import subprocess
import sys
import time
from contextlib import suppress
from dataclasses import fields, make_dataclass, replace
from pathlib import Path
from tempfile import NamedTemporaryFile
from types import ModuleType


LOG_LIMIT = 4 * 1024 * 1024
PROGRESS_INTERVAL = 15
SOCKET_PATH_FAILURE = re.compile(
    r"(?:OSError: AF_UNIX path too long|"
    r"(?:Error: )?(?:listen|bind) ENAMETOOLONG:[^\r\n]*)[ \t]*"
)


def socket_only_output(output):
    lines = [line for line in output.split("\n") if line.strip(" \t")]
    return len(lines) == 1 and SOCKET_PATH_FAILURE.fullmatch(lines[0]) is not None


class CheckDeadline(BaseException):
    """Leave the battery immediately so its outer owner can drain the group."""


class ProcessInspectionUnavailable(BaseException):
    """The Telegram guard explicitly returned no verdict for its Python lane."""


def compatible_shell_runner(runner):
    """Only replace the known combined-output, keyword-only runner contract."""
    try:
        parameters = list(inspect.signature(runner).parameters.values())
    except (TypeError, ValueError):
        return False
    return (
        [parameter.name for parameter in parameters]
        == ["command", "cwd", "env", "timeout"]
        and [parameter.kind for parameter in parameters]
        == [inspect.Parameter.POSITIONAL_OR_KEYWORD]
        + [inspect.Parameter.KEYWORD_ONLY] * 3
        and all(
            parameter.default is inspect.Parameter.empty for parameter in parameters
        )
    )


def run_attached(command, *, cwd, env, timeout, capture):
    deadline = None if timeout is None else time.monotonic() + timeout
    proc = subprocess.Popen(
        command,
        cwd=cwd,
        env=env,
        shell=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )

    def remaining():
        if deadline is None:
            return None
        seconds = deadline - time.monotonic()
        if seconds <= 0:
            raise CheckDeadline
        return seconds

    # Keep the repository runner's complete output for its own classification.
    # The private on-disk diagnostic is bounded independently by capture().
    output = bytearray()
    next_progress = 0
    with proc.stdout as stream, selectors.DefaultSelector() as selector:
        selector.register(stream, selectors.EVENT_READ)
        while True:
            if not selector.select(remaining()):
                continue
            chunk = os.read(stream.fileno(), 64 * 1024)
            if not chunk:
                break
            output.extend(chunk)
            capture(chunk)
            now = time.monotonic()
            if now >= next_progress:
                with suppress(BrokenPipeError, BlockingIOError):
                    print(
                        f"hammer CI mirror: check output received ({len(output)} bytes)",
                        file=sys.stderr,
                        flush=True,
                    )
                next_progress = now + PROGRESS_INTERVAL
    try:
        status = proc.wait(timeout=remaining())
    except subprocess.TimeoutExpired as exc:
        raise CheckDeadline from exc
    encoding = "utf-8" if sys.flags.utf8_mode else locale.getencoding()
    text = output.decode(encoding).replace("\r\n", "\n").replace("\r", "\n")
    return subprocess.CompletedProcess(command, status, text, None)


def main():
    plan_path, receipt_path, script, *args = sys.argv[1:]
    script_path = Path(script).resolve()
    sys.argv = [script, *args]
    sys.path[0] = str(script_path.parent)
    # Other mirror versions keep their original entry point and behavior.
    tree = ast.parse(script_path.read_bytes(), filename=script)
    definitions = {
        node.name
        for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.ClassDef))
    }
    if (
        not {"main", "load_manifest", "run_check", "Check", "CheckResult"}
        <= definitions
    ):
        os.execv(sys.executable, [sys.executable, script, *args])

    mirror = ModuleType("_hammer_ci_mirror")
    mirror.__file__ = str(script_path)
    sys.modules[mirror.__name__] = mirror
    exec(compile(tree, script, "exec"), vars(mirror))
    if not {"name", "command", "cwd", "skip_reason"} <= set(
        getattr(mirror.Check, "__dataclass_fields__", {})
    ):
        return mirror.main(args)

    receipt_file = Path(receipt_path)
    plan = {"manifests": {}, "reason": "ci-evidence-unavailable"}
    receipt = {"schemaVersion": 1, "checks": []}
    with suppress(OSError, ValueError):
        plan = json.loads(Path(plan_path).read_text(encoding="utf-8"))
    with suppress(OSError, ValueError):
        receipt = json.loads(receipt_file.read_text(encoding="utf-8"))
    if plan.get("source"):
        receipt["coverage"] = plan["source"]
    original_load = mirror.load_manifest
    original_run = mirror.run_check
    checkout = Path.cwd()
    check_fields = [field.name for field in fields(mirror.Check) if field.init]
    # Selection uses dataclasses.replace when combining matching globs. Carry
    # the manifest's evidence through that copy without setting skip_reason.
    mapped_check = make_dataclass(
        "MappedCheck",
        [("ci_evidence", dict)],
        bases=(mirror.Check,),
        frozen=mirror.Check.__dataclass_params__.frozen,
        kw_only=True,
    )

    def persist():
        temporary = None
        try:
            with NamedTemporaryFile(
                mode="w", encoding="utf-8", dir=receipt_file.parent, delete=False
            ) as stream:
                temporary = Path(stream.name)
                json.dump(receipt, stream)
            temporary.replace(receipt_file)
        except OSError:
            return False
        finally:
            if temporary:
                with suppress(OSError):
                    temporary.unlink(missing_ok=True)
        return True

    def load_manifest(path, *positional, **keywords):
        try:
            relative = Path(path).resolve().relative_to(checkout).as_posix()
            declaration = plan["manifests"].get(relative)
            if (
                not declaration
                or hashlib.sha256(Path(path).read_bytes()).hexdigest()
                != declaration["sha256"]
            ):
                declaration = None
        except (OSError, ValueError):
            declaration = None
        checks = original_load(path, *positional, **keywords)
        # A changed working file cannot lend evidence to what the loader saw.
        try:
            if (
                not declaration
                or hashlib.sha256(Path(path).read_bytes()).hexdigest()
                != declaration["sha256"]
            ):
                return checks
        except OSError:
            return checks
        entries = {
            (entry["name"], entry["command"]): entry for entry in declaration["checks"]
        }
        return [
            mapped_check(
                **{name: getattr(check, name) for name in check_fields},
                ci_evidence={
                    **entries.get((check.name, check.command), {}),
                    "manifest": relative,
                    "manifestSha256": declaration["sha256"],
                },
            )
            for check in checks
        ]

    # Supported mirrors run checks sequentially and let CheckDeadline escape.
    # Their runner combines stderr into stdout (CompletedProcess.stderr is None).
    # A concurrent runner needs separate receipt context before it is supported.
    active = None
    command_socket_faults = []

    def open_diagnostic(row):
        log = None
        diagnostic = {"limitBytes": LOG_LIMIT}
        try:
            log = NamedTemporaryFile(
                prefix=f"{receipt_file.name}.check-",
                suffix=".log",
                dir=receipt_file.parent,
                buffering=0,
                delete=False,
            )
            diagnostic["path"] = log.name
        except OSError:
            diagnostic["unavailable"] = True
        row.setdefault("diagnostics", []).append(diagnostic)
        persist()
        stored = 0

        def capture(chunk):
            nonlocal stored
            if log is None or diagnostic.get("unavailable"):
                return
            try:
                data = chunk[: LOG_LIMIT - stored]
                if log.write(data) != len(data):
                    raise OSError("short diagnostic write")
                stored += len(data)
                if len(chunk) > len(data) and not diagnostic.get("truncated"):
                    diagnostic["truncated"] = True
                    persist()
            except OSError:
                diagnostic["unavailable"] = True
                persist()

        return log, diagnostic, capture

    def run_shell_command(command, *, cwd, env, timeout):
        if active is None:
            return run_attached(
                command, cwd=cwd, env=env, timeout=timeout, capture=lambda _: None
            )
        log, diagnostic, capture = open_diagnostic(active)
        try:
            result = run_attached(
                command, cwd=cwd, env=env, timeout=timeout, capture=capture
            )
            command_socket_faults.append(
                0 < result.returncode < 124 and socket_only_output(result.stdout)
            )
            diagnostic["exitStatus"] = result.returncode
            persist()
            return result
        finally:
            if log is not None:
                with suppress(OSError):
                    log.close()

    def run_check(check, *positional, **keywords):
        nonlocal active
        decision = getattr(check, "ci_evidence", {})
        row = {
            "name": check.name,
            "cwd": check.cwd,
            "commandSha256": hashlib.sha256(check.command.encode()).hexdigest(),
            "status": "run",
            "reason": decision.get("reason", plan["reason"]),
        }
        receipt["checks"].append(row)
        jobs = decision.get("jobs")
        if jobs and not (decision.get("manifest") and decision.get("manifestSha256")):
            jobs = None
            row["reason"] = "ci-evidence-unavailable"
        result = None
        if jobs and not check.skip_reason:
            row.update(
                status="ci-covered",
                reason="exact-head-ci-success",
                jobs=jobs,
                manifest=decision["manifest"],
                manifestSha256=decision["manifestSha256"],
            )
            if persist():
                result = original_run(
                    replace(check, skip_reason="ci-covered"), *positional, **keywords
                )
                if result.status == "skipped" and result.reason == "ci-covered":
                    return result
            row.pop("jobs")
            row.update(status="run", reason="ci-evidence-unavailable")
            result = None
        if result is None:
            persist()
            command_socket_faults.clear()
            active = row
            try:
                result = original_run(check, *positional, **keywords)
            except CheckDeadline:
                row.update(
                    status="failed",
                    result="inconclusive",
                    localReason="check-timeout",
                    exitStatus=124,
                )
                persist()
                raise
            finally:
                active = None
        output = getattr(result, "output", "") or ""
        inspection_unavailable = (
            check.name == "telegram-responder-guard"
            and result.status != "fail"
            and (
                "telegram guard lane python: ps unusable in this sandbox: no verdict"
                in output.splitlines()
            )
        )
        if inspection_unavailable:
            row.update(
                status="failed",
                result="inconclusive",
                localReason="process-inspection-unavailable",
            )
        elif result.status in {"fail", "inconclusive"}:
            row.update(status="failed", result=result.status)
            if result.status == "fail" and command_socket_faults == [True]:
                row["socketPathFault"] = True
        elif result.status == "skipped":
            row.update(status="not-run", result=result.status)
        else:
            row["result"] = result.status
        if result.reason and not inspection_unavailable:
            row["localReason"] = result.reason
        if (
            (result.status != "pass" or inspection_unavailable)
            and not row.get("diagnostics")
            and output
        ):
            log, _, capture = open_diagnostic(row)
            if log is not None:
                with suppress(OSError), log:
                    capture(output.encode("utf-8", errors="replace"))
        logs = (
            row.pop("diagnostics", [])
            if result.status == "pass" and not inspection_unavailable
            else []
        )
        if persist():
            for log in logs:
                if "path" in log:
                    with suppress(OSError):
                        Path(log["path"]).unlink(missing_ok=True)
        elif logs:
            row["diagnostics"] = logs
        if inspection_unavailable:
            raise ProcessInspectionUnavailable
        return result

    receipt["perCheck"] = True
    persist()
    mirror.load_manifest = load_manifest
    mirror.run_check = run_check
    original_run_checks = getattr(mirror, "run_checks", None)
    if callable(original_run_checks):
        # Persist the entire selection size before the first check. Rows seen
        # before a timeout cannot stand in for guards the runner never reached.
        def run_checks(checks, *positional, **keywords):
            selected = list(checks)
            receipt["selectedCheckCount"] = len(selected)
            persist()
            return original_run_checks(selected, *positional, **keywords)

        mirror.run_checks = run_checks
    else:
        receipt["selectionSizeReason"] = "selection-size-unavailable"
        persist()
        print(
            "hammer CI mirror: selection-size-unavailable; UNKNOWN cannot use CI continuation",
            file=sys.stderr,
            flush=True,
        )
    shell_runner = getattr(mirror, "run_shell_command", None)
    if callable(shell_runner) and compatible_shell_runner(shell_runner):
        mirror.run_shell_command = run_shell_command
    elif callable(shell_runner):
        print(
            "hammer CI mirror: unsupported shell runner signature; keeping original runner",
            file=sys.stderr,
            flush=True,
        )
    try:
        return mirror.main(args)
    except CheckDeadline:
        print(
            "hammer CI mirror: check deadline expired; requesting group cleanup",
            file=sys.stderr,
            flush=True,
        )
        return 124
    except ProcessInspectionUnavailable:
        print(
            "hammer CI mirror: process inspection unavailable; no local verdict",
            file=sys.stderr,
            flush=True,
        )
        return (
            42 if any(row.get("result") == "fail" for row in receipt["checks"]) else 75
        )


if __name__ == "__main__":
    sys.exit(main())
