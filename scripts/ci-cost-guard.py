#!/usr/bin/env python3
"""CIGUARD-01: offline workflow cost delta and operator authorization gate.

Estimates are planning values, not billing measurements: five minutes per job,
3.5 minutes per added long step, Linux/macOS/Windows multipliers 1/10/2.
Use --pushes-per-month with measured churn; otherwise use local 30-day history.
The JSON input mode is the shared engine used by adversarial-review (no YAML dependency).
"""

from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import itertools
import json
import math
import re
import subprocess
import sys
from pathlib import Path

LABEL = "ci-cost-approved"
LONG = re.compile(
    r"--download\b|replay|canary|(?:pytest|unittest\s+discover|npm\s+(?:test|run\s+test)|go\s+test|swift\s+test)|full[-_ ]suite|test-offline\.sh",
    re.I,
)
DEFAULT_MINUTES = 5.0
TIMEOUT_THRESHOLD = 10


def approved(labels, timeline, operators):
    """Last label event must be an explicitly configured human operator."""
    if LABEL not in labels:
        return False
    actor = None
    for event in timeline:
        if (event.get("label") or {}).get("name") == LABEL:
            if event.get("event") == "unlabeled":
                actor = None
            elif event.get("event") == "labeled":
                actor = event.get("actor")
    return bool(
        actor
        and actor.get("type") == "User"
        and not actor.get("login", "").lower().endswith("[bot]")
        and actor.get("login", "").lower() in {x.lower() for x in operators}
    )


def triggers(workflow):
    value = workflow.get("on", workflow.get(True, {})) or {}
    if isinstance(value, str):
        return {value: {}}
    if isinstance(value, list):
        return {x: {} for x in value}
    if not isinstance(value, dict):
        raise ValueError("unresolvable triggers")
    return {k: v or {} for k, v in value.items()}


def pr_fanout(workflow):
    events = triggers(workflow)
    count = (
        int("pull_request" in events)
        + int("pull_request_target" in events)
        + int("merge_group" in events)
    )
    push = events.get("push")
    if push is not None and push.get("branches") != ["main"]:
        count += 1
    return count


def variants(job):
    matrix = (job.get("strategy") or {}).get("matrix") or {}
    if not isinstance(matrix, dict):
        raise ValueError("dynamic matrix requires operator authorization")
    axes = {k: v for k, v in matrix.items() if k not in {"include", "exclude"}}
    if any(not isinstance(v, list) for v in axes.values()):
        raise ValueError("dynamic matrix axis requires operator authorization")
    size = math.prod(len(v) for v in axes.values())
    if size > 4096:
        raise ValueError("matrix too large to resolve")
    original = [dict(zip(axes, row)) for row in itertools.product(*axes.values())] if axes else []
    rows = [
        dict(row)
        for row in original
        if not any(
            all(row.get(k) == v for k, v in exc.items()) for exc in matrix.get("exclude", [])
        )
    ]
    for inc in matrix.get("include", []):
        matches = [
            i
            for i, row in enumerate(original)
            if all(k not in axes or row.get(k) == v for k, v in inc.items())
        ]
        if matches:
            for i in matches:
                for row in rows:
                    if all(row.get(k) == original[i].get(k) for k in axes):
                        row.update(inc)
        else:
            rows.append(dict(inc))
    return rows or ([{}] if not matrix else [])


def runner(job, row):
    value = job.get("runs-on", "")
    value = json.dumps(value) if isinstance(value, (list, dict)) else str(value)
    value = re.sub(
        r"\$\{\{\s*matrix\.([\w-]+)\s*\}\}", lambda m: str(row.get(m[1], "UNKNOWN")), value
    )
    # Existing Ubuntu-routing expressions keep their conservative Linux baseline.
    if "${{" in value and not re.search(r"\|\|\s*['\"]ubuntu-[^'\"]+['\"]", value):
        raise ValueError("dynamic runner requires operator authorization")
    lower = value.lower()
    weight = 10 if "macos" in lower else 2 if "windows" in lower else 1
    costly = bool(
        weight > 1
        or re.search(
            r"xlarge|gpu|larger|large\b|\b[2-9]\d*[-_]?(?:cores?|cpu)\b|\b(?:ubuntu|linux)-\d+(?:core|cores)|\b\d+-core",
            lower,
        )
    )
    known_linux = "ubuntu" in lower or "linux" in lower
    if not known_linux and weight == 1:
        costly = True  # custom/self-hosted labels are not assumed free
    if costly and weight == 1:
        weight = 4
    return value, weight, costly


