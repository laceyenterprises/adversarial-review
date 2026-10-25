"""Read-only Darwin controller identities; no argv, environment or ledger access."""

import ctypes
import errno
import json
import os
import sys

CTL_KERN, KERN_PROC, KERN_PROC_PGRP = 1, 14, 2
SZOMB = 5


class KinfoProc(ctypes.Structure):
    """Darwin <sys/sysctl.h> kinfo_proc, stable 648-byte LP64 ABI.

    Only the fields the census reads are named: kp_proc.p_starttime (offset 0),
    kp_proc.p_stat (36), kp_proc.p_pid (40) and kp_eproc.e_pgid (564).
    """

    _fields_ = [
        ("start_sec", ctypes.c_int64),
        ("start_usec", ctypes.c_int32),
        ("_pad0", ctypes.c_char * 24),
        ("stat", ctypes.c_uint8),
        ("_pad1", ctypes.c_char * 3),
        ("pid", ctypes.c_int32),
        ("_pad2", ctypes.c_char * 520),
        ("pgid", ctypes.c_int32),
        ("_pad3", ctypes.c_char * 80),
    ]


def group_snapshot(pgid, sysctl):
    # KERN_PROC_PGRP filters in the kernel and returns one snapshot: the same
    # records ps reads, without a setuid helper. Unlike per-PID libproc reads it
    # needs no same-user check, so a member running a setuid tool stays visible.
    mib = (ctypes.c_int * 4)(CTL_KERN, KERN_PROC, KERN_PROC_PGRP, pgid)
    record = ctypes.sizeof(KinfoProc)
    # ENOMEM reports truncation. Bound growth even under process churn.
    for capacity in (64, 1024, 16384, 65536):
        records = (KinfoProc * capacity)()
        size = ctypes.c_size_t(ctypes.sizeof(records))
        ctypes.set_errno(0)
        if sysctl(mib, 4, records, ctypes.byref(size), None, 0) == 0:
            break
        error = ctypes.get_errno()
        if error != errno.ENOMEM:
            raise OSError(error or errno.EIO, "group census unavailable")
    else:
        raise OSError(errno.EOVERFLOW, "group census truncated")
    if size.value % record or size.value > ctypes.sizeof(records):
        raise OSError(errno.EIO, "group census misaligned")
    members = []
    for info in records[: size.value // record]:
        if (
            info.pid <= 0
            or info.pgid != pgid
            or info.start_sec <= 0
            or not 0 <= info.start_usec < 1_000_000
        ):
            raise OSError(errno.EIO, "group identity inconsistent")
        if info.stat != SZOMB:  # A zombie cannot execute or hold a lease.
            members.append(
                {"pid": info.pid, "birth": f"{info.start_sec}.{info.start_usec:06d}"}
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
        if ctypes.sizeof(ctypes.c_void_p) != 8:
            raise OSError(errno.ENOTSUP, "kinfo_proc ABI requires LP64")
        libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
        libc.sysctl.argtypes = [
            ctypes.POINTER(ctypes.c_int),
            ctypes.c_uint,
            ctypes.c_void_p,
            ctypes.POINTER(ctypes.c_size_t),
            ctypes.c_void_p,
            ctypes.c_size_t,
        ]
        libc.sysctl.restype = ctypes.c_int
        result = group_snapshot(pid, libc.sysctl)
    else:
        raise ValueError("unsupported census operation")
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except ValueError:
        print("controller census: EINVAL", file=sys.stderr)
        sys.exit(2)
    except OSError as error:
        # Only the errno name leaves the helper; the caller names the mechanism.
        name = errno.errorcode.get(error.errno, "EIO")
        print(f"controller census: {name}", file=sys.stderr)
        sys.exit(2)
