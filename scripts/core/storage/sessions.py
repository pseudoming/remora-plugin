from core.logger import warn as log_warn, error as log_error
from typing import Optional, Tuple

from core.storage.connection import get_conn, closing

def read_mode(session_id: str, default: str = "standard") -> str:
    try:
        with closing(get_conn()) as conn:
            with conn:
                row = conn.execute("SELECT mode FROM session_state WHERE session_id=?", (session_id,)).fetchone()
                if row and row[0] is not None:
                    return row[0]
                return default
    except Exception as e:
        log_warn(f"read_mode: {e}")
        return default

def write_mode(session_id: str, mode: str) -> None:
    with closing(get_conn()) as conn:
        with conn:
            conn.execute(
                "INSERT INTO session_state (session_id, mode, is_cold_start, updated_at) VALUES (?, ?, 1, CURRENT_TIMESTAMP) "
                "ON CONFLICT(session_id) DO UPDATE SET mode=excluded.mode, updated_at=CURRENT_TIMESTAMP", 
                (session_id, mode)
            )

def get_latest_session() -> Optional[Tuple[str, int]]:
    """Returns (session_id, is_cold_start) or None"""
    try:
        with closing(get_conn()) as conn:
            with conn:
                return conn.execute("SELECT session_id, is_cold_start FROM session_state ORDER BY updated_at DESC LIMIT 1").fetchone()
    except Exception as e:
        log_warn(f"get_latest_session: {e}")
        return None

def update_cold_start(session_id: str, is_cold_start: int) -> None:
    with closing(get_conn()) as conn:
        with conn:
            conn.execute("UPDATE session_state SET is_cold_start = ? WHERE session_id=?", (is_cold_start, session_id))

def force_cold_start_latest_session(main_conv_id: Optional[str] = None) -> None:
    with closing(get_conn()) as conn:
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
