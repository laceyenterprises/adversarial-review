"""Offline kern.proc.pgrp fixtures: unknown, truncated or inconsistent never become empty."""

import ctypes
import errno
import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location(
    "census", Path(__file__).resolve().parents[2] / "src/controller_process_census.py"
)
census = importlib.util.module_from_spec(spec)
spec.loader.exec_module(census)

# Legacy ps rows for the same group: "100 100 S Sat Oct 24 08:00:00 2026",
# "101 100 S Sat Oct 24 08:01:00 2026" and "102 100 Z ..." (excluded).
GROUP = [(100, 2, 1792828800, 0), (101, 2, 1792828860, 250000), (102, 5, 1792828920, 0)]


class Sysctl:
    """Kernel-filtered group 100: live leader, live child and a zombie."""

    def __init__(self, records=GROUP, error=0, result=0, enomem=0, size=None, pgid=100):
        self.records, self.error, self.result = records, error, result
        self.enomem, self.size, self.pgid, self.calls = enomem, size, pgid, 0

    def __call__(self, mib, count, buffer, sizep, new, newlen):
        assert (
            list(mib) == [1, 14, 2, 100] and count == 4 and new is None and newlen == 0
        )
        self.calls += 1
        if self.calls <= self.enomem:
            ctypes.set_errno(errno.ENOMEM)
            return -1
        ctypes.set_errno(self.error)
        for index, (pid, stat, sec, usec) in enumerate(self.records):
            buffer[index].pid, buffer[index].stat = pid, stat
            buffer[index].start_sec, buffer[index].start_usec = sec, usec
            buffer[index].pgid = self.pgid
        record = ctypes.sizeof(census.KinfoProc)
        sizep._obj.value = (
            len(self.records) * record if self.size is None else self.size
        )
        return self.result


