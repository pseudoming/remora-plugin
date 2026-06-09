import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import {
  runTopicGarbageCollection,
  pruneExpiredWatermarks,
} from "../src/storage/maintenance";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS project_topics (
      uuid TEXT,
      topic_id TEXT,
      status TEXT DEFAULT 'open',
      summary TEXT,
      source TEXT DEFAULT 'auto',
      last_accessed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(uuid, topic_id)
  );
  CREATE TABLE IF NOT EXISTS topic_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_uuid TEXT,
      topic_id TEXT,
      conversation_id TEXT,
      decision TEXT,
      rationale TEXT,
      user_confirmed INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS watermarks (
      conversation_id TEXT PRIMARY KEY,
      project_uuid TEXT,
      last_msg_id INTEGER DEFAULT 0,
      last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT,
      timestamp TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS session_state (
      session_id TEXT PRIMARY KEY
  );
`;

function createTempDb(): string {
  const tmpDir = os.tmpdir();
  const tmpFile = path.join(
    tmpDir,
    `test_concurrency_${Date.now()}_${Math.random().toString(36).slice(2)}.db`
  );
  const db = new Database(tmpFile);
  db.pragma("journal_mode = DELETE");
  db.exec(SCHEMA);
  db.close();
  return tmpFile;
}

function mockExit() {
  const original = process.exit;
  process.exit = ((code?: number) => {
    throw new Error(`EXIT_${code ?? 0}`);
  }) as any;
  return () => {
    process.exit = original;
  };
}

describe("runTopicGarbageCollection lock contention", () => {
  it("test_run_topic_garbage_collection_lock_contention", () => {
    const dbFile = createTempDb();
    const conn = new Database(dbFile, { timeout: 100 });
    const restore = mockExit();

    try {
      const lockConn = new Database(dbFile);
      lockConn.exec(
        "BEGIN EXCLUSIVE; INSERT INTO project_topics (uuid, topic_id) VALUES ('u1', 't1');"
      );

      expect(() => runTopicGarbageCollection(conn)).toThrow("EXIT_1");

      lockConn.exec("ROLLBACK");
      lockConn.close();
    } finally {
      restore();
      conn.close();
      fs.unlinkSync(dbFile);
    }
  }, 10000);
});

describe("pruneExpiredWatermarks lock contention", () => {
  it("test_prune_expired_watermarks_lock_contention", () => {
    const dbFile = createTempDb();
    const conn = new Database(dbFile, { timeout: 100 });
    const restore = mockExit();

    const brainDir = path.join(
      os.tmpdir(),
      `brain_${Date.now()}_${Math.random().toString(36).slice(2)}`
    );
    fs.mkdirSync(brainDir);

    try {
      conn.exec(
        "INSERT INTO watermarks (conversation_id, project_uuid, last_updated) VALUES ('c_expired', 'p1', datetime('now', '-40 days'));"
      );

      const lockConn = new Database(dbFile);
      lockConn.exec(
        "BEGIN EXCLUSIVE; INSERT INTO project_topics (uuid, topic_id) VALUES ('u2', 't2');"
      );

      expect(() => pruneExpiredWatermarks(conn, brainDir)).toThrow("EXIT_1");

      lockConn.exec("ROLLBACK");
      lockConn.close();
    } finally {
      restore();
      conn.close();
      fs.rmSync(brainDir, { recursive: true, force: true });
      fs.unlinkSync(dbFile);
    }
  }, 10000);
});
