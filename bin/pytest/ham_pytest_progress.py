"""Emit real pytest phase boundaries even with quiet/captured test output."""

import sys


def _progress(phase, detail=""):
    # Bypass pytest's per-test capture; these hooks are supervisor evidence.
    suffix = f" {detail}" if detail else ""
    print(f"HAM pytest: {phase}{suffix}", file=sys.__stderr__, flush=True)


_progress("plugin-loaded")


def pytest_sessionstart(session):
    _progress("session-start")


def pytest_collectstart(collector):
    _progress("collect", collector.nodeid)


def pytest_collection_finish(session):
    _progress("collected", str(len(session.items)))


def pytest_runtest_logstart(nodeid, location):
    _progress("test-start", nodeid)


def pytest_runtest_logreport(report):
    _progress(f"{report.when}:{report.outcome}", report.nodeid)


def pytest_sessionfinish(session, exitstatus):
    _progress("session-finish", str(exitstatus))
