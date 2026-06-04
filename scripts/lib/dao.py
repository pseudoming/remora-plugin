import sqlite3
import logging
from typing import Optional, List, Dict, Tuple
from contextlib import closing
from lib.paths import get_db_path

def _get_conn() -> sqlite3.Connection:
    return sqlite3.connect(get_db_path(), timeout=15.0)

def check_db_exists() -> bool:
    import os
    return os.path.exists(get_db_path())

# ==========================================
# Session State Operations
# ==========================================
def read_mode(session_id: str, default: str = "standard") -> str:
    try:
        with closing(_get_conn()) as conn:
            with conn:
                row = conn.execute("SELECT mode FROM session_state WHERE session_id=?", (session_id,)).fetchone()
                if row and row[0] is not None:
                    return row[0]
                return default
    except Exception as e:
        logging.error(f"Error in read_mode: {e}")
        return default

def write_mode(session_id: str, mode: str) -> None:
    with closing(_get_conn()) as conn:
        with conn:
            conn.execute(
                "INSERT INTO session_state (session_id, mode, is_cold_start, updated_at) VALUES (?, ?, 1, CURRENT_TIMESTAMP) "
                "ON CONFLICT(session_id) DO UPDATE SET mode=excluded.mode, updated_at=CURRENT_TIMESTAMP", 
                (session_id, mode)
            )

def get_latest_session() -> Optional[Tuple[str, int]]:
    """Returns (session_id, is_cold_start) or None"""
    try:
        with closing(_get_conn()) as conn:
            with conn:
                return conn.execute("SELECT session_id, is_cold_start FROM session_state ORDER BY updated_at DESC LIMIT 1").fetchone()
    except Exception as e:
        logging.error(f"Error in get_latest_session: {e}")
        return None

def update_cold_start(session_id: str, is_cold_start: int) -> None:
    with closing(_get_conn()) as conn:
        with conn:
            conn.execute("UPDATE session_state SET is_cold_start = ? WHERE session_id=?", (is_cold_start, session_id))

def delete_session(session_id: str) -> None:
    with closing(_get_conn()) as conn:
        with conn:
            conn.execute("DELETE FROM session_state WHERE session_id=?", (session_id,))

# ==========================================
# Watermarks Operations
# ==========================================
def get_project_uuid_by_conv(session_id: str) -> Optional[str]:
    try:
        with closing(_get_conn()) as conn:
            with conn:
                row = conn.execute("SELECT project_uuid FROM watermarks WHERE conversation_id=? LIMIT 1", (session_id,)).fetchone()
                return row[0] if row else None
    except Exception as e:
        logging.error(f"Error in get_project_uuid_by_conv: {e}")
        return None

# ==========================================
# Topic Operations
# ==========================================
def get_active_topic(project_uuid: str) -> Optional[str]:
    try:
        with closing(_get_conn()) as conn:
            with conn:
                row = conn.execute("SELECT topic_id FROM project_topics WHERE uuid=? AND status='open' LIMIT 1", (project_uuid,)).fetchone()
                return row[0] if row else None
    except Exception as e:
        logging.error(f"Error in get_active_topic: {e}")
        return None

def create_or_update_topic(project_uuid: str, topic_id: str, summary: str = "", source: str = "auto") -> None:
    with closing(_get_conn()) as conn:
        with conn:
            conn.execute(
                "INSERT INTO project_topics (uuid, topic_id, status, summary, source, last_accessed_at) "
                "VALUES (?, ?, 'open', ?, ?, CURRENT_TIMESTAMP) "
                "ON CONFLICT(uuid, topic_id) DO UPDATE SET status='open', summary=COALESCE(NULLIF(excluded.summary, ''), summary), source=excluded.source, last_accessed_at=CURRENT_TIMESTAMP",
                (project_uuid, topic_id, summary, source)
            )

def switch_topic(project_uuid: str, new_topic_id: str) -> None:
    with closing(_get_conn()) as conn:
        with conn:
            conn.execute("UPDATE project_topics SET status='closed' WHERE uuid=?", (project_uuid,))
            conn.execute(
                "INSERT INTO project_topics (uuid, topic_id, status, last_accessed_at) VALUES (?, ?, 'open', CURRENT_TIMESTAMP) "
                "ON CONFLICT(uuid, topic_id) DO UPDATE SET status='open', last_accessed_at=CURRENT_TIMESTAMP",
                (project_uuid, new_topic_id)
            )

def close_topic(project_uuid: str, topic_id: str) -> None:
    with closing(_get_conn()) as conn:
        with conn:
            conn.execute(
                "UPDATE project_topics SET status='closed', source='manual', last_accessed_at=CURRENT_TIMESTAMP WHERE uuid=? AND topic_id=?",
                (project_uuid, topic_id)
            )

