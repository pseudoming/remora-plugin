import json

def get_plan_change_time(conn, project_uuid: str):
    """Returns last message timestamp of implementation_plan.md for this project, or None."""
    cursor = conn.execute(
        "SELECT MAX(timestamp) FROM messages WHERE conversation_id=? AND role='implementation_plan.md'",
        (f"artifact_sync_{project_uuid}",))
    row = cursor.fetchone()
    return row[0] if row and row[0] else None

def get_user_messages_after(conn, timestamp: str, project_uuid: str) -> list:
    cursor = conn.execute(
        """SELECT m.content FROM messages m
           JOIN watermarks w ON m.conversation_id = w.conversation_id
           WHERE m.timestamp > ?
             AND m.role IN ('USER', 'USER_INPUT', 'USER_EXPLICIT', 'user')
             AND w.project_uuid = ?""",
        (timestamp, project_uuid))
    return [r[0] for r in cursor.fetchall()]

def get_plan_content(conn, project_uuid: str):
    cursor = conn.execute(
        "SELECT content FROM messages WHERE conversation_id=? AND role='implementation_plan.md' LIMIT 1",
        (f"artifact_sync_{project_uuid}",))
    row = cursor.fetchone()
    return row[0] if row else ""

def enqueue_event(conn, project_uuid: str, event_type: str, payload: str) -> None:
    conn.execute(
        "INSERT INTO remora_event_queue (project_uuid, event_type, payload) VALUES (?, ?, ?)",
        (project_uuid, event_type, payload))

def get_pending_events(conn) -> list:
    cursor = conn.execute(
        "SELECT id, project_uuid, event_type, payload FROM remora_event_queue WHERE status='pending' ORDER BY id ASC")
    return cursor.fetchall()

def mark_event_processed(conn, event_id: int) -> None:
    conn.execute("UPDATE remora_event_queue SET status='processed' WHERE id=?", (event_id,))

def get_artifact_hash(conn, file_path: str):
    cursor = conn.execute("SELECT hash FROM artifact_hashes WHERE file_path=?", (file_path,))
    row = cursor.fetchone()
    return row[0] if row else None

def upsert_artifact_hash(conn, file_path: str, file_hash: str) -> None:
    conn.execute(
        "INSERT OR REPLACE INTO artifact_hashes (file_path, hash, last_updated) VALUES (?, ?, CURRENT_TIMESTAMP)",
        (file_path, file_hash))

def delete_artifact_messages(conn, sync_conv_id: str, filename: str) -> None:
    conn.execute(
        "DELETE FROM messages WHERE conversation_id=? AND role=?",
        (sync_conv_id, filename))

def insert_artifact_message(conn, sync_conv_id: str, line_number: int, role: str, content: str, topic_id: str) -> None:
    conn.execute(
        """INSERT INTO messages (conversation_id, line_number, timestamp, role, content, topic_id)
           VALUES (?, ?, CURRENT_TIMESTAMP, ?, ?, ?)""",
        (sync_conv_id, line_number, role, content, topic_id))

def upsert_artifact_topic(conn, project_uuid: str, topic_id: str, summary: str) -> None:
    conn.execute(
        """INSERT INTO project_topics (uuid, topic_id, status, summary, source)
           VALUES (?, ?, 'closed', ?, 'auto')
           ON CONFLICT(uuid, topic_id) DO UPDATE SET
               status='closed',
               summary=excluded.summary,
               updated_at=CURRENT_TIMESTAMP""",
        (project_uuid, topic_id, summary))
