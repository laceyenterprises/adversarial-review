"""Read-only Darwin controller identities; no argv, environment or ledger access."""

import ctypes
import errno
import json
import os
import sys
import time

CTL_KERN, KERN_PROC, KERN_PROC_PGRP = 1, 14, 2
SZOMB = 5
DEFAULT_RETRY_BUDGET_MS = 2000
MAX_RETRY_BUDGET_MS = 40_000


class CensusInterrupted(OSError):
    """Transient kernel evidence exhausted this request's retry budget."""


def error_reply(error):
    reply = {"error": errno.errorcode.get(error.errno, "EIO")}
    if isinstance(error, CensusInterrupted):
        reply.update(
            retryable=True, attempts=error.attempts, elapsedMs=error.elapsed_ms
        )
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


def retry_budget_ms():
    # The JS caller sizes this once using load-aware-timeout. Standalone callers
    # retain the nominal budget. Clamp the environment input independently.
    try:
        value = int(
            os.environ.get("HAM_CENSUS_RETRY_BUDGET_MS", DEFAULT_RETRY_BUDGET_MS)
        )
    except ValueError:
        value = DEFAULT_RETRY_BUDGET_MS
    return max(1, min(MAX_RETRY_BUDGET_MS, value))


def group_snapshot(pgid, sysctl, sleep=time.sleep, now=time.monotonic, budget_ms=None):
    # Keep one deadline across interruptions, inconsistent records and ENOMEM
    # growth. A rejected read contributes no members to a later snapshot.
    budget_ms = retry_budget_ms() if budget_ms is None else budget_ms
    started = now()
    deadline = started + budget_ms / 1000
    mib = (ctypes.c_int * 4)(CTL_KERN, KERN_PROC, KERN_PROC_PGRP, pgid)
    record = ctypes.sizeof(KinfoProc)
    capacities = iter((64, 1024, 16384, 65536))
    capacity = next(capacities)
    attempts, failures, last_error = 0, 0, errno.EIO

    def exhausted():
        error = CensusInterrupted(last_error, "group census retry budget exhausted")
        error.attempts = attempts
        error.elapsed_ms = max(0, round((now() - started) * 1000))
        return error

    while True:
        if attempts and now() >= deadline:
            raise exhausted()
        records = (KinfoProc * capacity)()
        size = ctypes.c_size_t(ctypes.sizeof(records))
        ctypes.set_errno(0)
        attempts += 1
        result = sysctl(mib, 4, records, ctypes.byref(size), None, 0)
        if result != 0:
            error = ctypes.get_errno()
            if error == errno.ENOMEM:
                capacity = next(capacities, None)
                if capacity is None:
                    raise OSError(errno.EOVERFLOW, "group census truncated")
                continue
            if error not in (errno.EIO, errno.EINTR):
                raise OSError(error or errno.EIO, "group census unavailable")
            last_error = error
        else:
            if size.value % record or size.value > ctypes.sizeof(records):
                raise OSError(errno.EIO, "group census misaligned")
            members, inconsistent = [], False
            for info in records[: size.value // record]:
                if info.pid <= 0 or not 0 <= info.start_usec < 1_000_000:
                    raise OSError(errno.EIO, "group identity invalid")
                if info.pgid != pgid or info.start_sec <= 0:
                    inconsistent = True
                    break
                if info.stat != SZOMB:
                    members.append(
                        {
                            "pid": info.pid,
                            "birth": f"{info.start_sec}.{info.start_usec:06d}",
                        }
                    )
            if not inconsistent:
                return members
            last_error = errno.EIO
        failures += 1
        remaining = deadline - now()
        if remaining <= 0:
            raise exhausted()
        sleep(min(0.01 * 2 ** min(failures - 1, 5), 0.2, remaining))


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
        suffix = (
            f" retry-exhausted={reply['attempts']} elapsed-ms={reply['elapsedMs']}"
            if reply.get("retryable")
            else ""
        )
        print(f"controller census: {reply['error']}{suffix}", file=sys.stderr)
        sys.exit(2)
