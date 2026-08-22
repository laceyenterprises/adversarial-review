#!/usr/bin/env python3
"""The honoring read path (ARF-08) — Python.

The Python auto-merge backstop is a merge-capable actor, so it needs the same
gate the Node watcher paths use. This module is the Python half: identical
contract, identical decision codes, identical fail-closed posture, stdlib only.

Embedding it in a merge path is three lines::

    from arf_gate import ArfGate

    decision = ArfGate(os.environ["ARF_GATE_FILE"]).decide("python-backstop")
    if not decision["allowed"]:
        return refuse(decision["code"], decision["reason"])

Or, from a shell wrapper, with no import at all::

    python3 arf_gate.py --gate "$ARF_GATE_FILE" --path python-backstop || exit

Exit codes: ``0`` armed, ``3`` disarmed by an operator, ``4`` fail-closed
refusal (the gate is missing or broken), ``2`` usage.

Two invariants this file has to keep, and why:

1. **It stays byte-compatible with ``gate-contract.mjs``.** The constants below
   are restated rather than imported, because a Python process cannot import an
   ES module — which is precisely the ``config-schema.multi-loader-parity``
   shape that has taken daemons down before. ``test/gate-parity.test.mjs`` runs
   ``contract()`` here and deep-diffs it against the Node contract, so drift
   fails a test rather than a merge decision.

2. **It never caches.** Same reason as the Node client: an mtime-keyed cache
   cannot see two writes inside one filesystem timestamp tick, and would then
   serve a pre-disarm answer for the life of the process. The read is four
   syscalls against a page the OS already has.

No third-party imports, and nothing from agent-os: this file is meant to be
copied verbatim into a pipeline repo if importing across trees is inconvenient.
"""

import argparse
import json
import os
import sys

# --- contract (mirrors gate-contract.mjs; the parity test diffs the two) ------

GATE_VERSION = 1

MAX_GATE_BYTES = 64 * 1024

MASTER_SCOPE = "all"

MERGE_PATHS = (
    {
        "id": "hammer",
        "label": "hammer",
        "msm": True,
        "executor": "adversarial-watcher",
        "role": (
            "Common path. Remediates every final finding, rebases, revalidates CI at the "
            "rebased head, and merges under its own lease."
        ),
    },
    {
        "id": "daemon-clean",
        "label": "daemon-clean",
        "msm": True,
        "executor": "adversarial-watcher",
        "role": (
            "Rare path. On a fully-clean settled review with green required checks, a "
            "mergeable PR, and a matching head, the watcher clicks merge inline."
        ),
    },
    {
        "id": "python-backstop",
        "label": "auto-merge backstop",
        "msm": False,
        "executor": "auto-merge-daemon",
        "role": (
            "Worker-pool lane that merges CLEAN + MERGEABLE gate decisions once the AMA "
            "deferral window lapses. No merge-authority config key disarms it."
        ),
    },
)

MERGE_PATH_IDS = tuple(path["id"] for path in MERGE_PATHS)

MSM_PATH_IDS = tuple(path["id"] for path in MERGE_PATHS if path["msm"])

DECISION_CODES = {
    "armed": {"allowed": True, "failClosed": False, "summary": "the gate arms this merge path"},
    "disarmed-path": {
        "allowed": False,
        "failClosed": False,
        "summary": "this merge path is disarmed",
    },
    "disarmed-master": {
        "allowed": False,
        "failClosed": False,
        "summary": "every merge path is disarmed (emergency stop)",
    },
    "gate-missing": {
        "allowed": False,
        "failClosed": True,
        "summary": "no gate document at the configured path",
    },
    "gate-unreadable": {
        "allowed": False,
        "failClosed": True,
        "summary": "the gate document could not be read",
    },
    "gate-oversize": {
        "allowed": False,
        "failClosed": True,
        "summary": "the gate document exceeds the size a gate can legitimately be",
    },
    "gate-malformed": {
        "allowed": False,
        "failClosed": True,
        "summary": "the gate document is not a well-formed gate",
    },
    "gate-version-unsupported": {
        "allowed": False,
        "failClosed": True,
        "summary": "the gate document is a version this client does not understand",
    },
    "path-absent": {
        "allowed": False,
        "failClosed": True,
        "summary": "the gate document carries no entry for this merge path",
    },
    "unknown-path": {
        "allowed": False,
        "failClosed": True,
        "summary": "not a merge path this contract defines",
    },
}

# Insertion order is the contract order; the parity diff compares the sequence.
DECISION_CODE_IDS = tuple(DECISION_CODES.keys())

EXIT_CODES = {"allowed": 0, "usage": 2, "disarmed": 3, "refused": 4}


def contract():
    """The whole contract as plain data, for the cross-language parity gate."""
    return {
        "gateVersion": GATE_VERSION,
        "maxGateBytes": MAX_GATE_BYTES,
        "masterScope": MASTER_SCOPE,
        "mergePathIds": list(MERGE_PATH_IDS),
        "msmPathIds": list(MSM_PATH_IDS),
        "mergePaths": [dict(path) for path in MERGE_PATHS],
        "decisionCodes": {code: dict(spec) for code, spec in DECISION_CODES.items()},
        "exitCodes": dict(EXIT_CODES),
    }


