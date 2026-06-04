def read_mode(session_id: str, default: str = "standard") -> str:
    from lib.paths import get_db_path
    import sqlite3
    try:
        with sqlite3.connect(get_db_path()) as conn:
            row = conn.execute("SELECT mode FROM session_state WHERE session_id=?", (session_id,)).fetchone()
            return row[0] if row else default
    except:
        return default

def write_mode(session_id: str, mode: str):
    from lib.paths import get_db_path
    import sqlite3
    try:
        with sqlite3.connect(get_db_path()) as conn:
            conn.execute("INSERT INTO session_state (session_id, mode, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(session_id) DO UPDATE SET mode=excluded.mode, updated_at=CURRENT_TIMESTAMP", (session_id, mode))
            conn.commit()
    except:
        pass