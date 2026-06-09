import json
from core.logger import warn as log_warn, error as log_error
from typing import Optional, List, Tuple

from core.storage.connection import get_conn, closing

def get_active_topic(project_uuid: str) -> Optional[str]:
    try:
        with closing(get_conn()) as conn:
            with conn:
                row = conn.execute("SELECT topic_id FROM project_topics WHERE uuid=? AND status='open' ORDER BY updated_at DESC LIMIT 1", (project_uuid,)).fetchone()
                return row[0] if row else None
    except Exception as e:
        log_warn(f"get_active_topic: {e}")
        return None

def create_or_update_topic(project_uuid: str, topic_id: str, summary: str = "", source: str = "auto") -> None:
    with closing(get_conn()) as conn:
        with conn:
            conn.execute(
                "INSERT INTO project_topics (uuid, topic_id, status, summary, source, last_accessed_at) "
                "VALUES (?, ?, 'open', ?, ?, CURRENT_TIMESTAMP) "
                "ON CONFLICT(uuid, topic_id) DO UPDATE SET status='open', summary=COALESCE(NULLIF(excluded.summary, ''), summary), source=excluded.source, last_accessed_at=CURRENT_TIMESTAMP",
                (project_uuid, topic_id, summary, source)
            )

def switch_topic(project_uuid: str, new_topic_id: str) -> None:
    with closing(get_conn()) as conn:
        with conn:
            conn.execute("UPDATE project_topics SET status='closed' WHERE uuid=?", (project_uuid,))
            conn.execute(
                "INSERT INTO project_topics (uuid, topic_id, status, last_accessed_at) VALUES (?, ?, 'open', CURRENT_TIMESTAMP) "
                "ON CONFLICT(uuid, topic_id) DO UPDATE SET status='open', last_accessed_at=CURRENT_TIMESTAMP",
                (project_uuid, new_topic_id)
            )

def close_topic(project_uuid: str, topic_id: str) -> None:
    with closing(get_conn()) as conn:
        with conn:
            conn.execute(
                "UPDATE project_topics SET status='closed', source='manual', last_accessed_at=CURRENT_TIMESTAMP WHERE uuid=? AND topic_id=?",
                (project_uuid, topic_id)
            )

def get_topics_by_uuid(project_uuid: str) -> List[Tuple[str, str, str]]:
    """Returns [(topic_id, status, summary)]"""
    try:
        with closing(get_conn()) as conn:
            with conn:
                return conn.execute("SELECT topic_id, status, summary FROM project_topics WHERE uuid=? ORDER BY created_at DESC", (project_uuid,)).fetchall()
    except Exception as e:
        log_warn(f"get_topics_by_uuid: {e}")
        return []

def touch_topic_source_manual(project_uuid: str, topic_id: str) -> None:
    with closing(get_conn()) as conn:
        with conn:
            conn.execute(
                "UPDATE project_topics SET source='manual', last_accessed_at=CURRENT_TIMESTAMP WHERE uuid=? AND topic_id=?",
                (project_uuid, topic_id)
            )

def merge_physical_files_to_topic(project_uuid: str, topic_id: str, physical_files: List[str]) -> None:
    import json
    with closing(get_conn()) as conn:
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

def get_open_topic(conn, project_uuid: str):
    """Returns topic_id of the currently open topic for this project, or None."""
    cursor = conn.execute(
        "SELECT topic_id FROM project_topics WHERE uuid=? AND status='open' ORDER BY updated_at DESC LIMIT 1",
        (project_uuid,))
    row = cursor.fetchone()
    return row[0] if row else None

def get_topic_files(conn, project_uuid: str, topic_id: str):
    """Returns (associated_files_json, referenced_files_json) for a topic."""
    cursor = conn.execute(
        "SELECT associated_files, referenced_files FROM project_topics WHERE uuid=? AND topic_id=?",
        (project_uuid, topic_id))
    row = cursor.fetchone()
    return (row[0] if row else None, row[1] if row else None)

def update_topic_files(conn, project_uuid: str, topic_id: str, associated_files: str, referenced_files: str) -> None:
    conn.execute(
        "UPDATE project_topics SET associated_files=?, referenced_files=?, last_accessed_at=CURRENT_TIMESTAMP WHERE uuid=? AND topic_id=?",
        (associated_files, referenced_files, project_uuid, topic_id))

def upsert_topic(conn, project_uuid: str, topic_id: str, summary: str, confidence: float) -> None:
    conn.execute(
        """INSERT INTO project_topics (uuid, topic_id, summary, compression_confidence, source)
           VALUES (?, ?, ?, ?, 'auto')
           ON CONFLICT(uuid, topic_id) DO UPDATE SET summary=?, compression_confidence=?""",
        (project_uuid, topic_id, summary, confidence, summary, confidence))

def get_all_project_uuids(conn) -> list:
    cursor = conn.execute("SELECT DISTINCT uuid FROM project_topics")
    return [row[0] for row in cursor.fetchall()]

def get_active_topic_created_at(project_uuid: str) -> Optional[str]:
    try:
        with closing(get_conn()) as conn:
            with conn:
                row = conn.execute(
                    "SELECT created_at FROM project_topics WHERE uuid=? AND status='open' ORDER BY updated_at DESC LIMIT 1",
                    (project_uuid,)
                ).fetchone()
                return row[0] if row else None
    except Exception as e:
        log_warn(f"get_active_topic_created_at: {e}")
        return None
