"""Reviewer transport to the canonical selection and execution-lease owners.

Input/output is secret-free JSON over stdio. Never fetch credentials here.
The deployed Python environment supplies agent_os_core and cwp_dispatch.
"""

import json
from pathlib import Path
import sys
from types import SimpleNamespace


def execute(value):
    from agent_os_core.identity_token_pools import read_identity_token_pools
    from cwp_dispatch.token_pool_admission import BrokerExecutionClient, propose

    client = BrokerExecutionClient()
    operation = value["operation"]
    if operation in {"renew", "release"}:
        return getattr(client, operation)(value["lease"])

    from cwp_dispatch.quota_recovery import QuotaRecoveryMixin
    from cwp_dispatch.quota_reserve import snapshot

    declarations = read_identity_token_pools(value["oauth"])
    daemon = SimpleNamespace(hq_root=Path(value["hqRoot"]))
    daemon._read_quota_status = QuotaRecoveryMixin._read_quota_status.__get__(daemon)
    row = {
        "worker_class": value["identity"],
        "launch_request_id": value["requestId"],
        "task_type": "review",
        "request_payload_json": {"workerModel": value["model"]},
    }
    reserve_state = snapshot(daemon.hq_root)
    proposal = propose(
        daemon, row, reserve_state, declarations=declarations, client=client
    )
    reviewer_reserve_refused = False
    if value["family"] == "claude":
        # Preserve CLC's primary reviewer reserve refusal. The general worker
        # collector exempts non-coding tasks from builder floors; the existing
        # Claude reviewer account selector additionally checks these canonical
        # policy booleans. Keep its stricter primary gate, without recomputing a
        # threshold or refreshing the reserve observation's evidence stamps.
        policy = reserve_state.get("anthropic-oauth", {})
        if policy.get("active") or policy.get("nearCap"):
            for account_id in declarations.pools[value["identity"]]:
                account = declarations.accounts[account_id]
                evidence = proposal.snapshot["accounts"].get(account_id)
                if (
                    account.broker_provider == "claude-code"
                    and evidence
                    and evidence.get("reserve")
                ):
                    if evidence["reserve"].get("state") != "paused":
                        evidence["reserve"]["state"] = "floor-refused"
                        reviewer_reserve_refused = True
    if (
        reviewer_reserve_refused
        or value.get("blockedAccountIds")
        or value.get("unknownCooldownAccountIds")
    ):
        from agent_os_core.identity_token_selection import select_account
        import time

        # Local typed provider exhaustion is account evidence, not a family
        # outage. Other components retain their own freshness/generation.
        for account_id in [
            *value.get("blockedAccountIds", []),
            *value.get("unknownCooldownAccountIds", []),
        ]:
            evidence = proposal.snapshot["accounts"].get(account_id)
            if evidence is not None:
                evidence["quota"] = {
                    "state": "unknown"
                    if account_id in value.get("unknownCooldownAccountIds", [])
                    else "exhausted",
                    "generation": proposal.result.generation,
                    "observed_at": time.time(),
                    "expires_at": time.time() + 30,
                }
        proposal.result = select_account(
            proposal.declarations,
            identity=value["identity"],
            family=value["family"],
            identity_models=proposal.identity_models,
            requested_models=[value["model"]],
            generation=proposal.result.generation,
            now=time.time(),
            snapshot=proposal.snapshot,
        )
    result = proposal.result.to_dict()
    lease = None
    if operation == "acquire" and result["status"] == "selected":
        lease = client.acquire(
            identity=value["identity"],
            account_id=result["account_id"],
            request_id=value["requestId"],
        )
        if lease is None:
            # Reselect from a new owner snapshot on the next dispatch. A CAS
            # loss is capacity pressure, never quota exhaustion or permission
            # to use an unleased account.
            return {"held": "capacity-saturated"}
    return {
        "oauth": value["oauth"],
        "request": {
            "identity": value["identity"],
            "family": value["family"],
            "identity_models": list(proposal.identity_models),
            "requested_models": [value["model"]],
            "generation": result["generation"],
            "now": __import__("time").time(),
            "snapshot": proposal.snapshot,
        },
        "selection": result,
        "lease": lease,
    }


if __name__ == "__main__":
    try:
        print(json.dumps(execute(json.load(sys.stdin)), allow_nan=False))
    except Exception:
        # Dependencies, evidence and broker errors hold admission. Do not echo
        # exception diagnostics: downstream owners may include private values.
        print(json.dumps({"held": "evidence-unknown"}))
