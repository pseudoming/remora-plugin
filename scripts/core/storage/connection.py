import sqlite3
from contextlib import closing
from lib import paths

def _get_conn():
    return sqlite3.connect(paths.get_db_path(), timeout=15)

def check_db_exists():
    import os
    return os.path.exists(paths.get_db_path())
