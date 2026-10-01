"""Bounded collector reads using the registered GitHub adapter's auth resolver.

No credential is printed or returned to Node. Adapter installation and broker
identity validation remain owned by agent_os_github_adapter.
"""
import argparse
import errno
import json
import os
import re
import signal
from pathlib import Path
import subprocess
import sys
import time


GH_RETRY_DELAYS_SECONDS = (0.1, 0.25)
GH_ATTEMPT_TIMEOUT_SECONDS = 5
TRANSIENT_GH_ERROR = re.compile(
    r"\b(?:ETIMEDOUT|ESOCKETTIMEDOUT|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|"
    r"ENETUNREACH|EAI_AGAIN|EPIPE|EIO)\b|TLS handshake timeout|SSL|"
    r"timed?\s*out|timeout|connection (?:reset|refused)|network|early EOF|"
    r"RPC failed|remote end hung up|HTTP 5\d\d|Bad Gateway|"
    r"Service Unavailable|Gateway Timeout",
    re.IGNORECASE,
)


def run_gh(command, child_env, kind, *, run, sleep):
    # Three 5s attempts plus 350ms backoff fit within Node's 20s outer
    # deadline. SIGTERM's TimeoutError must unwind, never restart a child.
    for attempt in range(len(GH_RETRY_DELAYS_SECONDS) + 1):
        try:
            proc = run(command, env=child_env, capture_output=True, text=True,
                       timeout=GH_ATTEMPT_TIMEOUT_SECONDS, check=False)
        except subprocess.TimeoutExpired:
            transient = True
        except TimeoutError:
            raise
        except OSError as error:
            transient = error.errno in {errno.EAGAIN, errno.EIO, errno.EMFILE, errno.ENFILE}
            if not transient:
                raise ValueError("github read failed") from None
        else:
            if proc.returncode == 0:
                return proc
            # gh checks returns 1 for failed checks, 8 for pending. Accept
            # these only with list data; a TLS failure can also exit with 1.
            if kind == "checks" and proc.returncode in {1, 8}:
                try:
                    if isinstance(json.loads(proc.stdout), list):
                        return proc
                except (ValueError, TypeError):
                    pass
            transient = bool(TRANSIENT_GH_ERROR.search(f"{proc.stderr}\n{proc.stdout}"))
        if not transient or attempt == len(GH_RETRY_DELAYS_SECONDS):
            raise ValueError("github read failed") from None
        sleep(GH_RETRY_DELAYS_SECONDS[attempt])


def read(args, *, resolver_factory=None, run=subprocess.run, sleep=time.sleep):
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
    proc = run_gh(command, child_env, args.kind, run=run, sleep=sleep)
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
