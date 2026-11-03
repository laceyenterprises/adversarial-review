"""Offline cross-repository seam qualification; no provider or credential I/O.

Execute verbatim exported source snapshots, with synthetic config and registry.
Identity admission itself is real: the empty builder pool refuses launch.
This is not a qualification of the unrebased PR's complete runtime.
"""

import json
import os
from pathlib import Path
import pwd
import re
import subprocess
import sys
from types import ModuleType, SimpleNamespace
from typing import Any, Mapping

root = Path(__file__).parent
payload = json.load(sys.stdin)
classes = json.loads((root / "classes.json").read_text())


def module(name, **values):
    result = ModuleType(name)
    result.__dict__.update(values)
    sys.modules[name] = result
    return result


module("cwp_dispatch")
module("agent_os_config")
module("agent_os_core")
module("agent_os_config.token_pool_declarations", DECLARATION_KEYS=[])
module(
    "agent_os_core.identity_token_pools",
    read_identity_token_pools=lambda _: SimpleNamespace(accounts={}, pools={}),
)
module("cwp_dispatch.paths", hq_owner=lambda _: None)
module(
    "cwp_dispatch.agent_os_config_helper",
    get_config_runtime=lambda: {},
    resolve_hq_root_default=lambda: str(root),
)
builder = module(
    "cwp_dispatch.agy_builder",
    Path=Path,
    Any=Any,
    pwd=pwd,
    re=re,
    os=os,
    subprocess=subprocess,
    sys=sys,
    __file__=str(root / "agy_builder.py"),
)
exec(
    compile((root / "agy_builder.py").read_text(), "agy_builder.py", "exec"),
    builder.__dict__,
)
assert builder.builder_identities(root) == []
assert builder.admission_identity(root) is None
accounts = SimpleNamespace(getpwnam=lambda _: SimpleNamespace(pw_uid=987654321))
for configured in ["reviewer-fixture", "reviewer-alias-fixture"]:
    try:
        builder.builder_identities(
            root,
            config={
                "worker_pool.gemini.builder_identities": [configured],
                "reviewer.gemini.identities": ["reviewer-fixture"],
            },
            accounts=accounts,
        )
        raise AssertionError("builder borrowed a reviewer UID")
    except ValueError as error:
        assert "reserved reviewer seat" in str(error)
try:
    builder.launch_environment(root)
    raise AssertionError("empty builder pool admitted a worker")
except ValueError as error:
    assert "no dedicated non-reviewer identity" in str(error)

module(
    "cwp_dispatch.worker_tools",
    normalize_network_profile=lambda tier, **_: tier,
    resolve_default_network_profile=lambda _, spec: (
        spec["networkProfile"],
        "registry",
    ),
)
module("cwp_dispatch.worker_classes_registry", get_registry_entry=classes.__getitem__)


class AdapterError(Exception):
    pass


scope = dict(
    Mapping=Mapping,
    Any=Any,
    Path=Path,
    AdapterError=AdapterError,
    adapter_subprocess_env=lambda: {"FIRST_TURN_WATCHER_MAX_SECONDS": "960"},
    litellm_route_for_model_id=lambda _: None,
    spawn_marker_for_token=lambda _: None,
    _truthy=bool,
    _adapter_debug_from_config=lambda: False,
)
exec(compile((root / "adapters.py").read_text(), "adapters.py", "exec"), scope)
consume = scope["adapter_subprocess_env_for_payload"]
try:
    consume({**payload, "workerClass": "gemini"})
    raise AssertionError("builder borrowed a reviewer/owner seat")
except AdapterError as error:
    assert "no dedicated non-reviewer identity" in str(error)

spec = classes[payload["workerClass"]]
assert spec["entitlement"] == "foundry-remediator-worker"
assert payload["taskKind"] in spec["supportsTaskKinds"]
assert spec["defaultModel"] in spec["allowedModels"]
assert "bash:git-safe" in spec["toolsAllowlist"]
model_scope = dict(
    json=json,
    os=SimpleNamespace(environ={}),
    GeminiRuntimeError=ValueError,
    ANTIGRAVITY_MODEL_OVERRIDE_ENV="GEMINI_ANTIGRAVITY_MODEL",
    _registry_path=lambda: root / "classes.json",
)
exec(
    compile((root / "gemini_runtime.py").read_text(), "gemini_runtime.py", "exec"),
    model_scope,
)
resolve_model = model_scope["resolve_antigravity_launch_model"]
model = resolve_model(None, False, payload["workerClass"])
assert model == spec["defaultModel"]
assert (
    resolve_model(spec["allowedModels"][-1], True, payload["workerClass"])
    == spec["allowedModels"][-1]
)
try:
    resolve_model(classes["gemini"]["defaultModel"], True, payload["workerClass"])
    raise AssertionError("remediator accepted builder-only CLI model")
except ValueError as error:
    assert "not allow-listed" in str(error)
env = consume({**payload, "workerModel": model})
assert "HQ_AGY_BUILDER_IDENTITY" not in env
assert "AGENT_OS_WORKER_RUN_AS_USER" not in env
assert env["HQ_ADAPTER_DISPATCHED"] == "1"
assert env["HQ_LAUNCH_REQUEST_ID"] == payload["launchRequestId"]
assert env["HQ_WORKER_RUN_ID"] == payload["runId"]
assert env["HQ_WORKER_NETWORK_PROFILE"] == "restricted"
print(
    json.dumps(
        {
            "model": env["HQ_WORKER_MODEL"],
            "entitlement": spec["entitlement"],
            "emptyBuilderPoolRefusesBuilder": True,
            "remediatorAccepted": True,
        }
    )
)
