import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { getLatestNonUserMessages } from "../src/storage/messages";

let conn: Database.Database;

function insertMsg(
  convId: string,
  lineNumber: number,
  role: string,
  content: string | null,
  timestamp: string | null = null,
  topicId: string | null = null
): void {
  if (timestamp === null) {
    conn.prepare(
      "INSERT INTO messages (conversation_id, line_number, role, content, topic_id) VALUES (?, ?, ?, ?, ?)"
    ).run(convId, lineNumber, role, content, topicId);
  } else {
    conn.prepare(
      "INSERT INTO messages (conversation_id, line_number, timestamp, role, content, topic_id) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(convId, lineNumber, timestamp, role, content, topicId);
  }
}

describe("getLatestNonUserMessages", () => {
  beforeEach(() => {
    conn = new Database(":memory:");
    conn.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL,
        line_number INTEGER NOT NULL,
        timestamp TIMESTAMP,
        role TEXT,
        content TEXT,
        topic_id TEXT,
        UNIQUE(conversation_id, line_number)
      )
    `);
  });

  it("empty db returns empty", () => {
    const result = getLatestNonUserMessages(conn, "conv_1");
    expect(result).toEqual([]);
  });

  it("no matching conv id", () => {
    insertMsg("conv_1", 1, "model", "hello");
    const result = getLatestNonUserMessages(conn, "conv_2");
    expect(result).toEqual([]);
  });

  it("filters user roles", () => {
    insertMsg("conv_1", 1, "model", "model msg");
    insertMsg("conv_1", 2, "USER", "user msg");
    insertMsg("conv_1", 3, "USER_INPUT", "input msg");
    insertMsg("conv_1", 4, "user", "lower user");
    insertMsg("conv_1", 5, "USER_EXPLICIT", "explicit");
    const result = getLatestNonUserMessages(conn, "conv_1");
    expect(result.length).toBe(1);
    expect(result[0].content).toBe("model msg");
  });

  it("filters empty content", () => {
    insertMsg("conv_1", 1, "model", "");
    insertMsg("conv_1", 2, "model", null);
    insertMsg("conv_1", 3, "model", "valid");
    const result = getLatestNonUserMessages(conn, "conv_1");
    expect(result.length).toBe(1);
    expect(result[0].content).toBe("valid");
  });

  it("respects limit", () => {
    for (let i = 0; i < 10; i++) {
      insertMsg("conv_1", i, "model", `msg_${i}`);
    }
    const result = getLatestNonUserMessages(conn, "conv_1", 3);
    expect(result.length).toBe(3);
  });

  it("default limit is 5", () => {
    for (let i = 0; i < 10; i++) {
      insertMsg("conv_1", i, "tool", `msg_${i}`);
    }
    const result = getLatestNonUserMessages(conn, "conv_1");
    expect(result.length).toBe(5);
  });

  it("returns newest first", () => {
    insertMsg("conv_1", 1, "model", "oldest");
    insertMsg("conv_1", 2, "model", "newer");
    insertMsg("conv_1", 3, "model", "newest");
    const result = getLatestNonUserMessages(conn, "conv_1");
    expect(result[0].content).toBe("newest");
    expect(result[1].content).toBe("newer");
    expect(result[2].content).toBe("oldest");
  });

  it("includes timestamp and role", () => {
    const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
    insertMsg("conv_1", 1, "tool", "msg", ts);
    const result = getLatestNonUserMessages(conn, "conv_1");
    expect(result.length).toBe(1);
    expect(result[0].role).toBe("tool");
    expect(result[0].timestamp).not.toBeNull();
  });

  it("db connection error returns empty", () => {
    const badConn = new Database(":memory:");
    // 不创建 messages 表, prepare().all() 会抛出错误
    const result = getLatestNonUserMessages(badConn, "conv_error");
    expect(result).toEqual([]);
  });
});
