import json
import logging
from typing import Optional, List, Dict

from core.storage.connection import _get_conn, closing

def get_confirmed_decisions(project_uuid: str, topic_id: str) -> List[Dict]:
    """Returns [{'text': '...', 'files': [...], 'evidence': '...'}]"""
    try:
        import json
        with closing(_get_conn()) as conn:
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
                            logging.error(f"Error parsing evidence_msg_ids JSON: {e}")
                            
                    decisions.append({
                        "text": f"{d_text} (原因: {rationale})",
                        "evidence": "\n".join(evidence_texts),
                        "decision_type": decision_type or "approved"
                    })
                return decisions
    except Exception as e:
        logging.error(f"Error in get_confirmed_decisions: {e}")
        return []

def confirm_decision(project_uuid: str, decision_id: int) -> bool:
    with closing(_get_conn()) as conn:
        with conn:
            cursor = conn.execute(
                "UPDATE topic_decisions SET user_confirmed=1, updated_at=CURRENT_TIMESTAMP WHERE id=? AND project_uuid=?",
                (decision_id, project_uuid)
            )
            return cursor.rowcount > 0

def get_topic_id_by_decision(decision_id: int) -> Optional[str]:
    try:
        with closing(_get_conn()) as conn:
            with conn:
                row = conn.execute("SELECT topic_id FROM topic_decisions WHERE id=?", (decision_id,)).fetchone()
                return row[0] if row else None
    except Exception as e:
        logging.error(f"Error in get_topic_id_by_decision: {e}")
        return None
