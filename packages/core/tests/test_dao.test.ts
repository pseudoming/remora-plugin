import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const { testDbPath } = vi.hoisted(() => {
  const ref: { path: string } = { path: "" };
  return { testDbPath: ref };
});

vi.mock("../src/storage/connection", () => {
  const Database = require("better-sqlite3");
  const fs = require("node:fs");
  return {
    getDbPath: () => testDbPath.path,
    getConn: () => new Database(testDbPath.path, { timeout: 15000 }),
    checkDbExists: () => {
      try {
        return fs.statSync(testDbPath.path).isFile();
      } catch {
        return false;
      }
    },
  };
});

import * as dao from "../src/dao";
import * as decisionsMod from "../src/storage/decisions";
import * as connectionMod from "../src/storage/connection";

const TEST_DB_PATH = path.join(os.tmpdir(), "test_remora_dao.db");

const SCHEMA = `
    CREATE TABLE session_state (
        session_id TEXT PRIMARY KEY,
        mode TEXT DEFAULT 'standard',
        is_cold_start INTEGER DEFAULT 1,
        updated_at DATETIME
    );
    CREATE TABLE watermarks (
        conversation_id TEXT PRIMARY KEY,
        project_uuid TEXT,
        last_msg_id INTEGER DEFAULT 0,
        last_updated DATETIME
    );
    CREATE TABLE project_topics (
        uuid TEXT,
        topic_id TEXT,
        status TEXT DEFAULT 'open',
        summary TEXT,
        source TEXT DEFAULT 'auto',
        associated_files TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_accessed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(uuid, topic_id)
    );
    CREATE TABLE topic_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_uuid TEXT,
        topic_id TEXT,
        conversation_id TEXT,
        decision TEXT,
        rationale TEXT,
        evidence_msg_ids TEXT,
        user_confirmed INTEGER DEFAULT 0,
        decision_type TEXT DEFAULT 'approved',
        injected_count INTEGER DEFAULT 0,
        last_injected_at TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT,
        topic_id TEXT,
        role TEXT,
        content TEXT,
        line_number INTEGER,
        timestamp DATETIME
    );
    CREATE VIRTUAL TABLE messages_fts USING fts5(content, content_rowid='id');
    CREATE TABLE runtime_hook_state (
        session_id TEXT NOT NULL,
        turn_idx INTEGER NOT NULL,
        key TEXT NOT NULL,
        value TEXT,
        PRIMARY KEY(session_id, turn_idx, key)
    );
    CREATE TABLE IF NOT EXISTS file_changes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_uuid TEXT,
        conversation_id TEXT,
        file_name TEXT,
        source TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(conversation_id, file_name)
    );
`;

function createConn(): Database.Database {
  return new Database(TEST_DB_PATH, { timeout: 15000 });
}

function initSchema(): void {
  const conn = createConn();
  conn.exec(SCHEMA);
  conn.close();
}

function brokenConn(): Database.Database {
  return {
    prepare: () => {
      throw new Error("mock error");
    },
    exec: () => {
      throw new Error("mock error");
    },
    transaction: () => () => {
      throw new Error("mock error");
    },
    close: () => {},
  } as unknown as Database.Database;
}

process.env.HOME = "/tmp";

beforeEach(() => {
  try {
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  } catch {}
  process.env.REMORA_DB_PATH = TEST_DB_PATH;
  testDbPath.path = TEST_DB_PATH;
  initSchema();
});

afterEach(() => {
  try {
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  } catch {}
});

describe("test_session_state_operations", () => {
  it("test session state operations", () => {
    const conn = createConn();
    // Test read/write mode
    expect(dao.readMode("session_1")).toBe("standard");
    dao.writeMode("session_1", "relax");
    expect(dao.readMode("session_1")).toBe("relax");

    // Test cold start
    const latest = dao.getLatestSession();
    expect(latest).not.toBeNull();
    expect(latest!.session_id).toBe("session_1");
    expect(latest!.is_cold_start).toBe(1); // is_cold_start defaults to 1 when inserted

    dao.updateColdStart("session_1", 0);
    const latest2 = dao.getLatestSession();
    expect(latest2!.is_cold_start).toBe(0);

    conn.close();
  });
});

describe("test_watermark_operations", () => {
  it("test watermark operations", () => {
    const conn = createConn();
    expect(dao.getProjectUuidByConv("conv_1")).toBeNull();

    conn.prepare(
      "INSERT INTO watermarks (conversation_id, project_uuid) VALUES ('conv_1', 'proj_1')"
    ).run();

    expect(dao.getProjectUuidByConv("conv_1")).toBe("proj_1");

    conn.close();
  });
});

