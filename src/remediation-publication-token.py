"""Resolve a repository's publication token through the GitHub adapter."""

import json
import re
import sys

from agent_os_github_adapter.auth import (
    AuthResolutionError,
    UrlLibBrokerClient,
    github_token_for_repo,
)
from cwp_dispatch.broker_fetch_gate import BrokerFetchGateTimeout, broker_fetch_gate


class PublicationBrokerClient(UrlLibBrokerClient):
    """Retain grant evidence that the adapter's identity envelope omits."""

    def __init__(self, expected_provider):
        super().__init__()
        self.expected_provider = expected_provider
        self.metadata = {}

    def fetch_token(self, *, provider, **kwargs):
        if provider != self.expected_provider:
            raise AuthResolutionError("broker provider mismatch")
        body = super().fetch_token(provider=provider, **kwargs)
        metadata = body.get("metadata")
        self.metadata = metadata if isinstance(metadata, dict) else {}
        # The current installation response proves its owner through GitHub
        # and may omit credential_source. An explicit fallback never qualifies.
        if self.metadata.get("credential_source") not in (
            None,
            "github_app_installation",
        ):
            raise AuthResolutionError(
                "unexpected credential source", code="publication-credential-source"
            )
        return body


def matches_github_slug(value, expected):
    return isinstance(value, str) and value.isascii() and value.lower() == expected.lower()


def resolve(repo, role, provider, capability):
    client = PublicationBrokerClient(provider)
    try:
        result = github_token_for_repo(
            repo, role, broker_client=client, use_cache=False
        )
    except AuthResolutionError as error:
        checks = {
            "github-app-owner-not-configured": "owner not configured",
            "github-app-id-not-configured": "App id not configured",
            "github-app-id-mismatch": "App id mismatch",
            "github-installation-owner-mismatch": "installation owner mismatch",
            "github-installation-id-mismatch": "installation mismatch",
            "broker-unreachable": "broker unreachable",
            "publication-credential-source": "broker returned a non-installation credential",
        }
        status = re.match(r"broker returned HTTP ([1-5]\d\d)\b", str(error))
        if str(error).startswith("broker provider mismatch"):
            return {"check": "provider mismatch"}
        return {
            "check": checks.get(error.code)
            or (f"mint refused (HTTP {status[1]})" if status else "mint refused")
        }

    identity = result.metadata
    grant = client.metadata
    owner = repo.split("/", 1)[0]
    if identity.get("provider") != provider:
        return {"check": "provider mismatch"}
    if not (
        matches_github_slug(identity.get("repo"), repo)
        and matches_github_slug(grant.get("repo", repo), repo)
    ):
        return {"check": "repository mismatch"}
    if not (
        matches_github_slug(identity.get("installation_owner"), owner)
        and matches_github_slug(grant.get("owner", owner), owner)
    ):
        return {"check": "installation owner mismatch"}
    if not re.fullmatch(r"[1-9][0-9]*", str(identity.get("app_id", ""))):
        return {"check": "App id missing or invalid"}
    if not re.fullmatch(r"[1-9][0-9]*", str(identity.get("installation_id", ""))):
        return {"check": "installation identity missing"}
    permissions = grant.get("permissions")
    if not isinstance(permissions, dict):
        return {"check": "broker reported no token permissions"}
    if permissions.get("contents") != "write":
        return {"check": "missing contents:write"}
    if capability == "workflow" and permissions.get("workflows") != "write":
        return {"check": "missing workflows:write"}
    return {"token": result.token, "expires_at": identity.get("expires_at")}


if __name__ == "__main__":
    role, repo, provider, capability = sys.argv[1:]
    try:
        with broker_fetch_gate(label=f"github-app:{role}"):
            response = resolve(repo, role, provider, capability)
    except BrokerFetchGateTimeout:
        response = {"check": "broker fetch gate unavailable"}
    print(json.dumps(response))
