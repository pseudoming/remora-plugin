import logging
from typing import Optional

from core.storage.connection import _get_conn, closing

def get_project_uuid_by_conv(session_id: str) -> Optional[str]:
    try:
        with closing(_get_conn()) as conn:
            with conn:
                row = conn.execute("SELECT project_uuid FROM watermarks WHERE conversation_id=? LIMIT 1", (session_id,)).fetchone()
                return row[0] if row else None
    except Exception as e:
        logging.error(f"Error in get_project_uuid_by_conv: {e}")
        return None

def watermark_exists(project_uuid: str, conversation_id: str) -> bool:
    try:
        with closing(_get_conn()) as conn:
            with conn:
                row = conn.execute(
                    "SELECT 1 FROM watermarks WHERE project_uuid=? AND conversation_id=? LIMIT 1",
                    (project_uuid, conversation_id)
                ).fetchone()
                return row is not None
    except Exception as e:
        logging.error(f"Error in watermark_exists: {e}")
        return False

def get_active_topic_created_at(project_uuid: str) -> Optional[str]:
    try:
        with closing(_get_conn()) as conn:
            with conn:
                row = conn.execute(
                    "SELECT created_at FROM project_topics WHERE uuid=? AND status='open' LIMIT 1",
                    (project_uuid,)
                ).fetchone()
                return row[0] if row else None
    except Exception as e:
        logging.error(f"Error in get_active_topic_created_at: {e}")
        return None