describe("test_topic_operations", () => {
  it("test topic operations", () => {
    const conn = createConn();
    expect(dao.getActiveTopic("proj_1")).toBeNull();

    dao.createOrUpdateTopic("proj_1", "topic_A", "My Topic A");
    expect(dao.getActiveTopic("proj_1")).toBe("topic_A");

    // Updating same topic
    dao.createOrUpdateTopic("proj_1", "topic_A", "My Topic A updated");
    const topics = dao.getTopicsByUuid("proj_1");
    expect(topics.length).toBe(1);
    expect(topics[0].summary).toBe("My Topic A updated");

    // Updating with empty summary should not overwrite
    dao.createOrUpdateTopic("proj_1", "topic_A", "");
    const topics2 = dao.getTopicsByUuid("proj_1");
    expect(topics2[0].summary).toBe("My Topic A updated");

    // Closing topic
    dao.closeTopic("proj_1", "topic_A");
    expect(dao.getActiveTopic("proj_1")).toBeNull();
    const topics3 = dao.getTopicsByUuid("proj_1");
    expect(topics3[0].status).toBe("closed");

    conn.close();
  });
});

describe("test_decision_operations", () => {
  it("test decision operations", () => {
    const conn = createConn();
    // Insert some test data
    conn.exec(`
      INSERT INTO messages (id, conversation_id, content) VALUES (1, 'c1', 'Evidence for python');
      INSERT INTO messages (id, conversation_id, content) VALUES (2, 'c1', 'Evidence for rust');

      INSERT INTO topic_decisions (project_uuid, topic_id, decision, rationale, user_confirmed, evidence_msg_ids)
      VALUES ('proj_1', 'topic_A', 'Use python', 'It is fast to write', 1, '[1]');

      INSERT INTO topic_decisions (project_uuid, topic_id, decision, rationale, user_confirmed, evidence_msg_ids)
      VALUES ('proj_1', 'topic_A', 'Use rust', 'It is memory safe', 0, '[2]');
    `);
    conn.close();

    const decisions = dao.getConfirmedDecisions("proj_1", "topic_A");
    expect(decisions.length).toBe(1);
    expect(decisions[0].text).toBe("Use python (原因: It is fast to write)");
    expect(decisions[0].decision_type).toBe("approved");
    expect(decisions[0].evidence).toBe("Evidence for python");
  });
});

describe("test_fts5_recall_operations", () => {
  it("test fts5 recall operations", () => {
    const conn = createConn();
    conn.exec(`
      INSERT INTO watermarks (conversation_id, project_uuid) VALUES ('conv_1', 'proj_1');

      INSERT INTO messages (id, conversation_id, topic_id, role, content) VALUES (1, 'conv_1', '["topic_A"]', 'user', 'hello world 202606606');
      INSERT INTO messages_fts (rowid, content) VALUES (1, 'hello world 202606606');

      INSERT INTO topic_decisions (project_uuid, conversation_id, topic_id, decision, rationale, evidence_msg_ids)
      VALUES ('proj_1', 'conv_1', 'topic_A', 'Log correctly', 'Need logs to debug 202606606', '[1]');
    `);

    // test recall_fts5_logs
    const logs = dao.recallFts5Logs("proj_1", "conv_1", "202606606");
    expect(logs.length).toBe(1);
    expect(logs[0]).toBe("user: hello world 202606606");

    // test recall_decisions_by_fts5_topic
    const decisions = dao.recallDecisionsByFts5Topic(
      "proj_1",
      "conv_1",
      "202606606"
    );
    expect(decisions.length).toBe(1);
    expect(
      decisions[0].includes(
        "[topic_A] Log correctly (原因: Need logs to debug 202606606) [证据: hello world 202606606...]"
      )
    ).toBe(true);

    // test recall_decisions_by_like
    const likeDecisions = dao.recallDecisionsByLike(
      "proj_1",
      "conv_1",
      "202606606"
    );
    expect(likeDecisions.length).toBe(1);
    expect(
      likeDecisions[0].includes(
        "[topic_A] Log correctly (原因: Need logs to debug 202606606) [证据: hello world 202606606...]"
      )
    ).toBe(true);

    // test touch_topics
    // first fetch last_accessed
    conn.prepare(
      "INSERT INTO project_topics (uuid, topic_id, last_accessed_at) VALUES ('proj_1', 'topic_A', '2000-01-01 00:00:00')"
    ).run();

    dao.touchTopicsAccessedByRecall("proj_1", "conv_1", "202606606");

    const row = conn
      .prepare(
        "SELECT last_accessed_at FROM project_topics WHERE uuid='proj_1' AND topic_id='topic_A'"
      )
      .get() as { last_accessed_at: string };
    expect(row.last_accessed_at).not.toBe("2000-01-01 00:00:00");

    conn.close();
  });
});

