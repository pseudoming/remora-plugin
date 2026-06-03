import sqlite3
import os
import sys

scripts_dir = os.path.abspath(os.path.dirname(__file__))
if scripts_dir not in sys.path:
    sys.path.insert(0, scripts_dir)
from schema_init import DB_PATH

BRAIN_DIR = os.path.expanduser("~/.gemini/antigravity/brain")

def prune_expired_watermarks():
    """
    当本地 brain 下的物理会话目录被回收删除后，
    定时增量扫描会自动 DELETE 数据库中该会话对应的 watermarks、messages 与 topic_decisions。
    """
    with sqlite3.connect(DB_PATH) as conn:
        cursor = conn.execute("SELECT DISTINCT conversation_id FROM watermarks")
        active_db_convs = [row[0] for row in cursor.fetchall()]
        
        for conv_id in active_db_convs:
            if conv_id.startswith("artifact_sync_"):
                continue
            conv_dir = os.path.join(BRAIN_DIR, conv_id)
            if not os.path.exists(conv_dir):
                conn.execute("DELETE FROM watermarks WHERE conversation_id=?", (conv_id,))
                conn.execute("DELETE FROM messages WHERE conversation_id=?", (conv_id,))
                conn.execute("DELETE FROM topic_decisions WHERE conversation_id=?", (conv_id,))
                print(f"[Remora] 水印回收已清除会话: {conv_id}")
        conn.commit()
