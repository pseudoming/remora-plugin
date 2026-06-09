import Database from "better-sqlite3";

const DB_PATH =
  process.env.REMORA_DB_PATH ??
  process.env.HOME + "/.remora/data/remora_memory.db";

export function getDbPath(): string {
  return DB_PATH;
}

export function getConn(): Database.Database {
  return new Database(getDbPath(), { timeout: 15000 });
}

export function checkDbExists(): boolean {
  try {
    const stat = require("node:fs").statSync(getDbPath());
    return stat.isFile();
  } catch {
    return false;
  }
}
