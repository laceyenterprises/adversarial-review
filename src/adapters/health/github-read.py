"""Bounded collector reads using the registered GitHub adapter's auth resolver.

No credential is printed or returned to Node. Adapter installation and broker
identity validation remain owned by agent_os_github_adapter.
"""
import argparse
import json
import os
import signal
from pathlib import Path
import subprocess
import sys


def read(args, *, resolver_factory=None, run=subprocess.run):
    adapter_src = Path(args.adapter_bin).resolve().parent.parent / "src"
    sys.path.insert(0, str(adapter_src))
    from agent_os_github_adapter.auth import AuthPolicy, AuthResolver

    policy = AuthPolicy.from_env(
        selector=args.role, mode="broker", allow_ambient=False,
        expected_app_id=args.app_id, expected_installation_id=args.installation_id,
        broker_provider=args.provider,
    )
    auth = (resolver_factory or AuthResolver)(policy=policy).resolve()
    if not auth.token:
        raise ValueError("adapter returned no token")
    child_env = {key: value for key, value in os.environ.items()
                 if key not in {"GH_TOKEN", "GITHUB_TOKEN"}}
    child_env["GH_TOKEN"] = auth.token
    command = ["gh", "pr"]
    if args.kind == "list":
        command += ["list", "--state", "open", "--limit", "100", "--json",
                    "number,url,title,headRefName,headRefOid,baseRefName,mergeable,isDraft,updatedAt,labels,commits"]
    elif args.kind == "state":
        command += ["view", args.number, "--json", "state,mergedAt,closedAt,headRefName,headRefOid"]
    else:
        command += ["checks", args.number, "--json", "name,state,bucket"]
    command += ["--repo", args.repo]
    proc = run(command, env=child_env, capture_output=True, text=True, timeout=15, check=False)
    # gh checks returns 1 for failed checks, 8 for pending; both carry data.
    if proc.returncode != 0 and not (args.kind == "checks" and proc.returncode in {1, 8}):
        raise ValueError("github read failed")
    data = json.loads(proc.stdout)
    if args.kind in {"list", "checks"} and not isinstance(data, list):
        raise ValueError("invalid list")
    if args.kind == "list" and len(data) >= 100:
        raise ValueError("incomplete list")
    if args.kind == "state" and not isinstance(data, dict):
        raise ValueError("invalid state")
    return data


def cancel_read(_signal, _frame):
    # Raising through subprocess.run kills/waits for the child, including when
    # Node's outer deadline interrupts a slow broker + gh combination.
    raise TimeoutError("collector deadline")


def main():
    signal.signal(signal.SIGTERM, cancel_read)
    parser = argparse.ArgumentParser()
    for name in ("adapter-bin", "repo", "role", "app-id", "installation-id", "provider"):
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--kind", choices=("list", "state", "checks"), required=True)
    parser.add_argument("--number")
    args = parser.parse_args()
    try:
        print(json.dumps(read(args)))
        return 0
    except Exception:
        # Never emit exception text, subprocess stdout/stderr or broker metadata.
        print("github-adapter-read-inconclusive", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