def concurrency_removed(old, new):
    before, after = old.get("concurrency"), new.get("concurrency")
    return bool(
        before
        and (
            not after
            or (
                isinstance(before, dict)
                and before.get("cancel-in-progress")
                and (not isinstance(after, dict) or not after.get("cancel-in-progress"))
            )
        )
    )


def job_minutes(job):
    return max(
        DEFAULT_MINUTES,
        sum(3.5 for step in job.get("steps", []) if LONG.search(step.get("run", ""))),
    )


def total_minutes(workflow):
    return sum(
        job_minutes(job) * sum(runner(job, row)[1] for row in variants(job))
        for job in (workflow.get("jobs") or {}).values()
    )


def schedule_runs(events):
    """Count cron firings in the next 30 UTC dates; no network or billing access."""

    def values(expression, maximum, minimum=0):
        result = set()
        for term in expression.split(","):
            span, _, stride = term.partition("/")
            step = int(stride or 1)
            if step <= 0:
                raise ValueError("invalid cron stride")
            if span == "*":
                low, high = minimum, maximum
            elif "-" in span:
                low, high = map(int, span.split("-"))
            else:
                low = high = int(span)
            if not minimum <= low <= high <= maximum:
                raise ValueError("invalid cron range")
            result.update(range(low, high + 1, step))
        return result

    total = 0
    today = datetime.now(timezone.utc).date()
    for entry in events.get("schedule", []):
        minute, hour, dom, month, dow = entry["cron"].split()
        times = len(values(minute, 59)) * len(values(hour, 23))
        days, months, weekdays = values(dom, 31, 1), values(month, 12, 1), values(dow, 7)
        for offset in range(30):
            day = today + timedelta(days=offset)
            weekday = (day.weekday() + 1) % 7
            week_match = weekday in weekdays or (weekday == 0 and 7 in weekdays)
            day_match = day.day in days
            # Cron combines restricted day-of-month and day-of-week with OR.
            matches = (
                (day_match or week_match) if dom != "*" and dow != "*" else day_match and week_match
            )
            if day.month in months and matches:
                total += times
    return total


def analyze(before, after):
    if after is None:
        return {
            "reasons": [],
            "added_minutes_per_pr_push": 0.0,
            "added_minutes_per_month_fixed": 0.0,
        }
    before, after = before or {}, after or {}
    reasons = []
    if not before:
        reasons.append("new workflow file")
    old_events, events = triggers(before), triggers(after)
    for event in {"push", "schedule", "pull_request_target", "merge_group", "pull_request"}:
        if (
            event in events
            and event not in old_events
            and (event != "push" or events[event].get("branches") != ["main"])
        ):
            reasons.append(f"added trigger: {event}")
    if (
        "push" in old_events
        and "push" in events
        and old_events["push"].get("branches") == ["main"]
        and events["push"].get("branches") != ["main"]
    ):
        reasons.append("push no longer restricted to main")
    for event in old_events.keys() & events.keys():
        for key in ("paths", "paths-ignore", "branches", "branches-ignore"):
            a, b = old_events[event].get(key), events[event].get(key)
            if a and (not b or a != b):
                reasons.append(
                    f"removed or changed {event} {key} filter (potential broadened cadence)"
                )
    if concurrency_removed(before, after):
        reasons.append("removed concurrency or cancel-in-progress")
    if (
        "schedule" in old_events
        and "schedule" in events
        and old_events["schedule"] != events["schedule"]
    ):
        reasons.append("schedule cadence changed (potential cost increase)")
    old_jobs = before.get("jobs") or {}
    step_added = 0.0
    for name, job in (after.get("jobs") or {}).items():
        old = old_jobs.get(name, {})
        rows, old_rows = variants(job), variants(old) if old else []
        if len(rows) > len(old_rows):
            reasons.append(
                f"{name}: job/matrix count grows {len(old_rows)} -> {len(rows)} per trigger"
            )
        if old and any(row not in old_rows for row in rows):
            reasons.append(f"{name}: adds matrix entries")
        previous = {runner(old, row)[0] for row in old_rows}
        for row in rows:
            value, _, costly = runner(job, row)
            if costly and value not in previous:
                reasons.append(f"{name}: adds non-Linux/larger runner {value}")
        if job.get("uses") and job.get("uses") != old.get("uses"):
            reasons.append(f"{name}: new/changed reusable workflow (unknown cost)")
        if concurrency_removed(old, job):
            reasons.append(f"{name}: removed concurrency or cancel-in-progress")
        for owner, newer, older in [(name, job, old)] + [
            (
                f"{name} step {i}",
                step,
                (old.get("steps") or [{}])[i] if i < len(old.get("steps", [])) else {},
            )
            for i, step in enumerate(job.get("steps", []))
        ]:
            timeout = newer.get("timeout-minutes", 0)
            if not isinstance(timeout, (int, float)):
                reasons.append(f"{owner}: dynamic timeout")
            elif timeout > TIMEOUT_THRESHOLD and timeout > older.get("timeout-minutes", 0):
                reasons.append(
                    f"{owner}: timeout raised above {TIMEOUT_THRESHOLD} minutes to {timeout}"
                )
        commands = [step.get("run", "") for step in old.get("steps", [])]
        for step in job.get("steps", []):
            cmd = step.get("run", "")
            if cmd in commands:
                commands.remove(cmd)
            elif LONG.search(cmd):
                reasons.append(f"{name}: added long-running command: {cmd.strip()[:180]}")
                step_added += 3.5 * sum(runner(job, row)[1] for row in rows)
    before_pr = total_minutes(before) * pr_fanout(before)
    after_pr = total_minutes(after) * pr_fanout(after)
    added = max(0.0, after_pr - before_pr, step_added * pr_fanout(after))
    if reasons and pr_fanout(after) and not added:
        added = max(
            0.1, after_pr * 0.1
        )  # lost cancellation/path selectivity: explicit planning allowance
    fixed = max(
        0.0,
        total_minutes(after) * schedule_runs(events)
        - total_minutes(before) * schedule_runs(old_events),
    )
    return {
        "reasons": sorted(set(reasons)),
        "added_minutes_per_pr_push": round(added, 3),
        "added_minutes_per_month_fixed": round(fixed, 3),
    }


