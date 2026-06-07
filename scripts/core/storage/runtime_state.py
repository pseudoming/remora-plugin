import logging
from typing import Optional

from core.storage.connection import _get_conn, closing

def get_runtime_hook_value(session_id: str, turn_idx: int, key: str) -> Optional[str]:
    try:
        with closing(_get_conn()) as conn:
            with conn:
                row = conn.execute(
                    "SELECT value FROM runtime_hook_state WHERE session_id = ? AND turn_idx = ? AND key = ?",
                    (session_id, turn_idx, key)
                ).fetchone()
                return row[0] if row else None
    except Exception as e:
        logging.error(f"Error in get_runtime_hook_value: {e}")
        return None

def set_runtime_hook_value(session_id: str, turn_idx: int, key: str, value: str) -> None:
    try:
        with closing(_get_conn()) as conn:
            with conn:
                conn.execute("BEGIN EXCLUSIVE")
                conn.execute(
                    "INSERT INTO runtime_hook_state (session_id, turn_idx, key, value) VALUES (?, ?, ?, ?) "
                    "ON CONFLICT(session_id, turn_idx, key) DO UPDATE SET value = excluded.value",
                    (session_id, turn_idx, key, value)
                )
    except Exception as e:
        logging.error(f"Error in set_runtime_hook_value: {e}")

def delete_runtime_hook_value(session_id: str, turn_idx: int, key: str) -> None:
    try:
        with closing(_get_conn()) as conn:
            with conn:
                conn.execute("BEGIN EXCLUSIVE")
                conn.execute(
                    "DELETE FROM runtime_hook_state WHERE session_id = ? AND turn_idx = ? AND key = ?",
                    (session_id, turn_idx, key)
                )
    except Exception as e:
        logging.error(f"Error in delete_runtime_hook_value: {e}")

def trim_runtime_hook_states(session_id: str, current_turn_idx: int) -> None:
    try:
        with closing(_get_conn()) as conn:
            with conn:
                conn.execute("BEGIN EXCLUSIVE")
                conn.execute(
                    "DELETE FROM runtime_hook_state WHERE session_id = ? AND turn_idx >= ?",
                    (session_id, current_turn_idx)
                )
    except Exception as e:
        logging.error(f"Error in trim_runtime_hook_states: {e}")

def get_hook_state(session_id: str, turn_idx: int, key: str) -> Optional[str]:
    return get_runtime_hook_value(session_id, turn_idx, key)

def set_hook_state(session_id: str, turn_idx: int, key: str, value: str) -> None:
    set_runtime_hook_value(session_id, turn_idx, key, value)

def delete_hook_state(session_id: str, turn_idx: int, key: str) -> None:
    delete_runtime_hook_value(session_id, turn_idx, key)

def trim_hook_states(session_id: str, current_turn_idx: int) -> None:
    trim_runtime_hook_states(session_id, current_turn_idx)