describe("test_topic_garbage_collection", () => {
  it("test topic garbage collection", () => {
    const conn = createConn();
    conn.exec(`
      -- Topic 1: Old last_accessed_at, but recent messages -> Should NOT be deleted
      INSERT INTO project_topics (uuid, topic_id, status, source, last_accessed_at) VALUES ('p1', 't1', 'closed', 'auto', '2000-01-01 00:00:00');
      INSERT INTO topic_decisions (project_uuid, topic_id, user_confirmed, created_at) VALUES ('p1', 't1', 0, datetime('now', '-1 hours'));

      -- Topic 2: Old last_accessed_at, old messages -> Should be deleted
      INSERT INTO project_topics (uuid, topic_id, status, source, last_accessed_at) VALUES ('p1', 't2', 'closed', 'auto', '2000-01-01 00:00:00');
      INSERT INTO topic_decisions (project_uuid, topic_id, user_confirmed, created_at) VALUES ('p1', 't2', 0, datetime('now', '-80 hours'));

      -- Topic 3: Old last_accessed_at, old messages, but has user_confirmed=1 -> Should NOT be deleted
      INSERT INTO project_topics (uuid, topic_id, status, source, last_accessed_at) VALUES ('p1', 't3', 'closed', 'auto', '2000-01-01 00:00:00');
      INSERT INTO topic_decisions (project_uuid, topic_id, user_confirmed, created_at) VALUES ('p1', 't3', 1, datetime('now', '-80 hours'));
    `);
    conn.close();

    const gcConn = createConn();
    dao.runTopicGarbageCollection();
    gcConn.close();

    const checkConn = createConn();
    const topics = checkConn
      .prepare("SELECT topic_id FROM project_topics ORDER BY topic_id")
      .all() as Array<{ topic_id: string }>;
    expect(topics.length).toBe(2);

    // Verify topic_decisions for deleted topic t2 is also deleted
    const t2_decisions = checkConn
      .prepare("SELECT 1 FROM topic_decisions WHERE topic_id='t2'")
      .all();
    expect(t2_decisions.length).toBe(0);

    // Verify other topic decisions still exist
    const t1_decisions = checkConn
      .prepare("SELECT 1 FROM topic_decisions WHERE topic_id='t1'")
      .all();
    expect(t1_decisions.length).toBe(1);
    expect(topics[0].topic_id).toBe("t1");
    expect(topics[1].topic_id).toBe("t3");

    checkConn.close();
  });
});

