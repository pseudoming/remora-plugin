import logging

from core.storage.connection import _get_conn, closing

def run_topic_garbage_collection() -> None:
    """
    静默清理 source='auto' 且 status='closed' 且 last_accessed_at 早于 72 小时前，
    且该话题下没有任何 user_confirmed = 1 的决策的话题。
    """
    try:
        import sys
        with closing(_get_conn()) as conn:
            with conn:
                # Obtain EXCLUSIVE lock immediately to prevent Lock Upgrade Deadlocks in daemons
                conn.execute("BEGIN EXCLUSIVE")
                cursor = conn.execute(
                    """SELECT pt.uuid, pt.topic_id FROM project_topics pt
                       WHERE pt.source = 'auto' AND pt.status = 'closed'
                         AND pt.topic_id NOT IN (
                             SELECT DISTINCT topic_id FROM topic_decisions WHERE user_confirmed = 1 AND project_uuid = pt.uuid
                         )
                         AND (
                             COALESCE(
                                 (SELECT MAX(td.created_at) 
                                  FROM topic_decisions td 
                                  WHERE td.project_uuid = pt.uuid AND td.topic_id = pt.topic_id),
                                 pt.last_accessed_at
                             ) < datetime('now', '-72 hours')
                         )"""
                )
                to_delete = cursor.fetchall()
                for uuid, topic_id in to_delete:
                    conn.execute("DELETE FROM topic_decisions WHERE project_uuid=? AND topic_id=?", (uuid, topic_id))
                    conn.execute("DELETE FROM project_topics WHERE uuid=? AND topic_id=?", (uuid, topic_id))
                    print(f"[Remora GC] Pruned cold auto topic: {topic_id} in project {uuid}")
    except Exception as e:
        logging.error(f"Error running topic garbage collection: {e}")
        import sys
        sys.exit(1)

def prune_expired_watermarks(brain_dir: str) -> None:
    """
    定期清理已失效的水印和关联数据。
    """
    try:
        import os
        import sys
        if not os.path.isdir(brain_dir):
            logging.error(f"[Remora] Invalid brain_dir {brain_dir}, aborting prune to prevent data loss.")
            return

        with closing(_get_conn()) as conn:
            # First query without exclusive lock
            cursor = conn.execute("""
                SELECT w.conversation_id 
                FROM watermarks w
                LEFT JOIN messages m ON w.last_msg_id = m.id
                WHERE COALESCE(m.timestamp, w.last_updated) < datetime('now', '-30 days')
                OR NOT EXISTS (SELECT 1 FROM session_state ss WHERE ss.session_id = w.conversation_id)
            """)
            active_db_convs = [row[0] for row in cursor.fetchall()]
            
        to_delete = []
        for conv_id in active_db_convs:
            if conv_id.startswith("artifact_sync_"):
                continue
            conv_dir = os.path.join(brain_dir, conv_id)
            
            if not os.path.exists(conv_dir):
                to_delete.append((conv_id, "文件缺失"))
            else:
                with closing(_get_conn()) as conn:
                    res = conn.execute("""
                        SELECT 1 FROM watermarks w
                        LEFT JOIN messages m ON w.last_msg_id = m.id
                        WHERE w.conversation_id = ? 
                        AND COALESCE(m.timestamp, w.last_updated) < datetime('now', '-30 days')
                        AND NOT EXISTS (SELECT 1 FROM session_state ss WHERE ss.session_id = w.conversation_id)
                    """, (conv_id,)).fetchone()
                    if res:
                        to_delete.append((conv_id, "超期不活跃"))

        if to_delete:
            with closing(_get_conn()) as conn:
                with conn:
                    conn.execute("BEGIN EXCLUSIVE")
                    for conv_id, reason in to_delete:
                        conn.execute("DELETE FROM watermarks WHERE conversation_id=?", (conv_id,))
                        conn.execute("DELETE FROM messages WHERE conversation_id=?", (conv_id,))
                        conn.execute("DELETE FROM topic_decisions WHERE conversation_id=?", (conv_id,))
                        print(f"[Remora] 水印回收已清除会话 ({reason}): {conv_id}")
    except Exception as e:
        logging.error(f"Error pruning expired watermarks: {e}")
        import sys
        sys.exit(1)

def cleanup_ghost_messages() -> int:
    try:
        with closing(_get_conn()) as conn:
            with conn:
                cursor = conn.execute(
                    "DELETE FROM messages WHERE role IS NULL OR role = '' OR content IS NULL OR content = ''"
                )
                deleted = cursor.rowcount
                if deleted > 0:
                    conn.execute("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')")
                return deleted
    except Exception as e:
        logging.error(f"Error in cleanup_ghost_messages: {e}")
        return 0
