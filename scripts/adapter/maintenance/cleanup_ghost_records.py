import os
import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from lib import dao
from core.logger import info

def fix_db():
    info("Connecting to DB...")
    count = dao.cleanup_ghost_messages()
    if count > 0:
        info(f"Deleted {count} ghost records. FTS index rebuilt.")
    else:
        info("No ghost records to clean up.")

if __name__ == "__main__":
    fix_db()
