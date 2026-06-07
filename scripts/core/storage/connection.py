import os
import sqlite3
from contextlib import closing
from core.logger import debug

_DB_PATH = os.environ.get(
    "REMORA_DB_PATH",
    os.path.join(os.path.expanduser("~"), ".remora", "data", "remora_memory.db")
)

def get_db_path():
    return _DB_PATH

def get_conn():
    import time as _time
    _t0 = _time.perf_counter()
    conn = sqlite3.connect(get_db_path(), timeout=15)
    debug(f"db connect: {(_time.perf_counter() - _t0)*1000:.1f}ms")
    return conn

def check_db_exists():
    return os.path.exists(get_db_path())
