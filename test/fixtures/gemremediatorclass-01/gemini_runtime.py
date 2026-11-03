def resolve_antigravity_launch_model(
    model: str | None, explicit: bool, worker_class: str = "gemini"
) -> str:
    """Resolve dispatch pins and defaults against the dispatched class."""
    if worker_class == "gemini":
        allowed = _registry_antigravity_models()
        default = resolve_antigravity_gemini_model()
    else:
        try:
            entry = json.loads(_registry_path().read_text(encoding="utf-8"))[worker_class]
            allowed = entry["allowedModels"]
            default = entry["defaultModel"]
        except (OSError, ValueError, KeyError, TypeError) as exc:
            raise GeminiRuntimeError(
                f"Antigravity class {worker_class!r} lacks model policy"
            ) from exc
        if (
            not isinstance(allowed, list)
            or not allowed
            or not all(isinstance(item, str) and item for item in allowed)
            or not isinstance(default, str)
            or default not in allowed
        ):
            raise GeminiRuntimeError(f"Antigravity class {worker_class!r} has invalid model policy")
        override = os.environ.get(ANTIGRAVITY_MODEL_OVERRIDE_ENV, "").strip()
        if override in allowed:
            default = override
    if explicit:
        model = (model or "").strip()
        if model not in allowed:
            raise GeminiRuntimeError(f"Antigravity model {model!r} is not allow-listed")
        return model
    return default
