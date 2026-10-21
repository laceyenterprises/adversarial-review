"""Opt-in offline owner integration: python3 -I -B this_file <agent-os workspace>.

Use the real canonical reducer and injected broker/collector. Never construct a
live broker client, read live quota/config/registry, or contact a provider.
"""

import copy
import importlib.util
import json
from pathlib import Path
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch

repo = Path(__file__).resolve().parents[1]
owner = Path(sys.argv.pop()).resolve()
sys.path[:0] = [
    str(owner / "platform/agent-os-config/src"),
    str(owner / "modules/worker-pool/lib/python"),
    str(owner / "modules/quota-probe/lib/python"),
    str(owner / "platform/session-ledger/src"),
]
from agent_os_core.identity_token_pools import read_identity_token_pools  # noqa: E402
from agent_os_core.identity_token_selection import select_account  # noqa: E402

spec = importlib.util.spec_from_file_location(
    "reviewer_token_owner", repo / "src/adapters/reviewer-runtime/token-pool-owner.py"
)
transport = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transport)
vectors = json.loads(
    (repo / "test/fixtures/identity-token-selection.v1.json").read_text()
)


def merge(base, change):
    result = copy.deepcopy(base)
    for key, item in change.items():
        result[key] = (
            merge(result[key], item)
            if isinstance(item, dict) and isinstance(result.get(key), dict)
            else copy.deepcopy(item)
        )
    return result


class Broker:
    def __init__(self):
        self.operations = []
        self.saturated = False

    def acquire(self, **request):
        self.operations.append(("acquire", request))
        return None if self.saturated else {"account_id": request["account_id"]}

    def renew(self, receipt):
        self.operations.append(("renew", receipt))
        return receipt

    def release(self, receipt):
        self.operations.append(("release", receipt))
        return receipt


class OwnerIntegration(unittest.TestCase):
    def run_case(
        self,
        family,
        suffix,
        *,
        saturated=False,
        blocked=None,
        reserve=None,
        unknown=None,
    ):
        vector = next(
            v for v in vectors["cases"] if v["name"] == f"{family}-reviewer-{suffix}"
        )
        inputs = merge(vectors["defaults"], vector.get("patch", {}))
        # Real wall-clock evidence, without stale fixture timestamps.
        import time

        now = time.time()
        inputs["request"]["now"] = now
        for account in inputs["request"]["snapshot"]["accounts"].values():
            for observation in account.values():
                if isinstance(observation, dict):
                    observation["observed_at"] = now - 1
                    observation["expires_at"] = now + 100
        broker = Broker()
        broker.saturated = saturated

        def propose(daemon, row, reserve, *, declarations, client):
            self.assertEqual(row["worker_class"], f"{family}-reviewer")
            self.assertEqual(row["task_type"], "review")
            self.assertEqual(
                row["request_payload_json"]["workerModel"],
                inputs["request"]["requested_models"][0],
            )
            return SimpleNamespace(
                declarations=declarations,
                identity_models=tuple(inputs["request"]["identity_models"]),
                snapshot=inputs["request"]["snapshot"],
                result=select_account(declarations, **inputs["request"]),
            )

        with (
            patch(
                "cwp_dispatch.token_pool_admission.BrokerExecutionClient",
                return_value=broker,
            ),
            patch("cwp_dispatch.token_pool_admission.propose", side_effect=propose),
            patch("cwp_dispatch.quota_reserve.snapshot", return_value=reserve or {}),
        ):
            result = transport.execute(
                {
                    "operation": "acquire",
                    "oauth": inputs["oauth"],
                    "identity": f"{family}-reviewer",
                    "family": family,
                    "model": inputs["request"]["requested_models"][0],
                    "hqRoot": str(repo),
                    "requestId": "synthetic-session",
                    "blockedAccountIds": blocked or [],
                    "unknownCooldownAccountIds": unknown or [],
                }
            )
        return result, broker, inputs

    def test_real_shared_selection_for_both_reviewer_families(self):
        for family in ("claude", "codex"):
            for suffix in (
                "declared-preference",
                "quota-exhausted",
                "not-ready",
                "reserve-refused",
                "model-denied",
                "capacity-saturated",
                "preferred-unknown",
            ):
                with self.subTest(family=family, suffix=suffix):
                    result, broker, inputs = self.run_case(family, suffix)
                    expected = select_account(
                        read_identity_token_pools(inputs["oauth"]), **inputs["request"]
                    ).to_dict()
                    self.assertEqual(result["selection"], expected)
                    self.assertEqual(
                        len(broker.operations), int(expected["status"] == "selected")
                    )

    def test_cas_loss_holds_without_an_unleased_fallback(self):
        for family in ("claude", "codex"):
            result, broker, _ = self.run_case(
                family, "declared-preference", saturated=True
            )
            self.assertEqual(result, {"held": "capacity-saturated"})
            self.assertEqual(len(broker.operations), 1)

    def test_typed_account_cooldown_reuses_the_shared_reducer(self):
        for family, account in (
            ("claude", "anthropic-corporate"),
            ("codex", "openai-corporate"),
        ):
            result, _, _ = self.run_case(
                family, "declared-preference", blocked=[account]
            )
            self.assertEqual(result["selection"]["reason"], "fallback-ready")
            self.assertNotEqual(result["selection"]["account_id"], account)

    def test_renew_and_release_do_not_call_selection(self):
        broker = Broker()
        receipt = {
            "account_id": "openai-primary",
            "lease_id": "fixture",
            "generation": 9,
        }
        with patch(
            "cwp_dispatch.token_pool_admission.BrokerExecutionClient",
            return_value=broker,
        ):
            for operation in ("renew", "release"):
                self.assertEqual(
                    transport.execute({"operation": operation, "lease": receipt}),
                    receipt,
                )
        self.assertEqual(broker.operations, [("renew", receipt), ("release", receipt)])

    def test_claude_primary_reserve_is_not_bypassed_by_worker_task_exemption(self):
        for flag in ("active", "nearCap"):
            result, broker, _ = self.run_case(
                "claude", "quota-exhausted", reserve={"anthropic-oauth": {flag: True}}
            )
            self.assertEqual(result["selection"]["status"], "unavailable")
            self.assertEqual(
                result["selection"]["considered"][-1]["reason"], "reserve-refused"
            )
            self.assertEqual(broker.operations, [])

    def test_corrupt_local_cooldown_is_unknown_not_exhaustion(self):
        result, broker, _ = self.run_case(
            "codex", "declared-preference", unknown=["openai-corporate"]
        )
        self.assertEqual(result["selection"]["reason"], "evidence-unknown")
        self.assertEqual(broker.operations, [])


if __name__ == "__main__":
    unittest.main()
