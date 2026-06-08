from core.logger import error as log_error
from core.storage.connection import get_conn, closing

USER_ROLES = ("USER", "USER_INPUT", "USER_EXPLICIT", "user")


def get_latest_non_user_messages(conv_id, limit=5):
    try:
        with closing(get_conn()) as conn:
            with conn:
                rows = conn.execute(
                    "SELECT timestamp, role, content FROM messages "
                    "WHERE conversation_id = ? "
                    "AND role NOT IN (?, ?, ?, ?) "
                    "AND content IS NOT NULL AND content != '' "
                    "ORDER BY line_number DESC, id DESC "
                    "LIMIT ?",
                    (conv_id, *USER_ROLES, limit)
                ).fetchall()
                return [
                    {"timestamp": r[0], "role": r[1], "content": r[2]}
                    for r in rows
                ]
    except Exception as e:
        log_error(f"get_latest_non_user_messages failed: {e}")
        return []


def get_watermark(conn, project_uuid: str, conversation_id: str) -> int:
    """Returns last_msg_id from watermarks, or 0 if no row exists."""
    cursor = conn.execute(
        "SELECT last_msg_id FROM watermarks WHERE project_uuid=? AND conversation_id=?",
        (project_uuid, conversation_id))
    row = cursor.fetchone()
    return row[0] if row else 0

def get_max_line_number(conn, conversation_id: str) -> int:
    cursor = conn.execute("SELECT MAX(line_number) FROM messages WHERE conversation_id=?", (conversation_id,))
    row = cursor.fetchone()
    return row[0] if row and row[0] else 0

def insert_message(conn, conversation_id: str, line_number: int, timestamp: str, role: str, content: str) -> int:
    cursor = conn.execute(
        "INSERT OR IGNORE INTO messages (conversation_id, line_number, timestamp, role, content) VALUES (?, ?, ?, ?, ?)",
        (conversation_id, line_number, timestamp, role, content))
    return cursor.lastrowid

def get_max_message_id(conn, conversation_id: str) -> int:
    cursor = conn.execute("SELECT MAX(id) FROM messages WHERE conversation_id=?", (conversation_id,))
    row = cursor.fetchone()
    return row[0] if row and row[0] else 0

def get_max_message_id_up_to_line(conn, conversation_id: str, line_number: int) -> int:
    cursor = conn.execute(
        "SELECT MAX(id) FROM messages WHERE conversation_id=? AND line_number<=?",
        (conversation_id, line_number))
    row = cursor.fetchone()
    return row[0] if row and row[0] else 0

def delete_messages_above_line(conn, conversation_id: str, line_number: int) -> None:
    conn.execute(
        "DELETE FROM messages WHERE conversation_id=? AND line_number > ?",
        (conversation_id, line_number))

def get_decisions_by_conversation(conn, conversation_id: str) -> list:
    cursor = conn.execute("SELECT id, evidence_msg_ids FROM topic_decisions WHERE conversation_id=?", (conversation_id,))
    return cursor.fetchall()

def delete_topic_decision(conn, decision_id: int) -> None:
    conn.execute("DELETE FROM topic_decisions WHERE id=?", (decision_id,))

def get_message_timestamp(conn, message_id: int):
    cursor = conn.execute("SELECT timestamp FROM messages WHERE id=?", (message_id,))
    row = cursor.fetchone()
    return row[0] if row else None

def delete_decisions_by_conversation_after(conn, conversation_id: str, created_after: str) -> None:
    conn.execute("DELETE FROM topic_decisions WHERE conversation_id=? AND created_at > ?", (conversation_id, created_after))

def delete_pending_events(conn, project_uuid: str) -> None:
    conn.execute("DELETE FROM remora_event_queue WHERE project_uuid=? AND status='pending'", (project_uuid,))

def update_watermark(conn, project_uuid: str, conversation_id: str, msg_id: int) -> None:
    conn.execute(
        "UPDATE watermarks SET last_msg_id=? WHERE project_uuid=? AND conversation_id=?",
        (msg_id, project_uuid, conversation_id))

def ensure_watermark(conn, project_uuid: str, conversation_id: str) -> None:
    conn.execute(
        "INSERT OR IGNORE INTO watermarks (project_uuid, conversation_id, last_msg_id) VALUES (?, ?, 0)",
        (project_uuid, conversation_id))
