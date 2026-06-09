import json
from core.logger import warn as log_warn, error as log_error
from typing import Optional, List, Dict

from core.storage.connection import get_conn, closing

def get_confirmed_decisions(project_uuid: str, topic_id: str) -> List[Dict]:
    """Returns [{'text': '...', 'files': [...], 'evidence': '...'}]"""
    try:
        import json
        with closing(get_conn()) as conn:
            with conn:
                rows = conn.execute(
                    "SELECT decision, rationale, evidence_msg_ids, decision_type FROM topic_decisions WHERE project_uuid=? AND topic_id=? AND user_confirmed=1 ORDER BY created_at ASC", 
                    (project_uuid, topic_id)
                ).fetchall()
                
                decisions = []
                for d_text, rationale, evidence_msg_ids_json, decision_type in rows:
                    evidence_texts = []
                    if evidence_msg_ids_json:
                        try:
                            msg_ids = json.loads(evidence_msg_ids_json)
                            for msg_id in msg_ids:
                                msg_row = conn.execute("SELECT content FROM messages WHERE id=?", (msg_id,)).fetchone()
                                if msg_row:
                                    evidence_texts.append(msg_row[0])
                        except Exception as e:
                            log_warn(f"evidence_msg_ids parse: {e}")
                            
                    decisions.append({
                        "text": f"{d_text} (原因: {rationale})",
                        "evidence": "\n".join(evidence_texts),
                        "decision_type": decision_type or "approved"
                    })
                return decisions
    except Exception as e:
        log_warn(f"get_confirmed_decisions: {e}")
        return []

def confirm_decision(project_uuid: str, decision_id: int) -> bool:
    with closing(get_conn()) as conn:
        with conn:
            cursor = conn.execute(
                "UPDATE topic_decisions SET user_confirmed=1, updated_at=CURRENT_TIMESTAMP WHERE id=? AND project_uuid=?",
                (decision_id, project_uuid)
            )
            return cursor.rowcount > 0

def get_topic_id_by_decision(decision_id: int) -> Optional[str]:
    try:
        with closing(get_conn()) as conn:
            with conn:
                row = conn.execute("SELECT topic_id FROM topic_decisions WHERE id=?", (decision_id,)).fetchone()
                return row[0] if row else None
    except Exception as e:
        log_warn(f"get_topic_id_by_decision: {e}")
        return None

def decision_exists(conn, project_uuid: str, topic_id: str, decision_text: str) -> bool:
    """Check if an identical decision already exists for this project+topic. Uses the supplied connection for transaction consistency."""
    row = conn.execute(
        "SELECT id FROM topic_decisions WHERE project_uuid=? AND topic_id=? AND decision=?",
        (project_uuid, topic_id, decision_text)
    ).fetchone()
    return row is not None

def supersede_unconfirmed(conn, project_uuid: str, topic_id: str) -> None:
    """Delete all user_confirmed=0 decisions for this topic before inserting a new extraction batch."""
    conn.execute(
        "DELETE FROM topic_decisions WHERE project_uuid=? AND topic_id=? AND user_confirmed=0",
        (project_uuid, topic_id)
    )

def get_pending_decisions(conn, project_uuid: str, limit: int = 30) -> list:
    """Returns list of unconfirmed decisions for event consumption."""
    cursor = conn.execute(
        "SELECT id, decision, rationale FROM topic_decisions WHERE project_uuid=? AND user_confirmed=0 ORDER BY id DESC LIMIT ?",
        (project_uuid, limit))
    return [{"id": r[0], "decision": r[1], "rationale": r[2]} for r in cursor.fetchall()]

def confirm_decisions_by_ids(conn, decision_ids: list, project_uuid: str) -> None:
    """Batch-confirm decisions by their IDs."""
    for d_id in decision_ids:
        conn.execute(
            "UPDATE topic_decisions SET user_confirmed=1 WHERE id=? AND project_uuid=?",
            (d_id, project_uuid))

