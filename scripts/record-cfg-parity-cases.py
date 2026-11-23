#!/usr/bin/env python3
"""ONS-07: record the Python CFG loader's verdict for each parity case.

Usage: PYTHONPATH=<agent-os>/platform/agent-os-config/src \
  python3 scripts/record-cfg-parity-cases.py test/fixtures/cfg-parity-cases.v1.json

Each case names YAML files written to a scratch directory (`config.yaml` is
the top file), optional `modules` and `env`, and dotted keys to `get`. The
script rewrites each case's `python` field with the loader's verdict, so the
offline Node suite (test/config-cfg-parity.test.mjs) can assert agreement.

The supplied JSON is also the input suite: cases are authored here, not
imported from an upstream test list. Recording preserves all case inputs.
Use a clean agent-os checkout and set the fixture's `source` to its full
commit SHA after recording. For cases recorded against a newer revision,
use a separate cfg-parity-cases.<name>.json and include it in the Node test
so the older cases retain their original provenance.
"""

import json
import logging
import os
import sys
import tempfile
import warnings

if len(sys.argv) != 2:
    print("usage: record-cfg-parity-cases.py <cases.json>", file=sys.stderr)
    raise SystemExit(2)

warnings.simplefilter("ignore")
logging.disable(logging.CRITICAL)
from agent_os_config import AgentOSConfigError, load_config  # noqa: E402

path = sys.argv[1]
with open(path, encoding="utf-8") as handle:
    doc = json.load(handle)
for case in doc["cases"]:
    with tempfile.TemporaryDirectory() as scratch:
        for name, text in case["files"].items():
            target = os.path.join(scratch, name)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target, "w", encoding="utf-8") as handle:
                handle.write(text)
        env = {"AGENT_OS_CFG_VALIDATION_EVENT_LOG": "", **(case.get("env") or {})}
        try:
            cfg = load_config(
                top_path=os.path.join(scratch, "config.yaml"),
                module_paths=[
                    os.path.join(scratch, m) for m in (case.get("modules") or [])
                ],
                env=env,
            )
            case["python"] = {
                "ok": True,
                "values": {k: cfg.get(k) for k in (case.get("get") or [])},
            }
        except AgentOSConfigError as exc:
            case["python"] = {"ok": False, "key": exc.key}
with open(path, "w", encoding="utf-8") as handle:
    json.dump(doc, handle, indent=1)
    handle.write("\n")
