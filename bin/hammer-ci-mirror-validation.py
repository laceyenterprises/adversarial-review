"""Apply closer CI evidence inside the mirror's existing selection and runner."""

import ast
import hashlib
import json
import os
import sys
from contextlib import suppress
from dataclasses import fields, make_dataclass, replace
from pathlib import Path
from tempfile import NamedTemporaryFile
from types import ModuleType


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

    try:
        plan = json.loads(Path(plan_path).read_text(encoding="utf-8"))
        receipt = json.loads(Path(receipt_path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return mirror.main(args)
    receipt_file = Path(receipt_path)
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
                ci_evidence=entries.get((check.name, check.command), {}),
            )
            for check in checks
        ]

    def run_check(check, *positional, **keywords):
        decision = getattr(check, "ci_evidence", {})
        row = {
            "name": check.name,
            "cwd": check.cwd,
            "status": "run",
            "reason": decision.get("reason", plan["reason"]),
        }
        receipt["checks"].append(row)
        jobs = decision.get("jobs")
        result = None
        if jobs and not check.skip_reason:
            row.update(status="ci-covered", reason="exact-head-ci-success", jobs=jobs)
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
            result = original_run(check, *positional, **keywords)
        if result.status in {"fail", "inconclusive"}:
            row.update(status="failed", result=result.status)
        elif result.status == "skipped":
            row.update(status="not-run", result=result.status)
        else:
            row["result"] = result.status
        if result.reason:
            row["localReason"] = result.reason
        persist()
        return result

    receipt["perCheck"] = True
    if persist():
        mirror.load_manifest = load_manifest
        mirror.run_check = run_check
    return mirror.main(args)


if __name__ == "__main__":
    sys.exit(main())
