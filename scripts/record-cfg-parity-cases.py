#!/usr/bin/env python3
"""ONS-07: record the Python CFG loader's verdict for each parity case.

Usage: PYTHONPATH=<agent-os>/platform/agent-os-config/src \
  python3 scripts/record-cfg-parity-cases.py test/fixtures/cfg-parity-cases.v1.json

Each case names YAML files written to a scratch directory (`config.yaml` is
the top file), optional `modules` and `env`, and dotted keys to `get`. The
script rewrites each case's `python` field with the loader's verdict, so the
offline Node suite (test/config-cfg-parity.test.mjs) can assert agreement.
"""

import json
import logging
import os
import sys
import tempfile
import warnings

warnings.simplefilter("ignore")
logging.disable(logging.CRITICAL)
from agent_os_config import AgentOSConfigError, load_config  # noqa: E402

path = sys.argv[1]
doc = json.load(open(path))
for case in doc["cases"]:
    with tempfile.TemporaryDirectory() as scratch:
        for name, text in case["files"].items():
            with open(os.path.join(scratch, name), "w") as handle:
                handle.write(text)
        env = {"AGENT_OS_CFG_VALIDATION_EVENT_LOG": "", **case.get("env", {})}
        try:
            cfg = load_config(
                top_path=os.path.join(scratch, "config.yaml"),
                module_paths=[os.path.join(scratch, m) for m in case.get("modules", [])],
                env=env,
            )
            case["python"] = {"ok": True, "values": {k: cfg.get(k) for k in case.get("get", [])}}
        except AgentOSConfigError as exc:
            case["python"] = {"ok": False, "key": exc.key}
with open(path, "w") as handle:
    json.dump(doc, handle, indent=1)
    handle.write("\n")