def get_topics_by_uuid(project_uuid: str) -> List[Tuple[str, str, str]]:
    """Returns [(topic_id, status, summary)]"""
    try:
        with closing(_get_conn()) as conn:
            with conn:
                return conn.execute("SELECT topic_id, status, summary FROM project_topics WHERE uuid=? ORDER BY created_at DESC", (project_uuid,)).fetchall()
    except Exception as e:
        logging.error(f"Error in get_topics_by_uuid: {e}")
        return []

def get_topic_associated_files(project_uuid: str, topic_id: str) -> str:
    try:
        with closing(_get_conn()) as conn:
            with conn:
                row = conn.execute("SELECT associated_files FROM project_topics WHERE uuid=? AND topic_id=?", (project_uuid, topic_id)).fetchone()
                return row[0] if (row and row[0]) else "[]"
    except Exception as e:
        logging.error(f"Error in get_topic_associated_files: {e}")
        return "[]"

def update_topic_associated_files(project_uuid: str, topic_id: str, files_json: str) -> None:
    with closing(_get_conn()) as conn:
        with conn:
            conn.execute("UPDATE project_topics SET associated_files=? WHERE uuid=? AND topic_id=?", (files_json, project_uuid, topic_id))

def force_cold_start_latest_session(main_conv_id: Optional[str] = None) -> None:
    with closing(_get_conn()) as conn:
        with conn:
            if main_conv_id:
                conn.execute(
                    "INSERT INTO session_state (session_id, is_cold_start, updated_at) VALUES (?, 1, CURRENT_TIMESTAMP) "
                    "ON CONFLICT(session_id) DO UPDATE SET is_cold_start=1, updated_at=CURRENT_TIMESTAMP",
                    (main_conv_id,)
                )
            else:
                conn.execute("""
                    UPDATE session_state 
                    SET is_cold_start = 1, updated_at = CURRENT_TIMESTAMP
                    WHERE session_id = (SELECT session_id FROM session_state ORDER BY updated_at DESC LIMIT 1)
                """)

# ==========================================
# Topic Decisions Operations
# ==========================================
def get_confirmed_decisions(project_uuid: str, topic_id: str) -> List[Dict]:
    """Returns [{'text': '...', 'files': [...], 'evidence': '...'}]"""
    try:
        import json
        with closing(_get_conn()) as conn:
            with conn:
                rows = conn.execute(
                    "SELECT decision, rationale, evidence_msg_ids, associated_files FROM topic_decisions WHERE project_uuid=? AND topic_id=? AND user_confirmed=1 ORDER BY created_at ASC", 
                    (project_uuid, topic_id)
                ).fetchall()
                
                decisions = []
                for d_text, rationale, evidence_msg_ids_json, files_json in rows:
                    files = []
                    if files_json:
                        try:
                            files = [item.get('file', '') for item in json.loads(files_json) if 'file' in item]
                        except Exception as e:
                            logging.error(f"Error parsing decision JSON files: {e}")
                    
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
                        "files": files,
                        "evidence": "\n".join(evidence_texts)
                    })
                return decisions
    except Exception as e:
        logging.error(f"Error in get_confirmed_decisions: {e}")
        return []

