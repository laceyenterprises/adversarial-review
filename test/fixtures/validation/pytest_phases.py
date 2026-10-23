"""Explicit integration fixture for hammer-validate; no ledger/network access."""

import os


def test_local_runtime_preserves_explicit_test_routing():
    expected = {
        "AGENT_OS_SESSION_LEDGER_BACKEND": "sqlite",
        "AGENT_OS_SESSION_LEDGER_VDB": "false",
        "AGENT_OS_SESSION_LEDGER_POSTGRES_RUNTIME": "off",
        "AGENT_OS_SESSION_LEDGER_TEST_DSN": "fixture-disposable",
        "AGENT_OS_TEST_ALLOW_PG": "1",
    }
    mismatches = [
        key for key, value in expected.items() if os.environ.get(key) != value
    ]
    assert not mismatches
    live_dsn_present = "AGENT_OS_SESSION_LEDGER_DSN" in os.environ
    assert not live_dsn_present
    print("captured test output does not hide supervisor phase evidence")


def test_real_failure_remains_nonzero():
    should_fail = os.environ.get("HAM_VALIDATION_FIXTURE_FAIL") == "1"
    assert not should_fail, "intentional fixture failure"
