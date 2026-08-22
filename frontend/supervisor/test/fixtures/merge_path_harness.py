#!/usr/bin/env python3
"""A stand-in for the long-lived Python merge path (ARF-08 test fixture).

The auto-merge backstop is a Python daemon that boots once and stays up. Like
its Node counterpart in ``merge-path-harness.mjs``, this constructs its gate
**once at startup** and then answers a decision per line on stdin, so a test can
flip the gate from outside and watch the answer change in a process it never
restarted.

The pid is in every response for exactly that reason: without it, "the decision
changed" and "the process was replaced" look identical from the outside.
"""

import json
import os
import sys

sys.path.insert(
    0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "gate")
)

from arf_gate import ArfGate  # noqa: E402  (path has to be set before the import)

# Constructed once, at boot, exactly like the daemon this stands in for.
GATE = ArfGate(os.environ["ARF_GATE_FILE"])


def main():
    for line in sys.stdin:
        path_id = line.strip()
        if path_id == "":
            continue
        if path_id == "exit":
            break
        decision = GATE.decide_all() if path_id == "all" else GATE.decide(path_id)
        sys.stdout.write(
            json.dumps({"pid": os.getpid(), "runtime": "python", "decision": decision}) + "\n"
        )
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