def confirm_decision(project_uuid: str, decision_id: int) -> bool:
    with closing(_get_conn()) as conn:
        with conn:
            cursor = conn.execute(
                "UPDATE topic_decisions SET user_confirmed=1 WHERE id=? AND project_uuid=?",
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

def touch_topic_source_manual(project_uuid: str, topic_id: str) -> None:
    with closing(_get_conn()) as conn:
        with conn:
            conn.execute(
                "UPDATE project_topics SET source='manual', last_accessed_at=CURRENT_TIMESTAMP WHERE uuid=? AND topic_id=?",
                (project_uuid, topic_id)
            )

# ==========================================
# FTS5 Recall Operations (remora-recall.py)
# ==========================================
def recall_fts5_logs(project_uuid: str, conv_id: str, keyword: str, limit: int = 10) -> List[str]:
    try:
        safe_keyword = keyword.replace('"', '""')
        with closing(_get_conn()) as conn:
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
        logging.error(f"Error in recall_fts5_logs: {e}")
        return []

def recall_decisions_by_fts5_topic(project_uuid: str, conv_id: str, keyword: str) -> List[str]:
    try:
        import json
        safe_keyword = keyword.replace('"', '""')
        with closing(_get_conn()) as conn:
            with conn:
                cursor = conn.cursor()
                cursor.execute("""
                    SELECT topic_id, decision, rationale, evidence_msg_ids
                    FROM topic_decisions
                    WHERE (project_uuid = ? OR conversation_id = ?)
                    AND topic_id IN (
                        SELECT DISTINCT m.topic_id
                        FROM messages m
                        JOIN messages_fts fts ON m.id = fts.rowid
                        WHERE m.conversation_id IN (
                            SELECT conversation_id FROM watermarks WHERE project_uuid = ?
                            UNION
                            SELECT ? WHERE ? != ''
                        )
                        AND fts.content MATCH ?
                    )
                """, (project_uuid, conv_id, project_uuid, conv_id, conv_id, f'"{safe_keyword}"'))
                
                results = []
                for topic_id, decision, rationale, evidence_ids_json in cursor.fetchall():
                    evidence_texts = []
                    if evidence_ids_json:
                        try:
                            msg_ids = json.loads(evidence_ids_json)
                            for mid in msg_ids:
                                msg_row = conn.execute("SELECT content FROM messages WHERE id=?", (mid,)).fetchone()
                                if msg_row:
                                    evidence_texts.append(msg_row[0][:200] + "...")
                        except:
                            pass
                    evidence_str = f" [证据: {' | '.join(evidence_texts)}]" if evidence_texts else ""
                    results.append(f"[{topic_id}] {decision} (原因: {rationale}){evidence_str}")
                return results
    except Exception as e:
        logging.error(f"Error in recall_decisions_by_fts5_topic: {e}")
        return []

def recall_decisions_by_like(project_uuid: str, conv_id: str, keyword: str, limit: int = 5) -> List[str]:
    try:
        import json
        # Prevent LIKE wildcard injection
        safe_keyword = keyword.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        like_pattern = f"%{safe_keyword}%"
        with closing(_get_conn()) as conn:
            with conn:
                cursor = conn.cursor()
                cursor.execute("""
                    SELECT topic_id, decision, rationale, evidence_msg_ids
                    FROM topic_decisions
                    WHERE (project_uuid = ? OR conversation_id = ?)
                    AND (decision LIKE ? ESCAPE '\\' OR rationale LIKE ? ESCAPE '\\')
                    LIMIT ?
                """, (project_uuid, conv_id, like_pattern, like_pattern, limit))
                
                results = []
                for topic_id, decision, rationale, evidence_ids_json in cursor.fetchall():
                    evidence_texts = []
                    if evidence_ids_json:
                        try:
                            msg_ids = json.loads(evidence_ids_json)
                            for mid in msg_ids:
                                msg_row = conn.execute("SELECT content FROM messages WHERE id=?", (mid,)).fetchone()
                                if msg_row:
                                    evidence_texts.append(msg_row[0][:200] + "...")
                        except:
                            pass
                    evidence_str = f" [证据: {' | '.join(evidence_texts)}]" if evidence_texts else ""
                    results.append(f"[{topic_id}] {decision} (原因: {rationale}){evidence_str}")
                return results
    except Exception as e:
        logging.error(f"Error in recall_decisions_by_like: {e}")
        return []

def touch_topics_accessed_by_recall(project_uuid: str, conv_id: str, keyword: str) -> None:
    with closing(_get_conn()) as conn:
        with conn:
            safe_keyword = keyword.replace('"', '""')
            conn.execute("""
                UPDATE project_topics SET last_accessed_at = CURRENT_TIMESTAMP
                WHERE uuid = ? 
                AND topic_id IN (
                    SELECT topic_id FROM (
                        SELECT DISTINCT m.topic_id, m.id
                        FROM messages m
                        JOIN messages_fts fts ON m.id = fts.rowid
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
                        LIMIT 5
                    )
                )
            """, (project_uuid, project_uuid, conv_id, conv_id, f'"{safe_keyword}"', project_uuid, conv_id, f"%{safe_keyword}%", f"%{safe_keyword}%"))

# ==========================================
# GC Operations (session_gc.py, topic_gc.py)
# ==========================================
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


def merge_physical_files_to_topic(project_uuid: str, topic_id: str, physical_files: List[str]) -> None:
    import json
    with closing(_get_conn()) as conn:
        with conn:
            conn.execute("BEGIN EXCLUSIVE")
            row = conn.execute("SELECT associated_files FROM project_topics WHERE uuid=? AND topic_id=?", (project_uuid, topic_id)).fetchone()
            existing_assoc_json = row[0] if (row and row[0]) else "[]"
            try:
                existing_assoc = json.loads(existing_assoc_json)
            except:
                existing_assoc = []
            
            assoc_dict = {item.get('file'): item for item in existing_assoc if 'file' in item}
            for pf in physical_files:
                if pf not in assoc_dict:
                    assoc_dict[pf] = {"file": pf, "source": "physical"}
                elif "physical" not in assoc_dict[pf].get("source", ""):
                    assoc_dict[pf]["source"] = assoc_dict[pf]["source"] + ", physical"
                    
            conn.execute("UPDATE project_topics SET associated_files=? WHERE uuid=? AND topic_id=?", (json.dumps(list(assoc_dict.values())), project_uuid, topic_id))
