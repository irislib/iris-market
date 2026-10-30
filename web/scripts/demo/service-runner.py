#!/usr/bin/env python3
"""Hold an OS lock across exec; the kernel releases it even after a crash."""
import fcntl
import os
import sys

state = os.environ["MARKET_DEMO_STATE_DIR"]
os.makedirs(state, mode=0o700, exist_ok=True)
fd = os.open(os.path.join(state, "service.lock"), os.O_RDWR | os.O_CREAT, 0o600)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    sys.exit("Another process owns the demo state.")
os.set_inheritable(fd, True)
os.environ["MARKET_DEMO_LOCK_FD"] = str(fd)
os.execv(sys.argv[1], sys.argv[1:])