def insert_decision(conn, project_uuid: str, topic_id: str, conversation_id: str,
                    decision: str, rationale: str, evidence_msg_ids: str,
                    user_confirmed: int, decision_type: str) -> None:
    conn.execute(
        """INSERT INTO topic_decisions
           (project_uuid, topic_id, conversation_id, decision, rationale, evidence_msg_ids, user_confirmed, decision_type)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (project_uuid, topic_id, conversation_id, decision, rationale, evidence_msg_ids, user_confirmed, decision_type))


def get_decision_confirmed(conn, decision_id: int) -> bool:
    row = conn.execute("SELECT user_confirmed FROM topic_decisions WHERE id=?", (decision_id,)).fetchone()
    return bool(row and row[0] == 1)


def get_confirmed_decision_ids(conn, project_uuid: str) -> set:
    cursor = conn.execute(
        "SELECT id FROM topic_decisions WHERE project_uuid=? AND user_confirmed=1",
        (project_uuid,))
    return {row[0] for row in cursor.fetchall()}

def get_recent_decisions(conn, project_uuid: str, topic_id: str, limit: int = 5) -> list:
    """Returns recent decisions (both uc=0 and uc=1) sorted by created_at DESC."""
    cursor = conn.execute(
        "SELECT id, decision, rationale, user_confirmed, created_at FROM topic_decisions WHERE project_uuid=? AND topic_id=? ORDER BY created_at DESC LIMIT ?",
        (project_uuid, topic_id, limit))
    return [{"id": r[0], "decision": r[1], "rationale": r[2], "user_confirmed": r[3], "created_at": r[4]} for r in cursor.fetchall()]

def get_rejected_or_deferred_by_relevance(conn, project_uuid: str, query_text: str, limit: int = 12) -> list:
    """BM25-ranked rejected/deferred decisions matching the user query, with LIKE fallback."""
    safe_query = query_text.replace('"', '""')
    candidates = []
    existing_ids = set()

    try:
        cursor = conn.execute("""
            SELECT td.id, td.decision, td.rationale, td.decision_type, td.created_at
            FROM topic_decisions td
            JOIN json_each(td.evidence_msg_ids) j
            JOIN messages m ON m.id = j.value
            JOIN messages_fts fts ON m.id = fts.rowid
            WHERE td.project_uuid = ?
              AND td.decision_type IN ('rejected', 'deferred')
              AND messages_fts MATCH ?
            ORDER BY rank
            LIMIT ?
        """, (project_uuid, f'"{safe_query}"', limit))
        candidates = [{"id": r[0], "decision": r[1], "rationale": r[2], "decision_type": r[3], "created_at": r[4]} for r in cursor.fetchall()]
        existing_ids = {c["id"] for c in candidates}
    except Exception:
        pass

    if len(candidates) < limit:
        shortage = limit - len(candidates)
        id_placeholders = ','.join(['?'] * len(existing_ids)) if existing_ids else ''
        like_pattern = f"%{safe_query}%"
        try:
            if existing_ids:
                cursor = conn.execute(f"""
                    SELECT id, decision, rationale, decision_type, created_at
                    FROM topic_decisions
                    WHERE project_uuid = ? AND decision_type IN ('rejected','deferred')
                      AND id NOT IN ({id_placeholders})
                      AND (decision LIKE ? OR rationale LIKE ?)
                    LIMIT ?
                """, (project_uuid, *list(existing_ids), like_pattern, like_pattern, shortage))
            else:
                cursor = conn.execute("""
                    SELECT id, decision, rationale, decision_type, created_at
                    FROM topic_decisions
                    WHERE project_uuid = ? AND decision_type IN ('rejected','deferred')
                      AND (decision LIKE ? OR rationale LIKE ?)
                    LIMIT ?
                """, (project_uuid, like_pattern, like_pattern, shortage))
            candidates += [{"id": r[0], "decision": r[1], "rationale": r[2], "decision_type": r[3], "created_at": r[4]} for r in cursor.fetchall()]
        except Exception:
            pass

    return candidates

def bump_injection(conn, decision_id: int) -> None:
    conn.execute(
        "UPDATE topic_decisions SET injected_count = injected_count + 1, last_injected_at = CURRENT_TIMESTAMP WHERE id = ?",
        (decision_id,))