describe("test_prune_expired_watermarks", () => {
  it("test prune expired watermarks", () => {
    const brainDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "test_remora_brain_")
    );

    // Active folder
    fs.mkdirSync(path.join(brainDir, "c1"));

    const conn = createConn();
    conn.exec(`
      -- c1: Folder exists, recent messages, active -> NO DELETE
      INSERT INTO watermarks (conversation_id, last_msg_id, last_updated) VALUES ('c1', 1, datetime('now', '-1 hours'));
      INSERT INTO messages (id, conversation_id, timestamp) VALUES (1, 'c1', datetime('now', '-1 hours'));
      INSERT INTO session_state (session_id) VALUES ('c1');
      INSERT INTO topic_decisions (conversation_id, topic_id) VALUES ('c1', 't1');

      -- c2: Folder missing -> DELETE
      INSERT INTO watermarks (conversation_id, last_msg_id, last_updated) VALUES ('c2', 2, datetime('now', '-1 hours'));
      INSERT INTO messages (id, conversation_id, timestamp) VALUES (2, 'c2', datetime('now', '-1 hours'));
      INSERT INTO topic_decisions (conversation_id, topic_id) VALUES ('c2', 't2');

      -- c3: Folder exists, old messages, inactive -> DELETE
      INSERT INTO watermarks (conversation_id, last_msg_id, last_updated) VALUES ('c3', 3, datetime('now', '-40 days'));
      INSERT INTO messages (id, conversation_id, timestamp) VALUES (3, 'c3', datetime('now', '-40 days'));
      INSERT INTO topic_decisions (conversation_id, topic_id) VALUES ('c3', 't3');

      -- c4: Folder exists, old messages, but active session -> NO DELETE
      INSERT INTO watermarks (conversation_id, last_msg_id, last_updated) VALUES ('c4', 4, datetime('now', '-40 days'));
      INSERT INTO messages (id, conversation_id, timestamp) VALUES (4, 'c4', datetime('now', '-40 days'));
      INSERT INTO session_state (session_id) VALUES ('c4');
      INSERT INTO topic_decisions (conversation_id, topic_id) VALUES ('c4', 't4');
    `);
    conn.close();

    fs.mkdirSync(path.join(brainDir, "c3"));
    fs.mkdirSync(path.join(brainDir, "c4"));

    const pruneConn = createConn();
    dao.pruneExpiredWatermarks(brainDir);
    pruneConn.close();

    const checkConn = createConn();
    const watermarks = checkConn
      .prepare(
        "SELECT conversation_id FROM watermarks ORDER BY conversation_id"
      )
      .all() as Array<{ conversation_id: string }>;
    expect(watermarks.length).toBe(2);
    expect(watermarks[0].conversation_id).toBe("c1");
    expect(watermarks[1].conversation_id).toBe("c4");

    // Verify messages for deleted watermarks are also deleted
    const messages = checkConn
      .prepare(
        "SELECT conversation_id FROM messages ORDER BY conversation_id"
      )
      .all() as Array<{ conversation_id: string }>;
    expect(messages.length).toBe(2);
    expect(messages[0].conversation_id).toBe("c1");
    expect(messages[1].conversation_id).toBe("c4");

    // Verify topic_decisions for deleted watermarks are also deleted
    const decisions = checkConn
      .prepare(
        "SELECT conversation_id FROM topic_decisions ORDER BY conversation_id"
      )
      .all() as Array<{ conversation_id: string }>;
    expect(decisions.length).toBe(2);
    expect(decisions[0].conversation_id).toBe("c1");
    expect(decisions[1].conversation_id).toBe("c4");

    checkConn.close();

    // Cleanup
    try {
      fs.rmSync(brainDir, { recursive: true, force: true });
    } catch {}
  });
});

describe("test_check_db_exists", () => {
  it("test check db exists", () => {
    expect(dao.checkDbExists()).toBe(true);
    fs.unlinkSync(TEST_DB_PATH);
    expect(dao.checkDbExists()).toBe(false);
  });
});

describe("test_switch_topic", () => {
  it("test switch topic", () => {
    const conn = createConn();
    dao.createOrUpdateTopic("proj_1", "topic_A", "Topic A");
    expect(dao.getActiveTopic("proj_1")).toBe("topic_A");
    dao.switchTopic("proj_1", "topic_B");
    expect(dao.getActiveTopic("proj_1")).toBe("topic_B");
    const topics = dao.getTopicsByUuid("proj_1");
    const topicDict: Record<string, string> = {};
    for (const t of topics) {
      topicDict[t.topicId] = t.status;
    }
    expect(topicDict["topic_A"]).toBe("closed");
    expect(topicDict["topic_B"]).toBe("open");
    dao.switchTopic("proj_1", "topic_A");
    expect(dao.getActiveTopic("proj_1")).toBe("topic_A");
    conn.close();
  });
});

describe("test_force_cold_start_latest_session", () => {
  it("test force cold start latest session", () => {
    const conn = createConn();
    dao.writeMode("session_1", "standard");
    dao.writeMode("session_2", "standard");
    conn.prepare(
      "UPDATE session_state SET updated_at = datetime('now', '-1 hours') WHERE session_id = 'session_1'"
    ).run();
    dao.updateColdStart("session_1", 0);
    dao.forceColdStartLatestSession("session_1");
    const row = conn
      .prepare(
        "SELECT is_cold_start FROM session_state WHERE session_id='session_1'"
      )
      .get() as { is_cold_start: number };
    expect(row.is_cold_start).toBe(1);
    conn.prepare(
      "UPDATE session_state SET updated_at = datetime('now', '-2 hours') WHERE session_id = 'session_1'"
    ).run();
    dao.updateColdStart("session_2", 0);
    dao.forceColdStartLatestSession();
    const latest = dao.getLatestSession();
    expect(latest!.is_cold_start).toBe(1);
    expect(latest!.session_id).toBe("session_2");
    conn.close();
  });
});

