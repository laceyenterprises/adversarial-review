"""Read-only Darwin controller identities; no argv, environment or ledger access."""

import ctypes
import errno
import json
import os
import sys


class ProcBsdInfo(ctypes.Structure):
    """Darwin <sys/proc_info.h> proc_bsdinfo, stable 136-byte ABI."""

    _fields_ = [
        (name, ctypes.c_uint32)
        for name in (
            "flags",
            "status",
            "xstatus",
            "pid",
            "ppid",
            "uid",
            "gid",
            "ruid",
            "rgid",
            "svuid",
            "svgid",
            "rfu",
        )
    ] + [
        ("comm", ctypes.c_char * 16),
        ("name", ctypes.c_char * 32),
        ("nfiles", ctypes.c_uint32),
        ("pgid", ctypes.c_uint32),
        ("pjobc", ctypes.c_uint32),
        ("tdev", ctypes.c_uint32),
        ("tpgid", ctypes.c_uint32),
        ("nice", ctypes.c_int32),
        ("start_sec", ctypes.c_uint64),
        ("start_usec", ctypes.c_uint64),
    ]


def group_snapshot(pgid, lib):
    # PROC_PGRP_ONLY=2 filters in the kernel; never read unrelated identities.
    # Spare capacity detects truncation. Bound growth even under process churn.
    for capacity in (256, 1024, 4096, 16384, 65536):
        pids = (ctypes.c_int * capacity)()
        ctypes.set_errno(0)
        size = lib.proc_listpids(2, pgid, pids, ctypes.sizeof(pids))
        error = ctypes.get_errno()
        if size < 0 or error or size % ctypes.sizeof(ctypes.c_int):
            raise OSError(error or errno.EIO, "group census unavailable")
        if size < ctypes.sizeof(pids):
            break
    else:
        raise OSError(errno.EOVERFLOW, "group census truncated")
    members = []
    for pid in pids[: size // ctypes.sizeof(ctypes.c_int)]:
        if pid <= 0:
            raise OSError(errno.EIO, "invalid census pid")
        info = ProcBsdInfo()
        ctypes.set_errno(0)
        count = lib.proc_pidinfo(pid, 3, 0, ctypes.byref(info), ctypes.sizeof(info))
        error = ctypes.get_errno()
        if count == 0 and error == errno.ESRCH:
            continue  # Exited during enumeration, as with a non-atomic ps read.
        if count != ctypes.sizeof(info) or error:
            raise OSError(error or errno.EIO, "group identity unavailable")
        if (
            info.pid != pid
            or info.pgid != pgid
            or not info.start_sec
            or info.start_usec >= 1_000_000
        ):
            raise OSError(errno.EIO, "group identity inconsistent")
        if info.status != 5:  # SZOMB; a zombie cannot execute or hold a lease.
            members.append(
                {"pid": pid, "birth": f"{info.start_sec}.{info.start_usec:06d}"}
            )
    return members


def main():
    verb, value = sys.argv[1:]
    pid = int(value)
    if pid <= 1:
        raise ValueError("invalid process identity")
    if verb == "pgid":
        result = os.getpgid(pid)
    elif verb == "group" and sys.platform == "darwin":
        lib = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
        lib.proc_listpids.argtypes = [
            ctypes.c_uint32,
            ctypes.c_uint32,
            ctypes.c_void_p,
            ctypes.c_int,
        ]
        lib.proc_listpids.restype = ctypes.c_int
        lib.proc_pidinfo.argtypes = [
            ctypes.c_int,
            ctypes.c_int,
            ctypes.c_uint64,
            ctypes.c_void_p,
            ctypes.c_int,
        ]
        lib.proc_pidinfo.restype = ctypes.c_int
        result = group_snapshot(pid, lib)
    else:
        raise ValueError("unsupported census operation")
    print(json.dumps(result))


if __name__ == "__main__":
    main()
