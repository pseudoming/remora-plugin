import Database from "better-sqlite3";
import {
  getRuntimeHookValue,
  setRuntimeHookValue,
  deleteRuntimeHookValue,
} from "./storage/runtime-state";

/**
 * Returns True if stored value != given value (or no stored value).
 */
export function shouldFire(
  conn: Database.Database,
  convId: string,
  key: string,
  value: unknown
): boolean {
  const prev = getRuntimeHookValue(conn, convId, -1, key);
  return String(prev) !== String(value);
}

/**
 * Record that this gate has fired for this value.
 */
export function markFired(
  conn: Database.Database,
  convId: string,
  key: string,
  value: unknown
): void {
  setRuntimeHookValue(conn, convId, -1, key, String(value));
}

/**
 * Returns True if this exact value was already recorded (same-window dedup).
 */
export function isDuplicate(
  conn: Database.Database,
  convId: string,
  key: string,
  value: unknown
): boolean {
  const prev = getRuntimeHookValue(conn, convId, -1, key);
  return String(prev) === String(value);
}

/**
 * Delete old record if stored value differs from new_value (cross-window re-alert).
 */
export function clearStale(
  conn: Database.Database,
  convId: string,
  key: string,
  newValue: unknown
): void {
  const prev = getRuntimeHookValue(conn, convId, -1, key);
  if (prev && String(prev) !== String(newValue)) {
    deleteRuntimeHookValue(conn, convId, -1, key);
  }
}

/**
 * Returns True every 5th user input.
 */
export function shouldInjectTone(userInputCount: number): boolean {
  return userInputCount % 5 === 0;
}
