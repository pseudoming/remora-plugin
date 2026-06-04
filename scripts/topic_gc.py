import sqlite3
import os
import sys

scripts_dir = os.path.abspath(os.path.dirname(__file__))
if scripts_dir not in sys.path:
    sys.path.insert(0, scripts_dir)
from schema_init import DB_PATH

def run_garbage_collection(conn):
    """
    静默清理 source='auto' 且 status='closed' 且 last_accessed_at 早于 72 小时前，
    且该话题下没有任何 user_confirmed = 1 的决策的话题。
    """
    try:
        cursor = conn.execute(
            """SELECT uuid, topic_id FROM project_topics
               WHERE source = 'auto' AND status = 'closed'
                 AND last_accessed_at < datetime('now', '-72 hours')
                 AND (uuid, topic_id) NOT IN (
                     SELECT DISTINCT project_uuid, topic_id FROM topic_decisions WHERE user_confirmed = 1
                 )"""
        )
        to_delete = cursor.fetchall()
        for uuid, topic_id in to_delete:
            conn.execute("DELETE FROM topic_decisions WHERE project_uuid=? AND topic_id=?", (uuid, topic_id))
            conn.execute("DELETE FROM project_topics WHERE uuid=? AND topic_id=?", (uuid, topic_id))
            print(f"[Remora GC] Pruned cold auto topic: {topic_id} in project {uuid}")
        conn.commit()
    except Exception as e:
        print(f"Error running garbage collection: {str(e)}", file=sys.stderr)
