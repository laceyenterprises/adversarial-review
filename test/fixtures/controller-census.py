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

    def test_hamcensuseio_exhaustion_is_distinct_from_invalid_evidence(self):
        for code in (errno.EIO, errno.EINTR):
            sysctl, waits = Sysctl(error=code, result=-1), []
            with self.assertRaises(census.CensusInterrupted) as raised:
                census.group_snapshot(100, sysctl, sleep=waits.append)
            self.assertEqual(sysctl.calls, 3)
            self.assertEqual(waits, [0.01, 0.02])
            self.assertEqual(
                census.error_reply(raised.exception),
                {"error": errno.errorcode[code], "retryable": True, "attempts": 3},
            )
        for sysctl in (
            Sysctl(error=errno.EPERM, result=-1),
            Sysctl(result=-1),
            Sysctl(size=649),
            Sysctl(pgid=99),
        ):
            with self.assertRaises(OSError) as raised:
                census.group_snapshot(100, sysctl, sleep=lambda _: self.fail("retry"))
            self.assertEqual(sysctl.calls, 1)
            self.assertNotIn("retryable", census.error_reply(raised.exception))

    def test_hamcensuseio_churn_does_not_reset_interruption_budget(self):
        errors = iter([errno.EIO, errno.ENOMEM, errno.EINTR, errno.ENOMEM, errno.EIO])
        calls = []

        def churn(*args):
            calls.append(len(args[2]))
            ctypes.set_errno(next(errors))
            return -1

        with self.assertRaises(census.CensusInterrupted):
            census.group_snapshot(100, churn, sleep=lambda _: None)
        self.assertEqual(calls, [64, 64, 1024, 1024, 16384])

    def test_hamcensuseio_retry_does_not_relax_snapshot_validation(self):
        for bad in (
            Sysctl(size=649),
            Sysctl(pgid=99),
            Sysctl(enomem=99),
            Sysctl(error=errno.EPERM, result=-1),
            Sysctl(result=-1),
        ):
            calls = []

            def interrupted(*args):
                calls.append(1)
                if len(calls) == 1:
                    ctypes.set_errno(errno.EIO)
                    return -1
                return bad(*args)

            with self.assertRaises(OSError) as raised:
                census.group_snapshot(100, interrupted, sleep=lambda _: None)
            self.assertNotIsInstance(raised.exception, census.CensusInterrupted)
            self.assertNotIn("retryable", census.error_reply(raised.exception))
            self.assertEqual(len(calls), 5 if bad.enomem else 2)

    def test_hamcensuseio_serve_preserves_exhaustion_without_replaying_data(self):
        replies = io.StringIO()
        sysctl = Sysctl(error=errno.EIO, result=-1)
        with mock.patch.object(census.sys, "platform", "darwin"):
            census.serve(["group 100\n"] * 2, replies, sysctl=sysctl)
        self.assertEqual(
            [json.loads(line) for line in replies.getvalue().splitlines()],
            [{"error": "EIO", "retryable": True, "attempts": 3}] * 2,
        )
        self.assertEqual(sysctl.calls, 6)

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