def is_merge_path(path_id):
    """Whether ``path_id`` is a merge path this contract defines."""
    return path_id in MERGE_PATH_IDS


def exit_code_for(decision):
    """The process exit code a decision maps to."""
    if decision["allowed"]:
        return EXIT_CODES["allowed"]
    return EXIT_CODES["refused"] if decision["failClosed"] else EXIT_CODES["disarmed"]


# --- reading ------------------------------------------------------------------


def read_gate_bytes(path, max_bytes=MAX_GATE_BYTES):
    """Read at most ``max_bytes`` of ``path`` in one open/fstat/read/close.

    ``fstat`` on the open descriptor rather than ``stat`` on the name, so the
    size check and the read describe the same file. The oversize refusal happens
    before the read, which is what keeps the cost constant whatever the file on
    disk has become.
    """
    try:
        fd = os.open(path, os.O_RDONLY)
    except FileNotFoundError:
        return {"code": "gate-missing", "text": None, "detail": "no gate document at %s" % path}
    except NotADirectoryError:
        return {"code": "gate-missing", "text": None, "detail": "no gate document at %s" % path}
    except OSError as err:
        return {"code": "gate-unreadable", "text": None, "detail": "%s: %s" % (path, err)}
    try:
        size = os.fstat(fd).st_size
        if size > max_bytes:
            return {
                "code": "gate-oversize",
                "text": None,
                "detail": "%s is %d bytes; a gate document is bounded at %d"
                % (path, size, max_bytes),
            }
        chunks = []
        remaining = size
        while remaining > 0:
            chunk = os.read(fd, remaining)
            # A short read inside the reported size means the file was truncated
            # under us — a half-written document, which the JSON parse rejects.
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        raw = b"".join(chunks)
    except OSError as err:
        return {"code": "gate-unreadable", "text": None, "detail": "%s: %s" % (path, err)}
    finally:
        try:
            os.close(fd)
        except OSError:
            # A descriptor that will not close is not a reason to fail a decision
            # that already has its answer.
            pass
    try:
        return {"code": None, "text": raw.decode("utf-8"), "detail": None}
    except UnicodeDecodeError as err:
        return {"code": "gate-malformed", "text": None, "detail": "%s: %s" % (path, err)}


def _refusal(path_id, code, detail, gate=None):
    spec = DECISION_CODES[code]
    return {
        "path": path_id,
        "allowed": False,
        "code": code,
        "failClosed": spec["failClosed"],
        "reason": ("%s: %s" % (spec["summary"], detail)) if detail else spec["summary"],
        "gate": gate,
        "setBy": None,
        "setAt": None,
        "setReason": None,
    }


def _is_object(value):
    return isinstance(value, dict)


def _is_bool(value):
    # `isinstance(1, bool)` is False but `isinstance(True, int)` is True, so the
    # bool check has to come first anywhere a number could be mistaken for one.
    return isinstance(value, bool)


def _text_or_none(value):
    return value if isinstance(value, str) else None


def _gate_summary(document, path):
    seq = document.get("seq")
    return {
        "path": path,
        "version": document.get("gateVersion"),
        "seq": seq if isinstance(seq, int) and not isinstance(seq, bool) else None,
        "updatedAt": _text_or_none(document.get("updatedAt")),
    }


def parse_gate_document(text, path="<gate>"):
    """Parse a gate document, refusing anything that is not unambiguously one.

    Additive fields are ignored so a later ARF can add one without stopping a
    pipeline that has not updated. Every field a decision depends on is required
    and typed: a ``master.armed`` of ``"false"`` is malformed, not falsy.
    """
    try:
        parsed = json.loads(text)
    except ValueError as err:
        return {"document": None, "code": "gate-malformed", "detail": "%s: %s" % (path, err)}
    if not _is_object(parsed):
        return {
            "document": None,
            "code": "gate-malformed",
            "detail": "%s: not a JSON object" % path,
        }
    if parsed.get("gateVersion") != GATE_VERSION or _is_bool(parsed.get("gateVersion")):
        return {
            "document": None,
            "code": "gate-version-unsupported",
            "detail": "%s: gateVersion %s, this client speaks %d"
            % (path, json.dumps(parsed.get("gateVersion")), GATE_VERSION),
        }
    master = parsed.get("master")
    if not _is_object(master) or not _is_bool(master.get("armed")):
        return {
            "document": None,
            "code": "gate-malformed",
            "detail": "%s: master.armed must be a boolean" % path,
        }
    if not _is_object(parsed.get("paths")):
        return {
            "document": None,
            "code": "gate-malformed",
            "detail": "%s: paths must be an object" % path,
        }
    return {"document": parsed, "code": None, "detail": None}