describe("test_confirm_decision", () => {
  it("test confirm decision", () => {
    const conn = createConn();
    conn.prepare(
      "INSERT INTO topic_decisions (id, project_uuid, topic_id, decision) VALUES (1, 'proj_1', 'topic_A', 'test')"
    ).run();
    conn.close();

    expect(dao.confirmDecision("proj_1", 1)).toBe(true);
    expect(dao.confirmDecision("proj_1", 999)).toBe(false);
  });
});

describe("test_get_topic_id_by_decision", () => {
  it("test get topic id by decision", () => {
    expect(dao.getTopicIdByDecision(1)).toBeNull();
    const conn = createConn();
    conn.prepare(
      "INSERT INTO topic_decisions (id, project_uuid, topic_id, decision) VALUES (1, 'proj_1', 'topic_A', 'test')"
    ).run();
    conn.close();
    expect(dao.getTopicIdByDecision(1)).toBe("topic_A");
  });
});

describe("test_touch_topic_source_manual", () => {
  it("test touch topic source manual", () => {
    const conn = createConn();
    dao.createOrUpdateTopic("proj_1", "topic_A");
    dao.touchTopicSourceManual("proj_1", "topic_A");
    const row = conn
      .prepare(
        "SELECT source FROM project_topics WHERE uuid='proj_1' AND topic_id='topic_A'"
      )
      .get() as { source: string };
    expect(row.source).toBe("manual");
    conn.close();
  });
});

describe("test_get_confirmed_decisions_edge_cases", () => {
  it("test get confirmed decisions edge cases", () => {
    const conn = createConn();
    conn.exec(`
      INSERT INTO messages (id, conversation_id, content) VALUES (10, 'c1', 'Exists');
      INSERT INTO topic_decisions (project_uuid, topic_id, decision, rationale, user_confirmed) VALUES ('proj_1', 'topic_A', 'No files/evidence', 'none', 1);
      INSERT INTO topic_decisions (project_uuid, topic_id, decision, rationale, user_confirmed, evidence_msg_ids) VALUES ('proj_1', 'topic_A', 'Bad evidence', 'Wrong format', 1, 'bad-json');
      INSERT INTO topic_decisions (project_uuid, topic_id, decision, rationale, user_confirmed, evidence_msg_ids) VALUES ('proj_1', 'topic_A', 'Missing msg', 'No such msg', 1, '[999]');
    `);
    conn.close();

    const decisions = dao.getConfirmedDecisions("proj_1", "topic_A");
    expect(decisions.length).toBe(3);
    expect(decisions[0].evidence).toBe("");
    expect(decisions[1].evidence).toBe("");
    expect(decisions[2].evidence).toBe("");
  });
});

describe("test_recall_decisions_edge_cases", () => {
  it("test recall decisions edge cases", () => {
    const conn = createConn();
    conn.exec(`
      INSERT INTO watermarks (conversation_id, project_uuid) VALUES ('conv_1', 'proj_1');
      INSERT INTO messages (id, conversation_id, topic_id, role, content) VALUES (1, 'conv_1', '["topic_A"]', 'user', 'hello world');
      INSERT INTO messages_fts (rowid, content) VALUES (1, 'hello world');
      INSERT INTO topic_decisions (project_uuid, conversation_id, topic_id, decision, rationale) VALUES ('proj_1', 'conv_1', 'topic_A', 'Test decision', 'Test reason');
      INSERT INTO topic_decisions (project_uuid, conversation_id, topic_id, decision, rationale, evidence_msg_ids) VALUES ('proj_1', 'conv_1', 'topic_A', 'Bad evidence', 'Broken', 'not json');
      INSERT INTO topic_decisions (project_uuid, conversation_id, topic_id, decision, rationale, evidence_msg_ids) VALUES ('proj_1', 'conv_1', 'topic_A', 'Missing msg', 'No msg', '[999]');
      INSERT INTO topic_decisions (project_uuid, conversation_id, topic_id, decision, rationale, evidence_msg_ids) VALUES ('proj_1', 'conv_1', 'topic_A', 'Like bad json', 'Test bad json', 'not-json-either');
      INSERT INTO topic_decisions (project_uuid, conversation_id, topic_id, decision, rationale, evidence_msg_ids) VALUES ('proj_1', 'conv_1', 'topic_A', 'Like missing', 'Test no msg', '[111]');
    `);

    const decisions = dao.recallDecisionsByFts5Topic(
      "proj_1",
      "conv_1",
      "hello"
    );
    expect(decisions.length).toBe(5);
    const likeDecisions = dao.recallDecisionsByLike(
      "proj_1",
      "conv_1",
      "Test"
    );
    expect(likeDecisions.length).toBe(3);

    conn.close();
  });
});

