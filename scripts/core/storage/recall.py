import json
from core.logger import warn as log_warn, error as log_error
from typing import List

from core.storage.connection import get_conn, closing

def recall_fts5_logs(project_uuid: str, conv_id: str, keyword: str, limit: int = 10) -> List[str]:
    try:
        safe_keyword = keyword.replace('"', '""')
        with closing(get_conn()) as conn:
            with conn:
                cursor = conn.cursor()
                cursor.execute("""
                    SELECT m.role || ': ' || m.content
                    FROM messages m
                    JOIN messages_fts fts ON m.id = fts.rowid
                    WHERE m.conversation_id IN (
                        SELECT conversation_id FROM watermarks WHERE project_uuid = ?
                        UNION
                        SELECT ? WHERE ? != ''
                    )
                    AND fts.content MATCH ?
                    ORDER BY m.id ASC
                    LIMIT ?
                """, (project_uuid, conv_id, conv_id, f'"{safe_keyword}"', limit))
                return [row[0] for row in cursor.fetchall()]
    except Exception as e:
        log_warn(f"recall_fts5_logs: {e}")
        return []

def _build_evidence_texts(conn, evidence_ids_json):
    evidence_texts = []
    if evidence_ids_json:
        try:
            msg_ids = json.loads(evidence_ids_json)
            for mid in msg_ids:
                msg_row = conn.execute("SELECT content FROM messages WHERE id=?", (mid,)).fetchone()
                if msg_row:
                    evidence_texts.append(msg_row[0][:200] + "...")
        except Exception:
            pass
    return f" [证据: {' | '.join(evidence_texts)}]" if evidence_texts else ""

def recall_decisions_by_fts5_topic(project_uuid: str, conv_id: str, keyword: str) -> List[str]:
    try:
        safe_keyword = keyword.replace('"', '""')
        with closing(get_conn()) as conn:
            with conn:
                cursor = conn.cursor()
                cursor.execute("""
                    SELECT topic_id, decision, rationale, evidence_msg_ids
                    FROM topic_decisions
                    WHERE (project_uuid = ? OR conversation_id = ?)
                    AND topic_id IN (
                        SELECT DISTINCT j.value
                        FROM messages m
                        JOIN messages_fts fts ON m.id = fts.rowid
                        JOIN json_each(COALESCE(m.topic_id, '[]')) j
                        WHERE m.conversation_id IN (
                            SELECT conversation_id FROM watermarks WHERE project_uuid = ?
                            UNION
                            SELECT ? WHERE ? != ''
                        )
                        AND fts.content MATCH ?
                    )
                    ORDER BY created_at DESC
                """, (project_uuid, conv_id, project_uuid, conv_id, conv_id, f'"{safe_keyword}"'))
                
                results = []
                for topic_id, decision, rationale, evidence_ids_json in cursor.fetchall():
                    evidence_str = _build_evidence_texts(conn, evidence_ids_json)
                    results.append(f"[{topic_id}] {decision} (原因: {rationale}){evidence_str}")
                return results
    except Exception as e:
        log_warn(f"recall_decisions_by_fts5_topic: {e}")
        return []

def recall_decisions_by_like(project_uuid: str, conv_id: str, keyword: str, limit: int = 5) -> List[str]:
    try:
        # Prevent LIKE wildcard injection
        safe_keyword = keyword.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        like_pattern = f"%{safe_keyword}%"
        with closing(get_conn()) as conn:
            with conn:
                cursor = conn.cursor()
                cursor.execute("""
                    SELECT topic_id, decision, rationale, evidence_msg_ids
                    FROM topic_decisions
                    WHERE (project_uuid = ? OR conversation_id = ?)
                    AND (decision LIKE ? ESCAPE '\\' OR rationale LIKE ? ESCAPE '\\')
                    ORDER BY created_at DESC LIMIT ?
                """, (project_uuid, conv_id, like_pattern, like_pattern, limit))
                
                results = []
                for topic_id, decision, rationale, evidence_ids_json in cursor.fetchall():
                    evidence_str = _build_evidence_texts(conn, evidence_ids_json)
                    results.append(f"[{topic_id}] {decision} (原因: {rationale}){evidence_str}")
                return results
    except Exception as e:
        log_warn(f"recall_decisions_by_like: {e}")
        return []

def touch_topics_accessed_by_recall(project_uuid: str, conv_id: str, keyword: str) -> None:
    with closing(get_conn()) as conn:
        with conn:
            safe_keyword = keyword.replace('"', '""')
            conn.execute("""
                UPDATE project_topics SET last_accessed_at = CURRENT_TIMESTAMP
                WHERE uuid = ? 
                AND topic_id IN (
                    SELECT value FROM (
                        SELECT j.value
                        FROM messages m
                        JOIN messages_fts fts ON m.id = fts.rowid
                        JOIN json_each(COALESCE(m.topic_id, '[]')) j
                        WHERE m.conversation_id IN (
                            SELECT conversation_id FROM watermarks WHERE project_uuid = ?
                            UNION
                            SELECT ? WHERE ? != ''
                        )
                        AND fts.content MATCH ?
                        ORDER BY m.id ASC LIMIT 10
                    )
                    UNION
                    SELECT topic_id FROM (
                        SELECT topic_id FROM topic_decisions
                        WHERE (project_uuid = ? OR conversation_id = ?)
                        AND (decision LIKE ? ESCAPE '\\' OR rationale LIKE ? ESCAPE '\\')
                        ORDER BY created_at DESC LIMIT 5
                    )
                )
            """, (project_uuid, project_uuid, conv_id, conv_id, f'"{safe_keyword}"', project_uuid, conv_id, f"%{safe_keyword}%", f"%{safe_keyword}%"))