class CensusTests(unittest.TestCase):
    def test_hamcensuseio_interruption_retries_a_fresh_complete_snapshot(self):
        for code in (errno.EIO, errno.EINTR):
            with self.subTest(code=code):
                reads, waits = [], []
                good = Sysctl()

                def interrupted(*args):
                    reads.append(args[2])
                    if len(reads) < 3:
                        # Failed syscalls may have written partial output.
                        args[2][0].pid = 999
                        ctypes.set_errno(code)
                        return -1
                    return good(*args)

                result = census.group_snapshot(100, interrupted, sleep=waits.append)
                self.assertEqual([row["pid"] for row in result], [100, 101])
                self.assertEqual(len(reads), 3)
                self.assertIsNot(reads[0], reads[1])
                self.assertEqual(waits, [0.01, 0.02])

    def setUp(self):
        original = census.group_snapshot
        clock = [0.0]

        def snapshot(*args, **kwargs):
            sleep = kwargs.pop("sleep", lambda _: None)

            def advance(seconds):
                clock[0] += seconds
                sleep(seconds)

            return original(
                *args, **kwargs, sleep=advance, now=lambda: clock[0], budget_ms=2000
            )

        patch = mock.patch.object(census, "group_snapshot", snapshot)
        patch.start()
        self.addCleanup(patch.stop)

    def test_persistent_failure_exhausts_time_budget_with_metadata(self):
        for code in (errno.EIO, errno.EINTR):
            sysctl, waits = Sysctl(error=code, result=-1), []
            with self.assertRaises(census.CensusInterrupted) as raised:
                census.group_snapshot(100, sysctl, sleep=waits.append)
            reply = census.error_reply(raised.exception)
            self.assertEqual(reply["error"], errno.errorcode[code])
            self.assertTrue(reply["retryable"])
            self.assertEqual(reply["attempts"], sysctl.calls)
            self.assertGreater(sysctl.calls, 3)
            self.assertEqual(reply["elapsedMs"], 2000)
            self.assertAlmostEqual(sum(waits), 2)
            self.assertLessEqual(max(waits), 0.2)

    def test_embryonic_or_moving_record_requires_a_clean_reread(self):
        for bad in (Sysctl(pgid=99), Sysctl(records=[(100, 2, 0, 0)])):
            good = Sysctl()
            calls = []

            def changing(*args):
                calls.append(1)
                return (bad if len(calls) == 1 else good)(*args)

            self.assertEqual(len(census.group_snapshot(100, changing)), 2)
            self.assertEqual(len(calls), 2)

    def test_persistent_inconsistency_has_the_same_bounded_retry(self):
        for sysctl in (Sysctl(pgid=99), Sysctl(records=[(100, 2, 0, 0)])):
            with self.assertRaises(census.CensusInterrupted) as raised:
                census.group_snapshot(100, sysctl)
            self.assertEqual(census.error_reply(raised.exception)["elapsedMs"], 2000)

    def test_invalid_evidence_and_permission_denial_refuse_immediately(self):
        for sysctl in (
            Sysctl(error=errno.EPERM, result=-1),
            Sysctl(result=-1),
            Sysctl(size=649),
        ):
            with self.assertRaises(OSError) as raised:
                census.group_snapshot(100, sysctl, sleep=lambda _: self.fail("retry"))
            self.assertEqual(sysctl.calls, 1)
            self.assertNotIn("retryable", census.error_reply(raised.exception))

    def test_churn_does_not_reset_deadline_during_buffer_growth(self):
        errors = iter([errno.EIO, errno.ENOMEM, errno.EINTR, errno.ENOMEM])
        calls = []

        def churn(*args):
            calls.append(len(args[2]))
            ctypes.set_errno(next(errors, errno.EIO))
            return -1

        with self.assertRaises(census.CensusInterrupted) as raised:
            census.group_snapshot(100, churn)
        self.assertEqual(calls[:5], [64, 64, 1024, 1024, 16384])
        self.assertEqual(census.error_reply(raised.exception)["elapsedMs"], 2000)

    def test_serve_preserves_exhaustion_without_replaying_data(self):
        replies = io.StringIO()
        sysctl = Sysctl(error=errno.EIO, result=-1)
        with mock.patch.object(census.sys, "platform", "darwin"):
            census.serve(["group 100\n"] * 2, replies, sysctl=sysctl)
        answers = [json.loads(line) for line in replies.getvalue().splitlines()]
        for answer in answers:
            self.assertEqual(answer["error"], "EIO")
            self.assertTrue(answer["retryable"])
            self.assertEqual(answer["elapsedMs"], 2000)
        self.assertEqual(sysctl.calls, sum(answer["attempts"] for answer in answers))

    def test_caller_budget_is_bounded_and_standalone_default_is_nominal(self):
        for raw, expected in (
            ("12000", 12000),
            ("999999", 40000),
            ("0", 1),
            ("invalid", 2000),
        ):
            with mock.patch.dict(census.os.environ, HAM_CENSUS_RETRY_BUDGET_MS=raw):
                self.assertEqual(census.retry_budget_ms(), expected)

    def test_kinfo_proc_abi(self):
        self.assertEqual(ctypes.sizeof(census.KinfoProc), 648)
        offsets = {
            name: getattr(census.KinfoProc, name).offset
            for name in ("start_sec", "stat", "pid", "pgid")
        }
        self.assertEqual(offsets, {"start_sec": 0, "stat": 36, "pid": 40, "pgid": 564})

    def test_group_members_and_births_match_legacy_ps_rows(self):
        self.assertEqual(
            census.group_snapshot(100, Sysctl()),
            [
                {"pid": 100, "birth": "1792828800.000000"},
                {"pid": 101, "birth": "1792828860.250000"},
            ],
        )

    def test_empty_and_zombie_only(self):
        self.assertEqual(census.group_snapshot(100, Sysctl(records=[])), [])
        self.assertEqual(census.group_snapshot(100, Sysctl(records=GROUP[2:])), [])

    def test_truncation_grows_then_bounds(self):
        sysctl = Sysctl(enomem=1)
        self.assertEqual(len(census.group_snapshot(100, sysctl)), 2)
        self.assertEqual(sysctl.calls, 2)
        with self.assertRaises(OSError) as raised:
            census.group_snapshot(100, Sysctl(enomem=99))
        self.assertEqual(raised.exception.errno, errno.EOVERFLOW)

    def test_unknown_never_becomes_empty(self):
        record = ctypes.sizeof(census.KinfoProc)
        for label, sysctl, code in (
            ("denied", Sysctl(error=errno.EPERM, result=-1), errno.EPERM),
            ("silent failure", Sysctl(result=-1), errno.EIO),
            ("misaligned", Sysctl(size=record + 1), errno.EIO),
            ("overlong", Sysctl(size=64 * record + record), errno.EIO),
            ("foreign group", Sysctl(pgid=99), errno.EIO),
            ("no birth", Sysctl(records=[(100, 2, 0, 0)]), errno.EIO),
            ("bad usec", Sysctl(records=[(100, 2, 1, 1_000_000)]), errno.EIO),
            ("bad pid", Sysctl(records=[(0, 2, 1, 0)]), errno.EIO),
        ):
            with self.subTest(label=label):
                with self.assertRaises(OSError) as raised:
                    census.group_snapshot(100, sysctl)
                self.assertEqual(raised.exception.errno, code)

    def test_serve_rereads_every_request_and_never_replays_an_answer(self):
        class Changing(Sysctl):
            def __call__(self, *args):
                self.records = [GROUP[:1], GROUP[:2], []][self.calls]
                return super().__call__(*args)

        sysctl, replies = Changing(), io.StringIO()
        with mock.patch.object(census.sys, "platform", "darwin"):
            census.serve(["group 100\n"] * 3, replies, sysctl=sysctl)
        answers = [json.loads(line)["ok"] for line in replies.getvalue().splitlines()]
        self.assertEqual([len(answer) for answer in answers], [1, 2, 0])
        self.assertEqual(sysctl.calls, 3)

    def test_serve_reports_refusals_and_invalid_requests_by_errno_name(self):
        replies = io.StringIO()
        census.serve(
            ["pgid 1\n", "bogus\n", "pgid 2147483646\n", "unsupported 42\n"], replies
        )
        self.assertEqual(
            [json.loads(line) for line in replies.getvalue().splitlines()],
            [
                {"error": "EINVAL"},
                {"error": "EINVAL"},
                {"error": "ESRCH"},
                {"error": "EINVAL"},
            ],
        )

    def test_serve_reports_a_denied_group_census_without_ending(self):
        replies = io.StringIO()
        with mock.patch.object(census.sys, "platform", "darwin"):
            census.serve(
                ["group 100\n", "group 100\n"],
                replies,
                sysctl=Sysctl(error=errno.EPERM, result=-1),
            )
        self.assertEqual(
            [json.loads(line) for line in replies.getvalue().splitlines()],
            [{"error": "EPERM"}, {"error": "EPERM"}],
        )


unittest.main()
