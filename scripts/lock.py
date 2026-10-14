#!/usr/bin/env python3
"""Hold a persistent POSIX kernel lock until the parent closes stdin."""
import fcntl
import os
import stat
import sys

try:
    lock_fd = os.open(sys.argv[1], os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    if not stat.S_ISREG(os.fstat(lock_fd).st_mode):
        raise ValueError('invalid lock file')
    os.fchmod(lock_fd, 0o600)
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print('busy', flush=True)
        os.close(lock_fd)
        sys.exit(0)
    print('acquired', flush=True)
    while sys.stdin.buffer.read(65536):
        pass
    os.close(lock_fd)
except Exception:
    print('error', flush=True)
    sys.exit(1)
