def builder_identities(
    hq_root: Path,
    *,
    config: Any = None,
    accounts: Any = pwd,
) -> list[str]:
    """Return existing, non-reviewer OS identities in operator-configured order.

    Compare UIDs as well as names: aliases must not lend a reviewer's keychain.
    Unknown reviewer users or unreadable configuration fail closed.
    """
    if config is None:
        from cwp_dispatch.agent_os_config_helper import get_config_runtime

        config = get_config_runtime()
    from agent_os_config.token_pool_declarations import DECLARATION_KEYS
    from agent_os_core.identity_token_pools import read_identity_token_pools
    from cwp_dispatch.paths import hq_owner

    configured = config.get("worker_pool.gemini.builder_identities") or []
    reviewers = config.get("reviewer.gemini.identities") or []
    declarations = read_identity_token_pools(
        {key: config.get("oauth." + key) or {} for key in DECLARATION_KEYS}
    )
    pooled_reviewers = {
        declarations.accounts[member].holder_user
        for member in declarations.pools.get("gemini-reviewer", ())
    }
    declared_owner = hq_owner(hq_root)
    # Readiness records also cover seats supplied to the reviewer service by
    # its own environment. They stay reserved even if this process cannot see
    # that service's config override.
    reviewers = {
        *reviewers,
        *(name for name in pooled_reviewers if name),
        *([declared_owner] if declared_owner else []),
        *(path.stem for path in (hq_root / "state/agy-reviewer-identities").glob("*.json")),
    }
    # The reviewer service's implicit holder is its process user. Also protect
    # custody of HQ files even when an installation uses a different ownerUser.
    reserved_uids = {0, os.geteuid(), hq_root.stat().st_uid}
    reserved_names = {"root", *reviewers}
    for name in reviewers:
        reserved_uids.add(accounts.getpwnam(name).pw_uid)
    result = []
    for name in configured:
        if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_-]{0,63}", name):
            raise ValueError("invalid Antigravity builder OS identity")
        account = accounts.getpwnam(name)
        if name in reserved_names or account.pw_uid in reserved_uids:
            raise ValueError(f"Antigravity builder identity {name!r} is a reserved reviewer seat")
        if name not in result:
            result.append(name)
    return result


def admission_identity(hq_root: Path) -> str | None:
    """Empty, invalid or unprovisioned pools are inert, never an owner fallback."""
    try:
        for identity in builder_identities(hq_root):
            if identity_ready(identity):
                return identity
        return None
    except (OSError, KeyError, TypeError, ValueError):
        return None


def identity_ready(identity: str) -> bool:
    """Check a dedicated seat's lock and keychain metadata under its own UID."""
    account = pwd.getpwnam(identity)
    try:
        result = subprocess.run(
            [
                "/usr/bin/sudo",
                "-n",
                "-H",
                "-u",
                identity,
                "/usr/bin/env",
                "-i",
                f"HOME={account.pw_dir}",
                "PATH=/usr/bin:/bin",
                sys.executable,
                "-I",
                str(Path(__file__).resolve()),
                "--identity",
                identity,
                "--check-ready",
            ],
            capture_output=True,
            timeout=8,
            check=False,
        )
        return result.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def launch_environment(hq_root: Path) -> dict[str, str]:
    identity = admission_identity(hq_root)
    if identity is None:
        raise ValueError("Antigravity builder has no dedicated non-reviewer identity")
    return {
        "AGENT_OS_WORKER_RUN_AS_USER": identity,
        "HQ_AGY_BUILDER_IDENTITY": identity,
    }
