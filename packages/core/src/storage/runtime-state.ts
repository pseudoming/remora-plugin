import Database from "better-sqlite3";

export function getRuntimeHookValue(
  conn: Database.Database,
  sessionId: string,
  turnIdx: number,
  key: string
): string | null {
  try {
    const row = conn
      .prepare(
        "SELECT value FROM runtime_hook_state WHERE session_id = ? AND turn_idx = ? AND key = ?"
      )
      .get(sessionId, turnIdx, key) as { value: string } | undefined;
    return row ? row.value : null;
  } catch (e) {
    console.warn(`getRuntimeHookValue: ${e}`);
    return null;
  }
}

export function setRuntimeHookValue(
  conn: Database.Database,
  sessionId: string,
  turnIdx: number,
  key: string,
  value: string
): void {
  try {
    conn.prepare("BEGIN EXCLUSIVE").run();
    conn
      .prepare(
        "INSERT INTO runtime_hook_state (session_id, turn_idx, key, value) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(session_id, turn_idx, key) DO UPDATE SET value = excluded.value"
      )
      .run(sessionId, turnIdx, key, value);
    conn.prepare("COMMIT").run();
  } catch (e) {
    console.warn(`setRuntimeHookValue: ${e}`);
  }
}

export function deleteRuntimeHookValue(
  conn: Database.Database,
  sessionId: string,
  turnIdx: number,
  key: string
): void {
  try {
    conn.prepare("BEGIN EXCLUSIVE").run();
    conn
      .prepare(
        "DELETE FROM runtime_hook_state WHERE session_id = ? AND turn_idx = ? AND key = ?"
      )
      .run(sessionId, turnIdx, key);
    conn.prepare("COMMIT").run();
  } catch (e) {
    console.warn(`deleteRuntimeHookValue: ${e}`);
  }
}

export function trimRuntimeHookStates(
  conn: Database.Database,
  sessionId: string,
  currentTurnIdx: number
): void {
  try {
    conn.prepare("BEGIN EXCLUSIVE").run();
    conn
      .prepare(
        "DELETE FROM runtime_hook_state WHERE session_id = ? AND turn_idx >= ?"
      )
      .run(sessionId, currentTurnIdx);
    conn.prepare("COMMIT").run();
  } catch (e) {
    console.warn(`trimRuntimeHookStates: ${e}`);
  }
}

export function getHookState(
  conn: Database.Database,
  sessionId: string,
  turnIdx: number,
  key: string
): string | null {
  return getRuntimeHookValue(conn, sessionId, turnIdx, key);
}

export function setHookState(
  conn: Database.Database,
  sessionId: string,
  turnIdx: number,
  key: string,
  value: string
): void {
  setRuntimeHookValue(conn, sessionId, turnIdx, key, value);
}

export function deleteHookState(
  conn: Database.Database,
  sessionId: string,
  turnIdx: number,
  key: string
): void {
  deleteRuntimeHookValue(conn, sessionId, turnIdx, key);
}

export function trimHookStates(
  conn: Database.Database,
  sessionId: string,
  currentTurnIdx: number
): void {
  trimRuntimeHookStates(conn, sessionId, currentTurnIdx);
}
