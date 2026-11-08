"""Read-only Darwin controller identities; no argv, environment or ledger access."""

import ctypes
import errno
import json
import os
import sys
import time

CTL_KERN, KERN_PROC, KERN_PROC_PGRP = 1, 14, 2
SZOMB = 5
INTERRUPTION_ATTEMPTS = 3


class CensusInterrupted(OSError):
    """An explicit syscall interruption exhausted this request's retry budget."""


def error_reply(error):
    reply = {"error": errno.errorcode.get(error.errno, "EIO")}
    if isinstance(error, CensusInterrupted):
        reply.update(retryable=True, attempts=INTERRUPTION_ATTEMPTS)
    return reply


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


def group_snapshot(pgid, sysctl, sleep=time.sleep):
    # KERN_PROC_PGRP filters in the kernel and returns one snapshot: the same
    # records ps reads, without a setuid helper. Unlike per-PID libproc reads it
    # needs no same-user check, so a member running a setuid tool stays visible.
    mib = (ctypes.c_int * 4)(CTL_KERN, KERN_PROC, KERN_PROC_PGRP, pgid)
    record = ctypes.sizeof(KinfoProc)
    # ENOMEM reports truncation. Bound growth even under process churn.
    interruptions = 0
    capacities = iter((64, 1024, 16384, 65536))
    capacity = next(capacities)
    while True:
        records = (KinfoProc * capacity)()
        size = ctypes.c_size_t(ctypes.sizeof(records))
        ctypes.set_errno(0)
        if sysctl(mib, 4, records, ctypes.byref(size), None, 0) == 0:
            break
        error = ctypes.get_errno()
        # Only an explicit failed syscall can be transient. Never retry a
        # successful but incomplete/inconsistent snapshot, or synthesize a
        # retryable EIO from a failure that supplied no errno.
        if error in (errno.EIO, errno.EINTR):
            interruptions += 1
            if interruptions >= INTERRUPTION_ATTEMPTS:
                raise CensusInterrupted(error, "group census interrupted")
            sleep(0.01 * interruptions)
            continue
        if error == errno.ENOMEM:
            capacity = next(capacities, None)
            if capacity is None:
                raise OSError(errno.EOVERFLOW, "group census truncated")
            continue
        raise OSError(error or errno.EIO, "group census unavailable")
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


def darwin_sysctl():
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
    return libc.sysctl


def census(verb, value, sysctl_loader=darwin_sysctl):
    pid = int(value)
    if pid <= 1:
        raise ValueError("invalid process identity")
    if verb == "pgid":
        return os.getpgid(pid)
    if verb == "group" and sys.platform == "darwin":
        return group_snapshot(pid, sysctl_loader())
    raise ValueError("unsupported census operation")


def serve(requests, replies, sysctl=None):
    # One answer per request line. Every request re-reads the kernel; only the
    # libc binding outlives a request, never a census result.
    binding = [sysctl] if sysctl else []

    def loader():
        if not binding:
            binding.append(darwin_sysctl())
        return binding[0]

    for line in requests:
        try:
            verb, value = line.split()
            reply = {"ok": census(verb, value, loader)}
        except ValueError:
            reply = {"error": "EINVAL"}
        except OSError as error:
            reply = error_reply(error)
        replies.write(json.dumps(reply) + "\n")
        replies.flush()


def main():
    if sys.argv[1:] == ["serve"]:
        serve(sys.stdin, sys.stdout)
        return
    verb, value = sys.argv[1:]
    print(json.dumps(census(verb, value)))


if __name__ == "__main__":
    try:
        main()
    except ValueError:
        print("controller census: EINVAL", file=sys.stderr)
        sys.exit(2)
    except OSError as error:
        # Only bounded errno/exhaustion tokens leave the helper.
        reply = error_reply(error)
        suffix = " retry-exhausted=3" if reply.get("retryable") else ""
        print(f"controller census: {reply['error']}{suffix}", file=sys.stderr)
        sys.exit(2)