describe("test_merge_physical_files_to_topic", () => {
  it("test merge physical files to topic", () => {
    const conn = createConn();
    dao.createOrUpdateTopic("proj_1", "topic_A");
    conn.prepare(
      "UPDATE project_topics SET associated_files='not-valid-json' WHERE uuid='proj_1' AND topic_id='topic_A'"
    ).run();
    dao.mergePhysicalFilesToTopic("proj_1", "topic_A", [
      "/path/to/fallback.py",
    ]);
    let row = conn
      .prepare(
        "SELECT associated_files FROM project_topics WHERE uuid='proj_1' AND topic_id='topic_A'"
      )
      .get() as { associated_files: string };
    let data = JSON.parse(row.associated_files);
    expect(data.length).toBe(1);
    expect(data[0].file).toBe("/path/to/fallback.py");

    dao.mergePhysicalFilesToTopic("proj_1", "topic_A", [
      "/path/to/file1.py",
      "/path/to/file2.py",
    ]);
    row = conn
      .prepare(
        "SELECT associated_files FROM project_topics WHERE uuid='proj_1' AND topic_id='topic_A'"
      )
      .get() as { associated_files: string };
    data = JSON.parse(row.associated_files);
    expect(data.length).toBe(3);

    dao.mergePhysicalFilesToTopic("proj_1", "topic_A", [
      "/path/to/file1.py",
    ]);
    row = conn
      .prepare(
        "SELECT associated_files FROM project_topics WHERE uuid='proj_1' AND topic_id='topic_A'"
      )
      .get() as { associated_files: string };
    data = JSON.parse(row.associated_files);
    expect(data.length).toBe(3);

    dao.mergePhysicalFilesToTopic("proj_1", "topic_A", [
      "/path/to/file3.py",
    ]);
    row = conn
      .prepare(
        "SELECT associated_files FROM project_topics WHERE uuid='proj_1' AND topic_id='topic_A'"
      )
      .get() as { associated_files: string };
    data = JSON.parse(row.associated_files);
    expect(data.length).toBe(4);

    conn.prepare(
      "UPDATE project_topics SET associated_files=? WHERE uuid='proj_1' AND topic_id='topic_A'",
    ).run(
      JSON.stringify([{ file: "/path/to/file1.py", source: "auto" }])
    );
    dao.mergePhysicalFilesToTopic("proj_1", "topic_A", [
      "/path/to/file1.py",
    ]);
    row = conn
      .prepare(
        "SELECT associated_files FROM project_topics WHERE uuid='proj_1' AND topic_id='topic_A'"
      )
      .get() as { associated_files: string };
    data = JSON.parse(row.associated_files);
    const file1 = data.filter(
      (item: { file: string; source: string }) =>
        item.file === "/path/to/file1.py"
    )[0];
    expect(file1.source.includes("physical")).toBe(true);

    conn.close();
  });
});

describe("test_runtime_hook_operations", () => {
  it("test runtime hook operations", () => {
    const conn = createConn();

    expect(dao.getRuntimeHookValue("s1", 0, "k1")).toBeNull();
    dao.setRuntimeHookValue("s1", 0, "k1", "v1");
    expect(dao.getRuntimeHookValue("s1", 0, "k1")).toBe("v1");
    dao.setRuntimeHookValue("s1", 0, "k1", "v2");
    expect(dao.getRuntimeHookValue("s1", 0, "k1")).toBe("v2");
    dao.deleteRuntimeHookValue("s1", 0, "k1");
    expect(dao.getRuntimeHookValue("s1", 0, "k1")).toBeNull();
    dao.setRuntimeHookValue("s1", 0, "k", "v0");
    dao.setRuntimeHookValue("s1", 1, "k", "v1");
    dao.trimRuntimeHookStates("s1", 1);
    expect(dao.getRuntimeHookValue("s1", 0, "k")).toBe("v0");
    expect(dao.getRuntimeHookValue("s1", 1, "k")).toBeNull();
    expect(dao.getHookState("s1", 0, "k")).toBe("v0");
    dao.setHookState("s1", 0, "k", "alias");
    expect(dao.getHookState("s1", 0, "k")).toBe("alias");
    dao.trimHookStates("s1", 0);

    conn.close();
  });
});

