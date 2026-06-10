import Database from "better-sqlite3";
import { getConn } from "./connection";

export function getRuntimeHookValue(
  sessionId: string,
  turnIdx: number,
  key: string,
  conn?: Database.Database,
): string | null {
  const db = conn ?? getConn();
  const ownConn = !conn;
  try {
    const row = db
      .prepare(
        "SELECT value FROM runtime_hook_state WHERE session_id = ? AND turn_idx = ? AND key = ?"
      )
      .get(sessionId, turnIdx, key) as { value: string } | undefined;
    return row ? row.value : null;
  } catch (e) {
    console.warn(`getRuntimeHookValue: ${e}`);
    return null;
  } finally {
    if (ownConn) db.close();
  }
}

export function setRuntimeHookValue(
  sessionId: string,
  turnIdx: number,
  key: string,
  value: string,
  conn?: Database.Database,
): void {
  const db = conn ?? getConn();
  const ownConn = !conn;
  try {
    db.prepare("BEGIN EXCLUSIVE").run();
    db
      .prepare(
        "INSERT INTO runtime_hook_state (session_id, turn_idx, key, value) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(session_id, turn_idx, key) DO UPDATE SET value = excluded.value"
      )
      .run(sessionId, turnIdx, key, value);
    db.prepare("COMMIT").run();
  } catch (e) {
    console.warn(`setRuntimeHookValue: ${e}`);
  } finally {
    if (ownConn) db.close();
  }
}

export function deleteRuntimeHookValue(
  sessionId: string,
  turnIdx: number,
  key: string,
  conn?: Database.Database,
): void {
  const db = conn ?? getConn();
  const ownConn = !conn;
  try {
    db.prepare("BEGIN EXCLUSIVE").run();
    db
      .prepare(
        "DELETE FROM runtime_hook_state WHERE session_id = ? AND turn_idx = ? AND key = ?"
      )
      .run(sessionId, turnIdx, key);
    db.prepare("COMMIT").run();
  } catch (e) {
    console.warn(`deleteRuntimeHookValue: ${e}`);
  } finally {
    if (ownConn) db.close();
  }
}

export function trimRuntimeHookStates(
  sessionId: string,
  currentTurnIdx: number,
  conn?: Database.Database,
): void {
  const db = conn ?? getConn();
  const ownConn = !conn;
  try {
    db.prepare("BEGIN EXCLUSIVE").run();
    db
      .prepare(
        "DELETE FROM runtime_hook_state WHERE session_id = ? AND turn_idx >= ?"
      )
      .run(sessionId, currentTurnIdx);
    db.prepare("COMMIT").run();
  } catch (e) {
    console.warn(`trimRuntimeHookStates: ${e}`);
  } finally {
    if (ownConn) db.close();
  }
}

export function getHookState(
  sessionId: string,
  turnIdx: number,
  key: string,
  conn?: Database.Database,
): string | null {
  return getRuntimeHookValue(sessionId, turnIdx, key, conn);
}

export function setHookState(
  sessionId: string,
  turnIdx: number,
  key: string,
  value: string,
  conn?: Database.Database,
): void {
  setRuntimeHookValue(sessionId, turnIdx, key, value, conn);
}

export function deleteHookState(
  sessionId: string,
  turnIdx: number,
  key: string,
  conn?: Database.Database,
): void {
  deleteRuntimeHookValue(sessionId, turnIdx, key, conn);
}

export function trimHookStates(
  sessionId: string,
  currentTurnIdx: number,
  conn?: Database.Database,
): void {
  trimRuntimeHookStates(sessionId, currentTurnIdx, conn);
}