def decide_from_document(document, path_id, gate_path="<gate>"):
    """Decide one merge path against an already-parsed document.

    The master scope is checked before the per-path entry is looked up, so an
    emergency stop covers a path this document does not enumerate — including
    one a newer ARF would add.
    """
    if not is_merge_path(path_id):
        return _refusal(path_id, "unknown-path", "known: %s" % ", ".join(MERGE_PATH_IDS))
    gate = _gate_summary(document, gate_path)

    master = document["master"]
    if master["armed"] is False:
        return {
            "path": path_id,
            "allowed": False,
            "code": "disarmed-master",
            "failClosed": False,
            "reason": DECISION_CODES["disarmed-master"]["summary"],
            "gate": gate,
            "setBy": _text_or_none(master.get("actor")),
            "setAt": _text_or_none(master.get("at")),
            "setReason": _text_or_none(master.get("reason")),
        }

    entry = document["paths"].get(path_id)
    if not _is_object(entry) or not _is_bool(entry.get("armed")):
        return _refusal(
            path_id,
            "path-absent",
            "%s carries no boolean paths.%s.armed" % (gate_path, path_id),
            gate,
        )

    code = "armed" if entry["armed"] else "disarmed-path"
    return {
        "path": path_id,
        "allowed": entry["armed"],
        "code": code,
        "failClosed": False,
        "reason": DECISION_CODES[code]["summary"],
        "gate": gate,
        "setBy": _text_or_none(entry.get("actor")),
        "setAt": _text_or_none(entry.get("at")),
        "setReason": _text_or_none(entry.get("reason")),
    }


class ArfGate(object):
    """A gate bound to a path.

    Holds no state between calls beyond that path — deliberately, so there is
    nothing that can go stale and no reason to bounce the process holding it.
    """

    def __init__(self, gate_path, max_bytes=MAX_GATE_BYTES, read_bytes=read_gate_bytes):
        if not isinstance(gate_path, str) or not gate_path.strip():
            # No default and no ambient discovery: inventing a path would turn a
            # configuration bug into a silent "no gate, merge away".
            raise ValueError("ArfGate requires the gate document path (e.g. ARF_GATE_FILE)")
        self.gate_path = gate_path
        self.max_bytes = max_bytes
        self.read_bytes = read_bytes

    def load(self):
        """Load and parse the document, or the refusal code that stopped it."""
        read = self.read_bytes(self.gate_path, self.max_bytes)
        if read["code"]:
            return {"document": None, "code": read["code"], "detail": read["detail"]}
        return parse_gate_document(read["text"], self.gate_path)

    def decide(self, path_id):
        """Decide a single merge path. One document read, whatever the load."""
        loaded = self.load()
        if loaded["document"] is None:
            return _refusal(path_id, loaded["code"], loaded["detail"])
        return decide_from_document(loaded["document"], path_id, self.gate_path)

    def decide_all(self):
        """Decide every merge path from **one** read.

        A caller looping ``decide()`` would read the document once per path and
        could observe a flip landing mid-loop, so two paths would answer from
        different documents. This is how a caller gets a coherent snapshot.
        """
        loaded = self.load()
        out = {}
        for path_id in MERGE_PATH_IDS:
            if loaded["document"] is None:
                out[path_id] = _refusal(path_id, loaded["code"], loaded["detail"])
            else:
                out[path_id] = decide_from_document(loaded["document"], path_id, self.gate_path)
        return out

    def exit_code_for(self, path_id):
        """The exit code ``arf gate check`` returns for a path."""
        return exit_code_for(self.decide(path_id))


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="arf_gate",
        description="Decide whether the ARF arm/disarm gate permits a merge path.",
    )
    parser.add_argument(
        "--gate", default=os.environ.get("ARF_GATE_FILE"), help="gate document path"
    )
    parser.add_argument("--path", dest="path_id", help="merge path id (default: every path)")
    parser.add_argument("--json", action="store_true", help="print the decision as JSON")
    parser.add_argument(
        "--contract", action="store_true", help="print the contract as JSON and exit 0"
    )
    args = parser.parse_args(argv)

    if args.contract:
        sys.stdout.write(json.dumps(contract(), sort_keys=True) + "\n")
        return EXIT_CODES["allowed"]

    if not args.gate:
        sys.stderr.write("arf_gate: --gate (or ARF_GATE_FILE) is required\n")
        return EXIT_CODES["usage"]

    gate = ArfGate(args.gate)

    if args.path_id is None:
        decisions = gate.decide_all()
        if args.json:
            sys.stdout.write(json.dumps(decisions, sort_keys=True) + "\n")
        else:
            for path_id in MERGE_PATH_IDS:
                decision = decisions[path_id]
                sys.stdout.write(
                    "%-16s %-8s %s\n"
                    % (path_id, "armed" if decision["allowed"] else "DISARMED", decision["reason"])
                )
        # The aggregate exit code is the worst outcome across the paths, so a
        # wrapper checking "is anything armed" cannot read a zero as "all clear".
        worst = max(exit_code_for(decisions[path_id]) for path_id in MERGE_PATH_IDS)
        return worst

    decision = gate.decide(args.path_id)
    if args.json:
        sys.stdout.write(json.dumps(decision, sort_keys=True) + "\n")
    else:
        sys.stdout.write(
            "%s: %s\n" % ("armed" if decision["allowed"] else "refused", decision["reason"])
        )
    return exit_code_for(decision)


if __name__ == "__main__":
    sys.exit(main())
