from core.logger import warn as log_warn, error as log_error
from typing import List, Dict

from core.storage.connection import get_conn, closing

def insert_file_change(project_uuid: str, conversation_id: str, file_name: str, source: str) -> None:
    with closing(get_conn()) as conn:
        with conn:
            conn.execute(
                "INSERT OR IGNORE INTO file_changes (project_uuid, conversation_id, file_name, source) VALUES (?, ?, ?, ?)",
                (project_uuid, conversation_id, file_name, source)
            )

def get_files_by_topic(project_uuid: str, topic_id: str) -> List[str]:
    try:
        with closing(get_conn()) as conn:
            with conn:
                rows = conn.execute(
                    """SELECT DISTINCT fc.file_name FROM file_changes fc
                       JOIN topic_decisions td ON fc.conversation_id = td.conversation_id
                       WHERE td.project_uuid = ? AND td.topic_id = ?""",
                    (project_uuid, topic_id)
                ).fetchall()
                return [row[0] for row in rows]
    except Exception as e:
        log_warn(f"get_files_by_topic: {e}")
        return []

def get_decisions_by_file(project_uuid: str, file_name: str) -> List[Dict]:
    try:
        with closing(get_conn()) as conn:
            with conn:
                rows = conn.execute(
                    """SELECT DISTINCT td.id, td.decision, td.rationale
                       FROM topic_decisions td
                       JOIN file_changes fc ON fc.conversation_id = td.conversation_id
                       WHERE td.project_uuid = ? AND fc.file_name = ?
                       ORDER BY td.created_at DESC""",
                    (project_uuid, file_name)
                ).fetchall()
                return [{"id": r[0], "decision": r[1], "rationale": r[2]} for r in rows]
    except Exception as e:
        log_warn(f"get_decisions_by_file: {e}")
        return []
