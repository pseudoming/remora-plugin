import os
import sys
import time
import signal

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "scripts")))
from schema_init import DATA_DIR

LOCK_FILE = os.path.join(DATA_DIR, "compactor.lock")

def acquire_lock():
    if os.path.exists(LOCK_FILE):
        try:
            with open(LOCK_FILE, 'r') as f:
                pid = int(f.read().strip())
            mtime = os.path.getmtime(LOCK_FILE)
            if time.time() - mtime < 1800:
                try:
                    os.kill(pid, 0)
                    print(f"Lock active by PID {pid}, exiting.", file=sys.stderr)
                    sys.exit(0)
                except OSError:
                    pass # 原进程已死，允许接管
            else:
                try:
                    os.kill(pid, signal.SIGKILL)
                except OSError:
                    pass # 超过30分钟，强制杀掉僵尸进程后允许接管
        except Exception:
            pass # 文件损坏或无法读取，允许强行接管
    
    with open(LOCK_FILE, 'w') as f:
        f.write(str(os.getpid()))

def release_lock():
    if os.path.exists(LOCK_FILE):
        try:
            with open(LOCK_FILE, 'r') as f:
                pid = int(f.read().strip())
            if pid == os.getpid():
                os.remove(LOCK_FILE)
        except Exception:
            pass
