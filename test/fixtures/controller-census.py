"""Offline libproc fixtures, including denial indistinguishable from empty."""

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


class Lib:
    error = 0
    size = 4
    count = 136
    pid = 42
    pgid = 42
    status = 2
    birth = 123
    read_error = 0

    def proc_listpids(self, kind, pgid, pids, size):
        assert kind == 2 and pgid == 42
        ctypes.set_errno(self.error)
        pids[0] = self.pid
        return size if self.size == "full" else self.size

    def proc_pidinfo(self, pid, kind, arg, pointer, size):
        assert pid == 42 and kind == 3 and arg == 0 and size == 136
        info = pointer._obj
        info.pid, info.pgid, info.status, info.start_sec = (
            self.pid,
            self.pgid,
            self.status,
            self.birth,
        )
        info.start_usec = 1
        ctypes.set_errno(self.read_error)
        return self.count


class CensusTests(unittest.TestCase):
    def test_positive_birth_and_group(self):
        self.assertEqual(ctypes.sizeof(census.ProcBsdInfo), 136)
        self.assertEqual(
            census.group_snapshot(42, Lib()), [{"pid": 42, "birth": "123.000001"}]
        )

    def test_empty_and_zombie(self):
        lib = Lib()
        lib.size = 0
        self.assertEqual(census.group_snapshot(42, lib), [])
        lib.size, lib.status = 4, 5
        self.assertEqual(census.group_snapshot(42, lib), [])
        lib.count, lib.read_error = 0, errno.ESRCH
        self.assertEqual(census.group_snapshot(42, lib), [])

    def test_unknown_never_becomes_empty(self):
        for field, value in (
            ("error", errno.EPERM),
            ("size", -1),
            ("size", 3),
            ("size", "full"),
            ("count", 0),
            ("count", 135),
            ("read_error", errno.EPERM),
            ("pgid", 99),
            ("birth", 0),
        ):
            with self.subTest(field=field, value=value):
                lib = Lib()
                setattr(lib, field, value)
                with self.assertRaises(OSError):
                    census.group_snapshot(42, lib)
        lib = Lib()
        lib.size, lib.error = 0, errno.EPERM
        with self.assertRaises(OSError):
            census.group_snapshot(42, lib)


unittest.main()
