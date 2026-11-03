def adapter_subprocess_env_for_payload(payload: Mapping[str, Any]) -> dict[str, str]:
    child_env = adapter_subprocess_env()
    # Bind before the adapter stages files or crosses its existing UID boundary.
    # No ambient HQ-owner/reviewer keychain is an eligible builder fallback.
    if payload.get("workerClass") == "gemini":
        from cwp_dispatch.agy_builder import launch_environment
        from cwp_dispatch.agent_os_config_helper import resolve_hq_root_default

        try:
            child_env.update(launch_environment(Path(resolve_hq_root_default())))
        except ValueError as exc:
            raise AdapterError(str(exc)) from exc
    # Per-launch facts must not depend on a later worker-directory read or on
    # identity accidentally inherited from the daemon's own launch.
    provenance = payload.get("launchProvenance") or {}
    child_env["HQ_ADAPTER_DISPATCHED"] = "1"
    child_env["HQ_LAUNCH_REQUEST_ID"] = str(
        payload.get("launchRequestId") or provenance.get("launchRequestId") or ""
    )
    child_env["HQ_WORKER_RUN_ID"] = str(payload.get("runId") or provenance.get("workerRunId") or "")
    # Pin the dispatch-resolved policy in the owner environment, independently
    # of env assignments the adapter later grants to the downgraded payload.
    from cwp_dispatch.worker_tools import normalize_network_profile, resolve_default_network_profile
    from cwp_dispatch.worker_classes_registry import get_registry_entry

    child_env.pop("HQ_WORKER_NETWORK_PROFILE", None)
    network = (
        payload.get("networkProfile")
        or (payload.get("launchProvenance") or {}).get("networkProfile")
        or {}
    )
    spec = payload.get("workerSpec") or {}
    tier = (network.get("tier") if isinstance(network, Mapping) else network) or spec.get(
        "networkProfile"
    )
    if tier is None and payload.get("workerClass"):
        worker_class = str(payload["workerClass"])
        tier, _ = resolve_default_network_profile(worker_class, get_registry_entry(worker_class))
    if tier is not None:
        child_env["HQ_WORKER_NETWORK_PROFILE"] = normalize_network_profile(
            tier, field="networkProfile.tier"
        )
    # The provisioned workspace contract identifies the worker directory; do
    # not create temp storage here: adapters run under their own UID.
    workspace = payload.get("workspacePath")
    worker_id = payload.get("workerId")
    if isinstance(workspace, str) and isinstance(worker_id, str):
        workspace_path = Path(workspace)
        if workspace_path.is_absolute() and workspace_path.parent.name == worker_id:
            scratch = workspace_path.parent / "scratch"
            child_env["WORKER_SCRATCH_DIR"] = str(scratch)
    if not child_env.get("FIRST_TURN_WATCHER_MAX_SECONDS"):
        # The watcher must outlive the resolved first-sign-of-life window.
        # Resolve through the same CFG/env contract as the daemon watchdog.
        from cwp_dispatch.agent_os_config_helper import worker_pool_cfg_int_value_runtime

        raw_timeout = child_env.get("HQ_DISPATCH_FIRST_SIGN_OF_LIFE_TIMEOUT_SECONDS")
        if raw_timeout is None:
            first_sign_of_life_seconds = worker_pool_cfg_int_value_runtime(
                "dispatch.first_sign_of_life_timeout_seconds", default=900, lo=0, hi=7200
            )
        else:
            try:
                first_sign_of_life_seconds = int(raw_timeout)
            except ValueError:
                first_sign_of_life_seconds = 900
            if not 0 <= first_sign_of_life_seconds <= 7200:
                first_sign_of_life_seconds = 900
        if 0 < first_sign_of_life_seconds < 60:
            first_sign_of_life_seconds = 900
        # A disabled FSOL watchdog still permits the watcher to run to the
        # maximum configured window while the adapter parent remains alive.
        child_env["FIRST_TURN_WATCHER_MAX_SECONDS"] = str((first_sign_of_life_seconds or 7200) + 60)
    worker_spec = payload.get("workerSpec")
    model = payload.get("workerModel") or (
        worker_spec.get("model") if isinstance(worker_spec, Mapping) else None
    )
    model = model if isinstance(model, str) else ""
    child_env["HQ_WORKER_MODEL"] = model
    # New normalized requests retain whether the model was explicitly selected.
    # Legacy payloads preserve their previous override behavior.
    explicit = (
        worker_spec.get("modelExplicit", bool(model))
        if isinstance(worker_spec, Mapping)
        else bool(model)
    )
    child_env["HQ_WORKER_MODEL_EXPLICIT"] = "1" if explicit is True else "0"
    child_env["HQ_WORKER_MODEL_SOURCE"] = (
        "mes"
        if isinstance(worker_spec, Mapping) and worker_spec.get("modelSource") == "mes"
        else ""
    )
    child_env["AGENT_OS_WORKER_LITELLM_ROUTE"] = litellm_route_for_model_id(model) or ""
    launch_request_id = str(payload.get("launchRequestId") or "").strip()
    if launch_request_id:
        child_env["AGENT_OS_WORKER_LRQ_ID"] = launch_request_id
    spawn_marker = spawn_marker_for_token(str(payload.get("spawnToken") or ""))
    if launch_request_id and spawn_marker:
        child_env[WORKER_SPAWN_MARKER_ENV] = spawn_marker
    if _truthy(payload.get("adapterDebugVerbose")):
        child_env["AGENT_OS_ADAPTER_DEBUG"] = "1"
    elif "AGENT_OS_ADAPTER_DEBUG" not in child_env and _adapter_debug_from_config():
        child_env["AGENT_OS_ADAPTER_DEBUG"] = "1"
    return child_env