describe("test_common_exceptions", () => {
  it("test common exceptions", () => {
    const broken = brokenConn();

    // Set REMORA_DB_PATH to an invalid location so self-connecting functions fail
    process.env.REMORA_DB_PATH = "/tmp/nonexistent_test_dir_12345/test.db";

    expect(dao.readMode("test")).toBe("standard");
    expect(dao.getLatestSession()).toBeNull();
    expect(dao.getProjectUuidByConv("test")).toBeNull();
    expect(dao.getActiveTopic("test")).toBeNull();
    expect(dao.getTopicsByUuid("test")).toEqual([]);
    expect(dao.getConfirmedDecisions("test", "test")).toEqual([]);
    expect(dao.getTopicIdByDecision(999)).toBeNull();
    expect(dao.recallFts5Logs("test", "test", "test")).toEqual([]);
    expect(dao.recallDecisionsByFts5Topic("test", "test", "test")).toEqual([]);
    expect(dao.recallDecisionsByLike("test", "test", "test")).toEqual([]);

    process.env.REMORA_DB_PATH = TEST_DB_PATH;
  });
});

describe("test_runtime_hook_exceptions", () => {
  it("test runtime hook exceptions", () => {
    const broken = brokenConn();
    expect(dao.getRuntimeHookValue("test", 0, "key")).toBeNull();
    dao.setRuntimeHookValue("test", 0, "key", "val");
    dao.deleteRuntimeHookValue("test", 0, "key");
    dao.trimRuntimeHookStates("test", 0);
  });
});

describe("test_gc_exception", () => {
  it("test gc exception", () => {
    const origExit = process.exit;
    let exitCalled = false;
    let exitCode: number | null = null;
    process.exit = ((code?: number) => {
      exitCalled = true;
      exitCode = code ?? 0;
      throw new Error("SystemExit");
    }) as any;
    const savePath = testDbPath.path;
    testDbPath.path = "/dev/null/nonexistent/test.db";
    try {
      expect(() => {
        dao.runTopicGarbageCollection();
      }).toThrow("SystemExit");
      expect(exitCalled).toBe(true);
      expect(exitCode).toBe(1);
    } finally {
      process.exit = origExit;
      testDbPath.path = savePath;
    }
  });
});

describe("test_prune_exception", () => {
  it("test prune exception", () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "test_remora_prune_")
    );
    const origExit = process.exit;
    let exitCalled = false;
    let exitCode: number | null = null;
    process.exit = ((code?: number) => {
      exitCalled = true;
      exitCode = code ?? 0;
      throw new Error("SystemExit");
    }) as any;
    const savePath = testDbPath.path;
    testDbPath.path = "/dev/null/nonexistent/test.db";
    try {
      expect(() => {
        dao.pruneExpiredWatermarks(tmpDir);
      }).toThrow("SystemExit");
      expect(exitCalled).toBe(true);
      expect(exitCode).toBe(1);
    } finally {
      process.exit = origExit;
      testDbPath.path = savePath;
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    }
  });
});

describe("test_prune_expired_watermarks_artifact_sync", () => {
  it("test prune expired watermarks artifact sync", () => {
    const brainDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "test_remora_artifact_sync_")
    );
    const conn = createConn();
    conn.exec(`
      INSERT INTO watermarks (conversation_id, last_msg_id, last_updated) VALUES ('artifact_sync_foo', 1, datetime('now', '-40 days'));
      INSERT INTO messages (id, conversation_id, timestamp) VALUES (1, 'artifact_sync_foo', datetime('now', '-40 days'));
    `);
    conn.close();

    const pruneConn = createConn();
    dao.pruneExpiredWatermarks(brainDir);
    pruneConn.close();

    const checkConn = createConn();
    const rows = checkConn
      .prepare(
        "SELECT conversation_id FROM watermarks WHERE conversation_id='artifact_sync_foo'"
      )
      .all() as Array<{ conversation_id: string }>;
    expect(rows.length).toBe(1);
    checkConn.close();

    try {
      fs.rmSync(brainDir, { recursive: true, force: true });
    } catch {}
  });
});

describe("test_prune_expired_watermarks_invalid_dir", () => {
  it("test prune expired watermarks invalid dir", () => {
    const conn = createConn();
    const origExit = process.exit;
    let exitCalled = false;
    process.exit = ((code?: number) => {
      exitCalled = true;
      throw new Error("SystemExit");
    }) as any;
    try {
      expect(() => {
        dao.pruneExpiredWatermarks("/nonexistent/path_xyz123");
      }).toThrow("SystemExit");
      expect(exitCalled).toBe(true);
    } finally {
      process.exit = origExit;
      conn.close();
    }
  });
});

