import os
import sys
import sqlite3
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from lib.paths import get_data_dir

DB_PATH = os.path.join(get_data_dir(), "remora_memory.db")

def fix_db():
    print("Connecting to DB...")
    with sqlite3.connect(DB_PATH, timeout=15) as conn:
        cursor = conn.cursor()
        
        # Count ghost records
        cursor.execute("SELECT COUNT(*) FROM messages WHERE role IS NULL OR role = '' OR content IS NULL OR content = ''")
        count = cursor.fetchone()[0]
        print(f"Found {count} ghost records.")
        
        if count > 0:
            print("Deleting ghost records...")
            cursor.execute("DELETE FROM messages WHERE role IS NULL OR role = '' OR content IS NULL OR content = ''")
            deleted = cursor.rowcount
            print(f"Deleted {deleted} records.")
            
            print("Rebuilding FTS index...")
            cursor.execute("INSERT INTO messages_fts(messages_fts) VALUES('rebuild');")
            print("FTS index rebuilt.")
            
            conn.commit()
            print("Cleanup complete.")
        else:
            print("No ghost records to clean up.")

if __name__ == "__main__":
    fix_db()