def evaluate(changes, labels=(), timeline=(), operators=(), pushes_per_month=100):
    findings = []
    for change in changes:
        try:
            result = analyze(change.get("before"), change.get("after"))
        except (ValueError, TypeError, KeyError, AttributeError) as error:
            result = {
                "reasons": [f"unresolved workflow cost: {error}"],
                "added_minutes_per_pr_push": 50.0,
                "added_minutes_per_month_fixed": 0.0,
            }
        if result["reasons"]:
            findings.append({"path": change["path"], **result})
    added = round(sum(x["added_minutes_per_pr_push"] for x in findings), 3)
    authorized = approved(labels, timeline, operators)
    return {
        "ok": not findings or authorized,
        "flagged": bool(findings),
        "authorized": authorized,
        "findings": findings,
        "added_minutes_per_pr_push": added,
        "pushes_per_month": pushes_per_month,
        "added_minutes_per_month": round(
            added * pushes_per_month + sum(x["added_minutes_per_month_fixed"] for x in findings), 3
        ),
        "estimate_basis": "planning estimate: 5 min/job; 3.5 min/long step; macOS x10, Windows x2, custom/larger x4; lost filtering/cancellation allowance 10%; schedule firings in next 30 UTC dates",
    }


def git(repo, *args):
    return subprocess.check_output(["git", "-C", str(repo), *args], text=True, timeout=20)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", default=".")
    parser.add_argument("--base", default="origin/main")
    parser.add_argument("--head", default="HEAD")
    parser.add_argument("--json-input", action="store_true")
    parser.add_argument(
        "--authorization",
        type=Path,
        help="trusted live labels/timeline/operators JSON (not PR content)",
    )
    parser.add_argument("--pushes-per-month", type=float)
    args = parser.parse_args()
    try:
        if args.json_input:
            payload = json.load(sys.stdin)
        else:
            import yaml

            if not args.base:
                parser.error("--base required")
            base = git(args.repo, "merge-base", args.base, args.head).strip()
            changes = []
            names = git(
                args.repo,
                "diff",
                "--name-only",
                "--no-renames",
                base,
                args.head,
                "--",
                ".github/workflows/",
            ).splitlines()
            for path in names:
                versions = []
                for ref in (base, args.head):
                    exists = git(args.repo, "ls-tree", ref, "--", path).strip()
                    versions.append(
                        yaml.safe_load(git(args.repo, "show", f"{ref}:{path}")) if exists else None
                    )
                changes.append({"path": path, "before": versions[0], "after": versions[1]})
            payload = {"changes": changes}
            if args.authorization:
                payload.update(json.loads(args.authorization.read_text()))
            count = len(
                git(args.repo, "log", "--all", "--since=30 days ago", "--format=%H").splitlines()
            )
            payload["pushes_per_month"] = (
                args.pushes_per_month if args.pushes_per_month is not None else max(1, count)
            )
        result = evaluate(**payload)
        print(json.dumps(result, indent=2))
        return 0 if result["ok"] else 1
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
