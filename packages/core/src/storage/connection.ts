import DatabaseConstructor from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";

const Database = (DatabaseConstructor && (DatabaseConstructor as any).default) || DatabaseConstructor;

export function getDbPath(): string {
  return process.env.REMORA_DB_PATH ?? process.env.HOME + "/.remora/data/remora_memory.db";
}

export function getConn(): any {
  const dbPath = getDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  return new Database(dbPath, { timeout: 15000 });
}

export function checkDbExists(): boolean {
  try {
    const stat = fs.statSync(getDbPath());
    return stat.isFile();
  } catch {
    return false;
  }
}