describe("test_prune_expired_watermarks_no_delete", () => {
  it("test prune expired watermarks no delete", () => {
    const brainDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "test_remora_no_delete_")
    );
    fs.mkdirSync(path.join(brainDir, "c1"));
    const conn = createConn();
    conn.exec(`
      INSERT INTO watermarks (conversation_id, last_msg_id, last_updated) VALUES ('c1', 1, datetime('now', '-1 hours'));
      INSERT INTO messages (id, conversation_id, timestamp) VALUES (1, 'c1', datetime('now', '-1 hours'));
      INSERT INTO session_state (session_id) VALUES ('c1');
    `);
    conn.close();

    const pruneConn = createConn();
    dao.pruneExpiredWatermarks(brainDir);
    pruneConn.close();

    const checkConn = createConn();
    const rows = checkConn
      .prepare("SELECT conversation_id FROM watermarks")
      .all() as Array<{ conversation_id: string }>;
    expect(rows.length).toBe(1);
    checkConn.close();

    try {
      fs.rmSync(brainDir, { recursive: true, force: true });
    } catch {}
  });
});

describe("test_file_changes_insert_and_query", () => {
  it("test file changes insert and query", () => {
    const conn = createConn();
    dao.insertFileChange("proj_1", "conv_1", "auth.py", "snapshot");
    dao.insertFileChange("proj_1", "conv_1", "auth.py", "snapshot");
    dao.insertFileChange("proj_1", "conv_1", "middleware.py", "snapshot");
    dao.insertFileChange("proj_1", "conv_2", "logger.py", "sandbox");

    conn.prepare(
      "INSERT INTO topic_decisions (project_uuid, topic_id, conversation_id, decision, rationale) VALUES ('proj_1', 'topic_A', 'conv_1', 'Use python', 'fast')"
    ).run();
    conn.close();

    const queryConn = createConn();

    const decisions = dao.getDecisionsByFile("proj_1", "auth.py");
    expect(decisions.length).toBe(1);
    expect(decisions[0].decision).toBe("Use python");

    queryConn.close();
  });
});

describe("test_gate_should_fire_and_mark", () => {
  it("test gate should fire and mark", () => {
    const conn = createConn();

    // Gate fires when no prior state, then marks fired.
    const result = dao.shouldFire("conv_1", "test_gate_key", "v1");
    expect(result).toBe(true);

    dao.markFired("conv_1", "test_gate_key", "v1");
    const result2 = dao.shouldFire("conv_1", "test_gate_key", "v1");
    expect(result2).toBe(false);

    const result3 = dao.shouldFire("conv_1", "test_gate_key", "v2");
    expect(result3).toBe(true);

    conn.close();
  });
});

describe("test_gate_dedup_and_clear", () => {
  it("test gate dedup and clear", () => {
    const conn = createConn();

    // Same value dedup, different value clears stale.
    dao.markFired("conv_2", "test_dedup", "42");
    expect(dao.isDuplicate("conv_2", "test_dedup", "42")).toBe(true);
    expect(dao.isDuplicate("conv_2", "test_dedup", "99")).toBe(false);

    dao.markFired("conv_2", "test_dedup", "99");
    expect(dao.isDuplicate("conv_2", "test_dedup", "42")).toBe(false);

    conn.close();
  });
});

describe("test_bump_injection_once", () => {
  it("test bump injection once", () => {
    const conn = createConn();
    conn.prepare(
      "INSERT INTO topic_decisions (id, project_uuid, topic_id, decision, user_confirmed) VALUES (999, 'proj_1', 't1', 'test decision', 0)"
    ).run();
    decisionsMod.bumpInjection(999);
    const row = conn
      .prepare(
        "SELECT injected_count, last_injected_at FROM topic_decisions WHERE id=999"
      )
      .get() as { injected_count: number; last_injected_at: string | null };
    expect(row.injected_count).toBe(1);
    expect(row.last_injected_at).not.toBeNull();
    conn.close();
  });
});

describe("test_bump_injection_multiple", () => {
  it("test bump injection multiple", () => {
    const conn = createConn();
    conn.prepare(
      "INSERT INTO topic_decisions (id, project_uuid, topic_id, decision, user_confirmed) VALUES (998, 'proj_1', 't1', 'multi bump', 0)"
    ).run();
    for (let i = 0; i < 3; i++) {
      decisionsMod.bumpInjection(998);
    }
    const row = conn
      .prepare("SELECT injected_count FROM topic_decisions WHERE id=998")
      .get() as { injected_count: number };
    expect(row.injected_count).toBe(3);
    conn.close();
  });
});
