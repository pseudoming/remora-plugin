import Database from "better-sqlite3";

export function readMode(conn: Database.Database, sessionId: string, defaultMode: string = "standard"): string {
  try {
    const row = conn.prepare("SELECT mode FROM session_state WHERE session_id=?").get(sessionId) as { mode: string | null } | undefined;
    if (row && row.mode !== null) {
      return row.mode;
    }
    return defaultMode;
  } catch (e) {
    console.warn(`readMode: ${e}`);
    return defaultMode;
  }
}

export function writeMode(conn: Database.Database, sessionId: string, mode: string): void {
  conn.prepare(
    "INSERT INTO session_state (session_id, mode, is_cold_start, updated_at) VALUES (?, ?, 1, CURRENT_TIMESTAMP) " +
    "ON CONFLICT(session_id) DO UPDATE SET mode=excluded.mode, updated_at=CURRENT_TIMESTAMP"
  ).run(sessionId, mode);
}

/** Returns (session_id, is_cold_start) or null */
export function getLatestSession(conn: Database.Database): { session_id: string; is_cold_start: number } | null {
  try {
    const row = conn.prepare(
      "SELECT session_id, is_cold_start FROM session_state ORDER BY updated_at DESC LIMIT 1"
    ).get() as { session_id: string; is_cold_start: number } | undefined;
    return row ?? null;
  } catch (e) {
    console.warn(`getLatestSession: ${e}`);
    return null;
  }
}

export function updateColdStart(conn: Database.Database, sessionId: string, isColdStart: number): void {
  conn.prepare("UPDATE session_state SET is_cold_start = ? WHERE session_id=?").run(isColdStart, sessionId);
}

export function forceColdStartLatestSession(conn: Database.Database, mainConvId?: string): void {
  if (mainConvId) {
    conn.prepare(
      "INSERT INTO session_state (session_id, is_cold_start, updated_at) VALUES (?, 1, CURRENT_TIMESTAMP) " +
      "ON CONFLICT(session_id) DO UPDATE SET is_cold_start=1, updated_at=CURRENT_TIMESTAMP"
    ).run(mainConvId);
  } else {
    conn.prepare(
      `UPDATE session_state
       SET is_cold_start = 1, updated_at = CURRENT_TIMESTAMP
       WHERE session_id = (SELECT session_id FROM session_state ORDER BY updated_at DESC LIMIT 1)`
    ).run();
  }
}

/** Returns (session_id, mode, is_cold_start, updated_at) or null. */
export function getSession(conn: Database.Database, sessionId: string): { session_id: string; mode: string; is_cold_start: number; updated_at: string } | null {
  try {
    const row = conn.prepare(
      "SELECT session_id, mode, is_cold_start, updated_at FROM session_state WHERE session_id=?"
    ).get(sessionId) as { session_id: string; mode: string; is_cold_start: number; updated_at: string } | undefined;
    return row ?? null;
  } catch (e) {
    console.warn(`getSession: ${e}`);
    return null;
  }
}
