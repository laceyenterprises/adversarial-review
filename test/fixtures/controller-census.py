"""Offline kern.proc.pgrp fixtures: unknown, truncated or inconsistent never become empty."""

import ctypes
import errno
import importlib.util
from pathlib import Path
import unittest

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


unittest.main()
